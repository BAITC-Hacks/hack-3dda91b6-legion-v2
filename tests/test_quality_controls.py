"""Negative controls: do not confuse retained ownership, control and execution."""

from itertools import permutations

import pytest

from backend.comparison import compare_functions
from backend.pipeline import analyze
from backend.schemas import FunctionItem


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


def test_repeated_duty_does_not_consume_another_owners_retained_assignment(make_docx):
    before = regulation(make_docx, [
        "5.1. Директор ДЗ:", "5.1.1. Подготавливает отчёт о закупочных рисках.",
        "5.1.2. Подготавливает отчёт о закупочных рисках.",
        "5.2. Директор ДК:", "5.2.1. Подготавливает отчёт о закупочных рисках.",
    ])
    after = regulation(make_docx, [
        "5.1. Директор ДЗ:", "5.1.1. Подготавливает отчёт о закупочных рисках.",
        "5.2. Директор ДК:", "5.2.1. Подготавливает отчёт о закупочных рисках.",
    ])
    result = analyze(before, after, before_name="before.docx", after_name="after.docx")
    functions = {f.id: f for u in result.units for f in u.functions}
    control = next(m for m in result.function_matches if functions[m.before_function].section == "5.2.1")
    assert control.status == "PRESERVED"
    assert control.verification_status == "VERIFIED"
    assert functions[control.after_function].unit_name == "Департамент контроля"
    assert result.summary.moved_functions == 0
    assert result.summary.lost_functions == 1


def matching_item(identifier, owner, text):
    return FunctionItem(id=identifier, unit_name=owner, normalized_function=text,
                        source_text=text, section=identifier, document=identifier.split("-")[0],
                        clause_id=identifier)


@pytest.mark.parametrize("after_second_owner,second_text,expected_status", [
    ("B", "подготавливает ежеквартальный отчёт о закупочных рисках компании", "PRESERVED"),
    ("B", "подготавливает ежеквартальный отчёт о финансовых рисках компании", "PRESERVED"),
    ("C", "подготавливает ежеквартальный отчёт о финансовых рисках компании", "MOVED"),
], ids=["identical-other-owner", "similar-other-owner", "similar-transferred-duty"])
def test_duplicate_multiplicity_preserves_exact_matches_in_any_order(after_second_owner, second_text, expected_status):
    first_text = "подготавливает ежеквартальный отчёт о закупочных рисках компании"
    before = [matching_item("before-1", "A", first_text),
              matching_item("before-2", "A", first_text),
              matching_item("before-3", "B", second_text)]
    after = [matching_item("after-1", "A", first_text),
             matching_item("after-2", after_second_owner, second_text)]
    for before_order in permutations(before):
        for after_order in permutations(after):
            matches = compare_functions(list(before_order), list(after_order))
            by_id = {m.before_function: m for m in matches}
            assert by_id["before-3"].after_function == "after-2"
            assert by_id["before-3"].status == expected_status
            first_owner = [by_id["before-1"], by_id["before-2"]]
            assert sorted(m.status for m in first_owner) == ["LOST", "PRESERVED"]
            assigned = [m.after_function for m in matches if m.after_function]
            assert len(assigned) == len(set(assigned)) == 2


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


@pytest.mark.parametrize("prefix", ["Имеет право", "Вправе", "Имеют право"], ids=["singular", "entitled", "plural"])
def test_permission_inside_a_list_is_not_an_executed_duty(make_docx, prefix):
    raw = regulation(make_docx, ["5.1. Директор ДК:", f"5.1.1. {prefix} утверждать договоры закупок.",
                                 "5.1.2. Проверяет договоры закупок."])
    result = analyze(raw, raw, before_name="before.docx", after_name="after.docx")
    items = [f for u in result.units for f in u.functions]
    assert len(items) == 4
    assert all(f.kind == "RIGHT" for f in items if f.section == "5.1.1")
    assert all(f.kind == "FUNCTION" for f in items if f.section == "5.1.2")
    assert not any(f.type == "CONFLICT" for f in result.findings)
