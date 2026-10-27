# Plan: remove every mention of Lunar Melee from the repo

Status: **planned, not started** (Joey, 2026-10-26). No date set.

Goal: no file in the current tree names Lunar Melee, while the benchmarks keep working and the
pipeline stays reproducible. Their fair-use page calls the credit "appreciated, not required",
so dropping it breaks no terms.

## Scope decisions (settle before starting)

1. **Git history: leave it alone (recommended).** Past commits, the `v1.14.0` commit title
   ("…benchmarked against Lunar Melee's replays…") and the `feat/lunar-benchmarks` branch keep
   the name. Scrubbing them means rewriting `main` and force-pushing: every clone breaks, tags
   move, and it can't be undone. Do it only for a strong reason, and as its own decision.
2. **Neutral name for the source.** Pick one label for the data everywhere, e.g. `community`
   (sources `community_direct`, `community_netplay`, …) and `replay_ingest.py` for the script.

## Steps

### 1. User-facing (do first, smallest)
- `release-notes.md` — delete the line "Data from Lunar Melee (lunarmelee.com)." in v1.14.0.
- **GitHub release page for v1.14.0** — edit its body (`gh release edit v1.14.0 --notes-file …`);
  it was generated from release-notes.md and won't update on its own.
- `CLAUDE.md` — v1.14.0 bullet says release notes *must* credit Lunar; remove that rule with the
  rest of the mentions (also the "Lunar ingest" wording in the chart-hover bullet).

### 2. Shipped data labels
- `src/lib/grade-benchmarks.ts` header (`Source: stats_db:lunar_direct+…`) and
  `scripts/grade_baselines.json` (`source` string + the five `lunar_*` sample counts).
- ⚠ These are generated from the StatsDB, so editing the files alone is undone by the next
  rebuild. Rename the source values in the DB first, on the machine that has it:
  `UPDATE games SET source = replace(source, 'lunar_', 'community_') WHERE source LIKE 'lunar_%';`
  in `scripts/raw_stats_v3.sqlite` (gitignored; check `benchmark_excluded`/`pool` for the
  column too), then regenerate both files.
- ⚠ Regenerating changes `BENCHMARKS_VERSION`, which regrades every stored grade on update.
  Either keep the numbers identical (only the label changes, so grades won't move) and hand-edit
  the label while keeping the old version stamp, or ship the regen with a release. Decide then.

### 3. Pipeline scripts (rename, don't delete — they're the record of how benchmarks were built)
- `scripts/lunar_ingest.py` → `scripts/replay_ingest.py` (39 mentions: docstring, `lunar_*`
  source strings, temp/cache prefixes, the API constant, `--bundle` help text).
- `scripts/lunar_nonlegal_fetch.py`, `scripts/lunar_nonlegal_match.py` → `nonlegal_fetch.py`,
  `nonlegal_match.py`.
- `scripts/parse_hf_replays.py:1237` — comment only.
- ⚠ The API URL `api.lunarmelee.com` has to stay somewhere for the scripts to run again. Move it
  to an env var / CLI flag with no default (`--api-base`), and keep the value outside the repo.
- `.gitignore` — `lunar_checkpoint.json` / `lunar_*.checkpoint.json` → the new names. Rename any
  existing checkpoint files on disk to match.

### 4. Docs
- `docs/plans/lunar-benchmarks.md` — rename (e.g. `community-benchmarks.md`) and rewrite without
  the name; keep the technical content (.slpz format, streaming, non-legal-stage matching).
- `docs/dev_notes.md` — ~14 mentions in the 10-15 → 10-21 handoff banners. Reword them.
- `site/` currently has none; re-check.

### 5. Verify and finish
- `git grep -i lunar` returns nothing (this plan file included — delete it as the last step).
- `npx vitest run` green; `scripts/test_parity.py` green if any script logic was touched.
- Outside the repo (doesn't travel, but tidy): Claude memory files that mention it.
