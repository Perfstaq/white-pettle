// The app's plan-aware setup helpers (public/app.js "What the current plan allows"), run on the real code with the app's globals stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const a = src.indexOf("/* What the current plan allows"), b = src.indexOf("async function startOnboarding(");
assert.ok(a > 0 && b > a, "helper block found");
const block = src.slice(a, b);
function load({ billing, server = true }) {
  const APP = { cfg: { billing } }, DATA = { server: () => server };
  // eslint-disable-next-line no-new-func
  return new Function("APP", "DATA", "api", `let OB = null; ${block}; return { PLANL, promptCap, perOpts, effPer, setOB(v) { OB = v; } };`)(APP, DATA, async () => ({}));
}
const plan = (name, limits, features, used = {}) => ({ plan: { name }, limits: { questions: null, ...limits }, used: { questions: 0, ...used }, report: { features: { engines: ["chatgpt", "perplexity", "gemini"], schedules: ["off", "weekly"], competitors: 3, samples: 1, integrations: [], ...features } } });
const topics = (n) => Array.from({ length: n }, (_, i) => ({ name: "t" + i }));

test("a plan with 15 prompts generates at most 15, however many topics or prompts-per-topic are chosen", () => {
  const h = load({ billing: plan("Starter", { questions: 15 }) });
  h.setOB({ topics: topics(5), perTopic: 5, saved: null });
  assert.equal(h.promptCap(), 15); assert.deepEqual(h.perOpts(), [2, 3]); assert.equal(h.effPer(), 3, "5 per topic is cut to 3: 5 x 3 = 15");
  h.setOB({ topics: topics(5), perTopic: 2, saved: null }); assert.equal(h.effPer(), 2, "a smaller choice is respected");
  h.setOB({ topics: topics(8), perTopic: 3, saved: null }); assert.deepEqual(h.perOpts(), [1]); assert.equal(h.effPer(), 1, "8 topics leave room for 1 each");
  h.setOB({ topics: topics(20), perTopic: 3, saved: null }); assert.deepEqual(h.perOpts(), [], "more topics than prompts: nothing to offer, the page says to remove topics");
  for (const t of [3, 5, 7, 15]) for (const per of [2, 3, 4, 5]) { h.setOB({ topics: topics(t), perTopic: per, saved: null }); assert.ok(t * h.effPer() <= 15 || h.effPer() === 1, `${t} topics x ${per}`); }
});

test("the allowance is what is left: other brands' prompts count, this brand's own do not", () => {
  const h = load({ billing: plan("Growth", { questions: 30 }, {}, { questions: 12 }) });
  h.setOB({ topics: topics(5), perTopic: 5, saved: null }); assert.equal(h.promptCap(), 18, "30 - 12 already used by other brands");
  h.setOB({ topics: topics(5), perTopic: 5, saved: { questions: Array.from({ length: 7 }, () => ({ on: true })).concat([{ on: false }]) } });
  assert.equal(h.promptCap(), 25, "editing a brand that already holds 7 active prompts: 30 - (12 - 7)");
  assert.equal(load({ billing: plan("Starter", { questions: 15 }, {}, { questions: 15 }) }).PLANL.prompts(), 0, "a full plan leaves nothing");
});

test("competitors, engines, answers per prompt and schedules follow the plan", () => {
  const h = load({ billing: plan("Starter", { questions: 15 }) }), L = h.PLANL;
  assert.equal(L.rivals(), 3); assert.equal(L.samples(), 1); assert.deepEqual(L.engines(["chatgpt", "perplexity", "gemini", "aio", "claude"]), ["chatgpt", "perplexity", "gemini"]); assert.deepEqual(L.schedules(), ["off", "weekly"]);
  const e = load({ billing: plan("Enterprise", { questions: 300 }, { samples: 3, competitors: 20, schedules: ["off", "weekly", "daily"], engines: ["chatgpt", "aio"] }) }).PLANL;
  assert.equal(e.samples(), 3); assert.equal(e.rivals(), 20); assert.deepEqual(e.schedules(), ["off", "weekly", "daily"]); assert.deepEqual(e.engines(["chatgpt", "gemini", "aio"]), ["chatgpt", "aio"]);
});

test("unlimited when the plan has no limit or there are no accounts", () => {
  const legacy = load({ billing: plan("Legacy", { questions: null }, { competitors: null, samples: null, engines: ["chatgpt", "gemini"], schedules: ["off", "weekly", "daily"] }) });
  legacy.setOB({ topics: topics(9), perTopic: 5, saved: null });
  assert.equal(legacy.promptCap(), Infinity); assert.deepEqual(legacy.perOpts(), [2, 3, 4, 5]); assert.equal(legacy.effPer(), 5); assert.equal(legacy.PLANL.rivals(), Infinity); assert.equal(legacy.PLANL.samples(), 3);
  const none = load({ billing: plan("Starter", { questions: 15 }), server: false }); none.setOB({ topics: topics(9), perTopic: 5, saved: null });
  assert.equal(none.promptCap(), Infinity, "no accounts: no plan, no cap"); assert.deepEqual(none.PLANL.engines(["chatgpt", "claude"]), ["chatgpt", "claude"]);
  assert.equal(load({ billing: null }).PLANL.prompts(), Infinity);
});
