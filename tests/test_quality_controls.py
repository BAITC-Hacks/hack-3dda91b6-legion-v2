"""Negative controls: do not confuse retained ownership, control and execution."""

import pytest

from backend.pipeline import analyze


def regulation(make_docx, clauses):
    return make_docx([
        "1.1. БК является функциональным блоком компании.",
        "3.1. БК состоит из следующих структурных подразделений:",
        "а. Департамент закупок (ДЗ).",
        "б. Департамент контроля (ДК).",
        *clauses,
    ])


def test_unchanged_owner_gets_exact_match_before_other_departments(make_docx):
    before = regulation(make_docx, [
        "5.1. Директор ДЗ:", "5.1.1. Подготавливает отчёт о закупочных рисках.",
        "5.2. Директор ДК:", "5.2.1. Подготавливает отчёт о закупочных рисках.",
    ])
    after = regulation(make_docx, [
        "5.2. Директор ДК:", "5.2.1. Подготавливает отчёт о закупочных рисках.",
    ])
    result = analyze(before, after, before_name="before.docx", after_name="after.docx")
    functions = {f.id: f for u in result.units for f in u.functions}
    by_owner = {functions[m.before_function].unit_name: m for m in result.function_matches}
    assert by_owner["Департамент контроля"].status == "PRESERVED"
    assert by_owner["Департамент контроля"].verification_status == "VERIFIED"
    assert by_owner["Департамент закупок"].status == "LOST"
    assert not any(f.type == "MOVED" for f in result.findings)


@pytest.mark.parametrize("first,second", [
    ("Проверяет исполнение договоров закупок.", "Контролирует исполнение договоров закупок."),
    ("Проверяет утверждение договоров закупок.", "Контролирует утверждение договоров закупок."),
    ("Проверяет договоры закупок.", "Не утверждает договоры закупок."),
    ("Проверяет договоры закупок.", "Контролирует договоры в рамках утвержденного бюджета."),
])
def test_control_or_negated_approval_is_not_execution(make_docx, first, second):
    raw = regulation(make_docx, ["5.1. Директор ДК:", f"5.1.1. {first}", f"5.1.2. {second}"])
    result = analyze(raw, raw, before_name="before.docx", after_name="after.docx")
    assert not any(f.type == "CONFLICT" for f in result.findings)


@pytest.mark.parametrize("execution", [
    "Утверждает договоры закупок.",
    "Исполняет договоры закупок.",
    "Исполнение договоров закупок.",
    "Осуществляет оплату договоров закупок.",
    "Утверждение договоров закупок.",
])
def test_positive_execution_and_control_still_raise_review_candidate(make_docx, execution):
    raw = regulation(make_docx, ["5.1. Директор ДК:",
                                 "5.1.1. Проверяет договоры закупок.", f"5.1.2. {execution}"])
    result = analyze(raw, raw, before_name="before.docx", after_name="after.docx")
    assert any(f.type == "CONFLICT" and f.verification_status == "NEEDS_REVIEW" for f in result.findings)


@pytest.mark.parametrize("heading", [
    "Директор ДК не имеет права:",
    "Работники ДК не имеют права:",
    "Директор ДК не вправе:",
])
def test_singular_and_plural_prohibition_contexts(make_docx, heading):
    raw = regulation(make_docx, [f"5.1. {heading}", "5.1.1. Утверждать договоры закупок.",
                                 "5.2. Директор ДК:", "5.2.1. Проверяет договоры закупок."])
    result = analyze(raw, raw, before_name="before.docx", after_name="after.docx")
    prohibited = [f for u in result.units for f in u.functions if f.section == "5.1.1"]
    assert prohibited and all(f.kind == "PROHIBITION" for f in prohibited)
    assert not any(f.type == "CONFLICT" for f in result.findings)


@pytest.mark.parametrize("clause", [
    "Не имеет права утверждать договоры закупок.",
    "Не вправе утверждать договоры закупок.",
    "Запрещается утверждать договоры закупок.",
])
def test_prohibition_inside_a_function_list(make_docx, clause):
    raw = regulation(make_docx, ["5.1. Директор ДК:", f"5.1.1. {clause}",
                                 "5.1.2. Проверяет договоры закупок."])
    result = analyze(raw, raw, before_name="before.docx", after_name="after.docx")
    prohibited = [f for u in result.units for f in u.functions if f.section == "5.1.1"]
    assert prohibited and all(f.kind == "PROHIBITION" for f in prohibited)
    assert not any(f.type == "CONFLICT" for f in result.findings)
