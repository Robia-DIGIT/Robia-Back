import unittest

from app.agents.analysis import compute_audit_result
from app.agents.ingestion import ScrapedPage


def _accessible_page() -> ScrapedPage:
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
    )


def _inaccessible_page(error: str) -> ScrapedPage:
    return ScrapedPage(
        accessible=False,
        status_code=None,
        title=None,
        meta_description=None,
        h1=[],
        h2=[],
        h3=[],
        canonical=None,
        meta_robots=None,
        images_count=0,
        images_without_alt=0,
        internal_links_count=0,
        external_links_count=0,
        word_count=0,
        main_content=None,
        error=error,
    )


class ComputeAuditResultAccessibilityTests(unittest.TestCase):
    """A 0 global_score is only ever the real score for a genuinely
    inaccessible page — this asserts the page_accessible flag that lets
    callers (RC-24's CompetitorsService in particular) tell the two apart
    instead of treating a scraper read failure as a real 0."""

    def test_page_accessible_is_true_for_a_real_audit(self):
        result = compute_audit_result(
            page=_accessible_page(), city=None, country=None, ai_readiness={}
        )

        self.assertTrue(result["page_accessible"])
        self.assertGreater(result["global_score"], 0)

    def test_page_accessible_is_false_when_the_page_could_not_be_read(self):
        result = compute_audit_result(
            page=_inaccessible_page("redirect not followed"),
            city=None,
            country=None,
            ai_readiness={},
        )

        self.assertFalse(result["page_accessible"])
        self.assertEqual(result["global_score"], 0)
        self.assertIn("redirect not followed", result["missing_data"][0])


if __name__ == "__main__":
    unittest.main()
