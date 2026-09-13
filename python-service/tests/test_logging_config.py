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
    sanitize_sentry_event,
    scrub_text,
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

    def test_scrubs_a_secret_embedded_in_free_text_under_a_non_sensitive_key(self):
        payload = {
            "message": "Invalid request from fake-user@example.test, token=fake-token-abc123"
        }
        result = redact_sensitive(payload)
        self.assertNotIn("fake-user@example.test", result["message"])
        self.assertNotIn("fake-token-abc123", result["message"])

    def test_leaves_ordinary_free_text_untouched(self):
        payload = {"message": "Audit completed with 12 pages crawled"}
        self.assertEqual(redact_sensitive(payload), payload)


class ScrubTextTests(unittest.TestCase):
    def test_redacts_an_email_address_embedded_in_text(self):
        result = scrub_text("contact fake-user@example.test for details")
        self.assertNotIn("fake-user@example.test", result)

    def test_redacts_a_bearer_token_embedded_in_text(self):
        result = scrub_text("sent Authorization: Bearer fake-secret-value")
        self.assertNotIn("fake-secret-value", result)

    def test_redacts_a_jwt_shaped_string_embedded_in_text(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakesignature"
        result = scrub_text(f"cached token {jwt} for reuse")
        self.assertNotIn(jwt, result)

    def test_redacts_an_inline_key_value_secret_embedded_in_text(self):
        result = scrub_text("retrying with token=fake-token-123 after failure")
        self.assertNotIn("fake-token-123", result)

    def test_leaves_text_with_no_secret_shaped_substring_unchanged(self):
        self.assertEqual(scrub_text("everything is fine here"), "everything is fine here")


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

    def test_wires_the_shared_sanitizer_in_as_before_send(self):
        os.environ["SENTRY_DSN"] = "https://example.ingest.sentry.io/1"
        logging_config = self._reload()

        with patch("sentry_sdk.init") as mock_init:
            logging_config.init_sentry()

        self.assertIs(
            mock_init.call_args.kwargs["before_send"],
            logging_config.sanitize_sentry_event,
        )


class SanitizeSentryEventTests(unittest.TestCase):
    def test_redacts_request_headers_cookies_and_body(self):
        event = {
            "request": {
                "headers": {
                    "authorization": "Bearer fake-session-token",
                    "cookie": "session=fake-cookie-value",
                },
                "data": {"password": "fake-password", "username": "jane"},
            }
        }

        sanitized = sanitize_sentry_event(event, {})

        self.assertEqual(
            sanitized["request"]["headers"]["authorization"], "[REDACTED]"
        )
        self.assertEqual(sanitized["request"]["headers"]["cookie"], "[REDACTED]")
        self.assertEqual(sanitized["request"]["data"]["password"], "[REDACTED]")
        self.assertEqual(sanitized["request"]["data"]["username"], "jane")

    def test_redacts_user_email_but_keeps_non_sensitive_user_id(self):
        event = {"user": {"id": "user-123", "email": "fake-user@example.test"}}

        sanitized = sanitize_sentry_event(event, {})

        self.assertEqual(sanitized["user"]["email"], "[REDACTED]")
        self.assertEqual(sanitized["user"]["id"], "user-123")

    def test_redacts_sensitive_keys_inside_extra_and_contexts(self):
        event = {
            "extra": {"apiToken": "fake-extra-token", "pagesAnalyzed": 12},
            "contexts": {
                "audit": {"organizationSecret": "fake-secret", "auditId": "audit-1"}
            },
        }

        sanitized = sanitize_sentry_event(event, {})

        self.assertEqual(sanitized["extra"]["apiToken"], "[REDACTED]")
        self.assertEqual(sanitized["extra"]["pagesAnalyzed"], 12)
        self.assertEqual(
            sanitized["contexts"]["audit"]["organizationSecret"], "[REDACTED]"
        )
        self.assertEqual(sanitized["contexts"]["audit"]["auditId"], "audit-1")

    def test_redacts_secrets_in_breadcrumb_data_and_free_text_messages(self):
        event = {
            "breadcrumbs": [
                {
                    "message": "Retrying request with token=fake-token-999 after 401",
                    "data": {"authorization": "Bearer fake-breadcrumb-token"},
                }
            ]
        }

        sanitized = sanitize_sentry_event(event, {})

        self.assertNotIn("fake-token-999", sanitized["breadcrumbs"][0]["message"])
        self.assertEqual(
            sanitized["breadcrumbs"][0]["data"]["authorization"], "[REDACTED]"
        )

    def test_scrubs_secret_embedded_in_exception_message(self):
        event = {
            "exception": {
                "values": [
                    {
                        "type": "Error",
                        "value": "Upstream call failed for fake-user@example.test: api_key=fake-api-key-42",
                    }
                ]
            }
        }

        sanitized = sanitize_sentry_event(event, {})

        value = sanitized["exception"]["values"][0]["value"]
        self.assertNotIn("fake-user@example.test", value)
        self.assertNotIn("fake-api-key-42", value)

    def test_never_lets_a_real_shaped_fixture_value_reach_the_event_unredacted(self):
        event = {
            "request": {"headers": {"cookie": "session=fake-cookie-xyz"}},
            "user": {"email": "fake-user@example.test"},
            "exception": {
                "values": [
                    {
                        "value": "token=fake-token-abc rejected for fake-user@example.test"
                    }
                ]
            },
        }

        serialized = json.dumps(sanitize_sentry_event(event, {}))

        self.assertNotIn("fake-cookie-xyz", serialized)
        self.assertNotIn("fake-user@example.test", serialized)
        self.assertNotIn("fake-token-abc", serialized)


if __name__ == "__main__":
    unittest.main()
