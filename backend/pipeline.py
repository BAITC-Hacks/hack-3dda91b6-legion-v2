from hashlib import sha256

from .comparison import compare_functions, detect_findings, match_units
from .evidence import verify_evidence
from .extraction import extract_functions, extract_org_units
from .parser import ParsedDocument, parse_document
from .schemas import AnalysisResult, Summary


def generate_summary(result: AnalysisResult) -> Summary:
    summary = Summary(
        units_before=sum(u.document == result.before_document for u in result.units),
        units_after=sum(u.document == result.after_document for u in result.units),
        created_units=len({t.after_unit for t in result.transformations if t.type == "CREATED"}),
        removed_units=len({t.before_unit for t in result.transformations if t.type == "REMOVED"}),
        moved_functions=len({m.before_function for m in result.function_matches if m.status == "MOVED"}),
        lost_functions=len({m.before_function for m in result.function_matches if m.status == "LOST"}),
        duplications=sum(f.type == "DUPLICATED" for f in result.findings),
        overlaps=sum(f.type == "OVERLAP" for f in result.findings),
        potential_conflicts=sum(f.type == "CONFLICT" for f in result.findings),
        verified_findings=sum(f.verification_status == "VERIFIED" for f in result.findings),
        needs_review_findings=sum(f.verification_status == "NEEDS_REVIEW" for f in result.findings),
        analytical_note=result.summary.analytical_note,
        note_evidence=result.summary.note_evidence,
    )
    summary.conclusion = (
        f"В предоставленных документах извлечено подразделений: до — {summary.units_before}, после — {summary.units_after}. "
        f"Кандидаты на появление/исчезновение подразделений: {summary.created_units}/{summary.removed_units}; "
        f"на перенос/потерю функций: {summary.moved_functions}/{summary.lost_functions}. "
        f"Сигналы дублирования: {summary.duplications}, пересечения: {summary.overlaps}, конфликта интересов: {summary.potential_conflicts}. "
        f"Требуют проверки {summary.needs_review_findings} выводов. "
        "Отсутствие текстового соответствия не доказывает утрату функции. Числа отражают кандидатов в пределах извлечённого текста."
    )
    return summary


def analyze_parsed(before: ParsedDocument, after: ParsedDocument, mode="deterministic", semantic_analyzer=None) -> AnalysisResult:
    if mode not in ("deterministic", "semantic"):
        raise ValueError("Unsupported analysis mode.")
    if before.name == after.name:
        # Evidence document names must distinguish the two sides, even for equal uploads.
        before.name = "BEFORE_" + before.name
        after.name = "AFTER_" + after.name
    trace = ["Parsing BEFORE document", "Parsing AFTER document", "Extracting organizational units"]
    before_units, after_units = extract_org_units(before), extract_org_units(after)
    trace.append("Extracting functions")
    before_functions = extract_functions(before, before_units)
    after_functions = extract_functions(after, after_units)
    trace.append("Matching organizational units")
    transformations = match_units(before_units, after_units)
    trace.append("Comparing functions")
    matches = compare_functions(before_functions, after_functions)
    trace += ["Checking for lost functions", "Checking for duplicate responsibilities", "Checking for overlapping responsibilities and conflicts"]
    findings = detect_findings(matches, before_functions, after_functions)
    warnings = before.warnings + after.warnings + [
        "Rule-based extraction covers explicit unit lists and responsibility contexts; it may miss implicit assignments.",
        "NEEDS_REVIEW denotes an unconfirmed candidate. Exact source quotes alone do not prove a semantic claim.",
    ]
    if not before_units or not after_units:
        warnings.append("No organizational units were extracted on at least one side; comparison coverage is incomplete.")
    result = AnalysisResult(
        analysis_id=sha256(f"v4:{mode}:{before.name}:{before.sha256}:{after.name}:{after.sha256}".encode()).hexdigest()[:24],
        before_document=before.name, after_document=after.name, units=before_units + after_units,
        transformations=transformations, function_matches=matches, findings=findings,
        summary=Summary(), analysis_mode=mode, agent_trace=trace, warnings=warnings,
        clauses_before=len(before.clauses), clauses_after=len(after.clauses),
    )
    if mode == "semantic":
        from .semantic import OpenAISemanticAnalyzer
        analyzer = semantic_analyzer or OpenAISemanticAnalyzer()
        result.agent_trace.append("Reviewing semantic relations with OpenAI")
        result = analyzer.refine(result, before, after)
    else:
        result.warnings.append("Deterministic mode: lexical candidates only; semantic analysis was not run.")
    result.agent_trace.append("Verifying documentary evidence")
    verify_evidence(result, before, after)
    result.agent_trace.append("Generating analytical conclusion")
    result.summary = generate_summary(result)
    return result


def analyze(before_source, after_source, *, before_name=None, after_name=None, mode="deterministic", semantic_analyzer=None):
    before = parse_document(before_source, before_name)
    after = parse_document(after_source, after_name)
    return analyze_parsed(before, after, mode, semantic_analyzer)
