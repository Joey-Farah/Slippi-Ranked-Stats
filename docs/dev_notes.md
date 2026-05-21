# Dev Notes

Working notes for in-progress features. Not part of the user-facing docs.
Update this file as features land or context changes — it's the
hand-off mechanism between work sessions and across machines.

---

## Unranked & Direct Stats Tab (shipped v1.5.0)

Premium-gated tab at the end of the tab bar. Reads `match_type = 'unranked'` games already stored in the DB — no parser changes needed.

**What's in it:**
- Summary cards: Games Played, Win %, Record
- Win % vs Opponent Character chart (with A-Z/Best/Worst sort + per-character filter chips scoped to that chart)
- Your Characters win % chart
- Opponent Spotlight (Most Played, Best Record, Worst Record — same as Matchup Stats)
- Stage Win % chart
- Opponent History table (searchable)

**Key implementation notes:**
- `getGames()` in `db.ts` now returns all match types (ranked + unranked). `rankedGames` derived store still filters downstream — all ranked tabs unaffected.
- `unrankedGames` derived store added to `store.ts` (same date-range filter as ranked).
- Character filter chips are scoped to the opponent char chart only (not a global page filter).
- `BarChart` horizontal grids now use `containLabel: true` instead of hardcoded `left: 140` — fixes Fountain of Dreams label clipping on all tabs.

**Also shipped in v1.5.0 (from v1.4.12/v1.4.13, rebased in):**
- Premium check now routes through a Cloudflare Worker using a bot token (`workers/discord-check/`) — more reliable than calling Discord directly.
- `verifyPatronRoleWithRetry` with exponential backoff added to `discord.ts`. Transient 5xx/429 errors no longer flip `isPremium` to false.
- macOS auto-updater fix: release workflow now produces `.app.tar.gz` correctly.

---

## Streamer Overlay (idea, not started)

Streamers playing ranked on Twitch want to show live ranked stats in their OBS overlay — e.g. current rating, last set result, win/loss streak, opponent info.

**Most likely approach:** spin up a local HTTP server (via Tauri's `tauri-plugin-localhost` or a small Axum server in the Rust backend) that serves a minimal auto-updating HTML page. Streamers add it as a Browser Source in OBS at `localhost:PORT`. The page polls or uses SSE to reflect the latest watcher state.

**Alternative:** write a JSON/text file to disk after each game that OBS reads with a Text source — simpler but less flexible for custom styling.

**Open questions before building:**
- What data goes on the overlay? (rating, delta, current streak, last set W/L, opponent code/char, stage?)
- Should the layout be fixed or user-customizable (colors, font size)?
- Does it only update during a live watcher session, or show historical stats too?
- Premium feature or free?

**Do not build without discussing the approach first.**

---

## Set Grading System

Wired end-to-end, gated behind `$isPremium`. Visible to all premium users in production.

### What's built

- **`src/lib/grading.ts`** — `gradeSet(games, playerChar, opponentChar, setResult, wins, losses)` returns a `SetGrade` with overall letter/score, three category grades (Neutral, Punish, Defense), and per-stat breakdowns.
- **`src/lib/grade-benchmarks.ts`** — Generated from `scripts/grade_baselines.json`. Three-tier benchmark structure: `by_matchup[playerChar][oppChar]` → `by_player_char[playerChar]` → `by_player_char["_overall"]`. Characters with fewer than 20 samples fall back to the next tier.
- **`src/components/SetGradeDisplay.svelte`** — Renders the overall grade card + category rows. Shows "matchup baseline" / "overall baseline" annotation when applicable.
- **Watcher integration** (`src/lib/watcher.ts`, `handleRankedGame`) — When a set completes during a live watcher session, calls `gradeSet` and writes the result to `lastSetGrade`. Shown in Live Session tab for premium users.
- **Grading tab** (`src/components/tabs/GradeHistory.svelte`) — "Grade New Sets" button re-parses ungraded completed sets. Filters: grade letter, W/L result, player char, opponent char. Sort: date or score. Grades persisted to DB, hydrated on mount without eager clear (no tab-switch flash). Stale grades show an orange ⟳ indicator and a "Regrade stale (N)" button.

### How grading works

For each stat, `percentileScore(value, thresholds, inverted)` linearly interpolates between bench percentiles to produce a 0–100 score. Letter grade thresholds: S ≥ 75, A ≥ 63, B ≥ 52, C ≥ 40, D ≥ 28, F < 28.

**Algorithm details:**
- `INVERTED_STATS`: `openings_per_kill`, `avg_kill_percent`, `wavedash_miss_rate` (lower = better)
- `avg_kill_percent` and `avg_death_percent` skipped when `baselineSource === "overall"` (symmetric pooling makes scores misleading)
- **Win bonus**: +5 to composite score for a set win (capped at 100)
- **Benchmark lookup**: matchup (player × opp) → player char → `_overall`
- **Category weights**: Neutral 40%, Punish 40%, Defense 20% (execution stats are display-only, not scored — no category weight)
- **Per-stat weights (Neutral)**: NWR 30%, OCR 30%, Stage Control 15%, Lead Maintenance 15%, Comeback 10%
- **Per-stat weights (Punish)**: D/O 30%, OPK 30%, Edgeguard 15%, Kill% 15%, Tech Chase 5%, Hit Advantage 5%
- **Per-stat weights (Defense)**: Recovery 35%, Death% 30%, Stock Duration 20%, Respawn Defense 15%

**Stats by category (18 total):**
| Category  | Stats |
|-----------|-------|
| Neutral   | `neutral_win_ratio`, `opening_conversion_rate`, `stage_control_ratio`, `lead_maintenance_rate`, `comeback_rate` |
| Punish    | `damage_per_opening`, `openings_per_kill`, `avg_kill_percent`, `edgeguard_success_rate`, `tech_chase_rate`, `hit_advantage_rate` |
| Defense   | `avg_death_percent`, `recovery_success_rate`, `avg_stock_duration`, `respawn_defense_rate` |
| Execution | `l_cancel_ratio`, `inputs_per_minute`, `wavedash_miss_rate` (display-only) |

**Baselines (as of 2026-05-21):** Full HuggingFace rescan completed — 128,851 replays, 250,048 samples, 26 characters, 127 matchup entries (≥50 samples). Includes all stat fixes: OCR phantom guard, respawn_defense_rate window, avg_stock_duration last-stock, tech_chase_rate threshold unification, lead/comeback stock-only definition. Authenticated via HF token (no rate limiting).

~~**Baselines (as of 2026-04-18):** Full HuggingFace rescan completed — 177,538 replays, 345,012 samples, 26 characters, 183 matchup entries. Uses `lastHitBy` kill attribution and both OCR fixes. Validated against slippi-js on 256 games: OPK/Kill%/L-cancel 99%+ exact, D/O 96% ≤1 dmg, NWR 88% ≤3pp, OCR 81% ≤3pp.~~

### Premium gating

- Ko-fi (`ko-fi.com/joeydonuts`) and Patreon (`patreon.com/joeydonuts`) both supported, Patreon listed first everywhere
- Discord role verified via OAuth (`src/lib/discord.ts`)
- Sidebar, PremiumGate, GradeHistory, LiveRankedSession all updated with consistent Ko-fi + Patreon buttons and Discord help links

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
| OCR (phantom conversion) | Kill frame terminates active conversion, then `oppInStun` fires on the same frame (prevOppStocks not yet updated) opening a phantom conversion | Added `oppStockLostThisFrame` guard — block opening new conversion when opponent stock drops this frame |
| `respawn_defense_rate` | RESPAWN_WINDOW started at the death animation frame (~150 frames before respawn). Opponent had no agency during death, so the window expired before they could act — nearly always scored as "safe" (showed ~100%). Second bug (introduced same session): fix used states {10,11} (slippi-js doc IDs for Rebirth/RebirthWait) but those states **never appear** in peppi-py post-frame data — stat silently returned null for every game. | Window now starts when opponent exits **state 12 (Entry/spawn platform)** and transitions to state > 12 (actionable). Real respawn sequence in .slp files: state 0 (DeadDown) → state 12 (invincible platform) → control. Both `slp_parser.ts` and `parse_hf_replays.py` updated to `SPAWN_STATES = {0, 12}`. |
| `avg_stock_duration` | Last stock never added to durations list (loop exits after last death). Also Python used attribution-filtered `death_frames` (missed self-destructs), causing "never died" games to inflate p50 to ~111 seconds | TS: append `playerFrames.at(-1).frame - stockStart` after loop. Python: use `raw_death_frames` (unfiltered) and include last surviving stock. "Never died" games still excluded from the benchmark to prevent inflation. |
| `tech_chase_rate` (Python only) | Damage threshold was 2.0% vs TS 3.0%. Also had an early-exit on opponent regaining control before the hit, causing systematic undercount in benchmark data | Threshold unified to 3.0%. Control early-exit removed. |
| `lead_maintenance_rate` / `comeback_rate` (Python only) | Python defined "player ahead/behind" using same-stock percent differential (+15% threshold) that the TS parser doesn't have — broader definition caused benchmark mismatch | Removed percent-differential condition from Python. Both scripts now use stock count only for lead/behind. |

**Comeback rate null handling (2026-05-21):** `comeback_rate === null` (player was never behind in stocks) is now **excluded from scoring** — no bonus, no penalty. The UI shows *"never behind in stocks"* in italics. Previously null scored as 100 (perfect), which incorrectly rewarded dominant players with comeback credit they didn't demonstrate. The `NULL_CONTEXT` note for both `comeback_rate` and `lead_maintenance_rate` was already in `SetGradeDisplay.svelte`.

~~**Benchmarks status:** Rescan with all fixes above is **pending** — `peppi-py` and `huggingface_hub` need to be installed first.~~

~~**Pending: full benchmark rescan**~~ **Resolved 2026-04-18.** Rescan completed with `lastHitBy` kill attribution and both OCR fixes reflected in benchmarks.

~~**Rescan required for 2026-05-20 fixes**~~ **Resolved 2026-05-21.** Rescan completed with all fixes above (128,851 replays, 250,048 samples). Run command was:
```bash
HF_TOKEN="..." .venv/Scripts/python.exe -u scripts/parse_hf_replays.py --character ALL --batch-size 500 --dl-workers 8
.venv/Scripts/python.exe scripts/regen_benchmarks.py
```

**⚠ respawn_defense_rate baselines still missing (2026-05-21):** The 2026-05-21 rescan ran with the wrong state IDs ({10,11}) before the root cause was identified — all `respawn_defense_rate` entries in `grade_baselines.json` have `sample_size: 0`. The TS parser (`slp_parser.ts`) is fixed and computes correct values for users, but the grading bar cannot fill until baselines are populated. Run the targeted rescan to fix this:
```bash
HF_TOKEN="..." .venv/Scripts/python.exe -u scripts/rescan_respawn_only.py
.venv/Scripts/python.exe scripts/regen_benchmarks.py
```
`rescan_respawn_only.py` downloads all ~129k replays, computes only `respawn_defense_rate`, and patches just that stat into `grade_baselines.json` without touching any other baselines. Supports resume via `scripts/parse_hf_respawn_checkpoint.json`. Expected runtime: similar to the full scan (~3 hrs) since downloads dominate. HF cache was cleared by the prior scan, so files must be re-downloaded.

### Stat descriptions and in-app methodology panel

Added `STAT_DESCRIPTIONS` export to `grading.ts` — precise one-sentence descriptions of exactly what each stat measures (window sizes, thresholds, conditions). These appear as `(i)` tooltips next to each stat label in `SetGradeDisplay.svelte`.

Added `GradingMethodology.svelte` — expandable in-app panel in the Grading tab (toggled by "How Grading Works" button). Shows:
- How percentile scoring works + benchmark source
- Grade letter thresholds (S≥75, A≥63, B≥52, C≥40, D≥28, F<28)
- Per-category breakdown: each stat's weight within the category and its precise description
- Execution stats explanation (why they're display-only)

`STAT_WEIGHTS` and `CATEGORY_WEIGHTS` are now exported from `grading.ts` so the methodology component can import them directly instead of duplicating values.

### Onboarding screen

Added `OnboardingView.svelte` — shown when `$games.length === 0` (no replays scanned yet). Replaces the empty tab content with:
- 3-step setup checklist (connect code → replay folder → scan), each step shows green checkmark when done
- Feature highlight cards: Live Session, Set Grades (Premium), Matchup Stats, All-Time Stats

Wired into `App.svelte`: `{#if $games.length === 0}` check placed before the tab content switch — the tab bar remains visible so users can navigate once data loads.

---

## Premium verification (Discord role check)

As of v1.4.12, the role check no longer hits Discord's user-context endpoint
directly — it goes through a Cloudflare Worker that uses the bot token.

### Why we moved off the user endpoint

`/users/@me/guilds/{guild.id}/member` (user OAuth context) returned widespread
500s on 2026-05-08 — Cloudflare confirmed the request reached Discord's origin
(`cf-ray` + `cf-cache-status: BYPASS`), Discord's backend returned HTML error
pages instead of JSON. Curl from a clean shell reproduced it identically. The
endpoint has been historically flaky and isn't part of any major Discord
incident reports — it just quietly breaks.

The bot-context endpoint `/guilds/{id}/members/{user_id}` is a different code
path on Discord's side (heavily exercised by every Discord bot in existence)
and is much more reliable.

### Current architecture

- **App** (`src/lib/discord.ts`): OAuth flow unchanged (PKCE, scope
  `identify guilds.members.read`, redirect to `localhost:14523`). The role
  check `verifyPatronRole` POSTs the user's OAuth token to the worker and
  translates the `{premium, reason, username}` response into a `VerifyResult`.
- **Worker** (`workers/discord-check/index.js`): receives `{token}`, verifies
  it against `/users/@me` to extract the user_id, then bot-context lookups
  `/guilds/{GUILD_ID}/members/{user_id}` with the bot token. Returns the
  premium decision. `GUILD_ID` and `PREMIUM_ROLE_IDS` live here, not in the
  client.
- **Resilience layer** (`verifyPatronRoleWithRetry`): app-mount verify uses
  exponential backoff (8 attempts, ~86s total) on transient errors so a
  downgraded patron auto-recovers when Discord returns 200 again. The
  `verifyPatronRole` call itself only flips `isPremium=false` on definitive
  responses — never on 5xx/429/network errors.

### Operational requirements

- The SRS bot user (`Slippi Ranked Stats`, app ID `1489690383171719188`) must
  remain in the SRS Discord guild (`703857185570029628`) with **Server Members
  Intent** enabled in the Discord Developer Portal → Bot tab → Privileged
  Gateway Intents.
- The bot token is stored as a Cloudflare Worker secret named
  `DISCORD_BOT_TOKEN`. Never commit it. Set/rotate via
  `wrangler secret put DISCORD_BOT_TOKEN` from `workers/discord-check/`.
- Worker URL: `https://srs-discord-check.joeyfarah.workers.dev/check-premium`.
  If you redeploy under a different account/subdomain, update
  `PREMIUM_CHECK_URL` in `src/lib/discord.ts`.

### Deploying changes to the worker

```bash
cd workers/discord-check
npx wrangler deploy
```

No build step — single `index.js`. Logs visible in Cloudflare dashboard or
`npx wrangler tail`.

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

**Pipeline reliability notes (2026-05-21):**
- **ThreadPoolExecutor shutdown hang (fixed):** Old code used `with ThreadPoolExecutor(...) as dl_pool` which calls `shutdown(wait=True)` on `__exit__`. When `as_completed` timed out with threads stuck in HuggingFace 429 retry loops (up to 744s/retry), the `with` block silently blocked for hours. Fix: manage executor manually with `dl_pool.shutdown(wait=False, cancel_futures=True)` in a `finally` block.
- **HF token required:** Without an authenticated token, HuggingFace rate-limits downloads (HTTP 429). Always run with `HF_TOKEN="hf_..."` env var set. Store permanently with `huggingface-cli login` to avoid needing to pass it each run.
- **Always use `.venv/Scripts/python.exe`**, not system `py -3`. The `.venv` at the project root has all required packages (peppi-py, huggingface_hub, numpy) pre-installed.

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

