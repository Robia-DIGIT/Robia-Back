from fastapi import FastAPI
from app.schemas import AuditRequest, AuditResult, OpportunityRequest, GeneratedOpportunity
from app.orchestrator import run_audit, run_opportunity_generation

app = FastAPI(title="Robia AI Engine")


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/audit", response_model=AuditResult)
def audit(request: AuditRequest):
    result = run_audit(request.url, request.city)
    return result


@app.post("/opportunities", response_model=list[GeneratedOpportunity])
def generate_opportunities(request: OpportunityRequest):
    result = run_opportunity_generation(request.audit_result, request.city)
    return result