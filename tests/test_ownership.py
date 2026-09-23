import pytest

from backend.extraction import extract_functions, extract_org_units
from backend.parser import parse_document


def extract(make_docx, clauses, heading="Директоры ДТ и ДО:"):
    raw = make_docx([
        "1.1. БК является функциональным блоком компании.",
        "3.1. БК состоит из следующих структурных подразделений:",
        "а. Департамент технологий (ДТ).",
        "б. Департамент операционного аудита (ДО).",
        ("5. Функции и обязанности", "Heading 1"),
        f"5.1. {heading}",
        "5.1.1. Выполняют следующие действия:",
        *clauses,
    ])
    document = parse_document(raw, "synthetic.docx")
    return extract_functions(document, extract_org_units(document))


def test_trailing_unit_marker_narrows_shared_responsibility(make_docx):
    functions = extract(make_docx, [
        "а. Проверяют информационные системы (ДТ);",
        "б. Проверяют операционные процессы (ДО).",
        "в. Подготавливают общий годовой отчёт.",
    ])
    owners = {}
    for function in functions:
        owners.setdefault(function.section, set()).add(function.unit_name)
        assert function.ownership_status == "VERIFIED"
        assert function.ownership_evidence
    assert owners == {
        "5.1.1.а": {"Департамент технологий"},
        "5.1.1.б": {"Департамент операционного аудита"},
        "5.1.1.в": {"Департамент технологий", "Департамент операционного аудита"},
    }


@pytest.mark.parametrize("text", [
    "а. Проверяют отчёты департамента операционного аудита (ДО).",
    "а. Согласуют отчёты с ДО и проверяют показатели.",
    "а. Проверяют отчёты (ДО) и подготавливают заключение.",
    "а. Проверяют отчёты по внешней методике (ВМ).",
])
def test_mentions_and_unknown_markers_do_not_reassign_owner(make_docx, text):
    functions = extract(make_docx, [text])
    assert {f.unit_name for f in functions} == {"Департамент технологий", "Департамент операционного аудита"}


def test_explicit_unit_marker_keeps_prohibition_and_sources(make_docx):
    functions = extract(make_docx, ["а. Утверждать закупки оборудования (ДТ)."], heading="Работники ДТ и ДО не имеют права:")
    assert len(functions) == 1
    function = functions[0]
    assert function.unit_name == "Департамент технологий"
    assert function.kind == "PROHIBITION"
    assert function.source_text == "а. Утверждать закупки оборудования (ДТ)."
    assert any("не имеют права" in e.text for e in function.ownership_evidence)
