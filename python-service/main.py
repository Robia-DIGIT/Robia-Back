from fastapi import FastAPI
from app.schemas import AuditRequest, AuditResult
from app.orchestrator import run_audit

app = FastAPI(title="Robia AI Engine")


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/audit", response_model=AuditResult)
def audit(request: AuditRequest):
    result = run_audit(request.url, request.city)
    return result