"""Minimal paid OpenAI request with synthetic data; never part of normal tests."""

import argparse
import os
from pathlib import Path
import time
from typing import Literal

from dotenv import load_dotenv
from openai import APIError, APIStatusError, OpenAI
from pydantic import ValidationError

from backend.schemas import Schema
from backend.semantic import SemanticError, validate_configuration


class Probe(Schema):
    relation: Literal["PRESERVED", "CHANGED"]
    before_clause: str
    after_clause: str


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    if args.env_file:
        if not args.env_file.is_file():
            parser.error("The requested environment file does not exist.")
        load_dotenv(args.env_file, encoding="utf-8-sig", override=False)
    model = os.getenv("OPENAI_MODEL")
    try:
        validate_configuration(model)
        options = {"reasoning": {"effort": "low"}} if model.startswith("gpt-6-astra") else {}
        started = time.monotonic()
        with OpenAI(timeout=45.0, max_retries=0) as client:
            response = client.responses.parse(
                model=model, text_format=Probe, store=False, max_output_tokens=1024,
                input="Compare responsibilities. BEFORE clause b1: Reviews supplier invoices. AFTER clause a1: Reviews supplier invoices. Return the relation and the given clause IDs.",
                **options,
            )
        value = response.output_parsed
        if response.status != "completed" or not isinstance(value, Probe) or value != Probe(relation="PRESERVED", before_clause="b1", after_clause="a1"):
            print("LIVE ASTRA CALL: FAIL; invalid structured comparison")
            return 1
        print(f"LIVE ASTRA CALL: PASS; structured comparison verified; seconds={time.monotonic() - started:.1f}")
        if response.usage:
            print(f"Tokens: input={response.usage.input_tokens}, output={response.usage.output_tokens}")
        return 0
    except SemanticError as exc:
        print(f"LIVE ASTRA CALL: FAIL; {exc.code}: {exc}")
    except APIStatusError as exc:
        print(f"LIVE ASTRA CALL: FAIL; provider HTTP {exc.status_code}")
    except (APIError, ValidationError, ValueError) as exc:
        print(f"LIVE ASTRA CALL: FAIL; {type(exc).__name__}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
