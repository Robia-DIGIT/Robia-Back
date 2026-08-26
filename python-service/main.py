from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from app.schemas import AuditRequest, AuditResult, SiteAuditRequest, SiteAuditResult, OpportunityRequest, GeneratedOpportunity, DocumentRequest, GeneratedDocument, ActionRequest, GeneratedAction, SiteOpportunityRequest
from app.orchestrator import run_audit, run_site_audit, run_opportunity_generation, run_site_opportunity_generation, run_document_generation, run_action_generation

app = FastAPI(title="Robia AI Engine")


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/audit", response_model=AuditResult)
def audit(request: AuditRequest):
    return run_audit(url=request.url, sector=request.sector, city=request.city, country=request.country)


@app.post("/audit/site", response_model=SiteAuditResult)
def audit_site(request: SiteAuditRequest):
    return run_site_audit(url=request.url, max_pages=request.max_pages, max_depth=request.max_depth, city=request.city, country=request.country)


@app.post("/opportunities", response_model=list[GeneratedOpportunity])
def generate_opportunities(request: OpportunityRequest):
    result = run_opportunity_generation(request.audit_result, request.city)
    return result

@app.post("/opportunities/site", response_model=list[GeneratedOpportunity])
def generate_site_opportunities_route(request: SiteOpportunityRequest):
    return run_site_opportunity_generation(request.site_audit_result, request.city, request.country)


@app.post("/documents", response_model=GeneratedDocument)
def generate_document(request: DocumentRequest):
    result = run_document_generation(
        request.type,
        request.opportunity_title,
        request.opportunity_description
    )
    return result


@app.post("/actions", response_model=list[GeneratedAction])
def actions(request: ActionRequest):
    result = run_action_generation(
        request.opportunity_title,
        request.opportunity_description,
    )
    return result