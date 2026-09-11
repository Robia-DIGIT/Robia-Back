"""Structured logging and request-id correlation (RC-15).

Mirrors the NestJS side (src/common/logging/*): JSON logs, a request id
that is reused from an inbound X-Request-Id header when present (falling
back to a fresh uuid4) and echoed back on the response, secret redaction
by key-name pattern, and an optional DSN-gated Sentry init that stays
inert unless SENTRY_DSN is set.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import uuid
from contextvars import ContextVar
from typing import Any, Callable, Awaitable

REQUEST_ID_HEADER = "x-request-id"
RESPONSE_REQUEST_ID_HEADER = "X-Request-Id"

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)

_SENSITIVE_KEY_PATTERN = re.compile(
    r"(password|passwd|secret|token|api[-_]?key|authorization|cookie|email)",
    re.IGNORECASE,
)
_REDACTED = "[REDACTED]"


def get_request_id() -> str | None:
    return _request_id.get()


def redact_sensitive(value: Any, _seen: set[int] | None = None) -> Any:
    """Deep-redacts dict values whose key matches a sensitive pattern."""
    if _seen is None:
        _seen = set()

    if isinstance(value, dict):
        obj_id = id(value)
        if obj_id in _seen:
            return "[Circular]"
        _seen = _seen | {obj_id}
        result: dict[str, Any] = {}
        for key, entry in value.items():
            if _SENSITIVE_KEY_PATTERN.search(str(key)):
                result[key] = _redact_leaf(entry)
            else:
                result[key] = redact_sensitive(entry, _seen)
        return result

    if isinstance(value, list):
        return [redact_sensitive(item, _seen) for item in value]

    return value


def _redact_leaf(value: Any) -> Any:
    if value is None:
        return value
    if isinstance(value, str) and value == "":
        return value
    return _REDACTED


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.requestId = get_request_id()
        return True


_RESERVED_RECORD_KEYS = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {
    "message",
    "asctime",
}


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "name": record.name,
            "message": record.getMessage(),
        }

        request_id = getattr(record, "requestId", None)
        if request_id:
            payload["requestId"] = request_id

        extras = {
            key: val
            for key, val in record.__dict__.items()
            if key not in _RESERVED_RECORD_KEYS and key != "requestId"
        }
        if extras:
            payload.update(redact_sensitive(extras))

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str)


def configure_logging() -> None:
    """Replaces the root logger's handlers with a single JSON stream handler."""
    level_name = os.environ.get("LOG_LEVEL", "info").upper()
    level = getattr(logging, level_name, logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    handler.addFilter(_RequestIdFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)


_sentry_initialized = False


def init_sentry() -> None:
    """No-op unless SENTRY_DSN is set. Error-capture only, no tracing."""
    global _sentry_initialized
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return

    import sentry_sdk

    sentry_sdk.init(dsn=dsn, environment=os.environ.get("ENVIRONMENT", "development"), traces_sample_rate=0)
    _sentry_initialized = True


def is_sentry_initialized() -> bool:
    return _sentry_initialized


async def request_id_middleware(request: Any, call_next: Callable[[Any], Awaitable[Any]]) -> Any:
    """Starlette/FastAPI middleware: reuses an inbound X-Request-Id or
    generates one, exposes it via get_request_id() for the duration of the
    request (so log lines emitted while handling it carry it), and echoes
    it back on the response for the caller to correlate against."""
    incoming = request.headers.get(REQUEST_ID_HEADER)
    request_id = incoming.strip() if incoming and incoming.strip() else str(uuid.uuid4())

    token = _request_id.set(request_id)
    try:
        response = await call_next(request)
    finally:
        _request_id.reset(token)

    response.headers[RESPONSE_REQUEST_ID_HEADER] = request_id
    return response
