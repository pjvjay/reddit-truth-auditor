"""SQLite storage, proposition merging and consensus for the community API."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

from . import clustering
from .claimsig import canonicalize, similarity
from .outlets import lookup_domain, lookup_name

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS propositions (
    key         TEXT PRIMARY KEY,
    canonical   TEXT NOT NULL,
    subject     TEXT, predicate TEXT, object TEXT,
    quantities  TEXT, time TEXT, place TEXT, topic TEXT,
    sentence    TEXT,
    tokens      TEXT NOT NULL,
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prop_tokens (token TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (token, key));
CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, key TEXT NOT NULL, similarity REAL);
-- one (latest) vote per client per proposition; truth is normalised to the AFFIRMED proposition
CREATE TABLE IF NOT EXISTS votes (
    key TEXT NOT NULL, client TEXT NOT NULL,
    prop_truth REAL NOT NULL, confidence TEXT, researched INTEGER, tone TEXT, presented_as_fact INTEGER,
    stance TEXT, verdict TEXT, sources TEXT, model TEXT, day TEXT NOT NULL,
    PRIMARY KEY (key, client)
);
-- one row per (proposition, post, client): distinct posts = spread, rows = exposures
CREATE TABLE IF NOT EXISTS sightings (
    key TEXT NOT NULL, post TEXT NOT NULL, client TEXT NOT NULL,
    stance TEXT NOT NULL, subreddit TEXT, origin TEXT, day TEXT NOT NULL,
    PRIMARY KEY (key, post, client)
);
CREATE INDEX IF NOT EXISTS sightings_day ON sightings(day);
CREATE TABLE IF NOT EXISTS link_reports (key TEXT NOT NULL, url_hash TEXT NOT NULL, client TEXT NOT NULL, PRIMARY KEY (key, url_hash, client));
CREATE TABLE IF NOT EXISTS client_days (client TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (client, day));
-- one row per (hashed) post: where it came from and how popular it is (max observed across clients)
CREATE TABLE IF NOT EXISTS posts (
    post TEXT PRIMARY KEY, subreddit TEXT, url_hash TEXT,
    domain TEXT, source_kind TEXT, outlet TEXT, outlet_group TEXT, tier INTEGER, outlet_type TEXT, outlet_via TEXT,
    score INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, upvote_ratio REAL, crossposts INTEGER DEFAULT 0, subscribers INTEGER DEFAULT 0,
    post_day TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cluster_members (cluster TEXT NOT NULL, key TEXT NOT NULL, share REAL, PRIMARY KEY (cluster, key));
"""

ENGAGEMENT_CAPS = {"score": 5_000_000, "comments": 1_000_000, "crossposts": 100_000, "subscribers": 200_000_000}

CONF_W = {"high": 1.0, "medium": 0.7, "low": 0.4}
FALSE_MAX, TRUE_MIN = 4.0, 6.0


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def quota_reset(day: str) -> int:
    """Epoch seconds of the UTC midnight that ends `day` - when the per-client daily quota starts again."""
    d = date.fromisoformat(day) + timedelta(days=1)
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


class Store:
    def __init__(self, path: str, merge_threshold: float = 0.85, max_reports_per_client_day: int = 2000, max_report_age_days: int = 30):
        self.path = path
        self.merge_threshold = merge_threshold
        self.max_per_day = max_reports_per_client_day
        self.max_age = max(1, max_report_age_days)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA_SQL)
        self.cluster_cfg = clustering.ClusterConfig()
        self._ccache: dict[int, tuple[float, dict]] = {}
        self._dirty = True

    # ------------------------------------------------------------------ ingest
    def resolve(self, key: str) -> str:
        row = self.db.execute("SELECT key FROM aliases WHERE alias=?", (key,)).fetchone()
        return row["key"] if row else key

    def _find_similar(self, tokens: list[str]) -> tuple[str, float] | None:
        if len(tokens) < 2:
            return None
        need = max(2, int(len(tokens) * 0.5))
        q = ",".join("?" * len(tokens))
        rows = self.db.execute(
            f"SELECT key, COUNT(*) c FROM prop_tokens WHERE token IN ({q}) GROUP BY key HAVING c >= ? ORDER BY c DESC LIMIT 25",
            (*tokens, need)).fetchall()
        best = None
        for r in rows:
            other = self.db.execute("SELECT tokens FROM propositions WHERE key=?", (r["key"],)).fetchone()
            sim = similarity(tokens, json.loads(other["tokens"]))
            if sim >= self.merge_threshold and (best is None or sim > best[1]):
                best = (r["key"], sim)
        return best

    def _upsert_proposition(self, claim: dict, canon, day: str) -> str:
        key = self.resolve(canon.key)
        if self.db.execute("SELECT 1 FROM propositions WHERE key=?", (key,)).fetchone():
            self.db.execute("UPDATE propositions SET last_seen=max(last_seen, ?) WHERE key=?", (day, key))
            return key
        similar = self._find_similar(canon.tokens)
        if similar:  # near-identical canonical wording from another client -> merge as alias
            self.db.execute("INSERT OR REPLACE INTO aliases(alias, key, similarity) VALUES (?,?,?)", (canon.key, similar[0], similar[1]))
            self.db.execute("UPDATE propositions SET last_seen=max(last_seen, ?) WHERE key=?", (day, similar[0]))
            return similar[0]
        self.db.execute(
            "INSERT INTO propositions(key, canonical, subject, predicate, object, quantities, time, place, topic, sentence, tokens, first_seen, last_seen)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (key, canon.canonical, claim.get("subject"), claim.get("predicate"), claim.get("object"),
             json.dumps(claim.get("quantities") or []), claim.get("time"), claim.get("place"), claim.get("topic") or "other",
             canon.sentence, json.dumps(canon.tokens), day, day))
        self.db.executemany("INSERT OR IGNORE INTO prop_tokens(token, key) VALUES (?,?)", [(t, key) for t in canon.tokens])
        return key

    def _used(self, client: str, day: str) -> int:
        row = self.db.execute("SELECT n FROM client_days WHERE client=? AND day=?", (client, day)).fetchone()
        return row["n"] if row else 0

    def quota(self, client: str, day: str | None = None) -> dict:
        """Where a client stands against its daily quota (the day is the server's UTC day)."""
        day = day or today()
        used = self._used(client, day)
        return {"limit": self.max_per_day, "used": used, "remaining": max(0, self.max_per_day - used), "resets_at": quota_reset(day)}

    def _seen(self, client: str, canon, post: str) -> bool:
        """Has this client already reported this proposition for this post?"""
        return self.db.execute("SELECT 1 FROM sightings WHERE key=? AND post=? AND client=?",
                               (self.resolve(canon.key), post, client)).fetchone() is not None

    def ingest(self, client: str, reports: list[dict]) -> dict:
        """
        Store a batch. Each rejection carries a machine-readable `code`:
          "quota"    over the client's daily quota - nothing is wrong with the report; send it again after `quota.resets_at`
          "invalid"  the report itself cannot be used - sending it again will not help

        The quota counts new reports that are stored. A repeat - the same client reporting the same proposition
        for the same post again, as happens when two of its tabs send the same queue or a reply gets lost - is
        accepted (the vote and post statistics are refreshed, the sighting stays single), counted in
        `duplicates`, and costs nothing, even when the quota is used up.
        """
        accepted, duplicates, rejected, keys = 0, 0, [], []
        server_day = today()
        with self.lock, self.db:
            used, new = self._used(client, server_day), 0
            for i, r in enumerate(reports):
                canon = canonicalize(r["claim"])
                if canon is None:
                    rejected.append({"index": i, "code": "invalid", "reason": "claim has no subject/object"})
                    continue
                repeat = self._seen(client, canon, r["post"])
                if not repeat:
                    if used + new >= self.max_per_day:
                        rejected.append({"index": i, "code": "quota", "reason": "daily quota exceeded"})
                        continue
                    new += 1
                # the day the post was SEEN: clients publish offline backlogs later, so accept up to
                # max_report_age_days back - but never a day in the future or older than that
                day = r.get("day") or server_day
                try:
                    d = date.fromisoformat(day)
                    if not (date.fromisoformat(server_day) - timedelta(days=self.max_age) <= d <= date.fromisoformat(server_day)):
                        day = server_day
                except ValueError:
                    day = server_day
                key = self._upsert_proposition(r["claim"], canon, day)
                stance = canon.stance
                claim_truth = float(r["claim_truth"])
                prop_truth = claim_truth if stance == "affirms" else 10.0 - claim_truth
                if r.get("origin", "audit") != "community":  # community-derived results never vote (no feedback loop)
                    self.db.execute(
                        "INSERT INTO votes(key, client, prop_truth, confidence, researched, tone, presented_as_fact, stance, verdict, sources, model, day)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key, client) DO UPDATE SET"
                        " prop_truth=excluded.prop_truth, confidence=excluded.confidence, researched=excluded.researched, tone=excluded.tone,"
                        " presented_as_fact=excluded.presented_as_fact, stance=excluded.stance, verdict=excluded.verdict,"
                        " sources=excluded.sources, model=excluded.model, day=excluded.day",
                        (key, client, prop_truth, r.get("confidence"), int(bool(r.get("researched"))), r.get("tone"),
                         int(bool(r.get("presented_as_fact"))), stance, r.get("verdict"), json.dumps(r.get("sources") or []),
                         r.get("model"), day))
                self.db.execute(
                    "INSERT INTO sightings(key, post, client, stance, subreddit, origin, day) VALUES (?,?,?,?,?,?,?)"
                    " ON CONFLICT(key, post, client) DO NOTHING",
                    (key, r["post"], client, stance, (r.get("subreddit") or None), r.get("origin", "audit"), day))
                self._upsert_post(r, day, server_day)
                if r.get("url_hash") and stance == "affirms" and prop_truth <= FALSE_MAX:
                    self.db.execute("INSERT OR IGNORE INTO link_reports(key, url_hash, client) VALUES (?,?,?)", (key, r["url_hash"], client))
                accepted += 1
                duplicates += repeat
                keys.append(key)
            if new:
                self.db.execute("INSERT INTO client_days(client, day, n) VALUES (?,?,?) ON CONFLICT(client, day) DO UPDATE SET n = n + ?",
                                (client, server_day, new, new))
            quota = self.quota(client, server_day)
        if accepted:
            self._dirty = True
        return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected, "keys": keys, "quota": quota}

    def _upsert_post(self, r: dict, day: str, server_day: str) -> None:
        src, att, eng = r.get("source") or {}, r.get("attributed") or {}, r.get("engagement") or {}
        info, via, kind = None, None, None
        if src.get("domain"):
            info, via, kind = lookup_domain(src["domain"]), "link", src.get("kind")
        if not info and att.get("outlet"):
            info, via, kind = lookup_name(att["outlet"]), "attribution", att.get("kind")
        num = lambda k: max(0, min(int(eng.get(k) or 0), ENGAGEMENT_CAPS[k]))  # noqa: E731
        post_day = r.get("post_day")
        try:
            if post_day and not (date(2005, 6, 1) <= date.fromisoformat(post_day) <= date.fromisoformat(server_day)):
                post_day = None
        except ValueError:
            post_day = None
        self.db.execute(
            "INSERT INTO posts(post, subreddit, url_hash, domain, source_kind, outlet, outlet_group, tier, outlet_type, outlet_via,"
            " score, comments, upvote_ratio, crossposts, subscribers, post_day, first_seen, last_seen)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(post) DO UPDATE SET"
            " subreddit=COALESCE(excluded.subreddit, posts.subreddit), url_hash=COALESCE(posts.url_hash, excluded.url_hash),"
            # link-derived outlet info beats an attribution in the text
            " domain=CASE WHEN posts.outlet_via='link' THEN posts.domain ELSE COALESCE(excluded.domain, posts.domain) END,"
            " source_kind=CASE WHEN posts.outlet_via='link' THEN posts.source_kind ELSE COALESCE(excluded.source_kind, posts.source_kind) END,"
            " outlet=CASE WHEN posts.outlet_via='link' THEN posts.outlet ELSE COALESCE(excluded.outlet, posts.outlet) END,"
            " outlet_group=CASE WHEN posts.outlet_via='link' THEN posts.outlet_group ELSE COALESCE(excluded.outlet_group, posts.outlet_group) END,"
            " tier=CASE WHEN posts.outlet_via='link' THEN posts.tier ELSE COALESCE(excluded.tier, posts.tier) END,"
            " outlet_type=CASE WHEN posts.outlet_via='link' THEN posts.outlet_type ELSE COALESCE(excluded.outlet_type, posts.outlet_type) END,"
            " outlet_via=CASE WHEN posts.outlet_via='link' THEN 'link' ELSE COALESCE(excluded.outlet_via, posts.outlet_via) END,"
            " score=max(posts.score, excluded.score), comments=max(posts.comments, excluded.comments),"
            " upvote_ratio=COALESCE(excluded.upvote_ratio, posts.upvote_ratio), crossposts=max(posts.crossposts, excluded.crossposts),"
            " subscribers=max(posts.subscribers, excluded.subscribers), post_day=COALESCE(posts.post_day, excluded.post_day),"
            " last_seen=max(posts.last_seen, excluded.last_seen)",
            (r["post"], r.get("subreddit") or None, r.get("url_hash"),
             info and info["domain"], kind if kind in ("news", "opinion", "analysis", "video", "social", "blog") else (info and "unknown"),
             info and info["outlet"], info and info["group"], info and info["tier"], info and info["type"], via if info else None,
             num("score"), num("comments"), eng.get("upvote_ratio"), num("crossposts"), num("subscribers"), post_day, day, day))

    # ------------------------------------------------------------------ clustering
    def load_points(self, cfg: "clustering.ClusterConfig") -> list[dict]:
        since = (datetime.now(timezone.utc).date() - timedelta(days=cfg.window_days - 1)).isoformat()
        keys = [r["key"] for r in self.db.execute("SELECT DISTINCT key FROM sightings WHERE day >= ?", (since,))]
        points = []
        for key in keys:
            c = self.consensus(key)
            if c["n_clients"] == 0 or c["status"] == "true" or c["prop_truth"] > cfg.max_truth:
                continue
            row = self.db.execute("SELECT * FROM propositions WHERE key=?", (key,)).fetchone()
            posts, debunks, days = {}, {}, set()
            for s in self.db.execute(
                    "SELECT s.post, s.stance, s.day sday, p.* FROM sightings s LEFT JOIN posts p ON p.post = s.post"
                    " WHERE s.key = ? AND s.day >= ?", (key, since)):
                d = dict(s)
                d["post"] = s["post"]
                d["day"] = date.fromisoformat(d.get("post_day") or d.get("first_seen") or s["sday"])
                (posts if s["stance"] == "affirms" else debunks)[s["post"]] = d
            for d in (posts or debunks).values():
                days.add(d["day"])
            points.append({
                "key": key, "sentence": row["sentence"], "consensus": c,
                "claim": {"subject": row["subject"], "predicate": row["predicate"], "object": row["object"],
                          "quantities": json.loads(row["quantities"] or "[]"), "time": row["time"], "place": row["place"]},
                "posts": list(posts.values()), "debunk_posts": list(debunks.values()), "days": sorted(days),
                "reporters": {r["client"] for r in self.db.execute("SELECT client FROM votes WHERE key=?", (key,))},
            })
        return points

    def clusters(self, cfg: "clustering.ClusterConfig | None" = None, force: bool = False, ttl: float = 300) -> dict:
        """Cached clustering run; recomputed when stale, or when new reports arrived and it is >30 s old."""
        cfg = cfg or self.cluster_cfg
        now = time.time()
        cached = self._ccache.get(cfg.window_days)
        if cached and not force and now - cached[0] < ttl and not (self._dirty and now - cached[0] > 30):
            return cached[1]
        with self.lock:
            points = self.load_points(cfg)
            result = clustering.run(points, cfg, datetime.now(timezone.utc).date())
            previous = defaultdict(set)
            for r in self.db.execute("SELECT cluster, key FROM cluster_members"):
                previous[r["cluster"]].add(r["key"])
            clustering.stable_ids(result["clusters"], previous)
            for c in result["clusters"]:
                c["published"] = c["metrics"]["reporters"] >= cfg.cluster_min_clients
                visible = [m for m in c["members"] if m["reporters"] >= cfg.member_min_clients]
                hidden = 0
                for m in c["members"]:
                    if m["reporters"] < cfg.member_min_clients:   # rare variants: counted, not named
                        m["sentence"] = None
                        hidden += 1
                rep = next((m for m in c["members"] if m["key"] == c["representative"] and m["sentence"]), None)
                c["label"] = (rep or (visible[0] if visible else {"sentence": None}))["sentence"]
                c["hidden_members"] = hidden
            with self.db:
                self.db.execute("DELETE FROM cluster_members")
                self.db.executemany("INSERT INTO cluster_members(cluster, key, share) VALUES (?,?,?)",
                                    [(c["id"], m["key"], m["share"]) for c in result["clusters"] for m in c["members"]])
            result["generated_at"] = int(now)
            self._ccache[cfg.window_days] = (now, result)
            self._dirty = False
            return result

    def cluster_of(self, key: str) -> dict | None:
        for c in self.clusters()["clusters"]:
            if not c["published"] or not c["label"]:
                continue
            for m in c["members"]:
                if m["key"] == key:
                    met = c["metrics"]
                    return {"id": c["id"], "label": c["label"], "severity": c["severity"]["score"], "share": m["share"],
                            "independent_sources": met["independent_sources"], "outlets": [o["outlet"] for o in met["outlets"][:5]],
                            "spreading_posts": met["spreading_posts"], "subreddit_count": met["subreddit_count"],
                            "growth": met["growth"], "members": len(c["members"])}
        return None

    # ------------------------------------------------------------------ consensus & metrics
    def consensus(self, key: str) -> dict:
        votes = self.db.execute("SELECT * FROM votes WHERE key=?", (key,)).fetchall()
        if not votes:
            return {"status": "unknown", "n_clients": 0}
        wsum = tsum = wfalse = wtrue = 0.0
        tones = Counter()
        for v in votes:
            w = CONF_W.get(v["confidence"] or "medium", 0.7) * (1.0 if v["researched"] else 0.6)
            wsum += w
            tsum += w * v["prop_truth"]
            wfalse += w if v["prop_truth"] <= FALSE_MAX else 0
            wtrue += w if v["prop_truth"] >= TRUE_MIN else 0
            tones["satire-as-fact" if v["presented_as_fact"] else (v["tone"] or "sincere")] += 1
        mean = tsum / wsum
        agree_false, agree_true = wfalse / wsum, wtrue / wsum
        status = "false" if mean <= FALSE_MAX and agree_false >= 0.66 else "true" if mean >= TRUE_MIN and agree_true >= 0.66 else "disputed"
        # the verdict sentence most reporters agree on (confidence-weighted), preferring ones written about the
        # false claim itself (affirming stance); ties -> most recent, then alphabetical (deterministic)
        vv = Counter()
        latest = {}
        for v in votes:
            if v["verdict"]:
                vv[v["verdict"]] += CONF_W.get(v["confidence"] or "", 0.5) * (2 if v["stance"] == "affirms" else 1)
                latest[v["verdict"]] = max(latest.get(v["verdict"], ""), v["day"])
        ranked = sorted(vv, key=lambda t: (-vv[t], -date.fromisoformat(latest[t]).toordinal(), t))
        best = [{"verdict": t} for t in ranked]
        srcs = Counter(u for v in votes for u in json.loads(v["sources"] or "[]"))
        conf = "high" if len(votes) >= 5 and max(agree_false, agree_true) >= 0.85 else "medium" if len(votes) >= 3 else "low"
        return {
            "status": status,
            "prop_truth": round(mean, 2),
            "agreement": round(max(agree_false, agree_true), 3),
            "confidence": conf,
            "n_clients": len(votes),
            "researched_share": round(sum(1 for v in votes if v["researched"]) / len(votes), 3),
            "tone": tones.most_common(1)[0][0],
            "verdict": best[0]["verdict"] if best else "",
            "sources": [u for u, _ in srcs.most_common(5)],
        }

    def counts(self, key: str, since: str | None = None) -> dict:
        where, args = "key=?", [key]
        if since:
            where += " AND day>=?"
            args.append(since)
        r = self.db.execute(
            f"SELECT COUNT(DISTINCT post) posts, COUNT(*) exposures,"
            f" COUNT(DISTINCT CASE WHEN stance='affirms' THEN post END) spreading,"
            f" COUNT(DISTINCT CASE WHEN stance='denies' THEN post END) debunking FROM sightings WHERE {where}", args).fetchone()
        return dict(r)

    def _prop(self, row) -> dict:
        key = row["key"]
        return {
            "key": key,
            "claim": {"subject": row["subject"], "predicate": row["predicate"], "object": row["object"],
                      "quantities": json.loads(row["quantities"] or "[]"), "time": row["time"], "place": row["place"], "topic": row["topic"]},
            "sentence": row["sentence"],
            "tokens": json.loads(row["tokens"]),
            "aliases": [a["alias"] for a in self.db.execute("SELECT alias FROM aliases WHERE key=?", (key,))],
            "first_seen": row["first_seen"],
            "last_seen": row["last_seen"],
        }

    def feed(self, min_clients: int = 3, limit: int = 5000) -> list[dict]:
        """Propositions the community agrees are FALSE, with enough independent reporters."""
        rows = self.db.execute(
            "SELECT p.* FROM propositions p JOIN (SELECT key, COUNT(*) n FROM votes GROUP BY key HAVING n >= ?) v ON v.key = p.key"
            " ORDER BY p.last_seen DESC LIMIT ?", (min_clients, limit)).fetchall()
        out = []
        for row in rows:
            c = self.consensus(row["key"])
            if c["status"] != "false":
                continue
            item = self._prop(row)
            item["consensus"] = c
            item["counts"] = self.counts(row["key"])
            item["url_hashes"] = [r["url_hash"] for r in self.db.execute(
                "SELECT url_hash FROM link_reports WHERE key=? GROUP BY url_hash HAVING COUNT(DISTINCT client) >= ?", (row["key"], min_clients))]
            item["cluster"] = self.cluster_of(row["key"])
            out.append(item)
        return out

    def top(self, days: int = 7, limit: int = 20, sort: str = "posts", status: str = "false", min_clients: int = 1) -> list[dict]:
        since = (datetime.now(timezone.utc).date() - timedelta(days=days - 1)).isoformat()
        prev = (datetime.now(timezone.utc).date() - timedelta(days=2 * days - 1)).isoformat()
        rows = self.db.execute(
            "SELECT key, COUNT(DISTINCT post) posts, COUNT(*) exposures, COUNT(DISTINCT client) clients FROM sightings"
            " WHERE day >= ? GROUP BY key", (since,)).fetchall()
        items = []
        for r in rows:
            c = self.consensus(r["key"])
            if c["n_clients"] < min_clients or (status != "all" and c["status"] != status):
                continue
            prow = self.db.execute("SELECT * FROM propositions WHERE key=?", (r["key"],)).fetchone()
            prior = self.db.execute("SELECT COUNT(DISTINCT post) n FROM sightings WHERE key=? AND day >= ? AND day < ?",
                                    (r["key"], prev, since)).fetchone()["n"]
            item = self._prop(prow)
            item.pop("tokens")
            item["consensus"] = c
            item["window"] = {"days": days, **self.counts(r["key"], since), "reporters": r["clients"], "previous_posts": prior,
                              "growth": round((r["posts"] - prior) / max(1, prior), 2)}
            item["daily"] = self.daily(r["key"], days)
            item["subreddits"] = self.subreddits(r["key"], since)
            spread = [dict(p) for p in self.db.execute(
                "SELECT DISTINCT p.* FROM sightings s JOIN posts p ON p.post = s.post WHERE s.key=? AND s.day>=? AND s.stance='affirms'", (r["key"], since))]
            div = clustering.diversity(spread)
            item["window"]["engagement"] = {"score": sum(p["score"] or 0 for p in spread), "comments": sum(p["comments"] or 0 for p in spread),
                                            "crossposts": sum(p["crossposts"] or 0 for p in spread)}
            item["sources"] = {"independent_sources": div["independent_sources"], "diversity": div["score"],
                               "outlets": [{k: o[k] for k in ("outlet", "group", "tier", "posts", "kinds")} for o in div["outlets"][:10]]}
            items.append(item)
        keyf = {"posts": lambda x: x["window"]["posts"], "exposures": lambda x: x["window"]["exposures"],
                "engagement": lambda x: x["window"]["engagement"]["score"] + 2 * x["window"]["engagement"]["comments"],
                "sources": lambda x: (x["sources"]["diversity"], x["window"]["posts"]),
                "clients": lambda x: x["consensus"]["n_clients"], "trending": lambda x: (x["window"]["growth"], x["window"]["posts"])}[sort]
        return sorted(items, key=keyf, reverse=True)[:limit]

    def daily(self, key: str, days: int) -> list[dict]:
        start = datetime.now(timezone.utc).date() - timedelta(days=days - 1)
        rows = {r["day"]: r["n"] for r in self.db.execute(
            "SELECT day, COUNT(DISTINCT post) n FROM sightings WHERE key=? AND day >= ? GROUP BY day", (key, start.isoformat()))}
        return [{"day": (start + timedelta(days=i)).isoformat(), "posts": rows.get((start + timedelta(days=i)).isoformat(), 0)} for i in range(days)]

    def subreddits(self, key: str, since: str | None = None, limit: int = 8) -> list[dict]:
        rows = self.db.execute(
            "SELECT subreddit, COUNT(DISTINCT post) n FROM sightings WHERE key=? AND subreddit IS NOT NULL AND day >= ?"
            " GROUP BY subreddit ORDER BY n DESC LIMIT ?", (key, since or "0000", limit))
        return [{"subreddit": r["subreddit"], "posts": r["n"]} for r in rows]

    def proposition(self, key: str) -> dict | None:
        key = self.resolve(key)
        row = self.db.execute("SELECT * FROM propositions WHERE key=?", (key,)).fetchone()
        if not row:
            return None
        item = self._prop(row)
        item["consensus"] = self.consensus(key)
        item["counts"] = self.counts(key)
        item["daily"] = self.daily(key, 30)
        item["subreddits"] = self.subreddits(key)
        return item

    def stats(self) -> dict:
        q = lambda sql: self.db.execute(sql).fetchone()[0]  # noqa: E731
        return {
            "propositions": q("SELECT COUNT(*) FROM propositions"),
            "aliases": q("SELECT COUNT(*) FROM aliases"),
            "reporters": q("SELECT COUNT(DISTINCT client) FROM votes"),
            "posts": q("SELECT COUNT(DISTINCT post) FROM sightings"),
            "exposures": q("SELECT COUNT(*) FROM sightings"),
            "generated_at": int(time.time()),
        }
