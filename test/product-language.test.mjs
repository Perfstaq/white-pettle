// The product-language contract (public/product-language.js) and the static copy guard.
// The browser file is loaded in a VM exactly as the page loads it: a plain script that sets window.WP_LANGUAGE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
// Objects from the VM realm have other prototypes; compare plain copies.
const plain = (x) => JSON.parse(JSON.stringify(x));

function load() {
  const window = {};
  vm.runInNewContext(read("public/product-language.js"), { window }, { filename: "product-language.js" });
  return window.WP_LANGUAGE;
}

test("product-language: exposes a deeply frozen window.WP_LANGUAGE", () => {
  const L = load();
  assert.ok(L, "window.WP_LANGUAGE is set");
  const walk = (o, path) => {
    if (o && (typeof o === "object" || typeof o === "function")) {
      assert.ok(Object.isFrozen(o), `${path} is frozen`);
      for (const k of Object.keys(o)) walk(o[k], `${path}.${k}`);
    }
  };
  walk(L, "WP_LANGUAGE");
  assert.throws(() => { "use strict"; L.NAV.push({}); });
  assert.throws(() => { "use strict"; L.COPY.home.headline = "x"; });
});

test("product-language: canonical navigation follows the new information architecture", () => {
  const L = load();
  assert.deepEqual(plain(L.NAV.map((s) => [s.section, s.items.map((i) => i.label)])), [
    ["Home", ["Recommendation risk", "Evidence readiness"]],
    ["Gaps", ["Buyer questions", "Recommendation gaps", "AI answers"]],
    ["Why they win", ["Evidence sources", "Competitor advantages", "Search influence"]],
    ["Recovery", ["Recovery plan", "Drafts"]],
    ["Progress", ["Competitive landscape", "Change over time"]],
  ]);
  // Existing route keys stay where a screen already exists, so later tasks can relabel without breaking state.
  const byKey = Object.fromEntries(L.NAV.flatMap((s) => s.items.map((i) => [i.key, i.label])));
  assert.equal(byKey.overview, "Recommendation risk");
  assert.equal(byKey.site, "Evidence readiness");
  assert.equal(byKey.prompts, "Buyer questions");
  assert.equal(byKey.gaps, "Recommendation gaps");
  assert.equal(byKey.chats, "AI answers");
  assert.equal(byKey.domains, "Evidence sources");
  assert.equal(byKey.gap, "Competitor advantages");
  assert.equal(byKey.rankings, "Search influence");
  assert.equal(byKey.actions, "Recovery plan");
  assert.equal(byKey.ranking, "Competitive landscape");
  assert.equal(L.LABELS.rerun, "Recheck recommendations");
  assert.equal(L.LABELS.agent, "Ask WhitePetal");
});

test("product-language: intents map to discovery, consideration and decision gaps", () => {
  const L = load();
  assert.equal(L.GAP_TYPES.informational.gapType, "discovery");
  assert.equal(L.GAP_TYPES.commercial.gapType, "consideration");
  assert.equal(L.GAP_TYPES.transactional.gapType, "decision");
  assert.equal(L.GAP_TYPES.informational.label, "Discovery gap");
  assert.equal(L.GAP_TYPES.commercial.label, "Consideration gap");
  assert.equal(L.GAP_TYPES.transactional.label, "Decision gap");
  assert.deepEqual(plain(L.GAP_ORDER), ["decision", "consideration", "discovery"]);
});

test("product-language: lifecycle labels match the recovery_actions statuses, with no Done", () => {
  const L = load();
  assert.deepEqual(plain(L.LIFECYCLE.map((s) => s.status)), ["suggested", "drafting", "ready_for_review", "approved", "published", "recheck_scheduled", "result_observed", "archived"]);
  assert.deepEqual(plain(L.LIFECYCLE.map((s) => s.label)), ["Suggested", "Drafting", "Ready for review", "Approved", "Published/sent", "Recheck scheduled", "Result observed", "Archived"]);
  assert.ok(!L.LIFECYCLE.some((s) => /^done$/i.test(s.label)));
});

test("product-language: positioning and onboarding copy", () => {
  const L = load();
  assert.equal(L.COPY.category, "AI recommendation intelligence and recovery");
  assert.equal(L.COPY.promise, "Find the recommendation gaps. Fix the evidence. Track the recovery.");
  assert.equal(L.COPY.home.eyebrow, "AI recommendation intelligence for brands");
  assert.equal(L.COPY.home.headline, "When buyers ask AI what to choose, does your brand make the answer?");
  assert.equal(L.COPY.home.cta, "Find my recommendation gaps");
  assert.match(L.COPY.home.subhead, /^WhitePetal checks the questions buyers ask ChatGPT, Gemini and Perplexity/);
  assert.equal(L.COPY.home.proof.join(" → "), "Buyer questions → Competing recommendations → Trusted evidence → Recovery actions");
  assert.equal(L.COPY.onboarding.market, "Where are the buyers whose decisions matter?");
  assert.equal(L.COPY.onboarding.run, "Check where AI leaves us out");
  assert.equal(L.COPY.onboarding.ready, "We found your first recommendation gaps");
  assert.equal(L.COPY.accountGate, "Create an account to save this brand and run live recommendation checks.");
});

test("product-language: scoped claim helpers implement the 03 templates", () => {
  const L = load(), C = L.claims;
  assert.equal(C.zeroCoverage({ engine: "ChatGPT", brand: "Perfstaq", total: 20 }), "ChatGPT did not name Perfstaq in any of 20 tracked answers in this check.");
  assert.equal(C.partialCoverage({ engine: "Gemini", brand: "Perfstaq", named: 3, total: 10 }), "Perfstaq appeared in 3/10 tracked Gemini answers in this check.");
  assert.equal(C.coverage({ engine: "Gemini", brand: "Perfstaq", named: 0, total: 10 }), C.zeroCoverage({ engine: "Gemini", brand: "Perfstaq", total: 10 }));
  assert.equal(C.coverage({ engine: "Gemini", brand: "Perfstaq", named: 0, total: 0 }), C.insufficient());
  assert.equal(C.competitorContrast({ competitor: "Acme", brand: "Perfstaq", n: 6 }), "Acme appeared in 6 of the same answers. The cited sources below mention Acme but not Perfstaq.");
  assert.equal(C.actionRationale({ question: "best running shoes" }), "This action addresses an observed evidence gap for best running shoes. It may strengthen the information available to AI systems; it does not guarantee inclusion.");
  assert.equal(C.movement({ before: "0/10", after: "2/10" }), "After publication, recommendation coverage changed from 0/10 to 2/10 in the next comparable check. This is an observed association, not proof that one action caused the change.");
  assert.equal(C.insufficient(), "WhitePetal does not yet have enough comparable answers to call this a trend.");
  assert.equal(C.scope({ engine: "ChatGPT", date: "11 Oct 2026", market: "India", questions: 20, answers: 40 }), "ChatGPT · 11 Oct 2026 · India · 20 buyer questions · 40 answers");
  assert.equal(C.pursueInclusion("g2.com"), "Pursue inclusion on g2.com");
  assert.equal(C.strengthenEvidence("best crm"), "Strengthen evidence for “best crm”");
});

test("product-language: the prohibited-term checker flags outcome claims and allows scoped or negated uses", () => {
  const L = load();
  const terms = (t) => plain(L.findProhibited(t).map((f) => f.term));
  assert.deepEqual(terms("This page will get you named."), ["get you named"]);
  assert.deepEqual(terms("the fastest way into AI answers"), ["fastest way"]);
  assert.deepEqual(terms("still the biggest single lever"), ["biggest single lever"]);
  assert.deepEqual(terms("Draft a page to win it"), ["win it"]);
  assert.deepEqual(terms("AI says: wrong"), ["unscoped AI says"]);
  assert.deepEqual(terms("ChatGPT on 11 Oct: AI says you are expensive"), []);
  assert.deepEqual(terms("We guarantee rankings"), ["guarantee"]);
  assert.deepEqual(terms("it does not guarantee inclusion"), []);
  assert.deepEqual(terms("AI-proof your brand"), ["AI-proof"]);
  assert.deepEqual(terms("customers stolen by rivals; revenue lost"), ["customers stolen", "revenue lost"]);
  assert.deepEqual(terms("Get named on g2.com"), ["get named"]);
  assert.equal(L.findProhibited("a\nb fastest way")[0].line, 2);
});

test("product-language: its own copy passes the checker", () => {
  const L = load();
  const strings = [];
  const walk = (o) => { if (typeof o === "string") strings.push(o); else if (o && typeof o === "object") Object.values(o).forEach(walk); };
  walk({ NAV: L.NAV, LABELS: L.LABELS, GAP_TYPES: L.GAP_TYPES, LIFECYCLE: L.LIFECYCLE, COPY: L.COPY });
  const C = L.claims;
  strings.push(C.zeroCoverage({ engine: "E", brand: "B", total: 1 }), C.partialCoverage({ engine: "E", brand: "B", named: 1, total: 2 }), C.competitorContrast({ competitor: "X", brand: "B", n: 1 }), C.actionRationale({ question: "q" }), C.movement({ before: "0/1", after: "1/1" }), C.insufficient());
  assert.deepEqual(plain(strings.flatMap((s) => L.findProhibited(s).map((f) => `${f.term}: ${s}`))), []);
});

/* ---- static copy scan of user-facing code ----
   TODO(painkiller tasks 2, 3, 5, 6, 8, 10): these are the violations present when the guard was added.
   Each later task that rewrites the screen must delete the matching entries; Task 10 must leave this list empty.
   The test fails both on a new violation and on a stale entry (one that no longer occurs), so the list only shrinks. */
const KNOWN_VIOLATIONS = [
  { file: "public/index.html", term: "get you named", count: 2 }, // meta description + og:description (Task 3)
  { file: "public/index.html", term: "get named", count: 1 },     // landing "how it works" step 03 (Task 3)
  { file: "public/app.js", term: "unscoped AI says", count: 5 },  // file header + step comment, "what AI says" phase, "AI says:" action title, Perception subtitle (Tasks 5, 6, 8)
  { file: "public/app.js", term: "fastest way", count: 2 },       // agent console thought + Gap analysis subtitle (Task 6)
  { file: "public/app.js", term: "get named", count: 2 },         // "Get named on" action title + pitch modal title (Tasks 6, 8)
  { file: "public/app.js", term: "win it", count: 1 },            // Mention gaps "Draft a page to win it" (Task 5)
  { file: "public/app.js", term: "biggest single lever", count: 1 }, // Search rankings subtitle (Task 6)
];

function scanTargets() {
  const pub = readdirSync(join(ROOT, "public")).filter((f) => /\.(js|html)$/.test(f) && f !== "product-language.js").map((f) => "public/" + f);
  return [...pub, "api/write.js"];
}

test("copy guard: user-facing code carries no new prohibited outcome claims", () => {
  const L = load();
  const found = {};
  const where = {};
  for (const file of scanTargets()) {
    for (const f of L.findProhibited(read(file))) {
      const k = file + "\u0000" + f.term;
      found[k] = (found[k] || 0) + 1;
      (where[k] = where[k] || []).push(`${file}:${f.line}: ${f.match}`);
    }
  }
  const allowed = Object.fromEntries(KNOWN_VIOLATIONS.map((v) => [v.file + "\u0000" + v.term, v.count]));
  const problems = [];
  for (const [k, n] of Object.entries(found)) {
    const a = allowed[k] || 0;
    if (n > a) problems.push(`new prohibited phrase (${n} found, ${a} allowlisted):\n    ${where[k].join("\n    ")}`);
  }
  for (const [k, a] of Object.entries(allowed)) {
    const n = found[k] || 0;
    if (n < a) problems.push(`stale allowlist entry "${k.replace("\u0000", " → ")}": ${a} allowlisted, ${n} found. Lower or delete it in KNOWN_VIOLATIONS.`);
  }
  if (Object.keys(found).length) console.log("Known prohibited copy still to remove (allowlisted):\n  " + Object.values(where).flat().join("\n  "));
  assert.deepEqual(problems, []);
});

test("copy guard: product-language.js loads before app.js in index.html", () => {
  const html = read("public/index.html");
  const at = (src) => html.indexOf(`src="/${src}`);
  assert.ok(at("product-language.js") > 0, "product-language.js is loaded");
  assert.ok(at("product-language.js") < at("app.js"), "product-language.js loads before app.js");
});
