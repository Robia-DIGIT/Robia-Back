import unittest
from unittest.mock import Mock, patch

import requests

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
    }
}


class FetchPageSpeedInsightsTests(unittest.TestCase):
    @patch.dict("os.environ", {}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_skips_without_api_key(self, mock_get: Mock) -> None:
        result = fetch_pagespeed_insights("https://example.com")

        self.assertIsNone(result)
        mock_get.assert_not_called()

    @patch.dict("os.environ", {"PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_parses_successful_response(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.return_value = GOOD_PAYLOAD
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["performance_score"], 95)
        self.assertEqual(result["lcp_ms"], 1800.0)
        self.assertEqual(result["cls"], 0.05)
        self.assertEqual(result["tbt_ms"], 50.0)
        self.assertEqual(result["fcp_ms"], 900.0)

        called_kwargs = mock_get.call_args.kwargs
        self.assertEqual(called_kwargs["params"]["strategy"], "mobile")
        self.assertEqual(called_kwargs["params"]["url"], "https://example.com")
        self.assertEqual(called_kwargs["params"]["key"], "test-key")

    @patch.dict("os.environ", {"PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_returns_none_on_http_error(self, mock_get: Mock) -> None:
        mock_get.side_effect = requests.exceptions.HTTPError("400 Bad Request")

        result = fetch_pagespeed_insights("https://example.com")

        self.assertIsNone(result)

    @patch.dict("os.environ", {"PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_returns_none_on_timeout(self, mock_get: Mock) -> None:
        mock_get.side_effect = requests.exceptions.Timeout("timed out")

        result = fetch_pagespeed_insights("https://example.com")

        self.assertIsNone(result)

    @patch.dict("os.environ", {"PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_returns_none_on_malformed_json(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.side_effect = ValueError("no JSON object could be decoded")
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        self.assertIsNone(result)

    @patch.dict("os.environ", {"PAGESPEED_API_KEY": "test-key"}, clear=True)
    @patch("app.integrations.pagespeed.requests.get")
    def test_returns_none_on_unexpected_payload_shape(self, mock_get: Mock) -> None:
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_response.json.return_value = {"unexpected": "shape"}
        mock_get.return_value = mock_response

        result = fetch_pagespeed_insights("https://example.com")

        self.assertIsNone(result)

    @patch.dict("os.environ", {"PAGESPEED_API_KEY": "test-key"}, clear=True)
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

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["performance_score"], 60)
        self.assertIsNone(result["lcp_ms"])
        self.assertIsNone(result["cls"])
        self.assertIsNone(result["tbt_ms"])


if __name__ == "__main__":
    unittest.main()
