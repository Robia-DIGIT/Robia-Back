import os
import unittest
from unittest.mock import patch

from app.agents import ingestion
from app.agents.ingestion import ScrapedPage, crawl_website


def _accessible_page(url: str) -> ScrapedPage:
    return ScrapedPage(
        accessible=True,
        status_code=200,
        title="Title",
        meta_description="Description",
        h1=["H1"],
        h2=[],
        h3=[],
        canonical=None,
        meta_robots=None,
        images_count=0,
        images_without_alt=0,
        internal_links_count=0,
        external_links_count=0,
        word_count=100,
        main_content="Content",
        requested_url=url,
    )


class CrawlWebsiteMetricsTests(unittest.TestCase):
    """RC-15: crawl_website is the one "crawl" external-call surface named
    in the Codex review for minimal duration/success-failure/provider
    metrics — see pagespeed.py's fetch_pagespeed_insights for the same
    pattern applied to the PSI provider."""

    @patch.dict(os.environ, {"DISABLE_JS_RENDERING": "true"}, clear=False)
    @patch("app.agents.ingestion.scrape_website")
    @patch("app.agents.ingestion._discover_from_sitemap")
    def test_logs_a_success_metric_with_provider_and_page_counts(
        self, mock_sitemap, mock_scrape
    ):
        mock_sitemap.return_value = ["https://example.com/page1"]
        mock_scrape.return_value = _accessible_page("https://example.com/page1")

        with self.assertLogs("app.agents.ingestion", level="INFO") as logs:
            site = crawl_website("https://example.com", max_pages=5, max_depth=1)

        self.assertEqual(len(site.pages), 1)
        record = next(r for r in logs.records if r.msg == "external_call_metric")
        self.assertEqual(record.provider, "site_crawl")
        self.assertEqual(record.operation, "crawl_website")
        self.assertTrue(record.success)
        self.assertEqual(record.pagesFetched, 1)
        self.assertEqual(record.pagesFailed, 0)
        self.assertIsInstance(record.durationMs, float)
        self.assertGreaterEqual(record.durationMs, 0)

    @patch.dict(os.environ, {"DISABLE_JS_RENDERING": "true"}, clear=False)
    @patch("app.agents.ingestion.scrape_website")
    @patch("app.agents.ingestion._discover_from_sitemap")
    def test_logs_a_failure_metric_when_the_crawl_raises(
        self, mock_sitemap, mock_scrape
    ):
        mock_sitemap.return_value = ["https://example.com/page1"]
        mock_scrape.side_effect = RuntimeError("boom")

        with self.assertLogs("app.agents.ingestion", level="INFO") as logs:
            with self.assertRaises(RuntimeError):
                crawl_website("https://example.com", max_pages=5, max_depth=1)

        record = next(r for r in logs.records if r.msg == "external_call_metric")
        self.assertEqual(record.provider, "site_crawl")
        self.assertFalse(record.success)


if __name__ == "__main__":
    unittest.main()
