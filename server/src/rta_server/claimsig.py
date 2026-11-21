"""
Canonical claim signatures ("rta.claim/1").

A claim is described by a small structure the extraction model fills in:

    {"subject": "World Health Organization", "predicate": "states",
     "object": "5G towers spread the coronavirus", "polarity": "affirms",
     "quantities": [{"value": 380000, "unit": "people"}], "time": "2026", "place": "Canada",
     "topic": "health"}

`canonicalize()` turns it into a deterministic *proposition key*. Polarity is not part
of the key, so a post spreading a claim and a post debunking the very same claim share
a key and differ only in `stance`.

THIS MODULE IS MIRRORED IN userscript/reddit-truth-auditor.user.js (tokenize /
canonicalize). Any change here must be made there too - the parity test in
userscript/tests checks that both produce identical keys.
"""
from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from dataclasses import dataclass, field

SCHEMA = "rta.claim/1"
KEY_PREFIX = "p1_"

STOP = set((
    "a an the and or but if of to in on at by for from with about as into onto over under after before than then so such "
    "that this these those there here it its is are was were be been being am do does did doing have has had having will would shall should "
    "can could may might must i me my mine we us our you your he him his she her they them their what which who whom whose when where why how "
    "all any each both few more most other some just very really also only own same too up down out off again once via amp says said "
    "according report reports reported breaking update lol omg guys anyone"
).split(" "))
NEG = {"not", "no", "never", "none", "nor", "without", "cannot", "nobody", "nothing", "neither"}
TOPICS = {"health", "politics", "science", "economy", "immigration", "technology", "environment",
          "crime", "conflict", "elections", "celebrity", "other"}

_A = re.ASCII
_THOUSANDS = re.compile(r"(\d)[,\u00a0](?=\d{3}\b)", _A)
_NT = re.compile(r"n['\u2019]t\b", _A)
_CONTR = re.compile(r"['\u2019](s|re|ve|ll|d|m)\b", _A)
_SPLIT = re.compile(r"[^a-z0-9.%]+", _A)
_DOTS = re.compile(r"^\.+|\.+$", _A)
_DIGIT = re.compile(r"\d", _A)
_NUMBER = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$", re.ASCII | re.IGNORECASE)


def _is_num(w: str) -> bool:
    return bool(_DIGIT.search(w))


def _stem(w: str) -> str:
    if len(w) > 4:
        w = re.sub(r"ies$", "y", w)
        w = re.sub(r"(ing|ed)$", "", w)
    return re.sub(r"([^s])s$", r"\1", w)


def tokenize(text, cap: int = 48) -> list[str]:
    """Ordered, de-duplicated normalised tokens (identical to the userscript's tokenize())."""
    s = unicodedata.normalize("NFKD", str(text or "").lower())
    s = "".join(ch for ch in s if not ("\u0300" <= ch <= "\u036f"))
    s = _THOUSANDS.sub(r"\1", s)
    s = _NT.sub(" not", s)
    s = _CONTR.sub("", s)
    out: list[str] = []
    seen = set()
    for w in _SPLIT.split(s):
        w = _DOTS.sub("", w)
        if not w or w in STOP:
            continue
        if not _is_num(w):
            if len(w) < 2:
                continue
            w = _stem(w)
        if w not in seen:
            seen.add(w)
            out.append(w)
            if len(out) >= cap:
                break
    return out


def fmt_number(v) -> str | None:
    """Deterministic number formatting shared with the JS client."""
    if isinstance(v, bool):
        return None
    if isinstance(v, str):
        t = v.strip().replace(",", "").replace("\u00a0", "")
        if t.endswith("%"):
            t = t[:-1]
        if not _NUMBER.match(t):
            return None
        v = float(t)
    if not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    r = math.floor(v * 1e6 + 0.5) / 1e6
    s = f"{r:.6f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


@dataclass
class Canon:
    key: str
    stance: str                      # "affirms" | "denies" (after folding negations into polarity)
    canonical: str                   # the normalised string that was hashed
    tokens: list[str] = field(default_factory=list)
    sentence: str = ""               # human-readable form of the proposition (no polarity)


def canonicalize(c: dict) -> Canon | None:
    """Return the proposition key + stance for a canonical claim dict, or None if unusable."""
    if not isinstance(c, dict):
        return None
    neg = 0
    nums: set[str] = set()

    def fld(x) -> list[str]:
        nonlocal neg
        kept = []
        for t in tokenize(x, 32):
            if t in NEG:
                neg += 1
            elif _is_num(t):
                n = fmt_number(t.rstrip("%"))
                nums.add(n if n is not None else t)
            else:
                kept.append(t)
        return sorted(set(kept))

    s, p, o = fld(c.get("subject")), fld(c.get("predicate")), fld(c.get("object"))
    if not (s or o):
        return None
    for q in (c.get("quantities") or [])[:8]:
        v = q.get("value") if isinstance(q, dict) else q
        n = fmt_number(v)
        if n is not None:
            nums.add(n)
    ctx = sorted(set(fld(c.get("time")) + fld(c.get("place"))))
    polarity = "denies" if str(c.get("polarity", "")).lower().startswith("den") else "affirms"
    if neg % 2:
        polarity = "affirms" if polarity == "denies" else "denies"
    canonical = f"s={' '.join(s)}|p={' '.join(p)}|o={' '.join(o)}|n={' '.join(sorted(nums))}|c={' '.join(ctx)}"
    key = KEY_PREFIX + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]
    tokens = sorted(set(s + p + o + ctx)) + sorted(nums)
    sentence = " ".join(str(c.get(k) or "").strip() for k in ("subject", "predicate", "object")).strip()
    return Canon(key=key, stance=polarity, canonical=canonical, tokens=tokens, sentence=sentence[:300])


def similarity(a, b) -> float:
    """Jaccard with the same guards as the client: numbers must agree, short sets match only exactly."""
    a, b = set(a), set(b)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    j = inter / (len(a) + len(b) - inter)
    if j == 1:
        return 1.0
    if min(len(a), len(b)) < 4:
        return 0.0
    if {x for x in a if _is_num(x)} != {x for x in b if _is_num(x)}:
        return 0.0
    if bool(a & NEG) != bool(b & NEG):
        return 0.0
    return j


def hash_ref(value: str) -> str:
    """Hash used by clients for post ids and link keys (kept here for documentation/tests)."""
    return hashlib.sha256(("rta1:" + value).encode("utf-8")).hexdigest()[:32]


def field_tokens(c: dict) -> dict[str, list[str]]:
    """Per-field tokens used for event clustering (negations dropped, numbers kept separately)."""
    out: dict[str, list[str]] = {"subject": [], "predicate": [], "object": [], "context": [], "numbers": []}
    if not isinstance(c, dict):
        return out
    for src, dst in (("subject", "subject"), ("predicate", "predicate"), ("object", "object"), ("time", "context"), ("place", "context")):
        for t in tokenize(c.get(src), 32):
            if t in NEG:
                continue
            n = fmt_number(t.rstrip("%")) if _is_num(t) else None
            if n is not None:
                out["numbers"].append(n)      # pure numbers: weak evidence of the same event
            else:
                out[dst].append(t)            # names like "5g", "f35", "covid" stay with their field
    for q in (c.get("quantities") or [])[:8]:
        n = fmt_number(q.get("value") if isinstance(q, dict) else q)
        if n is not None:
            out["numbers"].append(n)
    return {k: sorted(set(v)) for k, v in out.items()}
