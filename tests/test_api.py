from fastapi.testclient import TestClient

from backend.app import app
from backend.schemas import AnalysisResult


client = TestClient(app)


def test_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_live_upload(document_pair):
    response = client.post("/api/analyze?mode=deterministic", files={
        "before_file": ("before.docx", document_pair[0]), "after_file": ("after.docx", document_pair[1])})
    assert response.status_code == 200
    assert AnalysisResult.model_validate(response.json()).summary.created_units == 1


def test_invalid_document_returns_useful_error():
    response = client.post("/api/analyze", files={"before_file": ("bad.docx", b"bad"), "after_file": ("bad.docx", b"bad")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_document"


def test_missing_semantic_configuration(document_pair, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    response = client.post("/api/analyze?mode=semantic", files={
        "before_file": ("before.docx", document_pair[0]), "after_file": ("after.docx", document_pair[1])})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "semantic_not_configured"


def test_bad_mode(document_pair):
    response = client.post("/api/analyze?mode=invalid", files={
        "before_file": ("before.docx", document_pair[0]), "after_file": ("after.docx", document_pair[1])})
    assert response.status_code == 422
