"""Google PageSpeed Insights integration.

Enrichment only: PSI is never required for an audit to complete. The API
key is optional (``PAGESPEED_API_KEY``) — when it is absent, or the call
fails for any reason (network, timeout, quota, malformed response), this
module returns ``None`` and the caller falls back to a "not_tested"
performance finding instead of failing the audit.

Mobile strategy only (see RC-10 decision): PSI bills/rate-limits desktop
and mobile as separate calls, and ROBIA's local-PME audience is
predominantly mobile traffic.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional, TypedDict

import requests

logger = logging.getLogger(__name__)

PAGESPEED_API_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
DEFAULT_TIMEOUT_SECONDS = 20.0


class PageSpeedMetrics(TypedDict):
    performance_score: int
    lcp_ms: Optional[float]
    cls: Optional[float]
    tbt_ms: Optional[float]
    fcp_ms: Optional[float]


def _extract_audit_numeric_value(
    audits: dict[str, Any], audit_id: str
) -> Optional[float]:
    audit = audits.get(audit_id)
    if not isinstance(audit, dict):
        return None
    value = audit.get("numericValue")
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _parse_pagespeed_response(payload: dict[str, Any]) -> Optional[PageSpeedMetrics]:
    lighthouse_result = payload.get("lighthouseResult")
    if not isinstance(lighthouse_result, dict):
        return None

    categories = lighthouse_result.get("categories")
    if not isinstance(categories, dict):
        return None

    performance_category = categories.get("performance")
    if not isinstance(performance_category, dict):
        return None

    raw_score = performance_category.get("score")
    if not isinstance(raw_score, (int, float)):
        return None

    audits = lighthouse_result.get("audits")
    audits = audits if isinstance(audits, dict) else {}

    return PageSpeedMetrics(
        performance_score=round(raw_score * 100),
        lcp_ms=_extract_audit_numeric_value(audits, "largest-contentful-paint"),
        cls=_extract_audit_numeric_value(audits, "cumulative-layout-shift"),
        tbt_ms=_extract_audit_numeric_value(audits, "total-blocking-time"),
        fcp_ms=_extract_audit_numeric_value(audits, "first-contentful-paint"),
    )


def fetch_pagespeed_insights(
    url: str, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> Optional[PageSpeedMetrics]:
    """Fetch lab performance metrics for ``url`` (mobile strategy).

    Returns ``None`` whenever a result cannot be obtained for any reason —
    this function must never raise, so a PSI outage never breaks an audit.
    """
    api_key = os.environ.get("PAGESPEED_API_KEY")
    if not api_key:
        logger.info("PageSpeed Insights skipped: PAGESPEED_API_KEY is not set.")
        return None

    try:
        response = requests.get(
            PAGESPEED_API_URL,
            params={
                "url": url,
                "strategy": "mobile",
                "category": "performance",
                "key": api_key,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        logger.warning("PageSpeed Insights request failed for %s: %s", url, exc)
        return None
    except ValueError as exc:
        logger.warning("PageSpeed Insights returned invalid JSON for %s: %s", url, exc)
        return None

    metrics = _parse_pagespeed_response(payload)
    if metrics is None:
        logger.warning(
            "PageSpeed Insights response for %s did not contain the expected fields.",
            url,
        )
    return metrics
