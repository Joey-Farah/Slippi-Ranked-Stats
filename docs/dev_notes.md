# Dev Notes

Working notes for in-progress features. Not part of the user-facing docs.
Update this file as features land or context changes — it's the
hand-off mechanism between work sessions and across machines.

---

## ⚠ SESSION HANDOFF — 2026-05-23 (READ FIRST)

> **✅ RESOLVED & SHIPPED in v1.6.1 (2026-05-23).** The "regrade shows no change"
> symptom was a measurement artifact, not a bug: the installed production app and the
> `npm run tauri dev` build share one SQLite DB (`com.slippi.rankedstats`), so a regrade
> in one overwrote the rows the other read — they could never show different grades at
> once. The 8 s recalibration was verified correct via (1) an offline play-by-play audit
> where the 8 s edgeguard count matches the actual replay kills, and (2) a 120-game
> 3 s-vs-8 s sweep (edgeguard rose in 76/120, always upward, avg +8.3 pts; denominator
> unchanged). Also note: installed **v1.6.0 predates the recovery/edgeguard *redefinition***
> (commits `dfc4ba1`/`1a0df4f`), so a prod-vs-dev comparison conflates definition + window
> + baselines — that's why edgeguard appeared to drop in side-by-side screenshots.
> **v1.6.1 shipped:** 8 s recalibration + rebuilt baselines, S-tier hot-pink palette,
> Slippi profile link in the sidebar, execution-stats section removed from "How Grading
> Works". The **stream overlay prototype was removed** from the release (idea still banked
> below). The dev-only `db.ts` `data_dev` split was reverted. Everything below is historical.

Big multi-thread session. Everything below is historical context from the build-up to
v1.6.1.

### 🔴 OPEN BUG (where we stopped) — regrade shows no change
After the 8 s recalibration, regrading sets in the **dev build still produces the
same recovery/edgeguard %s AND grades as the 3 s production build.** The
version-bump fix below was *necessary but did NOT fix this symptom.* Investigate next:
- **Stale filter excludes nulls.** `GradeHistory.svelte` (~line 124 `staleCount`,
  ~line 366 `regradeStale`) filters `r.baselineVersion !== null && r.baselineVersion
  !== BENCHMARKS_VERSION`. If stored grades have `baseline_version = null`, they're
  **never flagged stale** → "Regrade stale" skips them. **Check what
  `baseline_version` existing grade rows actually have in the DB.**
- **Confirm the regrade re-parses with the 8 s window.** Path: `parseSlpFile`
  (parser.ts) → `parseSlpBytes` (slp_parser.ts:904/1037) → `computeAdvancedStats`
  (slp_parser.ts:975/1097) where `EG_WINDOW = 480` (line 413). Call chain verified to
  *exist*, but the values aren't moving — so either the parse isn't re-running, it's
  cached, or recovery/edgeguard don't actually vary with EG_WINDOW as assumed.
- **Decisive test:** parse ONE .slp with a known >3 s offstage gimp using the 8 s vs
  3 s `slp_parser` and confirm recovery/edgeguard differ *at all*. If identical, the
  parser edit isn't reaching the running build (wrong path / stale bundle).
- Check whether `gradeAllSets`/regrade re-parses the `.slp` or re-scores stored stats.

### What got done (uncommitted unless noted)
1. **Recovery/edgeguard 8 s recalibration.** Measured (HF sample, throwaway script)
   that the old **3 s** offstage-trip timeout missed **~39 % of real edgeguard kills**.
   Changed `EG_WINDOW` 180→**480** (8 s) in `slp_parser.ts:413`, `parse_hf_replays.py`
   (`fo + 480` ×4), `rescan_recovery_edgeguard_only.py:70`. Full HF rescan done
   (**221,603 files, 429,344 samples, ~3.9 hr** on the Windows wired box via
   `run_recov_eg_supervised.py`). Verified ONLY recovery/edgeguard changed:
   _overall recovery **0.850→0.884**, edgeguard **0.068→0.108**.
2. **BENCHMARKS_VERSION bug — fixed in data+script (but didn't fix the regrade
   symptom, see above).** Targeted rescans never bumped grade_baselines.json's
   **top-level `generated_at`**, which `regen_benchmarks.py:183` turns into
   `BENCHMARKS_VERSION`. Bumped it → `2026-05-23T17:50:41`, regenerated; patched
   `rescan_recovery_edgeguard_only.py` `patch_baselines` to bump it going forward.
   (The 5-22 respawn rescan had the same latent issue.)
3. **Grade colors → pink palette, centralized.** Added `GRADE_COLORS` + `gradeColor()`
   to `grading.ts` (single source). New default: **S `#FF1493` (hot pink + glow)**,
   A `#00C853`, B `#00B0FF`, **C `#FFC400`**, **D `#FF7300`**, F `#FF1744`. All 4 grade
   UIs now import it (was 4 duplicated maps; LiveRankedSession's separate flat palette
   unified). **User approved as the release default** ("test it this release").
4. **UI fixes:** removed the "Execution Stats (display only)" block from
   `GradingMethodology` ("How Grading Works"); added **"Go to your Slippi profile ↗"**
   button in `Sidebar` under the rating → `slippi.gg/user/<connectCode lowercased,
   # → ->` (e.g. `JOEY#870` → `joey-870`).
5. **Stream Overlay PROTOTYPE — UI ONLY, NO BACKEND** (`LiveRankedSession.svelte` +
   `store.ts` `overlayEnabled`/`overlayExpanded` persisted). Single-toggle UX,
   collapsible when on (Hide/Setup chevron), ranked-set-only framing, in-app grade
   preview. **URL is a STUB** (`http://localhost:6789/overlay`). **Transport decision
   PENDING — do NOT build backend without confirming:** `tiny_http` + polling
   (recommended; small dep, what `tauri-plugin-localhost` uses) vs OBS **Text source**
   (zero-dep, plain text, loses styling). Also banked in the "Streamer Overlay" section.

### Commits (both UNPUSHED on `main`)
- `eff9bfa` — the **3 s** baselines. **SUPERSEDED** by the working-tree 8 s data;
  restructure (amend/soft-reset) so history carries 8 s, not 3 s-then-8 s. Also
  contains `run_recov_eg_supervised.py` (the Windows rescan supervisor).
- `0723475` — overlay idea doc.

### Release plan — user chose "HOLD, review first"
- Pending: **overlay in or out of this release** (recommend OUT/WIP — dead URL would
  confuse users; preserve on a branch).
- Restructure `eff9bfa` → 8 s recalibration commit.
- Ship: 8 s baselines + pink colors + execution-removal + Slippi link.
- Version bump + `release-notes.md` entry at release-cut time (per the release process).

### Operational notes
- **Bounce the dev app:** TaskStop the tauri-dev bg task → PowerShell `Stop-Process
  -Name slippi-ranked-stats -Force` + free port 1420 (`Get-NetTCPConnection
  -LocalPort 1420 | Stop-Process`) → relaunch `npm run tauri dev` (background, sandbox
  disabled) → watcher greps the log for `Finished`/errors. **Current dev task:
  `bd1eo2pns`.** Closing the app window exits the dev process cleanly (exit 0).
- **HMR staleness:** Svelte HMR doesn't recompute inline-style strings keyed on a
  stable value (grade colors keyed on `grade.letter`) and may skip changed module
  constants → needs a **full reload**. Force one by editing `index.html` (Vite
  full-reloads on it, no Rust rebuild). **Remove the temp comment before commit.**
- **HF_TOKEN** was still valid through all scans; user intends to rotate now (fine).
- Throwaway scripts (`_watch_recoveg.py`, `_analyze_eg_window.py`, `_smoke_recoveg.py`)
  were deleted — recreate the HF-sample analyzer if you need to re-measure window tails.

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

### Set-grade overlay widget (idea — banked 2026-05-23)

Show the set grade the moment it lands: when a ranked set completes mid-stream,
pop the just-earned grade onto the OBS overlay — overall letter + score, the three
category grades (Neutral / Punish / Defense), opponent char, and W/L — as a
transient card that animates in and auto-hides after ~15–20 s.

- **The data already exists.** The watcher computes `lastSetGrade` on set
  completion (`src/lib/watcher.ts` `handleRankedGame` → `gradeSet`) and the Live
  Session tab renders it. The overlay just surfaces that same store — no new stat
  or grading work, so this is a display/transport feature.
- **Transport: same infra as the live-stats overlay above.** Event-driven
  (SSE/WebSocket) so the card appears exactly when the grade lands — the local
  server pushes `lastSetGrade` to an OBS Browser Source. Disk-file fallback for a
  plain Text source.
- **It's one widget in a broader overlay system.** Build the local-server +
  Browser-Source plumbing once; the grade card and the live-stats panel
  (rating/streak/opponent) are widgets on top of it. Design them together.
- **Premium-gated** — grades are a premium feature, so tie to `$isPremium` /
  the Discord role check.
- **New open questions:**
  - Show after *every* set, or only at/above a chosen grade? (A streamer may not
    want a D broadcast.) Make it opt-in / threshold-configurable.
  - Transient per-set card vs. an always-on session summary (record + avg grade)
    vs. both?
  - Auto-hide duration + reveal animation; streamer-configurable position / size /
    theme.
  - Hide opponent identity (code/name) by default to avoid putting it on stream?
  - In-app "Streaming / Overlay" settings panel that generates the OBS URL +
    options.

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
- **Per-stat weights (Punish)**: D/O 30%, OPK 35%, Edgeguard 15%, Kill% 15%, Tech Chase 5% (hit_advantage_rate cut 2026-05-22 — see TODO below)
- **Per-stat weights (Defense)**: Recovery 35%, Death% 30%, Stock Duration 20%, Respawn Defense 15%

**Stats by category (17 scored/displayed):**
| Category  | Stats |
|-----------|-------|
| Neutral   | `neutral_win_ratio`, `opening_conversion_rate`, `stage_control_ratio`, `lead_maintenance_rate`, `comeback_rate` |
| Punish    | `damage_per_opening`, `openings_per_kill`, `avg_kill_percent`, `edgeguard_success_rate`, `tech_chase_rate` |
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

~~**⚠ respawn_defense_rate baselines still missing (2026-05-21)**~~ **Resolved 2026-05-22.** Targeted rescan completed on the **macOS machine**: **197/197 entries populated** (was all `sample_size: 0`), 418,846 samples over 221,943 replays, ~7.9 hrs. Used corrected `SPAWN_STATES = {0, 12}` (matches `slp_parser.ts`). `grade_baselines.json` + `grade-benchmarks.ts` regenerated. Run command (note `.venv/bin/python` on macOS, **not** the Windows `.venv/Scripts/python.exe`):
```bash
HF_TOKEN="..." caffeinate -i bash scripts/run_respawn_supervised.sh
```
The supervisor wraps `rescan_respawn_only.py` (patches only `respawn_defense_rate`, resumable via `scripts/parse_hf_respawn_checkpoint.json`) and auto-runs `regen_benchmarks.py` + a verify step on completion.

**Operational notes from this run (read before the next big rescan):**
- **peppi-py 0.8.x renamed `post.damage` → `post.percent`.** `rescan_respawn_only.py` handles both; the Windows venv's older peppi-py still exposes `.damage`.
- **The Xet backend wedges:** individual download threads hang indefinitely (the per-batch `as_completed(timeout=300)` does not reliably fire), freezing a batch with no error. `run_respawn_supervised.sh` detects log silence > 300 s, kills, and resumes from the checkpoint — lossless. Disabling Xet (`HF_HUB_DISABLE_XET=1` + `HF_HUB_DOWNLOAD_TIMEOUT=30`) is reliable but ~5× slower.
- **Download is bandwidth-bound**, not parse-bound. Throughput plateaus ~75 Mbps on this connection; `DL_WORKERS` raised 8 → 32 (sweet spot; 64 barely helps). A faster connection is the only real speed lever.

### Recovery & edgeguard redefinition (2026-05-22) — ✅ RESCAN COMPLETE (2026-05-23)

**Plain English:** Recovery % and Edgeguard % were measuring the wrong things, so
they were rewritten to be two views of the same event — *did the player who got
knocked off the stage make it back, or not.* If you got knocked offstage and made
it back (landed on stage or grabbed the ledge), that's a **successful recovery**
for you and a **dropped edgeguard** for your opponent. If you didn't make it back
(you died offstage), that's a **failed recovery** for you and a **successful
edgeguard** for your opponent. The one exception: getting hit on-stage and flying
*straight to the blast zone* doesn't count for either — there was no recovery to
attempt and no edgeguard to perform.

**Status: DONE.** Code shipped 2026-05-22; the benchmark rescan completed
2026-05-23 on the Windows wired-Ethernet machine (Xet on, supervised) —
**221,577 files, 429,292 samples each stat, 252 min (~4.2 hr)**, 197/197
matchup/char entries populated for both stats. `grade_baselines.json` patched
(only these two stats touched; the other 15 baselines unchanged) and
`grade-benchmarks.ts` regenerated. Sanity at scale: recovery avg 0.850 / p50
0.867, edgeguard avg 0.068 / p50 0.056 — matches the local pre-run estimates.

**Why we had to change them (the bugs):**
- **Recovery** used to require getting back *above* the stage (`y > 5`). But
  standing on stage is `y ≈ 0`, so a sweetspot ledge grab / low getup never got
  there → it timed out and scored as a **failure**. It rewarded recovering *high*
  and punished the safest recoveries.
- **Edgeguard** used to count *any* opponent death within 3 s of going offstage —
  including their SDs and on-stage kills that flew off the side — and the Python
  benchmark even credited deaths after a full recovery. It wasn't measuring
  edgeguarding.

**The final definitions (live `slp_parser.ts` + benchmark `parse_hf_replays.py`
are byte-for-byte in sync):**

A single **offstage trip** is scored from both sides:
- **Offstage** = `|x|` past the stage's ledge **OR** `y < -5`. (New: horizontal —
  you don't have to be below the ledge, just off the side. Needs the per-stage
  ledge-X table below.)
- **Made it back** = you return over the stage (no longer offstage) **or** reach a
  ledge state (CliffCatch family 252–263). → recovery success / edgeguard dropped.
- **Died offstage** → recovery failure / edgeguard success.
- **Blast kill (excluded from both)** = death from one continuous knockback
  (states 75–91) that *began on-stage* — the launching hit carried them to the
  blast zone. Tracked forward in the live parser (`*Ko*` vars), traced backward in
  Python (`_blast_kill`). ~23 % of offstage deaths in local replays.
- 3 s timeout closes the trip without a success.

Recovery and edgeguard are now exact mirrors (one's success = the other's
failure), so they share the offstage detection, the "made it back" check, and the
blast-kill exclusion. The old `RETURN_Y = 5` and the short-lived hit-based
edgeguard are both gone.

**Data-driven choices (measured from ~700 local replays, scripts in `/tmp` were
throwaway):**
- **Ledge-X per stage** measured from the ledge-grab (CliffCatch) position:
  FoD 67.4, PStadium 91.8, YStory 60.1, DreamLand 81.3, Battlefield 72.5, FD 89.6
  (`STAGE_LEDGE_X`, keyed by Slippi stage id; others fall back to 90).
- **Blast-kill rule** ("knockback began on-stage") cleanly separates launch-kills
  (trip p50 ≈ 50 frames) from real failed recoveries (p50 ≈ 150 frames).
- **"Made it back over the stage"** (not just landing) was needed because the new
  horizontal trigger otherwise left ~12 % of trips timing out (knocked off the
  side, drifted back over the stage, never cleanly landed within 3 s). With it,
  timeouts drop to ~6 %.
- Sanity check on local replays: recovery mean ≈ 0.86 (p50 0.88), edgeguard mean
  ≈ 0.07 (p50 0.06). Edgeguard is low because the denominator is *every* offstage
  trip and most are recovered — that's expected and matches the chosen definition.

**Files changed:** `src/lib/slp_parser.ts` (live parser, `stageId` now threaded into
`computeAdvancedStats`), `scripts/parse_hf_replays.py` (benchmark parser),
`scripts/rescan_recovery_edgeguard_only.py` (targeted rescan — kept in exact parity,
verified on local replays), `scripts/our_stats.cjs` (audit port; **its respawn logic
is still stale**, predates the `SPAWN_STATES={0,12}` fix), `src/lib/grading.ts`
(`STAT_DESCRIPTIONS`). Typecheck clean, 14/14 tests pass (grading.test.ts), all parsers parity-checked.

**The rescan — done 2026-05-23 on the Windows wired-Ethernet machine.** The
targeted script patches **only** these two stats in `grade_baselines.json`,
leaving the other 15 untouched (batched download+delete, resumable checkpoint).
It was run under a supervisor — `scripts/run_recov_eg_supervised.py`, the
cross-platform port of the macOS-only `run_respawn_supervised.sh` — which keeps
Xet on, auto-restarts from the per-batch checkpoint if the log goes silent >300 s,
and runs `regen_benchmarks.py` + a verify on clean completion:

```bash
# Windows (what was used — supervised, Xet on, finished in ~4.2 hr, no wedges):
set HF_TOKEN=hf_... && .venv\Scripts\python.exe scripts\run_recov_eg_supervised.py
# macOS equivalent (run the targeted script directly under caffeinate):
HF_TOKEN="hf_..." caffeinate -i .venv/bin/python scripts/rescan_recovery_edgeguard_only.py
python scripts/regen_benchmarks.py   # supervisor does this automatically at the end
```

Resumable via `scripts/parse_hf_recov_eg_checkpoint.json` (auto-removed on success).
peppi 0.8.6 prints `arrow2 OutOfSpec` / `de.rs` panics for a few unparseable replays
per character — caught (`except BaseException`) and skipped; ~98% of games yielded
data (1.94 samples/file). This final script reads only `position`/`state`/`stocks`,
so the peppi `.percent`/`.damage` rename doesn't apply here. If a future run does
wedge, the supervisor handles it; disabling Xet (`HF_HUB_DISABLE_XET=1`
`HF_HUB_DOWNLOAD_TIMEOUT=30`) is the reliable-but-~5×-slower fallback.

**Still worth doing:** the rescan is download-bound (~8 h regardless of stat count).
If we keep iterating on stat definitions, cache the dataset (or a representative
subset) on local disk so re-parsing any stat is ~15 min instead of ~8 h — it's
download+delete today only to save disk (~128k replays ≈ 150–200 GB).

### TODO: revisit `hit_advantage_rate` (cut from scoring 2026-05-22)

Removed from the **grade scoring + UI** because it overlapped `opening_conversion_rate`:
both reward landing follow-ups after the opponent becomes vulnerable, and OCR does it
more rigorously (requires the follow-up to actually land; guards against double-counting
mid-combo). Hit advantage only checked whether the player *entered an attacking state*
within 0.5 s of any vulnerability onset (incl. grabs, knockdowns, techs, and the dying
state), so it was the noisier proxy. Its 5% Punish weight was given entirely to
openings_per_kill (now 0.35).

**Still computed** by both parsers (`slp_parser.ts`, `parse_hf_replays.py`) and still
present in `grade_baselines.json` / `grade-benchmarks.ts` — only `grading.ts` + the
methodology UI changed, so no rescan was needed. To revisit next session:

- **Keep as-is:** re-add to the `breakdown` interface, `STAT_WEIGHTS`,
  `CATEGORY_DEFS.punish`, `STAT_DESCRIPTIONS`, `STAT_LABELS`, and the `formatStatValue`
  percent set in `grading.ts` (plus the local label map in `GradingMethodology.svelte`),
  then re-balance the Punish weights.
- **Redefine** (e.g. true frame/tempo advantage, follow-up *accuracy*, or surfacing the
  dormant `counter_hit_rate` field that's already computed in the Python pipeline but
  null/unused in the live grade): change the computation in both parsers and **run a full
  baseline rescan** before shipping.

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

## Release pages (GitHub)

The release workflow (`.github/workflows/release.yml`) publishes **only the latest version's `release-notes.md` section** as the GitHub release body (written to `release-body.md`), not the entire changelog — so the download assets aren't buried under the history. It also prepends a standing "already installed? no need to reinstall — just reopen the app for the update prompt" banner.

**Keep this layout for every release.** `latest.json` (the in-app updater notes) is unaffected — it already shows only the version-specific notes. The full changelog history stays in `release-notes.md` in the repo.

---

## Cross-machine workflow

Anything that needs to travel between machines must be in git. Per-machine state that does NOT travel:

- Claude's auto-memory (`~/.claude/projects/.../memory/`)
- App data (`~/Library/Application Support/Slippi Ranked Stats/data/{CONNECT_CODE}.db`)
- `scripts/logs/` (gitignored)

When picking up work on a different machine, this file plus `git log --oneline` is the source of truth. See also [`docs/session-log.md`](./session-log.md) for chronological session summaries (intent + decisions, not just diffs).

