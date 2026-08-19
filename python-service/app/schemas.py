from pydantic import BaseModel
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


class AuditResult(BaseModel):
    global_score: int
    subscores: Subscores
    ai_readiness_breakdown: AiReadinessBreakdown
    technical_details: TechnicalDetails
    strengths: list[str]
    missing_data: list[str]
    summary: str


class OpportunityRequest(BaseModel):
    audit_result: dict
    city: Optional[str] = None


class GeneratedOpportunity(BaseModel):
    title: str
    description: str
    category: str
    impact_score: int
    effort_score: int
    confidence_score: float
    source_data: str


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

