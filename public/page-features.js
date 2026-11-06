/* What is on a page, the way an AI engine would quote it. Pure: takes HTML, returns flags with the evidence for each.
   Plain script: the browser loads it (window.WP_PAGE) and the server imports it for its side effect (globalThis.WP_PAGE),
   so api/inspect.js and api/_audit.js read rivals' pages and your own pages with exactly the same rules. */
(function (root) {
  "use strict";
  const strip = (h) => String(h || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
  const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
  // The whole sentence a match sits in, so a quote never starts or ends mid-word.
  const sentence = (text, re, max = 170) => { const m = re.exec(text); if (!m) return ""; let a = m.index, b = m.index + m[0].length;
    while (a > 0 && !/[.!?]/.test(text[a - 1]) && m.index - a < 140) a--; while (b < text.length && !/[.!?]/.test(text[b]) && b - m.index < 160) b++;
    return clip(text.slice(a, b + 1).trim().replace(/^[^A-Za-z0-9"“$₹€£]+/, ""), max); };
  const BOILER = /helpful\?|feedback|need (more )?help|contact (us|support)|still have questions|did (this|you find)|cookie/i;
  function schemaTypes(html) {
    const out = new Set();
    for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      const walk = (x) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk); const t = x["@type"]; (Array.isArray(t) ? t : t ? [t] : []).forEach((v) => out.add(String(v))); if (x["@graph"]) walk(x["@graph"]); if (x.mainEntity) walk(x.mainEntity); };
      try { walk(JSON.parse(m[1].trim())); } catch { /* broken JSON-LD is common; ignore it */ }
    }
    return [...out];
  }
  const headings = (html) => [...String(html).matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: +m[1], text: strip(m[2]) })).filter((h) => h.text);
  function pageFeatures(html, { brands = [] } = {}) {
    const text = strip(html), hs = headings(html), types = schemaTypes(html), words = text ? text.split(" ").length : 0;
    // For quotes, every heading, paragraph and list item ends a sentence, so a heading never runs into the next line.
    const prose = strip(String(html).replace(/<\/(h[1-6]|p|li|div|td|th|dt|dd|section|header|footer|blockquote)>|<br\s*\/?>/gi, ". ")).replace(/(\s*\.\s*){2,}/g, ". ");
    const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].filter((t) => (t[0].match(/<tr/gi) || []).length >= 3).length;
    const steps = [...String(html).matchAll(/<ol[\s\S]*?<\/ol>/gi)].some((o) => (o[0].match(/<li/gi) || []).length >= 3) || hs.some((h) => /^step\s*\d|^how to\b/i.test(h.text));
    const qHeads = hs.filter((h) => /\?$/.test(h.text) && !BOILER.test(h.text));
    // A page that blocks readers or needs JavaScript (Reddit, YouTube, many apps) comes back nearly empty. Say so: an empty
    // page is "couldn't read", never "has none of these".
    if (words < 120 && hs.length < 2) return { readable: false, words, reason: "This page blocks readers or needs JavaScript, so its content couldn't be read." };
    const f = {
      readable: true, words, title: clip(strip((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""), 90), h1: hs.find((h) => h.level === 1)?.text || "",
      bestFor: sentence(prose, /(?<!\bworks?\s)\b(best (for|if)|ideal for|built for|designed for|perfect for|great for)\b/i), // "works best for in-person meetings" is a tip, not positioning
      // Prices only when there is an amount: "10 hours per user" is a limit, not a price.
      pricing: (/(?:\$|₹|€|£)\s?\d[\d,.]*(?:\s?(?:\/\s?|per\s)(?:mo|month|user|seat|member|year|yr)\b)?|\b\d[\d,.]*\s?(?:usd|inr|eur)\b/i.exec(text) || [""])[0].trim(),
      faq: types.includes("FAQPage") || hs.some((h) => /\bfaqs?\b|frequently asked/i.test(h.text)) || qHeads.length >= 3,
      comparison: tables > 0 || hs.some((h) => /\bvs\.?\b|\bversus\b|alternatives?|\bcompar(e|ed|es|ing|ison)\b/i.test(h.text)),
      steps, schema: types, dated: /dateModified|datePublished/.test(html) || /\b(updated|last updated)[^.]{0,30}\b20\d\d\b/i.test(text),
      headings: hs.length, questions: qHeads.slice(0, 4).map((h) => h.text),
      names: brands.filter((b) => b && new RegExp("\\b" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(text)),
    };
    return f;
  }
  // The checklist shown to people, in a fixed order: what AI can quote from a page.
  const CHECKS = [
    ["bestFor", "Says who it's best for", "AI repeats a clear \"best for\" line almost word for word."],
    ["pricing", "Shows prices", "Buyers ask about cost; AI quotes pages that state it."],
    ["comparison", "Compares options", "A table or a \"vs\" section is easy for AI to lift into an answer."],
    ["faq", "Answers questions", "Question-shaped headings match the questions buyers type."],
    ["steps", "Shows how it works", "Numbered steps get quoted for how-to prompts."],
    ["dated", "Shows it's current", "Engines prefer pages that say when they were updated."],
    ["schemaAny", "Has structured data", "Schema tells AI exactly what the page is about."],
  ];
  const has = (f, k) => (k === "schemaAny" ? f.schema.length > 0 : !!f[k]);
  root.WP_PAGE = Object.freeze({ pageFeatures, schemaTypes, CHECKS, has, strip });
})(typeof window !== "undefined" ? window : globalThis);
