# Dev Notes

Working notes for in-progress features. Not part of the user-facing docs.
Update this file as features land or context changes — it's the
hand-off mechanism between work sessions and across machines.

---

## Set Grading System (in progress, dev-only)

Wired end-to-end and gated behind `import.meta.env.DEV`. Production
builds tree-shake the entire feature out — visible only when running
`npm run tauri dev`.

### What's built

- **`src/lib/grading.ts`** — `gradeSet(games, playerChar, opponentChar, setResult, wins, losses)` returns a `SetGrade` with overall letter/score, four category grades (Neutral, Punish, Defense, Execution), and per-stat breakdowns. Categories are equally weighted; stats within a category are equally weighted.
- **`src/lib/grade-benchmarks.ts`** — Generated from `scripts/grade_baselines.json`. Per-character percentile thresholds (P5/P10/P25/P50/P75/P90/P95) for each stat. Characters with fewer than 20 samples in the baseline fall back to the `_overall` bucket.
- **`src/components/SetGradeDisplay.svelte`** — Renders the overall grade card + category rows. Iterates `CATEGORY_DEFS` from grading.ts so display always matches the grading logic.
- **Watcher integration** (`src/lib/watcher.ts`, `handleRankedGame`) — When a set completes during a live watcher session, calls `gradeSet` against in-memory `liveGameStats` and writes the result to `lastSetGrade`. Gated by `import.meta.env.DEV`.
- **Dev test panel** (`src/components/tabs/LiveRankedSession.svelte`) — Yellow card at the top of the **Live Ranked Session** tab. Picks any of the last 100 completed sets from a dropdown, re-parses each game's .slp file, runs `gradeSet`, and renders `SetGradeDisplay`. Only way to test grading without playing a full ranked set, because:
  - The `games` SQL table only stores metadata (filepath, char IDs, result, etc.)
  - Per-game stats (openings/kill, neutral win ratio, etc.) live only in `liveGameStats` during a watcher session
  - The watcher pre-populates `_preExistingMatchIds` from the DB on startup, so re-triggering on existing files won't fire grading

### How grading works

For each stat in a completed set, `percentileScore(value, thresholds, inverted)` linearly interpolates between bench percentiles to produce a 0–100 score. `INVERTED_STATS` (currently `openings_per_kill`, `avg_kill_percent`) are scored where lower = better. Letter grade thresholds: S ≥ 95, A ≥ 90, B ≥ 75, C ≥ 50, D ≥ 25, F < 25.

### Open issues before shipping

1. **Low per-char sample sizes** — Fox/Marth/Ice Climbers had ≤10 samples in the 1k SlippiLab pull, below the 20-sample threshold. A 5000-replay fetch was kicked off via the parallelized fetcher (~60 replays/min, ~90 min total). When done, regenerate `src/lib/grade-benchmarks.ts` from the new `scripts/grade_baselines.json`.
2. **`inputs_per_minute` placeholder** — py-slippi's frame API doesn't surface pre-frame button bytes. The in-app TS parser computes IPM live from pre-frame event 0x37, but no community baseline exists. Either port input-counting to Python or derive a baseline from accumulated user data.
3. **`_overall` kill% == death%** — identical by symmetry when both ports of a 1v1 are pooled. Per-char values diverge correctly. Chars falling back to `_overall` get identical raw thresholds for kill/death% (scored in opposite directions, so still produces a signal).
4. **Grade history persistence — proposed, not built.** Add a `set_grades` SQL table keyed by `match_id` storing overall letter/score, per-category scores, per-stat values + scores, `baseline_version`, and `generated_at`. Insert from `watcher.ts` `handleRankedGame` when grading runs; optionally insert from the dev test panel too. Surfaces as a future history view. Discuss approach before building.

---

## Baseline pipeline (`scripts/`)

Three Python scripts build the percentile benchmarks consumed by the in-app grading code.

### `scripts/fetch_slippilab_replays.py`

Pulls 1v1 replays from the SlippiLab public API, parses each one with py-slippi, computes the same stats the in-app TS parser computes, and writes `scripts/grade_baselines.json` (P5/P10/P25/P50/P75/P90/P95 for each stat, grouped by player char, opponent char, and `_overall`).

```bash
python3 -u scripts/fetch_slippilab_replays.py --limit 5000 --workers 4 --output scripts/grade_baselines.json
```

- `--workers` defaults to 4. `ProcessPoolExecutor` parallelizes download + parse + stat compute. Bump higher if network/CPU has headroom.
- Download URL must use `file_name` (UUID.slp), not numeric `id` — `/api/replay/{id}` 404s.
- Action-state ranges (`is_in_control`, `is_vulnerable`) are kept identical to `src/lib/slp_parser.ts` to avoid the divergence bug that previously inflated `damage_per_opening` (resolved in `d08339d`).
- Logs to `scripts/logs/` (gitignored).

### `scripts/global_baseline_parser.py`

Streams a hypothetical 140 GB JSON dump of global Slippi match data using `ijson` (constant memory) and overwrites `scripts/grade_baselines.json`. Code-complete and aligned with the dual-grouping schema (`by_player_char` + `by_opponent_char` + `_overall`). **Do not execute** until the JSON format is confirmed.

### Regenerating in-app benchmarks after a fresh fetch

After the fetch script writes a new `grade_baselines.json`, regenerate `src/lib/grade-benchmarks.ts`. The conversion is mechanical (read JSON, emit a TS const exporting `BENCHMARKS`). Most recent regeneration is committed in `d08339d`.

---

## Cross-machine workflow

Anything that needs to travel between machines must be in git. Per-machine state that does NOT travel:

- Claude's auto-memory (`~/.claude/projects/.../memory/`)
- App data (`~/Library/Application Support/Slippi Ranked Stats/data/{CONNECT_CODE}.db`)
- `scripts/logs/` (gitignored)

When picking up work on a different machine, this file plus `git log --oneline` is the source of truth.
