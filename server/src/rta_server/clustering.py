"""
Event clustering of propagating false claims.

Points
    Every proposition active in the window whose consensus leans false
    (weighted mean truth <= max_truth).

Point weight  w  ("how hard is this false claim being pushed")
    w = F * (1 + ln(1 + spreading_posts)) * (1 + reach / 4) * (1 + diversity_bias * diversity)

    F          falsity = (10 - prop_truth)/10 * (1 - e^(-reporters/2))   (consensus strength)
    reach      ln(1 + sum over spreading posts of (score + 2*comments + 20*crossposts))
               - log-compressed, so a viral post counts for a lot more than a dead one without
                 one post being able to swamp everything
    diversity  independent-source diversity of the outlets carrying it:
               sum over distinct OWNERSHIP GROUPS of tier weight (1.0 / 0.7 / 0.4; platforms 0.25)
               + 0.25 per additional distinct source article beyond one per group,
               x (1 + 0.15 per additional article kind: news / opinion / analysis / video / social / blog)

Similarity between two propositions
    sim = 0.70 * cos_tfidf + 0.20 * shared_articles + 0.10 * time_proximity
    - cos_tfidf over canonical tokens, field-weighted (subject/object 1.5, context 1.0,
      predicate 0.5, pure numbers 0.3) with smoothed IDF (plus a 50-document background prior),
      so rare entities ("nickelback")
      dominate and common predicates ("states") barely count;
    - shared_articles = |A ∩ B| / min(|A|, |B|) over hashed source-article links;
    - time_proximity = exp(-|Δ mean day| / tau).
    An edge needs sim >= sim_threshold and either some text overlap or a shared article.

Algorithm: weighted DBSCAN
    A point is CORE when the total weight of itself + its neighbours >= min_mass.
    Core points connected by edges form a cluster; non-core neighbours join the most
    similar core's cluster; everything else is noise ("not (yet) propagating").
    Heavily pushed single propositions can be a cluster on their own; weakly supported
    one-off claims never are - the clustering is biased towards false claims carried by
    many independent outlets, many posts and high engagement.

Each cluster reports its members' share of the cluster weight, a representative (weighted
medoid), the most-pushed claim, outlet / ownership / article-kind breakdowns, engagement and a
severity score (0-100) with its components.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import date, timedelta

from .claimsig import field_tokens
from .outlets import source_weight

FIELD_W = {"subject": 1.5, "object": 1.5, "context": 1.0, "predicate": 0.5, "numbers": 0.3}
KIND_SET = ("news", "opinion", "analysis", "video", "social", "blog")
IDF_PRIOR = 50


@dataclass
class ClusterConfig:
    window_days: int = 30
    sim_threshold: float = 0.25
    min_mass: float = 2.5
    diversity_bias: float = 0.5     # how strongly independent-source diversity boosts a claim's weight
    max_truth: float = 5.0          # only propositions whose consensus truth is <= this are clustered
    time_tau: float = 7.0
    member_min_clients: int = 2     # member claims with fewer reporters are counted but not named
    cluster_min_clients: int = 3    # clusters need this many distinct reporters to be published


def _engagement(p: dict) -> float:
    return max(0, p.get("score") or 0) + 2 * max(0, p.get("comments") or 0) + 20 * max(0, p.get("crossposts") or 0)


def reach_of(posts) -> float:
    return math.log1p(sum(_engagement(p) for p in posts))


def diversity(posts: list[dict]) -> dict:
    """Independent-source diversity of the outlets carrying a claim (posts = spreading posts)."""
    groups: dict[str, float] = {}
    outlets: dict[str, dict] = {}
    articles, kinds = set(), set()
    for p in posts:
        if not p.get("outlet_group"):
            continue
        info = {"tier": p.get("tier") or 3, "type": p.get("outlet_type") or "unknown"}
        wgt = source_weight(info, p.get("source_kind"))
        groups[p["outlet_group"]] = max(groups.get(p["outlet_group"], 0.0), wgt)
        o = outlets.setdefault(p["outlet"], {"outlet": p["outlet"], "group": p["outlet_group"], "tier": info["tier"],
                                              "type": info["type"], "posts": 0, "kinds": set()})
        o["posts"] += 1
        if p.get("source_kind") in KIND_SET:
            o["kinds"].add(p["source_kind"])
            kinds.add(p["source_kind"])
        if p.get("url_hash"):
            articles.add(p["url_hash"])
    base = sum(groups.values())
    extra_articles = max(0, len(articles) - len(groups))
    score = (base + 0.25 * extra_articles) * (1 + 0.15 * max(0, len(kinds) - 1))
    outlet_list = sorted(({**o, "kinds": sorted(o["kinds"])} for o in outlets.values()), key=lambda o: (-o["posts"], o["tier"], o["outlet"]))
    return {"score": round(score, 3), "independent_sources": len(groups), "articles": len(articles),
            "kinds": sorted(kinds), "outlets": outlet_list}


def _tfidf(points: list[dict]) -> None:
    df = Counter()
    for p in points:
        p["_terms"] = {}
        for fld, toks in field_tokens(p["claim"]).items():
            for t in toks:
                p["_terms"][t] = max(p["_terms"].get(t, 0.0), FIELD_W[fld])
        df.update(p["_terms"].keys())
    n = len(points)
    # smoothed IDF with a background prior of IDF_PRIOR pseudo-documents that contain none of the terms:
    # keeps small / young corpora behaving like large ones (a term in 3 of 5 claims is still rare news-wide)
    idf = {t: math.log((n + IDF_PRIOR + 1) / (c + 1)) + 1.0 for t, c in df.items()}
    for p in points:
        v = {t: tf * idf[t] for t, tf in p["_terms"].items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        p["_vec"] = {t: x / norm for t, x in v.items()}
    return df


def _cos(a: dict, b: dict) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(t, 0.0) for t, x in a.items())


def run(points: list[dict], cfg: ClusterConfig, today: date) -> dict:
    """points: dicts with key, claim, sentence, consensus, posts (spreading), debunk_posts, days, reporters(set)."""
    # ---- point weights
    for p in points:
        c = p["consensus"]
        p["falsity"] = max(0.0, (10 - c["prop_truth"]) / 10)
        p["F"] = p["falsity"] * (1 - math.exp(-c["n_clients"] / 2))
        p["reach"] = reach_of(p["posts"])
        p["div"] = diversity(p["posts"])
        p["weight"] = (p["F"] * (1 + math.log1p(len(p["posts"]))) * (1 + p["reach"] / 4)
                       * (1 + cfg.diversity_bias * p["div"]["score"]))
        p["t"] = (sum(d.toordinal() for d in p["days"]) / len(p["days"])) if p["days"] else today.toordinal()
        p["links"] = {x["url_hash"] for x in p["posts"] + p["debunk_posts"] if x.get("url_hash")}

    df = _tfidf(points)
    n = len(points)
    # ---- candidate pairs via inverted indexes (terms that are not ubiquitous, and shared articles)
    index, link_index = defaultdict(list), defaultdict(list)
    for i, p in enumerate(points):
        for t in p["_terms"]:
            if n < 20 or df[t] <= 0.3 * n:
                index[t].append(i)
        for u in p["links"]:
            link_index[u].append(i)
    nbrs: list[dict[int, float]] = [dict() for _ in points]
    for i, p in enumerate(points):
        cand = set()
        for t in p["_terms"]:
            cand.update(index.get(t, ()))
        for u in p["links"]:
            cand.update(link_index[u])
        for j in cand:
            if j <= i:
                continue
            q = points[j]
            cos = _cos(p["_vec"], q["_vec"])
            shared = len(p["links"] & q["links"]) / min(len(p["links"]), len(q["links"])) if p["links"] and q["links"] else 0.0
            if cos < 0.1 and shared == 0:
                continue
            prox = math.exp(-abs(p["t"] - q["t"]) / cfg.time_tau)
            sim = 0.70 * cos + 0.20 * shared + 0.10 * prox
            if sim >= cfg.sim_threshold:
                nbrs[i][j] = nbrs[j][i] = round(sim, 4)

    # ---- weighted DBSCAN
    mass = [p["weight"] + sum(points[j]["weight"] for j in nbrs[i]) for i, p in enumerate(points)]
    core = [m >= cfg.min_mass for m in mass]
    label = [-1] * n
    order = sorted(range(n), key=lambda i: (-points[i]["weight"], points[i]["key"]))
    next_id = 0
    for i in order:
        if not core[i] or label[i] != -1:
            continue
        label[i] = next_id
        stack = [i]
        while stack:
            k = stack.pop()
            for j in nbrs[k]:
                if core[j] and label[j] == -1:
                    label[j] = next_id
                    stack.append(j)
        next_id += 1
    for i in order:
        if label[i] == -1 and not core[i]:
            best = max(((s, j) for j, s in nbrs[i].items() if core[j]), default=None)
            if best:
                label[i] = label[best[1]]

    groups = defaultdict(list)
    for i, l in enumerate(label):
        if l >= 0:
            groups[l].append(i)
    clusters = [_summarise([points[i] for i in idx], idx, nbrs, cfg, today) for idx in groups.values()]
    clusters.sort(key=lambda c: (-c["severity"]["score"], -c["mass"]))
    noise = sorted((i for i in range(n) if label[i] == -1), key=lambda i: -points[i]["weight"])
    return {
        "params": asdict(cfg),
        "points": n,
        "clusters": clusters,
        # not (yet) propagating: below the density threshold
        "noise": [{"key": points[i]["key"], "weight": round(points[i]["weight"], 3), "mass": round(mass[i], 3)} for i in noise[:50]],
    }


def _summarise(members: list[dict], idx: list[int], nbrs, cfg: ClusterConfig, today: date) -> dict:
    total = sum(m["weight"] for m in members) or 1e-9
    pos = {i: k for k, i in enumerate(idx)}
    # weighted medoid: the member most similar (weight-weighted) to the rest
    def centrality(k):
        i = idx[k]
        return members[k]["weight"] + sum(members[pos[j]]["weight"] * s for j, s in nbrs[i].items() if j in pos)
    rep = members[max(range(len(members)), key=centrality)]
    heaviest = max(members, key=lambda m: m["weight"])
    sims = [s for i in idx for j, s in nbrs[i].items() if j in pos and j > i]

    posts = {p["post"]: p for m in members for p in m["posts"]}          # a post can carry one claim; union is safe
    debunks = {p["post"] for m in members for p in m["debunk_posts"]}
    reporters = set().union(*(m["reporters"] for m in members))
    div = diversity(list(posts.values()))
    reach = reach_of(posts.values())
    subs = Counter(p["subreddit"] for p in posts.values() if p.get("subreddit"))
    days = [d for m in members for d in m["days"]]
    recent_start, prev_start = today - timedelta(days=6), today - timedelta(days=13)
    recent = sum(1 for p in posts.values() if p.get("day") and p["day"] >= recent_start)
    prev = sum(1 for p in posts.values() if p.get("day") and prev_start <= p["day"] < recent_start)
    growth = (recent - prev) / max(1, prev)

    # ---- severity (0-100) with explainable components
    falsity = sum(m["weight"] * m["falsity"] for m in members) / total
    q = 1 - math.exp(-len(reporters) / 3)
    d = 1 - math.exp(-div["score"] / 3)
    r = 1 - math.exp(-reach / 8)
    s = 1 - math.exp(-(len(posts) + 2 * len(subs)) / 20)
    v = min(max(growth, 0.0), 3.0) / 3
    score = 100 * falsity * (0.5 + 0.5 * q) * (0.35 * d + 0.30 * r + 0.20 * s + 0.15 * v)

    # top distinguishing terms of the weighted centroid
    centroid = Counter()
    for m in members:
        for t, x in m["_vec"].items():
            centroid[t] += x * m["weight"]
    ordered = sorted(members, key=lambda m: -m["weight"])
    daily = Counter(p["day"] for p in posts.values() if p.get("day"))
    start = today - timedelta(days=cfg.window_days - 1)
    return {
        "id": None,  # assigned by the store (stable across runs)
        "label": rep["sentence"],
        "representative": rep["key"],
        "most_pushed": heaviest["key"],
        "top_terms": [t for t, _ in centroid.most_common(8)],
        "mass": round(total, 3),
        "cohesion": round(sum(sims) / len(sims), 3) if sims else 1.0,
        "members": [{
            "key": m["key"], "sentence": m["sentence"], "weight": round(m["weight"], 3), "share": round(m["weight"] / total, 4),
            "prop_truth": m["consensus"]["prop_truth"], "reporters": m["consensus"]["n_clients"],
            "spreading_posts": len(m["posts"]), "debunking_posts": len(m["debunk_posts"]),
            "reach": round(m["reach"], 2), "independent_sources": m["div"]["independent_sources"],
            "outlets": [o["outlet"] for o in m["div"]["outlets"][:6]],
        } for m in ordered],
        "metrics": {
            "spreading_posts": len(posts), "debunking_posts": len(debunks), "reporters": len(reporters),
            "subreddits": [{"subreddit": k, "posts": v} for k, v in subs.most_common(10)], "subreddit_count": len(subs),
            "score": sum(max(0, p.get("score") or 0) for p in posts.values()),
            "comments": sum(max(0, p.get("comments") or 0) for p in posts.values()),
            "crossposts": sum(max(0, p.get("crossposts") or 0) for p in posts.values()),
            "reach": round(reach, 2),
            "independent_sources": div["independent_sources"], "source_articles": div["articles"],
            "article_kinds": dict(Counter(k for o in div["outlets"] for k in o["kinds"])),
            "outlets": div["outlets"][:20],
            "first_seen": min(days).isoformat() if days else None, "last_seen": max(days).isoformat() if days else None,
            "recent_posts": recent, "previous_posts": prev, "growth": round(growth, 2),
            "daily": [{"day": (start + timedelta(days=i)).isoformat(), "posts": daily.get(start + timedelta(days=i), 0)}
                      for i in range(cfg.window_days)],
        },
        "severity": {
            "score": round(score, 1),
            "components": {"falsity": round(falsity, 3), "consensus": round(q, 3), "source_diversity": round(d, 3),
                           "reach": round(r, 3), "spread": round(s, 3), "velocity": round(v, 3)},
            "diversity_score": div["score"],
        },
    }


def stable_ids(new_clusters: list[dict], previous: dict[str, set[str]]) -> None:
    """Reuse a previous cluster id when member overlap (Jaccard) >= 0.3, else mint a content-derived id."""
    used = set()
    pairs = []
    for ci, c in enumerate(new_clusters):
        keys = {m["key"] for m in c["members"]}
        for pid, pkeys in previous.items():
            j = len(keys & pkeys) / len(keys | pkeys)
            if j >= 0.3:
                pairs.append((j, ci, pid))
    for j, ci, pid in sorted(pairs, reverse=True):
        if new_clusters[ci]["id"] is None and pid not in used:
            new_clusters[ci]["id"] = pid
            used.add(pid)
    for c in new_clusters:
        if c["id"] is None:
            seed = ",".join(sorted(m["key"] for m in c["members"]))
            c["id"] = "c_" + hashlib.sha256(seed.encode()).hexdigest()[:12]


def dumps(o) -> str:
    return json.dumps(o, default=lambda x: x.isoformat() if hasattr(x, "isoformat") else sorted(x) if isinstance(x, set) else str(x))
