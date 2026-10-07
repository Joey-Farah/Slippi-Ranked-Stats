---
status: proposal — NOT implemented, needs Joey's decision first
date: 2026-10-07
---

# Per-game grade persistence (what the Unranked side of the Grading tab is waiting on)

The Ranked / Unranked split in the Grading tab is built: the Ranked sub-tab is the existing
view, the Unranked sub-tab is an honest placeholder. The placeholder is there because the
unranked view has no data it can show without re-reading thousands of replays, and `CLAUDE.md`
says grade-history persistence gets discussed before it gets built. This is that discussion.

**The structural problem:** `games` stores metadata only (13 columns, no stats). Per-game stats
are re-derived from the `.slp` on every grade. Ranked gets away with it because finished grades
persist in `set_grades`; nothing persists for a game.

---

## Measured cost — the numbers the design has to survive

| | value | how it was measured |
|---|---|---|
| unranked + direct games in `JOEY_870.db` | **15,585** (10,666 unranked + 4,919 direct) | `SELECT match_type, COUNT(*) … GROUP BY match_type` on a read-only copy of the live DB |
| of those, metadata-eligible to grade | **15,061** | the same query plus the `isGradeCandidate` gates (legal stage, quit-out ≥ 45 s) |
| distinct non-ranked `match_id`s | 2,657 | `COUNT(DISTINCT match_id)` — i.e. ~5.9 games per "match", which is why a game is the only unit here |
| read + parse + grade, per game | **9.0 ms** (3.1 read / 5.6 parse / 0.06 grade), median 7.3, p90 12.9 | 240 of Joey's real unranked/direct replays, two disjoint random samples of 120, run through the app's own `parseSlpBytes` + `gradeGame` under node 24 |
| mean replay size | 3.3 MB / 8,800 frames | same run |
| **re-score only**, from already-parsed stats | **0.009 ms/game → 140 ms for all 15,061** | 15,061 `gradeGame` calls over cached parser output |
| storage for one stats row | **467 bytes** incl. 2 indexes → **6.7 MB** for 15,061 | built the proposed table in SQLite, inserted 15,061 rows, `VACUUM`, measured the file |
| storage if the rendered breakdown is stored instead | **~31.5 MB** for 15,061 | `AVG(LENGTH(breakdown_json))` over the 1,506 real rows in `set_grades` = 2,095 bytes |

**⚠ The 0.3 s/game figure in `dev_notes` is not the parser.** Parse + grade is 9 ms; grading
alone is 0.009 ms. The ~0.3 s comes from the in-app regrade (`dev_notes`: ~20 min for 1,346
sets ≈ 3,460 games = 0.35 s/game) — **a figure I did not measure myself and could not, without
running the Tauri app.** So there is a ~30× gap between what the work costs and what the app
pays for it, and it is somewhere between the WebView and `plugin-fs`/`plugin-sql`, not in the
parser or the scorer. Whoever builds this should put a `console.time` around read / parse / DB
write in the real loop **before** optimising anything; one run will say whether the 75 minutes
below is `readFile` IPC or 15,061 SQL round-trips.

**What that means for the batch:** at the in-app 0.3 s/game, 15,061 games is **~75 minutes**
and ~50 GB of reads. The CPU floor is 2.3 minutes. Either way it is a one-off background job
with progress and not something a tab open can do — which is the premise this is built on.

---

## Options

### Option 1 — persist the rendered grade per game (a `set_grades` twin)

A `game_grades` table shaped like `set_grades`: letters, the three category scores,
`breakdown_json`, one `baseline_version` token. Smallest conceptual leap; hydration is a copy
of `rowToEntry`.

Rejected. Two reasons, both measured above:

- **~31.5 MB of JSON** for Joey's corpus, 5× the stats-only table, to store numbers that can be
  recomputed in 140 ms.
- The stored token is the combined `GRADE_VERSION`, so **a benchmark-data change invalidates
  every row** and forces a full re-parse even though no replay changed. That is not a rare case:
  v1.8.11 moved `BENCHMARKS_VERSION` with `GRADING_LOGIC_VERSION` sitting still at 6, and the
  v1.10.0 rescan did the same at 8 (verified in git: `BENCHMARKS_VERSION` goes
  2026-07-14 → 2026-10-06 across `ac7cbd9` → `807c296` with the logic version unchanged). On
  this table a benchmark swap costs 75 minutes of re-reading 50 GB to arrive at numbers
  derivable from data already on disk.

### Option 2 — persist the per-game STATS, derive the grade (recommended)

One row per game holding the ~20 parser stat values plus the few metadata fields grading needs.
The grade is computed from the row, not stored (with optional cached score columns, below).

- A benchmarks change becomes a **0.14 s recompute**, no disk, no progress bar.
- A scoring-logic change (weights, curves, the win bonus) likewise.
- Only a change to the *parser's* stat math needs the 75-minute re-parse.
- 6.7 MB.
- **This is already validated against real data.** The v1.10.0 grade-impact harness did exactly
  this — held per-game stat values fixed, swapped only the benchmarks — and reproduced all
  16,456 stored per-stat scores and all 968 category scores exactly before being trusted.
- It fixes the ranked side as a side effect: the same rows would let `set_grades` regrade
  without re-parsing, retiring the 20-minute regrade (see open question 2).

Cost: grade letter and score are no longer SQL-queryable, so list filtering/sorting happens in
memory. At 140 ms for the whole corpus that is a non-issue, but for cheap sorting the table can
also cache `overall_score` / `overall_letter` / `scored_version`, refreshed by the same fast
re-score pass. Cached columns, never the source of truth.

### Option 3 — don't persist; aggregate only

Store a per-game overall score and nothing else, or store nothing and show only what the
watcher graded live. Cheapest to build, and it does not do the job: no breakdown for a
historical friendly, and any logic change is unapplied to history forever. It also re-creates
the thing this view exists to escape — the Live Session tab already shows live per-game grades.

**Recommendation: Option 2**, with cached score columns.

---

## Schema

```sql
CREATE TABLE IF NOT EXISTS game_stats (
  filename        TEXT PRIMARY KEY,   -- basename; see the trap below. NOT filepath.
  match_id        TEXT NOT NULL,
  game_timestamp  TEXT NOT NULL,
  match_type      TEXT NOT NULL,      -- ranked | unranked | direct
  player_char     TEXT NOT NULL,      -- resolved name, as set_grades stores it
  opponent_char   TEXT NOT NULL,
  opponent_code   TEXT NOT NULL,
  result          TEXT NOT NULL,      -- win | loss | lras_win | lras_loss
  stage_id        INTEGER NOT NULL,
  duration_frames INTEGER NOT NULL,
  kills           INTEGER,
  deaths          INTEGER,
  stats_version   TEXT NOT NULL,      -- parser generation these numbers came from
  parsed_at       TEXT NOT NULL,
  -- the 20 parser stats, one REAL column each, nullable (a stat can genuinely be null):
  openings_per_kill REAL, damage_per_opening REAL, neutral_win_ratio REAL,
  counter_hit_rate REAL, inputs_per_minute REAL, l_cancel_ratio REAL,
  avg_kill_percent REAL, avg_death_percent REAL, defensive_option_rate REAL,
  opening_conversion_rate REAL, stage_control_ratio REAL, lead_maintenance_rate REAL,
  tech_chase_rate REAL, edgeguard_success_rate REAL, hit_advantage_rate REAL,
  recovery_success_rate REAL, avg_stock_duration REAL, respawn_defense_rate REAL,
  comeback_rate REAL, wavedash_miss_rate REAL,
  -- cached, derived, safe to throw away:
  overall_score   REAL,
  overall_letter  TEXT,
  scored_version  TEXT
);
CREATE INDEX IF NOT EXISTS idx_game_stats_match ON game_stats (match_id);
CREATE INDEX IF NOT EXISTS idx_game_stats_ts    ON game_stats (game_timestamp);
```

Columns, not a JSON blob: the stat set is fixed and small, every one of them is something you
will want to average or filter on, and a blob would mean re-parsing JSON for 15k rows on every
pass. Nullable REALs because the parser legitimately emits null (`comeback_rate` when the player
was never behind, etc.) — ⚠ `NULL` here means "not applicable", never "not computed"; "not
computed" is the absence of the row.

**Store the stats whatever the mode.** Writing ranked rows too costs ~1.6 MB and is what makes
the ranked regrade free later. The *view* splits by mode; the storage shouldn't.

## Which database — the per-connect-code one (`<CODE>.db`), created in `initSchema`

`db.ts` has three homes and the choice is not stylistic:

- **`scanned.db`** is shared because a scan mark is about a **file**, and every code scanning the
  same folder has already read it.
- **`notes.db`** is shared because a note is about a **person** — linked codes must see the same
  notes, and switching the primary code must not strand them.
- **`<CODE>.db`** holds `games` and `set_grades`.

A per-game stats row is about **one row of `games`**: it is keyed by that row's `filename`,
carries that game's result, and is meaningless without it. It belongs where `games` lives, as
`set_grades` does. A sidecar would also have to answer "whose game was this?" at every query, in
exchange for nothing. The hydration loop that already walks `effectiveCodes` and dedupes works
unchanged.

Mirror `set_grades`' double-write into the primary DB for linked codes, for the same reason it
does it (grades survive a connect-code reconfiguration). It doubles 6.7 MB, which is not a cost.

## Invalidation — split the one version token into two

Today `GRADE_VERSION = ${BENCHMARKS_VERSION}+L${GRADING_LOGIC_VERSION}` is a single opaque
string, which is correct for a stored *grade* and far too coarse for stored *stats*: it cannot
distinguish "the numbers on disk are wrong" from "the numbers are fine, the scoring moved".

Proposed, and this is the decision that decides whether future grading releases cost 75 minutes
or 0.14 s:

| stored column | compared against | on mismatch |
|---|---|---|
| `stats_version` | `PARSER_STATS_VERSION` — new, bumped only when the parser's stat math changes | **re-parse** the replay (75 min for the corpus) |
| `scored_version` | `BENCHMARKS_VERSION` + `SCORING_LOGIC_VERSION` | **re-score** from the stored row (140 ms for the corpus) |

`GRADING_LOGIC_VERSION` today conflates the two. Looking back over its own history: v7
(lead/comeback) and v8 (parser parity fixes) were parser-math bumps that genuinely needed a
re-parse; v5's saturated-ceiling remap, the win bonus and the category weights are scoring-only
and never did. Put `PARSER_STATS_VERSION` in `parser.ts` beside `PARSER_CAPABILITY_VERSION`,
which is the same shape of idea (a stored generation number that triggers a one-off re-read).

⚠ **The failure mode of splitting is silent**: a parser change filed as scoring-only leaves
stale stats in place and nothing says so. Mitigate by making `PARSER_STATS_VERSION` the one you
must consciously decide about — if in doubt, bump it; the cost is time, while the cost of not
bumping it is wrong grades that look right. `scripts/test_parity.py` is the existing guard on
parser stat changes and should stay green either way.

## The batch job

- **Trigger: an explicit button only**, on the Unranked sub-tab (the disabled
  `Grade N Games` button already there). Never on tab open, never on launch — ⚠ the v1.8.8
  startup auto-scan is already running `scanDirectory` in the background at launch, and two jobs
  reading replays through the same IPC channel would fight each other.
- **Queue:** games with no `game_stats` row at the current `stats_version`, passed through
  `isGradeCandidate` (`src/lib/grade-queue.ts`, built with the Part A UI), newest first so the
  most recent play is what fills in first.
  ⚠ **Build the queue from the database, not from `filteredGames`** — those stores apply the
  sidebar Date Range, so a user on "Last 30 Days" would grade 30 days of games and be told they
  were done.
- **Progress:** its own pair of stores (`gameGradeBusy` / `gameGradeProgress {current,total}`),
  not the `gradeHistoryBusy` pair — a ranked set regrade and a game batch must not drive the
  same bar. Update the store once per chunk, not once per game: 15,061 store writes is 15,061
  re-renders of a list that is also 15,061 rows long.
- **Cancellable:** a module-level flag plus `cancelGameGrading()`, exactly as `cancelScan()` in
  `parser.ts` works.
- **Resumable, and crash-safe for free:** the queue is *defined* as the absence of a
  current-version row, so there is no checkpoint to keep and nothing to reconcile. Commit in
  chunks of 500 (the chunk size `markFilesScanned` already uses) and a kill mid-run costs at
  most 500 games of work. Closing the app mid-run leaves a partial corpus that is correct as far
  as it goes, and the button simply shows a smaller number next time.
- ⚠ **Resolve every path through `src/lib/replay-index.ts`** (`resolveReplayPath` +
  `updateGameFilepath`), the way `gradeAllSets` does: build the basename index lazily, at most
  once per run, only after a path actually fails, and persist each correction. `games.filepath`
  is absolute and captured at scan time; a folder reorganisation already destroyed 211 graded
  sets once. A 15,061-game job that gave up per missing file would silently produce nothing.
  And ⚠ don't wrap the directory walk in a bare `catch {}` — that is why the first version of
  that fix repaired nothing.

## Traps specific to this table

- ⚠ **Key on `filename`, never `filepath`.** `filename` is the basename and is `UNIQUE` in
  `games` (verified: 0 duplicates across 17,832 rows); `filepath` moves. Consequence of the
  existing `UNIQUE(filename)`, inherited rather than introduced here: two replays with the same
  basename in different folders can never both have a game row anyway (`insertGame` is
  `INSERT OR IGNORE`).
- ⚠ **A stored row is not a gradeable game.** `avg_stock_duration === null` means the replay held
  no frames at all, and that is only knowable after parsing — which is why `grade-queue.ts`
  counts *candidates*. Store the row anyway (with the nulls) so the job never re-reads that file
  hunting for stats it does not have; filter it out at grade time.
- Non-legal stages and short quit-outs are excluded by `isGradeCandidate` and so never get a
  row. If that rule is ever loosened, the newly-eligible files are in the same position as the
  v1.8.12 direct replays were — already marked, never revisited. `stats_version` is the lever
  that forces a revisit.

## Open questions — Joey's call

1. **Split `GRADING_LOGIC_VERSION` into `PARSER_STATS_VERSION` + `SCORING_LOGIC_VERSION`?**
   This is the one that matters. With the split, a benchmarks-only release (v1.8.11, and the
   v1.10.0 rescan) costs 0.14 s instead of 75 minutes; without it, every grading release
   re-reads 50 GB. The price is one more constant to classify changes against, and a
   misclassification is silent.
2. **Scope: unranked + direct only, or backfill ranked per-game stats in the same job?** Ranked
   adds ~3,526 games (~+20 min on the current path, +1.6 MB) and in exchange the ranked regrade
   stops re-parsing anything — the 20-minute regrade becomes sub-second for benchmark and
   scoring changes. Tempting, and it widens the blast radius of a feature whose first release
   should probably be boring.
3. **Gating.** Set Grading is Premium, Notes is free, and the Grading tab is currently *mixed* —
   free users see letters and the distribution, `$isPremium` gates the breakdown and the By
   Matchup view. Inheriting that mixed gating unchanged is the obvious default and the Part A
   work does exactly that, but per `CLAUDE.md` the gating of a new grade surface is yours to
   confirm, not mine to assume.

Not folded in here, but they want to ride along with whatever regrade this forces rather than
cause their own: **tie-aware scoring** (still undecided) and **quit-out games still being
averaged into SET grades** (measured: 12/1506 sets, mean +3.94 pts, 4 letter changes).
