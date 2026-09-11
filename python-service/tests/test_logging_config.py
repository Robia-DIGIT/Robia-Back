import asyncio
import importlib
import json
import logging
import os
import unittest
from unittest.mock import MagicMock, patch

from app.logging_config import (
    _JsonFormatter,
    get_request_id,
    redact_sensitive,
    request_id_middleware,
)


class RedactSensitiveTests(unittest.TestCase):
    def test_redacts_common_secret_key_variants(self):
        payload = {
            "password": "hunter2",
            "apiKey": "abc",
            "api_key": "abc",
            "GOOGLE_PAGESPEED_API_KEY": "abc",
            "Authorization": "Bearer xyz",
            "email": "user@example.com",
        }
        result = redact_sensitive(payload)
        for key in payload:
            self.assertEqual(result[key], "[REDACTED]")

    def test_leaves_non_sensitive_keys_untouched(self):
        payload = {"url": "https://example.com", "status": "ok"}
        self.assertEqual(redact_sensitive(payload), payload)

    def test_redacts_nested_and_list_values(self):
        payload = {"user": {"token": "secret"}, "items": [{"secret": "s"}]}
        result = redact_sensitive(payload)
        self.assertEqual(result["user"]["token"], "[REDACTED]")
        self.assertEqual(result["items"][0]["secret"], "[REDACTED]")

    def test_empty_string_and_none_pass_through(self):
        payload = {"password": "", "token": None}
        result = redact_sensitive(payload)
        self.assertEqual(result["password"], "")
        self.assertIsNone(result["token"])

    def test_handles_circular_references(self):
        payload: dict = {"password": "x"}
        payload["self"] = payload
        result = redact_sensitive(payload)
        self.assertEqual(result["self"], "[Circular]")


class JsonFormatterTests(unittest.TestCase):
    def test_formats_record_as_json_with_redacted_extras(self):
        formatter = _JsonFormatter()
        record = logging.LogRecord(
            name="app.test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="hello",
            args=(),
            exc_info=None,
        )
        record.apiKey = "should-be-hidden"
        record.requestId = "req-1"

        output = json.loads(formatter.format(record))

        self.assertEqual(output["message"], "hello")
        self.assertEqual(output["level"], "info")
        self.assertEqual(output["requestId"], "req-1")
        self.assertEqual(output["apiKey"], "[REDACTED]")


class RequestIdMiddlewareTests(unittest.TestCase):
    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    def test_reuses_incoming_request_id_and_echoes_it_back(self):
        request = MagicMock()
        request.headers = {"x-request-id": "incoming-id"}
        response = MagicMock()
        response.headers = {}

        seen_during_request = {}

        async def call_next(_req):
            seen_during_request["value"] = get_request_id()
            return response

        result = self._run(request_id_middleware(request, call_next))

        self.assertIs(result, response)
        self.assertEqual(seen_during_request["value"], "incoming-id")
        self.assertEqual(response.headers["X-Request-Id"], "incoming-id")
        self.assertIsNone(get_request_id())

    def test_generates_a_request_id_when_none_is_provided(self):
        request = MagicMock()
        request.headers = {}
        response = MagicMock()
        response.headers = {}

        async def call_next(_req):
            return response

        self._run(request_id_middleware(request, call_next))

        self.assertIn("X-Request-Id", response.headers)
        self.assertTrue(len(response.headers["X-Request-Id"]) > 0)


class SentryInitTests(unittest.TestCase):
    def setUp(self):
        self.original_dsn = os.environ.get("SENTRY_DSN")

    def tearDown(self):
        if self.original_dsn is None:
            os.environ.pop("SENTRY_DSN", None)
        else:
            os.environ["SENTRY_DSN"] = self.original_dsn

    def _reload(self):
        import app.logging_config as logging_config

        return importlib.reload(logging_config)

    def test_stays_inert_without_sentry_dsn(self):
        os.environ.pop("SENTRY_DSN", None)
        logging_config = self._reload()

        logging_config.init_sentry()

        self.assertFalse(logging_config.is_sentry_initialized())

    def test_initializes_when_dsn_is_set(self):
        os.environ["SENTRY_DSN"] = "https://example.ingest.sentry.io/1"
        logging_config = self._reload()

        with patch("sentry_sdk.init") as mock_init:
            logging_config.init_sentry()

        mock_init.assert_called_once()
        self.assertEqual(mock_init.call_args.kwargs["dsn"], "https://example.ingest.sentry.io/1")
        self.assertTrue(logging_config.is_sentry_initialized())


if __name__ == "__main__":
    unittest.main()
