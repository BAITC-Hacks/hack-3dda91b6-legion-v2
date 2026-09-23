import json
import traceback
from types import SimpleNamespace

import httpx
from openai import OpenAI
import pytest

from backend.evidence import evidence_exists
from backend.parser import parse_document
from backend.pipeline import analyze_parsed
from backend.semantic import FunctionRelation, OpenAISemanticAnalyzer, SemanticError, SemanticFinding, SemanticProposal, UnitRelation


def proposal(**changes):
    defaults = dict(unit_relations=[], function_relations=[], findings=[], conclusion="", conclusion_before_clause_ids=[], conclusion_after_clause_ids=[])
    defaults.update(changes)
    return SemanticProposal(**defaults)


def fake_client(value, status="completed"):
    return SimpleNamespace(responses=SimpleNamespace(parse=lambda **kwargs: SimpleNamespace(output_parsed=value, status=status)))


@pytest.mark.parametrize("model", ["test-model", "gpt-6-astra"])
def test_official_sdk_structured_output_roundtrip(document_pair, model):
    calls = []
    def handle(request):
        body = json.loads(request.content)
        calls.append(body)
        assert body["model"] == model
        if model == "gpt-6-astra":
            assert body["reasoning"] == {"effort": "low"}
        assert body["store"] is False
        assert body["text"]["format"]["type"] == "json_schema"
        assert body["text"]["format"]["strict"] is True
        return httpx.Response(200, json={
            "id": "resp_test", "object": "response", "created_at": 0, "status": "completed",
            "model": "test-model", "parallel_tool_calls": False, "tool_choice": "auto", "tools": [],
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": proposal().model_dump_json(), "annotations": []}]}],
        })
    with OpenAI(api_key="test-placeholder", http_client=httpx.Client(transport=httpx.MockTransport(handle))) as client:
        before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
        result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(client, model))
    assert len(calls) == 1
    assert result.analysis_mode == "semantic"
    assert "Reviewing semantic relations with OpenAI" in result.agent_trace


def test_unknown_model_references_rejected(document_pair):
    value = proposal()
    value.function_relations = [FunctionRelation(before_id="fake", after_ids=["fake"], status="MOVED", confidence=1, explanation="Unsupported")]
    value.findings = [SemanticFinding(type="MOVED", severity="HIGH", title="Unsupported", explanation="Unsupported", confidence=1,
                                     before_clause_ids=["fake"], after_clause_ids=["fake"], recommendation="Review")]
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(fake_client(value), "test-model"))
    assert not any(f.title == "Unsupported" for f in result.findings)
    assert any("Rejected 2" in w for w in result.warnings)
    assert all(evidence_exists(e, [before, after]) for f in result.findings for e in f.before_evidence + f.after_evidence)


def test_semantic_function_override_uses_original_quotes(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    baseline = analyze_parsed(before, after)
    original = next(m for m in baseline.function_matches if m.status == "MOVED")
    value = proposal()
    value.function_relations = [FunctionRelation(before_id=original.before_function, after_ids=[original.after_function], status="CHANGED", confidence=0.8, explanation="Изменена область ответственности.")]
    result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(fake_client(value), "test-model"))
    updated = next(m for m in result.function_matches if m.before_function == original.before_function)
    assert updated.status == "CHANGED"
    assert updated.before_evidence == original.before_evidence
    assert updated.after_evidence == original.after_evidence
    assert updated.verification_status == "NEEDS_REVIEW"


@pytest.mark.parametrize("status", ["incomplete", "failed"])
def test_incomplete_response_is_clear_error(document_pair, status):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    with pytest.raises(SemanticError, match="complete structured"):
        analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(fake_client(proposal(), status), "test-model"))


def test_provider_error_is_sanitized(document_pair):
    def handle(request):
        return httpx.Response(401, json={"error": {"message": "sensitive-provider-body", "type": "invalid_api_key", "code": "invalid_api_key"}})
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    with OpenAI(api_key="test-placeholder", max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(handle))) as client:
        with pytest.raises(SemanticError) as exc:
            analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(client, "test-model"))
    assert "sensitive-provider-body" not in str(exc.value)
    assert "test-placeholder" not in str(exc.value)
    assert exc.value.code == "semantic_authentication_failed"
    assert "sensitive-provider-body" not in "".join(traceback.format_exception(exc.value))


@pytest.mark.parametrize("status, code", [
    (404, "semantic_model_unavailable"),
    (429, "semantic_rate_limited"),
    (500, "semantic_unavailable"),
])
def test_provider_failure_codes(document_pair, status, code):
    def handle(request):
        return httpx.Response(status, json={"error": {"message": "sensitive-provider-body"}})
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    with OpenAI(api_key="test-placeholder", max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(handle))) as client:
        with pytest.raises(SemanticError) as exc:
            analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(client, "test-model"))
    assert exc.value.code == code
    assert exc.value.status_code == 503
    assert "sensitive-provider-body" not in "".join(traceback.format_exception(exc.value))


@pytest.mark.parametrize("model_text", ["{not-json", "{}", json.dumps({**proposal().model_dump(), "invented_units": ["Fake department"]})])
def test_malformed_sdk_output_is_rejected(document_pair, model_text):
    def handle(request):
        return httpx.Response(200, json={
            "id": "resp_test", "object": "response", "created_at": 0, "status": "completed",
            "model": "test-model", "parallel_tool_calls": False, "tool_choice": "auto", "tools": [],
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": model_text, "annotations": []}]}],
        })
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    with OpenAI(api_key="test-placeholder", max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(handle))) as client:
        with pytest.raises(SemanticError) as exc:
            analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(client, "test-model"))
    assert exc.value.code == "semantic_invalid_output"
    assert exc.value.status_code == 502
    assert model_text not in "".join(traceback.format_exception(exc.value))


def test_wrong_side_ids_and_unsupported_conclusion_are_rejected(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    baseline = analyze_parsed(before, after)
    before_unit = next(u for u in baseline.units if u.document == before.name and u.functions)
    after_unit = next(u for u in baseline.units if u.document == after.name and u.functions)
    value = proposal(
        unit_relations=[UnitRelation(before_ids=[after_unit.id], after_ids=[before_unit.id], type="RENAMED", confidence=1, explanation="Unsupported")],
        function_relations=[FunctionRelation(before_id=after_unit.functions[0].id, after_ids=[before_unit.functions[0].id], status="MOVED", confidence=1, explanation="Unsupported")],
        findings=[SemanticFinding(type="MOVED", severity="HIGH", title="Unsupported", explanation="Unsupported", confidence=1,
                                  before_clause_ids=[after.clauses[-1].id], after_clause_ids=[before.clauses[-1].id], recommendation="Review")],
        conclusion="Unsupported conclusion", conclusion_before_clause_ids=["nonexistent"], conclusion_after_clause_ids=[after.clauses[1].id],
    )
    result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(fake_client(value), "test-model"))
    assert result.units == baseline.units
    assert result.transformations == baseline.transformations
    assert result.function_matches == baseline.function_matches
    assert result.findings == baseline.findings
    assert result.summary.analytical_note is None
    assert any("Rejected 4" in w for w in result.warnings)


def test_model_split_preserves_each_edge(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    baseline = analyze_parsed(before, after)
    a = next(u for u in baseline.units if u.document == before.name and u.parent)
    b = [u for u in baseline.units if u.document == after.name and u.parent][:2]
    value = proposal()
    value.unit_relations = [UnitRelation(before_ids=[a.id], after_ids=[u.id for u in b], type="SPLIT", confidence=0.8, explanation="Кандидат на разделение.")]
    result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(fake_client(value), "test-model"))
    edges = [t for t in result.transformations if t.type == "SPLIT"]
    assert len(edges) == 2
    assert {t.after_unit for t in edges} == {u.id for u in b}
    assert all(t.evidence and t.verification_status == "NEEDS_REVIEW" for t in edges)


def test_semantic_conclusion_keeps_sources_and_review_status(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    value = proposal(conclusion="Структуру следует проверить по перечням подразделений.",
                     conclusion_before_clause_ids=[before.clauses[1].id], conclusion_after_clause_ids=[after.clauses[1].id])
    result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(fake_client(value), "test-model"))
    assert result.summary.analytical_note == value.conclusion
    assert result.summary.note_verification_status == "NEEDS_REVIEW"
    assert len(result.summary.note_evidence) == 2
    assert all(evidence_exists(e, [before, after]) for e in result.summary.note_evidence)


def test_preserved_relation_does_not_verify_model_embellishment(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    baseline = analyze_parsed(before, after)
    match = next(m for m in baseline.function_matches if m.verification_status == "VERIFIED")
    value = proposal()
    value.function_relations = [FunctionRelation(before_id=match.before_function, after_ids=[match.after_function], status="PRESERVED", confidence=1, explanation="Unsupported additional claim.")]
    result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(fake_client(value), "test-model"))
    verified = next(m for m in result.function_matches if m.before_function == match.before_function)
    assert verified.verification_status == "VERIFIED"
    assert "Unsupported" not in verified.explanation


@pytest.mark.parametrize("blank", ["", " \t\n"])
@pytest.mark.parametrize("target", ["unit", "function", "title", "explanation", "recommendation"])
def test_blank_model_text_rejects_only_the_invalid_proposal(document_pair, blank, target):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    baseline = analyze_parsed(before, after)
    a = next(u for u in baseline.units if u.document == before.name and u.functions)
    b = next(u for u in baseline.units if u.document == after.name and u.functions)
    value = proposal(conclusion="Review the documented changes.",
                     conclusion_before_clause_ids=[before.clauses[1].id],
                     conclusion_after_clause_ids=[after.clauses[1].id])
    if target == "unit":
        value.unit_relations = [UnitRelation(before_ids=[a.id], after_ids=[b.id],
                                            type="RENAMED", confidence=0.7, explanation=blank)]
    elif target == "function":
        value.function_relations = [FunctionRelation(before_id=a.functions[0].id, after_ids=[b.functions[0].id],
                                                    status="CHANGED", confidence=0.7, explanation=blank)]
    else:
        finding = SemanticFinding(type="MOVED", severity="MEDIUM", title="Review transfer",
                                  explanation="Check the assignment.", confidence=0.7,
                                  before_clause_ids=[a.functions[0].clause_id],
                                  after_clause_ids=[b.functions[0].clause_id], recommendation="Review sources.")
        setattr(finding, target, blank)
        value.findings = [finding]

    def handle(request):
        return httpx.Response(200, json={
            "id": "resp_test", "object": "response", "created_at": 0, "status": "completed",
            "model": "test-model", "parallel_tool_calls": False, "tool_choice": "auto", "tools": [],
            "output": [{"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": value.model_dump_json(), "annotations": []}]}],
        })
    with OpenAI(api_key="test-placeholder", http_client=httpx.Client(transport=httpx.MockTransport(handle))) as sdk:
        result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(sdk, "test-model"))
    assert result.transformations == baseline.transformations
    assert result.function_matches == baseline.function_matches
    assert result.findings == baseline.findings
    assert result.summary.analytical_note == value.conclusion
    assert len(result.summary.note_evidence) == 2
    assert any("Rejected 1" in warning for warning in result.warnings)
    assert all(item.explanation.strip() for item in result.transformations + result.function_matches + result.findings)


def test_whitespace_only_optional_note_is_omitted(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    value = proposal(conclusion=" \t\n", conclusion_before_clause_ids=[before.clauses[1].id],
                     conclusion_after_clause_ids=[after.clauses[1].id])
    result = analyze_parsed(before, after, "semantic", OpenAISemanticAnalyzer(fake_client(value), "test-model"))
    assert result.summary.analytical_note is None
    assert result.summary.note_evidence == []
