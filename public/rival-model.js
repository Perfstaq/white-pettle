/* WhitePetal rival model: pure functions over a completed (or partial) run, no DOM, no state.
   Plain script loaded after recommendation-model.js and before app.js (window.WP_RIVAL_MODEL);
   tests load it in a VM the same way.

   What it answers: how does each rival score (same formula as server/metrics.mjs), who is the main rival,
   and for one rival, where you win, where you are weak, where they are strong and where they are vulnerable.

   Rules:
   - Only completed answers count (the recommendation model's isCompleted). Missing data is never a weakness.
   - A strength or weakness needs MIN_ANSWERS completed answers behind it; below that we say "not enough answers".
   - Everything is "AI named them more often", never "they are better". These are observed counts, not causes.
   - The headline score never depends on the rivals a person tracks or ignores: scores are measured against
     every brand AI named. Tracking and ignoring only change what is shown. */
(function (root) {
  "use strict";

  const MIN_ANSWERS = 6; // fewer completed answers than this behind a claim is too little to say anything
  const GAP = 0.15;      // and the gap must be at least this big...
  const Z = 2.58;        // ...and pass a two-proportion test, so a tie is not reported as a lead (about 5% false alarms)
  // True when two shares, each measured on n answers, really differ (not just run-to-run noise).
  const differs = (a, b, n) => { if (n < MIN_ANSWERS || Math.abs(a - b) < GAP) return false; const p = (a + b) / 2, se = Math.sqrt((2 * p * (1 - p)) / n); return se > 0 && Math.abs(a - b) / se >= Z; };
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // One company, one key: "Fireflies.ai" and "Fireflies", "Notion Inc" and "Notion" must not be counted as two rivals.
  // Only safe changes (domain endings, company suffixes). "Google" and "Google Workspace" stay separate: that is a product call.
  const canon = (s) => norm(String(s || "").replace(/\.(ai|com|io|app|co|so|org|net)\b/gi, " ")).replace(/\b(inc|ltd|llc|pvt|corp|corporation|limited|technologies|labs)\b/g, " ").replace(/\s+/g, " ").trim()
    // "Notion AI" is Notion: answers name the company, lists often add the feature. A bare "AI" stays as it is.
    .replace(/^(.{3,}?)\s+ai$/, "$1");
  const RM = () => root.WP_RECOMMENDATION_MODEL;
  const completed = (a) => RM().isCompleted(a);
  const avg = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : null);
  const pct = (v) => Math.round(100 * v) + "%";
  const STAGE = { discovery: "discovery", consideration: "consideration", decision: "decision" };
  const STAGE_ORDER = ["decision", "consideration", "discovery"];
  const stageOf = (intent) => RM().gapTypeFor(intent);

  // Same formula as visibilityScore in server/metrics.mjs and app.js (a parity test pins them together).
  function visibilityScore({ vis = 0, sov = 0, leaderSov = 0, position = null, sentiment = null }) {
    const posF = position ? Math.max(0, Math.min(1, (6 - position) / 5)) : 0;
    const sovRel = leaderSov ? Math.min(1, sov / leaderSov) : 0;
    const sent = sentiment == null ? 0.5 : sentiment / 100;
    return Math.round(100 * (0.5 * vis + 0.2 * sovRel + 0.2 * posF + 0.1 * (vis ? sent : 0)));
  }

  // What a person chose: one main rival, and rivals to hide. Anything else in the stored value is dropped.
  function normalizePrefs(raw) {
    const clean = (s) => String(s || "").trim().slice(0, 80);
    const ignored = [...new Set((Array.isArray(raw?.ignored) ? raw.ignored : []).map(clean).filter(Boolean))].slice(0, 100);
    const main = clean(raw?.main);
    return { main: main && !ignored.some((n) => canon(n) === canon(main)) ? main : null, ignored };
  }

  const brandTest = (M, isYou) => (typeof isYou === "function" ? isYou : (name) => {
    const n = norm(name);
    return [M?.profile?.name, ...(M?.profile?.aliases || [])].map(norm).filter(Boolean).some((y) => n === y || (" " + n + " ").includes(" " + y + " "));
  });

  function answersOf(M, engine) {
    return Object.values(M?.answers || {}).filter((a) => completed(a) && (!engine || engine === "all" || a.engine === engine));
  }

  // Every brand AI named (plus the tracked ones), scored the same way as the person's own brand.
  function profiles(M, { isYou, prefs, engine } = {}) {
    const you = brandTest(M, isYou), P = normalizePrefs(prefs);
    const A = answersOf(M, engine), B = new Map(), YOU = "\u0000you";
    const tracked = new Set((M?.profile?.competitors || []).map(canon).filter(Boolean));
    const get = (name) => {
      const isMe = you(name), k = isMe ? YOU : canon(name); if (!k) return null;
      if (!B.has(k)) B.set(k, { key: isMe ? "you" : k, name: isMe ? M?.profile?.name || "You" : String(name).trim(), you: isMe, mentions: 0, pos: [], sent: [] });
      return B.get(k);
    };
    get(M?.profile?.name); tracked.forEach((k) => { const r = get(k); if (r && !r.you) r.name = (M.profile.competitors || []).find((n) => canon(n) === k) || r.name; });
    let total = 0;
    for (const a of A) {
      const seen = new Set();
      (a.brands || []).forEach((b, i) => { const r = get(b); if (!r || seen.has(r.key)) return; seen.add(r.key); r.mentions++; r.pos.push(i + 1); total++; });
      if (a.named && !seen.has("you")) { const r = B.get(YOU); r.mentions++; if (a.rank) r.pos.push(a.rank); total++; seen.add("you"); }
      for (const [n, v] of Object.entries(a.sent || {})) { const r = get(n); if (r && seen.has(r.key) && typeof v === "number") r.sent.push(Math.max(0, Math.min(100, v))); }
    }
    const all = [...B.values()].map((r) => ({
      key: r.key, name: r.name, you: r.you, mentions: r.mentions, n: A.length,
      vis: A.length ? r.mentions / A.length : 0, sov: total ? r.mentions / total : 0, position: avg(r.pos), sentiment: avg(r.sent),
      win: A.length ? r.pos.filter((p) => p === 1).length / A.length : 0,
      tracked: !r.you && tracked.has(r.key), ignored: !r.you && P.ignored.some((n) => canon(n) === r.key),
    })).filter((r) => r.mentions || r.you || r.tracked);
    const leaderSov = Math.max(0, ...all.map((r) => r.sov));
    all.forEach((r) => { r.score = visibilityScore({ vis: r.vis, sov: r.sov, leaderSov, position: r.position, sentiment: r.sentiment }); });
    all.sort((a, b) => b.score - a.score || b.vis - a.vis || (a.position ?? 99) - (b.position ?? 99) || (a.you ? 1 : 0) - (b.you ? 1 : 0));
    const me = all.find((r) => r.you) || null;
    // A rank among a long tail of brands named once means little: rank among you, tracked rivals and brands named at least twice.
    const field = all.filter((r) => r.you || r.tracked || r.mentions >= 2);
    return { n: A.length, you: me, rank: me ? field.indexOf(me) + 1 : 0, of: field.length, all, rivals: all.filter((r) => !r.you && !r.ignored), ignored: all.filter((r) => r.ignored) };
  }

  // The rival every comparison anchors on: the one a person starred, else the closest one above them
  // (beatable), else the strongest one below when they already lead.
  function mainRival(P, prefs) {
    const want = normalizePrefs(prefs).main, rivals = P?.rivals || [];
    const chosen = want && rivals.find((r) => r.key === canon(want));
    if (chosen) return { rival: chosen, why: "chosen" };
    if (!P?.you || !rivals.length) return { rival: rivals[0] || null, why: rivals.length ? "strongest" : "none" };
    // Compare against rivals the person tracks when there are any; a brand named once is not who they mean.
    const pool = rivals.some((r) => r.tracked) ? rivals.filter((r) => r.tracked) : rivals.filter((r) => r.mentions >= 2).length ? rivals.filter((r) => r.mentions >= 2) : rivals;
    if (!P.you.mentions) return { rival: pool[0], why: "strongest" };
    const above = pool.filter((r) => r.score > P.you.score).sort((a, b) => a.score - b.score)[0];
    if (above) return { rival: above, why: "nearest-above" };
    return { rival: pool[0], why: "closest-behind" };
  }

  // One plain sentence for the top of the Competitors page.
  function verdict(P, main) {
    if (!P?.you || !P.n) return "Run a check to see how you compare.";
    const lead = P.rivals[0], gap = lead ? lead.score - P.you.score : 0;
    if (!P.you.mentions) return `AI didn't name you in any of the ${P.n} answers.${lead ? ` ${lead.name} leads, named in ${pct(lead.vis)} of them.` : ""}`;
    const head = `You're #${P.rank} of ${P.of} in AI visibility.`;
    if (!lead) return head;
    const parts = [gap > 0 ? `${lead.name} leads by ${gap} point${gap === 1 ? "" : "s"}.` : "You lead the field."];
    const m = main?.rival;
    if (m && m.key !== lead.key && m.score > P.you.score) parts.push(`${m.name} is the closest rival above you (+${m.score - P.you.score}).`);
    return [head, ...parts].join(" ");
  }

  // Share of completed answers that name you and a given rival, overall, per stage, per engine and per prompt.
  function headToHead(M, rivalKey, { isYou, engine } = {}) {
    const you = brandTest(M, isYou), A = answersOf(M, engine), key = canon(rivalKey);
    const names = (a, who) => (who === "you" ? !!a.named || (a.brands || []).some((b) => you(b)) : (a.brands || []).some((b) => canon(b) === key));
    const rate = (as) => ({ n: as.length, you: as.length ? as.filter((a) => names(a, "you")).length / as.length : 0, rival: as.length ? as.filter((a) => names(a, "rival")).length / as.length : 0 });
    const qOf = new Map((M?.questions || []).map((q) => [q.id, q]));
    const group = (f) => { const m = new Map(); for (const a of A) { const g = f(a); if (g == null) continue; (m.get(g) || m.set(g, []).get(g)).push(a); } return m; };
    const byStage = {}; for (const [k, as] of group((a) => (qOf.get(a.qid) ? stageOf(qOf.get(a.qid).intent) : null))) byStage[k] = rate(as);
    const byEngine = {}; for (const [k, as] of group((a) => a.engine)) byEngine[k] = rate(as);
    const prompts = [...group((a) => a.qid)].map(([id, as]) => { const q = qOf.get(id) || {}; return { id, text: q.text || "", stage: q.intent ? stageOf(q.intent) : null, ...rate(as) }; });
    const rp = A.flatMap((a) => { const i = (a.brands || []).findIndex((b) => canon(b) === key); return i >= 0 ? [i + 1] : []; });
    const sent = A.flatMap((a) => { const k = Object.keys(a.sent || {}).find((n) => canon(n) === key); return k && typeof a.sent[k] === "number" ? [a.sent[k]] : []; });
    return { overall: rate(A), byStage, byEngine, prompts, rivalPosition: avg(rp), rivalWin: A.length ? rp.filter((p) => p === 1).length / A.length : 0, rivalSentiment: avg(sent), rivalSentimentN: sent.length };
  }

  // Cited pages that name a rival, and whether you are on them too. Strongest evidence of what carries a rival.
  function sourcesFor(M, rivalKey) {
    const key = canon(rivalKey);
    return Object.values(M?.inspections || {}).filter((p) => p && p.ok && (p.rivals || []).some((r) => canon(r) === key))
      .map((p) => ({ url: p.final || p.url, domain: p.domain || "", title: p.title || "", you: !!p.you, n: p.n || 1 })).sort((a, b) => b.n - a.n);
  }

  const engineName = (e) => ({ chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", claude: "Claude", groq: "Groq", aio: "Google AI Overviews", aimode: "Google AI Mode" }[e] || e);

  // The four boxes for one rival. Each item: { text, detail?, weight, prompts? } with weight used to order items.
  function strengthsAndWeaknesses(M, rivalName, opts = {}) {
    const rival = String(rivalName || "").trim(), h = headToHead(M, rival, opts);
    const out = { rival, n: h.overall.n, enough: h.overall.n >= MIN_ANSWERS, youWin: [], youWeak: [], theyStrong: [], theyVulnerable: [], h };
    if (!out.enough) return out;
    const stageW = (s) => 3 - Math.max(0, STAGE_ORDER.indexOf(s));
    for (const s of STAGE_ORDER) {
      const x = h.byStage[s]; if (!x) continue;
      if (x.rival > x.you && differs(x.rival, x.you, x.n)) out.youWeak.push({ kind: "stage", text: `On ${STAGE[s]}-stage prompts you're named in ${pct(x.you)} of answers; ${rival} in ${pct(x.rival)}.`, weight: stageW(s) * 10 + (x.rival - x.you) * 10, n: x.n });
      else if (x.you > x.rival && differs(x.you, x.rival, x.n)) out.youWin.push({ kind: "stage", text: `You lead ${rival} on ${STAGE[s]}-stage prompts: named in ${pct(x.you)} of answers vs ${pct(x.rival)}.`, weight: stageW(s) * 10 + (x.you - x.rival) * 10, n: x.n });
    }
    for (const [e, x] of Object.entries(h.byEngine)) {
      if (x.n < MIN_ANSWERS) continue;
      if (x.rival > x.you && differs(x.rival, x.you, x.n)) out.youWeak.push({ kind: "engine", text: `On ${engineName(e)} you're named in ${pct(x.you)} of answers; ${rival} in ${pct(x.rival)}.`, weight: (x.rival - x.you) * 10, n: x.n });
      else if (x.you > x.rival && differs(x.you, x.rival, x.n)) out.youWin.push({ kind: "engine", text: `On ${engineName(e)} you lead ${rival}: ${pct(x.you)} vs ${pct(x.rival)}.`, weight: (x.you - x.rival) * 10, n: x.n });
      if (x.n >= MIN_ANSWERS && x.rival >= 0.5) out.theyStrong.push({ kind: "engine", text: `${engineName(e)} names ${rival} in ${pct(x.rival)} of its answers.`, weight: x.rival * 10, n: x.n });
      else if (x.rival < h.overall.rival && differs(h.overall.rival, x.rival, x.n)) out.theyVulnerable.push({ kind: "engine", text: `${rival} is thin on ${engineName(e)}: ${pct(x.rival)} of answers, against ${pct(h.overall.rival)} overall.`, weight: (h.overall.rival - x.rival) * 10, n: x.n });
    }
    const behind = h.prompts.filter((p) => p.n >= 1 && p.rival >= 0.5 && p.you === 0).sort((a, b) => stageW(b.stage) - stageW(a.stage) || b.rival - a.rival);
    if (behind.length) out.youWeak.push({ kind: "prompts", text: `${behind.length} prompt${behind.length === 1 ? "" : "s"} where ${rival} is named and you never are.`, weight: 5 + behind.length, n: behind.length, prompts: behind.slice(0, 5) });
    const ahead = h.prompts.filter((p) => p.n >= 1 && p.you >= 0.5 && p.rival === 0).sort((a, b) => b.you - a.you);
    if (ahead.length) out.youWin.push({ kind: "prompts", text: `${ahead.length} prompt${ahead.length === 1 ? "" : "s"} where you're named and ${rival} never is.`, weight: 5 + ahead.length, n: ahead.length, prompts: ahead.slice(0, 5) });
    if (h.overall.n >= MIN_ANSWERS && h.rivalWin >= 0.4) out.theyStrong.push({ kind: "win", text: `${rival} is named first in ${pct(h.rivalWin)} of answers.`, weight: h.rivalWin * 10, n: h.overall.n });
    if (h.rivalSentimentN >= 3) {
      if (h.rivalSentiment >= 65) out.theyStrong.push({ kind: "sentiment", text: `AI describes ${rival} positively (${Math.round(h.rivalSentiment)}/100).`, weight: 4, n: h.rivalSentimentN });
      else if (h.rivalSentiment < 45) out.theyVulnerable.push({ kind: "sentiment", text: `AI is lukewarm about ${rival} (${Math.round(h.rivalSentiment)}/100).`, weight: 6, n: h.rivalSentimentN });
    }
    if (h.rivalPosition != null && h.rivalPosition >= 3.5 && h.overall.rival * h.overall.n >= 4) out.theyVulnerable.push({ kind: "position", text: `${rival} is usually named late: average place #${h.rivalPosition.toFixed(1)}.`, weight: 5, n: h.overall.n });
    const src = sourcesFor(M, rival);
    if (src.length) {
      const onBoth = src.filter((s) => s.you).length;
      out.theyStrong.push({ kind: "sources", text: `${rival} is named on ${src.length} page${src.length === 1 ? "" : "s"} AI cites${onBoth ? `; you're on ${onBoth} of them` : "; you're on none of them"}.`, weight: 3 + Math.min(5, src.length), n: src.length, sources: src.slice(0, 5) });
    }
    for (const k of ["youWin", "youWeak", "theyStrong", "theyVulnerable"]) out[k].sort((a, b) => b.weight - a.weight);
    return out;
  }

  root.WP_RIVAL_MODEL = Object.freeze({ canon, MIN_ANSWERS, GAP, Z, differs, visibilityScore, normalizePrefs, profiles, mainRival, verdict, headToHead, sourcesFor, strengthsAndWeaknesses, norm });
})(typeof window !== "undefined" ? window : globalThis);
