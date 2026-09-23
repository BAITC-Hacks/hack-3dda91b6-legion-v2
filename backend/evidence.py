"""Evidence lock: exact provenance is necessary, not proof of semantic entailment."""

from .extraction import normalize
from .comparison import function_evidence
from .parser import ParsedDocument
from .schemas import AnalysisResult, Evidence


def evidence_exists(item: Evidence, documents: list[ParsedDocument]) -> bool:
    if item.section is None or not item.text.strip():
        return False
    return any(
        doc.name == item.document and any(
            clause.id == item.clause_id and clause.section == item.section and item.text in clause.text
            for clause in doc.clauses
        ) for doc in documents
    )


def verify_evidence(result: AnalysisResult, before: ParsedDocument, after: ParsedDocument) -> AnalysisResult:
    units = {u.id: u for u in result.units}
    functions = {f.id: f for u in result.units for f in u.functions}

    def valid(items, document):
        return bool(items) and all(evidence_exists(e, [document]) for e in items)

    def includes(items, required):
        return all(e in items for e in required)

    for transformation in result.transformations:
        transformation.verification_status = "NEEDS_REVIEW"
        a, b = units.get(transformation.before_unit), units.get(transformation.after_unit)
        # Absence, split, merge, rename and semantic equivalence need human validation.
        if transformation.type == "PRESERVED" and a and b and normalize(a.name) == normalize(b.name):
            if a.document == before.name and b.document == after.name and valid(a.evidence, before) and valid(b.evidence, after) and includes(transformation.evidence, a.evidence + b.evidence) and all(evidence_exists(e, [before, after]) for e in transformation.evidence):
                transformation.verification_status = "VERIFIED"
                transformation.explanation = "Название подразделения совпадает в обеих редакциях после нормализации."
    for match in result.function_matches:
        match.verification_status = "NEEDS_REVIEW"
        a, b = functions.get(match.before_function), functions.get(match.after_function)
        if not a or not b:
            continue
        if not valid(match.before_evidence, before) or not valid(match.after_evidence, after):
            continue
        if not includes(match.before_evidence, function_evidence(a)) or not includes(match.after_evidence, function_evidence(b)):
            continue
        if a.document != before.name or b.document != after.name or a.kind != b.kind:
            continue
        if a.ownership_status != "VERIFIED" or b.ownership_status != "VERIFIED":
            continue
        same_owner = normalize(a.unit_name) == normalize(b.unit_name)
        if match.status == "PRESERVED" and same_owner and a.normalized_function == b.normalized_function:
            match.verification_status = "VERIFIED"
            match.explanation = "Совпадают нормализованные тексты функций и названия владельцев; назначение подтверждено исходными пунктами."
    # Even a real quote can be irrelevant to a model's assertion. Heuristic/semantic
    # findings remain candidates for review; matching a substring never upgrades one.
    for finding in result.findings:
        finding.verification_status = "NEEDS_REVIEW"
        for field, document in (("before_evidence", before), ("after_evidence", after)):
            items = getattr(finding, field)
            if any(not evidence_exists(e, [document]) for e in items):
                # Invalid quotations are not passed through as documentary sources.
                setattr(finding, field, [e for e in items if evidence_exists(e, [document])])
                warning = "An invalid source reference was removed; the finding requires review."
                if warning not in result.warnings:
                    result.warnings.append(warning)
    result.summary.note_verification_status = "NEEDS_REVIEW"
    if result.summary.analytical_note and (not result.summary.note_evidence or not all(evidence_exists(e, [before, after]) for e in result.summary.note_evidence)):
        result.summary.analytical_note = None
        result.summary.note_evidence = []
        result.warnings.append("Rejected analytical conclusion with invalid source evidence.")
    return result
