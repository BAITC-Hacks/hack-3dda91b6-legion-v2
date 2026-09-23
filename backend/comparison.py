from difflib import SequenceMatcher
from itertools import combinations
import re

from .extraction import normalize, stable_id
from .schemas import Evidence, Finding, FunctionItem, FunctionMatch, OrganizationalUnit, Transformation


CONTROL_ACTION = re.compile(r"\b(?:аудит\w*|провер\w*|контрол\w*)\b")
EXECUTION_ACTION = re.compile(
    r"\b(?:исполня(?:ет|ют|ть)|утвержда(?:ет|ют|ть)|провод(?:ит|ят)\s+оплат\w*|осуществля(?:ет|ют)\s+оплат\w*)\b"
    r"|^(?:исполнение|утверждение|проведение\s+оплат\w*|осуществление\s+оплат\w*)\b"
)


def positive_action(text, pattern):
    # Do not turn "checks execution" or "within an approved budget" into the
    # execution of the contract, or an explicitly negated action into a duty.
    return any(not re.search(r"\bне\s+$", text[:match.start()]) for match in pattern.finditer(text))


def function_evidence(function: FunctionItem) -> list[Evidence]:
    return [Evidence(document=function.document, section=function.section,
                     text=function.source_text, clause_id=function.clause_id), *function.ownership_evidence]


def match_units(before: list[OrganizationalUnit], after: list[OrganizationalUnit]) -> list[Transformation]:
    remaining = {normalize(u.name): u for u in after}
    result = []
    for unit in before:
        other = remaining.pop(normalize(unit.name), None)
        result.append(Transformation(
            before_unit=unit.id, after_unit=other.id if other else None,
            type="PRESERVED" if other else "REMOVED", confidence=1.0 if other else 0.5,
            evidence=unit.evidence + (other.evidence if other else []),
            explanation="Название присутствует в обеих редакциях." if other else "В извлечённом перечне AFTER нет подразделения с этим названием; требуется проверить переименование или реорганизацию.",
        ))
    for unit in remaining.values():
        result.append(Transformation(
            before_unit=None, after_unit=unit.id, type="CREATED", confidence=0.5,
            evidence=unit.evidence,
            explanation="Название найдено только в перечне AFTER; создание, переименование или выделение требует проверки.",
        ))
    return result


def similarity(left: str, right: str) -> float:
    # Sequence similarity proposes candidates; it never proves semantic equivalence.
    if left == right:
        return 1.0
    a, b = set(left.split()), set(right.split())
    jaccard = len(a & b) / max(1, len(a | b))
    # Even a perfect sequence score cannot reach the 0.68 candidate threshold.
    if (1 + jaccard) / 2 < 0.68:
        return jaccard
    return (SequenceMatcher(None, left, right, autojunk=False).ratio() + jaccard) / 2


def compare_functions(before: list[FunctionItem], after: list[FunctionItem]) -> list[FunctionMatch]:
    remaining = {f.id: f for f in after}
    matches = []
    # Reserve unchanged ownership globally before assigning exact text to another
    # department; otherwise an earlier unit can steal a later unit's retained duty.
    exact_owners = {(f.normalized_function, f.kind, normalize(f.unit_name)) for f in after}
    exact_texts = {(f.normalized_function, f.kind) for f in after}
    ordered = sorted(before, key=lambda f: (
        (f.normalized_function, f.kind, normalize(f.unit_name)) not in exact_owners,
        (f.normalized_function, f.kind) not in exact_texts,
    ))
    for function in ordered:
        candidates = [f for f in remaining.values() if f.kind == function.kind]
        ranked = sorted(candidates, key=lambda f: (
            f.normalized_function == function.normalized_function,
            similarity(function.normalized_function, f.normalized_function),
            normalize(f.unit_name) == normalize(function.unit_name), f.id), reverse=True)
        other = ranked[0] if ranked else None
        score = similarity(function.normalized_function, other.normalized_function) if other else 0
        if other is None or score < 0.68:
            other = None
            status = "LOST"
            explanation = "Не найден надёжный текстовый кандидат AFTER. Это потенциальная потеря, а не доказанное исключение функции."
            if (function.normalized_function, function.kind) in exact_texts:
                explanation = "Тот же текст обязанности присутствует в AFTER, но отдельное соответствие данному прежнему назначению не найдено. Возможна консолидация ответственности; потеря функции не доказана. Требуется проверка."
        else:
            remaining.pop(other.id)
            moved = normalize(function.unit_name) != normalize(other.unit_name)
            same = function.normalized_function == other.normalized_function
            status = "MOVED" if moved else "PRESERVED" if same else "CHANGED"
            explanation = "Найден совпадающий текст." if same else "Найден текстовый кандидат; смысловое соответствие требует проверки."
            if moved:
                explanation += " Кандидат отнесён к другому подразделению."
        matches.append(FunctionMatch(
            before_function=function.id, after_function=other.id if other else None,
            status=status, confidence=round(score if other else 0.35, 4),
            before_evidence=function_evidence(function), after_evidence=function_evidence(other) if other else [],
            explanation=explanation,
        ))
    return matches


def detect_findings(matches, before: list[FunctionItem], after: list[FunctionItem]) -> list[Finding]:
    findings = []
    for match in matches:
        if match.status not in ("LOST", "MOVED"):
            continue
        findings.append(Finding(
            id=stable_id(match.status, match.before_function, match.after_function or ""),
            type=match.status, severity="HIGH" if match.status == "LOST" else "MEDIUM",
            title="Потенциальная потеря функции" if match.status == "LOST" else "Возможный перенос функции",
            explanation=match.explanation, confidence=match.confidence,
            before_evidence=match.before_evidence, after_evidence=match.after_evidence,
            recommendation="Проверить назначение ответственного и связанные положения подразделений.",
        ))
    matched_after = {m.after_function for m in matches if m.after_function}
    for function in after:
        if function.id not in matched_after and function.kind == "FUNCTION":
            findings.append(Finding(
                id=stable_id("CREATED", function.id), type="CREATED", severity="INFO",
                title="Функция без найденного соответствия BEFORE",
                explanation="В AFTER извлечена функция, для которой не найдено соответствие BEFORE. Новизна требует проверки.",
                confidence=0.4, after_evidence=function_evidence(function),
                recommendation="Проверить, является ли функция новой или переформулированной.",
            ))
    for left, right in combinations(after, 2):
        if left.kind != "FUNCTION" or right.kind != "FUNCTION":
            continue
        if left.clause_id == right.clause_id:
            # One clause with collective scope is not evidence of duplicate assignment.
            continue
        score = similarity(left.normalized_function, right.normalized_function)
        if left.unit_name != right.unit_name and score >= 0.78:
            identical = left.normalized_function == right.normalized_function
            kind = "DUPLICATED" if identical else "OVERLAP"
            findings.append(Finding(
                id=stable_id(kind, left.id, right.id), type=kind, severity="MEDIUM",
                title="Возможное дублирование ответственности" if identical else "Возможное пересечение ответственности",
                explanation=f"У подразделений «{left.unit_name}» и «{right.unit_name}» найдены близкие формулировки. Границы полномочий требуют проверки.",
                confidence=round(score, 4), after_evidence=function_evidence(left) + function_evidence(right),
                recommendation="Уточнить объекты работы и разграничить ответственность.",
            ))
        if left.unit_name == right.unit_name:
            objects = ("закуп", "платеж", "договор", "транзак")
            shared_object = any(stem in left.normalized_function and stem in right.normalized_function for stem in objects)
            conflict = ((positive_action(left.normalized_function, CONTROL_ACTION) and positive_action(right.normalized_function, EXECUTION_ACTION))
                        or (positive_action(left.normalized_function, EXECUTION_ACTION) and positive_action(right.normalized_function, CONTROL_ACTION)))
            if shared_object and conflict:
                findings.append(Finding(
                    id=stable_id("CONFLICT", left.id, right.id), type="CONFLICT", severity="HIGH",
                    title="Возможное совмещение исполнения и контроля",
                    explanation=f"В функциях «{left.unit_name}» найдены формулировки об исполнении и контроле общего объекта; это сигнал для проверки независимости.",
                    confidence=0.4, after_evidence=function_evidence(left) + function_evidence(right),
                    recommendation="Проверить разделение полномочий, объекты контроля и ограничения независимости.",
                ))
    return findings
