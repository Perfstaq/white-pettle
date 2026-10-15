import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck, setHandlers, answerKey } from "../../server/runner.mjs";
import { summarize } from "../../server/metrics.mjs";
import { fakes, WS } from "./_fake.mjs";

test("a scheduled run asks every tracked prompt × engine × sample and builds the full report", async () => {
  setHandlers(fakes);
  const M = await runCheck(WS, { engines: ["chatgpt", "gemini"] });
  assert.equal(M.questions.length, 2);               // the "off" prompt is skipped
  assert.equal(Object.keys(M.answers).length, 2 * 2 * 2);
  assert.ok(M.answers[answerKey("q1", "chatgpt", 1)]);
  const a = M.answers[answerKey("q1", "chatgpt", 0)];
  assert.equal(a.named, true); assert.equal(a.rank, 2); assert.equal(a.sent["Acme AI"], 70);
  assert.equal(M.answers[answerKey("q2", "gemini", 0)].named, false);
  assert.ok(Object.keys(M.inspections).length >= 1);
  assert.equal(M.perception.claims[0].verdict, "wrong");
  assert.match(M.insights, /Insight/);
  assert.ok(M.finishedAt && M.done.ask && M.done.sentiment && M.done.sources);
  assert.deepEqual(fakes.calls.write.slice(0, 1), ["sentiment"]);
  const s = summarize(M);
  assert.equal(s.visibility, 2 / 8);
  assert.equal(s.engines.chatgpt, 0.5);
});
test("drafts carry forward from the previous run", async () => {
  setHandlers(fakes);
  const M = await runCheck(WS, { engines: ["chatgpt"], samples: 1, prev: { assets: { llms_txt: "x" }, pitches: { "https://a": "hi" } } });
  assert.deepEqual(M.assets, { llms_txt: "x" }); assert.equal(M.pitches["https://a"], "hi");
});
test("a brand with no prompts fails clearly", async () => {
  await assert.rejects(runCheck({ ...WS, setup: { ...WS.setup, questions: [] } }, { engines: ["chatgpt"] }), /no prompts/);
});
test("the account's \"pages\" limit sets how many cited pages a scheduled check reads (default 18)", async () => {
  // Every answer cites 30 different pages, so the limit, not the supply, decides how many are opened.
  const { sse } = await import("../../api/_lib.js");
  const ask = async (req) => { const b = await req.json(); return sse(async (send) => {
    const sources = Array.from({ length: 30 }, (_, i) => ({ url: `https://site${i}.example/${b.engine}`, title: "p", cited: i < 3 }));
    send("final", { answer: "Options: Deloitte.", sources, brands: ["Deloitte"], model: "fake-1" }); }); };
  for (const [pages, want] of [[5, 5], [null, 18], [25, 25]]) {
    setHandlers({ ...fakes, ask }); fakes.calls.inspect = 0;
    const M = await runCheck(WS, { engines: ["chatgpt"], samples: 1, pages });
    assert.equal(fakes.calls.inspect, want, `pages ${pages}`); assert.equal(Object.keys(M.inspections).length, want);
  }
});
