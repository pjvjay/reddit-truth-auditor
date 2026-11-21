"""
Reddit Truth Auditor - community API (reference implementation).

Collects anonymous reports of audited claims from userscript clients, merges them
into canonical *propositions*, and publishes:
  * a feed of propositions the community agrees are false (for clients to match locally),
  * frequency metrics (distinct posts spreading / debunking, exposures, subreddits, trends).

Run:   pip install ./server
       rta-server --host 0.0.0.0 --port 8080          (or: python -m rta_server)
Docs:  http://localhost:8080/docs  (OpenAPI)

Environment:
  RTA_DB                  SQLite path (default: ./rta-community.sqlite3)
  RTA_PUBLISH_TOKENS      comma-separated tokens; if set, POST /v1/reports requires X-RTA-Token
  RTA_CORS_ORIGINS        comma-separated origins for browser dashboards (default: *)
  RTA_FEED_MIN_CLIENTS    minimum independent reporters before a proposition is published (default 3)
  RTA_MAX_REPORTS_PER_DAY per anonymous client id (default 2000)
  RTA_IP_RATE_PER_MIN     POST requests per IP per minute (default 120; IPs are never stored)
  RTA_MAX_REPORT_AGE_DAYS oldest sighting day accepted (default 30 - clients publish offline backlogs)
  RTA_CLUSTER_WINDOW_DAYS / RTA_CLUSTER_SIM / RTA_CLUSTER_MIN_MASS / RTA_CLUSTER_DIVERSITY_BIAS /
  RTA_CLUSTER_MAX_TRUTH / RTA_CLUSTER_TTL   event clustering parameters (see clustering.py)
"""
from __future__ import annotations

import html
import os
import time
from collections import defaultdict, deque
from typing import Literal, Optional, Union

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .claimsig import TOPICS, canonicalize
from .clustering import ClusterConfig
from .store import Store

HEX32 = r"^[0-9a-f]{32}$"
TONE = Literal["sincere", "sarcastic", "humorous", "satirical", "unclear"]
KIND = Literal["news", "opinion", "analysis", "video", "social", "blog", "unknown"]


class Source(BaseModel):
    """Where the post's link points (host only - never the path)."""
    domain: str = Field(..., pattern=r"^[a-z0-9.-]{3,253}$")
    kind: KIND = "unknown"


class Attributed(BaseModel):
    """An outlet the post cites in its text ("according to Fox News ...")."""
    outlet: str = Field(..., max_length=80)
    kind: KIND = "unknown"


class Engagement(BaseModel):
    """Public popularity snapshot of the Reddit post when it was seen."""
    score: int = Field(0, ge=-1_000_000, le=100_000_000)
    comments: int = Field(0, ge=0, le=100_000_000)
    upvote_ratio: Optional[float] = Field(None, ge=0, le=1)
    crossposts: int = Field(0, ge=0, le=10_000_000)
    subscribers: int = Field(0, ge=0, le=1_000_000_000)


class Quantity(BaseModel):
    value: Union[float, int, str]
    unit: Optional[str] = Field(None, max_length=40)


class Claim(BaseModel):
    """Canonical claim structure (rta.claim/1) - see server/README.md."""
    subject: str = Field(..., max_length=200)
    predicate: str = Field("", max_length=80)
    object: str = Field("", max_length=300)
    polarity: Literal["affirms", "denies"] = "affirms"
    quantities: list[Quantity] = Field(default_factory=list, max_length=8)
    time: Optional[str] = Field(None, max_length=40)
    place: Optional[str] = Field(None, max_length=80)
    topic: Optional[str] = Field("other", max_length=30)


class Report(BaseModel):
    claim: Claim
    key: Optional[str] = Field(None, max_length=40, description="client-computed proposition key (informational; the server recomputes it)")
    claim_truth: float = Field(..., ge=0, le=10, description="truth of the claim AS STATED by the post (0-10)")
    confidence: Literal["low", "medium", "high"] = "medium"
    tone: TONE = "sincere"
    presented_as_fact: bool = False
    researched: bool = False
    sources: list[str] = Field(default_factory=list, max_length=5)
    verdict: str = Field("", max_length=400)
    model: str = Field("", max_length=60)
    post: str = Field(..., pattern=HEX32, description="sha256('rta1:' + reddit post id)[:32]")
    subreddit: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_]{2,21}$")
    url_hash: Optional[str] = Field(None, pattern=HEX32, description="sha256('rta1:' + normalised link)[:32]")
    day: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    origin: Literal["audit", "local", "community"] = "audit"
    source: Optional[Source] = None
    attributed: Optional[Attributed] = None
    engagement: Optional[Engagement] = None
    post_day: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="UTC day the Reddit post was created")


class ReportBatch(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    schema_: Literal["rta.report/1"] = Field("rta.report/1", alias="schema")
    client: str = Field(..., pattern=r"^c_[0-9a-f]{32}$", description="random, user-resettable install id")
    reports: list[Report] = Field(..., max_length=100)


def create_app(db_path: str | None = None) -> FastAPI:
    store = Store(db_path or os.environ.get("RTA_DB", "rta-community.sqlite3"),
                  max_reports_per_client_day=int(os.environ.get("RTA_MAX_REPORTS_PER_DAY", "2000")),
                  max_report_age_days=int(os.environ.get("RTA_MAX_REPORT_AGE_DAYS", "30")))
    tokens = {t.strip() for t in os.environ.get("RTA_PUBLISH_TOKENS", "").split(",") if t.strip()}
    feed_min = int(os.environ.get("RTA_FEED_MIN_CLIENTS", "3"))
    ip_rate = int(os.environ.get("RTA_IP_RATE_PER_MIN", "120"))
    env = os.environ.get
    store.cluster_cfg = ClusterConfig(
        window_days=int(env("RTA_CLUSTER_WINDOW_DAYS", "30")), sim_threshold=float(env("RTA_CLUSTER_SIM", "0.25")),
        min_mass=float(env("RTA_CLUSTER_MIN_MASS", "2.5")), diversity_bias=float(env("RTA_CLUSTER_DIVERSITY_BIAS", "0.5")),
        max_truth=float(env("RTA_CLUSTER_MAX_TRUTH", "5")), cluster_min_clients=feed_min)
    cluster_ttl = float(env("RTA_CLUSTER_TTL", "300"))
    hits: dict[str, deque] = defaultdict(deque)

    app = FastAPI(title="Reddit Truth Auditor – community API", version=__version__,
                  description="Anonymous, aggregated reports of mistruths seen on Reddit. See server/README.md.")
    app.state.store = store
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in os.environ.get("RTA_CORS_ORIGINS", "*").split(",")],
                       allow_methods=["GET", "POST"], allow_headers=["Content-Type", "X-RTA-Token"])

    def rate_limit(request: Request):
        ip = request.client.host if request.client else "?"
        now = time.monotonic()
        q = hits[ip]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= ip_rate:
            raise HTTPException(429, "Too many requests")
        q.append(now)

    def check_token(x_rta_token: Optional[str] = Header(None)):
        if tokens and x_rta_token not in tokens:
            raise HTTPException(401, "Missing or invalid X-RTA-Token")

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.post("/v1/reports", dependencies=[Depends(rate_limit), Depends(check_token)])
    def post_reports(batch: ReportBatch):
        """
        Submit a batch of audited claims. Only claims meant as fact are accepted (jokes/satire not passed off as fact are ignored).

        Returns `accepted`, `keys`, `quota` (`limit`, `used`, `remaining`, `resets_at` in epoch seconds) and `rejected`:
        one `{index, code, reason}` per report that was not stored, where `index` is its position in the request and
        `code` is `quota` (over the daily quota - send it again after `quota.resets_at`), `invalid` or `joke`.
        `duplicates` is how many of the accepted reports this client had already sent; those cost no quota.
        """
        ok, positions, skipped = [], [], []
        for i, r in enumerate(batch.reports):
            if r.tone in ("humorous", "satirical") and not r.presented_as_fact:
                skipped.append({"index": i, "code": "joke", "reason": "joke/satire not presented as fact"})
                continue
            d = r.model_dump()
            for k in ("source", "attributed", "engagement"):
                d[k] = getattr(r, k).model_dump() if getattr(r, k) else None
            d["claim"] = r.claim.model_dump()
            d["claim"]["quantities"] = [q.model_dump() for q in r.claim.quantities]
            if d["claim"].get("topic") not in TOPICS:
                d["claim"]["topic"] = "other"
            ok.append(d)
            positions.append(i)
        res = store.ingest(batch.client, ok)
        # ingest numbers its rejections within `ok`; clients need the position in the request they sent
        stored = [{**x, "index": positions[x["index"]]} for x in res["rejected"]]
        res["rejected"] = sorted(skipped + stored, key=lambda x: x["index"])
        return res

    @app.post("/v1/canonicalize")
    def post_canonicalize(claim: Claim):
        """Compute the proposition key for a canonical claim (same algorithm as the userscript)."""
        c = canonicalize(claim.model_dump() | {"quantities": [q.model_dump() for q in claim.quantities]})
        if not c:
            raise HTTPException(422, "claim needs a subject or object")
        return {"key": c.key, "stance": c.stance, "canonical": c.canonical, "tokens": c.tokens}

    @app.get("/v1/propositions/feed")
    def get_feed(min_clients: int = Query(feed_min, ge=1, le=1000), limit: int = Query(5000, ge=1, le=20000)):
        """Propositions the community agrees are false, reported by >= max(min_clients, server minimum) independent clients."""
        m = max(min_clients, feed_min)
        return {"schema": "rta.feed/1", "generated_at": int(time.time()), "min_clients": m, "items": store.feed(m, limit)}

    @app.get("/v1/propositions/top")
    def get_top(days: int = Query(7, ge=1, le=90), limit: int = Query(20, ge=1, le=200),
                sort: Literal["posts", "exposures", "clients", "trending", "engagement", "sources"] = "posts",
                status: Literal["false", "disputed", "true", "all"] = "false"):
        """Most frequent propositions in the last `days` days (by distinct posts, exposures, reporters or growth)."""
        return {"days": days, "sort": sort, "items": store.top(days, limit, sort, status, min_clients=feed_min if status == "false" else 1)}

    @app.get("/v1/propositions/{key}")
    def get_prop(key: str):
        p = store.proposition(key)
        if not p:
            raise HTTPException(404, "unknown proposition")
        return p

    def _clusters(days: int, force: bool = False) -> dict:
        cfg = store.cluster_cfg
        if days != cfg.window_days:
            cfg = ClusterConfig(**{**cfg.__dict__, "window_days": days})
        return store.clusters(cfg, force=force, ttl=cluster_ttl)

    @app.get("/v1/clusters")
    def get_clusters(days: int = Query(30, ge=3, le=90), limit: int = Query(20, ge=1, le=200),
                     sort: Literal["severity", "mass", "posts", "growth", "sources"] = "severity", min_severity: float = Query(0, ge=0, le=100)):
        """Event clusters of false claims that are being propagated, ranked by severity (or mass / posts / growth / source diversity)."""
        res = _clusters(days)
        keyf = {"severity": lambda c: c["severity"]["score"], "mass": lambda c: c["mass"], "posts": lambda c: c["metrics"]["spreading_posts"],
                "growth": lambda c: c["metrics"]["growth"], "sources": lambda c: c["severity"]["diversity_score"]}[sort]
        items = [c for c in res["clusters"] if c["published"] and c["label"] and c["severity"]["score"] >= min_severity]
        return {"schema": "rta.clusters/1", "generated_at": res["generated_at"], "params": res["params"],
                "points": res["points"], "items": sorted(items, key=keyf, reverse=True)[:limit]}

    @app.get("/v1/clusters/{cid}")
    def get_cluster(cid: str, days: int = Query(30, ge=3, le=90)):
        c = next((c for c in _clusters(days)["clusters"] if c["id"] == cid and c["published"]), None)
        if not c:
            raise HTTPException(404, "unknown cluster")
        return c

    @app.post("/v1/clusters/recompute", dependencies=[Depends(rate_limit), Depends(check_token)])
    def recompute(days: int = Query(30, ge=3, le=90)):
        res = _clusters(days, force=True)
        return {"clusters": len(res["clusters"]), "points": res["points"], "generated_at": res["generated_at"]}

    @app.get("/v1/stats")
    def get_stats():
        return store.stats()

    @app.get("/", response_class=HTMLResponse)
    def dashboard(days: int = Query(7, ge=1, le=90)):
        esc = html.escape
        clusters = [c for c in _clusters(max(days, 14))["clusters"] if c["published"] and c["label"]][:15]
        cards = []
        for c in clusters:
            sev, m = c["severity"], c["metrics"]
            colour = "#d9304a" if sev["score"] >= 60 else "#e08a00" if sev["score"] >= 35 else "#5a6b8c"
            outlets = " ".join(f"<span class=o title='{esc(o['group'])} · tier {o['tier']}'>{esc(o['outlet'])}"
                               f"{' · ' + esc('/'.join(o['kinds'])) if o['kinds'] else ''}</span>" for o in m["outlets"][:8])
            mem = "".join(f"<div class=m><span class=bar style='width:{max(2, round(x['share'] * 100))}%'></span>"
                          f"{esc(x['sentence']) if x['sentence'] else '<i>rarely reported variant</i>'} <small>{round(x['share'] * 100)}% · "
                          f"{x['spreading_posts']} posts</small></div>" for x in c["members"][:6])
            comp = " · ".join(f"{k.replace('_', ' ')} {round(v * 100)}%" for k, v in sev["components"].items())
            cards.append(f"<div class=c><div class=sev style='background:{colour}'>{round(sev['score'])}</div><div class=cb>"
                         f"<b>{esc(c['label'])}</b><div class=meta>{m['spreading_posts']} spreading posts · {m['debunking_posts']} debunking · "
                         f"{m['subreddit_count']} subreddits · {m['score']:,} upvotes · {m['comments']:,} comments · "
                         f"{m['independent_sources']} independent sources · growth {m['growth']:+.0%}</div>"
                         f"<div class=outlets>{outlets or '<small>no outlet links yet</small>'}</div>{mem}<div class=comp>{esc(comp)}</div></div></div>")
        cluster_html = "".join(cards) or "<p>No propagating narratives have formed yet.</p>"
        items = store.top(days, 30, "posts", "false", min_clients=feed_min)
        st = store.stats()
        bars = "▁▂▃▄▅▆▇█"
        rows = []
        for it in items:
            mx = max([d["posts"] for d in it["daily"]] + [1])
            spark = "".join(bars[min(7, round(d["posts"] / mx * 7))] for d in it["daily"])
            c, w = it["consensus"], it["window"]
            subs = ", ".join(f"r/{s['subreddit']} ({s['posts']})" for s in it["subreddits"][:3])
            rows.append(
                f"<tr><td><b>{html.escape(it['sentence'] or '')}</b><div class=v>{html.escape(c['verdict'] or '')}</div></td>"
                f"<td>{c['prop_truth']}/10</td><td>{c['n_clients']}</td><td>{w['spreading']}</td><td>{w['debunking']}</td>"
                f"<td>{w['exposures']}</td><td class=sp>{spark}</td><td>{html.escape(subs)}</td></tr>")
        body = "".join(rows) or "<tr><td colspan=8>No propositions have reached the reporting threshold yet.</td></tr>"
        return f"""<!doctype html><meta charset=utf-8><title>Truth Auditor – common mistruths</title>
<style>body{{font:14px system-ui,sans-serif;margin:32px;color:#1d2433}}
.c{{display:flex;gap:14px;padding:14px;border:1px solid #e4e7ee;border-radius:12px;margin-bottom:12px}}
.sev{{flex:none;width:52px;height:52px;border-radius:12px;color:#fff;font:800 20px system-ui;display:grid;place-items:center}}
.cb{{flex:1}}.meta{{color:#667;font-size:12px;margin:3px 0 6px}}.o{{display:inline-block;background:#eef1f7;border-radius:6px;padding:1px 7px;margin:2px;font-size:12px}}
.m{{position:relative;font-size:12.5px;padding:3px 6px;margin-top:3px}}.m small{{color:#667}}
.bar{{position:absolute;left:0;top:0;bottom:0;background:#fde3e7;border-radius:4px;z-index:-1}}.comp{{color:#8a93a6;font-size:11px;margin-top:6px}}table{{border-collapse:collapse;width:100%}}
th,td{{text-align:left;padding:8px 10px;border-bottom:1px solid #e4e7ee;vertical-align:top}}th{{font-size:12px;text-transform:uppercase;color:#667}}
.v{{color:#667;font-size:12px;margin-top:3px}}.sp{{font-family:monospace;letter-spacing:1px;color:#d9304a}}</style>
<h1>Propagating false narratives</h1>
<p>Event clusters of false claims, weighted by independent outlets carrying them, post popularity and spread. Severity 0–100.
<a href="/v1/clusters">JSON</a></p>
{cluster_html}
<h1>Most common mistruths – last {days} days</h1>
<p>{st['propositions']} propositions · {st['reporters']} anonymous reporters · {st['posts']} posts · {st['exposures']} exposures.
Only propositions judged false by ≥ {feed_min} independent reporters are listed. <a href="/docs">API</a></p>
<table><tr><th>Proposition</th><th>Truth</th><th>Reporters</th><th>Spreading posts</th><th>Debunking posts</th><th>Exposures</th><th>Daily</th><th>Where</th></tr>{body}</table>"""

    return app

