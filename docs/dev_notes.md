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
- **`src/lib/grade-benchmarks.ts`** — Generated from `scripts/grade_baselines.json`. Three-tier benchmark structure: `by_matchup[playerChar][oppChar]` → `by_player_char[playerChar]` → `by_player_char["_overall"]`. Characters with fewer than 20 samples fall back to the next tier.
- **`src/components/SetGradeDisplay.svelte`** — Renders the overall grade card + category rows. Iterates `CATEGORY_DEFS` from grading.ts so display always matches the grading logic. Shows "matchup baseline" / "overall baseline" annotation when applicable.
- **Watcher integration** (`src/lib/watcher.ts`, `handleRankedGame`) — When a set completes during a live watcher session, calls `gradeSet` against in-memory `liveGameStats` and writes the result to `lastSetGrade`. Gated by `import.meta.env.DEV`.
- **Dev test panel** (`src/components/tabs/LiveRankedSession.svelte`) — Yellow card at the top of the **Live Ranked Session** tab. Picks any of the last 100 completed sets from a dropdown, re-parses each game's .slp file, runs `gradeSet`, and renders `SetGradeDisplay`. Only way to test grading without playing a full ranked set, because:
  - The `games` SQL table only stores metadata (filepath, char IDs, result, etc.)
  - Per-game stats (openings/kill, neutral win ratio, etc.) live only in `liveGameStats` during a watcher session
  - The watcher pre-populates `_preExistingMatchIds` from the DB on startup, so re-triggering on existing files won't fire grading

### How grading works

For each stat in a completed set, `percentileScore(value, thresholds, inverted)` linearly interpolates between bench percentiles to produce a 0–100 score. Letter grade thresholds: S ≥ 95, A ≥ 90, B ≥ 75, C ≥ 50, D ≥ 25, F < 25.

**Algorithm details (as of current session):**
- `INVERTED_STATS`: `openings_per_kill`, `avg_kill_percent`, `defensive_option_rate` (lower = better)
- `avg_kill_percent` and `avg_death_percent` are **skipped** when `baselineSource === "overall"` — the `_overall` bucket has identical values for both by symmetric pooling, making scores misleading. Only scored with character-specific data.
- **Win bonus**: +5 added to the composite score for a set win (capped at 100). Winning a set reflects adaptability and reads not captured by raw metrics.
- **Benchmark lookup**: matchup (player × opp) → player char → `_overall`. The display shows which tier was used.

**Stats by category:**
| Category  | Stats                                                          |
|-----------|----------------------------------------------------------------|
| Neutral   | `neutral_win_ratio`, `counter_hit_rate`                        |
| Punish    | `damage_per_opening`, `openings_per_kill`, `avg_kill_percent`  |
| Defense   | `avg_death_percent`, `defensive_option_rate`                   |
| Execution | `l_cancel_ratio`, `inputs_per_minute`                          |

**All 9 stats now have real community baselines** (from HuggingFace parse, see below):
- `counter_hit_rate` — % of neutral wins where opponent was mid-attack when opened. Measures neutral read quality. Tracked in `slp_parser.ts` via `isAttacking()`: states 44–74 (ground+aerial attacks) + 0xB0–0xB2 (specials).
- `defensive_option_rate` — player's roll/spotdodge uses per minute (inverted). Tracked via transitions into states 29 (roll fwd), 30 (roll back), 31 (spotdodge). Fewer = better defensive decision-making.
- `inputs_per_minute` — computed from `pre.buttons_physical` frame changes via peppi-py. Character-specific (Fox/Falco ~250 IPM, Puff ~150 IPM).

### Open issues before shipping

1. ~~Low per-char sample sizes~~ **Resolved.** HuggingFace Falco parse (42,547 replays) provides massive sample sizes for all characters Falco faces. Combined with 5k SlippiLab pull for broader coverage.
2. ~~`inputs_per_minute` placeholder~~ **Resolved.** peppi-py exposes `pre.buttons_physical` for IPM computation. All 9 stats now have real community baselines.
3. **Grade history persistence — proposed, not built.** Add a `set_grades` SQL table keyed by `match_id` storing overall letter/score, per-category scores, per-stat values + scores, `baseline_version`, and `generated_at`. Insert from `watcher.ts` `handleRankedGame` when grading runs; optionally insert from the dev test panel too. Surfaces as a **premium-only** Grade History tab.

---

## Baseline pipeline (`scripts/`)

Three Python scripts build the percentile benchmarks consumed by the in-app grading code.

### `scripts/fetch_slippilab_replays.py`

Pulls 1v1 replays from the SlippiLab public API, parses each one with py-slippi, computes the same stats the in-app TS parser computes, and writes `scripts/grade_baselines.json`.

Output structure:
- `by_player_char[char][stat]` — percentiles for each player character
- `by_opponent_char[char][stat]` — percentiles vs each opponent character
- `by_matchup[playerChar][oppChar][stat]` — matchup-specific percentiles (only entries with ≥20 samples)

```bash
python3 -u scripts/fetch_slippilab_replays.py --limit 5000 --workers 4 --output scripts/grade_baselines.json
```

- `--workers` defaults to 4. `ProcessPoolExecutor` parallelizes download + parse + stat compute.
- Download URL must use `file_name` (UUID.slp), not numeric `id` — `/api/replay/{id}` 404s.
- Action-state helpers (`is_in_control`, `is_vulnerable`, `is_attacking`, `DEFENSIVE_STATES`) are kept identical to `src/lib/slp_parser.ts`.

### `scripts/baseline_generator.py`

Alternative script that reads from the user's local SQLite DB instead of SlippiLab. Useful for generating personal baselines. Outputs same `by_player_char` + `by_matchup` structure as the fetch script.

### `scripts/parse_hf_replays.py` (primary pipeline)

Parses replays from the HuggingFace `erickfm/slippi-public-dataset-v3.7` dataset using **peppi-py** (Rust backend, ~170 parses/sec). Computes all 9 stats including `inputs_per_minute` (from `pre.buttons_physical`), `counter_hit_rate`, and `defensive_option_rate`.

**Key design decisions:**
- **peppi-py** uses external character IDs (CSS order), NOT internal IDs. The CHARACTERS dict in this script maps accordingly (e.g. 20 = Falco, 0 = Captain Falcon).
- **Vectorized stats** via numpy on PyArrow struct-of-arrays (no per-frame Python loop)
- **Batch download+delete** to conserve disk space (~500 files / ~1 GB per batch)
- **Concurrent downloads** via ThreadPoolExecutor (8 threads) — download is I/O-bound
- **Checkpointing** every batch for resume on interruption
- **counter_hit_rate** fix: requires `o_ctrl & o_atk & o_vuln` (counter hits ⊆ neutral wins)

```bash
# Requires Python 3.10+ venv with peppi-py, numpy, huggingface_hub
python3 scripts/parse_hf_replays.py --character FALCO --batch-size 500 --dl-workers 8
```

### `scripts/global_baseline_parser.py`

Streams a hypothetical 140 GB JSON dump of global Slippi match data using `ijson` (constant memory). **Superseded** by `parse_hf_replays.py` for the HuggingFace dataset (which is raw .slp files, not pre-computed JSON). Kept for reference.

### `scripts/regen_benchmarks.py`

Reads `scripts/grade_baselines.json` and emits `src/lib/grade-benchmarks.ts`. Run after every fresh parse. Now handles all 9 stats (no more placeholders) and the `by_matchup` structure.

```bash
python3 scripts/regen_benchmarks.py
```

---

## Cross-machine workflow

Anything that needs to travel between machines must be in git. Per-machine state that does NOT travel:

- Claude's auto-memory (`~/.claude/projects/.../memory/`)
- App data (`~/Library/Application Support/Slippi Ranked Stats/data/{CONNECT_CODE}.db`)
- `scripts/logs/` (gitignored)

When picking up work on a different machine, this file plus `git log --oneline` is the source of truth.
