import unittest

from app.agents.audit_rules import (
    evaluate_performance,
    evaluate_site_audit,
    findings_to_opportunities,
)


class AuditRulesTests(unittest.TestCase):
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
        self.bad_page = {
            "url": "https://example.com/service",
            "accessible": True,
            "status_code": 200,
            "title": None,
            "meta_description": None,
            "h1": [],
            "canonical": None,
            "meta_robots": "noindex, follow",
            "word_count": 120,
            "images_count": 3,
            "images_without_alt": 2,
            "structured_data_types": [],
        }
        self.site = {
            "base_url": "https://example.com",
            "pages": [self.good_page, self.bad_page],
            "failed_urls": [],
            "business_address": None,
            "business_latitude": None,
            "business_longitude": None,
        }

    def finding(self, findings, rule_code):
        return next(
            item for item in findings if item["rule_code"] == rule_code
        )

    def test_returns_page_level_evidence_for_verified_failures(self):
        findings = evaluate_site_audit(self.site)

        title = self.finding(findings, "on_page.title_missing")
        self.assertEqual(title["status"], "failed")
        self.assertEqual(
            title["affected_urls"],
            ["https://example.com/service"],
        )
        self.assertEqual(
            title["evidence"][0]["observed"],
            "Balise <title> absente ou vide",
        )
        self.assertTrue(title["recommended_steps"])
        self.assertGreater(title["priority_score"], 0)

    def test_marks_local_check_not_tested_without_business_context(self):
        findings = evaluate_site_audit(self.site)

        local = self.finding(findings, "local.business_address")
        self.assertEqual(local["status"], "not_tested")
        self.assertEqual(local["priority_score"], 0)
        self.assertEqual(local["affected_urls"], [])

    def test_flags_missing_address_only_with_local_context(self):
        findings = evaluate_site_audit(
            self.site,
            city="Antananarivo",
            country="Madagascar",
        )

        local = self.finding(findings, "local.business_address")
        self.assertEqual(local["status"], "failed")
        self.assertEqual(local["severity"], "high")
        self.assertTrue(local["evidence"])

    def test_opportunities_only_include_actionable_evidenced_issues(self):
        findings = evaluate_site_audit(self.site)
        opportunities = findings_to_opportunities(findings)

        self.assertGreater(len(opportunities), 0)
        self.assertLessEqual(len(opportunities), 5)
        self.assertTrue(
            all(item["audit_status"] in {"failed", "warning"}
                for item in opportunities)
        )
        self.assertTrue(
            all(item["evidence"] for item in opportunities)
        )
        self.assertTrue(
            all(item["recommended_steps"] for item in opportunities)
        )
        priorities = [item["priority_score"] for item in opportunities]
        self.assertEqual(priorities, sorted(priorities, reverse=True))

    def test_passed_rules_never_become_opportunities(self):
        site = {
            **self.site,
            "pages": [self.good_page],
            "business_address": "Antananarivo, Madagascar",
        }
        findings = evaluate_site_audit(
            site,
            city="Antananarivo",
            country="Madagascar",
        )
        opportunities = findings_to_opportunities(findings)

        passed_codes = {
            item["rule_code"]
            for item in findings
            if item["status"] == "passed"
        }
        opportunity_codes = {
            item["rule_code"] for item in opportunities
        }
        self.assertTrue(passed_codes.isdisjoint(opportunity_codes))


def _psi_ok(score, lcp_ms=None, cls=None, tbt_ms=None, fcp_ms=None):
    return {
        "status": "ok",
        "strategy": "mobile",
        "performanceScore": score,
        "metrics": {
            "lcpMs": lcp_ms,
            "cls": cls,
            "tbtMs": tbt_ms,
            "fcpMs": fcp_ms,
        },
        "fetchedAt": "2026-09-11T00:00:00+00:00",
        "analyzedUrl": "https://example.com",
        "finalUrl": "https://example.com/",
        "source": "google_pagespeed_insights",
        "unavailableReason": None,
    }


def _psi_unavailable(reason):
    return {
        "status": "unavailable",
        "strategy": "mobile",
        "performanceScore": None,
        "metrics": {"lcpMs": None, "cls": None, "tbtMs": None, "fcpMs": None},
        "fetchedAt": "2026-09-11T00:00:00+00:00",
        "analyzedUrl": "https://example.com",
        "finalUrl": None,
        "source": "google_pagespeed_insights",
        "unavailableReason": reason,
    }


class EvaluatePerformanceTests(unittest.TestCase):
    def test_not_tested_when_psi_never_attempted(self):
        finding = evaluate_performance(None, "https://example.com")

        self.assertEqual(finding["status"], "not_tested")
        self.assertEqual(finding["category"], "performance")
        self.assertEqual(finding["severity"], "info")
        self.assertEqual(finding["affected_urls"], [])
        self.assertEqual(finding["evidence"], [])

    def test_not_tested_when_psi_unavailable_mentions_reason(self):
        finding = evaluate_performance(
            _psi_unavailable("timeout"), "https://example.com"
        )

        self.assertEqual(finding["status"], "not_tested")
        self.assertIn("timeout", finding["source_data"])

    def test_passed_for_good_score(self):
        finding = evaluate_performance(
            _psi_ok(95, lcp_ms=1800.0, cls=0.05, tbt_ms=50.0, fcp_ms=900.0),
            "https://example.com",
        )

        self.assertEqual(finding["status"], "passed")
        self.assertEqual(finding["severity"], "info")
        self.assertEqual(finding["impact_score"], 0)
        self.assertEqual(finding["affected_urls"], [])
        self.assertEqual(finding["recommended_steps"], [])

    def test_failed_for_poor_score_with_metric_specific_recommendations(self):
        finding = evaluate_performance(
            _psi_ok(25, lcp_ms=5200.0, cls=0.35, tbt_ms=900.0, fcp_ms=3000.0),
            "https://example.com",
        )

        self.assertEqual(finding["status"], "failed")
        self.assertEqual(finding["severity"], "high")
        self.assertEqual(finding["affected_urls"], ["https://example.com"])
        self.assertEqual(len(finding["evidence"]), 4)
        self.assertEqual(len(finding["recommended_steps"]), 3)

    def test_warning_for_middling_score(self):
        finding = evaluate_performance(
            _psi_ok(65, lcp_ms=3000.0, cls=0.05, tbt_ms=100.0, fcp_ms=1500.0),
            "https://example.com",
        )

        self.assertEqual(finding["status"], "warning")
        self.assertEqual(finding["severity"], "medium")
        # Only LCP is above threshold here.
        self.assertEqual(len(finding["recommended_steps"]), 1)

    def test_tbt_evidence_is_not_labelled_a_core_web_vital(self):
        finding = evaluate_performance(
            _psi_ok(25, lcp_ms=5200.0, cls=0.35, tbt_ms=900.0),
            "https://example.com",
        )

        tbt_evidence = next(
            item for item in finding["evidence"] if "TBT" in item["observed"]
        )
        self.assertIn("pas un Core Web Vital", tbt_evidence["observed"])


class EvaluateSiteAuditPerformanceIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.site = {
            "base_url": "https://example.com",
            "pages": [
                {
                    "url": "https://example.com/",
                    "accessible": True,
                    "status_code": 200,
                    "title": "Service local",
                    "meta_description": "Une description utile.",
                    "h1": ["Service local"],
                    "canonical": "https://example.com/",
                    "meta_robots": "index, follow",
                    "word_count": 650,
                    "images_count": 1,
                    "images_without_alt": 0,
                    "structured_data_types": ["LocalBusiness"],
                }
            ],
            "failed_urls": [],
            "business_address": None,
            "business_latitude": None,
            "business_longitude": None,
        }

    def test_includes_not_tested_performance_finding_without_psi(self):
        findings = evaluate_site_audit(self.site)

        performance = next(
            item for item in findings if item["category"] == "performance"
        )
        self.assertEqual(performance["status"], "not_tested")

    def test_includes_real_performance_finding_with_psi(self):
        findings = evaluate_site_audit(
            self.site,
            psi_result=_psi_ok(40, lcp_ms=4500.0, cls=0.3, tbt_ms=700.0, fcp_ms=2500.0),
        )

        performance = next(
            item for item in findings if item["category"] == "performance"
        )
        self.assertEqual(performance["status"], "failed")
        self.assertEqual(performance["rule_code"], "performance.pagespeed_insights")

    def test_includes_not_tested_performance_finding_when_psi_unavailable(self):
        findings = evaluate_site_audit(
            self.site,
            psi_result=_psi_unavailable("rate_limited"),
        )

        performance = next(
            item for item in findings if item["category"] == "performance"
        )
        self.assertEqual(performance["status"], "not_tested")

    def test_failed_performance_finding_becomes_an_opportunity(self):
        findings = evaluate_site_audit(
            self.site,
            psi_result=_psi_ok(30, lcp_ms=5000.0, cls=0.3, tbt_ms=800.0, fcp_ms=2800.0),
        )
        opportunities = findings_to_opportunities(findings)

        self.assertTrue(
            any(item["category"] == "performance" for item in opportunities)
        )


if __name__ == "__main__":
    unittest.main()
