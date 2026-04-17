# Session Log

Chronological notes on recent work sessions. Purpose: when another assistant picks up the repo on a different machine, this file + `git log --oneline` + `docs/dev_notes.md` give enough context to continue without re-deriving decisions.

Newest first.

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
