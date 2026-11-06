// Rival playbooks: what is on a page (public/page-features.js) and how one rival wins (public/story-model.js), loaded in a VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const window = {}, ctx = vm.createContext({ window });
for (const f of ["product-language.js", "recommendation-model.js", "rival-model.js", "intel-model.js", "page-features.js", "story-model.js"]) vm.runInContext(readFileSync(new URL("../public/" + f, import.meta.url), "utf8"), ctx, { filename: f });
const PG = window.WP_PAGE, S = window.WP_STORY, plain = (x) => JSON.parse(JSON.stringify(x));
const filler = "<p>" + "useful words here ".repeat(60) + "</p>";

test("a page's features: whole-sentence quotes, prices only with an amount, no widget questions, schema read", () => {
  const html = `<html><head><title>Notes</title><script type="application/ld+json">{"@graph":[{"@type":"FAQPage"},{"@type":"Article"}]}</script></head><body>
    <h1>AI meeting notes</h1><h2>Who can use it?</h2><h2>Does it record audio?</h2><h2>Was this resource helpful?</h2><h2>Compare plans</h2>
    <p>You get 10 hours per user. Plans start at $10 per user each month. It is best for teams who already live in Notion. Mention Granola too.</p>
    <ol><li>a</li><li>b</li><li>c</li></ol>${filler}</body></html>`;
  const f = plain(PG.pageFeatures(html, { brands: ["Notion", "Granola", "Krisp"] }));
  assert.equal(f.readable, true);
  assert.equal(f.bestFor, "It is best for teams who already live in Notion.");
  assert.equal(f.pricing, "$10 per user", "the amount, not the hours limit");
  assert.deepEqual(f.questions, ["Who can use it?", "Does it record audio?"]);
  assert.equal(f.faq, true); assert.equal(f.steps, true); assert.equal(f.comparison, true);
  assert.deepEqual(f.schema.sort(), ["Article", "FAQPage"]); assert.deepEqual(f.names, ["Notion", "Granola"]);
  assert.equal(PG.pageFeatures(`<html><body>${filler}10 hours per user</body></html>`).pricing, "", "no amount, no price");
});

test("a page that blocks readers is 'couldn't read', never 'has none of these'", () => {
  const f = plain(PG.pageFeatures("<html><body><div id=root></div>Loading…</body></html>"));
  assert.equal(f.readable, false); assert.match(f.reason, /couldn't be read/);
});

// Notion is named in 3 of 4 answers, never with you. Its own help page and a roundup that names it were read; a page that
// was used in those answers but doesn't mention Notion must not count as Notion's evidence.
const notionPage = PG.pageFeatures(`<html><head><script type="application/ld+json">{"@type":"FAQPage"}</script></head><body><h1>Notion notes</h1><h2>How does it work?</h2><h2>Who is it for?</h2><h2>Can I export?</h2><p>Notion is best for teams who live in Notion. From $10 per member.</p>${filler}</body></html>`, { brands: ["Notion"] });
const roundup = PG.pageFeatures(`<html><body><h1>Best tools</h1><h2>Notion vs Granola</h2><table><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></table><p>Notion and Granola lead.</p>${filler}</body></html>`, { brands: ["Notion", "Granola", "Acme"] });
const unrelated = PG.pageFeatures(`<html><body><h1>Zoom help</h1><h2>Settings</h2>${filler}</body></html>`, { brands: ["Notion"] });
const yourHome = PG.pageFeatures(`<html><body><h1>Acme</h1><h2>Pricing</h2><p>Acme costs $8 per month.</p>${filler}</body></html>`, { brands: [] });
const ans = (qid, engine, brands, sources, x = {}) => ({ qid, engine, status: "yes", answer: x.answer || `Try ${brands.join(", ")}.`, brands, sources: sources.map((url) => ({ url, cited: true })), named: false, ...x });
const M = { profile: { name: "Acme", competitors: ["Notion"] }, engines: ["chatgpt", "claude"],
  questions: [{ id: "q1", text: "Which notes tool should I buy?", intent: "transactional" }, { id: "q2", text: "Best meeting notes app", intent: "commercial" }],
  answers: {
    a: ans("q1", "chatgpt", ["Notion", "Granola"], ["https://www.notion.com/help/notes", "https://zoom.us/help"], { answer: "Notion — best flexible workspace for founders.\nGranola is lighter." }),
    b: ans("q1", "claude", ["Notion"], ["https://roundup.test/best", "https://reddit.com/r/notes/1"]),
    c: ans("q2", "chatgpt", ["Notion", "Granola"], ["https://roundup.test/best", "https://zoom.us/help"]),
    d: ans("q2", "claude", ["Granola"], [], {}),
  } };
const pages = { "https://www.notion.com/help/notes": notionPage, "https://roundup.test/best": roundup, "https://zoom.us/help": unrelated, "https://reddit.com/r/notes/1": PG.pageFeatures("<html><body>x</body></html>") };

test("how a rival wins: evidence is theirs or names them, quotes come from the answers, and the moves cite what they do", () => {
  const s = plain(S.rivalStory(M, "Notion", { pages, yours: [{ url: "https://acme.test/", features: yourHome }] }));
  assert.equal(s.named, 3); assert.equal(s.of, 4); assert.equal(s.absent.length, 2);
  assert.deepEqual(s.pages.map((p) => [p.domain, p.own, p.namesRival, p.unreadable]), [["notion.com", true, true, false], ["roundup.test", false, true, false], ["reddit.com", false, null, true]]);
  assert.ok(!s.pages.some((p) => p.domain === "zoom.us"), "a page that doesn't mention Notion is not Notion's evidence");
  assert.equal(s.says[0].text, "Notion — best flexible workspace for founders.");
  const by = Object.fromEntries(s.checks.map((c) => [c.key, c]));
  assert.equal(by.pricing.you.short, "acme.test", "you already show prices"); assert.ok(by.faq.they && !by.faq.you); assert.ok(by.comparison.they);
  assert.equal(s.moves[0].kind, "page"); assert.match(s.moves[0].title, /Which notes tool should I buy\?/, "the decision-stage prompt first");
  const steps = s.moves[0].steps.join(" | ");
  assert.match(steps, /Show your prices.*|Shows prices: you already do this on acme\.test/);
  assert.match(steps, /ChatGPT already says of Notion: "Notion — best flexible workspace for founders\."/);
  assert.match(steps, /FAQ headings/);
  assert.ok(s.moves.some((m) => m.kind === "listings" && m.steps[0].startsWith("roundup.test")), "get onto the roundup that names Notion, not you");
  assert.ok(s.moves.some((m) => m.kind === "forums"));
});

test("before any page is read, the story says so instead of inventing gaps", () => {
  const s = plain(S.rivalStory(M, "Notion", {}));
  assert.equal(s.read, 0); assert.equal(s.yoursRead, 0); assert.ok(s.checks.every((c) => !c.they && !c.you));
  assert.equal(s.moves[0].kind, "page"); assert.match(s.moves[0].steps[0], /Match the shape/);
  assert.equal(S.rivalStory(M, "Nobody", {}), null);
});

test("a competitor AI never named: its own website is compared with yours, and the answers say who AI names instead", () => {
  const site = PG.pageFeatures(`<html><body><h1>Meridian</h1><h2>Pricing</h2><p>Meridian is built for agencies. Plans from $29 per month.</p>${filler}</body></html>`, { brands: [] });
  const M2 = { ...M, profile: { ...M.profile, competitors: ["Notion", "Meridian"], competitorSites: { Meridian: "https://meridian.test" } } };
  const s = plain(S.rivalStory(M2, "Meridian", { pages: { "https://meridian.test": site }, yours: [{ url: "https://acme.test/", features: yourHome }] }));
  assert.equal(s.notNamed, true); assert.equal(s.of, 4); assert.equal(s.siteRead, true);
  const by = Object.fromEntries(s.checks.map((c) => [c.key, c]));
  assert.equal(by.bestFor.they.sample, "Meridian is built for agencies."); assert.equal(by.pricing.they.sample, "$29 per month"); assert.equal(by.pricing.you.short, "acme.test");
  assert.deepEqual(s.leaders, ["Notion", "Granola"]);
  const none = plain(S.rivalStory({ ...M2, profile: { ...M2.profile, competitorSites: {} } }, "Meridian", {}));
  assert.equal(none.notNamed, true); assert.equal(none.site, null, "no website given: the card asks for one");
});

test("pages on a competitor's given website count as its own site, whatever the domain is called", () => {
  const I = window.WP_INTEL;
  assert.equal(I.siteOwner("help.meridianhq.io", { profile: { competitorSites: { Meridian: "https://meridianhq.io" } } }), "Meridian");
  assert.equal(I.siteOwner("other.io", { profile: { competitorSites: { Meridian: "https://meridianhq.io" } } }), null);
});
