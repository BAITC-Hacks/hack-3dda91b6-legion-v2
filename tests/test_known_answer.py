from backend.parser import parse_document
from backend.pipeline import analyze
from scripts.smoke_known_answer import generate_pair, verify


def test_declared_synthetic_changes_without_network(tmp_path):
    before, after = generate_pair(tmp_path)
    result = analyze(before, after)
    assert verify(result, parse_document(before), parse_document(after), "deterministic") > 0
