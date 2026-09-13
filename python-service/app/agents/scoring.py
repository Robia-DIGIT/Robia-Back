"""SEO V2 scoring (RC-12) — explainable, weighted, "not measured" is never
a penalty.

This is a deliberately scoped first slice of the RC-12 plan: an explicit,
testable score formula. It does not expand rule coverage (still the rules
introduced through RC-10) and it does not touch or replace the legacy
score (`Audit.globalScore` / `resultJson.global_score`, computed by
`analysis.py`'s `compute_audit_result` for the older single-page path) —
that is a separate decision (recompute existing audits vs. freeze them)
left to product/Romeo-Landry, not something to improvise here.

## Why not the legacy formula

`compute_audit_result` averages five numbers, one of which used to be a
fake performance heuristic (RC-10 replaced that particular gap, but the
averaging itself was never explainable: a config problem and a genuine
SEO failure moved the same score by the same amount). It also has no way
to represent "not measured" — a category with nothing to say about it.

## This formula

1. Group `detailed_findings` (the evidence-based v2 findings — see
   `audit_rules.py`) by `category`.
2. Score each category independently, from only its own findings:
   - findings with status "not_tested" or "unavailable" are ignored —
     they never contribute a penalty, positive or negative;
   - among the remaining ("passed" / "warning" / "failed") findings,
     subtract each non-"passed" finding's severity penalty (the same
     `SEVERITY_WEIGHTS` scale audit_rules.py already uses for
     `priority_score`, so the same "critical > high > medium > low >
     info" ordering means the same thing in both places) from 100,
     clamped to [0, 100];
   - a category with zero tested findings scores `None` ("not
     measured"), not 0 and not 100.
3. The global score is the weighted average of CATEGORY_WEIGHTS, but
   only over the categories that *are* measured — weights are not
   renormalized to fabricate certainty, the divisor is simply the sum of
   the weights actually available. A site where only "technical" and
   "content" have been evaluated gets a global score computed from
   those two axes' weights alone, not from an assumption about the
   other three.
4. If nothing at all is measured, the global score is `None`.

CATEGORY_WEIGHTS is a proposal, not a final product decision — see the
RC-12 plan handoff for the reasoning and for the open question of
whether "ai_readiness" (LLM-derived, not deterministic) belongs at the
same weight class as the four rule-based axes.
"""

from __future__ import annotations

from typing import Any, Optional, TypedDict

from app.agents.audit_rules import SEVERITY_WEIGHTS

# Proposal (RC-12 plan): sums to 1.0. "local" weighted highest because
# ROBIA's stated product focus is local SEO for PMEs; "ai_readiness" is
# weighted lowest because it is LLM-derived reasoning, not a
# deterministic, reproducible rule like the other four axes.
CATEGORY_WEIGHTS: dict[str, float] = {
    "local": 0.25,
    "technical": 0.20,
    "content": 0.20,
    "performance": 0.20,
    "ai_readiness": 0.15,
}

TESTED_STATUSES = {"passed", "warning", "failed"}


class CategoryScore(TypedDict):
    score: Optional[int]
    weight: Optional[float]
    measured: bool
    findingsEvaluated: int


class SeoScoreV2(TypedDict):
    version: str
    globalScore: Optional[int]
    categories: dict[str, CategoryScore]


def _category_score(findings: list[dict[str, Any]]) -> tuple[Optional[int], int]:
    tested = [f for f in findings if f.get("status") in TESTED_STATUSES]
    if not tested:
        return None, 0

    penalty = sum(
        SEVERITY_WEIGHTS.get(str(finding.get("severity", "info")), 0)
        for finding in tested
        if finding.get("status") != "passed"
    )
    return max(0, min(100, 100 - penalty)), len(tested)


def compute_seo_score_v2(findings: list[dict[str, Any]]) -> SeoScoreV2:
    by_category: dict[str, list[dict[str, Any]]] = {}
    for finding in findings:
        category = str(finding.get("category") or "uncategorized")
        by_category.setdefault(category, []).append(finding)

    categories: dict[str, CategoryScore] = {}
    for category in sorted(set(by_category) | set(CATEGORY_WEIGHTS)):
        score, evaluated = _category_score(by_category.get(category, []))
        categories[category] = CategoryScore(
            score=score,
            weight=CATEGORY_WEIGHTS.get(category),
            measured=score is not None,
            findingsEvaluated=evaluated,
        )

    available = {
        category: data["score"]
        for category, data in categories.items()
        if data["measured"] and data["weight"] is not None
    }

    global_score: Optional[int] = None
    if available:
        weight_sum = sum(CATEGORY_WEIGHTS[category] for category in available)
        weighted_total = sum(
            score * CATEGORY_WEIGHTS[category] for category, score in available.items()
        )
        global_score = round(weighted_total / weight_sum)

    return SeoScoreV2(version="v2", globalScore=global_score, categories=categories)
