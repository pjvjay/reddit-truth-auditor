"""
Outlet registry: maps a linked domain (or an outlet a post *attributes* a claim to)
to an outlet, its ownership group and a reach tier.

The data lives in spec/outlets.json (shared with the userscript's offline
clustering); installed packages carry a copy in rta_server/data/.

Ownership group is the unit of *independence*: Fox News + Fox Business, or WSJ + NY Post
+ The Sun (News Corp), count as one independent source. Tier describes reach /
prominence - not quality or political lean.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

_HOST_RE = re.compile(r"^[a-z0-9.-]{3,253}$")
KINDS = {"news", "opinion", "analysis", "video", "social", "blog", "unknown"}


@lru_cache(maxsize=1)
def registry() -> dict:
    here = Path(__file__).resolve().parent
    for candidate in (here / "data" / "outlets.json", here.parents[2] / "spec" / "outlets.json"):
        if candidate.is_file():
            data = json.loads(candidate.read_text(encoding="utf-8"))
            aliases = dict(data.get("aliases", {}))
            for dom, o in data["outlets"].items():
                aliases.setdefault(o["name"].lower(), dom)
            data["aliases"] = aliases
            return data
    raise FileNotFoundError("outlets.json not found (expected rta_server/data/ or spec/)")


def _strip(host: str) -> str:
    return re.sub(r"^(www|m|amp|mobile)\.", "", (host or "").lower().strip().strip("."))


def registrable(host: str) -> str:
    """eTLD+1 for the common cases (edition.cnn.com -> cnn.com, www.bbc.co.uk -> bbc.co.uk)."""
    parts = _strip(host).split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in set(registry()["multi_part_suffixes"]):
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def lookup_domain(host: str) -> dict | None:
    """{domain, outlet, group, tier, type} - longest listed suffix wins; unknown sites are tier 3."""
    host = _strip(host)
    if not host or not _HOST_RE.match(host) or "." not in host:
        return None
    outlets = registry()["outlets"]
    parts = host.split(".")
    for i in range(len(parts) - 1):
        cand = ".".join(parts[i:])
        if cand in outlets:
            o = outlets[cand]
            return {"domain": cand, "outlet": o["name"], "group": o["group"], "tier": o["tier"], "type": o["type"]}
    reg = registrable(host)
    return {"domain": reg, "outlet": reg, "group": reg, "tier": 3, "type": "unknown"}


def lookup_name(name: str) -> dict | None:
    """Outlet for a name a post attributes the claim to ("according to Fox News")."""
    aliases = registry()["aliases"]
    n = re.sub(r"[^a-z0-9 .&'-]", "", (name or "").lower()).strip()
    if n not in aliases:
        n = re.sub(r"^the ", "", n)
    dom = aliases.get(n) or aliases.get("the " + n)
    return lookup_domain(dom) if dom else None


def source_weight(info: dict | None, kind: str | None) -> float:
    """How much one independent source counts towards diversity."""
    if not info:
        return 0.0
    reg = registry()
    if info["type"] in ("social", "video", "blog") or kind in ("social", "video", "blog"):
        return float(reg["platform_weight"])
    return float(reg["tier_weight"].get(str(info["tier"]), 0.4))
