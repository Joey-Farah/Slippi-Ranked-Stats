# Dev Notes

Working notes for in-progress features. Not part of the user-facing docs.
Update this file as features land or context changes — it's the
hand-off mechanism between work sessions and across machines.

---

## Set Grading System (in progress, dev-only)

Wired end-to-end and gated behind `$isPremium`. Visible to all premium users in production.

### What's built

- **`src/lib/grading.ts`** — `gradeSet(games, playerChar, opponentChar, setResult, wins, losses)` returns a `SetGrade` with overall letter/score, four category grades (Neutral, Punish, Defense, Execution), and per-stat breakdowns. Categories are equally weighted; stats within a category are equally weighted.
- **`src/lib/grade-benchmarks.ts`** — Generated from `scripts/grade_baselines.json`. Three-tier benchmark structure: `by_matchup[playerChar][oppChar]` → `by_player_char[playerChar]` → `by_player_char["_overall"]`. Characters with fewer than 20 samples fall back to the next tier.
- **`src/components/SetGradeDisplay.svelte`** — Renders the overall grade card + category rows. Iterates `CATEGORY_DEFS` from grading.ts so display always matches the grading logic. Shows "matchup baseline" / "overall baseline" annotation when applicable.
- **Watcher integration** (`src/lib/watcher.ts`, `handleRankedGame`) — When a set completes during a live watcher session, calls `gradeSet` against in-memory `liveGameStats` and writes the result to `lastSetGrade`. Shown in Live Session tab for premium users.
- **Set Grades tab** (`src/components/tabs/GradeHistory.svelte`) — "Grade New Sets" button re-parses ungraded completed sets, shows a compact table (Date / Opponent / Result / Score / Grade letter), distribution summary, and expandable `SetGradeDisplay` on click. Filters: grade letter, W/L result, player char (shown when player uses multiple chars), opponent char. Sort: date or score. Grades are persisted to DB and hydrated on mount. Stale grades (old baseline version) show an orange indicator and a "Regrade stale (N)" button.

### How grading works

For each stat in a completed set, `percentileScore(value, thresholds, inverted)` linearly interpolates between bench percentiles to produce a 0–100 score. Letter grade thresholds: S ≥ 95, A ≥ 90, B ≥ 75, C ≥ 50, D ≥ 25, F < 25.

**Algorithm details (as of current session):**
- `INVERTED_STATS`: `openings_per_kill`, `avg_kill_percent`, `wavedash_miss_rate` (lower = better)
- `avg_kill_percent` and `avg_death_percent` are **skipped** when `baselineSource === "overall"` — the `_overall` bucket has identical values for both by symmetric pooling, making scores misleading. Only scored with character-specific data.
- **Win bonus**: +5 added to the composite score for a set win (capped at 100). Winning a set reflects adaptability and reads not captured by raw metrics.
- **Benchmark lookup**: matchup (player × opp) → player char → `_overall`. The display shows which tier was used.
- **Category weights**: Punish 35%, Neutral 35%, Defense 25%, Execution 5%.

**Stats by category (18 total):**
| Category  | Stats                                                                                                 |
|-----------|-------------------------------------------------------------------------------------------------------|
| Neutral   | `neutral_win_ratio`, `opening_conversion_rate`, `stage_control_ratio`, `lead_maintenance_rate`, `comeback_rate` |
| Punish    | `damage_per_opening`, `openings_per_kill`, `avg_kill_percent`, `edgeguard_success_rate`, `tech_chase_rate`, `hit_advantage_rate` |
| Defense   | `avg_death_percent`, `recovery_success_rate`, `avg_stock_duration`, `respawn_defense_rate`             |
| Execution | `l_cancel_ratio`, `inputs_per_minute`, `wavedash_miss_rate`                                           |

**All-character baselines** generated from full HuggingFace dataset (221,603 replays across all 25 characters, 430k samples). All 18 stats have real benchmarks including `wavedash_miss_rate` (state ID bugs fixed and rescan completed 2026-04-17).

### Open issues before shipping

1. ~~Low per-char sample sizes~~ **Resolved.** Full dataset parse covers all 25 characters with 26 having ≥50 samples, 283 matchup entries.
2. ~~`inputs_per_minute` placeholder~~ **Resolved.** All 18 stats have real community baselines.
3. ~~**Full `--character ALL` rescan needed.**~~ **Resolved.** Rescan completed 2026-04-17 (221,603 replays, 430k samples). All parser bug fixes (OPK, L-cancel, IPM, DEFENSIVE_STATES, wavedash state IDs) are reflected in current baselines.
4. **Grade history persistence — built.** `set_grades` table in the per-connect-code SQLite DB. Grades are saved on every successful grade in `GradeHistory.svelte` and from the live watcher (DEV only). On mount, `GradeHistory.svelte` hydrates the store from DB. Stale grades (different `baseline_version`) show an orange ⟳ indicator and a "Regrade stale (N)" button. Design notes at [`docs/set_grades_persistence.md`](./set_grades_persistence.md) are still accurate as reference.

### Stat fixes applied (match slippi-js exactly)

All fixes are committed. Live parser (`slp_parser.ts`) and Python pipeline (`parse_hf_replays.py`) are in sync.

| Stat | Bug | Fix |
|------|-----|-----|
| L-cancel | Counted every frame in aerial state (inflated) | Now counts once per new aerial-action transition (states 65–74), matching slippi-js `isNewAction` guard |
| IPM | Counted button state-changes (`diff != 0`) | Now Hamming weight of rising edges on 12 digital buttons (`(~prev & cur) & 0xfff`), matching `buttonInputCount` |
| IPM (rollback) | Rollback frames caused duplicate pre-frame events, inflating count | `maxPreFrame` guard: skip pre-frame events for already-seen frame numbers |
| NWR | Used `oppConvActive` state flag (approximate) | Now tracks `playerNeutralWins/oppNeutralWins` — neutral-win iff opponent wasn't actively converting when conversion started |
| OPK | Dying state (0–10) is neither stun nor control; conversion lingered through respawn, causing next conversion to be missed | Terminate conversion immediately on stock loss (detects `opp.stocks < prev`), matching slippi-js |
| Conversion data | Rollback post-frame duplicates in `frameData` inflated conversion counts | Deduplicate `frameData` per port by keeping last occurrence of each frame number |
| OCR (first fix) | Used ≥20% damage threshold to define "successful conversion" | Changed to `convHitCount >= 2` (re-entries into hitstun), matching slippi-js `moves.length > 1` |
| OCR (second fix) | Multi-hit moves (Falco dair, shine repeats) appear as continuous hitstun in frame data — re-entry check missed them | Added percent-increase check: if `opp.percent > convLastOppPercent + 0.5` while already in stun, count as new hit |

Accuracy vs slippi-js on 5 test sets: OPK ✓ exact, L-C ✓ exact, IPM ±2, NWR ±2%, D/O ±1 (methodological: we use peak-pct-per-stock; slippi-js uses per-conversion move damage — consistent across benchmark and live parser so grading percentiles are valid).

OCR accuracy after both fixes: **10/12 games exact, avg gap 0.7%, max gap 5.3%** vs slippi-js `successfulConversions.ratio`. Remaining gap is from edge cases where multi-hit timing in frame data doesn't align exactly with slippi-js's `lastAttackLanded` events.

### Pending: OCR benchmark rescan

`opening_conversion_rate` is in `DISPLAY_ONLY_STATS` because current benchmarks were generated with the old ≥20% definition. Both OCR fixes are already applied to all three parsers. To re-enable OCR scoring:

1. Run full rescan: `python3 scripts/parse_hf_replays.py --character ALL --batch-size 500 --dl-workers 8` (~6.5 hours)
2. Run `python3 scripts/regen_benchmarks.py`
3. Remove `"opening_conversion_rate"` from `DISPLAY_ONLY_STATS` in `src/lib/grading.ts`
4. Commit and regrade all sets (stale baseline version will trigger the orange indicator)

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
python3 scripts/parse_hf_replays.py --character ALL --batch-size 500 --dl-workers 8
```

Supports `--character ALL` to loop through all 25 character directories in a single run with shared accumulators. Per-character checkpoints for resume, global checkpoint tracks completed characters. Writes intermediate `grade_baselines.json` after each character completes.

### `scripts/global_baseline_parser.py`

Streams a hypothetical 140 GB JSON dump of global Slippi match data using `ijson` (constant memory). **Superseded** by `parse_hf_replays.py` for the HuggingFace dataset (which is raw .slp files, not pre-computed JSON). Kept for reference.

### `scripts/regen_benchmarks.py`

Reads `scripts/grade_baselines.json` and emits `src/lib/grade-benchmarks.ts`. Run after every fresh parse. Handles all 18 stats and the `by_matchup` structure. Stats with no data (null p50) are skipped and marked optional in the TS interface.

```bash
python3 scripts/regen_benchmarks.py
```

### Ground-truth comparison scripts

Used to audit our parser against `@slippi/slippi-js` (the same library Slippi Launcher uses). Only run on the Windows machine where the replay paths in `SETS` are valid.

- **`scripts/compare_stats.cjs`** / **`scripts/compare_stats.mjs`** — same tool, CommonJS and ESM variants. Parses the hard-coded list of recent sets with `SlippiGame` and prints the stats slippi-js computes (OPK, L-cancel, IPM, NWR, damage-per-opening). Run: `node scripts/compare_stats.cjs`.
- **`scripts/our_stats.cjs`** — self-contained Node port of `src/lib/slp_parser.ts` (UBJSON parser + all 18 stat helpers). Prints every graded stat so we can line them up next to slippi-js output. Run: `node scripts/our_stats.cjs`.

Workflow: edit the `SETS` array in all three files with matching replay paths, run both, diff. Any stat slippi-js also emits must match within the tolerances listed under "Stat fixes applied" above. Stats only in `our_stats.cjs` (stage control, edgeguards, etc.) are custom — sanity-check values manually.

---

## Cross-machine workflow

Anything that needs to travel between machines must be in git. Per-machine state that does NOT travel:

- Claude's auto-memory (`~/.claude/projects/.../memory/`)
- App data (`~/Library/Application Support/Slippi Ranked Stats/data/{CONNECT_CODE}.db`)
- `scripts/logs/` (gitignored)

When picking up work on a different machine, this file plus `git log --oneline` is the source of truth. See also [`docs/session-log.md`](./session-log.md) for chronological session summaries (intent + decisions, not just diffs).

