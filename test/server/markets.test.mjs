// Markets (one brand per country), free fix rechecks, the scheduled report and its timing. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countryOf, localePath, detectCountry, localeSignals, siblingMarkets, ownUrl } from "../../api/_markets.js";
import { recheck, checkType, publicUrl, setFetch } from "../../server/recheck.mjs";
import { changesBetween, summarize } from "../../server/metrics.mjs";
import { nextRun } from "../../server/routes.mjs";
import * as N from "../../server/notify.mjs";

test("countries are recognised from names, codes, locale tags and path segments", () => {
  assert.equal(countryOf("India").code, "IN"); assert.equal(countryOf("in").code, "IN"); assert.equal(countryOf("en-IN").code, "IN");
  assert.equal(countryOf("uk").code, "GB"); assert.equal(countryOf("Dubai, UAE").code, "AE"); assert.equal(countryOf("United States").code, "US");
  for (const x of ["Global", "Europe", "", "worldwide"]) assert.equal(countryOf(x), null, x);
  assert.equal(localePath("/in/deals"), "/in"); assert.equal(localePath("/en-gb/"), "/en-gb"); assert.equal(localePath("/uk"), "/uk");
  for (const p of ["/blog/x", "/", "/go/x", "/deals"]) assert.equal(localePath(p), "", p);
});

test("a market's country comes from its path, then its language tag, then a one-country currency", () => {
  assert.deepEqual(detectCountry({ path: "/in", lang: "en-US" }).code, "IN");
  assert.equal(detectCountry({ lang: "en-GB" }).code, "GB");
  assert.equal(detectCountry({ lang: "en", currency: "INR" }).code, "IN");
  assert.equal(detectCountry({ lang: "en", currency: "EUR" }), null, "the euro is many countries");
  assert.equal(detectCountry({ lang: "en" }), null);
});

test("locale signals and sibling markets are read from the page", () => {
  const html = `<html lang="en-IN"><head><meta property="og:locale" content="en_IN"><link rel="alternate" hreflang="en-us" href="https://shop.example/us"><link rel="alternate" hreflang="x-default" href="https://shop.example/"></head><body>₹499 ₹999 <a href="/in/deals">x</a></body></html>`;
  const s = localeSignals(html, "https://shop.example/in");
  assert.equal(s.lang, "en-IN"); assert.equal(s.currency, "INR"); assert.equal(s.alternates.length, 1); assert.equal(s.alternates[0].country, "US");
  const sib = siblingMarkets(s, ["https://shop.example/in/deals", "https://shop.example/uk", "https://other.example/de"], "https://shop.example", "/in");
  assert.deepEqual(sib.map((x) => x.code).sort(), ["GB", "US"]);
});

test("your own pages are counted per market: /us pages aren't yours in an India check, /about pages are", () => {
  const site = "https://meshopcheap.com/in";
  assert.equal(ownUrl("https://meshopcheap.com/in/deals", site), true);
  assert.equal(ownUrl("https://www.meshopcheap.com/about", site), true);
  assert.equal(ownUrl("https://meshopcheap.com/us/deals", site), false);
  assert.equal(ownUrl("https://other.com/in", site), false);
  assert.equal(ownUrl("https://meshopcheap.com/us/deals", "https://meshopcheap.com"), true, "a brand with no market path owns all of its site");
  const M = { profile: { name: "MeShopCheap", site }, answers: { a: { status: "yes", named: true, engine: "chatgpt", brands: ["MeShopCheap"], sources: [{ url: "https://meshopcheap.com/us/x" }] }, b: { status: "no", engine: "chatgpt", brands: [], sources: [{ url: "https://meshopcheap.com/in/x" }] } } };
  assert.equal(summarize(M).usedAsSource, 0.5);
});

// A fake web for the rechecks: url → { status, body }.
const web = (pages) => setFetch(async (url) => { const p = pages[url]; return p ? { ok: p.status === undefined || p.status < 400, status: p.status || 200, url, body: p.body || "" } : { ok: false, status: 404, url, body: "" }; });

test("a fix is re-checked on its own, for free: robots.txt, llms.txt, schema, a page, a listing", async () => {
  const site = "https://shop.example/in", brand = { name: "Shopco", site, competitors: ["Rival"] };
  assert.equal(checkType("robots"), "robots"); assert.equal(checkType("fix:https://x"), "page"); assert.equal(checkType("pitch:https://x"), "listing"); assert.equal(checkType("article:q1"), null);

  web({ "https://shop.example/robots.txt": { body: "User-agent: GPTBot\nDisallow: /\n" } });
  let r = await recheck("robots", { site, evidence: { blocked: ["GPTBot", "ClaudeBot"] } });
  assert.equal(r.pass, false); assert.deepEqual(r.observed.stillBlocked, ["GPTBot"]); assert.match(r.detail, /GPTBot/);
  web({ "https://shop.example/robots.txt": { body: "User-agent: *\nAllow: /\n" } });
  r = await recheck("robots", { site, evidence: { blocked: ["GPTBot"] } }); assert.equal(r.pass, true);

  web({ "https://shop.example/llms.txt": { body: "<html>not found page</html>" } });
  assert.equal((await recheck("llms", { site })).pass, false, "a web page served at /llms.txt is not an llms.txt");
  web({ "https://shop.example/llms-full.txt": { body: "# Shopco\n> Deals" } });
  assert.equal((await recheck("llms", { site })).pass, true);

  const org = `<html><head><script type="application/ld+json">{"@type":"Organization","name":"Shopco"}</script></head><body></body></html>`;
  web({ [site]: { body: org } }); r = await recheck("org", { site }); assert.equal(r.pass, true); assert.match(r.detail, /Shopco/);
  web({ [site]: { body: "<html><body>hi</body></html>" } }); assert.equal((await recheck("org", { site })).pass, false);

  web({ "https://shop.example/in/deals": { body: "<html><body><p>thin</p></body></html>" } });
  r = await recheck("fix:https://shop.example/in/deals", { site, evidence: { score: 20 } });
  assert.equal(r.pass, false); assert.equal(r.observed.was, 20); assert.match(r.detail, /was 20/);
  assert.match((await recheck("fix:https://elsewhere.example/p", { site })).detail, /isn't on this brand's website/);

  web({ "https://list.example/best": { body: "<html><body>Top picks: Rival and others.</body></html>" } });
  r = await recheck("pitch:https://list.example/best", { site, brand }); assert.equal(r.pass, false); assert.deepEqual(r.observed.rivals, ["Rival"]);
  web({ "https://list.example/best": { body: "<html><body>Top picks: Rival, Shopco.</body></html>" } });
  assert.equal((await recheck("pitch:https://list.example/best", { site, brand })).pass, true);
  setFetch(null);
});

test("a recheck never opens a private or internal address", async () => {
  for (const u of ["http://localhost/x", "http://127.0.0.1/", "http://169.254.169.254/latest", "http://10.0.0.5/", "http://192.168.1.1/", "http://metadata.google.internal/", "file:///etc/passwd", "http://[::1]/"]) assert.equal(publicUrl(u), null, u);
  assert.ok(publicUrl("https://shop.example/in"));
  assert.match((await recheck("pitch:http://169.254.169.254/latest", { site: "https://shop.example" })).detail, /public web address/);
});

test("checks can run on a chosen day and hour in the brand's time zone, including half-hour zones", () => {
  const from = Date.parse("2026-10-19T03:00:00Z"); // Monday 08:30 in Kolkata
  const w = nextRun("weekly", from, { dow: 1, hour: 9, tz: "Asia/Kolkata" }); // Mondays 09:00 IST
  assert.equal(w.toISOString(), "2026-10-26T03:30:00.000Z", "today's slot is under a day away, so next week's");
  const w2 = nextRun("weekly", Date.parse("2026-10-17T03:00:00Z"), { dow: 1, hour: 9, tz: "Asia/Kolkata" }); // a Saturday
  assert.equal(w2.toISOString(), "2026-10-19T03:30:00.000Z");
  const d = nextRun("daily", from, { hour: 7, tz: "Europe/London" });
  assert.equal(d.toISOString(), "2026-10-19T06:00:00.000Z", "07:00 BST");
  assert.equal(nextRun("weekly", from).getTime(), from + 7 * 864e5, "no time chosen: a week after, as before");
  assert.equal(nextRun("off", from), null);
});

const run = (named, extra = {}) => ({ profile: { name: "Acme", site: "https://acme.ai" }, questions: [{ id: "q1", text: "best ai partner" }, { id: "q2", text: "top consultancies" }],
  answers: { "q1|chatgpt": { qid: "q1", engine: "chatgpt", status: named.q1 ? "yes" : "no", named: !!named.q1, brands: named.q1 ? ["Acme", "Rival"] : ["Rival"] }, "q2|chatgpt": { qid: "q2", engine: "chatgpt", status: named.q2 ? "yes" : "no", named: !!named.q2, brands: named.q2 ? ["Acme"] : ["Rival"] } }, ...extra });

test("the report says what changed since the last check, matched by prompt text", () => {
  const prev = run({ q2: true }, { audit: { bots: { GPTBot: false, ClaudeBot: true }, llms: false, avg: 40 } });
  // This run numbers the prompts the other way round: matching is by text, not by q1/q2.
  const cur = run({ q1: true }, { audit: { bots: { GPTBot: true, ClaudeBot: false }, llms: true, avg: 55 } });
  const c = changesBetween(prev, cur);
  assert.deepEqual(c.gained.map((x) => x.text), ["best ai partner"]); assert.deepEqual(c.lost.map((x) => x.text), ["top consultancies"]);
  assert.deepEqual(c.site.unblocked, ["GPTBot"]); assert.deepEqual(c.site.newlyBlocked, ["ClaudeBot"]); assert.equal(c.site.llms, true); assert.equal(c.site.avg, 55);
  const over = changesBetween(run({ q1: true, q2: true }), run({}));
  assert.equal(over.overtook[0].name, "Rival", "named less than you before, more than you now");
  assert.equal(changesBetween(null, cur).site, null, "a first check has nothing to compare");
});

test("the results email: daily or weekly, what changed, fixes checked, and a way to stop it", () => {
  const d = { brand: "Acme (India)", slug: "acme-in", schedule: "daily", s: { visibility: 0.5, score: 60, sov: 0.2, leader: null }, prev: { visibility: 0.25 },
    changes: { gained: [{ text: "best ai partner", engines: ["chatgpt"] }], lost: [], engines: [{ engine: "chatgpt", now: 0.5, before: 0.25 }], overtook: [], site: { unblocked: ["GPTBot"], newlyBlocked: [], llms: null, avg: 50, avgBefore: 50 } },
    fixes: [{ title: "Let AI crawlers read your site", pass: true, detail: "GPTBot can read your site now." }], observed: [{ title: "Win it", direction: "improved", before: { named: 0, total: 2 }, after: { named: 1, total: 2 } }] };
  const m = N.preview("weekly_results", d);
  assert.equal(m.subject, "Acme (India): your daily AI visibility");
  assert.match(m.paras[0], /up 25 points/);
  const sec = Object.fromEntries(m.sections.map((x) => [x.title.replace(/ \(\d+\)$/, ""), x.items]));
  assert.match(sec["Now named for"][0], /best ai partner.*ChatGPT/); assert.match(sec["Your site"][0], /GPTBot can read/);
  assert.match(sec["Fixes checked"][0], /^Confirmed: Let AI crawlers/); assert.match(sec["Results after publishing"][0], /improved \(named in 0 of 2, now 1 of 2\)/);
  assert.equal(N.preview("weekly_results", { ...d, schedule: "weekly" }).subject, "Acme (India): your weekly AI visibility");
  assert.ok(N.OPT_OUT_KINDS.includes("weekly_results"));
  assert.notEqual(N.unsubToken("u1", "weekly_results"), N.unsubToken("u2", "weekly_results"));
});
