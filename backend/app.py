import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .parser import DocumentError, MAX_FILE_BYTES
from .pipeline import analyze
from .schemas import AnalysisResult
from .semantic import SemanticError


app = FastAPI(title="Organizational Analysis Core", version="0.1.0")
origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://localhost:5173").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


@app.exception_handler(DocumentError)
async def invalid_document(request, exc):
    return JSONResponse(status_code=422, content={"error": {"code": "invalid_document", "message": str(exc)}})


@app.exception_handler(SemanticError)
async def semantic_error(request, exc):
    return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": str(exc)}})


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/analyze", response_model=AnalysisResult)
async def analyze_uploads(
    before_file: UploadFile = File(...),
    after_file: UploadFile = File(...),
    mode: Literal["deterministic", "semantic"] | None = Query(None),
):
    try:
        before = await before_file.read(MAX_FILE_BYTES + 1)
        after = await after_file.read(MAX_FILE_BYTES + 1)
        selected_mode = mode or os.getenv("ANALYSIS_MODE", "deterministic")
        if selected_mode not in ("deterministic", "semantic"):
            return JSONResponse(status_code=503, content={"error": {"code": "invalid_configuration", "message": "ANALYSIS_MODE must be deterministic or semantic."}})
        return await run_in_threadpool(
            analyze, before, after, before_name=before_file.filename or "before.docx",
            after_name=after_file.filename or "after.docx", mode=selected_mode,
        )
    finally:
        await before_file.close()
        await after_file.close()


@app.get("/api/demo", response_model=AnalysisResult)
def demo():
    data = Path(__file__).resolve().parents[1] / "data"
    before = sorted(data.glob("*_8_*.docx"))
    after = sorted(data.glob("*_9_*.docx"))
    if len(before) != 1 or len(after) != 1:
        return JSONResponse(status_code=404, content={"error": {"code": "demo_not_available", "message": "Place the revision 8 and revision 9 DOCX files in the local data directory."}})
    return analyze(before[0], after[0], mode="deterministic")
