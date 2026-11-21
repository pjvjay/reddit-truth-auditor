"""
End-to-end tests for reddit-truth-auditor.user.js.

Runs the real userscript in headless Chromium against mock Reddit pages, with
Tampermonkey's GM_* API shimmed and OpenAI / Tavily / reddit.com intercepted.
No network access or API keys needed.

    pip install playwright && playwright install chromium
    python userscript/tests/test_userscript.py            # screenshots -> userscript/tests/screenshots/
"""
import json
import os
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import fixtures as fx  # noqa: E402

HERE = Path(__file__).parent
SCRIPT = (HERE.parent / "reddit-truth-auditor.user.js").read_text(encoding="utf-8")
SHOTS = Path(os.environ.get("RTA_SHOTS", HERE / "screenshots"))
SHOTS.mkdir(parents=True, exist_ok=True)

GM_SHIM = r"""
(() => {
  const KEY = '__gm_store__';
  const store = JSON.parse(localStorage.getItem(KEY) || 'null') || (window.__GM_INIT || {});
  const persist = () => localStorage.setItem(KEY, JSON.stringify(store));
  persist();
  const clone = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
  window.GM_getValue = (k, d) => (k in store ? clone(store[k]) : d);
  window.GM_setValue = (k, v) => { store[k] = clone(v); persist(); };
  window.GM_deleteValue = (k) => { delete store[k]; persist(); };
  window.GM_listValues = () => Object.keys(store);
  window.GM_info = { script: { version: '1.0.0-test' } };
  window.GM_registerMenuCommand = () => {};
  window.GM_addStyle = (css) => { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); return s; };
  window.GM_xmlhttpRequest = (o) => {
    const delay = window.__MOCK_DELAY ?? 500;
    setTimeout(() => {
      fetch(o.url, { method: o.method, headers: o.headers, body: o.data })
        .then(async (r) => o.onload({ status: r.status, responseText: await r.text() }))
        .catch((e) => o.onerror && o.onerror(e));
    }, delay);
  };
})();
"""

CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}


class Harness:
    def __init__(self, browser, settings=None, delay=500, width=1440, height=900, page_kind="shreddit",
                 openai_status=200, ctx=None, by_id_status=200, store=None):
        self.calls = {"openai": [], "tavily": [], "by_id": []}
        self.by_id_status = by_id_status
        self.openai_status = openai_status
        self.ctx = ctx or browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True)
        self.page = self.ctx.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("console", lambda m: m.type == "error" and self.errors.append("console: " + m.text))
        self.errors = []
        init = dict(store or {})
        if settings is not None:
            init["rta.settings"] = settings
        self.page.add_init_script(f"window.__GM_INIT = {json.dumps(init)}; window.__MOCK_DELAY = {delay};")
        self.page.add_init_script("window.__RTA_TEST_HOOKS__ = true;")
        self.page.add_init_script(GM_SHIM)
        self.page.add_init_script(SCRIPT)
        self.page.route("https://www.reddit.com/**", self._reddit)
        self.page.route("https://old.reddit.com/**", self._reddit)
        self.page.route("https://api.openai.com/**", self._openai)
        self.page.route("https://api.tavily.com/**", self._tavily)
        self.page_kind = page_kind

    def _reddit(self, route):
        u = urlparse(route.request.url)
        if "/by_id/" in u.path:
            ids = u.path.split("/by_id/")[1].replace(".json", "").split(",")
            self.calls["by_id"].append(ids)
            if self.by_id_status != 200:
                return route.fulfill(status=self.by_id_status, body="Too Many Requests")
            return route.fulfill(status=200, content_type="application/json", body=fx.by_id_json(ids))
        if u.netloc.startswith("old."):
            body = fx.old_reddit_page()
        elif u.path.startswith("/r/dupes"):
            body = fx.shreddit_page(fx.DUPES)
        elif u.path.startswith("/r/twins"):
            body = fx.shreddit_page(fx.TWINS)
        else:
            body = fx.shreddit_page()
        route.fulfill(status=200, content_type="text/html; charset=utf-8", body=body)

    def _openai(self, route):
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        body = json.loads(route.request.post_data or "{}")
        self.calls["openai"].append({"headers": route.request.headers, "body": body})
        if self.openai_status != 200:
            return route.fulfill(status=self.openai_status, headers=CORS, content_type="application/json",
                                 body=json.dumps({"error": {"message": "Incorrect API key provided: sk-bad."}}))
        content = fx.llm_reply(body)
        resp = {"choices": [{"message": {"content": json.dumps(content)}}], "usage": {"prompt_tokens": 900, "completion_tokens": 150}}
        route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps(resp))

    def _tavily(self, route):
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        body = json.loads(route.request.post_data or "{}")
        self.calls["tavily"].append({"headers": route.request.headers, "body": body})
        route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps(fx.tavily_reply(body)))

    def goto(self, old=False, path="/"):
        self.page.goto("https://old.reddit.com/" if old else "https://www.reddit.com" + path)
        self.page.wait_for_selector("#reddit-truth-auditor", state="attached")

    # --- helpers -------------------------------------------------------------
    def panel_open(self):
        return self.page.locator(".panel.open").count() == 1

    def card(self, pid):
        return self.page.locator(f'.card[data-id="t3_{pid}"]')

    def card_classes(self, pid):
        return self.card(pid).get_attribute("class") or ""

    def wait_card_state(self, pid, state, timeout=15000):
        self.page.wait_for_selector(f'.card.{state}[data-id="t3_{pid}"]', state="attached", timeout=timeout)

    def pill_text(self, pid):
        return self.page.evaluate(f"""(() => {{
            const el = document.getElementById('t3_{pid}') || document.querySelector('[data-fullname="t3_{pid}"]');
            if (!el) return null;
            const next = el.nextElementSibling;
            const pill = (next && next.classList.contains('rta-slot') ? next : el).querySelector('.rta-pill');
            return pill ? pill.textContent : null; }})()""")

    def scroll_to(self, pid):
        self.page.evaluate(f"(document.getElementById('t3_{pid}') || document.querySelector('[data-fullname=\"t3_{pid}\"]')).scrollIntoView({{block:'center'}})")

    def calls_mentioning(self, text):
        return [c for c in self.calls["openai"] if text in c["body"]["messages"][-1]["content"]]

    def result(self, pid):
        return self.page.evaluate(f"window.__RTA_TEST__.Log.get('t3_{pid}')")

    def shot(self, name):
        self.page.wait_for_timeout(700)  # let the slide animation settle
        self.page.screenshot(path=str(SHOTS / f"{name}.png"))

    def close(self):
        self.ctx.close()


BASE = {"apiKey": "sk-test-1234", "tavilyKey": "tvly-test-9876", "dwellMs": 300, "riskThreshold": 60, "autoOpen": "risky"}

results = []


def test(fn):
    results.append(fn)
    return fn


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# -----------------------------------------------------------------------------
@test
def first_run_opens_settings(browser):
    h = Harness(browser, settings=None)
    h.goto()
    h.page.wait_for_selector(".panel.open", timeout=5000)
    h.page.wait_for_selector(".views.settings", timeout=5000)
    check("needs-setup" in h.page.locator(".launcher").get_attribute("class"), "launcher should show setup dot")
    h.page.wait_for_timeout(2000)
    check(len(h.calls["openai"]) == 0, "no API calls without a key")
    check(h.page.locator(".card").count() == 0, "no jobs without key")
    h.shot("01-first-run-settings")
    # enter key through the UI -> posts already on screen get checked without scrolling
    h.page.locator('input[type="password"]').first.fill("sk-from-ui-0001")
    h.page.locator(".btn.primary", has_text="Save").click()
    h.page.wait_for_selector('.card[data-id="t3_fake01"]', timeout=8000)
    stored = h.page.evaluate("GM_getValue('rta.settings', {})")
    check(stored["apiKey"] == "sk-from-ui-0001", "key saved")
    check(h.page.locator('input[type="password"]').first.input_value() == "", "key must never be rendered back into the DOM")
    h.page.wait_for_function("() => true")
    h.page.wait_for_timeout(2500)
    check(h.calls["openai"][0]["headers"]["authorization"] == "Bearer sk-from-ui-0001", "auth header uses saved key")
    check(not h.errors, f"page errors: {h.errors}")
    h.close()


@test
def main_flow_flags_risky_posts(browser):
    h = Harness(browser, settings=BASE, delay=600)
    h.goto()
    check(not h.panel_open(), "panel starts closed")
    # fake01 and hike02 are visible at load
    h.wait_card_state("fake01", "running", timeout=6000)
    check(not h.panel_open(), "panel must stay closed while researching in 'risky' mode")
    check("Fact-checking" in (h.pill_text("fake01") or ""), f"pill shows spinner text: {h.pill_text('fake01')}")
    check("busy" in h.page.locator(".launcher").get_attribute("class"), "launcher ring spins while busy")
    h.page.screenshot(path=str(SHOTS / "02-researching-pills.png"))

    h.wait_card_state("fake01", "done")
    h.page.wait_for_selector(".panel.open", timeout=3000)
    check("flagged" in h.card_classes("fake01"), "fake01 flagged")
    check("Likely false" in h.pill_text("fake01") and "90% risk" in h.pill_text("fake01"), f"pill: {h.pill_text('fake01')}")
    check(h.page.evaluate("document.getElementById('t3_fake01').getAttribute('data-rta-flagged')") == "1", "post element marked")
    h.wait_card_state("hike02", "skipped")
    check(h.pill_text("hike02") is None, "no badge on non-claim posts")
    # panel width = 25% of viewport
    w = h.page.evaluate("document.querySelector('#reddit-truth-auditor').shadowRoot.querySelector('.panel').getBoundingClientRect().width")
    check(abs(w - 1440 * 0.25) < 1, f"panel width {w} should be 25% of 1440")
    # details + sources (javascript: URL from search results must be dropped)
    h.card("fake01").locator("summary").click()
    links = h.card("fake01").locator(".d-sec a").evaluate_all("els => els.map(e => e.href)")
    check(links == ["https://www.reuters.com/fact-check/example", "https://www.who.int/news"], f"sources {links}")
    h.shot("03-flagged-panel-open")

    # request shape
    oa = h.calls["openai"][0]
    check(oa["headers"]["authorization"] == "Bearer sk-test-1234", "openai auth")
    check(oa["body"]["model"] == "gpt-4o-mini" and oa["body"]["response_format"] == {"type": "json_object"}, "openai body")
    check(h.calls["tavily"] and h.calls["tavily"][0]["headers"]["authorization"] == "Bearer tvly-test-9876", "tavily auth")
    check(any("t3_fake01" in b for b in h.calls["by_id"]), "post text fetched via /by_id")
    audit_prompt = [c for c in h.calls["openai"] if "Audit this claim" in c["body"]["messages"][-1]["content"]][0]["body"]["messages"][-1]["content"]
    check("<research>" in audit_prompt and "reuters.com" in audit_prompt, "research evidence passed to audit")

    # close, scroll on: satire + true + mixed should NOT reopen the panel
    h.page.locator('.btn-icon[aria-label="Close panel"]').click()
    h.page.wait_for_timeout(800)
    for pid in ["true03", "onion04", "mixed05"]:
        h.scroll_to(pid)
        h.page.wait_for_timeout(500)
    for pid in ["true03", "onion04", "mixed05"]:
        h.wait_card_state(pid, "done", timeout=15000)
    check(not h.panel_open(), "non-risky posts must not open the panel")
    check("flagged" not in h.card_classes("onion04"), "satire not flagged")
    check(h.pill_text("onion04") == "Likely satire", f"satire pill {h.pill_text('onion04')}")
    check("flagged" not in h.card_classes("mixed05"), "risk 50 < 60 threshold")
    check("Looks accurate" in h.pill_text("true03"), f"true03 pill {h.pill_text('true03')}")
    check(h.page.locator('.card[data-id="t3_promo99"]').count() == 0, "promoted post ignored")
    h.page.locator(".launcher").click()
    h.page.wait_for_selector(".panel.open")
    h.shot("04-live-feed-mixed-results")

    # xss post -> flagged -> reopens the panel; nothing executes
    h.page.locator('.btn-icon[aria-label="Close panel"]').click()
    h.page.wait_for_timeout(700)
    h.scroll_to("xss06")
    h.wait_card_state("xss06", "done")
    h.page.wait_for_selector(".panel.open", timeout=3000)
    h.card("xss06").locator("summary").click()
    h.page.wait_for_timeout(300)
    check(h.page.evaluate("!window.__xss && !window.__xss2 && !window.__xss3"), "no script execution from titles / model output")
    check("<img" in h.card("xss06").locator(".t").text_content(), "title rendered as text")
    check(h.page.locator(".card img").count() == 0, "no injected elements in cards")
    check(h.page.locator(".tab.flag .n").text_content() == "2", "flagged count 2")
    h.page.locator(".tab.flag").click()
    h.shot("05-flagged-tab")
    visible = h.page.locator(".card:visible").count()
    check(visible == 2, f"flagged tab shows only flagged cards ({visible})")

    # footer cost tracking: each llm call 900 in + 150 out tokens at gpt-4o-mini prices
    n = len(h.calls["openai"])
    usage = h.page.evaluate("GM_getValue('rta.usage')")
    expected = n * (900 * 0.15 + 150 * 0.60) / 1e6
    check(abs(usage["usd"] - expected) < 1e-9, f"usage {usage} vs {expected}")
    check(usage["searches"] == len(h.calls["tavily"]), "search count")

    # 'Show post' scrolls Reddit to the post
    h.page.evaluate("window.scrollTo(0, 0)")
    h.card("xss06").locator(".btn", has_text="Show post").click()
    h.page.wait_for_timeout(1200)
    top = h.page.evaluate("document.getElementById('t3_xss06').getBoundingClientRect().top")
    check(0 < top < 900, f"post scrolled into view ({top})")
    check(not h.errors, f"page errors: {h.errors}")
    h.close()


@test
def threshold_is_configurable_via_settings(browser):
    h = Harness(browser, settings=dict(BASE, dwellMs=100), delay=100)
    h.goto()
    for pid in ["fake01", "true03", "onion04", "mixed05"]:
        h.scroll_to(pid)
        h.page.wait_for_timeout(300)
        h.wait_card_state(pid, "done") if pid != "hike02" else None
    check(h.page.locator(".tab.flag .n").text_content() == "1", "only fake01 flagged at 60")

    def set_threshold(v):
        h.page.locator(".launcher").click() if not h.panel_open() else None
        h.page.locator('.btn-icon[aria-label="Settings"]').click()
        h.page.wait_for_selector(".views.settings")
        h.page.locator('input[aria-label="Risk threshold"]').evaluate(f"(el) => {{ el.value = {v}; el.dispatchEvent(new Event('input')); }}")
        h.page.locator(".btn.primary", has_text="Save").click()
        h.page.wait_for_timeout(1200)

    set_threshold(50)
    check(h.page.evaluate("GM_getValue('rta.settings').riskThreshold") == 50, "threshold saved")
    check("flagged" in h.card_classes("mixed05"), "mixed05 (risk 50) flagged at threshold 50")
    check(h.page.locator(".tab.flag .n").text_content() == "2", "2 flagged at 50")
    calls_before = len(h.calls["openai"])
    set_threshold(95)
    check("flagged" not in h.card_classes("fake01"), "fake01 (risk 90) not flagged at 95")
    check(h.page.locator(".tab.flag .n").text_content() == "0", "0 flagged at 95")
    check(len(h.calls["openai"]) == calls_before, "re-evaluating the threshold must not call the API again")
    # satire toggle off -> onion (risk 90) flagged at threshold 60
    h.page.locator('.btn-icon[aria-label="Settings"]').click()
    h.page.wait_for_selector(".views.settings")
    h.page.locator('input[aria-label="Risk threshold"]').evaluate("(el) => { el.value = 60; el.dispatchEvent(new Event('input')); }")
    h.page.locator(".check", has_text="satire").locator("input").uncheck()
    h.shot("06-settings")
    h.page.locator(".btn.primary", has_text="Save").click()
    h.page.wait_for_timeout(1200)
    check("flagged" in h.card_classes("onion04"), "satire flagged when ignoreSatire off")
    check(not h.errors, f"page errors: {h.errors}")
    h.close()


@test
def cache_survives_reload_and_reflags(browser):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    h = Harness(browser, settings=BASE, delay=100, ctx=ctx)

    def fake01_calls():
        return sum(1 for c in h.calls["openai"] if "5G towers" in c["body"]["messages"][-1]["content"])

    h.goto()
    h.wait_card_state("fake01", "done")
    h.page.wait_for_timeout(1000)  # debounce-save of the cache
    check(fake01_calls() == 2, "extract + audit on first view")
    h.page.reload()
    h.page.wait_for_selector("#reddit-truth-auditor", state="attached")
    h.wait_card_state("fake01", "done", timeout=5000)
    h.page.wait_for_selector(".panel.open", timeout=3000)
    check(fake01_calls() == 2, "cached result reused after reload, no new API calls")
    check("from research log" in h.card("fake01").locator(".d-sec").last.text_content(), "marked as coming from the log")
    # Re-check forces a new analysis
    h.card("fake01").locator(".btn", has_text="Re-check").click()
    h.wait_card_state("fake01", "done", timeout=8000)
    h.page.wait_for_timeout(300)
    check(fake01_calls() == 4, f"re-check ran extract + audit again ({fake01_calls()})")
    check(not h.errors, f"page errors: {h.errors}")
    h.close()


@test
def always_mode_shows_spinners(browser):
    h = Harness(browser, settings=dict(BASE, autoOpen="always"), delay=2500)
    h.goto()
    h.page.wait_for_selector(".panel.open", timeout=5000)
    h.page.wait_for_selector(".card.running .spin", timeout=5000)
    h.page.wait_for_timeout(2900)  # into the research stage
    h.page.screenshot(path=str(SHOTS / "07-always-mode-spinners.png"))
    check(h.page.locator(".card.running .step.active").count() >= 1, "active step shown")
    h.close()


@test
def never_mode_nudges_launcher_only(browser):
    h = Harness(browser, settings=dict(BASE, autoOpen="never"), delay=100)
    h.goto()
    h.wait_card_state("fake01", "done")
    h.page.wait_for_timeout(500)
    check(not h.panel_open(), "never mode keeps the panel closed")
    check(h.page.locator(".launcher .count.show").text_content() == "1", "launcher badge count")
    h.shot("08-never-mode-launcher")
    h.close()


@test
def budget_cap_blocks_new_checks(browser):
    h = Harness(browser, settings=dict(BASE, dailyBudgetUsd=0.0001, maxConcurrent=1), delay=100)
    h.goto()
    h.page.wait_for_timeout(3000)
    for pid in ["true03", "onion04"]:
        h.scroll_to(pid)
        h.page.wait_for_timeout(600)
    h.page.wait_for_timeout(1000)
    if not h.panel_open():
        h.page.locator(".launcher").click()
    h.page.wait_for_selector(".banner.warn", timeout=3000)
    check("spending cap" in h.page.locator(".banner.warn").first.text_content(), "budget banner")
    check(h.page.locator(".card.blocked").count() >= 1, "later posts blocked")
    usage = h.page.evaluate("GM_getValue('rta.usage')")
    check(usage["usd"] < 0.0001 + 0.0005, "spend stays near cap")
    h.close()


@test
def invalid_key_halts_and_explains(browser):
    h = Harness(browser, settings=BASE, delay=100, openai_status=401)
    h.goto()
    h.page.wait_for_selector(".panel.open", timeout=6000)
    h.page.wait_for_selector(".banner.bad", timeout=3000)
    check("Incorrect API key" in h.page.locator(".banner.bad").text_content(), "401 message shown")
    n = len(h.calls["openai"])
    h.scroll_to("true03")
    h.page.wait_for_timeout(1500)
    check(len(h.calls["openai"]) == n, "no further calls once halted")
    h.shot("09-invalid-key")
    h.close()


@test
def pause_and_subreddit_filters(browser):
    h = Harness(browser, settings=dict(BASE, paused=True), delay=100)
    h.goto()
    h.page.wait_for_timeout(1500)
    check(len(h.calls["openai"]) == 0 and h.page.locator(".card").count() == 0, "paused: nothing checked")
    h.page.locator(".launcher").click()
    h.page.locator('.btn-icon[aria-label="Resume scanning"]').click()
    h.wait_card_state("fake01", "done", timeout=6000)  # resumes on-screen posts without scrolling
    h.close()

    h = Harness(browser, settings=dict(BASE, subsBlock="worldnews, r/hiking"), delay=100)
    h.goto()
    h.page.wait_for_timeout(1500)
    check(h.page.locator('.card[data-id="t3_fake01"]').count() == 0, "blocked sub skipped")
    check(h.page.locator('.card[data-id="t3_hike02"]').count() == 0, "r/ prefix in block list works")
    h.close()

    h = Harness(browser, settings=dict(BASE, subsAllow="canada"), delay=100)
    h.goto()
    h.scroll_to("true03")
    h.wait_card_state("true03", "done")
    check(h.page.locator(".card").count() == 1, "allow-list only")
    h.close()


@test
def old_reddit_supported(browser):
    h = Harness(browser, settings=BASE, delay=200)
    h.goto(old=True)
    h.wait_card_state("fake01", "done")
    h.page.wait_for_selector(".panel.open", timeout=3000)
    pill = h.page.locator('[data-fullname="t3_fake01"] ul.flat-list li.rta-li .rta-pill')
    check(pill.count() == 1 and "Likely false" in pill.text_content(), "old reddit inline badge")
    h.shot("10-old-reddit")
    check(not h.errors, f"page errors: {h.errors}")
    h.close()


@test
def csv_export(browser):
    h = Harness(browser, settings=BASE, delay=100)
    h.goto()
    h.wait_card_state("fake01", "done")
    h.page.wait_for_timeout(800)
    with h.page.expect_download() as dl:
        h.page.locator('.btn-icon[aria-label="Export CSV"]').click()
    text = Path(dl.value.path()).read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    check(lines[0].startswith("date,post_id,risk,truth_score"), "csv header")
    check(any("t3_fake01" in l and '"90"' in l for l in lines), "fake01 row")
    h.close()


@test
def narrow_screen_min_width(browser):
    h = Harness(browser, settings=BASE, delay=100, width=1024, height=768)
    h.goto()
    h.page.wait_for_selector(".panel.open", timeout=6000)
    w = h.page.evaluate("document.querySelector('#reddit-truth-auditor').shadowRoot.querySelector('.panel').getBoundingClientRect().width")
    check(abs(w - 340) < 0.5, f"panel keeps a readable min width on small screens ({w})")
    h.close()


@test
def works_without_reddit_json_and_without_tavily(browser):
    h = Harness(browser, settings=dict(BASE, tavilyKey=""), delay=100, by_id_status=429)
    h.goto()
    h.wait_card_state("fake01", "done")
    check(h.calls["by_id"], "tried /by_id")
    check(not h.calls["tavily"], "no tavily without key")
    extract = h.calls["openai"][0]["body"]["messages"][-1]["content"]
    check("Share this before it gets deleted" in extract, "falls back to on-page post text")
    audit = [c for c in h.calls["openai"] if "Audit this claim" in c["body"]["messages"][-1]["content"]][0]["body"]["messages"][-1]["content"]
    check("No web research is available" in audit and "do NOT treat it as false" in audit, "knowledge-cutoff guard in prompt")
    check("Model knowledge only" in h.card("fake01").text_content(), "card says not web-verified")
    check(h.page.locator(".banner.info", has_text="Tavily").count() == 1, "tavily hint banner")
    h.close()


@test
def keyboard_shortcuts(browser):
    h = Harness(browser, settings=dict(BASE, paused=True), delay=100)
    h.goto()
    h.page.wait_for_timeout(300)
    h.page.keyboard.press("Alt+Shift+R")
    h.page.wait_for_selector(".panel.open")
    h.page.locator('.btn-icon[aria-label="Settings"]').focus()
    h.page.keyboard.press("Escape")
    h.page.wait_for_timeout(300)
    check(not h.panel_open(), "Esc closes")
    h.page.keyboard.press("Alt+Shift+R")
    h.page.wait_for_selector(".panel.open")
    h.close()


# ----------------------------------------------------------------------------- research log & duplicates
@test
def similarity_rules(browser):
    h = Harness(browser, settings=dict(BASE, paused=True), delay=0)
    h.goto()
    r = h.page.evaluate("""() => {
      const { tokenize: t, similarity: s, urlKey: u } = window.__RTA_TEST__;
      const sim = (a, b) => Math.round(s(t(a), t(b)) * 100);
      return {
        punct: sim('WHO confirms 5G towers spread the virus!!!', 'WHO confirms 5G towers spread the virus'),
        plural: sim('Canada sets its PR target at 380,000 people', "Canada's PR targets set at 380000 people"),
        number: sim('Inflation just fell to 1%, the lowest level in 50 years', 'Inflation just fell to 3%, the lowest level in 50 years'),
        negation: sim('The vaccine does cause autism in children', "The vaccine doesn't cause autism in children"),
        short: sim('Is this real', 'Is this fake'),
        unrelated: sim('Eiffel Tower completed in 1889', 'Octopuses have three hearts'),
        url1: u('https://www.bbc.co.uk/news/article-1/?utm_source=x&fbclid=y'),
        url2: u('https://m.bbc.co.uk/news/article-1'),
        yt1: u('https://youtu.be/abc123?si=share'),
        yt2: u('https://www.youtube.com/watch?v=abc123&feature=share'),
        reddit: u('https://www.reddit.com/r/x/comments/abc/post/'),
      };
    }""")
    check(r["punct"] == 100, f"punctuation ignored {r}")
    check(r["plural"] == 100, f"plurals/possessives/thousand separators normalised {r}")
    check(r["number"] == 0, f"different numbers never match {r}")
    check(r["negation"] == 0, f"negation mismatch never matches {r}")
    check(r["short"] == 0, f"short texts only match exactly {r}")
    check(r["unrelated"] == 0, f"unrelated {r}")
    check(r["url1"] == r["url2"] == "bbc.co.uk/news/article-1", f"url normalisation {r}")
    check(r["yt1"] == r["yt2"], f"youtube normalisation {r}")
    check(r["reddit"] == "", "reddit self links are not used for link matching")
    h.close()


@test
def duplicates_reuse_earlier_verdicts(browser):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    h = Harness(browser, settings=dict(BASE, dwellMs=200), delay=150, ctx=ctx)
    # 1. research the originals on the front page
    h.goto()
    for pid in ["fake01", "true03", "mixed05"]:
        h.scroll_to(pid)
        h.wait_card_state(pid, "done")
    h.page.wait_for_timeout(1000)  # index save debounce
    base_tavily = len(h.calls["tavily"])

    # 2. browse a page full of reposts
    h.goto(path="/r/dupes/")
    for p in fx.DUPES:
        h.scroll_to(p["id"])
        h.page.wait_for_timeout(350)
    for p in fx.DUPES:
        h.page.wait_for_selector(f'.card.done[data-id="t3_{p["id"]}"]', state="attached", timeout=15000)
    h.page.wait_for_timeout(500)

    via = {p["id"]: (h.result(p["id"]).get("dupOf") or {}).get("via") for p in fx.DUPES}
    check(via == {"fake01b": "text", "true03b": "link", "fake01x": "crosspost", "fake01p": "semantic", "fake01c": "claim", "mixed05n": None}, f"reuse routes {via}")

    # token accounting: tier-1 duplicates cost nothing; claim duplicates cost only the extraction call
    for pid, title in [("fake01b", fx.DUPES[0]["title"]), ("true03b", fx.DUPES[1]["title"]), ("fake01x", "Crazy if true")]:
        check(not h.calls_mentioning(f"Title: {title}"), f"{pid}: no LLM call at all")
    for pid in ["fake01p", "fake01c"]:
        title = next(p["title"] for p in fx.DUPES if p["id"] == pid)
        check(len(h.calls_mentioning(f"Title: {title}")) == 1, f"{pid}: only the extraction call")
    check(len(h.calls_mentioning("Title: Inflation just fell to 3%")) == 2, "number-changed post gets a full check")
    check(len(h.calls["tavily"]) == base_tavily + 1, f"only the new claim was web-searched ({len(h.calls['tavily']) - base_tavily})")
    sem = h.calls_mentioning("Title: The World Health Organization now says")[0]["body"]["messages"][-1]["content"]
    check("Previously fact-checked claims" in sem and "[C1]" in sem, "extraction prompt offered earlier claims")

    # reused risky posts are still flagged + announced, and say where the verdict came from
    h.page.wait_for_selector(".panel.open", timeout=3000)
    for pid in ["fake01b", "fake01x", "fake01p", "fake01c"]:
        check("flagged" in h.card_classes(pid), f"{pid} flagged from reused verdict")
    note = h.card("fake01b").locator(".reuse").text_content()
    check("Near-identical" in note and "BREAKING: WHO confirms 5G" in note and "No tokens were spent" in note, f"reuse note: {note}")
    check("Reused" in h.card("fake01b").locator(".meta").text_content(), "reused tag")
    h.card("fake01b").scroll_into_view_if_needed()
    h.shot("11-reused-duplicates")

    # 3. revisiting a logged post on a new page load costs nothing either
    n = len(h.calls["openai"])
    h.goto()
    h.wait_card_state("fake01", "done")
    h.page.wait_for_timeout(800)
    check(len(h.calls["openai"]) == n, "revisit served from the log")

    # 4. History tab
    if not h.panel_open():
        h.page.locator(".launcher").click()
    h.page.locator(".tab.hist").click()
    h.page.wait_for_selector(".history .h-stats")
    size = h.page.evaluate("window.__RTA_TEST__.Log.size()")
    check(h.page.locator(".tab.hist .n").text_content() == str(size), "history count")
    stats = h.page.locator(".h-stats").text_content()
    check("posts logged" in stats and "repeats skipped" in stats, stats)
    check(h.page.locator(".history .card:visible").count() == size, "all entries listed")
    h.page.locator(".h-tools select").select_option("dup")
    h.page.wait_for_timeout(200)
    check(h.page.locator(".history .card:visible").count() == 5, f"reused filter ({h.page.locator('.history .card:visible').count()})")
    h.page.locator(".h-tools select").select_option("all")
    h.page.locator(".h-tools input").fill("inflation")
    h.page.wait_for_timeout(500)
    check(h.page.locator(".history .card:visible").count() == 2, f"search filter {h.page.locator('.history .card:visible .t').all_text_contents()}")
    h.page.locator(".h-tools input").fill("")
    h.page.wait_for_timeout(500)
    h.shot("12-history-tab")

    # 5. CSV export includes the provenance columns
    with h.page.expect_download() as dl:
        h.page.locator('.btn-icon[aria-label="Export CSV"]').click()
    text = Path(dl.value.path()).read_text(encoding="utf-8-sig")
    check(text.splitlines()[0].endswith("reused_from,reuse_via"), "csv header")
    check(any("t3_fake01b" in l and '"t3_fake01"' in l and '"text"' in l for l in text.splitlines()), "dup row in csv")
    check(not h.errors, f"page errors: {h.errors}")
    h.close()


@test
def check_anyway_bypasses_dedupe(browser):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    h = Harness(browser, settings=dict(BASE, dwellMs=100), delay=100, ctx=ctx)
    h.goto()
    h.wait_card_state("fake01", "done")
    h.page.wait_for_timeout(800)
    h.goto(path="/r/dupes/")
    h.wait_card_state("fake01b", "done")
    check(not h.calls_mentioning("Title: " + fx.DUPES[0]["title"]), "reused first")
    if not h.panel_open():
        h.page.locator(".launcher").click()
    h.card("fake01b").locator(".btn", has_text="Check anyway").click()
    h.page.wait_for_timeout(300)
    h.wait_card_state("fake01b", "done")
    h.page.wait_for_timeout(300)
    check(len(h.calls_mentioning("Title: " + fx.DUPES[0]["title"])) == 2, "full check after Check anyway")
    check(not h.result("fake01b").get("dupOf"), "fresh result stored")
    h.close()


@test
def dedupe_can_be_disabled(browser):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    h = Harness(browser, settings=dict(BASE, dwellMs=100, dedupe=False), delay=100, ctx=ctx)
    h.goto()
    h.wait_card_state("fake01", "done")
    h.page.wait_for_timeout(800)
    h.goto(path="/r/dupes/")
    h.wait_card_state("fake01b", "done")
    h.page.wait_for_timeout(300)
    check(len(h.calls_mentioning("Title: " + fx.DUPES[0]["title"])) == 2, "full check when dedupe is off")
    check("Previously fact-checked" not in h.calls["openai"][-1]["body"]["messages"][-1]["content"], "no candidates offered when off")
    h.close()


@test
def simultaneous_twins_are_checked_once(browser):
    h = Harness(browser, settings=dict(BASE, dwellMs=100, maxConcurrent=2), delay=400)
    h.goto(path="/r/twins/")
    h.wait_card_state("twina", "done")
    h.wait_card_state("twinb", "done")
    h.page.wait_for_timeout(300)
    full = len(h.calls_mentioning("Audit this claim")) 
    check(full == 1, f"only one audit for two identical posts on screen together ({full})")
    check(len(h.calls["tavily"]) == 1, "one web search")
    vias = [(h.result(p).get("dupOf") or {}).get("via") for p in ("twina", "twinb")]
    check(sorted(map(str, vias)) == ["None", "text"], f"one original, one reuse {vias}")
    h.close()


@test
def legacy_cache_migrated_and_old_entries_pruned(browser):
    now = int(time.time() * 1000)
    legacy_r = {"kind": "audit", "truth": 1, "sarcasm": 1, "risk": 90, "confidence": "high", "claim": fx.POSTS[0]["claim"],
                "summary": "", "contentType": "news", "query": "", "factualCheck": "x", "contextCheck": "", "verdict": "False (from v1 cache).",
                "researched": True, "researchError": None, "sources": [], "model": "gpt-4o-mini", "at": now - 3600e3,
                "post": {"title": fx.POSTS[0]["title"], "subreddit": "worldnews", "permalink": "/r/worldnews/comments/fake01/post/", "domain": ""}}
    old_r = dict(legacy_r, verdict="ancient", post=dict(legacy_r["post"], title="Old news"))
    store = {
        "rta.cache": {"t3_fake01": {"t": now - 3600e3, "r": legacy_r}},
        "rta.log.t3_old999": {"t": now - 40 * 864e5, "r": old_r},
        "rta.idx": {"t3_old999": [now - 40 * 864e5, "a", 90, "Old news", "worldnews", "old new", "", "", "", 1]},
    }
    h = Harness(browser, settings=BASE, delay=100, store=store)
    h.goto()
    h.wait_card_state("fake01", "done")
    check(not h.calls_mentioning("5G towers"), "migrated v1 result reused, no API calls")
    check("from v1 cache" in h.card("fake01").text_content(), "shows migrated verdict")
    check(h.page.evaluate("GM_getValue('rta.cache', 'gone')") == "gone", "legacy key removed")
    check(h.page.evaluate("GM_getValue('rta.log.t3_old999', 'gone')") == "gone", "entry older than logDays pruned")
    check(h.page.evaluate("window.__RTA_TEST__.Log.get('t3_old999')") is None, "pruned from index")
    h.close()


@test
def index_self_heals_from_records(browser):
    now = int(time.time() * 1000)
    r = {"kind": "audit", "truth": 1, "sarcasm": 1, "risk": 90, "confidence": "high", "claim": fx.POSTS[0]["claim"], "summary": "",
         "contentType": "news", "query": "", "factualCheck": "", "contextCheck": "", "verdict": "False (record without index).",
         "researched": False, "researchError": None, "sources": [], "model": "m", "at": now,
         "post": {"title": fx.POSTS[0]["title"], "subreddit": "worldnews", "permalink": "/r/worldnews/comments/fake01/post/", "domain": ""}}
    h = Harness(browser, settings=dict(BASE, dwellMs=100), delay=100, store={"rta.log.t3_fake01": {"t": now, "r": r}})
    h.goto(path="/r/dupes/")   # a near-duplicate of the un-indexed record
    h.wait_card_state("fake01b", "done")
    check((h.result("fake01b").get("dupOf") or {}).get("id") == "t3_fake01", "duplicate matched against a reconciled record")
    check("t3_fake01" in h.page.evaluate("GM_getValue('rta.idx', {})"), "index repaired")
    h.close()


def main():
    only = sys.argv[1:]
    failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for fn in results:
            if only and fn.__name__ not in only:
                continue
            t = time.time()
            try:
                fn(browser)
                print(f"PASS  {fn.__name__}  ({time.time() - t:.1f}s)")
            except Exception:
                failed += 1
                print(f"FAIL  {fn.__name__}")
                traceback.print_exc()
        browser.close()
    print(f"\n{len(results) - failed if not only else '?'} passed, {failed} failed. Screenshots in {SHOTS}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
