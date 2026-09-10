import unittest

from app.agents.audit_rules import (
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


if __name__ == "__main__":
    unittest.main()
