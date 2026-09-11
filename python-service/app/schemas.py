from pydantic import BaseModel, Field
from typing import Optional, Dict


class AuditRequest(BaseModel):
    url: str
    sector: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None


class Subscores(BaseModel):
    local: int
    technical: int
    content: int
    performance: int
    ai_readiness: int


class AiReadinessBreakdown(BaseModel):
    structure: int
    authority: int
    clarity: int
    coherence: int


class TechnicalDetails(BaseModel):
    schema_org_types: list[str]
    og_tags_present: list[str]
    viewport_present: bool
    response_time_ms: Optional[float] = None
    redirect_count: int
    html_lang: Optional[str] = None
    business_address: Optional[str] = None
    business_latitude: Optional[float] = None
    business_longitude: Optional[float] = None
    js_rendering_used: bool = False
    social_links: Dict[str, str] = {}
    top_keywords: list[str] = []


class AuditResult(BaseModel):
    global_score: int
    subscores: Subscores
    ai_readiness_breakdown: AiReadinessBreakdown
    technical_details: TechnicalDetails
    strengths: list[str]
    missing_data: list[str]
    summary: str


class SiteAuditRequest(BaseModel):
    url: str
    max_pages: int = 20
    max_depth: int = 2
    city: Optional[str] = None
    country: Optional[str] = None


class PageDetail(BaseModel):
    url: str
    accessible: bool
    status_code: Optional[int] = None
    title: Optional[str] = None
    meta_description: Optional[str] = None
    h1: list[str] = []
    h2: list[str] = []
    h3: list[str] = []
    canonical: Optional[str] = None
    meta_robots: Optional[str] = None
    word_count: int = 0
    images_count: int = 0
    images_without_alt: int = 0
    internal_links_count: int = 0
    external_links_count: int = 0
    structured_data_types: list[str] = []
    og_tags_present: list[str] = []
    top_keywords: list[str] = []
    business_address: Optional[str] = None
    business_latitude: Optional[float] = None
    business_longitude: Optional[float] = None
    social_links: Dict[str, str] = {}
    js_rendering_used: bool = False
    js_rendering_suspected: bool = False
    main_content: Optional[str] = None
    error: Optional[str] = None


class FindingEvidence(BaseModel):
    url: str
    observed: str
    expected: str


class DetailedFinding(BaseModel):
    rule_code: str
    title: str
    category: str
    status: str
    severity: str
    impact_score: int
    effort_score: int
    confidence_score: float
    priority_score: int
    affected_urls: list[str] = Field(default_factory=list)
    evidence: list[FindingEvidence] = Field(default_factory=list)
    source_data: str
    why_it_matters: str
    recommended_steps: list[str] = Field(default_factory=list)


class PageSpeedMetrics(BaseModel):
    # Deliberately camelCase: this mirrors the cross-service PSI
    # contract field names (RC-10/RC-11), not this file's usual
    # snake_case convention.
    lcpMs: Optional[float] = None
    cls: Optional[float] = None
    tbtMs: Optional[float] = None  # lab proxy for interactivity, not a Core Web Vital
    fcpMs: Optional[float] = None


class PageSpeedInsightsResult(BaseModel):
    """Structured PageSpeed Insights contract exposed on SiteAuditResult
    for RC-11 to consume directly, without re-deriving values from the
    "performance" finding's evidence text. Never influences the audit's
    overall SEO score."""

    status: str  # "ok" | "unavailable"
    strategy: str
    performanceScore: Optional[int] = None
    metrics: PageSpeedMetrics
    fetchedAt: str
    analyzedUrl: str
    finalUrl: Optional[str] = None
    source: str
    unavailableReason: Optional[str] = None


class SeoCategoryScoreV2(BaseModel):
    score: Optional[int] = None
    weight: Optional[float] = None
    measured: bool
    findingsEvaluated: int


class SeoScoreV2(BaseModel):
    """Explainable, weighted SEO score (RC-12). Additive: does not
    replace SiteAuditResult's legacy scoring (there isn't one on this
    v2 payload) nor AuditResult.global_score (the older single-page
    path, untouched). See app.agents.scoring for the formula."""

    version: str
    globalScore: Optional[int] = None
    categories: dict[str, SeoCategoryScoreV2]


class SiteAuditResult(BaseModel):
    base_url: str
    discovery_method: str
    pages_discovered: int
    pages_analyzed: int
    pages_failed: int
    pages_excluded: int

    pages_count: int
    pages_with_h1: int
    pages_without_h1: int
    pages_with_meta_description: int
    pages_without_meta_description: int
    pages_with_schema: int
    pages_without_schema: int
    pages_with_og: int
    pages_without_og: int

    avg_word_count: float

    business_address: Optional[str] = None
    business_latitude: Optional[float] = None
    business_longitude: Optional[float] = None
    location_precision: str = "none"    

    social_links: Dict[str, str] = {}
    top_keywords: list[str] = []

    findings: list[str]
    detailed_findings: list[DetailedFinding] = Field(default_factory=list)
    pagespeed_insights: Optional[PageSpeedInsightsResult] = None
    seo_score_v2: Optional[SeoScoreV2] = None
    pages: list[PageDetail]
    failed_urls: list[str] = []


class OpportunityRequest(BaseModel):
    audit_result: dict
    city: Optional[str] = None


class SiteOpportunityRequest(BaseModel):
    site_audit_result: dict
    city: Optional[str] = None
    country: Optional[str] = None
    

class GeneratedOpportunity(BaseModel):
    title: str
    description: str
    category: str
    impact_score: int
    effort_score: int
    confidence_score: float
    source_data: str
    rule_code: Optional[str] = None
    severity: Optional[str] = None
    audit_status: Optional[str] = None
    priority_score: Optional[int] = None
    affected_urls: list[str] = Field(default_factory=list)
    evidence: list[FindingEvidence] = Field(default_factory=list)
    why_it_matters: Optional[str] = None
    recommended_steps: list[str] = Field(default_factory=list)


class DocumentRequest(BaseModel):
    type: str
    opportunity_title: str
    opportunity_description: str


class GeneratedDocument(BaseModel):
    title: str
    content: str


class ActionRequest(BaseModel):
    opportunity_title: str
    opportunity_description: str


class GeneratedAction(BaseModel):
    title: str

