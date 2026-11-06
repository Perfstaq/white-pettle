/* WhitePetal competitive intelligence: pure functions over a run, no DOM. Builds on rival-model.js.
   Answers four questions in one place:
   1. Who is winning, engine by engine?            engineMatrix
   2. Which prompts does each brand own?           battleground
   3. Why do they win (pages, positioning)?        sourceMap, ownedDomain, descriptors
   4. What can I copy, and where?                  playbook
   Every claim is an observed count from AI answers ("associated with"), never a cause. */
(function (root) {
  "use strict";
  const RV = () => root.WP_RIVAL_MODEL, RM = () => root.WP_RECOMMENDATION_MODEL;
  const canon = (s) => RV().canon(s);
  const squash = (s) => canon(s).replace(/\s+/g, "");
  const host = (u) => (/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(String(u || "").trim())?.[1] || "").replace(/^www\./i, "").toLowerCase();
  const completed = (M, engine) => Object.values(M?.answers || {}).filter((a) => RM().isCompleted(a) && (!engine || engine === "all" || a.engine === engine));
  const brandTest = (M, isYou) => (typeof isYou === "function" ? isYou : (n) => canon(n) === canon(M?.profile?.name));
  const named = (a, you) => !!a.named || (a.brands || []).some(you);
  const pct = (v) => Math.round(100 * v) + "%";
  // Brands a person hid from their lists: left out of every view here (their own score never depends on it).
  const hidden = (prefs) => new Set(RV().normalizePrefs(prefs).ignored.map(canon));
  const ENGINE = { chatgpt: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini", claude: "Claude", groq: "Groq", aio: "Google AI Overviews", aimode: "Google AI Mode" };
  const engineName = (e) => ENGINE[e] || e;

  // A domain is a brand's own site when one of its labels is the brand's name: help.fathom.video -> Fathom, docs.wisprflow.ai -> Wispr Flow.
  // A competitor's website, when the person gave one, decides first: "meridian.com" is Meridian's own site.
  function siteOwner(domain, M) {
    for (const [name, url] of Object.entries(M?.profile?.competitorSites || {})) { const h = host(url); if (h && (domain === h || domain.endsWith("." + h))) return name; }
    return null;
  }
  function ownedDomain(domain, brandNames) {
    const labels = String(domain || "").split(".").slice(0, -1).map((l) => l.replace(/[^a-z0-9]/g, ""));
    return brandNames.find((b) => { const k = squash(b); return k.length >= 3 && labels.includes(k); }) || null;
  }
  const DIRECTORY = /(^|\.)(g2|capterra|getapp|softwareadvice|trustradius|producthunt|sourceforge|techjockey|alternativeto|saasworthy|crozdesk|slashdot|softwaresuggest)\./;
  const FORUM = /(^|\.)(reddit|quora|news\.ycombinator|stackexchange|stackoverflow|indiehackers|community\.|forum\.)/;
  function domainType(domain, owner) {
    if (owner) return "Brand's own site";
    if (DIRECTORY.test(domain + ".")) return "Review / directory";
    if (FORUM.test(domain)) return "Forum";
    if (/(^|\.)(youtube|medium|substack|linkedin)\./.test(domain + ".")) return "Social / creator";
    return "Article / publisher";
  }

  // 1. Brands x engines: visibility on each engine, plus where the engines disagree about a brand.
  function engineMatrix(M, { isYou, prefs, limit = 10 } = {}) {
    const engines = (M?.engines || []).filter((e) => completed(M, e).length);
    const all = RV().profiles(M, { isYou, prefs });
    const per = Object.fromEntries(engines.map((e) => [e, RV().profiles(M, { isYou, prefs, engine: e })]));
    const top = all.rivals.filter((r) => r.tracked || r.mentions >= 2).slice(0, limit);
    const rows = [all.you, ...top].filter(Boolean).sort((a, b) => b.score - a.score).map((r) => ({
      key: r.key, name: r.name, you: r.you, tracked: r.tracked, score: r.score, vis: r.vis,
      engines: Object.fromEntries(engines.map((e) => { const x = per[e].all.find((b) => b.key === r.key); return [e, { vis: x ? x.vis : 0, score: x ? x.score : 0, n: per[e].n }]; })),
    }));
    const disagree = [];
    for (const r of rows) {
      const cells = engines.map((e) => [e, r.engines[e]]).filter(([, c]) => c.n >= RV().MIN_ANSWERS);
      if (cells.length < 2) continue;
      cells.sort((a, b) => b[1].vis - a[1].vis);
      const [hi, lo] = [cells[0], cells[cells.length - 1]];
      if (hi[1].vis - lo[1].vis >= 0.3 && RV().differs(hi[1].vis, lo[1].vis, Math.min(hi[1].n, lo[1].n)))
        disagree.push({ key: r.key, name: r.name, you: r.you, hi: hi[0], lo: lo[0], hiVis: hi[1].vis, loVis: lo[1].vis,
          text: `${engineName(hi[0])} names ${r.you ? "you" : r.name} in ${pct(hi[1].vis)} of its answers; ${engineName(lo[0])} in ${pct(lo[1].vis)}.` });
    }
    return { engines, rows, disagree, n: all.n, you: all.you, leader: all.rivals[0] || null, profiles: all };
  }

  // 2. Every prompt: who AI names, and whether a brand owns it, it is contested, or nobody is recommended (white space).
  function battleground(M, { isYou, engine, prefs } = {}) {
    const you = brandTest(M, isYou), A = completed(M, engine), byQ = new Map(), ign = hidden(prefs);
    for (const a of A) (byQ.get(a.qid) || byQ.set(a.qid, []).get(a.qid)).push(a);
    return (M?.questions || []).filter((q) => byQ.has(q.id)).map((q) => {
      const as = byQ.get(q.id), n = as.length, count = new Map();
      for (const a of as) { const seen = new Set(); for (const b of a.brands || []) { if (you(b)) continue; const k = canon(b); if (!k || seen.has(k) || ign.has(k)) continue; seen.add(k); const c = count.get(k) || { name: String(b).trim(), n: 0, first: 0 }; c.n++; if ((a.brands || []).findIndex((x) => canon(x) === k) === 0) c.first++; count.set(k, c); } }
      const brands = [...count.values()].map((c) => ({ ...c, share: c.n / n })).sort((a, b) => b.share - a.share || b.first - a.first);
      const youShare = as.filter((a) => named(a, you)).length / n;
      // Led: one brand is named FIRST in at least half the answers, and more often than any other. Otherwise contested.
      brands.sort((a, b) => b.first - a.first || b.share - a.share);
      const lead = brands[0], next = brands[1];
      const status = youShare > 0 ? "you" : !lead ? "open" : lead.first >= Math.max(1, Math.ceil(n / 2)) && (!next || lead.first > next.first) ? "led" : "contested";
      return { id: q.id, text: q.text || "", stage: RM().gapTypeFor(q.intent), n, youShare, status, owner: status === "led" ? lead.name : null, ownerFirst: status === "led" ? lead.first : 0, brands, // every brand named for this prompt, most first; views show the top few
        engines: [...new Set(as.map((a) => a.engine))] };
    });
  }

  // 3a. The pages behind the answers: each domain, how many answers used it, which brands those answers named, and whether you were in them.
  function sourceMap(M, { isYou, engine, prefs } = {}) {
    const you = brandTest(M, isYou), A = completed(M, engine), D = new Map(), brandNames = new Set(), ign = hidden(prefs);
    for (const a of A) (a.brands || []).forEach((b) => !you(b) && !ign.has(canon(b)) && brandNames.add(String(b).trim()));
    for (const a of A) {
      const doms = new Map(); for (const s of a.sources || []) { const d = host(s.url); if (d) { const x = doms.get(d) || { cited: false, urls: new Set() }; x.cited = x.cited || !!s.cited; x.urls.add(s.url); doms.set(d, x); } }
      for (const [d, x] of doms) {
        const r = D.get(d) || { domain: d, answers: 0, cited: 0, you: 0, brands: new Map(), urls: new Set(), engines: new Set(), qids: new Set() };
        r.answers++; if (x.cited) r.cited++; if (named(a, you)) r.you++; x.urls.forEach((u) => r.urls.add(u)); r.engines.add(a.engine); r.qids.add(a.qid);
        const seen = new Set(); for (const b of a.brands || []) { if (you(b)) continue; const k = canon(b); if (!k || seen.has(k) || ign.has(k)) continue; seen.add(k); r.brands.set(k, { name: r.brands.get(k)?.name || String(b).trim(), n: (r.brands.get(k)?.n || 0) + 1 }); }
        D.set(d, r);
      }
    }
    const names = [...brandNames];
    return [...D.values()].map((r) => { const owner = siteOwner(r.domain, M) || ownedDomain(r.domain, names); return { domain: r.domain, answers: r.answers, cited: r.cited, youIn: r.you, owner, type: domainType(r.domain, owner),
      brands: [...r.brands.values()].sort((a, b) => b.n - a.n), urls: [...r.urls].slice(0, 3), engines: [...r.engines], qids: [...r.qids] }; })
      .sort((a, b) => b.answers - a.answers || b.brands.length - a.brands.length);
  }

  // 3b. How AI describes a brand: the sentences that name it, cleaned of markdown, most recommendation-like first.
  function descriptors(M, name, { engine, max = 3 } = {}) {
    const k = canon(name), word = new RegExp("\\b" + String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "\\b", "i"), out = [], seen = new Set();
    for (const a of completed(M, engine)) {
      if (!(a.brands || []).some((b) => canon(b) === k)) continue;
      const text = String(a.answer || "").replace(/\n+\s*(?:[-*•]|\d+[.)])?\s*/g, " • ").replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, "$1").replace(/\(\[[^\]]*\]\)|\[\d+\]|\[[a-z0-9.-]+\.[a-z]{2,}\]/gi, " ").replace(/\*\*|__|`|#+\s|\|/g, " ").replace(/\(https?:[^)]*\)/g, "").replace(/\s+/g, " ");
      for (const s of text.split(/(?<=[.!?])\s+|\s[-•]\s/)) {
        const t = s.trim().replace(/^[-:;,\s]+/, ""); if (t.length < 30 || t.length > 240 || !word.test(t) || /:$/.test(t)) continue;
        const key = t.toLowerCase().slice(0, 60); if (seen.has(key)) continue; seen.add(key);
        out.push({ text: t, engine: a.engine, qid: a.qid, w: (/\b(best|ideal|great|top|if you|for (teams|founders|solo|most)|recommend|pick|go with|choose)\b/i.test(t) ? 2 : 0) + (t.length < 160 ? 1 : 0) });
      }
    }
    return out.sort((a, b) => b.w - a.w).slice(0, max);
  }

  // 4. The playbook: what each leading rival does that AI rewards, turned into a move you can make. Ranked by how many answers back it.
  function playbook(M, { isYou, prefs, rivals = 3 } = {}) {
    const mx = engineMatrix(M, { isYou, prefs }), bg = battleground(M, { isYou, prefs }), src = sourceMap(M, { isYou, prefs });
    const qText = (id) => (M.questions.find((q) => q.id === id) || {}).text || "";
    const top = mx.profiles.rivals.filter((r) => r.mentions >= 2).slice(0, rivals), out = [];
    // Pages that carry several rivals at once get one shared card; a rival's own card only lists pages specific to it.
    const allHubs = src.filter((s) => !s.owner && s.youIn === 0 && s.brands.length >= 3), hubs = allHubs.slice(0, 5), hubSet = new Set(allHubs.map((s) => s.domain));
    for (const r of top) {
      const own = src.filter((s) => s.owner && canon(s.owner) === r.key);
      const ownN = own.reduce((t, s) => t + s.answers, 0);
      if (ownN >= 2) { const n = ownN;
        out.push({ rival: r.name, kind: "own-content", title: `${r.name}'s own pages are what AI reads`, impact: n, effort: "medium",
          evidence: own.slice(0, 3).map((s) => `${s.domain}: used in ${s.answers} answer${s.answers === 1 ? "" : "s"}`), urls: own.flatMap((s) => s.urls).slice(0, 3),
          move: `Publish pages on your own site that answer the same questions directly: ${[...new Set(own.flatMap((s) => s.qids))].slice(0, 2).map((id) => `"${qText(id)}"`).join(" and ")}. Use comparison tables, pricing and an FAQ so AI can quote you.` }); }
      const lists = src.filter((s) => !s.owner && !hubSet.has(s.domain) && s.youIn === 0 && s.brands.some((b) => canon(b.name) === r.key)).slice(0, 4);
      if (lists.length) out.push({ rival: r.name, kind: "listings", title: `Get listed where ${r.name} is listed`, impact: lists.reduce((t, s) => t + s.answers, 0), effort: "medium",
        evidence: lists.map((s) => `${s.domain} (${s.type.toLowerCase()}): used in ${s.answers} answer${s.answers === 1 ? "" : "s"} that name ${r.name}, none that name you`), urls: lists.flatMap((s) => s.urls).slice(0, 3),
        move: `Pitch these pages to include you next to ${r.name}. Lead with what you do that ${r.name} doesn't.` });
      const owned = bg.filter((p) => p.status === "led" && canon(p.owner) === r.key).sort((a, b) => ["decision", "consideration", "discovery"].indexOf(a.stage) - ["decision", "consideration", "discovery"].indexOf(b.stage));
      if (owned.length) out.push({ rival: r.name, kind: "prompts", title: `${r.name} leads ${owned.length} prompt${owned.length === 1 ? "" : "s"}`, impact: owned.reduce((t, p) => t + p.n, 0), effort: "high",
        evidence: owned.slice(0, 3).map((p) => `"${p.text}": named first in ${p.ownerFirst} of ${p.n} answer${p.n === 1 ? "" : "s"}`),
        move: `Write the best answer on the web for ${owned.length === 1 ? "this prompt" : "these prompts"}, then get it cited. Start with the ${owned[0].stage}-stage one.` });
      const row = mx.rows.find((x) => x.key === r.key), cells = row ? mx.engines.map((e) => [e, row.engines[e]]).filter(([, c]) => c.n >= RV().MIN_ANSWERS).sort((a, b) => a[1].vis - b[1].vis) : [];
      if (cells.length >= 2 && cells[cells.length - 1][1].vis - cells[0][1].vis >= 0.3 && RV().differs(cells[cells.length - 1][1].vis, cells[0][1].vis, Math.min(cells[0][1].n, cells[cells.length - 1][1].n))) out.push({ rival: r.name, kind: "engine-gap", title: `${r.name} is weakest on ${engineName(cells[0][0])}`, impact: Math.round(10 * (cells[cells.length - 1][1].vis - cells[0][1].vis)), effort: "low",
        evidence: cells.map(([e, c]) => `${engineName(e)}: named in ${pct(c.vis)} of answers`), move: `Make ${engineName(cells[0][0])} your first battleground: it recommends ${r.name} least, so there is room for you.` });
    }
    const lines = top.map((r) => [r.name, descriptors(M, r.name, { max: 1 })[0]]).filter(([, d]) => d);
    if (lines.length) out.push({ rival: null, kind: "positioning", title: "How AI describes the leaders", impact: lines.length, effort: "low", evidence: lines.map(([n, d]) => `${n}, on ${engineName(d.engine)}: "${d.text}"`),
      move: "Each leader has one clear line AI repeats: who it is best for. Write yours and use it in the same words on your home page, product pages and listings." });
    const open = bg.filter((p) => p.status === "open" || p.status === "contested");
    if (open.length) out.push({ rival: null, kind: "white-space", title: `${open.length} prompt${open.length === 1 ? "" : "s"} with no clear winner`, impact: open.reduce((t, p) => t + p.n, 0), effort: "medium",
      evidence: open.slice(0, 4).map((p) => `"${p.text}": ${p.status === "open" ? "no brand recommended" : `split between ${p.brands.slice(0, 3).map((b) => b.name).join(", ")}`}`),
      move: `These are the cheapest wins: no rival owns them yet. Publish the clearest answer for each.` });
    if (hubs.length) out.push({ rival: null, kind: "hubs", title: "The pages that decide your category", impact: hubs.reduce((t, s) => t + s.answers, 0), effort: "medium",
      evidence: hubs.map((s) => `${s.domain}: used in ${s.answers} answer${s.answers === 1 ? "" : "s"}, carries ${s.brands.slice(0, 4).map((b) => b.name).join(", ")}`), urls: hubs.flatMap((s) => s.urls).slice(0, 3),
      move: `Several rivals are on these pages and you are not. Getting onto any one helps against all of them.` });
    return out.sort((a, b) => b.impact - a.impact);
  }

  root.WP_INTEL = Object.freeze({ siteOwner, engineMatrix, battleground, sourceMap, descriptors, playbook, ownedDomain, domainType, engineName });
})(typeof window !== "undefined" ? window : globalThis);
