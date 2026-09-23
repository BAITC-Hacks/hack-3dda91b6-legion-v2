import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv

from .parser import DocumentError, parse_document
from .pipeline import analyze_parsed
from .semantic import SemanticError


def main():
    parser = argparse.ArgumentParser(description="Compare BEFORE and AFTER DOCX regulations.")
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--mode", choices=["deterministic", "semantic"], default="deterministic")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, help="Explicit local environment file; existing environment takes precedence.")
    args = parser.parse_args()
    try:
        if args.env_file:
            if not args.env_file.is_file():
                parser.error("The requested environment file does not exist.")
            load_dotenv(args.env_file, encoding="utf-8-sig", override=False)
        before, after = parse_document(args.before), parse_document(args.after)
        result = analyze_parsed(before, after, args.mode)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result.model_dump_json(indent=2), encoding="utf-8")
        for label, doc in (("BEFORE", before), ("AFTER", after)):
            units = [u for u in result.units if u.document == doc.name]
            print(f"{label} parsed: OK; clauses={len(doc.clauses)}; units={len(units)}; functions={sum(len(u.functions) for u in units)}")
        print(f"JSON comparison: {args.output}; findings={len(result.findings)}; mode={result.analysis_mode}")
        return 0
    except (DocumentError, SemanticError, OSError) as exc:
        print(f"Analysis failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
