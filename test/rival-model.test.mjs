// The rival model (public/rival-model.js), loaded in a VM like the page loads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { visibilityScore as serverScore } from "../server/metrics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
function load() {
  const window = {}, ctx = vm.createContext({ window });
  for (const f of ["product-language.js", "recommendation-model.js", "rival-model.js"]) vm.runInContext(read("public/" + f), ctx, { filename: f });
  return window.WP_RIVAL_MODEL;
}
const R = load();

let seed = 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const ENGINES = ["chatgpt", "gemini", "perplexity"], INTENTS = ["informational", "commercial", "transactional"];
const ans = (qid, engine, sample, x) => ({ qid, engine, sample, status: "yes", named: false, rank: null, answer: "text", brands: [], sent: {}, ...x });
function world(nq, samples, pYou, pRival, extra = {}) {
  const questions = Array.from({ length: nq }, (_, i) => ({ id: "q" + i, text: "P" + i, intent: INTENTS[i % 3] })), answers = {};
  for (const q of questions) for (const e of ENGINES) for (let k = 0; k < samples; k++) {
    const named = rnd() < pYou(q, e), r = rnd() < pRival(q, e);
    answers[`${q.id}|${e}|${k}`] = ans(q.id, e, k, { named, rank: named ? 1 : null, brands: r ? ["Rival"] : [] });
  }
  return { profile: { name: "Me", competitors: ["Rival"] }, engines: ENGINES, questions, answers, inspections: {}, ...extra };
}

test("score formula matches the server's visibilityScore", () => {
  for (const x of [{}, { vis: 0.5 }, { vis: 0.4, sov: 0.2, leaderSov: 0.4, position: 2, sentiment: 70 }, { vis: 1, sov: 1, leaderSov: 1, position: 1, sentiment: 100 }, { vis: 0.1, position: 9, sentiment: 10 }])
    assert.equal(R.visibilityScore(x), serverScore(x));
});

test("name variants of one company are one rival, and only safe variants merge", () => {
  assert.equal(R.canon("Fireflies.ai"), R.canon("Fireflies"));
  assert.equal(R.canon("Notion Inc"), R.canon("notion"));
  assert.notEqual(R.canon("Google"), R.canon("Google Workspace"));
  const M = { profile: { name: "Me", competitors: ["Fireflies"] }, answers: {
    a: ans("q0", "chatgpt", 0, { brands: ["Fireflies.ai", "Otter"] }), b: ans("q1", "chatgpt", 0, { brands: ["Fireflies", "Otter.ai"] }) }, questions: [{ id: "q0", intent: "commercial" }, { id: "q1", intent: "commercial" }] };
  const P = R.profiles(M, {});
  assert.equal(P.rivals.filter((r) => r.key === R.canon("Fireflies")).length, 1);
  assert.equal(P.rivals.find((r) => r.key === R.canon("Fireflies")).mentions, 2);
  assert.equal(P.rivals.find((r) => r.key === R.canon("Otter")).mentions, 2);
});

test("a brand that is never named reads as 'not named', not as a rank in a long tail", () => {
  const M = world(6, 1, () => 0, (q) => 0.6);
  const P = R.profiles(M, {});
  assert.equal(P.you.mentions, 0);
  assert.match(R.verdict(P, R.mainRival(P, {})), /didn't name you in any of the 18 answers/);
  assert.equal(R.mainRival(P, {}).rival.name, "Rival");
});

test("ignoring a rival hides it but never changes your score", () => {
  const M = world(12, 2, () => 0.4, () => 0.5);
  const all = R.profiles(M, {}), hid = R.profiles(M, { prefs: { ignored: ["Rival"] } });
  assert.equal(hid.rivals.length, 0); assert.equal(hid.ignored.length, 1);
  assert.equal(hid.you.score, all.you.score); assert.equal(hid.rank, all.rank);
});

test("main rival: a chosen one wins; otherwise the closest one above you, among tracked rivals", () => {
  const M = { profile: { name: "Me", competitors: ["Big", "Mid", "Low"] }, questions: [{ id: "q0", intent: "commercial" }], answers: {} };
  const named = (brands, me) => ans("q0", "chatgpt", M.n = (M.n || 0) + 1, { brands, named: me, rank: me ? 1 : null });
  for (let i = 0; i < 10; i++) { const a = named(["Big", ...(i < 6 ? ["Mid"] : []), ...(i < 2 ? ["Low"] : [])], i < 4); M.answers["a" + i] = a; }
  const P = R.profiles(M, {});
  assert.equal(R.mainRival(P, {}).rival.name, "Mid"); assert.equal(R.mainRival(P, {}).why, "nearest-above");
  assert.equal(R.mainRival(P, { main: "Low" }).why, "chosen");
  assert.equal(R.mainRival(P, { main: "Low", ignored: ["Low"] }).why, "nearest-above", "an ignored rival cannot be the main one");
});

test("preferences are sanitised", () => {
  const p = R.normalizePrefs({ main: " X ", ignored: ["a", "a", "", 5, "x"], extra: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { main: null, ignored: ["a", "5", "x"] });
  assert.deepEqual(JSON.parse(JSON.stringify(R.normalizePrefs(undefined))), { main: null, ignored: [] });
});

test("finds planted strengths and weaknesses", () => {
  // You are weak at the decision stage and on Perplexity; the rival is thin on Gemini.
  const M = world(30, 2, (q) => (q.intent === "transactional" ? 0.1 : 0.55), (q, e) => (e === "perplexity" ? 0.85 : e === "gemini" ? 0.1 : 0.5));
  const x = R.strengthsAndWeaknesses(M, "Rival");
  const text = (k) => x[k].map((i) => i.text).join(" | ");
  assert.match(text("youWeak"), /decision-stage/); assert.match(text("youWeak"), /Perplexity/);
  assert.match(text("theyVulnerable"), /thin on Gemini/); assert.match(text("theyStrong"), /Perplexity names Rival/);
});

test("too few answers: no claims, and the result says so", () => {
  const x = R.strengthsAndWeaknesses(world(1, 1, () => 0, () => 1), "Rival", {});
  assert.equal(x.n, 3); assert.equal(x.enough, false);
  assert.deepEqual([x.youWin, x.youWeak, x.theyStrong, x.theyVulnerable].map((a) => a.length), [0, 0, 0, 0].map(Number));
});

test("noise: when you and the rival are tied, a statistical claim is rare", () => {
  let worlds = 0, flagged = 0;
  for (let t = 0; t < 200; t++) {
    const x = R.strengthsAndWeaknesses(world(20, 1, () => 0.4, () => 0.4), "Rival", {}); worlds++;
    if ([...x.youWin, ...x.youWeak, ...x.theyVulnerable].some((i) => i.kind === "stage" || i.kind === "engine")) flagged++;
  }
  assert.ok(flagged / worlds <= 0.1, `false-alarm rate ${flagged / worlds}`);
});

test("pages that name a rival, with whether you are on them", () => {
  const M = { profile: { name: "Me" }, answers: {}, questions: [], inspections: {
    a: { ok: true, url: "https://x.com/best", domain: "x.com", rivals: ["Rival"], you: false, n: 4 },
    b: { ok: true, url: "https://y.com/top", domain: "y.com", rivals: ["Rival.ai"], you: true, n: 2 },
    c: { ok: false, url: "https://blocked.com", rivals: ["Rival"] } } };
  const s = R.sourcesFor(M, "Rival");
  assert.deepEqual(JSON.parse(JSON.stringify(s.map((p) => [p.domain, p.you]))), [["x.com", false], ["y.com", true]], "an unreadable page is never counted");
});

test("a trailing AI is the same brand: lists say 'Notion AI', answers say 'Notion'", () => {
  assert.equal(R.canon("Notion AI"), R.canon("Notion")); assert.equal(R.canon("ClickUp AI"), R.canon("clickup"));
  assert.equal(R.canon("Jasper.ai"), R.canon("Jasper")); assert.equal(R.canon("AI"), "ai", "a bare AI is left alone");
  assert.notEqual(R.canon("Google AI Studio"), R.canon("Google"), "only a trailing AI, not one in the middle");
});
