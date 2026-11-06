// The competitive intelligence model (public/intel-model.js), loaded in a VM like the page loads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (f) => readFileSync(new URL("../public/" + f, import.meta.url), "utf8");
const window = {}, ctx = vm.createContext({ window });
for (const f of ["product-language.js", "recommendation-model.js", "rival-model.js", "intel-model.js"]) vm.runInContext(read(f), ctx, { filename: f });
const I = window.WP_INTEL;
const plain = (x) => JSON.parse(JSON.stringify(x));

// Q1 (decision): Notion first in both answers -> led. Q2 (consideration): split -> contested. Q3: nobody named -> open. Q4: you named.
const src = (url, cited = true) => ({ url, title: "", cited });
const a = (qid, engine, brands, sources = [], x = {}) => ({ qid, engine, sample: 0, status: "yes", answer: x.answer || `Options: ${brands.join(", ")}.`, brands, sources, named: false, rank: null, ...x });
function run() {
  const answers = {
    "q1|chatgpt": a("q1", "chatgpt", ["Notion", "Granola"], [src("https://www.notion.com/help/notes"), src("https://reddit.com/r/x/1"), src("https://techradar.com/best", false)], { answer: "**Notion** — best if you already live in Notion. See [notion.com](https://notion.com). Use Notion if you want:" }),
    "q1|claude": a("q1", "claude", ["Notion", "Krisp"], [src("https://notion.com/pricing"), src("https://reddit.com/r/x/2"), src("https://techradar.com/best")]),
    "q2|chatgpt": a("q2", "chatgpt", ["Granola", "Notion", "Krisp"], [src("https://reddit.com/r/y"), src("https://g2.com/cat")]),
    "q2|claude": a("q2", "claude", ["Krisp", "Granola"], [src("https://krisp.ai/blog")]),
    "q3|chatgpt": a("q3", "chatgpt", [], []), "q3|claude": a("q3", "claude", [], []),
    "q4|chatgpt": a("q4", "chatgpt", ["Acme", "Notion"], [src("https://reddit.com/r/z")], { named: true, rank: 1 }),
    "q4|claude": a("q4", "claude", ["Notion"], [src("https://reddit.com/r/w")]),
  };
  return { profile: { name: "Acme", competitors: ["Notion", "Granola"] }, engines: ["chatgpt", "claude"], answers,
    questions: [{ id: "q1", text: "Which tool should I buy?", intent: "transactional" }, { id: "q2", text: "Best meeting notes app", intent: "commercial" }, { id: "q3", text: "How do notes apps work?", intent: "informational" }, { id: "q4", text: "Alternatives to Notion", intent: "commercial" }] };
}

test("a brand's own site is recognised from its domain labels; other sites get a type", () => {
  assert.equal(I.ownedDomain("help.fathom.video", ["Fathom", "Krisp"]), "Fathom");
  assert.equal(I.ownedDomain("docs.wisprflow.ai", ["Wispr Flow"]), "Wispr Flow");
  assert.equal(I.ownedDomain("notion.com", ["Notion"]), "Notion");
  assert.equal(I.ownedDomain("techradar.com", ["Notion"]), null);
  assert.equal(I.ownedDomain("ai.com", ["AI"]), null, "a name under 3 letters never claims a domain");
  assert.equal(I.domainType("g2.com", null), "Review / directory"); assert.equal(I.domainType("reddit.com", null), "Forum");
  assert.equal(I.domainType("notion.com", "Notion"), "Brand's own site"); assert.equal(I.domainType("techradar.com", null), "Article / publisher");
});

test("every prompt is led, contested, open, or yours", () => {
  const bg = plain(I.battleground(run(), {}));
  const by = Object.fromEntries(bg.map((p) => [p.id, p]));
  assert.equal(by.q1.status, "led"); assert.equal(by.q1.owner, "Notion"); assert.equal(by.q1.ownerFirst, 2); assert.equal(by.q1.stage, "decision");
  assert.equal(by.q2.status, "contested", "Granola and Krisp are each first once");
  assert.equal(by.q3.status, "open"); assert.equal(by.q4.status, "you"); assert.equal(by.q4.youShare, 0.5);
});

test("pages behind the answers: counted once per answer, with the brands in those answers and whether you were", () => {
  const s = plain(I.sourceMap(run(), {})), d = Object.fromEntries(s.map((x) => [x.domain, x]));
  assert.equal(d["reddit.com"].answers, 5); assert.equal(d["reddit.com"].youIn, 1); assert.equal(d["reddit.com"].type, "Forum");
  assert.equal(d["notion.com"].owner, "Notion", "www. is ignored"); assert.equal(d["notion.com"].answers, 2);
  assert.equal(d["techradar.com"].cited, 1, "read in one answer, cited in the other");
  assert.ok(!d["reddit.com"].brands.some((b) => b.name === "Acme"), "you are never one of the rivals");
  const hid = plain(I.sourceMap(run(), { prefs: { ignored: ["Krisp"] } }));
  assert.ok(!hid.some((x) => x.brands.some((b) => b.name === "Krisp")), "a hidden brand is left out");
  assert.equal(hid.find((x) => x.domain === "krisp.ai").owner, null);
});

test("how AI describes a brand: clean sentences, no markdown, no dangling lead-ins", () => {
  const d = plain(I.descriptors(run(), "Notion"));
  assert.ok(d.length >= 1); assert.equal(d[0].text, "Notion — best if you already live in Notion.");
  assert.ok(d.every((x) => !/[*[\]]|:$/.test(x.text)), JSON.stringify(d));
});

test("the playbook: shared pages once, rival-specific pages separately, and nothing claimed below the noise line", () => {
  const pb = plain(I.playbook(run(), {}));
  const kinds = pb.map((p) => p.kind);
  assert.ok(kinds.includes("white-space")); assert.ok(kinds.includes("own-content"), "Notion's own site was used in 2 answers");
  const own = pb.find((p) => p.kind === "own-content"); assert.equal(own.rival, "Notion"); assert.match(own.move, /Which tool should I buy\?/);
  assert.ok(!kinds.includes("engine-gap"), "2 answers per engine is never enough to call an engine weak");
  const hub = pb.find((p) => p.kind === "hubs");
  if (hub) for (const l of pb.filter((p) => p.kind === "listings")) for (const e of l.evidence) assert.ok(!hub.evidence.some((h) => h.split(":")[0] === e.split(" ")[0]), "a shared page is never repeated per rival");
  for (let i = 1; i < pb.length; i++) assert.ok(pb[i - 1].impact >= pb[i].impact, "ranked by evidence");
});

test("engines only disagree about a brand when the gap is bigger than run-to-run noise", () => {
  const M = run(); const mx = plain(I.engineMatrix(M, {}));
  assert.deepEqual(mx.engines, ["chatgpt", "claude"]); assert.equal(mx.disagree.length, 0);
  assert.equal(mx.rows.find((r) => r.you).engines.chatgpt.vis, 0.25);
  // 20 answers per engine: Notion in every ChatGPT answer, in none of Claude's -> a real difference.
  const big = { ...M, answers: {}, questions: [{ id: "z", text: "z", intent: "commercial" }] };
  for (let i = 0; i < 20; i++) { big.answers["c" + i] = a("z", "chatgpt", ["Notion", "Krisp"]); big.answers["k" + i] = a("z", "claude", ["Krisp"]); }
  const d = plain(I.engineMatrix(big, {})).disagree;
  assert.equal(d.length, 1); assert.equal(d[0].name, "Notion"); assert.equal(d[0].hi, "chatgpt");
});
