"""Mock Reddit pages + canned LLM / Tavily answers for the userscript tests."""
import html
import json

POSTS = [
    dict(id="fake01", sub="worldnews", type="text",
         title="BREAKING: WHO confirms 5G towers spread the virus and orders a global shutdown of mobile networks",
         body="Sources inside the WHO say the announcement is coming tomorrow. Share this before it gets deleted!",
         verifiable=True, ctype="news",
         claim="The WHO confirmed that 5G towers spread the virus and ordered a global shutdown of mobile networks.",
         truth=1, sarcasm=1, conf="high",
         fact="The WHO has published no such statement [1]. Radio waves cannot carry or spread viruses [2].",
         context="A recycled 2020 conspiracy theory presented as breaking news.",
         verdict="False: the WHO never said this, and 5G cannot spread viruses."),
    dict(id="hike02", sub="hiking", type="text",
         title="What's your favourite beginner trail near Vancouver?",
         body="Moving there next month and would love some suggestions!", verifiable=False, ctype="question"),
    dict(id="true03", sub="canada", type="link", url="https://www.canada.ca/en/immigration-refugees-citizenship/news.html",
         title="Canada sets its 2026 permanent resident admissions target at 380,000",
         body="", verifiable=True, ctype="politics",
         claim="Canada's 2026 permanent resident admissions target is 380,000.",
         truth=9, sarcasm=0, conf="high",
         fact="The 2026-2028 Immigration Levels Plan lists 380,000 PR admissions for 2026 [1].",
         context="Target, not actual admissions.", verdict="Accurate: matches the published levels plan."),
    dict(id="onion04", sub="TheOnion", type="link", url="https://www.theonion.com/area-man",
         title="Area man heroically finishes entire to-do list, scientists baffled",
         body="", verifiable=True, ctype="meme/satire",
         claim="Scientists are baffled that a man finished his entire to-do list.",
         truth=1, sarcasm=9.5, conf="high", fact="This is an Onion satire headline.", context="Satire outlet.",
         verdict="Satire, not a factual claim."),
    dict(id="mixed05", sub="economy", type="text",
         title="Inflation just fell to 1%, the lowest level in 50 years",
         body="Saw this on the news this morning.", verifiable=True, ctype="finance",
         claim="Inflation fell to 1%, the lowest level in 50 years.", truth=5, sarcasm=1, conf="low",
         fact="Could not confirm the figure for the most recent month.", context="No country or source given.",
         verdict="Unverified: the figure may be right for one country but the 50-year claim is doubtful."),
    dict(id="xss06", sub="conspiracy", type="text",
         title='<img src=x onerror="window.__xss=1">Moon landing was filmed in a studio <b>PROOF</b>',
         body='<script>window.__xss3=1</script> look at the shadows', verifiable=True, ctype="other",
         claim='The <i>Apollo</i> moon landing was filmed in a studio.', truth=0.5, sarcasm=1, conf="high",
         fact='<img src=x onerror="window.__xss2=1"> Retroreflectors left on the Moon are still used today [1].',
         context="Long-debunked conspiracy.", verdict="False: the Apollo landings are extensively documented."),
]
FILLER = [
    ("history", "The Eiffel Tower was completed in 1889 for the World's Fair"),
    ("space", "The James Webb Space Telescope launched on 25 December 2021"),
    ("science", "Water boils at 100 degrees Celsius at sea level"),
    ("todayilearned", "TIL octopuses have three hearts"),
    ("geography", "Mount Everest is the highest mountain above sea level"),
    ("sports", "The 2024 Summer Olympics were held in Paris"),
    ("technology", "The first iPhone was released in 2007"),
    ("books", "George Orwell published Nineteen Eighty-Four in 1949"),
]
for i, (sub, title) in enumerate(FILLER, start=7):
    POSTS.append(dict(id=f"fill{i:02d}", sub=sub, type="text", title=title, body="Just a fun fact.",
                      verifiable=True, ctype="other", claim=title + ".", truth=10, sarcasm=0, conf="high",
                      fact="Well documented.", context="", verdict="Accurate."))

# move the XSS post to the end so it is only reached by an explicit scroll
POSTS.append(POSTS.pop(next(i for i, p in enumerate(POSTS) if p["id"] == "xss06")))

_F = {p["id"]: p for p in POSTS}
_fake = _F["fake01"]
# Reposts / near-duplicates served on /r/dupes and /r/twins (not on the front page)
DUPES = [
    # near-identical text (punctuation / "&" / "a") -> reused before any API call
    dict(_fake, id="fake01b", sub="news",
         title="BREAKING: WHO confirms 5G towers spread the virus & orders a global shutdown of mobile networks!!!"),
    # same article link (tracking params, no www, trailing slash) + reworded title -> reused
    dict(_F["true03"], id="true03b", sub="immigration",
         url="https://canada.ca/en/immigration-refugees-citizenship/news.html/?utm_source=reddit&utm_medium=social",
         title="Canada's 2026 PR admissions target set at 380,000"),
    # crosspost with an unrelated title -> reused via crosspost_parent from /by_id
    dict(_fake, id="fake01x", sub="conspiracy", title="Crazy if true", body="", crosspost="t3_fake01"),
    # paraphrase -> extraction model says same_as -> research + audit skipped
    dict(_fake, id="fake01p", sub="skeptic", body="",
         title="The World Health Organization now says 5G masts are what spread the virus",
         claim="The World Health Organization says 5G masts spread the virus.", same_as_of="fake01"),
    # different wording, identical extracted claim -> lexical claim match
    dict(_fake, id="fake01c", sub="askreddit", body="",
         title="Apparently the WHO is shutting down mobile networks worldwide because 5G spreads the virus"),
    # same sentence but a different number -> must NOT be reused
    dict(_F["mixed05"], id="mixed05n", title="Inflation just fell to 3%, the lowest level in 50 years",
         claim="Inflation fell to 3%, the lowest level in 50 years.", truth=3,
         verdict="Misleading: no major economy reported 3% as a 50-year low."),
]
TWINS = [
    dict(id="twina", sub="space", type="text", title="Scientists discover liquid water in a huge underground lake on Mars",
         body="Big if true.", verifiable=True, ctype="science/health",
         claim="Scientists discovered liquid water in a huge underground lake on Mars.", truth=6, sarcasm=0, conf="medium",
         fact="Radar studies suggest it but it is unconfirmed.", context="", verdict="Partly supported."),
]
TWINS.append(dict(TWINS[0], id="twinb", sub="science", title=TWINS[0]["title"] + "!"))
ALL = POSTS + DUPES + TWINS
BY_ID = {f"t3_{p['id']}": p for p in ALL}


def permalink(p):
    return f"/r/{p['sub']}/comments/{p['id']}/post/"


def by_id_json(ids):
    children = []
    for i in ids:
        p = BY_ID.get(i)
        if not p:
            continue
        children.append({"kind": "t3", "data": {
            "name": i, "id": p["id"], "title": p["title"], "selftext": p["body"], "subreddit": p["sub"],
            "link_flair_text": None, "is_self": p["type"] == "text",
            "url": p.get("url") or f"https://www.reddit.com{permalink(p)}",
            "domain": f"self.{p['sub']}" if p["type"] == "text" else "example.com",
            "permalink": permalink(p), "author": "someone",
            **({"crosspost_parent": p["crosspost"]} if p.get("crosspost") else {}),
        }})
    return json.dumps({"kind": "Listing", "data": {"children": children}})


def shreddit_page(posts=None):
    e = html.escape
    arts = []
    for p in (posts or POSTS):
        media = '<div class="media"></div>' if p["type"] == "link" else ""
        body = f'<div slot="text-body"><div id="t3_{p["id"]}-post-rtjson-content" class="md">{e(p["body"])}</div></div>' if p["body"] else ""
        arts.append(f'''<article aria-label="{e(p["title"])}">
<shreddit-post id="t3_{p["id"]}" permalink="{permalink(p)}" post-title="{e(p["title"])}" subreddit-prefixed-name="r/{p["sub"]}"
  post-type="{p["type"]}" domain="{"self." + p["sub"] if p["type"] == "text" else "example.com"}" author="someone"
  content-href="{e(p.get("url") or "https://www.reddit.com" + permalink(p))}">
  <div class="credit"><span class="sub">r/{p["sub"]}</span> • 3 hr. ago <span class="join">Join</span><span class="dots">···</span></div>
  <a slot="title" href="{permalink(p)}" class="title">{e(p["title"])}</a>
  {body}{media}
  <div class="actions"><span>▲ 1.2k ▼</span><span>💬 348</span><span>🏆</span><span>↗ Share</span></div>
</shreddit-post></article><hr>''')
        if p["id"] == "true03":  # an ad and a promoted post - both must be ignored
            arts.append('<shreddit-ad-post post-title="Buy stuff"><div class="title">Sponsored: Buy stuff</div></shreddit-ad-post><hr>')
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>reddit mock (shreddit)</title><style>
body{{margin:0;background:#0e1113;color:#d7dadc;font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}}
header{{position:sticky;top:0;z-index:3;height:56px;display:flex;align-items:center;padding:0 20px;background:#0e1113;border-bottom:1px solid #343536;font-weight:800;color:#ff4500;font-size:20px}}
.layout{{display:flex;gap:24px;max-width:1120px;margin:0 auto;padding:12px 20px}}
main{{flex:1;max-width:760px}} aside.side{{width:310px;height:400px;background:#1a1a1b;border-radius:16px;position:sticky;top:72px}}
shreddit-post{{display:block;padding:8px 16px 10px;border-radius:16px}} shreddit-post:hover{{background:#131f23}}
.credit{{font-size:12px;color:#818384;display:flex;gap:6px}} .join{{margin-left:auto;background:#0045ac;color:#fff;border-radius:999px;padding:2px 10px}}
.title{{display:block;font-size:18px;font-weight:600;color:#d7dadc;text-decoration:none;margin:6px 0}}
.md{{color:#b8c5c9}} .media{{height:260px;margin-top:8px;border-radius:16px;background:linear-gradient(135deg,#243b55,#141e30)}}
.actions{{display:flex;gap:8px;margin-top:10px}} .actions span{{background:#272729;border-radius:999px;padding:7px 12px;font-size:12px;font-weight:600}}
hr{{border:0;border-bottom:1px solid #343536;margin:4px 0}}
</style></head><body><header>reddit</header><div class="layout"><main><shreddit-feed>{"".join(arts)}
<article><shreddit-post id="t3_promo99" promoted permalink="/r/ads/comments/promo99/x/" post-title="Promoted: amazing pills cure everything" subreddit-prefixed-name="r/ads" post-type="text"><a slot="title" class="title">Promoted: amazing pills cure everything</a></shreddit-post></article>
<div style="height:1200px"></div></shreddit-feed></main><aside class="side"></aside></div></body></html>'''


def old_reddit_page():
    e = html.escape
    things = []
    for p in POSTS[:6]:
        dom = f"self.{p['sub']}" if p["type"] == "text" else "example.com"
        things.append(f'''<div class="thing link" id="thing_t3_{p["id"]}" data-fullname="t3_{p["id"]}" data-subreddit="{p["sub"]}"
  data-permalink="{permalink(p)}" data-domain="{dom}" data-url="{e(p.get("url") or permalink(p))}" data-author="someone">
  <div class="midcol">▲<br>1.2k<br>▼</div><div class="entry"><div class="top-matter">
   <p class="title"><a class="title" href="{permalink(p)}">{e(p["title"])}</a> <span class="domain">({dom})</span></p>
   <p class="tagline">submitted 3 hours ago by someone to r/{p["sub"]}</p>
   <ul class="flat-list buttons"><li><a>348 comments</a></li><li><a>share</a></li><li><a>save</a></li><li><a>hide</a></li><li><a>report</a></li></ul>
  </div></div></div><div class="clearleft"></div>''')
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>reddit mock (old)</title><style>
body{{margin:0;font:small verdana,arial,helvetica,sans-serif;background:#fff;color:#222}}
#header{{height:60px;background:#cee3f8;border-bottom:1px solid #5f99cf}}
#siteTable{{padding:10px 320px 10px 10px}} .thing{{display:flex;gap:8px;margin-bottom:40px;padding:4px}}
.midcol{{width:40px;text-align:center;color:#888;font-weight:bold}} a.title{{color:#0000ff;font-size:16px;text-decoration:none}}
.tagline{{color:#888;font-size:x-small;margin:2px 0}} .domain{{color:#888;font-size:x-small}}
ul.flat-list{{list-style:none;padding:0;margin:0}} ul.flat-list li{{display:inline-block;padding-right:4px}}
ul.flat-list a{{color:#888;font-weight:bold;font-size:x-small}}
</style></head><body><div id="header"></div><div id="siteTable">{"".join(things)}</div><div style="height:1500px"></div></body></html>'''


def _find(pred):
    for p in ALL:
        if pred(p):
            return p
    return None


def llm_reply(body):
    """Return (content_dict, usage) for a /chat/completions request body."""
    msgs = body.get("messages", [])
    user = msgs[-1]["content"] if msgs else ""
    if "Identify the main factual claim" in user:
        p = _find(lambda p: f"Title: {p['title']}\n" in user)
        if not p:
            return {"is_verifiable": False, "content_type": "other", "summary": "unknown", "claim": "", "query": ""}
        if not p["verifiable"]:
            return {"is_verifiable": False, "content_type": p["ctype"], "summary": "A user asks for hiking suggestions.", "claim": "", "query": ""}
        out = {"is_verifiable": True, "content_type": p["ctype"], "summary": p["title"], "claim": p["claim"], "query": "verify: " + p["claim"][:60]}
        if "Previously fact-checked claims" in user:
            out["same_as"] = None
            if p.get("same_as_of"):
                import re
                target = next(q for q in ALL if q["id"] == p["same_as_of"])["claim"]
                for label, text in re.findall(r"\[(C\d+)\] (.*)", user):
                    if text.strip() == target:
                        out["same_as"] = label
        return out
    if "Audit this claim" in user:
        p = _find(lambda p: p.get("claim") and f"Claim: {p['claim']}\n" in user)
        if not p:
            return {"truth_score": 5, "sarcasm_score": 0, "confidence": "low", "factual_check": "?", "context_check": "", "verdict": "Unknown."}
        return {"truth_score": p["truth"], "sarcasm_score": p["sarcasm"], "confidence": p["conf"],
                "factual_check": p["fact"], "context_check": p["context"], "verdict": p["verdict"]}
    return {"ok": True}


def tavily_reply(body):
    q = body.get("query", "")
    return {"query": q, "answer": "Reputable sources address this claim directly.", "results": [
        {"title": "Fact-check: " + q[:50], "url": "https://www.reuters.com/fact-check/example", "content": "Reuters fact check content about the claim.", "score": 0.9},
        {"title": "Official statement", "url": "https://www.who.int/news", "content": "Official statement content.", "score": 0.8},
        {"title": "bad scheme", "url": "javascript:alert(1)", "content": "should be dropped", "score": 0.1},
    ]}
