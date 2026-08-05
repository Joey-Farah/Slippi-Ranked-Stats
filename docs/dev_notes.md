# Dev Notes

Working notes for in-progress features. Not part of the user-facing docs.
Update this file as features land or context changes — it's the
hand-off mechanism between work sessions and across machines.

---

## ⚠ SESSION HANDOFF — 2026-08-03 (v1.9.0 — NOTES + LEAD-MAINTENANCE FIX + LIVE TAB REWORK — READ FIRST)

> **State: PREPARED AND PUSHED TO `main`, DELIBERATELY NOT TAGGED.** Version bumped to 1.9.0 in
> all three places, `release-notes.md` written. `tsc --noEmit` clean, `vite build` clean,
> **124/124 tests**. Joey approved the release, then decided to hold it — **"save the release for
> another day, I'll ask you to do the release tomorrow" (2026-08-03).** Everything is committed;
> the only remaining step is tagging `v1.9.0` and pushing the tag, which is what triggers CI and
> publishes to users. **Do not tag without asking.**
>
> **Post-review fix (2026-08-04, `a51bf10`): the tab strip scrolls instead of clipping.** Found
> testing the 1.9.0 build on a normal MacBook window — eight tabs overflowed a plain flex row and
> cut off **Notes**, which is last and can't be moved (persisted index). Joey picked scrolling over
> wrapping. Affordance details and the two load-bearing CSS rules are in CLAUDE.md's v1.9.0 bullet
> (7); the epsilon in `tab-scroll.ts` exists because `zoom` yields fractional widths.
>
> **✅ THE OPEN GATING DECISION IS CLOSED (2026-08-04): the Notes tab ships FREE.** Joey decided
> the standalone tab stays ungated — no `PremiumGate` in `Notes.svelte`, and nobody should "fix"
> its absence later. The live-session panel remains Premium only because it lives inside Live
> Session's `$isPremium` gate. Nothing blocks the tag now except Joey asking for it.
>
> **⚠ LEAD MAINTENANCE WAS BADLY BROKEN — FIXED HERE (`GRADING_LOGIC_VERSION` 6→7).** Joey
> reported winning a set without dropping a stock and getting a B. Confirmed against his real
> database (`raw=0.58`), then derived: **0.58 was the stat's mathematical ceiling for every
> player.** Two compounding defects:
> - The size nudge docked by the PEAK lead (`marginMax`), not by what was given back — so
>   dominating was punished.
> - `troughAfterUp` is structurally pinned at **+1**: stocks are lost one at a time, so the moment
>   you first go ahead the margin is exactly +1 and the running minimum records it. `leadCbPos`'s
>   `m >= 2 → 1.0` branch was therefore **dead code** for lead maintenance.
> - They compound: not dipping requires never losing a stock, which forces `marginMax` to 4, which
>   triggers the maximum penalty. `0.70 − 0.04×3 = 0.58`.
>
> Now measured as the worst **drawdown from the running peak** (`maxGivenBack` / `lowAtGiveBack`).
> Surrender nothing → 1.0, whatever the lead's size.
>
> ⚠ **My FIRST attempt at this fix was also wrong, and Joey caught the second one in the app.**
> Both failures were the same mistake as the original bug — feeding the formula a quantity that
> didn't mean what its name suggested:
> - Attempt 1 used `marginMax − troughAfterUp` as "given back". That measures how much the lead
>   **grew**, since the trough is pinned at the entry point. Caught by a unit test.
> - Attempt 2 forgot that **every won game ends with you ahead**. A game trailed the whole way and
>   then closed out registered as "went ahead and never gave any back" → a free 100. Joey found a
>   real 1–2 **SET LOSS** vs `PZPR#0` scoring **100** on lead maintenance, because its two losses
>   were null and the one win was this trivial case, so the average was exactly 1.0.
> - Fix: **a margin only counts as a lead while `opp.stocks > 0`.** Taking someone's last stock is
>   winning, not going ahead. Mirrored as `playerAlive` for comeback.
>
> **`leadMaintenanceDegree` / `comebackDegree` are now exported from `slp_parser.ts`** and unit
> tested in `lead-comeback.test.ts` — deliberately over **stock-count paths** (`[[4,4],[4,3],…]`)
> rather than margins, because the `oppAlive` rule cannot be expressed in margins at all. Don't
> "simplify" those fixtures back to margins.
>
> **No rescan needed:** `lead_maintenance_rate` is in `ABSOLUTE_STATS` (never benchmarked), and
> `parse_hf_replays.py` only stores a crude win/loss binary for it, so the Python side is
> irrelevant to scoring. This is a TypeScript-only change.
>
> **Also in this release:** the Live Session tab was reworked (session figures → a compact strip at
> the top; two-column grid, live match left / notes right; the Rolling 20-Set Win Rate chart moved
> to Rating History). Ctrl +/− now uses Chromium's **`zoom`** instead of `transform: scale()` —
> `transform` scaled rendered output without reflowing, which is why text went soft, why it needed
> a `100/zoom vw/vh` counter-hack, and why charts never re-fitted (ResizeObserver saw the
> untransformed size). Chart resizes are coalesced to one per animation frame (they were running a
> full ECharts re-layout on every observer callback during a window drag). Zoom persists as
> `srs_uiZoom`; the 20-snap average toggle persists as `srs_showRatingAvg`.
>
> ⚠ The 20-snap toggle was **first built as a clickable legend entry** and Joey couldn't find it —
> it rendered identically to the static label it replaced. Controls belong in the control row;
> legends describe. Don't move it back.
>
> **The notes feature itself** (built earlier this session) is described in full below. The DDL and
> every CRUD statement were executed against real SQLite (`node:sqlite`) including index-usage
> query plans, and `notes.db` was confirmed created by the real app with the right schema.
>
> **What it is (Joey's ask):** when you run into an opponent, the app pulls up any notes you've
> previously left for yourself about that person — quick bullets, on screen before the match
> starts. Extended mid-request to **matchups as well as people**.
>
> **Two kinds of note, one table:**
> - **opponent** — keyed by connect code. "Always techs in place off the top platform."
> - **matchup** — keyed by (**your** character → **their** character), *directional*, because
>   Fox-vs-Marth and Marth-vs-Fox are not the same problem. `player_char = ''` is a deliberate
>   wildcard meaning "any character I play", for facts about the opposing character rather than
>   about the pairing.
>
> **Storage: a NEW `notes.db`, deliberately NOT the per-connect-code DB.** Same pattern as
> `scanned.db` (`getNotesDb()` in `db.ts`). A note is about a *person*, not about which of your
> accounts you happened to face them on: linked codes must all see the same notes, and switching
> your primary connect code must not strand them in a file the app stops opening. Absent keys are
> `''` rather than `NULL` throughout, so every lookup is plain equality instead of the
> NULL-never-equals-NULL footgun on an indexed column. Two indexes, both confirmed used by
> `EXPLAIN QUERY PLAN`.
>
> **One row = one bullet**, not one blob per subject. Bullets are what actually gets written
> mid-session (one field, hit Enter), and individually addressable rows are what make pinning,
> deleting the one that stopped being true, and capping the live list possible.
>
> **The whole table is resident in memory** (`notes` store in `notes.ts`, loaded once in
> `App.svelte`'s `onMount` — *not* lazily when the Notes tab is first opened). A note list is
> hundreds of rows at the very most, and keeping it resident means the live panel renders
> synchronously off the same store update that puts the opponent on screen. That's the one moment
> the feature has to be instant, and it must work whether or not the Notes tab was ever visited.
>
> **Why the timing works at all:** v1.8.13/v1.8.14 already put the opponent's code AND both
> characters on screen at game *start* (the `.slp` header peek, ~100ms). So the notes panel is
> populated before the match loads. Nothing new was needed in the watcher for this.
>
> **Files:**
> - `src/lib/notes.ts` — pure matching/sorting/grouping (unit-tested) + the `notes` writable,
>   the `activeSetNotes` derived, and the async actions. Imports `store.ts`, never the reverse —
>   putting the writable in `store.ts` would have made the derived's dependency on
>   `notesForContext` a cycle.
> - `src/lib/db.ts` — `getNotesDb()` + `NoteRow` + CRUD.
> - `src/components/NoteList.svelte` — one bullet per row: click to edit, Enter saves,
>   Escape cancels, blur saves, ★ pins, ✕ is **two-step** (turns into "Delete?", auto-disarms
>   after 4s). There's no undo, so a single stray click must not destroy a note written weeks ago.
> - `src/components/NoteComposer.svelte` — the write box. Enter submits, Shift+Enter newlines.
> - `src/components/OpponentNotes.svelte` — the live panel, rendered under NOW PLAYING in
>   `LiveRankedSession.svelte`. Shows both lists plus a composer with a **This player /
>   This matchup** target toggle (defaults to player; a note jotted mid-set is nearly always
>   about the person). The matchup half hides and the toggle disables when either character
>   isn't known yet — a recovered session has no header read at all.
>
> ⚠ **The panel is NOT gated on `activeSet`, and that's the point.** A ranked set clears
> `activeSet` the instant someone reaches 2 — and the moment you actually want to write a note is
> *right after* playing someone, not during. So `liveNoteSubject` (in `notes.ts`) falls back to
> the last game of `liveGameStats` when nothing is live, the panel stays put until the next game
> starts, and it gets a small **"last opponent"** chip so it's clear NOW PLAYING is gone.
> `liveGameStats` already resets on a session gap, so this can't resurrect somebody you played
> last night. Per-game rows carry no display name, so `preferredTag()` recovers one from their
> own notes — which also means a player you have notes on is named on screen even if the profile
> fetch fails outright.
> - `src/components/tabs/Notes.svelte` — new tab (index 7). Browse/search/filter every note, and
>   write notes **ahead of time** for someone you aren't playing: the connect-code field is an
>   input backed by a `<datalist>` of everyone you've actually played (most-played first), so a
>   code you've never faced is still typable.
>
> ⚠ **`activeTab` is persisted as an integer index, so the Notes tab was APPENDED (7), not
> slotted next to Live Session where it belongs conceptually.** Inserting mid-list would silently
> move every existing user to a different tab on update.
>
> ⚠ **Notes are deliberately NOT on the OBS overlay, and shouldn't be.** The panel is a scouting
> report on the person you are playing; putting it on stream hands it straight to them. This is a
> different call from the v1.8.14 last-season strip (which was "out of scope, easy to add later")
> — this one is "don't".
>
> **`syncOpponentTag()`** is called from `applyOpponentProfile()` in `watcher.ts` (one line) so a
> player who renames themselves doesn't sit in the Notes tab under a tag they haven't used in a
> year. Guarded twice — no-ops unless they actually have notes and the name actually changed —
> so it isn't a write per set.
>
> **✅ COMEBACK HAD THE EXACT MIRROR BUG — ALSO FIXED HERE.** Found while answering "does the
> grading cover every outcome". `highAfterDown` was a running MAXIMUM seeded at the −1 entry point,
> so the comeback base could never fall below `leadCbPos(-1) = 0.30` — the floor unreachable
> exactly as the lead's ceiling was — and the depth nudge then *added* credit for how deep the hole
> was even when none of it had been climbed out of. Measured: **being 4-stocked scored 31.5 while
> going down one and never recovering scored 22.5** — a blowout beat a close loss.
> - Now the mirror of the lead measure: best **run-up from the running trough**
>   (`maxClawedBack` / `highAtClawBack`), gated on `playerAlive` so being taken to zero doesn't
>   count as falling further behind. Recovering nothing = 0.
> - Folded into the **same** `GRADING_LOGIC_VERSION` 7 bump, so it cost no extra regrade. Doing it
>   after the release would have needed a v8 and a second full regrade.
> - ⚠ **Getting four-stocked is the only path that recovers nothing** — taking any of their stocks
>   is a recovery — so a "shallow no-recovery" test case cannot be constructed. Don't try.
>
> **DECISION FOR JOEY (deliberately left as-is, one-line change):**
> 1. **Premium gating.** The live panel inherits the Live Session tab's existing `$isPremium`
>    gate for free. **The new Notes tab is currently ungated.** CLAUDE.md says to discuss gating
>    before building it in, so it wasn't guessed at. If it should be Premium it's a `PremiumGate`
>    wrapper in `Notes.svelte`, same as `LiveRankedSession.svelte`.
> 2. **Not eyeballed against a live game** — same limitation as v1.8.14. What to watch: that
>    notes for a known opponent are already up when the match loads, and that the matchup line
>    names the right pairing.
>
> **What WAS verified beyond the test suite:**
> - A real `tauri dev` run booted clean and sat there for ~3 min taking HMR updates with **no
>   runtime errors** — so the new tab registers and the components mount.
> - **`notes.db` was created by the actual app** (via the Tauri SQL plugin, not a simulation) and
>   its schema read back out of `%APPDATA%\com.slippi.rankedstats\…\data\notes.db`: table plus
>   both indexes, exactly as written. `refreshNotes()` at mount works end to end.
> - The DDL and every CRUD statement were separately executed against real SQLite via
>   `node:sqlite`, including `EXPLAIN QUERY PLAN` confirming both indexes are actually used and
>   that the `updateOpponentTag` `<>` guard makes a repeat call a genuine no-op.
> - ⚠ **The dev run was killed early on purpose: Joey was mid-session in Slippi at the time** and
>   `tauri dev` shares the production app's identifier, hence its app-data dir, DBs and overlay
>   files. **Don't leave a dev instance running alongside the installed app while playing.**

---

## ⚠ SESSION HANDOFF — 2026-08-01 (v1.8.14 — opponent season history + the REAL opponent-delay fix — READ FIRST)

> **State: ✅ RELEASED. `v1.8.14` tagged and pushed 2026-08-02; both CI jobs green (Windows +
> macOS), release live and not a draft, `latest.json` carries all 4 platform keys, all signed —
> so auto-update is live on both platforms.** `tsc --noEmit` clean, `vite build` clean,
> **70/70 tests** (21 new). **Still NOT eyeballed in a live game** — Joey is testing against the
> shipped build; see VERIFY below for the two things to watch.
>
> **1. Opponent's season W/L + last-season rank on the Live Session tab** (Joey's request).
> Both come from the `fetchRatingSnapshot(opponentCode)` call the live card **already makes** —
> `rankedNetplayProfileHistory` was being returned and thrown away, exactly like the characters
> were before v1.8.8. **Zero extra API calls.**
> - `SeasonData` gained `global_rank` (from `dailyGlobalPlacement`); new **`previousSeason()`**
>   in `api.ts` returns the most recently *completed* season.
> - ⚠ **The API omits seasons a player didn't play.** So this is "their last season", NOT
>   necessarily the one immediately before the current one. Verified live against real
>   profiles: 3 of 15 sampled opponents pointed at Season 2 or Season 3 while Season 4 was the
>   most recent season overall. **That's why the UI prints the season NAME** instead of a
>   "Last season" label — the label would be a lie for a returning player. Don't "simplify" it.
> - ⚠ **`dailyGlobalPlacement` IS populated for past seasons**, and still only for roughly the
>   top 300 (every historical value observed across the sample was ≤ 288; everyone outside it
>   returned none at all). So it doubles as the Grandmaster flag for a past season exactly as
>   it does for the current one — `getRankTier(rating, global_rank > 0)`. This was checked
>   before relying on it, because if the API had returned a placement for *everyone* it would
>   have promoted every past Master to Grandmaster.
> - New `PrevSeasonInfo` type + `opponent_prev_season` on `ActiveSet` (`store.ts`). Rendered as
>   a **full-width footer strip** under the NOW PLAYING grid (with a 20px rank medal), not as
>   another line in the identity column — that column is already the tallest of the three and
>   the season name needs the horizontal room.
> - The season W/L line special-cases a 0–0 record as "No ranked games this season" — the raw
>   `0W–0L (—)` reads like a failed fetch rather than a fact about the player.
> - **The three duplicated opponent-profile `.then()` blocks in `watcher.ts` are now one
>   `applyOpponentProfile()`** (peek / game-end parse / watcher-start recovery). They had
>   already drifted: only the peek's copy avoided downgrading a header-derived tag to null.
> - **Deliberately NOT on the OBS overlay.** Joey asked for the Live Session tab; putting it on
>   the overlay means another `OverlayVisibility` toggle and layout work in `stats-overlay.ts`.
>   Easy to add later — `opponent_prev_season` is already on `ActiveSet`.
> - **Why this is worth having (real capture):** an opponent reading `Gold I · 1536, 4W–1L this
>   season` who finished last season at `Grandmaster · 2323`. That's smurf/placement detection
>   you can see *before* the set instead of working it out afterwards.
>
> **2. The remaining opponent-detection delay was the FS WATCHER, not the parser.** v1.8.13
> moved opponent detection to game start via `parseSlpHeader`, but a stubborn ~2s remained.
> Root cause: **`watch()` from `@tauri-apps/plugin-fs` passes `delayMs: 2000` when you omit the
> option** — it is not "no debounce". The Rust side (`tauri-plugin-fs` 2.4.5, verified in the
> crate source) feeds that straight into `notify-debouncer-full` with `tick_rate: None`
> (= timeout/4), and **that debouncer holds every event for the full timeout before releasing
> it**. So the `create` event that fires the game-start peek arrived **2.0–2.5s late**. The peek
> was working perfectly; it just wasn't being told a game had started.
> - Now `watch(dir, handler, { recursive: true, delayMs: WATCH_DEBOUNCE_MS })` with
>   `WATCH_DEBOUNCE_MS = 100` → create delivered in ~100–125ms.
> - **A short delay is still much better than `watchImmediate`**: the debouncer collapses
>   same-kind events per path, so 100ms caps us at ~10 modify events/sec/file during a match
>   instead of one IPC message per frame at 60fps. `watchImmediate` would have removed the
>   debouncer entirely and flooded the webview for the whole game.
> - ⚠ **Never omit `delayMs` on `watch()` in this codebase.** Same trap for anything else that
>   ever starts watching files.
> - `HEADER_PEEK_DELAYS_MS` retuned `[120,400,1200,3000]` → `[50,100,200,400,800,1500,3000]`:
>   with a 100ms debounce we now frequently beat Slippi to the Game Start block, so the ladder
>   has to start tight. Also **fixed an off-by-one** — it indexed `HEADER_PEEK_DELAYS_MS[attempt
>   + 1]`, silently skipping the shortest delay and making the first retry the slow one.
> - `FILE_SETTLE_MS` (800ms) deliberately unchanged. Net effect: the game-end full parse also
>   lands ~2s sooner, since it no longer waits out the 2s debounce first.
>
> **3. Folds in the three banked post-v1.8.13 changes** (stage-id table, non-legal-stage
> exclusion from stats/grading, scrollable Live Session game list) — they needed nothing but a
> version bump and are covered in the v1.8.14 release notes.
>
> **Tests added (21, suite now 70):** `season-history.test.ts` — `previousSeason` ordering/
> independence from API order, in-progress and malformed-date rejection, the lapsed-player gap
> case, the past-season Grandmaster-vs-Master placement rule, and the placement/Unranked rule
> (incl. that placements outrank the Grandmaster check, and that an omitted set count leaves
> behaviour unchanged). `session-rating.test.ts` — the bracketed happy path plus every reason it
> returns null: no baseline, no closing snapshot, no coverage at all, a stale multi-session
> bracket, an off-by-one bracket, and a snapshot past the grace window. Fixtures mirror real
> captured API responses and real rows from the app's own database.
>
> **VERIFY NEXT SESSION (needs a live game — could not be done from this machine):**
> 1. **The latency fix in a real match.** Everything above is derived from the plugin's JS
>    default plus the debouncer's documented behaviour and its crate source, and it's solid —
>    but it has not been watched happen. Start a ranked game and confirm the opponent appears
>    essentially immediately rather than after a beat.
> 2. **Watch for a modify-event flood.** 100ms should be comfortable, but if the app feels busy
>    during a long match, raise `WATCH_DEBOUNCE_MS` (250ms would still be ~8× better than the
>    2000ms default) rather than reverting it.
> 3. **The last-season strip against a real opponent**, ideally someone who didn't play last
>    season, to confirm the season name reads sensibly.
>
> **4. The 1100-rating "Silver I" mislabel — RAISED AND FIXED THIS SESSION** (Joey: "if they
> haven't received a rank, doing the slippi default is fine"). Slippi starts everyone at **1100**,
> which sits inside Silver I (floor 1054.87), so a player who had never queued that season was
> displayed as a genuine Silver I with a medal. `getRankTier` gained an optional third arg
> `setsPlayed` (season W+L); below `PLACEMENT_SETS_REQUIRED` it returns Unranked. **Left `null`
> by default so the rule is skipped, not guessed, when the count isn't known** — that keeps every
> historical/stored-snapshot path working unchanged.
> - Wired in everywhere the count IS available: `applyOpponentProfile` + `opponentPrevSeason`
>   (watcher), the overlay payload (`store.ts`), `Header.svelte`, `Sidebar.svelte`. The live card
>   also **hides the rating number** when Unranked — 1100 is a placeholder, and a mid-placement
>   rating is provisional, so printing it presents a non-number as fact.
> - ⚠ **`PLACEMENT_SETS_REQUIRED = 5` is our own reimplementation, not something read back from
>   Slippi.** Verified this session: GraphQL **introspection is disabled** on internal.slippi.gg,
>   and `NetplayProfile` has no `rank`, `isPlaced` or `placementsRequired` field — slippi.gg
>   derives the tier client-side exactly as we do. So the threshold can't be confirmed against
>   the API; it's Slippi's documented 5-placement-set rule. It's a single named constant if it
>   ever needs changing.
> - What the data DID confirm: **18/18 sampled zero-set profiles sit at exactly 1100**, but a
>   player with 3 sets was at **1095.6** — so Slippi *does* publish a moving rating during
>   placements. That means "rating == 1100" is NOT a usable placed/unplaced test; the set count
>   is. Don't switch it back to a rating check.
> - `ratingUpdateCount` exists on the API and equals season W+L (93 == 77+16 on a real profile),
>   so W+L is used instead — it needs no new field and works for already-stored snapshots.
>
> **5. Net Rating per session on the Ranked Sessions tab** (Joey's request, mid-session). New
> `sessionRatingDelta(session, snaps)` in `store.ts` → a stat card in `SessionView.svelte` (the
> summary grid widens 8→9 columns when present) and a small coloured delta in the
> `RankedSessions.svelte` list rail.
> - **Sparse by nature — "no data" is the normal case.** Snapshots only start 2026-03-20 while
>   ranked games go back to 2024-04, so on Joey's real DB only **19 of 137 sessions** have any
>   coverage at all. The UI drops the card entirely rather than showing a placeholder.
> - The delta brackets the session: last snapshot at/before the first set → last snapshot within
>   15 min of the last set. **The bracket is then validated against the snapshots' season W/L**:
>   the number of sets between the two snapshots must equal the session's set count. Without
>   that, a baseline left over from days earlier would silently absorb another session's results.
>   On the real DB the check passes for **16 of the 19**; the 3 it rejects are each off by one
>   set. Deliberate call: a rating delta reads as authoritative, so showing nothing beats showing
>   approximately-right.
> - The TS was cross-checked against a Python analysis of the real database — both produce the
>   same 16 sessions.
> - ⚠ `{@const}` in Svelte 5 must be an **immediate** child of a block (`{#each}`/`{#if}`/…), not
>   nested inside an element within it. Caught at build time here; the fix is to hoist it.
>
> **Dead code noted, not touched:** `src/components/tabs/LiveSession.svelte` is **not imported by
> `App.svelte`** (only `LiveRankedSession.svelte` is routed). It still has the old
> `getRankTier(rating)`-for-colour bug that was fixed in the live tab. Unreachable, so left alone
> — but don't resurrect it without fixing that line.

---

## ⚠ SESSION HANDOFF — 2026-07-28 (v1.8.13 — UNRANKED/DIRECT LIVE SESSIONS + game-start opponent + direct backfill — READ FIRST)

> **State: all code committed; version bumped to v1.8.13. NOT YET TAGGED/PUSHED as a release** —
> tagging is what triggers CI, so it was left as an explicit decision. Tested live on Windows in a
> `tauri dev` instance against real games; 43 tests pass, build clean.
>
> **What shipped this session:**
>
> **1. Live session tracking now covers unranked + direct (the headline feature).** Previously the
> Live Session tab and the OBS overlay went dead outside ranked. The gate was literally one line in
> `watcher.ts` (`g.match_type === "ranked"`) plus a SQL filter in `recoverActiveSet`.
>
> **The thing to understand before touching this again: `match_id` means something different per
> mode.** Ranked = one best-of-3 set (2–3 games). Unranked/direct = the ENTIRE connection with that
> opponent, until someone leaves. Measured against Joey's own data: **53 games** under one unranked
> `match_id`, **62** under one direct one (2,151 unranked and 340 direct `match_id`s scanned). So
> "first to 2" is meaningless there, and anything that assumed it had to be gated:
> - `handleRankedGame` → `handleLiveGame`; `isComplete` is now `isRanked && (…)`, so **only ranked
>   can complete**. That single fact gates grading, `setResultFlash`, the overlay post-set bridge
>   and — most importantly — `scheduleSnapshotFetch`. An unranked game tripping a rating refetch
>   would insert **phantom snapshots into the rating history**, corrupting the Rating chart and
>   session delta. This is the one thing to re-check if this code is ever refactored.
> - `liveSetRecord` filters to ranked; new `liveUnrankedRecord` counts unranked/direct in **games**.
>   The two are deliberately never summed — different units.
> - `computeAllTimeRecord` / `getGamesVsOpponent` are mode-aware (sets vs games, `all_time_unit`).
> - **No end event exists** for unranked/direct, so `armIdleClear` (15 min of quiet) clears the
>   card, and a resumed run with the same `match_id` rebuilds it (`rebuild` flag in `handleLiveGame`).
>
> **Design decision — NO mode indicator.** A RANKED/UNRANKED/DIRECT chip was built (overlay + card,
> with its own visibility toggle) and then **removed at Joey's request**: unranked should look
> identical to ranked. The only visible difference is the scoreboard caption, `Set Count:` vs
> `Games:`, which stays because calling a running game tally a "set count" would be false. Don't
> re-add the chip without asking.
>
> **2. Opponent now appears at game START (was: only after game 1 ended).** Root cause was two
> things stacked: the parser reads connect codes from the `metadata` block, which sits at the END
> of the file (~byte 3,000,000 of a 3 MB replay) and isn't written until the game finishes; and
> `scheduleFileParse` debounces 800ms after the last write, which never happens mid-game because
> Slippi writes frames at 60fps. New `parseSlpHeader()` reads the **Game Start (0x36) block only**:
> - Connect codes at **payload offset 544 + 10×port** (10-byte fields), char ids at `0x64 + 0x24×port`.
> - **Codes are Shift-JIS with a FULL-WIDTH `＃` (bytes 0x81 0x94), not ASCII `#`.** This is the
>   trap — a normal `#` search over the header finds nothing and makes it look like the codes aren't
>   there. Cost an entire wrong conclusion earlier in the session.
> - Offsets verified empirically against **299 real replays: 297 exact matches** vs metadata codes
>   (the 2 "misses" were noise in the verification regex, not real).
> - `peekHeader()` fires on the fs `create` event with a 120/400/1200/3000ms retry backoff (the file
>   can exist before the header is flushed) and **fails closed** — returns `null` rather than guessing.
> - `handleLiveGame` **carries over** the peek's already-fetched profile instead of resetting to
>   `null`, or the card would visibly blank and repopulate when game 1 ends; it also skips the now
>   redundant second `fetchRatingSnapshot`.
> - **Tag and character also come straight from the header** (no API round-trip): netplay display
>   names are 31-byte Shift-JIS fields at **payload offset 420 + 31×port** (present for every
>   player across 200 real replays), and external char ids at `0x64 + 0x24×port`. So the tag shows
>   even if the Slippi API is slow or down. `char-icons.ts` gained `externalToInternal()` — the
>   mirror of `internalToExternal()`, matched by character NAME so they can't drift; there's a
>   round-trip test over all 26 characters. ⚠ **The conversion deliberately lives in `watcher.ts`,
>   not `slp_parser.ts`**: that module has no imports on purpose, and importing char-icons there
>   would form a cycle (`slp_parser → char-icons → parser → slp_parser`) whose eagerly-built
>   lookup tables would initialise EMPTY. `parseSlpHeader` therefore returns
>   `*_char_external` and callers convert.
> - The profile fetch no longer overwrites the tag/characters with null when the API returns an
>   empty display name or lists no characters.
> - ⚠ Minor: header char ≠ full-parse char for a **Zelda who plays the game as Sheik** — the full
>   parse takes the most-played character, Game Start records the selected one. The test counts
>   agreement (>80%) rather than asserting per-file.
>
> **3. v1.8.12's direct-connect fix could not reach existing replays — fixed.** `scanDirectory`
> marks a file scanned even when the parse returns `[]` (only a *thrown* error skips the mark).
> That's deliberate — otherwise every local/CPU/teams replay re-parses on every scan forever — but
> it means widening the supported mode set can't reach files already on disk. So Bruno's v1.8.12 fix
> only ever caught direct games played *after* updating. `PARSER_CAPABILITY_VERSION` (`parser.ts`,
> now **2**) vs persisted `srs_parserCapabilityVersion` triggers a one-time
> `pruneUnproductiveScannedFiles()` (`db.ts`) that drops scan marks for files that yielded no game
> row; the normal startup scan then re-parses them. **Bump PARSER_CAPABILITY_VERSION whenever the
> parser starts accepting a match type it used to discard.** Verified on Joey's machine: 6,450 files
> re-scanned, **4,878 direct games ingested** (predicted 4,902 from an independent disk scan).
>
> **4. Pre-existing overlay bug found + fixed (since v1.8.7).** `simulateSet()` snapshots the payload
> into `statsOverlayPreview`; `layout` was re-applied from the live store but `show` never was — so
> **all 12 "Show on overlay" toggles were inert for the 38s a simulation ran**, on the real OBS
> overlay as well as the in-app preview. Fixed in `App.svelte` and `LiveRankedSession.svelte`.
>
> **5. Live Session tab layout pass** (Joey flagged the proportions): opponent **rank medal**
> (reuses `RANK_MEDAL_SVGS`, same art as the overlay) + **tag** alongside the connect code; the card
> moved off `justify-content: space-between` (which shoved blocks to the far edges of a wide window)
> onto a `1.5fr / auto / 1fr` grid; the per-game table's `1fr` stage column was eating ~600px while
> stats crammed right, now fully proportional; rows compacted (8px→5px padding) since unranked runs
> stack up to 10. Tier colour now uses `opponent_tier_color` — it was recomputed via
> `getRankTier(rating)` without the placement flag, showing Grandmaster in a Master colour.
>
> **6. `vite.config.ts`: node polyfills disabled under vitest** (`process.env.VITEST`). They stub
> `node:fs`, which blocked tests from reading real `.slp` files off disk. Node provides
> Buffer/global/process natively, so nothing is lost; the production bundle still gets them.
>
> **Tests added:** `live-record.test.ts` (ranked-sets vs unranked-games split, incl. a regression
> test that a 12-game unranked run does NOT register as a set), `stats-overlay.test.ts` (scoreboard
> unit per mode + opponent identity present in all modes), `slp-header.test.ts` (parses the newest
> 60 real replays from `C:/Slippi Replays/Recent`, first 4 KB only, and cross-checks opponent code /
> match_id / match_type / stage_id against the full parser). **Note: `slp-header.test.ts` self-skips
> when that replay directory doesn't exist**, so it is effectively Windows-machine-only — it will
> silently skip on the Mac.
>
> **⚠ Update 2026-07-31 — that test went red on a purely data-dependent change and was fixed.**
> Two of its assertions ("≥80% of the newest 60 replays parse") failed at 44/60. Nothing was wrong
> with `parseSlpHeader`: 16 of those 60 files were games **Joey isn't in** — Slippi writes
> SPECTATED replays into the same folder (a 2026-07-30 batch, e.g. `POIR#851` vs `FUN#941`), and
> returning `null` there is the correct behaviour. `recentReplays()` now pre-filters the sample to
> files whose header contains the own connect code, found by raw byte search (Shift-JIS, full-width
> `＃` = `0x81 0x94`) so the filter never leans on the parser it's testing. Result: 44/44 of Joey's
> own replays parse. **If this test ever fails again, check the sample before suspecting the
> parser** — and note that the two `files[0]` tests at the bottom were passing vacuously whenever
> the newest replay happened to be a spectated one.
>
> **⚠ ~~`main` IS AHEAD OF THE `v1.8.13` TAG — three BANKED changes are pushed but deliberately
> unreleased~~ — RESOLVED 2026-08-01: all three shipped in v1.8.14** (see the newest handoff at
> the top). Kept below for the context on *why* each change was made.
>
> ~~three BANKED changes are pushed but deliberately unreleased~~ (Joey's call: too minor to
> justify an update prompt on their own). **Fold them into whatever ships next; they need no
> further work, just a version bump.**
> - `d97e64d` **stage id table was wrong for every non-legal stage.** Only the six legal ones
>   (2/3/8/28/31/32) were right; id 24 read "Mushroom Kingdom II" when it's Big Blue, id 7 read
>   "Hyrule Temple" when it's Corneria, ~12 wrong and ~13 missing entirely. Invisible for years
>   because ranked/unranked only produce the six legal stages — **ingesting direct replays in
>   v1.8.12/v1.8.13 is what made the broken half reachable.** Table now mirrors slippi-js's `Stage`
>   enum, pinned by `parser.test.ts` so it can't drift. Display-only; `stage_id` is what's stored.
> - `1291921` **non-legal stages are now excluded from all statistics + grading.** Filtered in
>   `filteredGames` (every statistic derives from it) and separately in both grading paths
>   (`watcher.ts` live, `GradeHistory.svelte` regrade) since the benchmarks are entirely
>   legal-stage ranked play. `LEGAL_STAGES` / `isLegalStage()` live in `parser.ts`. **Games are
>   still parsed and stored — aggregates only, so it's reversible.** Real impact locally: 8 games
>   of 18,534 (0.04%), 7 of them one **unranked April Fools session** (Corneria, Mute City,
>   Rainbow Cruise, Jungle Japes, Green Greens, Poké Floats, Kongo Jungle N64) — so this was
>   already skewing unranked stats before direct games existed.
> - ⚠ Deliberately NOT filtered: the NOW PLAYING running scoreboard still counts non-legal games
>   (it reads the DB by `match_id`, not `filteredGames`). It's a scoreboard of what you played,
>   not a statistic. Revisit if that feels wrong.
> - **The Live Session per-game list is no longer truncated to the latest 10** (2026-07-31,
>   Joey's request). An unranked/direct run shares one `match_id` for the whole connection, so
>   v1.8.13 capped the list at `allGames.slice(-10)` and labelled it "(latest 10 of N)". It now
>   renders every game inside a `.game-list` scroll container capped at `clamp(140px, 48vh,
>   620px)`: a tall window stretches to show more rows, a short one gets a scrollbar. Column
>   headers are `position: sticky` **inside** that container — deliberately, so they shrink with
>   the rows when the scrollbar appears instead of drifting out of alignment (a header outside
>   the scroll box would). The list **follows the newest game** (it's at the bottom) via a small
>   `$effect`, unless the user has scrolled up more than 24px, and re-pins when the opponent
>   changes; `followLatest`/`followedMatch` are plain `let`s, not `$state`, since nothing in the
>   markup reads them. The row grid moved from repeated inline styles to `.game-grid` /
>   `.game-row` classes so the header and rows can't drift apart. Ranked sets are 2–3 games and
>   never reach the cap. Caption is now "(N games)" on unranked/direct only.
>   **Explicitly NOT worth a release on its own (Joey, 2026-07-31)** — like the two stage fixes
>   above, it rides along with whatever ships next.
>
> **NEXT UP:**
> 1. ✅ `v1.8.13` tagged, built and published (both platforms, `latest.json` has all 4 platform
>    keys signed). Release verified live.
> 2. The header peek is the newest code on the watcher's hot path (runs on every new `.slp`). It
>    fails closed, but deserves more real-play soak time before it's considered settled.
> 3. Still open from 07-18/19: the removed Ko-fi/Patreon links on the landing page, and the
>    UI-rework-vs-leave-as-is fork.

---

## ⚠ SESSION HANDOFF — 2026-07-18/19 (MARKETING LANDING PAGE — iteration pass, UI-rework fork still open — READ FIRST)

> **State: LIVE at `https://slippirankedstats.com`, all changes pushed to `main`.** This session
> was a fast back-and-forth polish pass on top of 2026-07-17's initial content pass (still below,
> unchanged in substance — hosting/DNS/naming context there still applies). No architecture
> changes, all `site/index.html` + `site/screenshots/*` edits, one commit per round-trip with Joey.
>
> **What changed, in order:**
> - **macOS download button fixed** — the Apple logo `<path>` was a corrupted/malformed SVG,
>   silently clipping the left edge of the icon. Replaced with a known-good Apple glyph path.
> - **Hero copy de-marketed** — headline/subhead rewritten to plainly describe the app (lifted
>   phrasing from `README.md`'s opening line) instead of the "Your rank says where you stand..."
>   hook copy from the 07-17 pass. Same treatment applied to the hero HUD's bottom row: replaced
>   a hand-styled fake grade badge with an actual **cropped screenshot** of a real grade card
>   (`site/screenshots/hero-grade-card.png`, cropped from `grading-detail.png`) — Joey's read was
>   that a stylized recreation didn't make it obvious the app *actually* grades your sets; a real
>   screenshot does. A short heading was added above the whole HUD panel ("Every set you play
>   gets graded by our stats engine:") to frame the stat counters before you reach the screenshot.
> - **Nav cleanup** — logo bumped 26px→38px; dropped a redundant second "view on GitHub" text
>   link that sat right next to the nav's GitHub button (same destination, felt duplicated).
> - **HUD stat swapped** — "3 categories: Neutral/Punish/Defense" → "15 stats scored across
>   Neutral, Punish & Defense" (the 15-stat count comes from `docs/grading_methodology.md`; more
>   impressive and more specific than just naming the 3 categories).
> - **Showcase layout fixed twice.** First pass (side-by-side pairs) had a real bug: flexbox rows
>   were stretching to their tallest child's height, leaving dead space under shorter screenshots
>   — fixed with `align-items: flex-start` + re-pairing images by aspect ratio instead of by
>   content logic. Final layout: `session-breakdown` + `grading-distribution` (both wide) in one
>   row; `matchup-stats` + `grading-detail` + `overlay-preview` (all portrait-ish) in a 3-up
>   `.shot-row.triple` row; `rating-history` standalone full-width. Two new screenshots
>   (`matchup-stats.png`, `rating-history.png`) landed from a git pull mid-session.
> - **Premium section removed entirely** (was a standalone box before the footer, with a
>   screenshot + Ko-fi/Patreon buttons). Joey didn't want it — its two facts (overlay is Premium,
>   full per-stat breakdown is Premium) now live as parenthetical notes on the matching showcase
>   captions instead, so the gating info isn't lost, it's just not a dedicated section anymore.
>   **Note: this also removed the only Ko-fi/Patreon links on the whole page** — nothing was put
>   back in their place (footer only has GitHub links). Flagged to Joey, not yet resolved either
>   way — if support links should live somewhere, that's still open.
> - **OBS overlay screenshot churned twice.** Briefly swapped to a wider horizontal crop
>   (`overlay-live.png`, from a screenshot pulled mid-session) thinking it'd pair better, but Joey
>   asked to revert to the original narrow vertical `overlay-preview.png` — that's what's live now,
>   grouped with the other portrait screenshots in the triple row. `overlay-live.png` was removed
>   from the repo again.
> - Confirmed via direct curl + headless Playwright render of the **live production URL** (not a
>   local file) that the overlay screenshot was in fact deployed and loading (200) when Joey
>   twice reported not seeing it after a hard browser restart — likely a stale disk cache on his
>   end (survives restarts, unlike memory cache); flagged Cmd+Shift+R / private window as the fix.
>   Worth checking this again next session if it recurs — haven't fully ruled out a real bug.
>
> **⚠ STILL OPEN — UI REWORK vs LEAVE THE APP AS-IS.** Unchanged from 07-17, still undecided,
> still worth surfacing before more screenshot work (see full writeup a few lines down — kept
> verbatim since nothing about the tradeoff changed this session).
>
> **Also still open:** the removed Ko-fi/Patreon links (see above); no setup/how-it-works story;
> no trust-question copy (bannable? needs Slippi Launcher?); general copy polish.

---

## ⚠ SESSION HANDOFF — 2026-07-17 (MARKETING LANDING PAGE — content pass done, UI-rework fork still open)

> **State: LIVE at `https://slippirankedstats.com`, hosted on Vercel.** The site
> (`site/index.html`) moved off GitHub Pages this session. Deploy mechanism: a root-level
> `vercel.json` (`{"outputDirectory": "site"}`) tells Vercel to serve `site/` without needing
> the dashboard's Root Directory field (that field wasn't showing up for Joey — this sidesteps
> it entirely). The Vercel project (`slippi-ranked-stats`, team `joey-farahs-projects`) is
> git-connected to this repo via the Vercel GitHub App (needed to be manually granted access at
> github.com/settings/installations — wasn't authorized for this repo by default) so every push
> to `main` auto-deploys, same trigger condition as the old Pages workflow. **The old GitHub
> Pages path is retired**: `.github/workflows/pages.yml` and `site/CNAME` were deleted this
> session (Vercel doesn't use a CNAME file — the domain is attached via the dashboard's Domains
> tab instead). Motivation: Joey wanted something more shareable/marketable than a raw GitHub
> Releases link, without giving up the GitHub-based release pipeline (the landing page sits in
> front of it, doesn't replace it).
>
> **Domain: `slippirankedstats.com`, bought and DNS'd through Cloudflare.** Two DNS records
> needed, **both must be DNS-only (grey cloud)**, not proxied — same reason as the GitHub Pages
> saga (Cloudflare's proxy terminates TLS itself, breaking Vercel's own cert/serving):
> - `@` (apex) → Vercel gave a CNAME-style target; Cloudflare auto-flattens an apex CNAME to A
>   records when resolved externally, so this works even though apex records can't normally be
>   a CNAME. Resolves to Vercel edge IPs (`64.29.17.65` / `216.198.79.65` at time of writing —
>   Vercel rotates these, don't hardcode).
> - `www` → CNAME to the Vercel-provided target (a generated `*.vercel-dns-*.com` hostname, not
>   a plain IP — this is correct/expected, not a mistake). **This was the actual bug this
>   session**: `www` got left proxied (orange cloud) while `@` was already fixed, so it resolved
>   to Cloudflare's own proxy IPs instead of Vercel's — apex correctly redirects to `www`, so
>   the whole site 404'd until this was caught. If the domain ever seems broken again, check
>   BOTH records' proxy toggle individually — don't assume fixing one fixes both.
> - Apex redirects to `www` (Vercel's default when both are added) — `https://slippirankedstats.com` →
>   `https://www.slippirankedstats.com`, both work.
>
> **Why `slippirankedstats.com` and not a `thelombardiproject.com` subdomain (the previous
> plan) or `slprankedstats.com` (briefly considered):** Joey wants the URL to match the app name
> exactly (it's called "Slippi Ranked Stats" everywhere — README, in-app title, repo) rather
> than a shortened/de-Slippi'd string, and decided the trademark exposure is low/symbolic once
> paired with a disclaimer (added to the footer this session: "independent, fan-made tool... not
> affiliated with, endorsed by, or sponsored by Nintendo or Project Slippi"). Domain-only
> avoidance of the word "Slippi" was considered and rejected as mostly theater — if the name
> itself were a real problem, the URL wording wouldn't fix that; the disclaimer is what's
> actually doing the legal work here, not the domain string.
>
> **Why Vercel over GitHub Pages:** apex-domain DNS on GitHub Pages needs either 4 hardcoded A
> records or Cloudflare's proxied-only CNAME flattening (a paid-tier-adjacent quirk that kept
> rejecting DNS-only apex CNAMEs as "invalid content"). Vercel handles apex domains natively
> with one flattened record and auto-issues/renews its own cert — Joey already had this working
> painlessly for `thelombardiproject.com` on Vercel, so the landing page was migrated to match.
> No payment method is on file for the Vercel account (confirmed this session) — Hobby-tier
> usage limits are far above what a single static page needs, and without a card on file
> overages would prompt an upgrade rather than silently bill.
>
> **What's there:** download buttons that fetch `releases/latest` from the GitHub API
> client-side and point at the exact `.exe`/`.dmg` asset (falls back to the releases page if
> the API call fails/rate-limits) — no hardcoded version/filename to maintain. Design pass
> grounded in Melee's own visual language rather than generic dark-gradient SaaS-template
> looks: a HUD-scoreboard hero (count-up animated, shows real benchmark numbers — 2.13M
> samples / 569 matchups / 3 categories), the three grading categories tagged with Melee's
> port colors (red/blue/green), and the actual Platinum/Diamond/Master rank medal SVGs pulled
> from `src/assets/ranks/` to back the "real ranked data" claim. Fonts: Chakra Petch (display)
> + Inter (body) + JetBrains Mono (stat readouts) via Google Fonts.
>
> **2026-07-17 CONTENT PASS — screenshots + premium section + hero, all shipped.** Joey supplied
> real in-app screenshots this session (stitched two overlapping captures into one with Python/PIL
> where a single laptop screenshot couldn't fit the whole grading detail view — no ImageMagick on
> this machine, PIL was already available). Landed:
> - `site/screenshots/session-breakdown.png`, `grading-distribution.png`, `grading-detail.png` —
>   showcase section now tells a breadth→depth story (session analytics → grade distribution
>   across all sets → one set's full Neutral/Punish/Defense stat-by-stat breakdown). Dropped the
>   fake browser-chrome dots (`.shot-frame .chrome` removed) and the old `grades.png`/
>   `last-session.png` (bad crops, no longer referenced).
> - `site/screenshots/overlay-preview.png` (a tight crop of just the live-preview card, not the
>   whole settings screen) — the premium box now **shows** the OBS overlay instead of only
>   describing live tracking in text; this was previously the single biggest gap (flagship
>   Premium feature, never mentioned on the page at all).
> - Hero HUD panel got a 4th "payoff" row: real dataset stats (2.13M samples / 569 matchups) used
>   to just sit there proving the benchmark was real without showing what it *produces* — now it
>   closes the loop with a real example (`Falco vs Fox · Win 2–0` → `S · 76`, same numbers as the
>   showcase's detail screenshot, not invented for marketing). Rank-medal trust badge upgraded
>   from small plain text to a bordered pill with bigger medals + glow. Added a second, subtler
>   ambient background gradient to soften the flat black void Joey flagged around the hero.
>
> **⚠ STILL OPEN — UI REWORK vs LEAVE THE APP AS-IS. Joey has NOT decided; ask before doing either.**
> Diagnosed 2026-07-16, untouched since: `src/styles/global.css` sets `--accent: #2ecc71` /
> `--loss: #e74c3c` — Emerald and Alizarin from the **2013 Flat UI Colors palette**; `--font: 'Segoe
> UI'` (Windows system default); `App.svelte:226-231` labels every tab with an **emoji** (`⚡ Ranked
> Sessions`, `🎮 Matchup Stats`, …) — the loudest "hobby project" tell in the app. Tile soup too: the
> session view stacks ~14 equal-weight stat cards before any content, so nothing is emphasized.
> **THE THESIS (Claude's, Joey hasn't signed off): this is NOT a blind redesign — the new design
> system already exists on the landing page** (`#0a0b0f` near-black, `#8b7bf7` brand violet, Melee's
> port colors, Chakra Petch/Inter/JetBrains Mono) and Joey already likes it, so the rework would be
> a token swap + font swap + emoji→SVG-icon swap + a hierarchy pass, not inventing a new look. Since
> the landing page now has real screenshots wired in, this fork just got **more expensive to defer**
> — any UI rework after this point means re-shooting all three showcase screenshots + the overlay
> preview. Worth surfacing that tradeoff explicitly next session before doing more screenshot work
> elsewhere.
>
> **Also still open, lower priority:** no setup/how-it-works story on the page (nobody learns it's
> ~3 clicks: point at replay folder, scan, done), and no answer to the trust questions a
> replay-touching tool raises (does this get me banned? does it need Slippi Launcher running?).
> General copy polish pass hasn't happened yet either.

---

## ⚠ SESSION HANDOFF — 2026-07-14 (MERGED BASELINES — ranked+v3.7, 2.13M samples — TESTED & APPROVED, shipping as v1.8.11 — READ FIRST)

> **State: TESTED & APPROVED — shipping as v1.8.11.** Joey reviewed grade behavior in a dev
> build (2026-07-14) and signed off. Version bumped 1.8.10→1.8.11 across package.json /
> tauri.conf.json / Cargo.toml / Cargo.lock + a release-notes.md entry. Ready to tag `v1.8.11`
> (check `git tag` — may already be pushed).
>
> **Test findings (old 2026-06-21 baselines → new 2026-07-14).** Re-scored all 891 regraded
> JOEY#870 sets under both benchmark sets; the recompute matched the app's stored grades on
> 891/891 (high confidence). Mean overall change **−0.7 pts**, median −0.8, **89% kept their
> letter** (all single-step moves, no cliffs). The drift is entirely the **Defense** category
> (−3.9 pts avg): the ranked pool's `avg_stock_duration` p50 rose ~10% (2262→2464 frames),
> recovery/death nudged up; Neutral/Punish flat. Matchup outliers were thin-sample corrections:
> Falco vs Ice Climbers **−7.1** (old IC bucket was small/soft), Falco vs Pikachu **+5.8**.
> **Matchup self-comparison verified character-agnostic:** 891/891 of Joey's sets used a
> dedicated `by_matchup[player][opp]` bucket (zero fallbacks); all 26 chars have buckets
> (569/676 combos; Fox/Falco/Marth/Sheik/Peach/Captain Falcon = full cast; low-pop chars like
> Pichu/Kirby partial → graceful fallback to the char baseline by design). The v1.8.9
> `--character FALCO` matchup-drop bug is confirmed NOT present.
>
> **What landed:** `scripts/grade_baselines.json` + `src/lib/grade-benchmarks.ts` regenerated
> from the new **StatsDB sidecar** (`scripts/raw_stats.sqlite`, multi-GB, gitignored, THIS Mac only):
> - **2,129,888 rows** total: 1,699,122 from `erickfm/melee-ranked-replays` (848,061 unique
>   replays, ALL 934 tarballs of the 1.43TB dataset, plat+ ranked, anonymized) + 430,766 from
>   the v3.7 tournament rescan (221,380 games). Sample pool grew ~5×.
> - **569 matchup entries** in grade-benchmarks.ts (was 283); baselines JSON keeps 636 (≥20).
> - **`by_rank` sections captured** (platinum 493k / master 202k / diamond 117k samples) —
>   fuel for the banked rank-stratified grading upgrade; re-pooling = a query, no rescan.
> - `BENCHMARKS_VERSION` = generation timestamp (auto-bumped) → all stored grades regrade on update.
> - **Shift vs old baselines is MILD** (p50s moved ≤3% on most stats) — the v3.7 tournament pool
>   was already ~plat+ skill. Exception: `l_cancel_ratio` p90 went 0.0 → 1.0 (top-end grading
>   for that stat is meaningfully tougher). Release notes should still mention grades may shift.
> - Pipeline code: `--dataset ranked` scan mode + StatsDB (`scripts/stats_db.py`) + progress
>   watchdog/supervisor self-healing + `--dataset db` baseline builder (commits 77bf6f9,
>   33027a1, watchdog fixes). 11 pytest + 61 vitest green.
> - Ops notes: HF blocked the legacy download path for the ranked repo mid-scan (repo-wide,
>   confirmed from multiple IPs); the hf_xet library path kept working. Joey duplicated the
>   dataset to his own HF account as plan B (can delete it). Ethernet ≈ 15-25MB/s vs WiFi ~6.
>
> **NEXT UP:** (1) ✅ Tested & approved → **v1.8.11 release prepared this session** (version bump +
> release-notes + this handoff). Remaining: tag/push `v1.8.11` to trigger the Windows+macOS CI build.
> (2) LONG-TERM (Joey, 2026-07-14): find/build a dataset covering EVERY ranked skill tier
> (bronze→GM) for truly representative grading — no public source exists today; options are
> the v3.7 connect-code skill-inference idea (banked below) or collecting community replays.

---

## ⚠ SESSION HANDOFF — 2026-06-16 (Discord weekly re-auth — REAL ROOT CAUSE found + fixed via Discord portal — READ FIRST)

> **The v1.8.4 "silent refresh" fix was correct in code but could NEVER work — the Discord app was missing the `PUBLIC_OAUTH2_CLIENT` flag.** This supersedes the v1.8.4 TO-DO claim below ("renew seamlessly forever after"), which was never live-verified and was **false**.
>
> **Root cause:** Discord requires a `client_secret` on the `refresh_token` grant **unless** the application has the `PUBLIC_OAUTH2_CLIENT` flag. We're a public/PKCE client and send no secret. So: **linking works** (PKCE `code_verifier` satisfies the authorization_code grant → a `refresh_token` is returned + stored), but the weekly `refreshDiscordToken()` (`discord.ts:74-82`) gets **`401 invalid_client`** → our 4xx branch clears the refresh token (`discord.ts:90`) → forced re-link, **recurring every ~7 days forever.** Confirmed via Discord docs + discord-api-docs#5531.
>
> **Fix (done 2026-06-16 — NO code change, NO release):** owner enabled the **"Public Client" toggle** on the SRS app's **OAuth2 tab** in the Discord Developer Portal (client ID `1489690383171719188`), which sets `PUBLIC_OAUTH2_CLIENT`. Once on: installs with a stored refresh token renew silently on next launch; any whose token was already wiped re-link **once** to repopulate, then never again. **Not yet live-verified against a real 7-day expiry** — verify next time an access token rolls over (no re-link prompt = fixed).
>
> **Banked follow-up (optional):** add a distinct console.warn in `refreshDiscordToken()` when Discord returns `invalid_client`, so a future regression of this exact class is obvious instead of looking like a normal expiry. The 4xx-clears-refresh-token behavior is correct now that the flag is set.

---

## ⚠ SESSION HANDOFF — 2026-06-11 (telemetry owner-exclusion — WORKERS DEPLOYED, client pending release — READ FIRST)

> **Stop telemetry over-counting the owner's own test installs as premium users / installs.**
> The dashboard's "Premium users" = `COUNT(DISTINCT install_id WHERE event='premium')`, and the
> `premium` ping (`discord.ts`) fires on every premium-role verify — i.e. the owner, on every test
> machine. `install_id` is a per-machine localStorage random (`store.ts`). So each dev/test install
> counted as a premium user + an install + DAU/MAU. Fix = client kill-switch + server-side exclusion.
>
> **✅ ALREADY DEPLOYED to Cloudflare this session (both workers live):**
> 1. **discord-check worker** now returns `userId` (was computed, discarded). Deployed.
> 2. **telemetry worker** — `OWNER_INSTALL_IDS` exclusion applied to **every** count (totals,
>    premium, DAU/WAU/MAU, version, OS, retention, features, all-events) + a new token-gated
>    **`/installs`** admin page (per-install list to spot owner machines). Deployed with 3 ids seeded
>    → live counts went **premium 30→27, installs 354→351**.
>    - Seeded (confident): `307770c8…` (this Mac, PROVEN — localStorage username "Joey Donuts"),
>      `b3d76c88…` (25 distinct versions), `d1922e36…` (23 versions). The big version counts are the
>      tell — no normal user runs ~24 builds.
>    - **BORDERLINE, left IN the counts pending owner yes/no:** `749f8a75…` (12 ver),
>      `28147e53…/84e21c00…/e198c5fa…/c3c18e55…` (8–9 ver). `db7823a8…` (other macOS) is likely a
>      REAL Mac supporter (owner only has this one Mac). To exclude more: add ids to
>      `OWNER_INSTALL_IDS` and `cd workers/telemetry && npx wrangler deploy`.
>    - ⚠ **Redeploying the telemetry worker from a clean checkout will KEEP the seeded ids only
>      because they're now committed** — but if you ever edit/clear that array, re-seed from above.
>      Find owner ids without the dashboard token via `npx wrangler d1 execute srs-telemetry --remote`.
> 3. **Client kill-switch (NOT yet active — ships with next release):** `pingTelemetry()` no-ops when
>    `import.meta.env.DEV`, `isOwner` (new persisted store, set in `discord.ts` when the verified
>    Discord id === `OWNER_DISCORD_ID` = `101538614428602368`), or a manual `srs_telemetryOff=1`
>    localStorage flag. Until a release ships this, owner machines keep pinging — but the exclusion
>    list keeps the dashboard correct meanwhile. Once shipped, the list stops needing new ids.
>
> **Validated:** `vite build` clean, 61/61 tests, both workers `node --check` clean, exclusion
> verified against the live D1 DB. **NOT version-bumped, NOT tagged** — the owner is building the
> release from the other machine. **REMAINING TO RELEASE:** bump 1.8.9→1.8.10 (package.json,
> tauri.conf.json, Cargo.toml, Cargo.lock), add release-notes.md entry, tag `v1.8.10`, push → CI.
> (Owner may also bundle other in-progress ideas into the same bump.)
---

## ▶ BANKED IDEA — Rank-stratified grading benchmarks (dataset found 2026-07-11, worth pursuing, NOT started)

Found a HuggingFace dataset that could turn the grader into a **rank-aware** system — grade each
player against their **own tier** instead of the current pooled-across-all-skill baselines. Banked for
a future session; discuss the design before touching the pipeline.

**The dataset:** `erickfm/melee-ranked-replays` (https://huggingface.co/datasets/erickfm/melee-ranked-replays).
- **Rank labels baked in** — files are tarballs bucketed by **rank PAIR**: `diamond-diamond`,
  `diamond-platinum`, `master-diamond`, `master-master`, `master-platinum`, `platinum-platinum`
  (higher rank first in mixed pairs). Per-replay metadata JSON: `{filename, p1(char), p2(char),
  rank(pair), archive}`. **No Slippi-API scraping needed** — the skill label is handed to you.
- **Ranked-only**, MIT license, 25 chars, **~1.19M replays / 1.43 TB**.

**Why it matters:** today `scripts/grade_baselines.json` pools every skill level, so a Platinum is
graded against a distribution that secretly includes Masters. Per-rank baselines → grade a Diamond vs
Diamonds. Real fairness/accuracy upgrade to the premium grading feature.

**Catches to design around (grill first):**
- **Plat / Diamond / Master ONLY** — no Bronze/Silver/Gold, no Grandmaster. Great for high-level
  benchmarks; does NOT give a full-ladder skill census.
- **Labels are per-PAIR, not per-player** — same-rank tarballs are unambiguous; for mixed pairs you
  must confirm which port is the higher-ranked one before attributing stats (verify vs the metadata).
- **1.43 TB** (~6.5× the ~222 GB v3.7; the v3.7 rescan took ~10.6h throttled). Tarballs are
  per-character-and-rank → **selectively download** (same-rank pairs only / capped sample per tier);
  do NOT pull the whole thing.
- **Anonymized — no connect codes** (the author scrubbed `names.code`/`names.netplay` before
  publishing, for PII reasons). Fine here — the rank bracket replaces per-player linkage.
- Integration: `parse_hf_replays.py` buckets by rank → a new per-rank baseline tier in the benchmark
  schema + `BENCHMARKS_VERSION` bump + the existing stale-grade regrade machinery.
- **⚠ our HF parser does NOT filter by match type** — it parses whatever `.slp` are in the char dirs.
  (So the current v3.7 benchmark composition is "whatever v3.7 contains"; match-type of v3.7 is
  unconfirmed. The new set is ranked-only by construction, which sidesteps that.)

**Recommended first step:** feasibility probe — pull 1–2 tarballs, confirm the rank→port mapping and a
clean per-bracket parse, before committing to any big scan.

**Related banked idea (for UNLABELED sets like v3.7):** derive skill without a million API pings via
*label-a-sample-then-infer* — look up current rating for a few thousand unique connect codes (v3.7
retains codes), fit a gameplay-stats→tier model (IPM / L-cancel% / wavedash / neutral-win are
rank-correlated), infer the rest with zero further calls (average per-player). Zero-API fallback = an
unsupervised execution index (relative spread, not absolute tiers). Ceiling: rating at record-time
isn't in the file, so current-rating labels add irreducible noise. Needs a parser change to emit
`(connect_code, stats)` per game (currently discarded). The labeled dataset above avoids all of this.

---

## ⚠ SESSION HANDOFF — 2026-06-10 (v1.8.9 — matchup coverage RESTORED + flawless=100 + overlay toggles — READ FIRST)

> **✅ v1.8.9 prepared overnight and STAGED ON MAIN LOCALLY — NOT released.** Owner gives final say + tests, then tags/pushes. Version bumped 1.8.8→1.8.9 (package.json, tauri.conf.json, Cargo.toml, Cargo.lock); release-notes.md + CLAUDE.md updated. Validated: 33/33 tests, `vite build` clean. **Do NOT tag/push without the owner's go-ahead.**
>
> 1. **Matchup baseline coverage was silently REGRESSED and is now restored (all users).** Root cause: commit `b7bb93a` ("rescan baselines with all stat fixes", 2026-05-21) re-ran `scripts/parse_hf_replays.py` with the **default `--character FALCO`** instead of `--character ALL`, so only Fox/Falco/Marth folders were parsed. `gradeSet` (`grading.ts`) looks up `by_matchup[player][opp] → by_player_char[player] → _overall`; with FFM-only data, every matchup NOT involving Fox/Falco/Marth fell back to the player-char baseline (e.g. a Sheik-vs-Pikachu set graded vs "Sheik vs everyone"). Proof of the regression: for all 22 non-FFM chars, their total game count exactly equalled the sum of FFM-vs-them. **Fix:** full `--character ALL` rescan from HuggingFace `erickfm/slippi-public-dataset-v3.7` (~192k games) + `regen_benchmarks.py`. Result: 21/24 player chars now have broad matchup coverage (≥50-sample matchups land in `grade-benchmarks.ts`; `grade_baselines.json` keeps ≥20 → 258 combos of 676). Sheik-vs-Pikachu / Peach-vs-Jigglypuff back. ⚠ **TRAP: the `--character` default is `FALCO` — ALWAYS pass `--character ALL` for a full rebuild.**
> 2. **Flawless rate ⇒ score 100 (all users).** `percentileScore` (`grading.ts`) gained a saturated-ceiling remap: new `max` param + `BOUNDED_RATE_STATS` set ([0,1] rate stats). When a stat's p95 == the 1.0 ceiling (e.g. recovery — a perfect rate is only the 95th percentile, so it used to cap at 95), the top band is remapped p90→ceiling onto 90→100, and any value ≥ max returns 100. Non-saturated stats (edgeguard, p95 ≪ 1.0) untouched. `GRADING_LOGIC_VERSION` 4→5 → grades flag stale (regrade refreshes).
> 3. **Overlay (Premium): two new independent toggles** — `setResult` (the SET WON/LOST · score · vs line) and `setRating` (per-set Rating change, decoupled from the `mmr` toggle). Added to `OverlayVisibility` + `OVERLAY_VISIBILITY_DEFAULT` (store.ts), gated by `vis()` in `stats-overlay.ts`, and in `VIS_OPTS` (LiveRankedSession.svelte).
> 4. **Overlay (Premium): stacked-layout reorder** — `buildStacked` keeps the Today's block with the persistent identity at the top and pushes transient `contextHtml` (opponent line / post-set) to the bottom (side layout already did this). Owner-requested.
> 5. **Overlay (Premium): "THIS SET" → "LAST SET:"** label on the post-set rating change.
>
> **STILL BANKED — Ice Climbers / Nana raw-stat fix.** Both parsers (`slp_parser.ts` + `parse_hf_replays.py`) discard the follower (Nana): the leader-only frame stream means hits/openings/edgeguards on Nana are invisible, so correct anti-IC play (split pressure between climbers) inflates openings-per-kill / deflates conversion rate. The v1.8.9 coverage fix makes IC grades **fair vs the same-matchup baseline** (the baseline shares the Nana-blindness → it cancels) but NOT **accurate to actual performance**. Real fix = merge Nana's frames into the opponent entity in BOTH parsers (lockstep) + another full rescan + regrade; **discuss the conversion/opening/kill/edgeguard semantics first.**
>
> **HF token:** the rescan used a HuggingFace read token (owner-provided, set as a process env var only — never written to the repo); owner is rotating it. HF throttled the big folders hard (~2 files/sec on Fox), so the rescan took ~10.6h.
>
> **Remaining to release:** owner tests the staged commit (regrade stale grades, eyeball overlay), then tags `v1.8.9` + pushes → signed CI release.

---

## ⚠ SESSION HANDOFF — 2026-06-05 (v1.8.8 — overlay opponent-char icons + Rating clarity + auto-scan — READ FIRST)

> **✅ v1.8.8: overlay polish (Premium) + an all-users auto-scan fix.** Version bumped 1.8.7→1.8.8
> (package.json, tauri.conf.json, Cargo.toml, Cargo.lock); release-notes.md + CLAUDE.md updated.
> Validated: `vite build` clean, `tsc --noEmit` clean, 33/33 tests, and the overlay's inline render
> logic exercised in a stub-DOM sandbox across ~20 scenarios (opponent icons, text fallback, post-set
> THIS SET delta, toggle gating, layout placement, self-reload). **Live-verified by the owner in the
> dev app** across several iterative tweaks (medal sizes, Set Count, wording). Tag **`v1.8.8`** to
> trigger the signed CI release.
>
> 1. **Opponent characters from their Slippi profile (Premium overlay).** `fetchRatingSnapshot`
>    (`api.ts`) now returns the profile's `characters` (`{character, gameCount}[]`, sorted desc) — it
>    was already in `PROFILE_QUERY`, just discarded. The API returns the char as a **string enum**
>    (e.g. `"FOX"`, `"CAPTAIN_FALCON"`; verified live), mapped via `API_CHAR_TO_EXTERNAL` in the new
>    `src/lib/char-icons.ts`. The watcher computes top mains (`topOpponentChars`: always #1, plus any
>    ≥15% of season games, cap 3) → `ActiveSet.opponent_chars` (external ids). The overlay renders
>    them as **character stock icons**, not the lagging per-game char; falls back to the live char
>    (converted via `internalToExternal`) when the profile lists none (season reset / new player).
>    Icons = project-slippi **GPL-3.0** stock heads (`characters/<extId>/0/stock.png`) in
>    `src/assets/characters/char_<extId>.png` (+ NOTICE), inlined as base64 data URIs by
>    `char-icons.ts` (`?inline` glob; same approach as rank-medals). ⚠ **The Slippi API char field is
>    EXTERNAL ids/enums**, NOT the internal `CHARACTERS` table in parser.ts — `char-icons.ts` has both
>    maps + the `internalToExternal` bridge.
> 2. **Rating display split for clarity (Premium overlay).** Current Rating moved to the identity
>    column (below season W/L) in both layouts; the "Today's stats" block shows the **session** change;
>    the post-set bridge shows a separate **"THIS SET"** Rating change (from `OverlaySetResult.ratingBefore`
>    vs the refetched rating — `ratingBefore` was captured but previously unused). New
>    `OverlaySetResult.opponentCharId` + `StatsOverlayOpponent.charIds` thread the icons through.
> 3. **"MMR" → "Rating"** in all user-facing overlay/UI copy (slippi.gg's term). Internal code
>    comments/CSS class names left as-is.
> 4. **Live "Set Count:" scoreboard** row during a set (white text), replacing the cramped `(w–l)`
>    that was tacked onto the opponent stat line.
> 5. **Overlay self-reloads after an app update (Premium).** No more manual OBS Browser-Source
>    "Refresh" to pick up a new overlay build. `OVERLAY_VERSION` (djb2 hash of the rendered page,
>    excluding the boot/version stamp) is written into each state file as `htmlVersion` and baked into
>    the live page as `PAGE_VERSION`; on mismatch the page cache-bust-reloads itself
>    (`location.replace(href+"?v="+version)`). `App.svelte` re-writes `stats.html` whenever
>    `OVERLAY_VERSION` changes (BEFORE announcing the new version in state) so disk is always current
>    first → **no reload loop**. The in-app preview omits `PAGE_VERSION`, so the check is a no-op there.
>    ⚠ Existing OBS sources still have the pre-v1.8.8 page loaded (no self-reload code) → they need
>    **one** last manual Refresh to load the self-reloading page; automatic forever after.
> 6. **Auto-scan on launch (all users, not premium).** `App.svelte` startup effect now fires an
>    incremental background `scanDirectory` (skips already-scanned files) so ranked sets played while
>    the app was **closed** get ingested without a manual scan — fixes a user-reported bug (the watcher
>    only catches files created while it's running; `recoverActiveSet` only looks back 15 min for an
>    in-progress set). Safe alongside the watcher: `insertGame` is `INSERT OR IGNORE` on a UNIQUE
>    filename.

---

## ⚠ SESSION HANDOFF — 2026-06-01 (v1.8.7 — overlay element toggles + grade opp-code filter — READ FIRST)

> **✅ SHIPPED in v1.8.7 (2026-06-01): two small features.** Version bumped 1.8.6→1.8.7
> (package.json, tauri.conf.json, Cargo.toml, Cargo.lock); release-notes.md updated; tagged
> **`v1.8.7`** → triggers the signed CI release. svelte-check 0 errors, 33/33 tests; verified
> live in the dev app (overlay toggles in both layouts + the grade opp-code filter).
>
> 1. **Per-element overlay visibility toggles (Premium).** Every data piece on the Live Stats OBS
>    panel can now be hidden independently (the user asked for this — previously it was all-or-nothing).
>    Ten toggles: tag, rank medal, rank name, MMR, session MMR change, global placement, season W/L,
>    today's W/L, opponent line, post-set grade. New `OverlayVisibility` type + `OVERLAY_VISIBILITY_DEFAULT`
>    (all true) + `statsOverlayVisibility` store (persisted `srs_statsOverlayVisibility`, via a new
>    `persistedMerged()` helper that merges stored-over-defaults so a future new toggle defaults to
>    *visible*, not hidden). Threaded as `show` on `StatsOverlayPayload` (added to the
>    `statsOverlayPayload` derived's deps). In `stats-overlay.ts` a `vis(s,k)` helper (missing show/key →
>    visible, so old state files never blank the overlay) gates every `*Html` render fn; `buildStacked`/
>    `buildSide` rewritten to drop empty containers + dividers when elements are hidden. UI = a "Show on
>    overlay" chip-toggle row in the setup card (`LiveRankedSession.svelte`, after Layout), bound via
>    `toggleVis()`. The in-app preview runs the same render code, so toggles reflect live there.
>    - `grade` toggle hides only the **grade letter + standout stat**; the "SET WON/LOST · score · vs"
>      post-set callout still shows (verified). `sessionDelta` gates the +/- both beside the MMR and in
>      the today's row. In the side layout the MMR lives in the today block, so `mmr` and `today` (session
>      W/L) gate independently and the block/vdivider collapse when both are off.
>    - ✅ Verified: svelte-check 0 errors (1 pre-existing Tooltip a11y warning, unrelated), 33/33 tests,
>      and the inline overlay script was extracted + run in a stub-DOM sandbox across toggle combos in
>      both layouts (all-on shows everything; minimal hides medal/season/global/delta but keeps tag+mmr;
>      opponent + grade toggles behave). NOT yet eyeballed in a live OBS source — the preview path covers it.
>
> 2. **Opponent connect-code filter in the Grading tab (came from a user suggestion: "search direct
>    code sets and grade them").** Added a free-text **OPPONENT CODE** search box to the grading filter
>    card (`GradeHistory.svelte`), case-insensitive substring on `opponentCode`, with a `<datalist>` of
>    known codes for autocomplete. Wired into `sortedHistory`, `anyFilterActive`, and Clear filters.
>    ⚠ **Scope note:** the suggester literally meant grading **Direct-connect (unranked) sets**, which the
>    grading tab does NOT do today (`sets` derives from `rankedGames` only — ranked Bo3 ft2). Owner chose
>    to ship just the opp-code filter now and **bank** the grade-direct-sets idea (see NEXT UP below).
>
> Released as v1.8.7 — release-notes.md has the user-facing copy for both features.

---

## ▶ BANKED IDEA — Grade Direct / Unranked sets (deferred 2026-06-01)

A user suggested being able to **grade Direct-connect (and unranked) sets**, not just ranked. Today the
Grading tab only ever sees ranked sets: `sets` (store.ts) derives from `rankedGames`, and a "set" is
defined as ranked **Bo3, first-to-2** (`completedSets` in `GradeHistory.svelte`). Direct/unranked games
exist in the DB (`unrankedGames`) but are never grouped into sets or graded.

**Why it's non-trivial (discuss before building — touches the grading pipeline + premium gating):**
- **No fixed set length for direct play.** Friendlies aren't ft2 — they can be ftX of anything or endless.
  "What is a set?" needs a definition (e.g. group consecutive games vs. the same opponent code split by a
  session time-gap, or let the user pick ftX). This is the core design decision.
- **Premium vs free.** Grading is a Premium feature; need to decide whether direct grading is in/out of
  the same gate, and how the tab presents ranked vs direct (separate sub-views? a match-type filter?).
- The grade math itself is match-type-agnostic (per-game stats from the parser), so the *grading* part is
  reusable — it's the **set boundary + UX + gating** that's the work.

The opp-code filter shipped this session is complementary: it's most useful once direct sets are gradeable
(you'd search for a specific friend's code). Building this later wastes nothing already done.

---

## ⚠ SESSION HANDOFF — 2026-05-31 (v1.8.6 — "forbidden path" REPLAY-SCAN FIX — READ FIRST)

> **v1.8.6 released this session — fixes a regression that SHIPPED in v1.8.4.** The security
> hardening (commit 2e5e597, in the v1.8.4 tag) narrowed the `fs` read/read-dir/watch capability
> from whole-disk (`**`) to `$HOME/**`. Any user whose Slippi replay folder lives **outside their
> user folder** — another drive, or a drive root like `C:\Slippi Replays` (the owner's own setup) —
> hit **`Scan error: "forbidden path: C:\Slippi Replays"`**. The prior handoff banner had explicitly
> predicted this ("revert to `**` if that report ever comes in") — the report came in.
>
> **FIX:** reverted `fs:allow-read-file` / `fs:allow-read-dir` / `fs:allow-watch` back to `**` in
> `src-tauri/capabilities/default.json` **and** its generated mirror `src-tauri/gen/schemas/capabilities.json`.
> Write stays scoped to `$APPDATA/**` (unchanged). The replay folder is user-configurable to any path
> on any drive, so there is **no static narrowing that won't eventually break someone** — `**` is the
> only correct scope for reads. The original exfiltration concern that motivated `$HOME` is still
> covered by the **CSP** (`script-src 'self'`, enabled the same hardening pass) — injected JS can't run,
> so whole-disk *read* capability doesn't reopen that hole. ⚠ Capabilities are **compiled into the Rust
> binary** — a JS HMR reload does NOT pick this up; a dev restart / rebuild is required (verified live
> this session: scan works again).
>
> **Bundled in the same v1.8.6 release** (were sitting unreleased on `main` from prior commits):
> tab-memory restore (app reopens on last tab) + expanded anonymous telemetry (scan / live-session /
> grade / overlay-toggle counts). Version bumped 1.8.5→1.8.6 (package.json, tauri.conf.json, Cargo.toml,
> Cargo.lock); release-notes.md updated. Tagged **`v1.8.6`** → triggers signed CI release.

---

## ⚠ SESSION HANDOFF — 2026-05-29 (v1.8.5 — OVERLAY PREVIEW REGRESSION FIX — READ FIRST)

> **v1.8.5 released this session — fixes a regression that SHIPPED in v1.8.4.** The CSP
> hardening (commit 2e5e597, contained in the v1.8.4 tag) set `script-src 'self'`, which blocked
> the in-app OBS overlay **Live preview** iframe: it rendered from an inline `<script>` inside a
> `srcdoc` iframe, and a srcdoc iframe inherits the parent's CSP → inline script blocked → blank
> box. OBS was unaffected (its CEF loads `stats.html` off disk, no app CSP). Premium overlay
> users on v1.8.4 saw a blank preview.
>
> **FIX (asset-protocol baked preview):** the preview iframe no longer uses `srcdoc`. It loads a
> baked `preview.html` (payload inlined, no polling) via the **asset protocol** (`convertFileSrc`).
> A real-URL frame does NOT inherit the app CSP, so its inline script runs; baking the payload in
> also avoids the live page's relative `stats-state.js` fetch, which the asset protocol's encoded
> single-segment path can't resolve (that was a failed first attempt — pointing the iframe at the
> live `stats.html` loaded but 404'd its state file → still blank). Changes:
> - `tauri.conf.json`: added `frame-src 'self' asset: http://asset.localhost` to CSP +
>   `assetProtocol { enable: true, scope: ["$APPDATA/stream-overlay/*"] }`.
> - `Cargo.toml`: `tauri` features now include `protocol-asset` (CLI auto-added on build) → `http-range` in Cargo.lock.
> - `stats-overlay.ts`: restored `overlayPreviewHtml`, added `writeStatsOverlayPreviewFile` + `statsOverlayPreviewPath` (writes `preview.html`, separate from the OBS `stats.html`).
> - `LiveRankedSession.svelte`: preview writes `preview.html` on payload change + points the iframe at `convertFileSrc(previewPath)+"?v="+ver` (ver cache-busts so it reloads).
> - ✅ Verified live in dev: preview renders + Simulate works. svelte-check clean, 33/33 tests.
> - ⚠ Note for future: Svelte HMR did NOT apply the new `$effect` mid-session — a dev RESTART was
>   needed before `preview.html` got written. If preview is blank after a preview-code change, restart.
>
> **The TO-DO list below predates this fix — the manual/owner items (telemetry deploy, feedback
> rate-limit, 2FA, npm audit) are still open.**

---

## ⚠ PRIOR HANDOFF — 2026-05-29 (SECURITY HARDENING)

> **Security review of the whole app this session. Worst-case (malicious auto-update) is
> already well-defended — the updater signing key is NOT in the repo (never has been; checked
> all branches) and unsigned updates are rejected client-side. The Rust backend is tiny + safe
> (2 commands, no shell injection), and all SQL is parameterized. Found + fixed several
> defense-in-depth gaps. Changes are committed to `main` but NOT released — they only reach
> users when bundled into the next version bump (see TO-DO).**
>
> **✅ APPLIED + TESTED this session (svelte-check clean, 33/33 tests, dev app launches clean
> under all changes):**
> 1. **CSP enabled** — `tauri.conf.json` was `"csp": null`; now a real policy with
>    `script-src 'self'` (no inline/remote JS can run → a poisoned dep or future XSS can't
>    steal Discord tokens / call privileged APIs). `style-src-attr 'unsafe-inline'` kept so the
>    app's many inline `style=` attrs still work. Network calls are unaffected (they go through
>    plugin-http / the Rust updater, which bypass webview CSP). Verified the app renders.
> 2. **fs read scope narrowed** — `capabilities/default.json` read/read-dir/watch were `**`
>    + `/**` (whole disk); now `$HOME/**`. Write was already correctly scoped to `$APPDATA/**`.
>    Folder-picker dialog is unaffected (OS dialog isn't capability-gated). ⚠ If a user keeps
>    replays on a non-home drive (e.g. `D:\`), this would block them — revert to `**` if that
>    report ever comes in. `gen/schemas/capabilities.json` auto-regenerated.
> 3. **CI uses `npm ci`** (was `npm install`) in both release.yml jobs — lockfile-exact builds
>    on the signing machine.
> 4. **Telemetry worker `/stats` + `/init` gated** behind `?key=<DASHBOARD_TOKEN>` (a Worker
>    secret) — install/DAU/premium numbers were public to anyone with the URL. Returns 404
>    without the key. ⚠ NOT LIVE until redeployed + secret set (see TO-DO).
> 5. **Overlay `<script>` injection hardened** — `stats-overlay.ts` now routes all 3 inlined-
>    payload sites through `jsonForScript()` (escapes `<` → `<`) so an opponent's Slippi
>    display name (attacker-controlled) containing `</script>` can't break out.
>
> **📋 TO-DO NEXT SESSION (owner is away from the computer — these need the owner's machine /
> accounts; nothing here is done yet):**
> - **[manual, owner] Deploy + secret the telemetry worker** so fix #4 takes effect:
>   in `workers/telemetry/`: `npx wrangler secret put DASHBOARD_TOKEN` (pick a long random
>   string), then `npx wrangler deploy`. After that the dashboard is at `…/stats?key=<token>`.
>   Until done, `/stats` 404s for everyone incl. owner.
> - **[manual, owner] Feedback worker spam guard (#5 from review):** anyone can currently POST
>   to the feedback worker and spam Discord #bug-reports / #suggestion-box. Best fix is a
>   Cloudflare **Rate Limiting rule** (dashboard, not code — e.g. 5 req/min per IP on the
>   feedback route). ~5 clicks. No code change needed.
> - **[manual, owner] Account security:** enable 2FA / hardware key on the **GitHub** account
>   (holds the updater signing secret `TAURI_SIGNING_PRIVATE_KEY`) and the **Cloudflare**
>   account (holds `DISCORD_BOT_TOKEN`). With the code hardened, these accounts are now the only
>   realistic path to a malicious release. Consider branch protection on `main`.
> - **[code] `npm audit fix`:** 4 advisories (svelte moderate, lodash/lodash-es high). ALL are
>   SSR / `_.template` issues — **not exploitable here** (no SSR, no `_.template`), but worth
>   clearing. Do as its own commit so it's easy to revert if a bump misbehaves.
> - **[✅ BUILT 2026-05-29 — pending live test + release] Discord premium re-auth bug**
>   (owner-reported: "need to re-link Discord for premium after some updates"). **ROOT CAUSE:**
>   Discord OAuth access tokens expire after **7 days**; `discord.ts` stored ONLY
>   `data.access_token` and discarded the `refresh_token`. On launch, an expired token →
>   worker `auth_invalid` → token cleared → re-link. It *correlated* with updates only because
>   updates relaunch+recheck; the real trigger is time (~weekly), so multiple users saw it.
>   **FIX SHIPPED IN CODE (reactive + proactive, owner-approved):** new persisted stores
>   `srs_discordRefreshToken` + `srs_discordTokenExpiresAt`; `storeTokenResponse()` captures
>   both on auth + on refresh (Discord rotates refresh tokens — latest always saved).
>   `refreshDiscordToken()` does a silent `grant_type=refresh_token` exchange. `verifyPatronRole`
>   now: (proactive) refreshes when the stored token is within `REFRESH_SKEW_MS` (1 day) of its
>   expiry on the no-explicit-token launch check; (reactive) on `auth_invalid`, tries ONE silent
>   refresh + re-verify before clearing (guarded by `_afterRefresh` against recursion). 4xx on
>   refresh clears the dead refresh token (→ re-link); 5xx/network keeps it for next launch.
>   `disconnectDiscord` clears the new stores. `App.svelte` launch check now calls
>   `verifyPatronRoleWithRetry()` with NO token arg so proactive engages. svelte-check 0/0,
>   33/33 tests. **Worst case is no-regression:** if Discord doesn't return a refresh_token,
>   `refreshDiscordToken` returns null → same re-link as before. ⚠ **NOT live-verified** — needs
>   a real link-and-wait (or a forced-expiry) test on the owner's machine; can't repro on mobile.
>   ⚠ **Existing installs linked before this** have no stored refresh token → they re-link ONCE
>   more, which populates it, then renew seamlessly forever after. Ship in **v1.8.4**.
> - **[release] Version bump → `v1.8.4`:** the app-level fixes (#1, #2, #5) only protect users
>   once shipped. Bundle them + the Discord refresh fix into one `v1.8.4` release next session
>   (package.json, tauri.conf.json, Cargo.toml, Cargo.lock, release-notes.md; tag `v1.8.4`).
>   The hardening commit already on `main` is NOT yet released.

---

## ⚠ SESSION HANDOFF — 2026-05-28 (v1.8.3, READ FIRST)

> **✅ SHIPPED in v1.8.3 (2026-05-28): overlay post-set grade no longer lingers into the next set.**
>
> - **Symptom (owner-reported):** after a ranked set, the overlay's post-set grade stayed up through
>   matchmaking AND the entire first game of the *next* set, instead of clearing when the next set began.
> - **Root cause:** `stats-overlay.ts` `apply()` only dismissed the post-set bridge when `s.opponent`
>   appeared or `POSTSET_MS` (3 min) elapsed. `opponent` is derived from `activeSet`, which the watcher
>   only populates in `handleRankedGame` — i.e. *after the next set's game 1 finishes parsing*. So the
>   dismiss signal didn't exist until that game ended (or the 3-min cap fired mid-game).
> - **Fix (2 parts, no persistence/gating change):**
>   1. `watcher.ts` file-watch handler: on a `.slp` **`create`** event, if `activeSet === null &&
>      lastOverlaySet !== null` (the exact "between sets, grade still showing" window), clear
>      `lastOverlaySet`. A new replay file while no set is live = the next set is starting. The guard
>      pins it to set boundaries, so it never fires for games 2/3 of an ongoing set.
>   2. `stats-overlay.ts` `apply()`: new branch dismisses the bridge when the bridge is showing and the
>      incoming payload no longer carries a completed set (`!s.lastSet`) — the receiving end of the clear.
> - **Behavior:** the 3-min hold stays as the default; a newly-started set now **preempts** it. Caveat:
>   from next-game-start until that game parses, the overlay shows the plain always-on panel (no opponent
>   line yet — opponent scouting still needs the parsed `.slp`); the stale grade is just gone immediately.
> - **Not fully live-verified:** the in-app "Simulate set result" button writes the payload directly and
>   does NOT fire a filesystem `create` event, so it can't reproduce this transition — eyeball on a real
>   ranked session when convenient. Logic + full store→payload→write→poll→apply wiring traced; the in-app
>   preview clears its grade too (consistent). svelte-check 0 errors, 33/33 tests.
>
> Version bumped 1.8.2→1.8.3 (package.json, tauri.conf.json, Cargo.toml, Cargo.lock); release notes updated.
> Released: commit `v1.8.3: …` on main, tagged **`v1.8.3`** → triggers signed CI release.

---

## ⚠ SESSION HANDOFF — 2026-05-28 (v1.8.2)

> **✅ SHIPPED in v1.8.2 (2026-05-28): "Filter by Your Character" + overlay opponent scouting + set-grade polish.**
>
> - **Filter by Your Character (free, all stats tabs):** new tab-level **single-select** control at the top of
>   `MatchupStats.svelte`, `AllTimeStats.svelte`, and `UnrankedStats.svelte`. Default "All Characters"; picking
>   one scopes the **entire tab** (every chart, opponent spotlight, history tables, summary cards) to sets/games
>   you played as that character — for dual mains. Implemented as a `playerCharFilter` rune feeding a `baseSets`
>   (Matchup/AllTime) / `baseGames` (Unranked) derived that all downstream stats read from. The chip row only
>   renders when `myPlayedCharIds.length > 1`. (First attempt was a chart-only hide-toggle — owner clarified they
>   wanted whole-tab single-select; the chart-only version was replaced.)
> - **Overlay opponent line — pre-set scouting (Premium):** the live opponent line now shows the opponent's
>   **tag, rank medal + tier-colored name, MMR, and season W–L (W green / L red)** in addition to the live set
>   score. **No new API call** — `fetchRatingSnapshot(opponentCode)` was already fired on set start; it returns
>   `displayName` / `wins` / `losses` / rating, which the watcher previously discarded. Now captured into new
>   `ActiveSet` fields (`opponent_tag`, `opponent_tier_color`, `opponent_season_wins/losses`) → `StatsOverlayOpponent`
>   → rendered in `stats-overlay.ts` `contextHtml`. Medal lookup reuses `MEDALS[o.tier]` (tier name = medal key).
> - **Set-grade layout (Premium):** the standout stat moved from *under* the grade letter to its **own column to
>   the right** (`gradeEl` + `subEl` are now siblings in `.setblock`), reading `BEST` / `Openings / Kill: S`
>   (colon added per owner). Fills the wide post-set area instead of leaving side gaps.
> - **In-app preview box fix:** the preview iframe (`LiveRankedSession.svelte`) used a fixed `aspect-ratio: 2`
>   tuned for the persistent panel, so transient content (opponent line / post-set grade) was **clipped** by
>   `overflow:hidden`. Now `previewHasTransient` picks a taller ratio (side 1.3 / stacked 1/1.5) when opponent or
>   lastSet is present. **This was the reason opponent info "wasn't showing" — it was rendering but clipped.**
>
> Validated live in the dev app via the **Simulate set result** button + the character filter on real data.
> svelte-check clean, 33/33 tests. Version bumped 1.8.1→1.8.2 (package.json, tauri.conf.json, Cargo.toml,
> Cargo.lock); release notes + CLAUDE.md updated. **Release steps remaining: tag `v1.8.2` + push** (triggers CI).

---

## ⚠ SESSION HANDOFF — 2026-05-27 (v1.8.1, READ FIRST)

> **✅ SHIPPED in v1.8.1 (2026-05-27): overlay fixes + comeback/lead grading redesign.**
>
> - **Overlay set-grade latency fixed:** `watcher.ts handleRankedGame` set `lastOverlaySet` (the
>   overlay payload) *after* `await saveSetGrade(...)`, so the overlay lagged the in-app grade by the
>   DB-write time (~seconds). Now `lastSetGrade` / `lastOverlaySet` / `activeSet` all update
>   synchronously and the DB save runs last.
> - **Overlay MMR delta** is now signed (+/−) via `fmtDelta` in `stats-overlay.ts` (was arrow + abs).
> - **Standout stat under the set grade:** new `featuredCategory(grade, won)` in `grading.ts` →
>   `{label, letter, stat}`; threaded through `OverlaySetResult` (`subStatLabel/subStatLetter`) and
>   rendered in `stats-overlay.ts`. Owner chose to show **only the stat** (`BEST/WORST <stat> <letter>`),
>   not the category name.
> - **Overlay PREVIEW post-set fix:** `overlayPreviewHtml` baked a single `apply()` whose first-call
>   guard marked the set "already shown", so the post-set block never rendered in the in-app preview.
>   It now sets `postSet` directly. ⚠ **OBS caches `stats.html`** — changing the overlay's look needs an
>   OBS Browser-Source refresh; only the state JS is polled.
> - **Forfeit/quit-out grading:** an opponent LRAS now completes + grades the set when ≥1 full game was
>   played (`watcher.ts` completion check + `GradeHistory` `completedSets` filter + `LiveRankedSession`
>   helpers). New shared `setResultFromGames()` in `store.ts`: a forfeit is a win if the opponent quit /
>   loss if you quit, regardless of game count (fixes a 1-1 forfeit mislabeled a loss). The set-comeback
>   **+4 bonus is suppressed on a forfeit win** via `gradeSet(..., forfeitWin)`.
> - **Comeback & Lead Maintenance REDESIGNED** (`slp_parser.ts`): dropped the max-drawdown/climb
>   `*_FULL_STOCKS` model for an **end-position** model. lead = `leadCbPos(troughAfterUp)`, comeback =
>   `leadCbPos(highAfterDown)` — shared mirrored curve `leadCbPos` (margin → 0–1: ≥+2→1.0, +1→.70,
>   0→.45, −1→.30, −2→.13, ≤−3→0) × win/loss mult, ± `LEAD_CB_NUDGE=0.04`/stock size nudge (bigger lead
>   blown docks lead; deeper deficit overcome lifts comeback). Still **absolute — no rescan.** Tuning
>   visualizer kept at `scripts/lead_grade_matrix.py`. `GRADING_LOGIC_VERSION` bumped **2→4** → all grades
>   flag stale (Regrade refreshes). `STAT_DESCRIPTIONS` for both rewritten.
>
> Validated the lead/comeback math on a real set (mono, FUN#941): lead F→C, set comeback D. Released:
> branch → main, tagged **`v1.8.1`** → signed CI release. svelte-check clean, 33/33 tests.

---

## ⚠ SESSION HANDOFF — 2026-05-27 (v1.8.0)

> **✅ SHIPPED in v1.8.0 (2026-05-27): Live Stats Overlay — the unified OBS overlay.** The v1.7.0 standalone
> set-grade overlay is **retired and folded into this one** — `src/lib/overlay.ts` deleted, its card +
> `overlayEnabled`/`overlayExpanded` stores + the watcher's `writeOverlayState` call all removed. New
> `src/lib/stats-overlay.ts` writes `stats.html` + `stats-state.js` to `<appDataDir>/stream-overlay/`;
> `stats.html` polls the state file (500ms) and renders an **always-on panel**. **Side-by-side** (default):
> left = medal + a **centered** identity column (tag, rank, global placement `#rank [REGION]`, season W/L);
> right = a **Today's stats** block holding the **MMR + persistent session delta (▲/▼) + today's (live-session)
> W/L**. **Stacked** layout also available (toggle persisted as `statsOverlayLayout`). During a set the panel
> shows the **opponent line**; on completion a **post-set area** holds the set result + grade (spins in,
> labelled "SET GRADE") **until the next ranked set starts or 3 min** (`POSTSET_MS`) — the MMR climb shows live
> in the Today's block as the rating refetches. The in-app **preview is the real overlay in an iframe**
> (`overlayPreviewHtml` — baked payload, no poll) so it can't drift; a **Simulate set result** button drives a
> fake set via `statsOverlayPreview` (app-level write override in `App.svelte`). Premium-gated (`isPremium &&
> statsOverlayEnabled`). `displayName` now captured from the Slippi API (`api.ts`). Watcher `FILE_SETTLE_MS`
> trimmed 1500→800ms to cut set-end→grade latency.
>
> **Rank fix (app-wide, same release):** `getRankTier` in `parser.ts` now uses Slippi Launcher's current
> rating thresholds (ours were stale by 30–50 pts in Plat/Diamond/Master) AND implements **Grandmaster =
> Master 1+ rating AND a global leaderboard placement** (was rating-only, so GM never showed). Signature is
> `getRankTier(rating, hasPlacement)`; callers (overlay payload, Header, Sidebar, watcher opponents) pass
> `global_rank > 0`. Region codes shortened for the overlay (NORTH_AMERICA → NA, etc.; `regionLabel` in store.ts).
>
> **Rank medals:** 20 official Slippi rank SVGs from project-slippi/slippi-launcher (**GPL-3.0**) in
> `src/assets/ranks/` (+ `NOTICE`), inlined into `stats.html` via a `?raw` glob (`src/lib/rank-medals.ts`).
> Owner **accepted the IP risk** of using Slippi's medal art in this closed-source app. A `.gitignore`
> `assets/` rule was negated (`!src/assets/`) so they're tracked (else they wouldn't sync to other machines/CI).
>
> **Version bumped 1.7.0→1.8.0** (package.json, tauri.conf.json, Cargo.toml, Cargo.lock); v1.8.0 release notes
> + CLAUDE.md updated. svelte-check clean, 23/23 tests, build OK. **Validated live** (real ranked set +
> Simulate tool). Released: developed on branch `live-stats-overlay`, merged to `main`, tagged **`v1.8.0`** →
> triggers the signed CI release (Windows + macOS auto-update).

---

## ⚠ SESSION HANDOFF — 2026-05-26 (READ FIRST)

> **✅ SHIPPED in v1.6.2 (2026-05-25): Comeback & Lead Maintenance redesign.** Both stats
> were rebuilt from binary (were-you-behind/ahead → did-you-win = 1/0, percentile-scored
> against a degenerate distribution) to a **continuous stock-margin "degree" on an absolute
> curve** — no benchmark, no HF rescan (see `docs/adr/0001`). Comeback = stocks climbed back
> from the deepest sub-zero trough; Lead = stocks held vs. given back from the peak; both ×
> a win multiplier. Added a **set-level modifier** layered on the unchanged +5 win bonus,
> keyed on (Game 1 result × set result): lost-G1→won-set **+4** (comeback), won-G1→won-set
> **+2** (closeout), won-G1→lost-set **−4** (blown lead). New `GRADING_LOGIC_VERSION` is
> folded into the stored stale token (`GRADE_VERSION = <bench>+L<n>`) so logic-only changes
> force a regrade with **no DB migration**. Tuning constants — `COMEBACK_FULL_STOCKS` /
> `LEAD_FULL_STOCKS` = 2 and `CB_LOSS_MULT` = 0.75 (slp_parser.ts), `SET_*` bonuses
> (grading.ts) — are first-guesses, accepted as-is; revisit if grades feel off. Files:
> slp_parser.ts, grading.ts, watcher.ts, GradeHistory.svelte, SetGradeDisplay.svelte,
> grading.test.ts (23/23 pass, svelte-check clean).
>
> **Still durable from v1.6.1:** the prod app and `npm run tauri dev` **share one SQLite DB**
> (`com.slippi.rankedstats`) — a regrade in one overwrites the other; never trust a
> prod-vs-dev side-by-side. **Known gap:** the set modifier is NOT persisted (only its effect
> on `overall_score` is), so a reloaded-from-DB grade can't show the comeback/closeout/blown-lead
> chip until it's regraded in-session. Persisting it would need a new DB column (persistence
> change → discuss first).
>
> **✅ SHIPPING in v1.7.0 (2026-05-26): OBS stream overlay.** Server-less local-file transport:
> `src/lib/overlay.ts` writes `overlay.html` + `state.js` to `<appDataDir>/stream-overlay/` (created
> via `mkdir` on enable; fs capability scoped `$APPDATA/**` so it works for installed users, not just
> dev — verified this session). `watcher.ts` fires `writeOverlayState(grade.letter)` on completed ranked
> sets when `isPremium && overlayEnabled`. Premium "Stream Overlay" card in `LiveRankedSession.svelte`
> (toggle, dynamic path + copy, Test button, grade-chip preview); state persisted in `store.ts`. Animation:
> **spin-in / spin-out**, **25 s hold** (`HOLD_MS`), letter **62vh** + caption **6vh** so the 1.1× scale +
> rotation stays inside `overflow:hidden`. **Auto-trigger validated** earlier via replay-injection of a real
> completed set (CHAB#749, lost-G1 2–1 comeback → graded A → fired → animated in OBS). The owner **opted to
> skip a fresh live ranked-set test** (2026-05-26) and release on the validated state. Version **bumped
> 1.6.2→1.7.0** (package.json, tauri.conf.json, Cargo.toml, Cargo.lock), **v1.7.0 release notes written**,
> svelte-check clean, 23/23 tests pass. Overlay recorded as a shipped Premium feature in `CLAUDE.md`.
> **Release steps remaining: merge `obs-overlay`→main, push, tag `v1.7.0`** (triggers the signed CI release).

This file is the cross-machine handoff doc. The banner above records the last shipped
state; everything below is durable reference — active backlog (see NEXT UP),
shipped-feature architecture, the baseline pipeline, the release process, and the
cross-machine workflow.

---

## ✅ DONE — Comeback Rate & Lead Maintenance redesign (shipped v1.6.2, 2026-05-25)

> **Built, tested, and shipped 2026-05-25.** The remaining open questions were resolved this
> session (see RESOLVED at the bottom of this section) and the redesign went out in v1.6.2 —
> the SESSION HANDOFF banner above has the as-shipped summary. The LOCKED design rationale
> below is retained as reference.

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

**RESOLVED (all shipped in v1.6.2):**
- **Set Comeback / closeout / blown-lead bonus** = **+4 / +2 / −4**, keyed on (Game 1 result ×
  set result), layered on top of the unchanged +5 win bonus (a difficulty premium on the win,
  not a re-payment for it). Clean mirror: comeback +4 ↔ blown-lead −4. `SET_*` consts in
  grading.ts; the composite is now floored at 0 as well as capped at 100.
- **Absolute curve (per-game degree):** the parser emits a 0–1 degree =
  `min(stocks / FULL_STOCKS, 1) × (win ? 1 : CB_LOSS_MULT)`; grading maps degree × 100 with no
  benchmark lookup. `COMEBACK_FULL_STOCKS`/`LEAD_FULL_STOCKS` = 2, `CB_LOSS_MULT` = 0.75
  (first-guess constants, accepted as-is — easy to retune in slp_parser.ts).
- **Blowing a lead — penalize or just fail to reward?** Per-game = **fail to reward** (degree
  floors at 0, can't drag the category negative); the active **penalty** lives at the *set*
  level (−4 blown lead). No double-dip.
- **Display:** comeback/lead show a 0–100 **degree** (no % sign), the letter, and a set-modifier
  chip on the overall card; tooltip notes the score is absolute, not benchmarked.
- **Stale handling:** `GRADING_LOGIC_VERSION` is folded into `GRADE_VERSION` (the token stored
  per grade and compared at the 5 stale sites). Bumping it flags every existing grade stale →
  the existing "Regrade stale (N)" flow refreshes them. No benchmark-version change, no DB
  migration. **Known gap:** the set modifier itself isn't persisted (see handoff banner).

**Future enhancement (banked):** matchup-aware comeback/lead — score the continuous degree by
percentile per matchup. Deferred per ADR 0001 (needs the rescan + Python parser parity).
Additive later; nothing built now is wasted.

Shipped in v1.6.2. The OBS / stream overlay below is the next focus again.

---

## ▶ NEXT UP — OBS / Stream Overlay (BUILT + animated on `obs-overlay`; final cross-machine test → v1.7.0 — 2026-05-25)

> **AS BUILT (branch `obs-overlay`, not on main, target v1.7.0 — version bumped + notes written):**
> server-less local file, exactly as designed below. New `src/lib/overlay.ts` writes `overlay.html`
> + `state.js` to `<appDataDir>/stream-overlay/` via `@tauri-apps/plugin-fs` (`fs:allow-write-text-file`
> added to capabilities, scoped `$APPDATA/**`). `watcher.ts` calls `writeOverlayState(grade.letter)`
> on completed ranked sets when `isPremium && overlayEnabled`. Premium "Stream Overlay" card
> in `LiveRankedSession.svelte` (toggle, collapsible, dynamic path + copy, **Test button**,
> grade-chip preview); `overlayEnabled`/`overlayExpanded` persisted in `store.ts`. **Animation
> (finalized):** `spin-in` keyframes (720ms, rotate-and-scale from 0) → hold `HOLD_MS = 25000` →
> `spin-out` (620ms); `#letter` is `62vh` and `#caption` `6vh` so the entrance's 1.1× scale +
> rotation stays inside the viewport (at 72vh the rotated diagonal clipped against `overflow:hidden`).
> `overlay.ts` is the single source of truth (no committed `overlay-prototype/`). **Auto-trigger
> validated** this session via replay-injection of a real completed set (method in the SESSION HANDOFF
> banner) — watcher graded + fired + animated in OBS. svelte-check clean, 23/23 tests pass.
> **Remaining before release: one final real ranked-set test on the second machine, then merge
> `obs-overlay`→main, push, tag `v1.7.0`** (and record the shipped overlay in `CLAUDE.md`).

**v1 scope (DECIDED 2026-05-25): the set's overall LETTER GRADE only, in its grade
color, revealed with a short entrance animation the moment a ranked set completes.**
Score, category grades, and opponent/W–L are **deferred** — the fuller multi-element
card stays banked below under "Streamer Overlay" / "Set-grade overlay widget".
Deliberately minimal: one animated colored letter, nothing else.

**Usage model (user, 2026-05-25):** the streamer has SRS running (watcher active) on a
second monitor or behind Melee; they finish a ranked set mid-stream; the OBS Browser
Source pops the just-earned letter onto the stream with a little animation.

**Transport: DECIDED — server-less local FILE → OBS Browser Source** (revised 2026-05-25;
the local-HTTP-server idea was dropped). Rationale: a listening server adds a socket, a
port, and a likely Windows Firewall / AV prompt — unwanted friction while gaming +
streaming (its actual CPU cost would've been ~nil, but the surface area isn't worth it).
The plain OBS Text-source option was also rejected: static color (a pink S and a red F
look identical) and manual-refresh only. So: the app **writes a small local state file**
on ranked-set completion, and OBS loads a local **`overlay.html`** as a **Browser Source**
(Browser Sources support transparency natively → clear background).

**How it updates without a server:** the app writes `{ letter, setId }` to a state file in
its app-data folder each time a ranked set completes; `overlay.html` watches that file
client-side and, when `setId` changes, animates the colored letter in, holds, then fades.
The letter is **transient**, so between sets the page is empty/transparent — nothing to
flicker. ⚠ **Risk to validate FIRST (prototype before anything else):** OBS's embedded
browser (CEF) restricts `file://` pages from cleanly re-reading sibling files, so the
file-watch mechanism — timed full reload + a `localStorage` setId-guard, vs. a re-injected
`<script src>`, vs. `fetch` with the right flags — needs a real OBS test to confirm a
written change reliably re-triggers the animation. This is the make-or-break unknown.

**The page (v1):** one centered letter on a transparent background, colored via the SAME
palette as the app — `GRADE_COLORS` / `gradeColor()` in `grading.ts` (S = `#FF1493` hot
pink, etc.). CSS entrance animation on a new `setId`. Source = the watcher's
`lastSetGrade.letter`, already computed on ranked-set completion (expose a per-set id so
the page can tell sets apart). (Verified 2026-05-25: no overlay code exists yet — clean
rebuild; the earlier prototype was never committed.)

**In-app:** a premium-only "Stream Overlay" card in `LiveRankedSession.svelte` — single
on/off toggle, collapsible-when-on, an in-app **preview** of the colored letter, and the
local file path + instructions for adding it as an OBS Browser Source. Persist
`overlayEnabled` (+ `overlayExpanded`) in `store.ts`. **Premium-gated; fires ONLY on
completed ranked sets** (not single games, not unranked/direct).

**Build order:** (1) prototype the file-watch → OBS reliability in isolation on the dev
machine; (2) only then wire the watcher to write the state file + build the in-app card.
**Test fully in a dev instance before any push** (user, 2026-05-25).

**Still to decide (sub-details, not blockers):**
- After the entrance animation: auto-hide (fade out after ~10–20 s) or hold until the next
  set? (Leaning: hold briefly, then fade — keeps the stream uncluttered.)
- Exact file location + format, and whether `overlay.html` ships as a bundled asset or is
  written by the app alongside the state file.
- Whether toggling the overlay off stops the app from writing the state file.

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
