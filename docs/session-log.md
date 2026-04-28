# Session Log

Chronological notes on recent work sessions. Purpose: when another assistant picks up the repo on a different machine, this file + `git log --oneline` + `docs/dev_notes.md` give enough context to continue without re-deriving decisions.

Newest first.

---

## 2026-04-28 — Mac dev environment + multi-code scan bug diagnosed

**Machine:** Mac

### What happened

- Set up Tauri dev environment on Mac (`npm install` + `npm run tauri dev`). App launches, Discord premium verifies, Get Current Rating works, scan path works after the fix below. Compile took 2m 30s on first build; subsequent launches are fast.
- HMR can leave Tauri ↔ Rust callback state stale across hot reloads — fixed by Cmd+R in the app window. Not a code bug, just a dev-mode quirk to remember.
- Tester reported "ranked replays in folder, app misses some." Reproduced on Mac with their 10 test `.slp` files.

### Bug found: multi-code scanning

Scan only ingests for `$connectCode` (primary). Linked codes are unioned at display time but never at ingest. Compounded by `scanned_files` table being keyed on filename only — files dropped under primary-only logic are stuck on the "already scanned" list and never re-tried after adding a linked code.

**Full diagnosis trail and fix design lives in [`docs/multi-code-scan-fix.md`](multi-code-scan-fix.md).** That doc is the working spec — pick it up there to implement on Windows.

### Side fix shipped this session

`statusMessage` writable was being `.set()` from five places in `Sidebar.svelte` but never rendered anywhere — every scan/rescan/rating-fetch result was silent. Added a one-line render below the scan progress bar so the message actually shows. This was the only thing masking the multi-code bug for so long.

### Untracked: `TestingSLPFiles/`

Tester's 10 test `.slp` files. Added to `.gitignore`. Stay on local disk; not committed.

### Other small things

- `future-log.md`: added Mac distribution to Ideas; moved multi-code profiles + richer session history to Shipped (both shipped in v1.4.0).
- `package-lock.json` and `Cargo.lock` resynced to match `package.json` / `tauri.conf.json` (was a pre-existing version drift).
- New `src-tauri/gen/schemas/macOS-schema.json` (Tauri-generated, sibling to the already-tracked `windows-schema.json`).

### Commits this session
- `c01bc0b` — Mac dev setup: resync lockfiles, log Mac distribution as future feature
- (next) — Show statusMessage in Sidebar; gitignore TestingSLPFiles; add multi-code scan fix design doc

### Hand-off

- Mac stays as a dev environment going forward. Joey will copy `.slp` files over for proper feature testing later.
- Multi-code scan fix is **not started**. Work picks up on Windows from `docs/multi-code-scan-fix.md`. After implementation, cut a new release.

---

## 2026-04-18/19 — Ko-fi, benchmark rescan, UI polish, beta.2 release (v1.4.0-beta.2)

**Machine:** Windows

### Product decisions made

- **Ko-fi added as a premium payment option.** Patreon listed first everywhere (red), Ko-fi second (blue). Discord role verification works for both. Help links point to platform-specific support articles (Patreon: support.patreon.com/…/212052266, Ko-fi: help.ko-fi.com/…/8664701197073).
- **Benchmark rescan completed.** Full HuggingFace rescan with corrected `lastHitBy` kill attribution and both OCR fixes: 177,538 replays, 345,012 samples, 26 characters, 183 matchup entries. `opening_conversion_rate` is now benchmark-accurate and fully scored (removed from display-only list).
- **OCR accuracy ceiling acknowledged.** 81% of games ≤3pp vs slippi-js. Frame-level vs move-level data is the hard limit — no code change will close this gap without access to slippi-js move data. Acceptable for grading purposes.
- **Tab-switch flash fixed at the store level.** Root cause: `gradeHistory.set([])` at effect start caused blank render on remount. Removed the eager clear; store persists across tab switches, data hydrates from DB on mount without wiping first.

### Changes made

- **`src/components/tabs/GradeHistory.svelte`** — Connected/no-role state: Patreon first (red #FF424D), Ko-fi second (#29ABE0), Discord help links added. Unlock card redesigned to 3-column horizontal layout (text | support buttons | Discord links). Removed eager `gradeHistory.set([])` to fix tab-switch flash. Description updated to mention Live Session tab.
- **`src/components/Sidebar.svelte`** — Connected/no-role state: Patreon first, Ko-fi second, help links added. Unlock flow: Patreon first, Ko-fi second in Step 1. Button text centered (added `justify-content: center`). Added feature summary under "UNLOCK PREMIUM" heading. "Patron" → "Premium" in connected state display.
- **`src/components/PremiumGate.svelte`** — Ko-fi URL corrected (supporter-facing article). Help text updated to "Having trouble connecting with Discord? Check out these support articles:".
- **`src/components/tabs/LiveRankedSession.svelte`** — PremiumGate description updated to cross-mention Grading tab set breakdown.
- **`src/lib/grading.ts`** — `opening_conversion_rate` removed from `DISPLAY_ONLY_STATS` (now fully scored after rescan). `CATEGORY_WEIGHTS` remains `{ neutral: 0.40, punish: 0.40, defense: 0.20 }`.
- **`src/lib/grade-benchmarks.ts`** — Regenerated from rescan (177k replays, both OCR fixes, `lastHitBy` attribution).
- **`scripts/grade_baselines.json`** — Updated by rescan.
- **`CLAUDE.md`** — Added Security section: never read `.env`, `*.pem`, `*.key`, `credentials.*`, etc.
- **`docs/dev_notes.md`** — Updated category weights, per-stat weights, baseline counts; marked rescan resolved; added premium gating section; cleaned up stat-fixes table.
- **`release-notes.md`** — Updated for v1.4.0-beta.2 (correct weights, Ko-fi, 18 stats, UI polish).

### Commits this session
- `df2a9f6` — Update dev_notes: reflect rescan completion, Ko-fi addition, current state
- `20d5026` — Update release-notes.md for v1.4.0-beta.2

### Release
- Tag `v1.4.0-beta.2` pushed; GitHub Actions built and signed the installer; release notes patched via `gh release edit` after workflow completed.

---

## 2026-04-18 — Grading overhaul, UI polish, beta release (v1.4.0-beta.1)

**Machine:** Windows

### Product decisions made

- **Execution category removed from scoring.** L-cancel, IPM, and wavedash miss rate remain in the breakdown display but carry zero weight. The plateau in technical execution at mid-to-high levels makes them poor discriminators.
- **New category weights: Neutral 40%, Punish 40%, Defense 20%.** Per-stat weights added within each category — D/O and OPK at 30% each within Punish (primary efficiency signal).
- **Connect code switching bug fixed.** `onMount` only fired once; replaced with `$effect` so grade history correctly reloads when the user switches connect codes.
- **Beta distribution strategy.** Modified `release.yml` to detect `-beta` tags and create GitHub pre-releases instead of stable releases. `/releases/latest` endpoint excludes pre-releases, so existing users' auto-updater is unaffected. Tag `v1.4.0-beta.1` pushed; build confirmed running.
- **Next rescan planned post-tester feedback.** Current benchmarks predate the `lastHitBy` kill attribution fix. Effect is small (SDs rare in ranked) but will be corrected in the next rescan before stable release.

### Changes made

- **`src/lib/grading.ts`** — `CategoryKey` removes `"execution"`; `CATEGORY_WEIGHTS` → `{ neutral: 0.40, punish: 0.40, defense: 0.20 }`; `STAT_WEIGHTS` populated with per-stat weights for all 14 scored stats; `CATEGORY_DEFS` execution entry removed.
- **`src/lib/watcher.ts`** — execution score/letter DB writes now write `null`.
- **`src/components/SetGradeDisplay.svelte`** — execution removed from `CATEGORY_ORDER`; overall badge scaled to 80px/38px; category headers 14px; stat rows use `1fr 160px 48px 28px` grid (label gets 1fr, bar capped at 160px); stat name 15px/600 weight, value 13px; bar height 6px; new grade colors (S=gold, A=green, B=sky blue, C=amber, D=orange, F=red).
- **`src/components/tabs/GradeHistory.svelte`** — execution removed from `rowToEntry` and DB writes; `onMount` → `$effect` for connect-code reactivity; non-premium banner replaced with full Patreon→Discord step flow (adapts to Discord connection state); filter bar redesigned as labeled card with GRADE/RESULT/CHARACTER/SORT groups and Clear filters button; distribution summary and table rows scaled up; tab section title updated to "Grading".
- **`src/App.svelte`** — tab renamed `"📝 Grading"`, Live Session moved to last position (index 5), PRO badge removed.
- **`docs/grading_methodology.md`** — fully rewritten for 3-category structure, per-stat weight tables, note that methodology will evolve.
- **`.github/workflows/release.yml`** — detects `-beta` in tag name and passes `--prerelease` to `gh release create`.
- **`src-tauri/tauri.conf.json`**, **`package.json`** — version bumped to `1.4.0`.
- **`release-notes.md`** — updated for v1.4.0 beta.

### Commits this session
- `ebb73c1` — Overhaul grading UI and weight system for tester release
- `9800853` — Bump version to 1.4.0; add beta pre-release support to release workflow

---

## 2026-04-17 — Free/premium split for grading + user-facing methodology

**Machine:** Mac (primary)
**Parallel work:** Windows machine ran `parse_hf_replays.py --character ALL` during this session to regenerate baselines with the corrected stat methodology (see previous entry). **Do not touch `scripts/grade_baselines.json` or `src/lib/grade-benchmarks.ts` until that completes.**

### Product decisions made

- **Premium gating strategy for grading finalized.** Set Grades tab becomes the shared free/paid surface. Free users see the overall letter + strongest/weakest category for every graded set. Premium unlocks the per-category scores, per-stat breakdown, and matchup-specific baselines. Live Session tab stays entirely premium — the live grade card is a premium bonus, not the free teaser.
- **Rejected alternatives:** (1) gutting Live Session to free (loses existing premium anchor), (2) mixed gating inside Live Session (every component needs two render paths).
- **Framing:** grading is positioned as "a directional read, not a verdict" — both in the methodology doc pull-quote and as a short in-app line in the Set Grades tab header. Not a perfect grading system, just a tool to help see strong/weak areas.

### Changes made (uncommitted at time of writing, intended to land together)

- **`src/components/SetGradeDisplay.svelte`** — new `detailed: boolean` prop (default true). When false: renders the overall badge + a strongest/weakest summary row + a Patreon upgrade button. When true: the existing full breakdown.
- **`src/components/tabs/GradeHistory.svelte`** — removed the top-level `PremiumGate` block so free users can access the tab. Added a non-blocking upsell banner at the top for free users. Expanded rows render `SetGradeDisplay` with `detailed={$isPremium}`. Fixed pre-existing TS errors (`filterLetter`/`sortMode` used before declaration). Added "How is this calculated?" link in the header pointing to `docs/grading_methodology.md` on GitHub.
- **`README.md`** — removed incorrect "rating history" claim from Premium section, added Set Grading to Features list, expanded Premium section to spell out what's in each tier.
- **`docs/grading_methodology.md`** *(new)* — user-facing long-form doc. Explains: grade thresholds, 4 categories with stat-by-stat breakdown, why 35/35/25/5 weights, percentile-to-score mechanic, win bonus, three-tier baseline lookup, dataset size (221,942 replays), kill%/death% caveat, what's excluded, parser accuracy vs slippi-js, honest limits.
- **`docs/set_grades_persistence.md`** *(new)* — proposal doc for the `set_grades` SQL table. Schema, baseline-versioning strategy, insertion points, Rust/Tauri commands, open questions. **Not implemented yet — discuss before building** (per CLAUDE.md).
- **`docs/dev_notes.md`** — added section documenting the ground-truth comparison scripts (`compare_stats.cjs/mjs`, `our_stats.cjs`). Linked the persistence proposal.
- **`release-notes-draft.md`** *(new, not the live file)* — draft release notes for the grading launch + parser accuracy improvements. Keeping `release-notes.md` untouched (that's the live v1.3.8 content).

### Gaps / flagged for later

- **`lastSetGrade` is written but never rendered.** `dev_notes.md` claims the live grade card is "shown in Live Session tab for premium users" but `LiveRankedSession.svelte` doesn't reference `lastSetGrade` at all. Either the live card was removed at some point or was never finished. Decide: build it (with free/premium parity — same `detailed` split), remove the watcher write, or leave as-is until grading ships.
- **`set_grades` persistence** — proposal exists (`docs/set_grades_persistence.md`), implementation blocked on Joey's review.
- **`wavedash_miss_rate`** — detection fixed, waiting on the in-progress rescan to populate baselines.

### Constraints honored

- No Claude attribution on any commits (per `CLAUDE.md`).
- Grading feature remains gated (now `$isPremium`, not `import.meta.env.DEV`) — dev_notes.md reflects current state.
- Did not touch `grade_baselines.json` or `grade-benchmarks.ts` during the rescan.

### Follow-up work in the same session

After the free/premium split landed (commit e092e00), three more items were completed:

- **Live Session post-set grade card wired up.** `LiveRankedSession.svelte` now imports `lastSetGrade` from store and `SetGradeDisplay`, and renders the grade below the per-game rows when the current set is complete. Hides automatically when a new set starts (because `lastMatch` becomes incomplete). Closes the orphaned-`lastSetGrade` gap flagged above. No free/premium prop passed — the tab itself is premium-gated, so the grade is always rendered in full detail.
- **`future-log.md` cleaned up.** The only entry was the original 2026-04-14 post-set letter grade idea, now shipped. File restructured with a `## Shipped` section; entry moved there with a link to `docs/grading_methodology.md`.
- **Unit tests for `grading.ts`.** Added `vitest` as a dev dep, wired `test` + `test:watch` scripts, created `src/lib/grading.test.ts` with 14 tests covering `scoreToGrade` boundaries, `gradeSet` shape invariants (all 18 breakdown keys, 4 categories, score clamped to [0, 100], letter matches score), the +5 win bonus (including cap behavior), baseline-source fallback, and category definition sanity checks. All passing.
