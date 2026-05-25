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

This file is the cross-machine handoff doc. The banner above records the last shipped
state; everything below is durable reference — active backlog (see NEXT UP),
shipped-feature architecture, the baseline pipeline, the release process, and the
cross-machine workflow.

---

## ⏳ ACTIVE (2026-05-24) — Comeback Rate & Lead Maintenance redesign (design in progress)

> **⏸ Paused 2026-05-24 — the grill machine (this macOS box) died after Q3 of ~7.** The session
> was recovered from the local Claude Code transcript. The `5e169bd` checkpoint was committed
> *before* the Q3 outcome was written down, so the **Q3 decision below was re-extracted from the
> transcript and folded into LOCKED in this follow-up commit.** **Resume at the ▶ NEXT open
> question:** the size of the Set Comeback bonus and how it stacks with the existing +5 win bonus.

**Why:** Both stats are binary per game (were-behind→won=1/lost=0; were-ahead→won=1/lost=0)
and percentile-scored against a degenerate binary population. Result: a real set (Falco vs
Jigglypuff, L 0–2) graded **0% comeback as S (75)** while **0% lead maintenance scored F (25)**
— identical raw values, opposite grades, because the matchup populations lean opposite ways
(comeback p75=0.0, lead p50=1.0). The grade contradicts the number printed next to it.

**Approach:** redefine both as a CONTINUOUS "degree" measured from stock margin, scored on an
ABSOLUTE curve (no benchmark/rescan). See `docs/adr/0001-absolute-scoring-for-comeback-lead.md`
and the new root `CONTEXT.md` glossary (Set, Stock margin, Comeback, Lead Maintenance).

**LOCKED so far:**
- Comeback stays a graded stat on the 0–100 spectrum (not a separate additive modifier);
  its value becomes continuous.
- Per-game comeback credit = **stocks of margin climbed back from your worst point**
  (depth-weighted, so down-2→even beats down-1→even), with **winning the game as a
  multiplier** on top. (Does not distinguish down-3→down-1 from down-2→even — both "climbed
  2"; accepted as a rare tie.)
- **Lead Maintenance = the mirror** (recovery/edgeguard precedent): degree of margin *held*
  from your best point; closing out in a win multiplies; blowing a lead scores low.
- **Absolute curve, not percentile** → no HF rescan, no `parse_hf_replays.py` changes;
  comeback/lead drop out of `grade-benchmarks.ts`. (ADR 0001.)
- **Stock-only**; percent never factors in.
- Set format confirmed **best-of-3, first-to-2** (`watcher.ts:267`) — so the only set-comeback
  path is lose-G1 → win 2–1.
- **Set-level comeback/lead = a separate composite modifier, NOT folded into the per-game stat
  row** (Q3, agreed 2026-05-24). Bo3 is first-to-2, so the set level has *no degree* — it's
  **binary**: you either came back from a game down (lost G1, won 2–1) or you didn't. Concretely:
  - **Comeback stat** stays the per-game continuous degree (in Neutral, gets a letter), averaged
    across the set's games — exactly as above.
  - **Set Comeback** is a fixed composite-level bump (like the existing +5 win bonus), applied
    when you win 2–1 after dropping game 1 — not crammed into the per-game row.
  - **Mirror for lead:** closing out a 1–0 lead → small closeout credit; **blowing** a 1–0 lead
    (losing 1–2) → a composite penalty. Symmetric to set-comeback.

**STILL OPEN (grill paused at Q3 of ~7 — resume at the ▶ NEXT item):**
- ▶ **NEXT:** the **size of the Set Comeback / closeout bonus** and how it **stacks with the
  existing +5 win bonus** (avoid over-counting "you won").
- Exact absolute curve: how stocks-climbed × win-multiplier maps to 0–100 (per-game degree).
- Lead maintenance: should blowing a lead **penalize**, or only fail to reward? (Settled at the
  *set* level above — composite penalty; still open for the *per-game* degree.)
- Display: an absolute degree is no longer a clean percentile row — how to show it.
- Stale-grade handling: a logic-only change won't trip the benchmark-version stale check, so
  it must force a regrade.

**Future enhancement (banked):** matchup-aware comeback/lead — score the continuous degree by
percentile per matchup. Deferred per ADR 0001 (needs the rescan + Python parser parity).
Additive later; nothing built now is wasted.

This is the current focus, ahead of the OBS overlay below.

---

## ▶ NEXT UP — OBS / Stream Overlay (after the comeback/lead redesign)

**Goal:** show the set grade on a streamer's OBS overlay the moment a ranked SET
completes (overall letter + score, opponent char, W/L) as a transient card that
animates in and auto-hides after ~15–20 s. Full design is banked below under
**"Streamer Overlay"** and **"Set-grade overlay widget"**.

**State going in:**
- A **prototype UI was built this session and then REMOVED before the v1.6.1 release —
  it was never committed, so it must be rebuilt from these notes** (it was a quick build).
  Rebuild target: a "Stream Overlay" card in `LiveRankedSession.svelte` (premium-only),
  a single on/off toggle, collapsible-when-on ("Hide ▴ / Setup ▾"), ranked-set-only
  framing, an in-app grade **preview**, a stub Browser-Source URL
  `http://localhost:6789/overlay`, and `overlayEnabled` / `overlayExpanded` persisted
  stores in `store.ts`. The data already exists — the watcher computes `lastSetGrade`
  on set completion.
- **Premium-gated**, fires ONLY on completed **ranked sets** (not single games, not
  unranked/direct).

**THE open decision (discuss before building — do not just pick):** the transport that
feeds OBS.
  1. **`tiny_http` + polling** (recommended) — small Rust dep, the same crate
     `tauri-plugin-localhost` uses; serves a tiny auto-updating HTML page added as an
     OBS Browser Source. Keeps the styled card.
  2. **OBS Text source via a JSON/text file on disk** — zero-dep, but plain text only.
  Keep the app lightweight (explicit constraint). Settle #1 vs #2 first.

**Documented-but-not-fixed:** `CLAUDE.md` still says "the grading feature is dev-only …
do not ship/un-gate without explicit instruction." That's stale as of v1.6.0 — grading
shipped as a **Premium** feature (gated by `$isPremium`, tab always rendered). The
matching comment in `grade-benchmarks.ts` was corrected; the `CLAUDE.md` line was left
for the owner to update.

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

~~**⚠ respawn_defense_rate baselines still missing (2026-05-21)**~~ **Resolved 2026-05-22.** Targeted rescan completed on the **macOS machine**: **197/197 entries populated** (was all `sample_size: 0`), 418,846 samples over 221,943 replays, ~7.9 hrs. Used corrected `SPAWN_STATES = {0, 12}` (matches `slp_parser.ts`). `grade_baselines.json` + `grade-benchmarks.ts` regenerated. (The targeted rescan + supervisor scripts used here have since been removed — recoverable from git history.)

**Operational notes from this run (read before the next big rescan):**
- **peppi-py 0.8.x renamed `post.damage` → `post.percent`** — handle both; older venvs still expose `.damage`.
- **The Xet backend wedges:** individual download threads hang indefinitely (the per-batch `as_completed(timeout=300)` does not reliably fire), freezing a batch with no error. A supervisor that detects log silence > 300 s, kills, and resumes from the checkpoint avoids data loss. Disabling Xet (`HF_HUB_DISABLE_XET=1` + `HF_HUB_DOWNLOAD_TIMEOUT=30`) is reliable but ~5× slower.
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
`computeAdvancedStats`), `scripts/parse_hf_replays.py` (benchmark parser), `scripts/our_stats.cjs` (audit port; **its respawn logic
is still stale**, predates the `SPAWN_STATES={0,12}` fix), `src/lib/grading.ts`
(`STAT_DESCRIPTIONS`). Typecheck clean, 14/14 tests pass (grading.test.ts), all parsers parity-checked.

**The rescan** patched only recovery + edgeguard in `grade_baselines.json` (the other 15 baselines untouched), ran ~4.2 hr on the Windows wired box, and `grade-benchmarks.ts` was regenerated. The one-off targeted-rescan + supervisor scripts used for it have since been removed — recoverable from git; for any future stat rescan use the primary `parse_hf_replays.py` pipeline (see **Baseline pipeline** / `PIPELINE_RUN.md`).

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

The grading benchmarks are built from the HuggingFace dataset. **Runbook: [`scripts/PIPELINE_RUN.md`](../scripts/PIPELINE_RUN.md).**

- **`scripts/parse_hf_replays.py`** (primary) — parses the HuggingFace `erickfm/slippi-public-dataset-v3.7` dataset with peppi-py (~170 parses/sec) and writes `scripts/grade_baselines.json`. Use `.venv/Scripts/python.exe`; needs `HF_TOKEN`. `--character ALL` loops all characters with shared accumulators + per-character checkpoints. peppi-py uses EXTERNAL character IDs (CSS order). Manage the download ThreadPoolExecutor manually (`shutdown(wait=False, cancel_futures=True)`) to avoid the HF 429-retry hang.
- **`scripts/regen_benchmarks.py`** — reads `grade_baselines.json`, emits `src/lib/grade-benchmarks.ts`. Run after every parse. `BENCHMARKS_VERSION` = the JSON's top-level `generated_at`, which drives stale-grade detection — any targeted rescan MUST bump it.
- **Ground-truth comparison:** `scripts/compare_stats.cjs` (what slippi-js computes) vs `scripts/our_stats.cjs` (a Node port of our TS parser). Edit the `SETS` array in both with matching local replay paths, run both, diff. Only meaningful on a machine where those paths exist.

---

## Release pages (GitHub)

The release workflow (`.github/workflows/release.yml`) publishes **only the latest version's `release-notes.md` section** as the GitHub release body (written to `release-body.md`), not the entire changelog — so the download assets aren't buried under the history. It also prepends a standing "already installed? no need to reinstall — just reopen the app for the update prompt" banner.

**Keep this layout for every release.** `latest.json` (the in-app updater notes) is unaffected — it already shows only the version-specific notes. The full changelog history stays in `release-notes.md` in the repo.

---

## Cross-machine workflow

**Git is the ONLY channel between machines.** Per-machine state that does NOT travel — never treat it as shared truth:
- **Claude Code's auto-memory** (`~/.claude/...`, gitignored). Each machine has its own; *this file* is the real handoff. (This is why "context discrepancies" happen across machines.)
- **App data / SQLite DBs** (`%APPDATA%\\com.slippi.rankedstats\\...` on Windows; `~/Library/Application Support/Slippi Ranked Stats/...` on macOS).
- `scripts/logs/`, `.venv/`, build output (all gitignored).

**Session start (every machine, every time):**
1. `git pull`
2. Read this file — the SESSION HANDOFF banner + NEXT UP (CLAUDE.md enforces this).
3. `git status` — and write any leftover uncommitted work into the SESSION HANDOFF banner.

**Session end:**
1. Commit + push everything. If work must stay uncommitted, note it in the SESSION HANDOFF banner and push that note.
2. If a feature's status/gating changed, update `CLAUDE.md` **in the same commit** — the stale "grading is dev-only" line happened because this wasn't done.

Source of truth on a new machine: this file + `git log --oneline` + `release-notes.md`.
