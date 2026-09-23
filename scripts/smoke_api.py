"""Run a temporary local HTTP server and upload both private control documents."""

import argparse
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
from dotenv import load_dotenv

from backend.evidence import evidence_exists
from backend.parser import parse_document
from backend.pipeline import analyze_parsed
from backend.schemas import AnalysisResult


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/api-comparison.json"))
    parser.add_argument("--mode", choices=["deterministic", "semantic"], default="deterministic")
    parser.add_argument("--env-file", type=Path, help="Explicit local environment file; semantic mode makes a paid API call.")
    args = parser.parse_args()
    if args.env_file:
        if not args.env_file.is_file():
            parser.error("The requested environment file does not exist.")
        load_dotenv(args.env_file, encoding="utf-8-sig", override=False)
    root = Path(__file__).resolve().parents[1]
    before_paths = list((root / "data").glob("*_8_*.docx"))
    after_paths = list((root / "data").glob("*_9_*.docx"))
    if len(before_paths) != 1 or len(after_paths) != 1:
        parser.error("Place exactly one revision 8 and one revision 9 DOCX in local data/.")
    before, after = before_paths[0], after_paths[0]
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=150.0, trust_env=False) as client:
            ready = False
            for _ in range(50):
                if server.poll() is not None:
                    raise RuntimeError("Temporary HTTP server exited before becoming ready.")
                try:
                    health = client.get("/api/health")
                    if health.status_code == 200 and health.json() == {"ok": True}:
                        ready = True
                        break
                except httpx.ConnectError:
                    pass
                time.sleep(0.2)
            if not ready:
                raise RuntimeError("Temporary HTTP server did not become ready.")
            with before.open("rb") as a, after.open("rb") as b:
                started = time.monotonic()
                response = client.post(f"/api/analyze?mode={args.mode}", files={
                    "before_file": (before.name, a), "after_file": (after.name, b)})
            elapsed = time.monotonic() - started
            if response.is_error:
                # Only the backend's sanitized error code, never a provider body.
                code = response.json().get("error", {}).get("code", "unknown")
                raise RuntimeError(f"Analyze failed: HTTP {response.status_code}, code={code}")
            response.raise_for_status()
            result = AnalysisResult.model_validate(response.json())
            sources = [parse_document(before), parse_document(after)]
            baseline = analyze_parsed(*sources)
            # The model may relate existing entities, but cannot create or rewrite them.
            assert result.units == baseline.units
            assert result.analysis_mode == args.mode
            quotes = [e for unit in result.units for e in unit.evidence]
            quotes += [e for unit in result.units for f in unit.functions for e in f.ownership_evidence]
            quotes += [e for t in result.transformations for e in t.evidence]
            quotes += [e for m in result.function_matches for e in m.before_evidence + m.after_evidence]
            quotes += [e for f in result.findings for e in f.before_evidence + f.after_evidence]
            quotes += result.summary.note_evidence
            assert quotes and all(evidence_exists(e, sources) for e in quotes)
            assert all(f.verification_status == "NEEDS_REVIEW" for f in result.findings)
            if args.mode == "semantic":
                assert result.summary.analytical_note and result.summary.note_evidence
                assert result.summary.note_verification_status == "NEEDS_REVIEW"
            assert result.summary.units_before == 3 and result.summary.units_after == 5
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(result.model_dump_json(indent=2), encoding="utf-8")
            demo = client.get("/api/demo")
            demo.raise_for_status()
            assert AnalysisResult.model_validate(demo.json()) == baseline
            print(f"HTTP health=200, analyze=200, demo=200; mode={args.mode}; seconds={elapsed:.1f}; validated evidence={len(quotes)}")
            print(f"Findings={len(result.findings)}; warnings={len(result.warnings)}; model conclusion={bool(result.summary.analytical_note)}")
            print(f"BEFORE clauses={result.clauses_before}, AFTER clauses={result.clauses_after}; JSON={args.output}")
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)


if __name__ == "__main__":
    main()
