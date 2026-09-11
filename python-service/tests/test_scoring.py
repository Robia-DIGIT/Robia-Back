import unittest

from app.agents.audit_rules import evaluate_site_audit
from app.agents.scoring import CATEGORY_WEIGHTS, compute_seo_score_v2


def _finding(category, status, severity="medium"):
    return {"category": category, "status": status, "severity": severity}


class ComputeSeoScoreV2Tests(unittest.TestCase):
    def test_all_not_tested_yields_no_global_score(self):
        findings = [
            _finding("local", "not_tested"),
            _finding("technical", "unavailable"),
        ]

        result = compute_seo_score_v2(findings)

        self.assertIsNone(result["globalScore"])
        self.assertFalse(result["categories"]["local"]["measured"])
        self.assertFalse(result["categories"]["technical"]["measured"])

    def test_empty_findings_yields_no_global_score_but_lists_all_weighted_categories(self):
        result = compute_seo_score_v2([])

        self.assertIsNone(result["globalScore"])
        self.assertEqual(set(result["categories"]), set(CATEGORY_WEIGHTS))
        for category in CATEGORY_WEIGHTS:
            self.assertFalse(result["categories"][category]["measured"])

    def test_all_passed_scores_100(self):
        findings = [_finding("content", "passed"), _finding("content", "passed")]

        result = compute_seo_score_v2(findings)

        self.assertEqual(result["categories"]["content"]["score"], 100)
        self.assertEqual(result["globalScore"], 100)

    def test_failed_findings_reduce_the_category_score_by_severity(self):
        findings = [
            _finding("technical", "passed"),
            _finding("technical", "failed", severity="high"),  # -22
        ]

        result = compute_seo_score_v2(findings)

        self.assertEqual(result["categories"]["technical"]["score"], 78)

    def test_score_never_goes_below_zero(self):
        findings = [
            _finding("local", "failed", severity="critical"),
            _finding("local", "failed", severity="critical"),
            _finding("local", "failed", severity="critical"),
            _finding("local", "failed", severity="critical"),
        ]

        result = compute_seo_score_v2(findings)

        self.assertEqual(result["categories"]["local"]["score"], 0)

    def test_global_score_weights_only_measured_categories(self):
        # Only "content" (weight 0.20) and "local" (weight 0.25) are
        # measured; the global score must come from those two weights
        # alone, not a fabricated 5-way split.
        findings = [
            _finding("content", "passed"),  # 100
            _finding("local", "failed", severity="medium"),  # 86
        ]

        result = compute_seo_score_v2(findings)

        expected = round((100 * 0.20 + 86 * 0.25) / (0.20 + 0.25))
        self.assertEqual(result["globalScore"], expected)
        self.assertFalse(result["categories"]["technical"]["measured"])
        self.assertFalse(result["categories"]["performance"]["measured"])
        self.assertFalse(result["categories"]["ai_readiness"]["measured"])

    def test_unweighted_category_is_reported_but_excluded_from_global_score(self):
        findings = [_finding("uncategorized", "failed", severity="critical")]

        result = compute_seo_score_v2(findings)

        self.assertIn("uncategorized", result["categories"])
        self.assertIsNone(result["categories"]["uncategorized"]["weight"])
        self.assertIsNone(result["globalScore"])

    def test_findings_evaluated_counts_only_tested_statuses(self):
        findings = [
            _finding("local", "passed"),
            _finding("local", "not_tested"),
            _finding("local", "failed"),
        ]

        result = compute_seo_score_v2(findings)

        self.assertEqual(result["categories"]["local"]["findingsEvaluated"], 2)

    def test_version_is_v2(self):
        self.assertEqual(compute_seo_score_v2([])["version"], "v2")


class ComputeSeoScoreV2IntegrationTests(unittest.TestCase):
    """Feeds real evaluate_site_audit() output through the scorer, the
    same way orchestrator.run_site_audit does."""

    def setUp(self):
        self.good_page = {
            "url": "https://example.com/",
            "accessible": True,
            "status_code": 200,
            "title": "Service local à Antananarivo",
            "meta_description": "Une description utile.",
            "h1": ["Service local"],
            "canonical": "https://example.com/",
            "meta_robots": "index, follow",
            "word_count": 650,
            "images_count": 1,
            "images_without_alt": 0,
            "structured_data_types": ["LocalBusiness"],
        }
        self.site = {
            "base_url": "https://example.com",
            "pages": [self.good_page],
            "failed_urls": [],
            "business_address": "12 rue Example, Antananarivo",
            "business_latitude": -18.9,
            "business_longitude": 47.5,
        }

    def test_missing_psi_never_penalizes_the_performance_category(self):
        findings = evaluate_site_audit(
            self.site, city="Antananarivo", country="Madagascar", psi_result=None
        )

        result = compute_seo_score_v2(findings)

        self.assertFalse(result["categories"]["performance"]["measured"])
        self.assertIsNone(result["categories"]["performance"]["score"])
        # A healthy site with only performance unmeasured should not be
        # dragged down by the missing axis.
        self.assertIsNotNone(result["globalScore"])
        self.assertGreaterEqual(result["globalScore"], 80)

    def test_real_pagespeed_result_is_reflected_in_the_performance_category(self):
        psi_result = {
            "status": "ok",
            "strategy": "mobile",
            "performanceScore": 20,
            "metrics": {"lcpMs": 6000.0, "cls": 0.4, "tbtMs": 900.0, "fcpMs": 4000.0},
            "fetchedAt": "2026-09-11T00:00:00+00:00",
            "analyzedUrl": "https://example.com",
            "finalUrl": "https://example.com/",
            "source": "google_pagespeed_insights",
            "unavailableReason": None,
        }
        findings = evaluate_site_audit(
            self.site, city="Antananarivo", country="Madagascar", psi_result=psi_result
        )

        result = compute_seo_score_v2(findings)

        self.assertTrue(result["categories"]["performance"]["measured"])
        self.assertLess(result["categories"]["performance"]["score"], 100)


if __name__ == "__main__":
    unittest.main()
