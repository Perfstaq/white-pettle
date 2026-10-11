// The recommendation-gap decision model (public/recommendation-model.js), loaded in a VM like the page loads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

function load() {
  const window = {};
  const ctx = vm.createContext({ window });
  vm.runInContext(read("public/product-language.js"), ctx, { filename: "product-language.js" });
  vm.runInContext(read("public/recommendation-model.js"), ctx, { filename: "recommendation-model.js" });
  return { R: window.WP_RECOMMENDATION_MODEL, L: window.WP_LANGUAGE };
}

// A run shaped like app.js missions: questions carry intent; answers are keyed qid|engine[|sample]
// with status "run" | "err" | "yes" | "no", `named`, `rank`, `brands` in answer order, and `sources`.
const ans = (qid, engine, sample, x) => ({ qid, engine, sample, status: "no", named: false, rank: null, answer: "Some answer text.", brands: [], sources: [], searches: [], ...x });
function run(answers, extra = {}) {
  return {
    id: "r1", slug: "acme", startedAt: Date.UTC(2026, 9, 11, 10, 0), finishedAt: Date.UTC(2026, 9, 11, 10, 30), samples: 3,
    profile: { name: "Perfstaq", site: "perfstaq.com", market: "India", competitors: ["Rival One"] },
    engines: ["chatgpt", "gemini"],
    questions: [
      { id: "q1", intent: "transactional", text: "Where do I buy running shoes online?" },
      { id: "q2", intent: "commercial", text: "Best running shoe brands" },
      { id: "q3", intent: "informational", text: "How are running shoes made?" },
    ],
    answers: Object.fromEntries(answers.map((a) => [a.sample ? `${a.qid}|${a.engine}|${a.sample}` : `${a.qid}|${a.engine}`, a])),
    ...extra,
  };
}

test("model: a deeply frozen window.WP_RECOMMENDATION_MODEL", () => {
  const { R } = load();
  assert.ok(R && Object.isFrozen(R));
  assert.throws(() => { "use strict"; R.deriveGaps = null; });
  assert.ok(Object.isFrozen(R.GAP_TYPE_OF));
});

test("model: intent maps to gap type, including the legacy question intents", () => {
  const { R, L } = load();
  assert.equal(R.gapTypeFor("informational"), "discovery");
  assert.equal(R.gapTypeFor("commercial"), "consideration");
  assert.equal(R.gapTypeFor("transactional"), "decision");
  // Older runs stored best | alternatives | comparison | problem | local (api/write.js `questions`).
  assert.equal(R.normalizeIntent("problem"), "informational");
  assert.equal(R.normalizeIntent("best"), "commercial");
  assert.equal(R.normalizeIntent("alternatives"), "commercial");
  assert.equal(R.normalizeIntent("comparison"), "commercial");
  assert.equal(R.normalizeIntent("local"), "transactional");
  assert.equal(R.normalizeIntent(" Transactional "), "transactional");
  assert.equal(R.normalizeIntent(undefined), "commercial", "unknown intent falls back to commercial, as onboarding does");
  // Same mapping as the language contract.
  for (const i of ["informational", "commercial", "transactional"]) assert.equal(R.gapTypeFor(i), L.GAP_TYPES[i].gapType);
});

test("model: failed, unfinished, empty and not-shown answers are excluded, never counted as gaps", () => {
  const { R } = load();
  assert.equal(R.isCompleted(ans("q1", "chatgpt", 0, { status: "no" })), true);
  assert.equal(R.isCompleted(ans("q1", "chatgpt", 0, { status: "yes", named: true })), true);
  assert.equal(R.isCompleted(ans("q1", "chatgpt", 0, { status: "err", error: "429" })), false);
  assert.equal(R.isCompleted(ans("q1", "chatgpt", 0, { status: "run" })), false);
  assert.equal(R.isCompleted(ans("q1", "chatgpt", 0, { status: "no", absent: true })), false, "Google showed no AI answer");
  assert.equal(R.isCompleted(ans("q1", "chatgpt", 0, { status: "no", answer: "  ", brands: [] })), false, "empty answer");
  assert.equal(R.isCompleted(null), false);

  const M = run([
    ans("q1", "chatgpt", 0, { status: "err", error: "quota" }),
    ans("q1", "chatgpt", 1, { status: "err", error: "quota" }),
    ans("q1", "chatgpt", 2, { status: "no", answer: "", brands: [] }),
  ]);
  const g = R.assess(M, "q1", "chatgpt");
  assert.equal(g.answerCount, 3);
  assert.equal(g.completedAnswerCount, 0);
  assert.equal(g.evidenceState, "insufficient");
  assert.deepEqual(plain(R.deriveGaps(M)), [], "failed answers never become a gap");
});

test("model: zero completed answers is insufficient data, distinct from a gap", () => {
  const { R } = load();
  const M = run([]);
  const g = R.assess(M, "q2", "gemini");
  assert.equal(g.completedAnswerCount, 0);
  assert.equal(g.evidenceState, "insufficient");
  assert.equal(g.confidence, "low");
  const s = R.summarize(M);
  assert.equal(s.gaps.length, 0);
  assert.equal(s.included.length, 0);
  assert.equal(s.insufficient.length, 6, "3 questions × 2 engines, none answered");
});

test("model: derived gap object has exactly the 06 shape", () => {
  const { R } = load();
  const M = run([
    ans("q1", "chatgpt", 0, { brands: ["Rival One", "Other Co"], sources: [{ url: "https://www.g2.com/best-shoes" }, { url: "https://rival.com/a" }] }),
    ans("q1", "chatgpt", 1, { brands: ["Other Co", "Rival One"], sources: [{ url: "https://www.g2.com/best-shoes" }] }),
    ans("q1", "chatgpt", 2, { brands: ["Rival One"], sources: [] }),
  ]);
  const gaps = R.deriveGaps(M);
  assert.equal(gaps.length, 1);
  assert.deepEqual(plain(gaps[0]), {
    id: "gap:q1:chatgpt",
    questionId: "q1",
    question: "Where do I buy running shoes online?",
    intent: "transactional",
    gapType: "decision",
    engine: "chatgpt",
    checkedAt: "2026-10-11T10:30:00.000Z",
    market: "India",
    answerCount: 3,
    completedAnswerCount: 3,
    namedCount: 0,
    competitors: [{ name: "Rival One", mentions: 3, bestPosition: 1 }, { name: "Other Co", mentions: 2, bestPosition: 1 }],
    sources: [{ url: "https://www.g2.com/best-shoes", domain: "g2.com", citedCount: 2 }, { url: "https://rival.com/a", domain: "rival.com", citedCount: 1 }],
    confidence: "high",
    evidenceState: "observed",
  });
});

test("model: a gap needs a completed answer without the brand; any naming means included", () => {
  const { R } = load();
  const M = run([
    ans("q2", "chatgpt", 0, { status: "yes", named: true, rank: 2, brands: ["Rival One", "Perfstaq"] }),
    ans("q2", "chatgpt", 1, { brands: ["Rival One"] }),
    ans("q3", "gemini", 0, { brands: [] }),
  ]);
  const s = R.summarize(M);
  assert.deepEqual(plain(s.included.map((g) => g.id)), ["gap:q2:chatgpt"]);
  assert.equal(s.included[0].namedCount, 1);
  assert.deepEqual(plain(s.gaps.map((g) => [g.id, g.gapType])), [["gap:q3:gemini", "discovery"]]);
  // A gap with no competing brand is observed but cannot carry a strong competitor claim.
  assert.deepEqual(plain(s.gaps[0].competitors), []);
  assert.notEqual(s.gaps[0].confidence, "high");
});

test("model: partial evidence when some answers failed", () => {
  const { R } = load();
  const M = run([
    ans("q1", "gemini", 0, { brands: ["Rival One"] }),
    ans("q1", "gemini", 1, { status: "err", error: "timeout" }),
  ]);
  const g = R.assess(M, "q1", "gemini");
  assert.equal(g.answerCount, 2);
  assert.equal(g.completedAnswerCount, 1);
  assert.equal(g.evidenceState, "partial");
  assert.equal(g.confidence, "low");
});

test("model: competitor frequency counts each brand once per answer, excludes the brand, keeps best position", () => {
  const { R } = load();
  const isYou = (n) => /perfstaq/i.test(n);
  const freq = R.competitorFrequency([
    ans("q1", "chatgpt", 0, { brands: ["Rival One", "Perfstaq Inc", "rival one", "Zeta"] }),
    ans("q1", "chatgpt", 1, { brands: ["Zeta", "Rival One"] }),
    ans("q1", "chatgpt", 2, { brands: ["Zeta"] }),
  ], { isYou });
  assert.deepEqual(plain(freq), [{ name: "Zeta", mentions: 3, bestPosition: 1 }, { name: "Rival One", mentions: 2, bestPosition: 1 }]);
});

test("model: cited sources are counted per answer and grouped by domain", () => {
  const { R } = load();
  const src = R.citedSources([
    ans("q1", "chatgpt", 0, { sources: [{ url: "https://reddit.com/r/x" }, { url: "https://reddit.com/r/x" }, { url: "https://www.g2.com/a" }] }),
    ans("q1", "chatgpt", 1, { sources: [{ url: "https://g2.com/b" }, { url: "https://reddit.com/r/x" }] }),
  ]);
  assert.deepEqual(plain(src), [
    { url: "https://reddit.com/r/x", domain: "reddit.com", citedCount: 2 },
    { url: "https://www.g2.com/a", domain: "g2.com", citedCount: 1 },
    { url: "https://g2.com/b", domain: "g2.com", citedCount: 1 },
  ]);
  assert.deepEqual(plain(R.sourceDomains(src)), [{ domain: "reddit.com", citedCount: 2 }, { domain: "g2.com", citedCount: 2 }]);
});

test("model: confidence rules", () => {
  const { R } = load();
  assert.equal(R.confidenceFor({ answerCount: 0, completedAnswerCount: 0, competitorCount: 0 }), "low");
  assert.equal(R.confidenceFor({ answerCount: 1, completedAnswerCount: 1, competitorCount: 2 }), "low");
  assert.equal(R.confidenceFor({ answerCount: 2, completedAnswerCount: 2, competitorCount: 1 }), "medium");
  assert.equal(R.confidenceFor({ answerCount: 3, completedAnswerCount: 3, competitorCount: 1 }), "high");
  assert.equal(R.confidenceFor({ answerCount: 4, completedAnswerCount: 3, competitorCount: 1 }), "medium", "partial evidence caps at medium");
  assert.equal(R.confidenceFor({ answerCount: 3, completedAnswerCount: 3, competitorCount: 0 }), "medium", "no competing brand caps at medium");
});

test("model: gaps sort decision → consideration → discovery, then competitor frequency, then confidence", () => {
  const { R } = load();
  const M = run([
    ans("q3", "chatgpt", 0, { brands: ["Rival One"] }),
    ans("q2", "chatgpt", 0, { brands: ["Rival One"] }),
    ans("q2", "gemini", 0, { brands: ["Rival One"] }),
    ans("q2", "gemini", 1, { brands: ["Rival One"] }),
    ans("q1", "gemini", 0, { brands: [] }),
  ]);
  assert.deepEqual(plain(R.deriveGaps(M).map((g) => g.id)), ["gap:q1:gemini", "gap:q2:gemini", "gap:q2:chatgpt", "gap:q3:chatgpt"]);
  assert.deepEqual(plain(R.deriveGaps(M, { engines: ["chatgpt"] }).map((g) => g.id)), ["gap:q2:chatgpt", "gap:q3:chatgpt"]);
});

test("model: question-level gaps keep the dashboard's rule (absent everywhere, a competitor named)", () => {
  const { R } = load();
  const isYou = (n) => /perfstaq/i.test(n);
  const M = run([
    // q1: absent on both engines, rivals named → gap
    ans("q1", "chatgpt", 0, { brands: ["Rival One"], sources: [{ url: "https://g2.com/x" }] }),
    ans("q1", "gemini", 0, { brands: ["Rival One", "Zeta"], sources: [{ url: "https://g2.com/x" }, { url: "https://zeta.com" }] }),
    ans("q1", "gemini", 1, { status: "err" }),
    // q2: named on one engine → not a gap
    ans("q2", "chatgpt", 0, { status: "yes", named: true, brands: ["Perfstaq"] }),
    ans("q2", "gemini", 0, { brands: ["Rival One"] }),
    // q3: absent, but no competitor named → not a competitor-backed gap
    ans("q3", "chatgpt", 0, { brands: [] }),
  ]);
  const qg = R.questionGaps(M, { isYou });
  assert.equal(qg.length, 1);
  assert.equal(qg[0].questionId, "q1");
  assert.equal(qg[0].gapType, "decision");
  assert.equal(qg[0].answers.length, 2, "failed answer excluded");
  assert.deepEqual(plain(qg[0].competitors.map((c) => [c.name, c.mentions])), [["Rival One", 2], ["Zeta", 1]]);
  assert.deepEqual(plain(R.sourceDomains(qg[0].sources)), [{ domain: "g2.com", citedCount: 2 }, { domain: "zeta.com", citedCount: 1 }]);
  assert.deepEqual(plain(qg[0].engines), ["chatgpt", "gemini"]);
  assert.equal(R.questionGaps(M, { isYou, engines: ["chatgpt"] }).length, 1, "q1 on chatgpt only");
  assert.deepEqual(plain(R.questionGaps(M, { isYou, engines: ["gemini"] }).map((g) => g.questionId)), ["q1", "q2"], "q2 is a gap when only Gemini is in view");
  // Without the competitor requirement (the action deck's "no engine named you"): q3 counts; failed-only questions never do.
  const M2 = run([...Object.values(M.answers), ans("q4", "chatgpt", 0, { status: "err" })], { questions: [...M.questions, { id: "q4", intent: "commercial", text: "Failed only" }] });
  assert.deepEqual(plain(R.questionGaps(M2, { isYou, requireCompetitor: false }).map((g) => g.questionId)), ["q1", "q3"]);
});

test("model: comparable runs need the same normalized question, engine, market and sample definition", () => {
  const { R } = load();
  const a = run([], {});
  const b = run([], { id: "r2", questions: [{ id: "q9", intent: "transactional", text: "where do I buy  running shoes online" }] });
  const sa = R.scopeOf(a, "q1", "chatgpt"), sb = R.scopeOf(b, "q9", "chatgpt");
  assert.deepEqual(plain(sa), { questionKey: "where do i buy running shoes online", engine: "chatgpt", market: "india", samples: 3 });
  assert.equal(R.isComparable(sa, sb), true, "question ids may differ; normalized text matches");
  assert.equal(R.isComparable(sa, { ...plain(sb), engine: "gemini" }), false);
  assert.equal(R.isComparable(sa, { ...plain(sb), market: "united states" }), false);
  assert.equal(R.isComparable(sa, { ...plain(sb), samples: 1 }), false);
  assert.equal(R.isComparable(sa, { ...plain(sb), questionKey: "best running shoes" }), false);
  assert.equal(R.isComparable(sa, null), false);
  assert.equal(R.normalizeMarket(""), "global");
  assert.equal(R.scopeOf(a, "nope", "chatgpt"), null);
});

test("model: coverage change is only reported between comparable checks", () => {
  const { R } = load();
  assert.equal(R.coverageDirection({ named: 0, total: 3 }, { named: 1, total: 3 }, true), "improved");
  assert.equal(R.coverageDirection({ named: 1, total: 3 }, { named: 1, total: 3 }, true), "unchanged");
  assert.equal(R.coverageDirection({ named: 2, total: 3 }, { named: 0, total: 3 }, true), "regressed");
  assert.equal(R.coverageDirection({ named: 0, total: 3 }, { named: 3, total: 3 }, false), "incomparable");
  assert.equal(R.coverageDirection({ named: 0, total: 0 }, { named: 1, total: 3 }, true), "incomparable", "no completed answers before");
});

test("model: index.html loads the model after the language contract and before app.js", () => {
  const html = read("public/index.html");
  const at = (src) => html.indexOf(`src="/${src}`);
  assert.ok(at("product-language.js") > 0 && at("recommendation-model.js") > at("product-language.js"));
  assert.ok(at("recommendation-model.js") < at("app.js"));
});

test("model: app.js uses the model instead of its own gap calculations", () => {
  const app = read("public/app.js");
  assert.match(app, /WP_RECOMMENDATION_MODEL/);
  // The old inline rules (Mention gaps page and the nav count) are gone.
  assert.doesNotMatch(app, /if \(!as\.length \|\| as\.some\(\(a\) => a\.named\)\) return null;/);
  assert.doesNotMatch(app, /const gapsN = M\.questions\.filter\(/);
  // The action deck's "no engine named you" counted questions whose answers had all failed.
  assert.doesNotMatch(app, /M\.engines\.every\(\(e\) => !answersOf\(M, q\.id, e\)\.some\(\(a\) => a\.named\)\)/);
});
