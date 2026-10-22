"""Browser end-to-end for markets, fix rechecks and the scheduled report settings:
set up a site's /in version -> add its /us version as a market -> switch markets -> compare them -> Recheck a fix (not yet,
then confirmed) -> pick the weekday and hour of automatic checks -> turn the results email off -> rerun a market (it must
stay that market, not overwrite the brand).
Runs against a real server with Postgres; only the AI endpoints and the recheck's web read are mocked. Markets need a plan
that allows two, so run the server with BILLING_ENABLED=0 (no limits):
    BILLING_ENABLED=0 DATABASE_URL=... node server/index.mjs
    pip install playwright && python3 test/e2e/markets.py /tmp/shots-markets      # BASE=http://127.0.0.1:3000 by default"""
import json, sys, time, pathlib, os
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/claude-0/shots-markets"); OUT.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get("BASE", "http://127.0.0.1:3000")
EMAIL = f"mk{int(time.time()*1000)}{os.getpid()}@example.com"
RIVALS = ["DealHub", "SaveMore", "CouponKing"]
COUNTRY = {"in": ("IN", "India", "en-IN", "INR"), "us": ("US", "United States", "en-US", "USD")}
SIBLINGS = [{"path": "/us", "code": "US", "name": "United States", "url": "https://shop.example/us"}, {"path": "/uk", "code": "GB", "name": "United Kingdom", "url": "https://shop.example/uk"}]

def sse(events): return "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events)
def audit_for(seg):
    code, name, lang, ccy = COUNTRY[seg]
    return {"origin": "https://shop.example", "scope": "/" + seg, "site": f"https://shop.example/{seg}", "bots": {"GPTBot": False, "ClaudeBot": True}, "llms": False, "sitemap": 12, "avg": 48, "homeSchema": [], "orgSchema": False,
            "pages": [{"url": f"https://shop.example/{seg}", "title": "Shopco deals", "score": 42, "fails": ["FAQ block", "Specific numbers"]}],
            "locale": {"lang": lang, "currency": ccy, "hreflang": 0, "redirectedTo": "", "country": {"code": code, "name": name, "via": "path"}},
            "markets": [m for m in SIBLINGS + [{"path": "/in", "code": "IN", "name": "India", "url": "https://shop.example/in"}] if m["path"] != "/" + seg]}

checks = {"n": 0, "bodies": []}
def route(route):
    req = route.request; path = "/" + req.url.split("/", 3)[3]
    body = json.loads(req.post_data or "{}") if req.method == "POST" else {}
    if path.startswith("/api/config"):
        d = route.fetch().json(); d.update({"engines": ["chatgpt", "gemini"], "llm": True}); return route.fulfill(json=d)
    if path.startswith("/api/site"):
        seg = "us" if "/us" in body.get("url", "") else "in"; a = audit_for(seg); code, name = COUNTRY[seg][:2]
        prof = {"name": "Shopco", "site": a["site"], "category": "deal aggregator", "offer": "Daily deals and discounts.", "audience": "online shoppers", "market": name, "country": code,
                "competitors": RIVALS[:2], "facts": ["Founded 2020"], "identity": ["Thrifty"], "products": ["Deals", "Coupons"], "personas": ["Bargain hunter", "Student"]}
        ev = [("step", {"id": "home", "text": "Opening"}), ("done", {"id": "home", "text": "Read", "ok": True}), ("page", a["pages"][0]), ("result", {"profile": prof, "audit": a, "siteText": "Shopco deals."})]
        return route.fulfill(status=200, headers={"content-type": "text/event-stream"}, body=sse(ev))
    if path.startswith("/api/write"):
        k = body.get("kind"); d = body.get("data", {})
        if k == "topics": txt = "Online deals\nCoupon codes"
        elif k == "topicQuestions": txt = "\n".join(f"{t} | commercial | Bargain hunter | best site for {t.lower()} {j}" for t in d["topics"] for j in range(d.get("perTopic", 2)))
        elif k == "perception": txt = json.dumps({"summary": "Known as a deals site.", "recognised": True, "claims": []})
        elif k == "assets": txt = json.dumps({"llms_txt": "# Shopco", "org_schema": {"@type": "Organization", "name": "Shopco"}})
        elif k == "sentiment": txt = json.dumps({it["id"]: {b: 60 for b in it["brands"]} for it in d["items"]})
        else: txt = "- **Insight.** One."
        return route.fulfill(status=200, headers={"content-type": "text/event-stream"}, body=sse([("delta", {"text": txt}), ("final", {"text": txt})]))
    if path.startswith("/api/ask"):
        q = body.get("question", ""); named = "coupon" in q.lower() and body.get("engine") == "chatgpt"
        brands = ["DealHub", "Shopco"] if named else RIVALS
        srcs = [{"url": "https://shop.example/us/deals", "title": "deals", "cited": True}, {"url": "https://lists.example/best", "title": "Best deal sites", "cited": True}]
        return route.fulfill(status=200, headers={"content-type": "text/event-stream"}, body=sse([("final", {"answer": "Options: " + ", ".join(brands), "sources": srcs, "brands": brands, "model": "fake"})]))
    if path.startswith("/api/inspect"):
        u = body["url"]; return route.fulfill(json={"ok": True, "url": u, "final": u, "domain": u.split("/")[2], "title": "Best deal sites", "you": False, "rivals": ["DealHub"], "evidence": [], "contacts": {"emails": []}, "excerpt": "..."})
    if path.startswith("/api/recheck"):
        # The real route reads robots.txt from the web; here the first read still sees the block and the second sees the fix.
        checks["n"] += 1; checks["bodies"].append(body); ok = checks["n"] > 1
        return route.fulfill(json={"check": {"type": "robots", "pass": ok, "at": "2026-10-22T10:00:00Z", "by": "person", "detail": "GPTBot can read your site now." if ok else "Still blocked in robots.txt: GPTBot."}})
    return route.continue_()

errors, fails = [], []
def check(cond, what): print(("ok   " if cond else "FAIL ") + what); (None if cond else fails.append(what))

def onboard(pg, shot, prefix, country):
    """From the profile sheet to a finished check, accepting what the site said."""
    pg.wait_for_selector("#obSheet:not([hidden])", timeout=15000); time.sleep(0.4)
    pg.click("[data-act=profileOk]"); time.sleep(0.3); shot(prefix + "_market")
    note = pg.inner_text("#obAsk")
    check(f"We read the {country} version" in note, f"{prefix}: the market step says which country version was read ({country})")
    if country == "United States": check("India" not in pg.inner_text("#obAsk p.muted.sm"), "the US market's note doesn't offer India again: it is already tracked")
    pg.click("#onboard form.pill .go"); time.sleep(0.3)
    pg.click("[data-go=topicsGen]"); pg.wait_for_selector("text=Review your topics", timeout=8000)
    pg.click("[data-go=focus]"); time.sleep(0.2); pg.click("[data-act=openFocus]"); time.sleep(0.3)
    pg.click("[data-act=genPrompts]"); pg.wait_for_selector("text=Your prompt set is ready", timeout=8000)
    pg.click("#obAsk [data-act=launch]")
    pg.wait_for_selector("#ready[data-mode=done]:not([hidden]), #reportWrap:not([hidden])", timeout=120000)
    if pg.is_visible("#readyGo"): pg.click("#readyGo")
    pg.wait_for_selector("#reportWrap:not([hidden])", timeout=15000); time.sleep(1.5)

def spaces(pg): return pg.evaluate("fetch('/api/workspaces').then(r=>r.json()).then(d=>d.workspaces.map(w=>({slug:w.slug,parent:w.parent,code:w.market&&w.market.code,site:w.site})))")

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 1440, "height": 900}); pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    pg.on("console", lambda m: m.type == "error" and "favicon" not in m.text and errors.append("console: " + m.text))
    pg.route(lambda u: "/api/" in u and any(k in u for k in ("/api/config", "/api/site", "/api/write", "/api/ask", "/api/inspect", "/api/recheck")), route)
    ctx.route("https://www.google.com/**", lambda r: r.fulfill(status=404, body=""))
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", headers={"content-type": "text/css"}))
    shot = lambda n: pg.screenshot(path=str(OUT / f"{n}.png"))

    # 1. The India version of the site.
    pg.goto(BASE + "/"); time.sleep(0.6)
    pg.fill("#startUrl", "shop.example/in"); pg.click("#startForm button")
    pg.wait_for_selector("#auth:not([hidden])", timeout=5000)
    pg.fill("#authName", "Mia"); pg.fill("#authEmail", EMAIL); pg.fill("#authPass", "correct-horse-9"); pg.click("#authGo")
    onboard(pg, shot, "01_india", "India"); shot("02_india_overview")
    ws = spaces(pg)
    check(len(ws) == 1 and ws[0]["code"] == "IN" and ws[0]["site"] == "https://shop.example/in", f"the brand is saved as the India market of shop.example/in: {ws}")
    check("Add market" in pg.inner_text(".mkts") and "2 found" in pg.inner_text(".mkts"), "the market bar offers the site's other country versions")

    # 2. Add the US version as a market of the same brand.
    pg.click("[data-addmkt]"); time.sleep(0.4); shot("03_add_market")
    check("United Kingdom" in pg.inner_text(".modal") and "United States" in pg.inner_text(".modal"), "Add market lists the versions found on the site")
    pg.click(".modal [data-mkturl='https://shop.example/us']")
    onboard(pg, shot, "04_us", "United States"); shot("05_us_overview")
    ws = spaces(pg); us = next((w for w in ws if w["code"] == "US"), None)
    check(len(ws) == 2 and us and us["slug"] == "shopco-us" and us["parent"] == "shopco", f"the US is a market of the brand, not a new brand: {ws}")
    check(pg.inner_text("#projName") == "Shopco · United States", "the header names the market")
    check("By market" in pg.inner_text("#pages") and pg.locator("#pages tr[data-mkt]").count() == 2, "the overview compares both markets")
    shot("06_by_market")

    # 3. Switch to India with the market tabs.
    pg.click(".mkts [data-mkt=shopco]"); pg.wait_for_function("document.querySelector('#projName').textContent.includes('India')", timeout=10000); time.sleep(0.6)
    check(pg.inner_text("#projName") == "Shopco · India", "the India tab opens the India market")

    # 4. Recheck one fix: not fixed yet, then confirmed, without a new check.
    pg.click('#side [data-page="actions"]'); time.sleep(0.6)
    pg.click("#deck [data-act=recheck]"); pg.wait_for_selector("#deck .rcheck.no", timeout=8000); time.sleep(0.3); shot("07_recheck_not_yet")
    check("Not fixed yet" in pg.inner_text("#deck .rcheck"), "a failed recheck says what is still wrong on the card")
    sent = checks["bodies"][0]
    check(sent.get("slug") == "shopco" and sent.get("sourceKey") == "robots" and sent.get("evidence", {}).get("blocked") == ["GPTBot"], f"the recheck names the brand, the fix and what the card saw: {sent}")
    pg.click("#deck [data-act=recheck]"); time.sleep(1.2); shot("08_recheck_confirmed")
    check("1 confirmed" in pg.inner_text("#deckCount"), "a passing recheck confirms the fix and moves the deck on")
    check(pg.evaluate("fetch('/api/workspaces/shopco/runs').then(r=>r.json()).then(d=>d.runs.length)") == 1, "a recheck doesn't start a check")

    # 5. Automatic checks on Mondays at 09:00, and the results email off.
    pg.click("#acctBtn"); pg.click('#side [data-page="settings"]'); time.sleep(0.6)
    pg.click("[data-sched=weekly]"); time.sleep(1)
    pg.select_option("[data-rundow]", "1"); time.sleep(1); pg.select_option("[data-runhour]", "9"); time.sleep(1.2); shot("09_settings_time")
    nxt = pg.inner_text(".st-card")
    check("Next check Mon" in nxt and "09:00" in nxt, "the next check is the chosen weekday and hour")
    w = pg.evaluate("fetch('/api/workspaces').then(r=>r.json()).then(d=>d.workspaces.find(w=>w.slug==='shopco'))")
    check(w["runDow"] == 1 and w["runHour"] == 9 and w["runTz"], f"the weekday, hour and time zone are saved: {w['runDow']} {w['runHour']} {w['runTz']}")
    us_sched = pg.evaluate("fetch('/api/workspaces').then(r=>r.json()).then(d=>d.workspaces.find(w=>w.slug==='shopco-us').schedule)")
    check(us_sched == "off", "each market keeps its own schedule")
    pg.uncheck("[data-emailme]"); time.sleep(1)
    check(pg.evaluate("fetch('/api/me/email-prefs').then(r=>r.json()).then(d=>d.reports)") is False, "the results email can be turned off in Settings")

    # 6. Rerun the US market: it stays the US market (it used to be saved under the brand's own name, over the brand).
    pg.click(".mkts [data-mkt=shopco-us]"); pg.wait_for_function("document.querySelector('#projName').textContent.includes('United States')", timeout=10000); time.sleep(0.5)
    pg.click("#rerun"); pg.wait_for_selector("text=Your prompt set is ready", timeout=15000); time.sleep(0.3)
    pg.click("#obAsk [data-act=launch]"); pg.wait_for_selector("#ready[data-mode=done]:not([hidden]), #reportWrap:not([hidden])", timeout=120000); time.sleep(1.5)
    ws = spaces(pg)
    check(len(ws) == 2 and pg.evaluate("fetch('/api/workspaces/shopco-us/runs').then(r=>r.json()).then(d=>d.runs.length)") == 2
          and pg.evaluate("fetch('/api/workspaces/shopco/runs').then(r=>r.json()).then(d=>d.runs.length)") == 1, f"the rerun is the US market's second check, the brand's India check is untouched: {ws}")
    shot("10_rerun_us")
    b.close()

errs = [e for e in errors if "404" not in e]
print("ERRORS:", errs or "none"); print("FAILED:", fails or "none")
sys.exit(1 if fails or errs else 0)
