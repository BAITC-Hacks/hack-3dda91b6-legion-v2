from pathlib import Path

from backend.pipeline import analyze
from backend.schemas import AnalysisResult


def test_analysis_schema_and_live_differences(document_pair):
    result = analyze(*document_pair, before_name="before.docx", after_name="after.docx")
    assert AnalysisResult.model_validate_json(result.model_dump_json()) == result
    assert result.summary.units_before == 3
    assert result.summary.units_after == 4
    assert result.summary.created_units == 1
    assert result.summary.moved_functions == 1
    assert result.summary.duplications == 1
    assert result.analysis_mode == "deterministic"
    assert all(f.verification_status == "NEEDS_REVIEW" for f in result.findings)
    assert result.agent_trace[-1] == "Generating analytical conclusion"


def test_equal_names_are_disambiguated(document_pair):
    result = analyze(*document_pair, before_name="same.docx", after_name="same.docx")
    assert result.before_document != result.after_document
    assert result.summary.units_before == 3
    assert result.summary.units_after == 4


def test_identical_documents_have_no_changes(document_pair):
    raw = document_pair[0]
    result = analyze(raw, raw, before_name="same.docx", after_name="same.docx")
    assert all(t.type == "PRESERVED" for t in result.transformations)
    assert all(m.status == "PRESERVED" for m in result.function_matches)
    assert not any(f.type in ("MOVED", "LOST", "CREATED") for f in result.findings)


def test_changed_input_changes_output(document_pair):
    result = analyze(*document_pair, before_name="before.docx", after_name="after.docx")
    equal = analyze(document_pair[0], document_pair[0], before_name="before.docx", after_name="after.docx")
    assert result.analysis_id != equal.analysis_id
    assert result.summary.created_units != equal.summary.created_units


def test_shared_clause_is_not_duplicate(make_docx):
    raw = make_docx(["1.1. БК является функциональным блоком компании.",
                     "3.1. БК состоит из следующих структурных подразделений:",
                     "а. Департамент контроля (ДК).", "б. Департамент проверки (ДП).",
                     ("5. Обязанности", "Heading 1"),
                     "5.1. Директор ДК и Директор ДП:", "5.1.1. Проверяет закупки оборудования."])
    result = analyze(raw, raw, before_name="before.docx", after_name="after.docx")
    assert len([f for u in result.units if u.document == "after.docx" for f in u.functions]) == 2
    assert not any(f.type == "DUPLICATED" for f in result.findings)


def test_prohibition_is_not_positive_function(make_docx):
    raw = make_docx(["1.1. БК является функциональным блоком компании.",
                     "3.1. БК состоит из следующих структурных подразделений:",
                     "а. Департамент контроля (ДК).", ("5. Обязанности", "Heading 1"),
                     "5.1. Работники ДК не имеют права:", "5.1.1. Утверждать договоры закупок.",
                     "5.2. Директор ДК:", "5.2.1. Проверяет договоры закупок."])
    result = analyze(raw, raw, before_name="before.docx", after_name="after.docx")
    functions = [f for u in result.units for f in u.functions]
    assert any(f.kind == "PROHIBITION" for f in functions)
    assert not any(f.type == "CONFLICT" for f in result.findings)


def test_nested_prohibition_inherits_scope(make_docx):
    raw = make_docx(["1.1. БК является функциональным блоком компании.",
                     "3.1. БК состоит из следующих структурных подразделений:",
                     "а. Департамент контроля (ДК).", ("5. Обязанности", "Heading 1"),
                     "5.1. Работники ДК не имеют права:",
                     "5.1.1. Выполнять следующие действия, в том числе:",
                     "а. Утверждать договоры закупок."])
    result = analyze(raw, raw, before_name="before.docx", after_name="after.docx")
    functions = [f for u in result.units for f in u.functions]
    assert functions
    assert all(f.kind == "PROHIBITION" and f.unit_name == "Департамент контроля" for f in functions)
    assert all(any("не имеют права" in e.text for e in f.ownership_evidence) for f in functions)


def test_real_demo_golden_path():
    data = Path(__file__).resolve().parents[1] / "data"
    before, after = list(data.glob("*_8_*.docx")), list(data.glob("*_9_*.docx"))
    if not before or not after:
        import pytest
        pytest.skip("Private local documents not installed.")
    result = analyze(before[0], after[0])
    # Dataset assertions only: the extraction algorithm contains no known answer.
    assert result.summary.units_before == 3
    assert result.summary.units_after == 5
    assert result.summary.created_units == 2
    assert all(u.functions for u in result.units)
    # The collective heading is narrowed by explicit trailing department markers.
    for section, alias in (("5.3.2.а", "ДИТААД"), ("5.3.2.б", "ДОА")):
        owners = [u for u in result.units if u.document == after[0].name
                  and any(f.section == section for f in u.functions)]
        assert len(owners) == 1
        assert alias in owners[0].aliases
    assert AnalysisResult.model_validate_json(result.model_dump_json()) == result
