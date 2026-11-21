"""Event clustering of propagating false claims.   Run:  python -m pytest server/tests -q"""
import hashlib
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from fastapi.testclient import TestClient  # noqa: E402

from rta_server import app as app_module  # noqa: E402
from rta_server.clustering import ClusterConfig  # noqa: E402
from rta_server.outlets import lookup_domain, lookup_name, registrable  # noqa: E402
from rta_server.store import Store  # noqa: E402

TODAY = datetime.now(timezone.utc).date()


def H(s):
    return hashlib.sha256(("rta1:" + s).encode()).hexdigest()[:32]


def C(subject, predicate, obj, **kw):
    return {"subject": subject, "predicate": predicate, "object": obj, "polarity": "affirms", **kw}


# --- two unrelated false narratives + one one-off claim
WHO = C("World Health Organization", "states", "5G towers spread the coronavirus")
RAD = C("5G radiation", "causes", "coronavirus symptoms")
BAN = C("United Kingdom government", "bans", "5G towers to stop coronavirus spread")
CONG = C("United States Congress", "approves", "replacing the national anthem with a Nickelback song")
PRES = C("President", "signs", "law making a Nickelback song the national anthem")
ODD = C("Bill Gates", "owns", "all farmland in Ohio")


class Feed:
    """Builds realistic report streams: several independent reporters, several posts, outlets & engagement."""

    def __init__(self, store):
        self.store = store
        self.n = 0

    def spread(self, claim, posts, reporters=3, truth=1.0, outlets=(), kinds=("news",), score=800, comments=150,
               crossposts=1, subreddit="worldnews", days_ago=1, polarity="affirms", attributed=None):
        """`posts` distinct posts; each reporter reports every post; outlet i (cycled) is the linked source."""
        claim = {**claim, "polarity": polarity}
        clients = ["c_" + uuid.uuid4().hex for _ in range(reporters)]
        for i in range(posts):
            self.n += 1
            dom = outlets[i % len(outlets)] if outlets else None
            r = {"claim": claim, "claim_truth": truth if polarity == "affirms" else 10 - truth, "confidence": "high",
                 "tone": "sincere", "researched": True, "verdict": "False.", "sources": [], "model": "m",
                 "post": H(f"t3_p{self.n}"), "subreddit": subreddit if isinstance(subreddit, str) else subreddit[i % len(subreddit)],
                 "url_hash": H(f"{dom}/article-{self.n}") if dom else None,
                 "source": {"domain": dom, "kind": kinds[i % len(kinds)]} if dom else None,
                 "attributed": {"outlet": attributed, "kind": "news"} if attributed else None,
                 "engagement": {"score": score, "comments": comments, "crossposts": crossposts, "subscribers": 2_000_000, "upvote_ratio": 0.8},
                 "post_day": (TODAY - timedelta(days=days_ago)).isoformat(), "day": (TODAY - timedelta(days=min(days_ago, 3))).isoformat()}
            for c in clients:
                self.store.ingest(c, [r])
        return self


@pytest.fixture()
def store(tmp_path):
    return Store(str(tmp_path / "c.sqlite3"))


def run(store, **kw):
    return store.clusters(ClusterConfig(**kw), force=True)


def by_keys(res):
    from rta_server.claimsig import canonicalize
    k = lambda c: canonicalize(c).key  # noqa: E731
    names = {k(WHO): "WHO", k(RAD): "RAD", k(BAN): "BAN", k(CONG): "CONG", k(PRES): "PRES", k(ODD): "ODD"}
    return [sorted(names.get(m["key"], m["key"]) for m in c["members"]) for c in res["clusters"]], names


# ------------------------------------------------------------------ outlets
def test_outlet_registry():
    assert registrable("edition.cnn.com") == "cnn.com" and registrable("www.bbc.co.uk") == "bbc.co.uk"
    assert lookup_domain("edition.cnn.com")["outlet"] == "CNN"
    assert lookup_domain("abcnews.go.com")["outlet"] == "ABC News (US)"
    assert lookup_domain("www.foxbusiness.com")["group"] == lookup_domain("foxnews.com")["group"] == "Fox Corporation"
    assert lookup_domain("wsj.com")["group"] == lookup_domain("nypost.com")["group"] == "News Corp"
    unknown = lookup_domain("blog.some-random-site.net")
    assert unknown["outlet"] == "some-random-site.net" and unknown["tier"] == 3
    assert lookup_name("Fox")["outlet"] == "Fox News" and lookup_name("the BBC")["outlet"] == "BBC"
    assert lookup_name("The Daily Planet") is None


# ------------------------------------------------------------------ clustering
def test_related_claims_form_event_clusters_and_one_offs_are_noise(store):
    f = Feed(store)
    f.spread(WHO, posts=4, outlets=["foxnews.com", "cnn.com"])
    f.spread(RAD, posts=3, outlets=["dailymail.co.uk"])
    f.spread(BAN, posts=2, outlets=["bbc.co.uk"])
    f.spread(CONG, posts=3, outlets=["nypost.com"])
    f.spread(PRES, posts=2, outlets=["breitbart.com"])
    f.spread(ODD, posts=1, reporters=1, score=3, comments=0, crossposts=0, outlets=[])
    res = run(store)
    groups, names = by_keys(res)
    assert sorted(groups) == [["BAN", "RAD", "WHO"], ["CONG", "PRES"]]
    assert [names[n["key"]] for n in res["noise"]] == ["ODD"]
    who = next(c for c in res["clusters"] if "5g" in c["top_terms"])
    assert who["metrics"]["spreading_posts"] == 9 and who["metrics"]["independent_sources"] == 4   # Fox, CNN, DMG, BBC
    assert abs(sum(m["share"] for m in who["members"]) - 1) < 1e-3


def test_independent_source_diversity_raises_weight_and_severity(store):
    # identical narratives (same posts, reporters, engagement) - one carried by CNN, Fox News and the BBC,
    # the other only by Fox-owned outlets (Fox News + Fox Business = one independent source)
    f = Feed(store)
    f.spread(WHO, posts=6, outlets=["cnn.com", "foxnews.com", "bbc.co.uk"])
    f.spread(CONG, posts=6, outlets=["foxnews.com", "foxbusiness.com"])
    res = run(store)
    who = next(c for c in res["clusters"] if "5g" in c["top_terms"])
    cong = next(c for c in res["clusters"] if "nickelback" in c["top_terms"])
    assert who["metrics"]["independent_sources"] == 3 and cong["metrics"]["independent_sources"] == 1
    assert who["mass"] > cong["mass"]
    assert who["severity"]["components"]["source_diversity"] > cong["severity"]["components"]["source_diversity"]
    assert who["severity"]["score"] > cong["severity"]["score"]
    assert res["clusters"][0]["id"] == who["id"]                        # ranked first
    # the bias is tunable: with diversity_bias=0 the two claims weigh the same
    flat = run(store, diversity_bias=0.0)
    masses = sorted(c["mass"] for c in flat["clusters"])
    assert abs(masses[0] - masses[1]) < 1e-6


def test_news_corp_titles_are_not_independent(store):
    f = Feed(store)
    f.spread(WHO, posts=3, outlets=["wsj.com", "nypost.com", "thesun.co.uk"])
    c = run(store)["clusters"][0]
    assert c["metrics"]["independent_sources"] == 1 and {o["outlet"] for o in c["metrics"]["outlets"]} == {"The Wall Street Journal", "New York Post", "The Sun"}


def test_popularity_determines_a_claims_weight_within_its_cluster(store):
    f = Feed(store)
    f.spread(WHO, posts=2, outlets=["cnn.com"], score=45_000, comments=9_000, crossposts=40)   # viral
    f.spread(RAD, posts=2, outlets=["cnn.com"], score=4, comments=1, crossposts=0)
    c = run(store)["clusters"][0]
    shares = {m["sentence"].split()[0]: m["share"] for m in c["members"]}
    assert shares["World"] > 0.6 > shares["5G"]
    assert c["most_pushed"] == c["members"][0]["key"] and c["members"][0]["sentence"].startswith("World Health")
    assert c["metrics"]["score"] == 2 * 45_000 + 2 * 4


def test_density_threshold_needs_real_propagation(store):
    f = Feed(store)
    f.spread(ODD, posts=1, score=5, comments=1, crossposts=0, outlets=[])
    assert run(store)["clusters"] == []                                        # one low-engagement post: noise
    f.spread(ODD, posts=12, outlets=["cnn.com", "foxnews.com", "bbc.co.uk", "reuters.com"], subreddit=["news", "politics", "farming"])
    res = run(store)
    assert len(res["clusters"]) == 1 and len(res["clusters"][0]["members"]) == 1  # a single heavily pushed lie is its own cluster
    assert res["clusters"][0]["metrics"]["subreddit_count"] == 4


def test_opinion_pieces_and_article_kinds(store):
    f = Feed(store)
    f.spread(WHO, posts=4, outlets=["foxnews.com"], kinds=("news", "opinion"))
    c1 = run(store)["clusters"][0]
    assert c1["metrics"]["article_kinds"] == {"news": 1, "opinion": 1}
    assert c1["metrics"]["outlets"][0]["kinds"] == ["news", "opinion"] and c1["metrics"]["source_articles"] == 4
    # ordering: news only < same outlet with news + opinion pieces < a second, independent outlet
    from rta_server.clustering import diversity
    post = lambda i, dom, grp, kind: {"outlet": dom, "outlet_group": grp, "tier": 1, "outlet_type": "news", "source_kind": kind, "url_hash": f"a{i}"}  # noqa: E731
    news_only = diversity([post(i, "Fox News", "Fox", "news") for i in range(4)])["score"]
    mixed = diversity([post(i, "Fox News", "Fox", ("news", "opinion")[i % 2]) for i in range(4)])["score"]
    two_outlets = diversity([post(i, ("Fox News", "CNN")[i % 2], ("Fox", "WBD")[i % 2], "news") for i in range(4)])["score"]
    assert news_only < mixed < two_outlets
    assert c1["severity"]["diversity_score"] == mixed


def test_attributed_outlet_used_when_post_has_no_link(store):
    f = Feed(store)
    f.spread(WHO, posts=3, outlets=[], attributed="Fox")
    c = run(store)["clusters"][0]
    assert c["metrics"]["outlets"][0]["outlet"] == "Fox News" and c["metrics"]["independent_sources"] == 1


def test_debunks_counted_but_do_not_add_propagation_weight(store):
    f = Feed(store)
    f.spread(WHO, posts=4, outlets=["cnn.com"])
    before = run(store)["clusters"][0]
    f.spread(WHO, posts=3, outlets=["reuters.com"], polarity="denies", truth=1.0)
    after = run(store)["clusters"][0]
    assert after["metrics"]["debunking_posts"] == 3 and after["metrics"]["spreading_posts"] == 4
    assert after["metrics"]["independent_sources"] == 1                          # Reuters debunked it, didn't spread it


def test_true_claims_are_not_clustered(store):
    f = Feed(store)
    f.spread(WHO, posts=5, truth=9.0, outlets=["cnn.com"])
    res = run(store)
    assert res["points"] == 0 and res["clusters"] == []


def test_cluster_ids_are_stable_as_narratives_grow(store):
    f = Feed(store)
    f.spread(WHO, posts=3, outlets=["cnn.com"]).spread(RAD, posts=3, outlets=["bbc.co.uk"])
    first = run(store)["clusters"][0]["id"]
    f.spread(BAN, posts=3, outlets=["foxnews.com"])
    second = run(store)["clusters"][0]
    assert second["id"] == first and len(second["members"]) == 3


def test_growth_and_velocity(store):
    f = Feed(store)
    f.spread(WHO, posts=2, days_ago=10, outlets=["cnn.com"])
    f.spread(WHO, posts=6, days_ago=1, outlets=["cnn.com"])
    c = run(store)["clusters"][0]
    assert c["metrics"]["recent_posts"] == 6 and c["metrics"]["previous_posts"] == 2 and c["metrics"]["growth"] == 2.0
    assert c["severity"]["components"]["velocity"] > 0.6


# ------------------------------------------------------------------ API
@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("RTA_FEED_MIN_CLIENTS", "3")
    monkeypatch.delenv("RTA_PUBLISH_TOKENS", raising=False)
    return TestClient(app_module.create_app(str(tmp_path / "api.sqlite3")))


def test_clusters_api_feed_annotation_dashboard_and_privacy(api):
    f = Feed(api.app.state.store)
    f.spread(WHO, posts=4, outlets=["cnn.com", "foxnews.com"])
    f.spread(RAD, posts=3, outlets=["bbc.co.uk"])
    f.spread(C("5G masts", "cause", "coronavirus outbreaks in cities"), posts=2, reporters=1, outlets=["rt.com"])  # rare variant
    body = api.get("/v1/clusters").json()
    assert body["schema"] == "rta.clusters/1" and len(body["items"]) == 1
    c = body["items"][0]
    assert c["published"] and c["label"] and c["severity"]["score"] > 0
    hidden = [m for m in c["members"] if m["sentence"] is None]
    assert len(hidden) == 1 and c["hidden_members"] == 1                          # 1-reporter variant counted, not named
    assert api.get(f"/v1/clusters/{c['id']}").json()["id"] == c["id"]
    assert api.get("/v1/clusters/c_nope").status_code == 404
    feed = api.get("/v1/propositions/feed").json()["items"]
    assert feed and all(it["cluster"]["id"] == c["id"] for it in feed)
    assert feed[0]["cluster"]["independent_sources"] == 4 and "CNN" in feed[0]["cluster"]["outlets"]
    top = api.get("/v1/propositions/top?sort=sources").json()["items"]
    assert top[0]["sources"]["independent_sources"] >= 1 and top[0]["window"]["engagement"]["score"] > 0
    page = api.get("/?days=7").text
    assert "Propagating false narratives" in page and "CNN" in page
    assert api.post("/v1/clusters/recompute").json()["clusters"] == 1


def test_report_validation_for_new_fields(api):
    base = {"claim": WHO, "claim_truth": 1, "post": H("t3_x")}
    ok = api.post("/v1/reports", json={"client": "c_" + uuid.uuid4().hex, "reports": [{**base, "source": {"domain": "edition.cnn.com", "kind": "opinion"},
                                                                                         "engagement": {"score": 10, "comments": 2}, "post_day": TODAY.isoformat()}]})
    assert ok.json()["accepted"] == 1
    for bad in ({"source": {"domain": "https://cnn.com/path", "kind": "news"}}, {"source": {"domain": "cnn.com", "kind": "rumour"}},
                {"engagement": {"score": "lots"}}, {"post_day": "yesterday"}):
        assert api.post("/v1/reports", json={"client": "c_" + uuid.uuid4().hex, "reports": [{**base, **bad}]}).status_code == 422
    row = api.app.state.store.db.execute("SELECT * FROM posts").fetchone()
    assert (row["outlet"], row["source_kind"], row["outlet_via"]) == ("CNN", "opinion", "link")
