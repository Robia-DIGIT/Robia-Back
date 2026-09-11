import unittest
from unittest.mock import Mock, patch

import requests

from app.integrations import pagespeed
from app.integrations.pagespeed import fetch_pagespeed_insights

GOOD_PAYLOAD = {
    "lighthouseResult": {
        "categories": {"performance": {"score": 0.95}},
        "audits": {
            "largest-contentful-paint": {"numericValue": 1800.0},
            "cumulative-layout-shift": {"numericValue": 0.05},
            "total-blocking-time": {"numericValue": 50.0},
            "first-contentful-paint": {"numericValue": 900.0},
        },
        "finalUrl": "https://example.com/",
    }
}


def _http_error(status_code: int) -> requests.exceptions.HTTPError:
    response = Mock()
    response.status_code = status_code
    error = requests.exceptions.HTTPError(f"{status_code} error", response=response)
    return error


class FetchPageSpeedInsightsTests(unittest.TestCase):
    def setUp(self):
        pagespeed._cache.clear()

    @patch.dict("os.environ", {}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_calls_psi_without_key_when_unset(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.return_value = GOOD_PAYLOAD
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        mock_get.assert_called_once()
        called_params = mock_get.call_args.kwargs["params"]
        self.assertNotIn("key", called_params)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["performanceScore"], 95)

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_parses_successful_response(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.return_value = GOOD_PAYLOAD
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["strategy"], "mobile")
        self.assertEqual(result["performanceScore"], 95)
        self.assertEqual(result["metrics"]["lcpMs"], 1800.0)
        self.assertEqual(result["metrics"]["cls"], 0.05)
        self.assertEqual(result["metrics"]["tbtMs"], 50.0)
        self.assertEqual(result["metrics"]["fcpMs"], 900.0)
        self.assertEqual(result["analyzedUrl"], "https://example.com")
        self.assertEqual(result["finalUrl"], "https://example.com/")
        self.assertEqual(result["source"], "google_pagespeed_insights")
        self.assertIsNone(result["unavailableReason"])
        self.assertTrue(result["fetchedAt"])

        called_kwargs = mock_get.call_args.kwargs
        self.assertEqual(called_kwargs["params"]["strategy"], "mobile")
        self.assertEqual(called_kwargs["params"]["url"], "https://example.com")
        self.assertEqual(called_kwargs["params"]["key"], "test-key")

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_rate_limited_response_is_unavailable(self, mock_get: Mock) -> None:
        mock_get.side_effect = _http_error(429)

        result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["unavailableReason"], "rate_limited")
        self.assertIsNone(result["performanceScore"])

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_server_error_response_is_unavailable(self, mock_get: Mock) -> None:
        mock_get.side_effect = _http_error(503)

        result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["unavailableReason"], "server_error_503")

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_returns_unavailable_on_timeout(self, mock_get: Mock) -> None:
        mock_get.side_effect = requests.exceptions.Timeout("timed out")

        result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["unavailableReason"], "timeout")

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_returns_unavailable_on_malformed_json(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.side_effect = ValueError("no JSON object could be decoded")
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["unavailableReason"], "invalid_json")

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_returns_unavailable_on_non_dict_payload(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.return_value = ["unexpected", "list", "payload"]
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["unavailableReason"], "invalid_response_shape")

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_returns_unavailable_on_unexpected_dict_shape(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.return_value = {"unexpected": "shape"}
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["unavailableReason"], "invalid_response_shape")

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_missing_audits_still_returns_score(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.return_value = {
            "lighthouseResult": {
                "categories": {"performance": {"score": 0.6}},
            }
        }
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["performanceScore"], 60)
        self.assertIsNone(result["metrics"]["lcpMs"])
        self.assertIsNone(result["metrics"]["cls"])
        self.assertIsNone(result["metrics"]["tbtMs"])
        self.assertIsNone(result["finalUrl"])

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "s3cr3t-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_api_key_never_leaks_into_logs_on_request_failure(
        self, mock_get: Mock
    ) -> None:
        exc = requests.exceptions.ConnectionError(
            "Failed to establish a new connection: "
            "GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
            "?url=https://example.com&strategy=mobile&key=s3cr3t-key"
        )
        mock_get.side_effect = exc

        with self.assertLogs("app.integrations.pagespeed", level="WARNING") as logs:
            result = fetch_pagespeed_insights("https://example.com")

        self.assertEqual(result["status"], "unavailable")
        # The structured result never carries raw exception text.
        self.assertNotIn("s3cr3t-key", str(result))
        # And the log line has the key redacted even though the
        # underlying exception message embedded it.
        joined_logs = "\n".join(logs.output)
        self.assertNotIn("s3cr3t-key", joined_logs)
        self.assertIn("***", joined_logs)

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_successful_result_is_cached(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.return_value = GOOD_PAYLOAD
        mock_get.return_value = mock_response

        fetch_pagespeed_insights("https://example.com")
        fetch_pagespeed_insights("https://example.com")

        mock_get.assert_called_once()

    @patch.dict("os.environ", {"GOOGLE_PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_failed_result_is_not_cached(self, mock_get: Mock) -> None:
        mock_get.side_effect = requests.exceptions.Timeout("timed out")

        fetch_pagespeed_insights("https://example.com")
        fetch_pagespeed_insights("https://example.com")

        self.assertEqual(mock_get.call_count, 2)


if __name__ == "__main__":
    unittest.main()
