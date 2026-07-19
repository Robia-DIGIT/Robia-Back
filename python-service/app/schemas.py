from pydantic import BaseModel
from typing import Optional


class AuditRequest(BaseModel):
    url: str
    sector: Optional[str] = None
    city: Optional[str] = None


class Subscores(BaseModel):
    local: int
    technical: int
    content: int
    performance: int


class AuditResult(BaseModel):
    global_score: int
    subscores: Subscores
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


class GeneratedAction(BaseModel):
    title: str
