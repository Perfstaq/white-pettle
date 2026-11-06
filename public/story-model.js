/* How one rival wins, and what to change: words first, built from the answers and from what is on the pages AI read.
   Pure; needs rival-model.js, intel-model.js and page-features.js. pages: { url: features } for pages that were read;
   yours: [{ url, features }] for your own pages. Every claim names its source. */
(function (root) {
  "use strict";
  const RV = () => root.WP_RIVAL_MODEL, I = () => root.WP_INTEL, PG = () => root.WP_PAGE, RM = () => root.WP_RECOMMENDATION_MODEL;
  const canon = (s) => RV().canon(s), pct = (v) => Math.round(100 * v) + "%";
  const host = (u) => (/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(String(u || ""))?.[1] || "").replace(/^www\./i, "").toLowerCase();
  const short = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const STAGE_W = { decision: 3, consideration: 2, discovery: 1 };

  function rivalStory(M, rivalName, { isYou, prefs, pages = {}, yours = [] } = {}) {
    const key = canon(rivalName), you = typeof isYou === "function" ? isYou : (n) => canon(n) === canon(M.profile.name);
    const A = Object.values(M.answers || {}).filter((a) => RM().isCompleted(a)), mine = A.filter((a) => (a.brands || []).some((b) => canon(b) === key));
    const P = RV().profiles(M, { isYou, prefs }), r = P.all.find((x) => x.key === key); if (!r) return null;
    const sample = (f, k) => (k === "bestFor" ? f.bestFor : k === "pricing" ? f.pricing : k === "faq" && f.questions?.length ? f.questions.slice(0, 2).join(" · ") : k === "schemaAny" ? (f.schema || []).slice(0, 3).join(", ") : "");
    // A competitor AI never named: nothing to learn from the answers, but its own website (when given) can still be
    // compared with yours, and the answers show who AI recommends instead.
    if (!mine.length) {
      const siteName = Object.keys(M.profile?.competitorSites || {}).find((n) => canon(n) === key), site = siteName ? M.profile.competitorSites[siteName] : null;
      const f = site ? pages[site] || pages[site + "/"] || null : null, yourRead = yours.filter((y) => y.features?.readable);
      const checks = PG().CHECKS.map(([k, label, why]) => { const mineHas = yourRead.find((y) => PG().has(y.features, k));
        return { key: k, label, why, they: f?.readable && PG().has(f, k) ? { short: short(site), sample: sample(f, k) } : null, you: mineHas ? { short: short(mineHas.url) } : null }; });
      return { notNamed: true, rival: r.name, key, of: P.n, site, siteRead: !!f?.readable, siteUnreadable: !!f && !f.readable, checks, read: f?.readable ? 1 : 0, yoursRead: yourRead.length,
        leaders: P.rivals.filter((x) => x.mentions && x.key !== key).slice(0, 3).map((x) => x.name), named: 0, score: r.score, you: P.you?.score ?? 0, says: [], pages: [], engines: [], leads: [], absent: [], gaps: [], moves: [] };
    }
    const engines = (M.engines || []).map((e) => { const as = A.filter((a) => a.engine === e); return { e, n: as.length, vis: as.length ? as.filter((a) => (a.brands || []).some((b) => canon(b) === key)).length / as.length : 0 }; }).filter((x) => x.n);
    const bg = I().battleground(M, { isYou, prefs }), leads = bg.filter((p) => p.status === "led" && canon(p.owner) === key);
    const absent = bg.filter((p) => p.youShare === 0 && p.brands.some((b) => canon(b.name) === key)).sort((a, b) => STAGE_W[b.stage] - STAGE_W[a.stage] || (b.brands.find((x) => canon(x.name) === key).share - a.brands.find((x) => canon(x.name) === key).share));
    // The pages behind the answers that name this rival, most used first; with what is on each one when it was read.
    const names = [...new Set(A.flatMap((a) => a.brands || []).filter((b) => !you(b)))], used = new Map();
    for (const a of mine) { const seen = new Set(); for (const s of a.sources || []) { const k = String(s.url).replace(/[#?].*$/, "").replace(/\/$/, ""); if (seen.has(k)) continue; seen.add(k); const x = used.get(k) || { url: s.url, n: 0 }; x.n++; used.set(k, x); } }
    const allPages = [...used.values()].sort((a, b) => b.n - a.n).map((p) => {
      const d = host(p.url), owner = I().siteOwner(d, M) || I().ownedDomain(d, names), f = pages[p.url] || pages[p.url.replace(/[#?].*$/, "")] || null;
      return { url: p.url, short: short(p.url), domain: d, n: p.n, owner, own: !!owner && canon(owner) === key, type: I().domainType(d, owner), read: f && f.readable ? f : null, unreadable: !!f && !f.readable,
        namesRival: f && f.readable ? f.names.some((n) => canon(n) === key) : null, namesYou: f && f.readable ? f.names.some((n) => you(n)) : null };
    });
    // Evidence for this rival: its own pages, then pages that were read and name it, then forum threads (unreadable, but
    // AI read them). A page that was read and doesn't mention the rival is not evidence for it, however often it was used.
    const rank = (p) => (p.own ? 0 : p.namesRival ? 1 : p.type === "Forum" ? 2 : 9);
    const pagesOut = allPages.filter((p) => rank(p) < 9).sort((a, b) => rank(a) - rank(b) || b.n - a.n).slice(0, 6);
    // The competitor's own website, when the person gave it, is evidence too, even if AI never cited it.
    const givenName = Object.keys(M.profile?.competitorSites || {}).find((n) => canon(n) === key), given = givenName ? M.profile.competitorSites[givenName] : null;
    if (given && !pagesOut.some((p) => host(p.url) === host(given))) { const f = pages[given] || pages[given + "/"] || null;
      pagesOut.unshift({ url: given, short: short(given), domain: host(given), n: 0, owner: r.name, own: true, type: "Brand's own site", read: f && f.readable ? f : null, unreadable: !!f && !f.readable, namesRival: true, namesYou: f && f.readable ? f.names.some((n) => you(n)) : null }); }
    // What their pages have that yours don't: each check, the best example from their pages, and your best page for it.
    const theirs = pagesOut.filter((p) => p.read && (p.own || p.namesRival)), yourRead = yours.filter((y) => y.features?.readable);
    const checks = PG().CHECKS.map(([k, label, why]) => {
      const ex = theirs.find((p) => PG().has(p.read, k)), mineHas = yourRead.find((y) => PG().has(y.features, k));
      const smp = ex ? sample(ex.read, k) : "";
      return { key: k, label, why, they: ex ? { short: ex.short, sample: smp } : null, you: mineHas ? { short: short(mineHas.url) } : null };
    });
    const gaps = checks.filter((c) => c.they && !c.you), says = I().descriptors(M, r.name, { max: 2 });
    const read = pagesOut.filter((p) => p.read).length, yoursRead = yours.filter((y) => y.features?.readable).length;
    // The moves, most backed first. Each step quotes what the rival does, so the person sees the pattern to copy.
    const moves = [];
    // One step per thing their pages have and yours don't, quoting theirs. The best-for line quotes what AI itself says
    // about the rival, because that is the line AI repeats.
    const STEP = { bestFor: "Open with one line saying who you're best for", pricing: "Show your prices on the page", comparison: "Add a comparison table with the options buyers weigh", faq: "Add FAQ headings phrased as buyer questions", steps: "Show how it works in numbered steps", dated: "Show when the page was last updated", schemaAny: "Add structured data (FAQPage, SoftwareApplication)" };
    const step = (g) => g.key === "bestFor" && says[0] ? `${STEP.bestFor}. ${I().engineName(says[0].engine)} already says of ${r.name}: "${says[0].text}"`
      : `${STEP[g.key]}. ${r.name}'s ${g.they.short} does${g.they.sample ? `: "${g.they.sample}"` : ""}`;
    const target = absent[0];
    if (target) moves.push({ kind: "page", weight: 100 + target.n, title: `Publish the page that answers "${target.text}"`,
      why: `AI names ${r.name} for this ${target.stage}-stage question and never names you.`,
      steps: [...checks.filter((c) => c.they && c.you).slice(0, 1).map((c) => `${c.label}: you already do this on ${c.you.short}. Put it on this page too.`), ...gaps.map(step), ...(gaps.length ? [] : ["Match the shape of the pages AI reads for this question: a clear best-for line, prices, a comparison and FAQs."])].slice(0, 6),
      go: ["gaps", "Draft this page"], prompt: target.id });
    if (absent.length || leads.length) moves.push({ kind: "vs", weight: 8 + absent.length, title: `Add a "${M.profile.name} vs ${r.name}" page`,
      why: `Buyers ask AI to compare options. ${absent.length} prompt${absent.length === 1 ? "" : "s"} name ${r.name} and not you.`,
      steps: [`Lead with the one difference that matters most to your buyers.`, `A table: ${M.profile.name}, ${r.name} and the next two options, with prices.`, `Say plainly who should pick ${r.name} instead. AI trusts balanced pages.`, `FAQ headings like "Is ${M.profile.name} a ${r.name} alternative?"`], go: ["gaps", "Draft this page"] });
    const lists = pagesOut.filter((p) => !p.own && !p.owner && p.read && p.namesRival && !p.namesYou);
    if (lists.length) moves.push({ kind: "listings", weight: 6 + lists.reduce((t, p) => t + p.n, 0), title: `Get onto the pages that recommend ${r.name}`,
      why: `These pages name ${r.name}, not you, and AI read them while answering.`, steps: lists.slice(0, 4).map((p) => `${p.short} (${p.type.toLowerCase()}, used in ${p.n} answer${p.n === 1 ? "" : "s"})`), go: ["gap", "Draft pitches"] });
    const talk = pagesOut.filter((p) => p.type === "Forum");
    if (talk.length) moves.push({ kind: "forums", weight: 4 + talk.reduce((t, p) => t + p.n, 0), title: `Join the conversations where ${r.name} gets recommended`,
      why: `AI read these threads while answering. Real replies there are what it quotes.`, steps: [...talk.slice(0, 3).map((p) => p.short), "Reply as yourself, say you're the founder, and answer the question asked."], go: null, urls: talk.slice(0, 3).map((p) => p.url) });
    moves.sort((a, b) => b.weight - a.weight);
    return { read, yoursRead, rival: r.name, key, score: r.score, you: P.you?.score ?? 0, named: r.mentions, of: P.n, engines, leads, absent, says, pages: pagesOut, checks, gaps, moves };
  }
  root.WP_STORY = Object.freeze({ rivalStory });
})(typeof window !== "undefined" ? window : globalThis);
