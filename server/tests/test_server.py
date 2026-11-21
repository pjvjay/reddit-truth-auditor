"""Tests for the community API.   Run:  python -m pytest server/tests -q"""
import hashlib
import os
import sys
import uuid
from pathlib import Path

import pytest

from fastapi.testclient import TestClient  # noqa: E402

from rta_server import app as app_module  # noqa: E402
from rta_server.claimsig import canonicalize, similarity, tokenize  # noqa: E402

WHO = {"subject": "World Health Organization", "predicate": "states", "object": "5G towers spread the coronavirus", "topic": "health"}


def h(s):
    return hashlib.sha256(("rta1:" + s).encode()).hexdigest()[:32]


def client_id():
    return "c_" + uuid.uuid4().hex


def report(claim=WHO, truth=1.0, post="t3_a", **kw):
    r = {"claim": claim, "claim_truth": truth, "confidence": "high", "tone": "sincere", "researched": True,
         "verdict": "False: no such statement.", "sources": ["https://www.reuters.com/fact-check/x"], "model": "gpt-4o-mini",
         "post": h(post), "subreddit": "worldnews"}
    r.update(kw)
    return r


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("RTA_FEED_MIN_CLIENTS", "3")
    monkeypatch.delenv("RTA_PUBLISH_TOKENS", raising=False)
    return TestClient(app_module.create_app(str(tmp_path / "t.sqlite3")))


def send(api, cid, reports, **headers):
    return api.post("/v1/reports", json={"schema": "rta.report/1", "client": cid, "reports": reports}, headers=headers)


# ---------------------------------------------------------------- canonical form
def test_canonical_key_is_stable_across_wording():
    a = canonicalize(WHO)
    assert a.key.startswith("p1_") and a.stance == "affirms"
    assert canonicalize({**WHO, "object": "the coronavirus spread 5G tower"}).key == a.key          # order / plural / article
    assert canonicalize({**WHO, "subject": "world health ORGANIZATION!"}).key == a.key               # case / punctuation


def test_negation_is_folded_into_stance_not_key():
    a = canonicalize(WHO)
    b = canonicalize({**WHO, "predicate": "does not state"})
    c = canonicalize({**WHO, "polarity": "denies"})
    d = canonicalize({**WHO, "predicate": "does not state", "polarity": "denies"})   # double negative
    assert a.key == b.key == c.key == d.key
    assert (b.stance, c.stance, d.stance) == ("denies", "denies", "affirms")


def test_numbers_pooled_from_text_and_quantities():
    x = canonicalize({"subject": "Canada", "predicate": "sets", "object": "permanent resident admissions target",
                      "quantities": [{"value": 380000, "unit": "people"}], "time": "2026"})
    y = canonicalize({"subject": "Canada", "predicate": "set", "object": "permanent resident admissions target of 380,000", "time": "2026"})
    z = canonicalize({"subject": "Canada", "predicate": "set", "object": "permanent resident admissions target",
                      "quantities": [{"value": "385000"}], "time": "2026"})
    assert x.key == y.key != z.key


def test_similarity_guards():
    assert similarity(tokenize("inflation fell to 1% lowest level 50 years"), tokenize("inflation fell to 3% lowest level 50 years")) == 0
    assert similarity(["a1", "b", "c", "d"], ["a1", "b", "c", "d"]) == 1


# ---------------------------------------------------------------- ingest / feed
def test_feed_requires_independent_agreement(api):
    for i in range(2):
        assert send(api, client_id(), [report(post=f"t3_{i}")]).json()["accepted"] == 1
    assert api.get("/v1/propositions/feed").json()["items"] == []          # only 2 reporters
    send(api, client_id(), [report(post="t3_9")])
    items = api.get("/v1/propositions/feed").json()["items"]
    assert len(items) == 1
    it = items[0]
    assert it["key"] == canonicalize(WHO).key
    assert it["consensus"]["status"] == "false" and it["consensus"]["n_clients"] == 3
    assert it["counts"]["posts"] == 3 and it["counts"]["spreading"] == 3
    assert "5g" in it["tokens"] and it["consensus"]["sources"] == ["https://www.reuters.com/fact-check/x"]


def test_same_client_votes_once_but_every_post_counts(api):
    cid = client_id()
    send(api, cid, [report(post=f"t3_{i}") for i in range(5)])
    p = api.get(f"/v1/propositions/{canonicalize(WHO).key}").json()
    assert p["consensus"]["n_clients"] == 1 and p["counts"]["posts"] == 5


def test_debunking_posts_vote_on_the_proposition(api):
    # Two users audit posts that DENY the lie (truth 10 as stated) -> proposition truth 0 -> still a mistruth
    deny = {**WHO, "polarity": "denies"}
    for i in range(2):
        send(api, client_id(), [report(claim=deny, truth=10, post=f"t3_d{i}")])
    send(api, client_id(), [report(post="t3_s")])
    it = api.get("/v1/propositions/feed").json()["items"][0]
    assert it["consensus"]["prop_truth"] < 1          # two debunkers say 0/10, one spreader's audit says 1/10
    assert it["counts"]["spreading"] == 1 and it["counts"]["debunking"] == 2


def test_disputed_propositions_are_not_published(api):
    for i in range(3):
        send(api, client_id(), [report(post=f"t3_f{i}")])
    for i in range(3):
        send(api, client_id(), [report(truth=9, post=f"t3_t{i}")])
    assert api.get("/v1/propositions/feed").json()["items"] == []
    top = api.get("/v1/propositions/top?status=all").json()["items"]
    assert top[0]["consensus"]["status"] == "disputed"


def test_community_derived_results_never_vote(api):
    for i in range(2):
        send(api, client_id(), [report(post=f"t3_{i}")])
    send(api, client_id(), [report(post="t3_c", origin="community")])
    p = api.get(f"/v1/propositions/{canonicalize(WHO).key}").json()
    assert p["consensus"]["n_clients"] == 2 and p["counts"]["posts"] == 3      # counted as spread, not as a vote
    assert api.get("/v1/propositions/feed").json()["items"] == []


def test_jokes_not_meant_as_fact_are_ignored_but_satire_as_fact_is_kept(api):
    r = send(api, client_id(), [report(tone="satirical", presented_as_fact=False), report(tone="satirical", presented_as_fact=True, post="t3_x")]).json()
    assert r["accepted"] == 1 and r["rejected"][0]["reason"].startswith("joke")


def test_near_identical_canonical_wording_is_merged(api):
    a = {"subject": "Bill Gates", "predicate": "funds", "object": "microchip implants hidden in vaccines for population tracking", "topic": "health"}
    b = {**a, "object": "microchip implants hidden in vaccines for population tracking purposes"}
    assert canonicalize(a).key != canonicalize(b).key
    for i in range(2):
        send(api, client_id(), [report(claim=a, post=f"t3_a{i}")])
    keys = send(api, client_id(), [report(claim=b, post="t3_b")]).json()["keys"]
    assert keys == [canonicalize(a).key]
    it = api.get("/v1/propositions/feed").json()["items"][0]
    assert canonicalize(b).key in it["aliases"] and it["consensus"]["n_clients"] == 3


def test_link_hashes_need_independent_reporters(api):
    for i in range(3):
        send(api, client_id(), [report(post=f"t3_{i}", url_hash=h("fake-news.example/story"))])
    send(api, client_id(), [report(post="t3_z", url_hash=h("legit.example/one-off"))])
    it = api.get("/v1/propositions/feed").json()["items"][0]
    assert it["url_hashes"] == [h("fake-news.example/story")]


def test_top_metrics_and_dashboard(api):
    bees = {"subject": "United States Congress", "predicate": "approves", "object": "replacing national anthem with Nickelback song", "topic": "politics"}
    for i in range(4):
        send(api, client_id(), [report(post=f"t3_w{i}"), report(claim=bees, post=f"t3_b{i}", subreddit="politics", verdict="<script>x</script>")])
    send(api, client_id(), [report(claim=bees, post=f"t3_b{i}x", subreddit="politics") for i in range(6)])
    top = api.get("/v1/propositions/top?sort=posts").json()["items"]
    assert [t["claim"]["subject"] for t in top] == ["United States Congress", "World Health Organization"]
    assert top[0]["window"]["posts"] == 10 and top[0]["subreddits"][0]["subreddit"] == "politics"
    assert sum(d["posts"] for d in top[0]["daily"]) == 10
    page = api.get("/").text
    assert "Nickelback" in page and "<script>x" not in page and "&lt;script&gt;" in page
    assert api.get("/v1/stats").json()["reporters"] == 5


def test_validation_quota_and_token(api, tmp_path, monkeypatch):
    assert send(api, "not-a-client", [report()]).status_code == 422
    assert send(api, client_id(), [report(post="t3_raw_not_hashed") | {"post": "t3_raw"}]).status_code == 422
    assert send(api, client_id(), [report(claim={"subject": "x" * 500})]).status_code == 422
    monkeypatch.setenv("RTA_PUBLISH_TOKENS", "s3cret")
    monkeypatch.setenv("RTA_MAX_REPORTS_PER_DAY", "3")
    locked = TestClient(app_module.create_app(str(tmp_path / "locked.sqlite3")))
    assert send(locked, client_id(), [report()]).status_code == 401
    cid = client_id()
    r = send(locked, cid, [report(post=f"t3_{i}") for i in range(5)], **{"X-RTA-Token": "s3cret"}).json()
    assert r["accepted"] == 3 and len(r["rejected"]) == 2


def test_canonicalize_endpoint_matches_library(api):
    r = api.post("/v1/canonicalize", json={**WHO, "polarity": "denies"}).json()
    assert r["key"] == canonicalize(WHO).key and r["stance"] == "denies"
