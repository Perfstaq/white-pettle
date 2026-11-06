// Buyer segment: competitor suggestions and every draft are written for the segment the brand sells to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SEGMENTS, segmentOf, competitorRules } from "../api/_lib.js";
import { PROMPTS } from "../api/write.js";

const profile = (segment) => ({ name: "Perfstaq", site: "perfstaq.com", category: "voice-first founder workspace", offer: "Run your startup by talking", audience: "founders", competitors: ["Notion"], segment });

test("segments: three sizes, unknown values are no segment", () => {
  assert.deepEqual(Object.keys(SEGMENTS), ["smb", "mid", "enterprise"]);
  assert.equal(segmentOf({ segment: "smb" }).label, "Solo founders and small businesses");
  for (const v of ["", undefined, "SMB ", "huge"]) assert.equal(segmentOf({ segment: v }), null, String(v));
});

test("competitor rules: same job first, real products only, then the segment filter", () => {
  const none = competitorRules({}), smb = competitorRules({ segment: "smb" }), ent = competitorRules({ segment: "enterprise" });
  assert.ok(none.indexOf("Same job first") < none.indexOf("Only real products"));
  assert.doesNotMatch(none, /Segment:/, "no segment, no segment rule");
  assert.match(smb, /leave out vendors that mainly sell to large enterprises/);
  assert.match(ent, /leave out tools built mainly for individuals or very small teams/);
  assert.ok(smb.indexOf("Same job first") < smb.indexOf("Segment:"), "the segment filters; it never overrides the job");
});

test("the competitor writer covers every size in one call, tags each one, and skips the person's own picks", () => {
  const p = PROMPTS.competitors({ profile: profile("smb"), siteText: "Run your startup by talking.", keep: ["Granola"] });
  assert.match(p, /"size":"smb\|mid\|enterprise\|all"/); assert.match(p, /4-5 for each of smb, mid and enterprise/);
  assert.match(p, /do not repeat\): Granola/);
  assert.doesNotMatch(p, /Buyer segment/, "every size is asked for, whatever the brand's own segment");
  assert.match(p, /Competitors: -/, "the previous suggestions are not shown, so they don't anchor the new list");
  assert.match(p, /Same job first/);
});

test("drafts know today's date: no 'Last updated: June 2024'", () => {
  const month = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const art = PROMPTS.article({ profile: profile(""), question: "Best dictation app", rivals: [] });
  assert.ok(art.includes(`Last updated: ${month}`), "the article ends with this month, not one the model guesses");
  for (const kind of ["article", "pitch", "questions", "topics", "competitors"]) assert.ok(PROMPTS[kind]({ profile: profile("smb"), question: "q", rivals: [], t: { url: "https://x.test", title: "x" }, count: 3 }).includes(`Today: ${month}`), kind);
});

test("every draft knows who buys once a segment is set, and says nothing about it when it isn't", () => {
  for (const kind of ["article", "pitch", "questions", "topics"]) {
    const data = { profile: profile("smb"), question: "Best dictation app", rivals: [], t: { url: "https://x.test", title: "x" }, count: 5 };
    assert.match(PROMPTS[kind](data), /Buyer segment .*solo founders/, kind);
    assert.doesNotMatch(PROMPTS[kind]({ ...data, profile: profile("") }), /Buyer segment/, kind + " without a segment");
  }
});

test("the site scan guesses the segment and suggests competitors with the same rules", () => {
  const src = readFileSync(new URL("../api/site.js", import.meta.url), "utf8");
  assert.match(src, /"segment":"who mainly buys/); assert.match(src, /competitorRules\(\{\}\)/); assert.match(src, /segment: SEGMENTS\[/);
});
