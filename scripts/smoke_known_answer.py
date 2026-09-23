"""Generate synthetic DOCX with declared changes and verify a running HTTP API.

Semantic mode explicitly makes a paid model call through the backend. No API key
is read by this script. Documents and full responses stay in ignored artifacts/.
"""

import argparse
import json
from pathlib import Path
import time

from docx import Document
import httpx

from backend.evidence import evidence_exists
from backend.parser import parse_document
from backend.schemas import AnalysisResult


BEFORE = [
    "1.1. БК является функциональным блоком компании.",
    "3.1. БК состоит из следующих структурных подразделений:",
    "а. Департамент закупок (ДЗ).",
    "б. Департамент контроля (ДК).",
    "в. Департамент эксплуатации (ДЭ).",
    "5.1. Директор ДЗ:",
    "5.1.1. Организует закупки оборудования.",
    "5.1.2. Подготавливает отчёт о закупочных рисках.",
    "5.2. Директор ДК:",
    "5.2.1. Проверяет исполнение договоров поставщиками.",
    "5.3. Директор ДЭ:",
    "5.3.1. Контролирует план аварийного восстановления.",
]
AFTER = [
    "1.1. БК является функциональным блоком компании.",
    "1.2. Департамент закупок (ДЗ) переименован в Департамент снабжения (ДС).",
    "3.1. БК состоит из следующих структурных подразделений:",
    "а. Департамент снабжения (ДС).",
    "б. Департамент контроля (ДК).",
    "в. Департамент эксплуатации (ДЭ).",
    "г. Департамент анализа (ДА).",
    "5.1. Директор ДС:",
    "5.1.1. Организует закупки оборудования.",
    "5.1.2. Проверяет исполнение договоров поставщиками.",
    "5.1.3. Утверждает договоры закупок.",
    "5.2. Директор ДК:",
    "5.2.1. Проверяет исполнение договоров поставщиками.",
    "5.2.2. Подготавливает отчёт о закупочных рисках.",
    "5.3. Директор ДЭ:",
    "5.3.1. Осуществляет мониторинг доступности сетевых каналов.",
    "5.4. Директор ДА:",
    "5.4.1. Анализирует статистику обращений пользователей.",
]

# Ground truth is declared before generating documents or calling the model.
EXPECTED = {
    "unit_counts": [4, 5],
    "created_unit": "Департамент анализа",
    "semantic_rename": ["Департамент закупок", "Департамент снабжения"],
    "moved_function_sections": ["5.1.2", "5.2.2"],
    "lost_function_section": "5.3.1",
    "duplicate_after_sections": ["5.1.2", "5.2.1"],
    "potential_conflict_after_sections": ["5.1.2", "5.1.3"],
}


def generate_pair(folder):
    folder.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, paragraphs in (("known-before.docx", BEFORE), ("known-after.docx", AFTER)):
        doc = Document()
        for paragraph in paragraphs:
            doc.add_paragraph(paragraph)
        path = folder / name
        doc.save(path)
        paths.append(path)
    (folder / "expected.json").write_text(json.dumps(EXPECTED, ensure_ascii=False, indent=2), encoding="utf-8")
    return paths


def verify(result, before, after, mode):
    units = {u.id: u for u in result.units}
    functions = {f.id: f for u in result.units for f in u.functions}
    assert result.analysis_mode == mode
    assert [result.summary.units_before, result.summary.units_after] == EXPECTED["unit_counts"]
    assert any(t.type == "CREATED" and units[t.after_unit].name == EXPECTED["created_unit"] for t in result.transformations)
    assert any(m.status == "MOVED" and functions[m.before_function].section == EXPECTED["moved_function_sections"][0]
               and m.after_function and functions[m.after_function].section == EXPECTED["moved_function_sections"][1]
               for m in result.function_matches), "Expected transfer of the risk report was not found"
    assert any(m.status == "LOST" and functions[m.before_function].section == EXPECTED["lost_function_section"]
               for m in result.function_matches), "Expected missing recovery responsibility was not found"
    for kind, key in (("DUPLICATED", "duplicate_after_sections"), ("CONFLICT", "potential_conflict_after_sections")):
        assert any(f.type == kind and set(EXPECTED[key]) <= {e.section for e in f.after_evidence}
                   for f in result.findings), f"Expected {kind} candidate with the declared sources was not found"
    if mode == "semantic":
        assert any(t.type == "RENAMED" and [units[t.before_unit].name, units[t.after_unit].name] == EXPECTED["semantic_rename"]
                   for t in result.transformations), "Explicitly documented rename was not found"
        assert result.summary.analytical_note and result.summary.analytical_note.strip()
        assert {e.document for e in result.summary.note_evidence} == {before.name, after.name}
        assert result.summary.note_verification_status == "NEEDS_REVIEW"
    sources = [e for u in result.units for e in u.evidence]
    sources += [e for u in result.units for f in u.functions for e in f.ownership_evidence]
    sources += [e for t in result.transformations for e in t.evidence]
    sources += [e for m in result.function_matches for e in m.before_evidence + m.after_evidence]
    sources += [e for f in result.findings for e in f.before_evidence + f.after_evidence]
    sources += result.summary.note_evidence
    assert sources and all(evidence_exists(e, [before, after]) for e in sources)
    assert all(f.verification_status == "NEEDS_REVIEW" for f in result.findings)
    assert all(x.explanation.strip() for x in result.transformations + result.function_matches + result.findings)
    return len(sources)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--mode", choices=["deterministic", "semantic"], default="deterministic")
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/known-answer"))
    args = parser.parse_args()
    paths = generate_pair(args.output_dir)
    with httpx.Client(base_url=args.base_url, timeout=150, trust_env=False) as client:
        assert client.get("/api/health").json() == {"ok": True}
        started = time.monotonic()
        with paths[0].open("rb") as a, paths[1].open("rb") as b:
            response = client.post(f"/api/analyze?mode={args.mode}", files={
                "before_file": (paths[0].name, a), "after_file": (paths[1].name, b)})
        if response.is_error:
            code = response.json().get("error", {}).get("code", "unknown")
            raise RuntimeError(f"Analyze failed: HTTP {response.status_code}, code={code}")
        result = AnalysisResult.model_validate(response.json())
    elapsed = time.monotonic() - started
    output = args.output_dir / f"{args.mode}-response.json"
    output.write_text(result.model_dump_json(indent=2), encoding="utf-8")
    count = verify(result, *(parse_document(p) for p in paths), args.mode)
    print(f"PASS known-answer HTTP upload: mode={args.mode}; seconds={elapsed:.1f}; sources={count}")
    print("PASS created unit, moved function, missing function, duplicate and potential conflict")
    if args.mode == "semantic":
        print("PASS documented rename, model conclusion with sources from both documents")
    print(f"Response: {output}")


if __name__ == "__main__":
    main()
