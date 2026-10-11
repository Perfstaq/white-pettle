# Recommendation recovery: visual directions and chosen system

Date: 2026-10-11 · Owner: design (Task 9, steps 1–2) · Status: **Direction B chosen**, with specific additions from A and C (§4)

Explorations live in `docs/design/painkiller-directions/`. Each is one self-contained HTML file. Fonts come from Google Fonts; nothing else is fetched. Append a query to choose the view:

| File | Views (`?view=`) | Screenshots |
|---|---|---|
| `direction-a.html`, "The Brief" | `risk`, `drawer`, `recovery` | `direction-a-{risk,drawer,recovery}-1440.png`, `direction-a-mobile-390.png` |
| `direction-b.html`, "Pathways" (**chosen**) | `risk`, `drawer`, `recovery` | `direction-b-{risk,drawer,recovery}-1440.png`, `direction-b-risk-1920.png`, `direction-b-{risk,drawer}-768.png`, `direction-b-mobile-390.png` |
| `direction-c.html`, "Triage Desk" | `risk`, `drawer`, `recovery` | `direction-c-{risk,drawer,recovery}-1440.png`, `direction-c-mobile-390.png` |
| `mobile-frame.html?src=direction-x.html` | Shows the three views in 390×844 iframes (add `&h=2900` for full length) | — |

All three prototypes are interactive. You can open and close the evidence drawer (Esc closes it and focus returns to where it was), switch between risk and recovery, and use the mobile tab bar. C also supports keyboard triage with `J`/`K`/`E`.

## 1. Shared sample data

The sample brand is fictional: **Saarvi Skin**, an Indian D2C skincare brand (saarviskin.com). Its competitors (Dermaroot, Clearlab, Glowpath, Vedara) and every source domain are also fictional. The numbers are internally consistent, and a script checked them:

- 18 buyer questions × 3 engines (ChatGPT, Gemini, Perplexity) = 54 answers. 51 were completed. **3 Gemini answers were not collected**: they are excluded and never counted as gaps.
- Saarvi was named in **12 of 51** completed answers, which leaves **39 gaps**: **9 decision**, **16 consideration** and **14 discovery**. The 25 decision and consideration gaps are the "high-intent" set.
- Dermaroot appeared in 27 of the 39 gap answers, and in 7 of the 9 decision gaps.
- The check date is 9 Oct 2026, the market is India, and the comparable prior check is 25 Sep 2026. Since then, 2 gaps recovered, 3 are new, 1 regressed and 36 are unchanged.
- There are 12 recovery actions across all 8 lifecycle states: 4 suggested, 1 drafting, 2 ready for review, 1 approved, 1 published or sent, 1 recheck scheduled, 1 result observed and 1 archived. That gives "6 ready" (4 suggested plus 2 awaiting review).
- Every claim follows the templates in 03. The only movement shown is "0/3 → 1/3 … an observed association, not proof the page caused it". Every action uses the rationale "may strengthen … does not guarantee inclusion". The prototypes make no outcome promises.

## 2. The three directions

All three use the same data and the same hierarchy from 02 (statement → scope → four decision cards → 3–5 priority gaps → recovery path → what changed → advanced metrics). They differ in **spatial system, hierarchy treatment, evidence presentation and motion**. They are not palette swaps.

### A: "The Brief" (editorial decision room)
- **Space:** a document. Content runs on a 12-column text grid with an 8/4 split: a main column plus a margin rail for the evidence of each gap. Rules replace cards. The page is warm paper (#F4F1EA).
- **Hierarchy:** one large serif conclusion (Newsreader, about 49px) carries the page. The four decision cards are ruled columns with serif numerals. Gaps are a numbered ledger ("01–05"), with each gap's engine coverage written as marginalia.
- **Evidence:** a right-hand dossier sheet. It has labelled bands (`Observed answer`, `Cited sources`, `Your page, inspected`, `Inference`, `Recovery action`), shows the answer as a serif blockquote, and lists sources as footnote-style rows.
- **Recovery:** a horizontal station track (8 stops) over a ledger grouped by state, with a sticky action dossier.
- **Motion:** ink settles in (6px rise, staggered 60ms). Competitor names in the quote get a slow marker-sweep highlight.
- **Strengths:** the most calm and premium of the three, and the easiest to forward to a client as a "brief". Excellent contrast.
- **Weaknesses:** low density (5 gaps take 2 screens). The serif voice drifts away from the Geist product brand, and it reads a little "report", a little less "instrument".

### B: "Pathways" (diagrammatic decision room), chosen
- **Space encodes the buyer journey:** left means learning, right means choosing. The hero pairs a scoped statement card with a **recommendation pathway map**. It has three intent lanes (Discovery → Consideration → **Decision**), and every buyer question appears as a 3-cell engine strip (named / not named / not collected). The decision lane is tinted and bounded by a solid rule, so you see where the leakage sits before you read anything.
- **Hierarchy:** the four decision cards form one connected chain (`01 Coverage → 02 High-intent gaps → 03 Shown instead most → 04 Recovery actions ready`). The chevrons literally walk the core loop from problem to action, so they never read as a KPI wall. Each priority gap is a **left-to-right evidence chain** (question → engines → shown instead → evidence → recovery), and arrows join the stages.
- **Evidence:** a bottom sheet with three columns: **Observed answer | Cited sources | Who the evidence supports**. Bezier "provenance wires" run from each cited page to the brands it mentions. Saarvi sits in a dashed "missing" node with no solid lines going into it, so the gap shows as an absence of evidence and not as red paint.
- **Recovery:** a matrix with one row per action and 8 lifecycle columns. Rows are grouped by gap type. A line runs from Suggested to the current state, so progress is visible without kanban-template styling. Expanding the selected row inline shows the action detail.
- **Motion:** lines draw. The map nodes slide in from the left (in the journey direction), wires draw from source to brand (640ms) when the drawer is opened, and rows step in at a 50ms stagger. Motion always explains a connection or a direction.
- **Strengths:** the most category-specific and memorable. It answers "where does AI leave us out?" visually in under 10 seconds, and it continues the current brand (Geist, warm off-white, the orange petal = "you").
- **Weaknesses:** the wire diagram needs a desktop width. On tablet and mobile it collapses into rows, as designed. Engine cells are small (9px), so implementers must keep the text alternatives.

### C: "Triage Desk" (operator workbench)
- **Space:** no sidebar. A matte top bar carries the five nav groups, and the page is a split desk: a dense sortable gap **queue table** on the left and a **docked inspector** on the right that always shows the selected gap's evidence. `J`/`K` move through the queue and `E` expands it.
- **Hierarchy:** a one-line situation statement, then the four decision cards as a single instrument strip with segmented meters, then the queue. The recovery path is a chevron status line under the queue.
- **Evidence:** inline and always visible. It includes a **competitor comparison table** (Saarvi vs Dermaroot vs Clearlab across named answers, cited roundups, skin type in text, structured data and forum mentions). Expanding it opens a two-column focus drawer.
- **Severity:** a rail by thickness (5px decision, 3px consideration, 1px discovery) plus text codes `DEC/CON/DIS`.
- **Recovery:** a compact 8-column kanban with 7-tick progress bars on each card and a docked detail panel.
- **Motion:** mechanical. Selections slide in 120ms and panels dock in 260ms.
- **Strengths:** the highest density, the fastest for agencies working through many gaps, and keyboard-first.
- **Weaknesses:** it looks like a tool and not a decision room. Its distinctiveness is the weakest of the three (a triage table plus kanban is familiar territory). With the detail panel open, the board overflows at 1440. A founder skimming for 10 seconds faces the most text.

## 3. Evaluation (05's criteria, 1–5)

| Criterion | A: Brief | **B: Pathways** | C: Triage Desk | Notes |
|---|---|---|---|---|
| Clarity in 10 s | 5 | **5** | 3 | B's lane map shows *where* (decision lane) before any reading. C's statement competes with the queue and inspector. |
| Distinctiveness | 4 | **5** | 2 | B's pathway map and provenance wires are specific to recommendation recovery. C is a well-made but generic triage table. |
| Accessibility | 5 | **4** | 4 | A has the largest type and simplest structure. B needs aria text on its 9px cells and diagram (provided). C uses 11–12px type throughout. |
| Information density | 2 | **4** | 5 | A spends 2 screens on 5 gaps. B puts 18 questions plus 5 gaps in about 1.5 screens. |
| D2C founder appeal | 4 | **5** | 2 | Founders respond to "you're missing on the right, where people buy". A feels like a premium memo. C feels like an ops tool. |
| Agency / client presentability | 5 | **5** | 3 | A is a ready-made client brief. B's map and chain read without jargon. C needs explaining. |
| **Total (30)** | 25 | **28** | 19 | |
| Weighted (×2 clarity and founder appeal) | 34 | **38** | 24 | |

**Choice: B "Pathways".** It is the only direction whose *layout itself* carries the category's argument: the left-to-right journey shows where the gaps sit, the chain shows how to act, and the wires show why the evidence favours competitors. It keeps brand continuity with the current app (Geist, warm off-white, petal orange) while replacing the Peec-style KPI grid. It also degrades gracefully: on narrower screens the diagrams become ordered lists and chains, and nothing is hidden.

### What we take from the rejected directions (part of the spec)
- **From A:** the explicit `Observed` / `Inference` / `Recovery action` labelling on every evidence block, which B already uses as the black `OBSERVED` and blue `INFERENCE` tags. Also the "Why it matters" consequence sentence beside the headline, and the shareable-brief framing for the "Share with client" export.
- **From C:** the **competitor comparison table** inside the evidence drawer (as a 4th tab, or below the sources at ≥1280px), `J`/`K`/`E`/`A` keyboard triage on Recommendation gaps and Buyer questions, the hatched "not collected" table row as the canonical engine-failure treatment, and a docked inspector instead of the bottom sheet at ≥1680px.

### Tradeoffs we are accepting
- **We give up A's** larger serif type and literary calm. B is more "instrument" than "memo". Serif is not reintroduced in the app; it stays on the landing page only if marketing wants it.
- **We give up C's** density on long lists. Dense table views (Buyer questions, AI answers, Evidence sources) should use C's table recipe inside B's shell (§6.7). That is the only place C's look survives.
- **B's risks:** the wire diagram needs a JavaScript layout pass (getBoundingClientRect) and a resize handler, and it must be suppressed on ≤1100px widths and when there is no layout. The map must cap at roughly 8 questions per lane, with a "+n more" link, for workspaces with more than 25 questions.

## 4. Token spec (chosen system)

Put this on `:root` in `public/app.css`. It replaces the current `.light` token block; keep aliases (`--petal` → `--you`, `--rival`, `--src`) during migration so legacy views do not break.

### 4.1 Type
Load from Google Fonts: `family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500` (the same as today).

| Token | Value | Use |
|---|---|---|
| `--f-ui` | `"Geist", ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif` | All UI |
| `--f-mono` | `"Geist Mono", ui-monospace, Menlo, Consolas, monospace` | Scope lines, labels, counts, URLs, IDs |
| `--t-display` | 600 28px/1.18, tracking −0.025em (32px ≥1680, 22px ≤760) | Scoped statement (one per page) |
| `--t-h2` | 600 17px/1.2, −0.01em | Section heads |
| `--t-h3` | 600 14px/1.35 | Gap question, card titles |
| `--t-num` | 600 30px/1.1, −0.03em, tabular numbers (24px ≤760) | Decision-card values |
| `--t-body` | 400 14px/1.5 | Body |
| `--t-sm` | 400 12.5px/1.45 | Secondary text, meta |
| `--t-label` | 500 11px/1.2 mono, +0.04em, UPPERCASE | Section labels, column heads, scope keys |
| `--t-micro` | 500 10.5px mono | Counts in nav, chips |

Rules: never go below 11px for meaningful text. Use `font-variant-numeric: tabular-nums` on every count. Use only one `--t-display` per page.

### 4.2 Space, radius, layout
- Space (4px base): `--s1 4` `--s2 8` `--s3 12` `--s4 16` `--s5 20` `--s6 28` `--s7 40` `--s8 56`.
- Radius: `--r1 6px` (buttons, inputs, chips), `--r2 10px` (rows, cards), `--r3 16px` (hero panels, sheets). Pills use 999px only for scope chips and filter chips.
- Section rhythm: 30px above a section head and 10px below it. Cards in a stack have an 8px gap.

### 4.3 Colour and surfaces
| Token | Hex | Meaning |
|---|---|---|
| `--bg` | #F6F6F3 | App background (warm off-white) |
| `--surface` | #FFFFFF | Panels, rows, sheets |
| `--surface-2` | #EFEFEB | Chips, header rows, sunk areas |
| `--line` / `--line-2` | #E2E2DC / #CBCBC3 | Hairlines / stronger dividers and outlines |
| `--ink` / `--ink-2` / `--ink-3` | #121417 / #3F444B / #62676F | Text: primary / secondary / tertiary (5.3:1 on bg) |
| `--you` / `--you-ink` / `--you-wash` | #E8661A / #A94508 / #FDEBDD | **The user's brand** (fills, "named" cells, your node). `--you-ink` for text |
| `--rival` | #2B3138 | Competitor dots and wires (neutral graphite, never red) |
| `--scrim` | rgba(18,20,23,.42) | Behind sheets |

Elevation (no glass, no blur):
- `--e1: 0 1px 2px rgba(18,20,23,.05), 0 0 0 1px var(--line)` for resting panels and rows.
- `--e2: 0 1px 2px rgba(18,20,23,.06), 0 12px 32px -16px rgba(18,20,23,.22), 0 0 0 1px var(--line)` for popovers and the account menu.
- `--e3: 0 -20px 60px -20px rgba(18,20,23,.35)` for the bottom sheet and drawer.

Focus: `--focus: 0 0 0 2px var(--surface), 0 0 0 4px var(--work)` on `:focus-visible` for every interactive element. Never remove it. Inside dark surfaces, swap the inner ring to the dark colour.

### 4.4 Semantic states: colour + shape + label (never colour alone)
Every state is rendered with **icon shape + text label**, and colour reinforces it. Icons are 14px SVG symbols (see the `<defs>` in `direction-b.html`).

| State | Text / wash | Shape (icon) | Label | Extra non-colour cue |
|---|---|---|---|---|
| Decision gap | `--decision` #B4232A / #FBE7E6 (5.5:1) | **Filled triangle** ▲ | "Decision gap" | 4px left rail on rows; lane bounded by a solid rule |
| Consideration gap | `--consider` #A35A07 / #FBEEDC (4.6:1; use #8F4F06 for any body-size text) | **Square with a filled centre** | "Consideration gap" | 4px left rail |
| Discovery gap | `--discover` #4B5B78 / #E7EBF2 (5.7:1) | **Open circle** | "Discovery gap" | 4px left rail |
| Recommended work (suggested, drafting, ready for review) | `--work` #2450B8 / #E5ECFB (7.2:1) | **Dashed ring with a dot** | The exact state name | Hollow node in the pipeline |
| Approved / Published / Recheck scheduled | `--progress` #1E7A4C / #E1F2E8 (5.3:1) | **Check mark** in a solid node | The exact state name | Solid filled node |
| Result observed | `--observed` #0B6B70 / #DDF0F0 (5.3:1) | **Target** (ring + dot), with a halo | "Result observed" plus before→after values | Always paired with "association, not proof of cause" |
| Low confidence / insufficient data | `--unsure` #62676F / #EEEFF0 | **Dotted ring with "?"** | "Low confidence" / "Not enough comparable answers" | Dashed 1px pill; diagonal-stripe row background; no action is suggested |
| Engine / system failure | `--fault` #4A4F57 / #E6E7E9 | **Square with a slash** | "Not collected" / "Could not inspect — technical, not a gap" | **Hatched** −45° fill on cells and rows; italic label; never in gap counts |
| Archived | `--ink-3` | Archive box | "Archived" | Dashed outline; struck or dimmed title |

Confidence uses **three pips** (●●● high, ●●○ medium) followed by the word. Low confidence switches to the dashed pill above. Engine coverage cells are 9×9px. Named is filled `--you`, not named is a 1.5px `--ink-2` outline, and not collected is the hatched `--fault`. Every strip must have an `aria-label` such as "ChatGPT: Not named, Gemini: Not collected, Perplexity: Not named".

**Red budget:** `--decision` appears only on decision-gap tags, rails, the decision lane, the high-intent card and the single highlighted phrase in the statement. Do not use red for errors (use `--fault`), competitors (graphite) or buttons.

### 4.5 Motion
| Token | Value | Used for |
|---|---|---|
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | Everything |
| `--d1` | 160ms | Hover, chip toggles, focus, tab change |
| `--d2` | 280ms | Sheet/drawer open (translateY / translateX), row enter (6px slide in the journey direction), scrim fade |
| `--d3` | 640ms | Provenance wires drawing (stroke-dashoffset), coverage bar grow, lifecycle node advancing |

Rules:
- Motion explains state changes, so we animate a lifecycle transition (the node moves to the next column and the trail extends). We never add idle loops, shimmer or decorative spinners. Loading shows the current check stage in text.
- Stagger lists at 40–50ms per item, up to 6 items. After that there is no stagger.
- Only animate wires on an interactive open. A deep-linked or restored drawer renders lines statically.
- `@media (prefers-reduced-motion: reduce)`: set all animation and transition durations to 1ms and delays to 0. Wires render fully drawn. Sheets appear without sliding.

### 4.6 Layout grid
| Width | Shell | Content |
|---|---|---|
| ≥1680 (1920 target) | 224px sidebar + content, max-width 1560px centred, 40px padding | Hero 4/8 split (statement / map). Evidence opens as a **docked right inspector** (520px) instead of a bottom sheet. Gap rows keep the five-stage chain. |
| 1101–1679 (1440 target) | 224px sidebar + fluid content, 32px padding | Hero 5/7. Chain of 4 cards. Gap row columns `2.1fr 170px 1.2fr 1.35fr 1.5fr`. Evidence is a bottom sheet at 86vh (left edge = sidebar) with columns `1fr 1.2fr 300px` and an 84px wire gutter. |
| 761–1100 | ≤1024: sidebar becomes an off-canvas drawer opened from a sticky 56px top bar. 20px padding | Hero stacked. Decision cards 2×2. Gap rows on two lines (question / engines / shown instead, then evidence / recovery). Sheet spans the full width; brands become a row under the sources; wires are hidden. |
| ≤760 (390 target) | Sticky top bar (brand mark, page title, scope date) plus a floating dark bottom tab bar (Risk, Gaps, Why, Recovery, Progress), 16px padding, 84px bottom padding | Statement 22px. Scope chips wrap. The map shows **Decision lane first**, up to 4 questions per lane plus a link. Decision cards 2×2. Gap chains run **vertically** with a left connector line. Evidence is a 94vh bottom sheet with one column in the order answer → your page → sources → inference → brands, and its primary action is pinned in the footer. Recovery shows one card per action with a compact 8-step trail and a visible state label. |

## 5. Interaction and accessibility contract
- Drawers and sheets use `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing at the question. Focus moves to Close on open and returns to the invoker on close. Esc and a scrim click both close it. Focus is trapped while it is open.
- Every claim is one click from evidence. Every gap row, lane question and statement exposes `Inspect evidence`.
- Tabs use `role="tablist"`/`tab` and `aria-selected`. Toggle chips use `aria-pressed`. Selected matrix rows use `aria-expanded`.
- Never convey state only through the hatching or rail. The text label is always present, and it is visually hidden only on ≤760 where the icon and label both remain on the row.
- Hit targets are at least 28px on desktop and 40px on touch. At 200% zoom, the 1024 layout rules apply naturally.

## 6. Component recipes

Class names are suggestions, written to the vanilla CSS app. The reference implementation is `direction-b.html`.

### 6.1 Page header: scoped statement + scope line (`.stmt`)
- A white panel with `--r3`, `--e1` and 24/26px padding.
- Contents in order:
  - `--t-label` "Observed in this check".
  - An `h1` in `--t-display`, built from the 03 templates. The single highest-intent phrase is wrapped in `<span class="d">` and coloured `--decision`.
  - One consequence sentence in `--ink-2`.
  - The primary action (the `you` button "Inspect the strongest gap →").
  - The scope chips.
- Scope chips: mono 11.5px, `--surface-2`, height 26, labelled keys (`ENGINES`, `CHECKED`, `MARKET`, `QUESTIONS`, `ANSWERS 51/54`). A **hatched `--fault` chip** states the failures ("3 Gemini not collected"). The scope is mandatory on every page that makes a claim.
- Top crumb row: page crumb, comparison note ("compared with 25 Sep (comparable)"), and on the right `Methodology` (link), `Share with client` (ghost) and `Recheck recommendations` (primary ink).

### 6.2 Recommendation pathway map (`.map`, `.lanes`, `.lane`, `.qn`)
- Three lanes `1fr 1fr 1.15fr`: Discovery → Consideration → Decision. Each lane header shows its shape icon, name, and `gaps/completed` in mono.
- The Decision lane has a solid `--decision` left rule and a gradient wash.
- Each question is a button with a 3-cell engine strip and the question truncated with an ellipsis (full text in the title attribute and aria). Clicking it opens the gap drawer.
- A footer axis reads "Learning ──── Choosing" (mono, rule gradient to `--decision`). There is also a legend.

### 6.3 Decision card chain (`.chain`, `.ck`)
- One white strip containing four cells separated by hairlines, with a rotated-square chevron joining each pair.
- Each cell holds: a step label (`01 · COVERAGE`), a value in `--t-num`, and one human-readable sentence. Coverage adds a 6px `--you` bar and a comparable delta.
- Card 02 (high-intent gaps) is the only tinted cell (`--decision-wash`, value in `--decision`) and shows the mix with icons. Card 04's value is in `--work`.
- Each cell is a link to its page. Never add a fifth card. Put advanced metrics in a `<details>` below "What changed".

### 6.4 Gap row: evidence chain (`.row`)
- Five grid cells:
  1. Tag plus question.
  2. Engines: icon cell plus name per engine, with "· not collected" in italic `--fault`.
  3. Shown instead: graphite dot, name and `n/m` count.
  4. Evidence: page count in 20px, a source bar (graphite for pages mentioning a competitor, outline for the rest), then "x mention Competitor · y mention Brand" and confidence pips.
  5. Recovery: the action title, its state, and an `Inspect evidence` button. When there is no action, the cell reads "Too little evidence to suggest work".
- Connector arrows (14px line plus a 5px head) sit between cells. There is a 4px inset rail in the gap colour.
- Low-confidence rows get a 135° stripe background.
- Default sort: decision → consideration → discovery → competitor frequency → confidence.

### 6.5 Evidence drawer / sheet (`.sheet`, `.prov`)
- **Header:** grab handle, gap tag, confidence, a mono scope line, the question (20px), and a Close button.
- **Column 1, Observed answer:** engine pill tabs (each carrying its engine cell state); the timestamp, market and sample; the raw answer in a `--bg` box. Competitor names are bold with a 2px graphite underline and never recoloured red. The source text is never altered. A **dashed `--you` absence note** follows ("Saarvi Skin is not in this answer"), then the inspected facts about your page (✓ in `--progress` or ✕ in `--decision`).
- **Column 2, Cited sources:** source rows (§6.6), then an **Inference** box (`--work-wash`, tagged `INFERENCE · HIGH CONFIDENCE`) that states it is an interpretation.
- **Column 3, Who the evidence supports:** brand nodes. Competitors are solid; the user's brand is a dashed `--you` node that shows its count of supporting pages. An SVG wire layer draws cubic curves from each source row's right dot to each brand it mentions: graphite at 60% opacity for competitors, dotted `--you` for weak mentions of the user's brand. Add a caption explaining the lines.
- **Footer:** the primary next action (`Open draft A-104 for review`), a secondary action (`Pursue inclusion on …`), the action-rationale template in `--t-sm`, and a `Methodology` link.
- At ≥1280, add a **Compare** tab or block using C's table (§6.8).

### 6.6 Source row (`.srow`)
- Mono URL (ellipsis) on the left; on the right, the kind and cited count (`Roundup · 3/3`).
- The second line lists which brands it mentions (owner pages marked "(own)"), then "Inspected 9 Oct".
- If it could not be inspected: dashed border, hatched background, and a `--fault` "Could not inspect — technical, not a gap" label.
- On the Evidence sources page, the default view is pages, with a "Group by domain" toggle. The row action is "Pursue inclusion" (outline button), presented as a hypothesis.

### 6.7 Dense tables (Buyer questions, AI answers, Evidence sources)
- Use C's table recipe in B's colours: a sticky mono header on `--surface-2`, 10px cell padding, the gap rail in the first cell, engine cells as 22×18 text badges (`CH`/`GE`/`PE`), and the selected row in `--work-wash` with a 3px inset `--work` edge.
- A filter-chip bar above it: intent, engine, persona, status, competitor.
- `J`/`K`/`E`/`A` shortcuts with a visible hint.
- Engine failures show as a hatched row explaining their exclusion.

### 6.8 Competitor comparison (`.cmpt`)
- A table with rows for evidence categories (named in answers, in cited roundups, owned page states key fact, structured data, forum mentions, search presence) and columns for You (the `--you-wash` column) plus up to 3 competitors.
- Cells use ✓ Yes n / — No / △ Not inspected, always with text. The header is labelled "Observed · this question" or "Observed advantage".
- The Competitor advantages page repeats this per advantage category, with a confidence label.

### 6.9 Recovery plan
- **Path summary on the risk page (`.pipe`):** 8 nodes on a connecting line. Work states are hollow `--work` dashed rings, progress states are solid `--progress` checks, result observed is a solid `--observed` target with a halo, and archived is a grey box. Each node shows the count in 20px and the state name. Below it sit two notes: "2 drafts await your review — approving does not publish" and an observed-result note with its association caveat.
- **Board / matrix (`.mx`):** a sticky header row of the 8 states with counts. Group rows are Decision, Consideration and Discovery. Each action row has a 340px label (title, id, kind, question, low-confidence pill) plus 8 cells. The trail runs from the first stage to the current one: passed stages are 10px graphite dots, and the current stage is a 24px node in its state style with a mono caption (`due 13 Oct`, `Sent 30 Sep`, `0/3 → 1/3`). Archived rows show only the archive node. There is also a priority-list view toggle in the page actions, sorted by intent × confidence.
- **Action detail (expands inline below the row; a docked panel at ≥1680):**
  - Three columns.
    1. Observed problem plus proposed intervention plus the rationale template.
    2. A definition list: State, Owner, Due, Approval, Published URL, Recheck, Result and Confidence. Empty values say what is needed ("Not yet — add live URL", "Needs a later comparable check").
    3. The draft card and the evidence links.
  - **Transitions** are explicit buttons for valid next states only: Approve / Back to drafting / Archive. There is no "Done". Publishing requires a URL and date field. "Result observed" is never a button; it appears only from a comparable run.
- **Recovery column/card (≤1100 and mobile):** a white card with `--r2` and `--e1`, a 4px gap rail, title, id · kind · question, a visible "State: …" label, and a compact 8-step trail.

### 6.10 Draft card (`.draftc`)
- A dashed `--line-2` border, `--bg` fill and a doc icon.
- Title "Draft vN — review before publishing". The meta shows word count · "n [TODO] claims to verify" · generated date.
- It always links back to its gap and action. On the Drafts page, cards are grouped by Page / Pitch / Schema / llms.txt / Page fix, and the label is mandatory.

### 6.11 Empty, error and insufficient states
- **Empty** (for example, no gaps of a type): a white panel with a neutral icon, a one-line explanation of what is missing, and the next safe action ("No decision gaps in this check. Review consideration gaps").
- **Engine error:** hatched `--fault` panel or row, square-slash icon, "This answer could not be collected", and "Retry this engine". It is excluded from every count, and the scope line says so.
- **Insufficient:** dotted-ring icon, `--unsure` text, the 03 copy "WhitePetal does not yet have enough comparable answers to call this a trend." No inference box and no suggested action.
- **Incomparable runs** (Change over time): a `--unsure` banner with the reason (different engines, questions or market). Percentage deltas are disabled, and only raw counts per run are shown.
- **Loading:** show the current check stage in text ("Checking Gemini · 31 of 54 answers"), plus Cancel. No skeleton shimmer.

### 6.12 Navigation with section headings (`.nav`)
- A 224px white sidebar.
- From the top:
  - The Perfstaq three-bar mark plus "White Petal".
  - The brand switcher: an orange letter tile, the brand, and "India · 18 buyer questions".
  - Section heads in mono 10.5px uppercase with a 5px dot: **Home** (Recommendation risk, Evidence readiness), **Gaps** (Buyer questions, Recommendation gaps, AI answers), **Why they win** (Evidence sources, Competitor advantages, Search influence), **Recovery** (Recovery plan, Drafts), **Progress** (Competitive landscape, Change over time).
- Items are 13.5px with mono counts on the right. The active item is an ink fill with white text and `aria-current="page"`.
- ≤1024 it becomes an off-canvas drawer, and the sections collapse to disclosure groups.

### 6.13 Account menu (`.acct`)
- Pinned at the bottom of the sidebar: avatar, name, and "Role · Settings, team, billing".
- It opens an `--e2` menu (`role="menu"`) with Settings, Team, Organization, Integrations, Billing and Sign out. Admin-only items (environment/API) are hidden from non-admins.
- On mobile it is the avatar button in the top bar.

### 6.14 Buttons
| Variant | Style | Use |
|---|---|---|
| Primary | Ink fill, white text, height 34 (28 small), `--r1`, weight 500 | One per area: Recheck, Approve, Open draft |
| You | `--you` fill, #1a0d03 text (5.75:1) | Only for the single "go to the strongest gap" entry point |
| Ghost | White with an inset `--line-2` ring | Secondary actions |
| Link | `--work` text | Navigation within a section |

## 7. Implementation notes for Task 9
1. Swap the tokens first (§4), keeping the legacy aliases. Load nothing new: Geist is already loaded.
2. Copy the icon `<symbol>` set from `direction-b.html` into `public/index.html` once, and reference it with `<use href="#i-…">`.
3. Wire layout: a `drawWires(container)` helper that measures rows, writes one absolutely positioned SVG, re-runs on resize (debounced) and on tab switch, is skipped below 1100px, and adds the draw animation only when the drawer was opened by the user (see the prototype's `body.animate`).
4. Apply the system to landing, onboarding, first results, every nav destination, the drawer, the Recovery plan, Drafts and mobile. Don't apply it to the overview alone; 08 treats that as a release stop.
5. Validate at 390×844, 768×1024, 1440×900 and 1920×1080. Check reduced motion, keyboard focus order and 200% zoom.
