"""Google PageSpeed Insights integration.

Enrichment only: PSI is never required for an audit to complete, and it
never changes the audit's overall SEO score. ``fetch_pagespeed_insights``
always returns a well-formed structured result (never ``None``, never
raises) so callers get one consistent contract whether the call
succeeded or not - see ``status`` / ``unavailableReason``.

Mobile strategy only (RC-10 decision): PSI bills/rate-limits desktop and
mobile as separate calls, and ROBIA's local-PME audience is
predominantly mobile.

``GOOGLE_PAGESPEED_API_KEY`` is optional. PSI accepts unauthenticated
requests at a much lower, stricter quota, so when the key is unset the
``key`` query parameter is omitted entirely rather than skipping the
call - a keyless caller still gets real data, just at a lower rate limit.

The one metric this module reports that is *not* a Core Web Vital is
Total Blocking Time (TBT): it is a lab-only proxy correlated with
interactivity (INP), not one of Google's three official Core Web Vitals
(LCP, CLS, INP). It is labelled as such everywhere it is surfaced.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional, TypedDict

import requests

logger = logging.getLogger(__name__)

PAGESPEED_API_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
DEFAULT_TIMEOUT_SECONDS = 20.0
STRATEGY = "mobile"
SOURCE_NAME = "google_pagespeed_insights"

# In-memory cache, per ai-engine process, successes only (a failure is
# never cached, so the next audit always retries rather than freezing a
# transient outage for a full day). 24h: PSI lab scores are noisy
# run-to-run: re-querying every audit adds latency/quota cost without a
# meaningfully fresher signal within the same day.
#
# NOTE: the ai-engine container runs uvicorn with --workers 2 (see
# python-service/Dockerfile), and this dict is process-local - it is
# NOT shared between the two workers or across restarts. This reduces
# duplicate PSI calls within a worker, it is not a distributed cache.
CACHE_TTL_SECONDS = 24 * 60 * 60


class PageSpeedMetrics(TypedDict):
    lcpMs: Optional[float]
    cls: Optional[float]
    tbtMs: Optional[float]  # lab proxy for interactivity - not a Core Web Vital
    fcpMs: Optional[float]


class PageSpeedResult(TypedDict):
    status: str  # "ok" | "unavailable"
    strategy: str
    performanceScore: Optional[int]
    metrics: PageSpeedMetrics
    fetchedAt: str
    analyzedUrl: str
    finalUrl: Optional[str]
    source: str
    unavailableReason: Optional[str]


_cache: dict[str, tuple[float, PageSpeedResult]] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_metrics() -> PageSpeedMetrics:
    return PageSpeedMetrics(lcpMs=None, cls=None, tbtMs=None, fcpMs=None)


def _unavailable(url: str, reason: str) -> PageSpeedResult:
    return PageSpeedResult(
        status="unavailable",
        strategy=STRATEGY,
        performanceScore=None,
        metrics=_empty_metrics(),
        fetchedAt=_now_iso(),
        analyzedUrl=url,
        finalUrl=None,
        source=SOURCE_NAME,
        unavailableReason=reason,
    )


def _redact(text: str, secret: Optional[str]) -> str:
    """Strip a known secret value out of free-form text before it is
    logged. requests' own exception messages embed the request URL
    (including query params), so this is the difference between a log
    line that is safe to read and one that leaks the API key."""
    if not secret:
        return text
    return text.replace(secret, "***")


def _classify_request_exception(exc: requests.RequestException) -> str:
    """Map a request failure to a small, fixed vocabulary. Deliberately
    never includes the exception's own message: that message can embed
    the full request URL, key included - classifying instead of
    forwarding is what keeps the key out of `unavailableReason`."""
    if isinstance(exc, requests.exceptions.Timeout):
        return "timeout"
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status == 429:
        return "rate_limited"
    if isinstance(status, int) and 500 <= status < 600:
        return f"server_error_{status}"
    if isinstance(status, int):
        return f"http_error_{status}"
    return "network_error"


def _extract_audit_numeric_value(audits: Any, audit_id: str) -> Optional[float]:
    if not isinstance(audits, dict):
        return None
    audit = audits.get(audit_id)
    if not isinstance(audit, dict):
        return None
    value = audit.get("numericValue")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _parse_pagespeed_response(payload: Any, requested_url: str) -> PageSpeedResult:
    """Best-effort parse that never raises. Any payload shape other than
    the one PSI is documented to return - a JSON list, a string, a dict
    missing the expected keys, wrong value types - resolves to an
    "unavailable" result instead of propagating an exception."""
    if not isinstance(payload, dict):
        return _unavailable(requested_url, "invalid_response_shape")

    lighthouse_result = payload.get("lighthouseResult")
    if not isinstance(lighthouse_result, dict):
        return _unavailable(requested_url, "invalid_response_shape")

    categories = lighthouse_result.get("categories")
    performance_category = (
        categories.get("performance") if isinstance(categories, dict) else None
    )
    raw_score = (
        performance_category.get("score")
        if isinstance(performance_category, dict)
        else None
    )
    if not isinstance(raw_score, (int, float)) or isinstance(raw_score, bool):
        return _unavailable(requested_url, "invalid_response_shape")

    audits = lighthouse_result.get("audits")
    final_url = lighthouse_result.get("finalUrl")
    if not isinstance(final_url, str):
        final_url = None

    return PageSpeedResult(
        status="ok",
        strategy=STRATEGY,
        performanceScore=round(raw_score * 100),
        metrics=PageSpeedMetrics(
            lcpMs=_extract_audit_numeric_value(audits, "largest-contentful-paint"),
            cls=_extract_audit_numeric_value(audits, "cumulative-layout-shift"),
            tbtMs=_extract_audit_numeric_value(audits, "total-blocking-time"),
            fcpMs=_extract_audit_numeric_value(audits, "first-contentful-paint"),
        ),
        fetchedAt=_now_iso(),
        analyzedUrl=requested_url,
        finalUrl=final_url,
        source=SOURCE_NAME,
        unavailableReason=None,
    )


def fetch_pagespeed_insights(
    url: str, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> PageSpeedResult:
    """Fetch lab performance metrics for ``url`` (mobile strategy).

    Always returns a well-formed :class:`PageSpeedResult` - this function
    must never raise, so a PSI outage never breaks an audit and never
    changes the audit's SEO score.
    """
    cached = _cache.get(url)
    if cached is not None:
        cached_at, cached_result = cached
        if time.monotonic() - cached_at < CACHE_TTL_SECONDS:
            return cached_result

    api_key = os.environ.get("GOOGLE_PAGESPEED_API_KEY") or None

    params: dict[str, str] = {
        "url": url,
        "strategy": STRATEGY,
        "category": "performance",
    }
    if api_key:
        params["key"] = api_key

    try:
        response = requests.get(PAGESPEED_API_URL, params=params, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        reason = _classify_request_exception(exc)
        logger.warning(
            "PageSpeed Insights request failed for %s: %s",
            url,
            _redact(str(exc), api_key),
        )
        return _unavailable(url, reason)
    except ValueError:
        logger.warning("PageSpeed Insights returned invalid JSON for %s.", url)
        return _unavailable(url, "invalid_json")

    result = _parse_pagespeed_response(payload, url)
    if result["status"] != "ok":
        logger.warning(
            "PageSpeed Insights response for %s did not contain the expected fields.",
            url,
        )
        return result

    _cache[url] = (time.monotonic(), result)
    return result
