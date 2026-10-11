/* WhitePetal product language: one immutable source for navigation labels, gap types, lifecycle labels,
   positioning/onboarding copy, scoped-claim templates and the prohibited outcome claims the copy tests enforce.
   Plain script, loaded before app.js (window.WP_LANGUAGE). Tests load it in a VM the same way.
   Voice: observed fact + buyer consequence + evidence + credible next action. Never promise an outcome. */
(function (root) {
  "use strict";

  const deepFreeze = (o) => {
    if (o && (typeof o === "object" || typeof o === "function") && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach((k) => deepFreeze(o[k]));
    }
    return o;
  };

  const CATEGORY = "AI recommendation intelligence and recovery";
  const PROMISE = "Find the recommendation gaps. Fix the evidence. Track the recovery.";

  // Main decision journey. `key` reuses the current route key where that screen already exists;
  // "drafts" and "trend" are new destinations that later tasks add.
  const NAV = [
    { section: "Home", items: [
      { key: "overview", label: "Recommendation risk" },
      { key: "site", label: "Evidence readiness" },
    ] },
    { section: "Gaps", items: [
      { key: "prompts", label: "Buyer questions" },
      { key: "gaps", label: "Recommendation gaps" },
      { key: "chats", label: "AI answers" },
    ] },
    { section: "Why they win", items: [
      { key: "domains", label: "Evidence sources" },
      { key: "gap", label: "Competitor advantages" },
      { key: "rankings", label: "Search influence" },
    ] },
    { section: "Recovery", items: [
      { key: "actions", label: "Recovery plan" },
      { key: "drafts", label: "Drafts" },
    ] },
    { section: "Progress", items: [
      { key: "ranking", label: "Competitive landscape" },
      { key: "trend", label: "Change over time" },
    ] },
  ];

  // Labels for screens and controls that sit outside the main journey (drill-downs, account area).
  const LABELS = {
    fanouts: "Searches behind the answer",
    insights: "Contextual findings",
    perception: "Brand accuracy",
    rerun: "Recheck recommendations",
    agent: "Ask WhitePetal",
    settings: "Settings",
    team: "Team & keys",
    noOpenActions: "No open recovery actions",
    draftNotice: "Draft—review before publishing/sending.",
    inspectEvidence: "Inspect evidence",
    createAction: "Create recovery action",
    draftEvidence: "Draft evidence for this buyer question",
    openRisk: "Open recommendation risk",
    reviewAnswers: "Review the AI answers",
    observedInCheck: "Observed in this check",
    basedOnSources: "Based on cited sources",
  };

  // One universal object, the recommendation gap, with intent severity.
  const GAP_TYPES = {
    informational: { intent: "informational", gapType: "discovery", label: "Discovery gap", meaning: "Brand is absent while buyers learn or define the category" },
    commercial: { intent: "commercial", gapType: "consideration", label: "Consideration gap", meaning: "Brand is absent while buyers compare credible options" },
    transactional: { intent: "transactional", gapType: "decision", label: "Decision gap", meaning: "Brand is absent near a concrete purchase or vendor choice" },
  };
  const GAP_ORDER = ["decision", "consideration", "discovery"]; // highest urgency first

  // Mirrors the recovery_actions.status check constraint. There is no "Done".
  const LIFECYCLE = [
    { status: "suggested", label: "Suggested" },
    { status: "drafting", label: "Drafting" },
    { status: "ready_for_review", label: "Ready for review" },
    { status: "approved", label: "Approved" },
    { status: "published", label: "Published/sent" },
    { status: "recheck_scheduled", label: "Recheck scheduled" },
    { status: "result_observed", label: "Result observed" },
    { status: "archived", label: "Archived" },
  ];

  const COPY = {
    category: CATEGORY,
    promise: PROMISE,
    corePain: "Recommendation leakage",
    coreObject: "Recommendation gap",
    home: {
      eyebrow: "AI recommendation intelligence for brands",
      headline: "When buyers ask AI what to choose, does your brand make the answer?",
      subhead: "WhitePetal checks the questions buyers ask ChatGPT, Gemini and Perplexity, shows where competitors are recommended instead of you, traces the evidence behind those answers, and drafts the work needed to compete.",
      cta: "Find my recommendation gaps",
      proof: ["Buyer questions", "Competing recommendations", "Trusted evidence", "Recovery actions"],
    },
    accountGate: "Create an account to save this brand and run live recommendation checks.",
    onboarding: {
      profile: "What must AI understand correctly about your brand?",
      market: "Where are the buyers whose decisions matter?",
      competitors: "Which brands take the same customer choice?",
      topics: "Which purchase decisions should include you?",
      focus: "Which buyer moments matter most right now?",
      questions: "These are the buyer questions WhitePetal will monitor",
      run: "Check where AI leaves us out",
      ready: "We found your first recommendation gaps",
    },
  };

  const n = (v) => (v == null || v === "" ? "–" : String(v));
  const claims = {
    zeroCoverage: ({ engine, brand, total }) => `${n(engine)} did not name ${n(brand)} in any of ${n(total)} tracked answers in this check.`,
    partialCoverage: ({ engine, brand, named, total }) => `${n(brand)} appeared in ${n(named)}/${n(total)} tracked ${n(engine)} answers in this check.`,
    // Picks the right template; zero completed answers is never a claim about the brand.
    coverage: (x) => (!x || !x.total ? claims.insufficient() : x.named ? claims.partialCoverage(x) : claims.zeroCoverage(x)),
    competitorContrast: ({ competitor, brand, n: count }) => `${n(competitor)} appeared in ${n(count)} of the same answers. The cited sources below mention ${n(competitor)} but not ${n(brand)}.`,
    actionRationale: ({ question }) => `This action addresses an observed evidence gap for ${n(question)}. It may strengthen the information available to AI systems; it does not guarantee inclusion.`,
    movement: ({ before, after }) => `After publication, recommendation coverage changed from ${n(before)} to ${n(after)} in the next comparable check. This is an observed association, not proof that one action caused the change.`,
    insufficient: () => "WhitePetal does not yet have enough comparable answers to call this a trend.",
    // Engine · date · market · question count · answer sample, for headline claims.
    scope: ({ engine, date, market, questions, answers }) => [n(engine), n(date), market || "Global", `${n(questions)} buyer question${questions === 1 ? "" : "s"}`, `${n(answers)} answer${answers === 1 ? "" : "s"}`].join(" · "),
    pursueInclusion: (domain) => `Pursue inclusion on ${n(domain)}`,
    strengthenEvidence: (question) => `Strengthen evidence for “${n(question)}”`,
  };

  // Outcome claims and retired phrases the copy guard rejects in user-facing code and generation prompts.
  // `unless` is tested against the whole line (scoped uses); `negated` skips a match preceded by a negation.
  const ENGINE_SCOPE = /\b(ChatGPT|Perplexity|Gemini|Groq|Copilot|Claude|AI Overviews?|AI Mode)\b|\$\{ENG\[/;
  const PROHIBITED = [
    { term: "get you named", pattern: "\\bget you named\\b" },
    { term: "get named", pattern: "\\bget named\\b" },
    { term: "fastest way", pattern: "\\bfastest way\\b" },
    { term: "biggest single lever", pattern: "\\bbiggest single lever\\b" },
    { term: "win it", pattern: "\\bwin it\\b" },
    { term: "unscoped AI says", pattern: "\\bAI says\\b", unlessLine: ENGINE_SCOPE.source },
    { term: "guarantee", pattern: "\\bguarantee(?:s|d|ing)?\\b", negated: true },
    { term: "AI-proof", pattern: "\\bAI[- ]proof\\b" },
    { term: "customers stolen", pattern: "\\bcustomers stolen\\b" },
    { term: "revenue lost", pattern: "\\brevenue lost\\b" },
  ];
  const NEGATION = /(?:\bnot|\bnever|\bno|n't|\bwithout|\bcannot)\s+(?:\w+\s+)?$/i;

  function findProhibited(text) {
    const out = [];
    String(text || "").split("\n").forEach((line, i) => {
      for (const p of PROHIBITED) {
        if (p.unlessLine && new RegExp(p.unlessLine).test(line)) continue;
        const re = new RegExp(p.pattern, "gi");
        let m;
        while ((m = re.exec(line))) {
          if (p.negated && NEGATION.test(line.slice(0, m.index))) continue;
          out.push({ term: p.term, line: i + 1, match: line.trim().slice(0, 200) });
        }
      }
    });
    return out;
  }

  root.WP_LANGUAGE = deepFreeze({ NAV, LABELS, GAP_TYPES, GAP_ORDER, LIFECYCLE, COPY, claims, PROHIBITED, findProhibited });
})(typeof window !== "undefined" ? window : globalThis);
