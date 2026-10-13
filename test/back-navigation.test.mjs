// Back from Team / Plans & payment / Account returns to the screen you left, never to "the most recently saved brand" (public/app.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const a = src.indexOf("// Team, Plans & payment and Account are side pages"), endMarker = "scrollTo({ top: 0 });\n}", b = src.indexOf(endMarker, a) + endMarker.length;
assert.ok(a > 0 && b > a, "navigation block found");
const block = src.slice(a, b);
const ALL = ["landing", "auth", "mission", "onboard", "ready", "reportWrap", "team", "billing", "account"];

function app({ visible, M = null, page = "overview" }) {
  const calls = [], els = Object.fromEntries(ALL.map((id) => [id, { hidden: id !== visible }]));
  const $ = (sel) => els[sel.slice(1)] || { hidden: true, remove() {} }, $$ = () => [];
  const env = { $, $$, SCREENS: ALL, APP: { M }, DASH: { page }, document: { body: { classList: { add() {}, remove() {} } } }, scrollTo() {},
    showReport: (p) => calls.push(["showReport", p]), showRunning: () => calls.push(["showRunning"]), goHome: () => calls.push(["goHome"]), home: () => calls.push(["home"]) };
  const fn = new Function(...Object.keys(env), `${block}; return { screen, backFromSide };`)(...Object.values(env));
  const open = (id) => { fn.screen(id); for (const k of ALL) els[k].hidden = k !== id; }; // screen() flips visibility in the app; mirror it
  return { calls, open, back: fn.backFromSide };
}

test("from a finished dashboard: Account, Plans & payment and Team all go back to that dashboard, on the same page", () => {
  for (const side of ["account", "billing", "team"]) {
    const t = app({ visible: "reportWrap", M: { slug: "acme", finishedAt: 1 }, page: "sources" });
    t.open(side); t.back(); assert.deepEqual(t.calls, [["showReport", "sources"]], side);
  }
});
test("chained side pages still return to where you started (Account -> Plans & payment -> Back)", () => {
  const t = app({ visible: "reportWrap", M: { slug: "acme", finishedAt: 1 } });
  t.open("account"); t.open("billing"); t.back(); assert.deepEqual(t.calls, [["showReport", "overview"]]);
});
test("from a running or paused analysis it goes back to that analysis, not to another brand", () => {
  const t = app({ visible: "ready", M: { slug: "acme" } });
  t.open("billing"); t.back(); assert.deepEqual(t.calls, [["showRunning"]]);
});
test("from the brand list it goes back to the brand list; with nothing to return to it falls back to home", () => {
  const l = app({ visible: "landing" }); l.open("team"); l.back(); assert.deepEqual(l.calls, [["goHome"]]);
  const n = app({ visible: "billing" }); n.back(); assert.deepEqual(n.calls, [["home"]], "opened directly: no screen to return to");
  const u = app({ visible: "reportWrap", M: { slug: "acme" } }); u.open("account"); u.back(); assert.deepEqual(u.calls, [["home"]], "an unfinished check is not shown as a dashboard");
});
test("the return target is used once", () => {
  const t = app({ visible: "reportWrap", M: { slug: "acme", finishedAt: 1 } });
  t.open("account"); t.back(); t.back(); assert.deepEqual(t.calls, [["showReport", "overview"], ["home"]]);
});
