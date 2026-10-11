# Painkiller UX: implementation log (2026-10-11)

Running log for the WhitePetal "AI recommendation intelligence and recovery" evolution
(spec: `WhitePetal-Claude-Code-Handoff-2026-10-11/`, plan `07-IMPLEMENTATION-PLAN.md`).
Each task appends its baseline, commands, results and anything deferred.

## Task 1: baseline

- Branch: `petal-1`
- HEAD: `366fa82` (feat(dashboard): instant hover hints, settings in sections, safe brand switching)
- Restore tag: `petal-1-before-painkiller`
- `git status --short`: clean (only `?? docs/design/`, owned by the concurrent visual-directions work; not touched here)
- Node `v22.22.0`

Baseline `npm test`, against a disposable database (`createdb whitepetal_pk1`;
`TEST_DATABASE_URL=… DATABASE_URL=… npm test`, never the `whitepetal` dev database):

```
# tests 64
# pass 63
# fail 1
```

The one failure is pre-existing and fails on untouched code:
`not ok 54 - organisations: invites, roles, own keys, budget, scheduler, audit`.

## Task 1: language contract and copy guard

- `public/product-language.js`: immutable (deep-frozen) `window.WP_LANGUAGE` with `NAV` (02's IA, existing route
  keys reused; `drafts` and `trend` are new keys for later tasks), `LABELS`, `GAP_TYPES`/`GAP_ORDER`, `LIFECYCLE`
  (the `recovery_actions` statuses, no "Done"), `COPY` (03 positioning, account gate, onboarding questions),
  `claims` (03 scoped templates + `scope`, `pursueInclusion`, `strengthenEvidence`), `PROHIBITED` and `findProhibited(text)`.
  Loaded before `app.js` in `public/index.html`.
- `test/product-language.test.mjs` loads it in a VM. Red first (10/10 failing: file missing), then green.
- Copy guard scans `public/*.js`, `public/*.html` (except `product-language.js` itself, whose copy is checked
  separately) and `api/write.js`. "AI says" counts as scoped only when the same line names an engine; "guarantee"
  is allowed when negated ("does not guarantee").
- Known violations are allowlisted in `KNOWN_VIOLATIONS` with a TODO. The test fails on any new violation and on any
  stale entry, so the list can only shrink; Task 10 must leave it empty:

  | File | Term | Count | Owner task |
  |---|---|---|---|
  | public/index.html | get you named | 2 | 3 (meta + og description) |
  | public/index.html | get named | 1 | 3 (how-it-works step 03) |
  | public/app.js | unscoped AI says | 5 | 5, 6, 8 (comments, phase label, "AI says:" action, Perception subtitle) |
  | public/app.js | fastest way | 2 | 6 (agent thought, Gap analysis subtitle) |
  | public/app.js | get named | 2 | 6, 8 ("Get named on" action + pitch modal) |
  | public/app.js | win it | 1 | 5 ("Draft a page to win it") |
  | public/app.js | biggest single lever | 1 | 6 (Search rankings subtitle) |

- `package.json` description/keywords and the README summary now state the category and promise.
- Full suite after: `# tests 74 # pass 73 # fail 1` (same pre-existing organisations failure).
