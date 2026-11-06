// The Claude engine in api/ask.js, against a faked Anthropic stream (no network, no key spent).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { claude } from "../api/ask.js";
import { engines } from "../api/_lib.js";

const sse = (events) => new Response(new ReadableStream({ start(c) { const enc = new TextEncoder(); for (const e of events) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
const happy = (extra = []) => [
  { type: "message_start", message: { model: "claude-opus-5-5", role: "assistant" } },
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query": "best voice' } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ' dictation app"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.com/best?utm=1", title: "Best apps" }, { type: "web_search_result", url: "https://b.com/x", title: "B" }] } },
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Try Wispr Flow " } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "or Superwhisper." } },
  { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://a.com/best", title: "Best apps", cited_text: "x" } } },
  ...extra,
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
];
let calls, saved;
const fakeFetch = (resp) => { globalThis.fetch = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return typeof resp === "function" ? resp() : resp; }; };
const run = (brand = { name: "Perfstaq", country: "IN" }) => { const out = { events: [] }; return claude("best dictation app", brand, (t, d) => out.events.push([t, d])).then((r) => ({ ...out, r }), (e) => ({ ...out, err: e })); };
beforeEach(() => { calls = []; saved = { fetch: globalThis.fetch, key: process.env.ANTHROPIC_API_KEY, model: process.env.PETTLE_CLAUDE_MODEL }; process.env.ANTHROPIC_API_KEY = "test-key"; delete process.env.PETTLE_CLAUDE_MODEL; });
afterEach(() => { globalThis.fetch = saved.fetch; for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["PETTLE_CLAUDE_MODEL", saved.model]]) v === undefined ? delete process.env[k] : (process.env[k] = v); });

test("streams the answer, the searches it ran and the sources, citations marked", async () => {
  fakeFetch(() => sse(happy()));
  const { r, events, err } = await run(); assert.equal(err, undefined);
  assert.equal(r.text, "Try Wispr Flow or Superwhisper.");
  assert.deepEqual(events.filter(([t]) => t === "search").map(([, d]) => d.query), ["best voice dictation app"]);
  assert.equal(r.sources.length, 2, "the same page under two URLs is one source");
  assert.deepEqual(r.sources.map((s) => [s.url, s.cited]), [["https://a.com/best?utm=1", true], ["https://b.com/x", false]]);
  assert.equal(r.model, "claude-opus-5-5"); assert.equal(events.filter(([t]) => t === "delta").length, 2);
});

test("asks for web search, in the buyer's country, with the current default model and refusal fallback", async () => {
  fakeFetch(() => sse(happy())); await run();
  const { url, opts, body } = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(opts.headers["x-api-key"], "test-key"); assert.equal(opts.headers["anthropic-version"], "2023-06-01");
  assert.equal(body.model, "claude-opus-5-5"); assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "IN" } }]);
  assert.equal(body.fallbacks, "default"); assert.equal(opts.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal("thinking" in body, false, "thinking is left to the model default");
});

test("a model without the fallback feature gets neither the field nor the beta header", async () => {
  process.env.PETTLE_CLAUDE_MODEL = "claude-haiku-5-5"; fakeFetch(() => sse(happy())); await run();
  assert.equal(calls[0].body.model, "claude-haiku-5-5"); assert.equal("fallbacks" in calls[0].body, false); assert.equal("anthropic-beta" in calls[0].opts.headers, false);
});

test("a refusal is an error, never an answer that names nobody", async () => {
  fakeFetch(() => sse([{ type: "message_start", message: { model: "m" } }, { type: "message_delta", delta: { stop_reason: "refusal" } }]));
  assert.match((await run()).err.message, /declined/);
});

test("a paused turn with no text, and an empty answer, are errors", async () => {
  fakeFetch(() => sse([{ type: "message_delta", delta: { stop_reason: "pause_turn" } }])); assert.match((await run()).err.message, /paused/);
  fakeFetch(() => sse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }])); assert.match((await run()).err.message, /no answer/);
});

test("API failures read plainly", async () => {
  fakeFetch(() => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })); assert.match((await run()).err.message, /rejected the API key/);
  fakeFetch(() => new Response(JSON.stringify({ error: { message: "Your credit balance is too low" } }), { status: 400 })); assert.match((await run()).err.message, /credits are used up/);
  fakeFetch(() => sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])); assert.match((await run()).err.message, /Overloaded/);
});

test("a failed web search is reported but the answer still stands", async () => {
  fakeFetch(() => sse(happy([{ type: "content_block_start", index: 3, content_block: { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } } }])));
  const { r, events } = await run(); assert.equal(r.text, "Try Wispr Flow or Superwhisper."); assert.ok(events.some(([t, d]) => t === "status" && /max_uses_exceeded/.test(d.text)));
});

test("the engine is offered only when an Anthropic key is set", () => {
  assert.ok(engines().includes("claude")); delete process.env.ANTHROPIC_API_KEY; assert.ok(!engines().includes("claude"));
});
