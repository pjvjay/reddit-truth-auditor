"""The Python reference must reproduce spec/canonical-vectors.json (the userscript is tested against the same file)."""
import json
from pathlib import Path

from rta_server.claimsig import canonicalize, hash_ref, tokenize
from rta_server.outlets import lookup_domain, lookup_name, registrable

V = json.loads((Path(__file__).resolve().parents[2] / "spec" / "canonical-vectors.json").read_text(encoding="utf-8"))


def test_canonicalize():
    for v in V["canonicalize"]:
        r = canonicalize(v["input"])
        got = None if r is None else {"key": r.key, "stance": r.stance, "canonical": r.canonical, "tokens": r.tokens}
        assert got == v["expected"], v["input"]


def test_tokenize_and_hash():
    for v in V["tokenize"]:
        assert tokenize(v["input"]) == v["expected"]
    for v in V["hash_ref"]:
        assert hash_ref(v["input"]) == v["expected"]


def test_outlets():
    for v in V["registrable"]:
        assert registrable(v["input"]) == v["expected"]
    for v in V["lookup_domain"]:
        assert lookup_domain(v["input"]) == v["expected"]
    for v in V["lookup_name"]:
        assert lookup_name(v["input"]) == v["expected"]
