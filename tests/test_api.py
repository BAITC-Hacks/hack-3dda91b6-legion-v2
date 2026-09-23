from fastapi.testclient import TestClient
import httpx
from openai import OpenAI
import pytest

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


@pytest.mark.parametrize("key, code", [
    ("", "semantic_not_configured"),
    ("не-настоящий-ключ", "semantic_invalid_configuration"),
    ("sk-contains whitespace", "semantic_invalid_configuration"),
    ("sk-contains\x7fcontrol", "semantic_invalid_configuration"),
])
def test_invalid_key_never_reaches_sdk(document_pair, monkeypatch, key, code):
    monkeypatch.setenv("OPENAI_MODEL", "gpt-6-astra")
    monkeypatch.setenv("OPENAI_API_KEY", key)
    def unexpected_client(**kwargs):
        pytest.fail("Invalid credentials must be rejected before constructing an SDK client")
    monkeypatch.setattr("backend.semantic.OpenAI", unexpected_client)
    response = client.post("/api/analyze?mode=semantic", files={
        "before_file": ("before.docx", document_pair[0]), "after_file": ("after.docx", document_pair[1])})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == code
    if key:
        assert key not in response.json()["error"]["message"]


def test_sdk_timeout_returns_safe_api_error(document_pair, monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "gpt-6-astra")
    monkeypatch.setenv("OPENAI_API_KEY", "test-placeholder")
    calls = []
    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout("sensitive-provider-body", request=request)
    with OpenAI(api_key="test-placeholder", max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(timeout))) as sdk:
        monkeypatch.setattr("backend.semantic.OpenAI", lambda **kwargs: sdk)
        response = client.post("/api/analyze?mode=semantic", files={
            "before_file": ("before.docx", document_pair[0]), "after_file": ("after.docx", document_pair[1])})
    assert len(calls) == 1
    assert response.status_code == 504
    assert response.json()["error"]["code"] == "semantic_timeout"
    assert "sensitive-provider-body" not in response.text
    assert "test-placeholder" not in response.text
