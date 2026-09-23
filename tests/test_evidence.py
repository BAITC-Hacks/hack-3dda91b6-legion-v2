import pytest

from backend.evidence import evidence_exists, verify_evidence
from backend.extraction import evidence
from backend.parser import parse_document
from backend.pipeline import analyze_parsed


@pytest.mark.parametrize("field,value", [("text", "Выдуманная цитата"), ("section", "999.1"), ("document", "nonexistent.docx"), ("clause_id", "invented")])
def test_evidence_rejects_fabricated_source(document_pair, field, value):
    before = parse_document(document_pair[0], "before.docx")
    source = evidence(before, before.clauses[0])
    assert evidence_exists(source, [before])
    assert not evidence_exists(source.model_copy(update={field: value}), [before])


def test_every_emitted_quote_exists_in_its_source(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    result = analyze_parsed(before, after)
    for finding in result.findings:
        assert finding.before_evidence or finding.after_evidence
        assert all(evidence_exists(e, [before]) for e in finding.before_evidence)
        assert all(evidence_exists(e, [after]) for e in finding.after_evidence)
    assert any(t.verification_status == "VERIFIED" for t in result.transformations)
    assert all(t.verification_status == "NEEDS_REVIEW" for t in result.transformations if t.type == "CREATED")


def test_invalid_quote_cannot_be_verified_or_returned(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    result = analyze_parsed(before, after)
    finding = result.findings[0]
    finding.verification_status = "VERIFIED"
    finding.before_evidence = [evidence(before, before.clauses[0]).model_copy(update={"text": "Forged quote"})]
    verify_evidence(result, before, after)
    assert finding.verification_status == "NEEDS_REVIEW"
    assert finding.before_evidence == []


def test_real_but_irrelevant_quote_does_not_verify_finding(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    result = analyze_parsed(before, after)
    finding = result.findings[0]
    finding.title = "Unsupported allegation"
    finding.before_evidence = [evidence(before, before.clauses[0])]
    finding.after_evidence = [evidence(after, after.clauses[0])]
    finding.verification_status = "VERIFIED"
    verify_evidence(result, before, after)
    assert finding.verification_status == "NEEDS_REVIEW"


def test_empty_or_irrelevant_provenance_cannot_verify_relations(document_pair):
    before, after = [parse_document(raw, name) for raw, name in zip(document_pair, ["before.docx", "after.docx"])]
    result = analyze_parsed(before, after)
    transformation = next(t for t in result.transformations if t.verification_status == "VERIFIED")
    transformation.evidence = []
    match = next(m for m in result.function_matches if m.verification_status == "VERIFIED")
    match.before_evidence = [evidence(before, before.clauses[0])]
    verify_evidence(result, before, after)
    assert transformation.verification_status == "NEEDS_REVIEW"
    assert match.verification_status == "NEEDS_REVIEW"
