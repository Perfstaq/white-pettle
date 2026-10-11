/* WhitePetal recommendation-gap model: pure functions over a completed (or partial) run, no DOM, no state.
   Plain script loaded after product-language.js and before app.js (window.WP_RECOMMENDATION_MODEL);
   tests load it in a VM the same way.

   Rules (06-DATA-STATE-CONTRACTS):
   - Only completed answers count: status "yes"/"no", shown (not `absent`), and not empty. A failed, unfinished
     or empty answer is missing data, never a gap.
   - Zero completed answers for a question × engine is "insufficient", distinct from a gap.
   - A recommendation gap needs at least one completed answer and the brand named in none of them.
   - A competitor claim needs a competing brand in the same completed answer set.
   - Before/after needs the same normalized question, engine, market and sample definition. */
(function (root) {
  "use strict";

  const deepFreeze = (o) => {
    if (o && (typeof o === "object" || typeof o === "function") && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach((k) => deepFreeze(o[k]));
    }
    return o;
  };
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const host = (u) => String(u || "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/?#]*@/, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./i, "").toLowerCase();

  // Intent → gap type. Older runs stored best | alternatives | comparison | problem | local.
  const GAP_TYPE_OF = { informational: "discovery", commercial: "consideration", transactional: "decision" };
  const INTENT_ALIASES = {
    informational: "informational", info: "informational", research: "informational", problem: "informational",
    commercial: "commercial", comparison: "commercial", compare: "commercial", alternatives: "commercial", best: "commercial",
    transactional: "transactional", local: "transactional", action: "transactional", buy: "transactional",
  };
  const GAP_ORDER = ["decision", "consideration", "discovery"];
  const CONF_RANK = { low: 0, medium: 1, high: 2 };

  const normalizeIntent = (i) => INTENT_ALIASES[String(i || "").toLowerCase().replace(/[^a-z]/g, "")] || "commercial";
  const gapTypeFor = (i) => GAP_TYPE_OF[normalizeIntent(i)];
  const normalizeQuestion = (t) => norm(t);
  const normalizeMarket = (m) => norm(m) || "global";

  const isCompleted = (a) => !!a && (a.status === "yes" || a.status === "no") && !a.absent
    && (String(a.answer || "").trim() !== "" || (a.brands || []).length > 0 || !!a.named);
  const isFailed = (a) => !!a && a.status === "err";

  // The brand test app.js uses (name equals, or contains, one of the brand's names), as a fallback.
  const brandMatcher = (run, isYou) => {
    if (typeof isYou === "function") return isYou;
    const names = [run?.profile?.name, ...(run?.profile?.aliases || [])].map(norm).filter(Boolean);
    return (name) => { const n = norm(name); return names.some((y) => n === y || (" " + n + " ").includes(" " + y + " ")); };
  };

  const answersFor = (run, qid, engine) => Object.values(run?.answers || {})
    .filter((a) => a && a.qid === qid && a.engine === engine)
    .sort((x, y) => (x.sample || 0) - (y.sample || 0));

  // Each competing brand counted once per answer; bestPosition is its best 1-based place in an answer's brand list.
  function competitorFrequency(answers, { isYou = () => false } = {}) {
    const by = new Map();
    for (const a of answers || []) {
      const seen = new Set();
      (a.brands || []).forEach((b, i) => {
        const k = norm(b); if (!k || isYou(b) || seen.has(k)) return; seen.add(k);
        const r = by.get(k) || { name: String(b).trim(), mentions: 0, bestPosition: null };
        r.mentions++; r.bestPosition = r.bestPosition == null ? i + 1 : Math.min(r.bestPosition, i + 1);
        by.set(k, r);
      });
    }
    return [...by.values()].sort((x, y) => y.mentions - x.mentions);
  }

  // Each URL counted once per answer that cites it.
  function citedSources(answers) {
    const by = new Map();
    for (const a of answers || []) {
      const seen = new Set();
      for (const s of a.sources || []) {
        const url = String(s?.url || "").trim(); if (!url || seen.has(url)) continue; seen.add(url);
        const r = by.get(url) || { url, domain: host(url), citedCount: 0 };
        r.citedCount++; by.set(url, r);
      }
    }
    return [...by.values()].sort((x, y) => y.citedCount - x.citedCount);
  }
  function sourceDomains(sources) {
    const by = new Map();
    for (const s of sources || []) { const d = s.domain || host(s.url); if (!d) continue; by.set(d, (by.get(d) || 0) + (s.citedCount || 1)); }
    return [...by.entries()].map(([domain, citedCount]) => ({ domain, citedCount })).sort((x, y) => y.citedCount - x.citedCount);
  }

  // high: 3+ completed answers, none failed, a competing brand observed. medium: 2+, or capped by partial
  // evidence / no competitor. low: one answer, or none.
  function confidenceFor({ answerCount = 0, completedAnswerCount = 0, competitorCount = 0 }) {
    if (completedAnswerCount <= 1) return "low";
    if (completedAnswerCount >= 3 && completedAnswerCount >= answerCount && competitorCount > 0) return "high";
    return "medium";
  }

  const iso = (t) => { if (t == null || t === "") return null; const d = new Date(t); return isNaN(d) ? null : d.toISOString(); };

  // One question × engine, in the 06 gap shape, whether or not it turns out to be a gap.
  function assess(run, questionId, engine, opts = {}) {
    const q = (run?.questions || []).find((x) => x.id === questionId) || { id: questionId, text: "", intent: "" };
    const isYou = brandMatcher(run, opts.isYou);
    const all = answersFor(run, questionId, engine).filter((a) => !a.absent);
    const done = all.filter(isCompleted);
    const competitors = competitorFrequency(done, { isYou });
    const intent = normalizeIntent(q.intent);
    return {
      id: `gap:${questionId}:${engine}`,
      questionId,
      question: q.text || "",
      intent,
      gapType: GAP_TYPE_OF[intent],
      engine,
      checkedAt: iso(run?.finishedAt || run?.startedAt),
      market: run?.profile?.market || "Global",
      answerCount: all.length,
      completedAnswerCount: done.length,
      namedCount: done.filter((a) => a.named).length,
      competitors,
      sources: citedSources(done),
      confidence: confidenceFor({ answerCount: all.length, completedAnswerCount: done.length, competitorCount: competitors.length }),
      evidenceState: !done.length ? "insufficient" : done.length < all.length ? "partial" : "observed",
    };
  }

  const isGap = (g) => g.completedAnswerCount > 0 && g.namedCount === 0;
  const topMentions = (g) => (g.competitors[0] ? g.competitors[0].mentions : 0);
  const sortGaps = (gaps) => gaps.slice().sort((x, y) => GAP_ORDER.indexOf(x.gapType) - GAP_ORDER.indexOf(y.gapType)
    || topMentions(y) - topMentions(x) || CONF_RANK[y.confidence] - CONF_RANK[x.confidence]);

  // Every question × engine in view, split into gaps (sorted by severity), included, and insufficient data.
  function summarize(run, opts = {}) {
    const engines = opts.engines || run?.engines || [];
    const out = { gaps: [], included: [], insufficient: [] };
    for (const q of run?.questions || []) for (const e of engines) {
      const g = assess(run, q.id, e, opts);
      (g.completedAnswerCount === 0 ? out.insufficient : isGap(g) ? out.gaps : out.included).push(g);
    }
    out.gaps = sortGaps(out.gaps);
    return out;
  }
  const deriveGaps = (run, opts) => summarize(run, opts).gaps;

  // Question-level view across the engines in view (the dashboard's Mention gaps rule): completed answers exist,
  // the brand is named in none of them, and at least one competing brand is (unless requireCompetitor: false).
  // Question order is kept.
  function questionGaps(run, opts = {}) {
    const engines = opts.engines || run?.engines || [];
    const isYou = brandMatcher(run, opts.isYou);
    const out = [];
    for (const q of run?.questions || []) {
      const answers = engines.flatMap((e) => answersFor(run, q.id, e)).filter(isCompleted);
      if (!answers.length || answers.some((a) => a.named)) continue;
      const competitors = competitorFrequency(answers, { isYou });
      if (opts.requireCompetitor !== false && !competitors.length) continue;
      const intent = normalizeIntent(q.intent);
      out.push({ questionId: q.id, question: q.text || "", intent, gapType: GAP_TYPE_OF[intent], engines: engines.filter((e) => answers.some((a) => a.engine === e)), answers, competitors, sources: citedSources(answers) });
    }
    return out;
  }

  // What must match for a before/after comparison to be direct.
  function scopeOf(run, questionId, engine) {
    const q = (run?.questions || []).find((x) => x.id === questionId); if (!q) return null;
    return { questionKey: normalizeQuestion(q.text), engine, market: normalizeMarket(run?.profile?.market), samples: Math.max(1, Number(run?.samples) || 1) };
  }
  const isComparable = (a, b) => !!a && !!b && !!a.questionKey && a.questionKey === b.questionKey && a.engine === b.engine && a.market === b.market && a.samples === b.samples;
  function coverageDirection(before, after, comparable) {
    if (!comparable || !before?.total || !after?.total) return "incomparable";
    const d = after.named / after.total - before.named / before.total;
    return Math.abs(d) < 1e-9 ? "unchanged" : d > 0 ? "improved" : "regressed";
  }

  root.WP_RECOMMENDATION_MODEL = deepFreeze({
    GAP_TYPE_OF, INTENT_ALIASES, GAP_ORDER,
    normalizeIntent, gapTypeFor, normalizeQuestion, normalizeMarket, isCompleted, isFailed,
    competitorFrequency, citedSources, sourceDomains, confidenceFor,
    assess, summarize, deriveGaps, sortGaps, questionGaps,
    scopeOf, isComparable, coverageDirection,
  });
})(typeof window !== "undefined" ? window : globalThis);
