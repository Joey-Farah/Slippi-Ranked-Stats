# `set_grades` Persistence — Proposal

**Status:** proposal, not implemented. Per `CLAUDE.md`, grade-history persistence needs discussion before any code lands. This is the artifact to react to.

**Goal:** persist set grades so the Set Grades tab doesn't have to re-parse 100 `.slp` files every time the app opens, and so grade history becomes durable record-keeping rather than an in-memory derived view.

---

## Schema

New table in the per-connect-code SQLite DB (same DB that holds `sets`/`games`).

```sql
CREATE TABLE set_grades (
  match_id          TEXT PRIMARY KEY,       -- natural key; matches sets.match_id
  generated_at      TEXT NOT NULL,          -- ISO8601 when grading ran
  baseline_version  TEXT NOT NULL,          -- see "Baseline versioning" below
  player_char       TEXT NOT NULL,
  opponent_char     TEXT NOT NULL,
  baseline_source   TEXT NOT NULL,          -- 'matchup' | 'character' | 'overall'
  set_result        TEXT NOT NULL,          -- 'win' | 'loss'
  wins              INTEGER NOT NULL,
  losses            INTEGER NOT NULL,

  overall_letter    TEXT NOT NULL,          -- 'S'..'F'
  overall_score     REAL NOT NULL,          -- 0..100

  neutral_score     REAL,
  neutral_letter    TEXT,
  punish_score      REAL,
  punish_letter     TEXT,
  defense_score     REAL,
  defense_letter    TEXT,
  execution_score   REAL,
  execution_letter  TEXT,

  breakdown_json    TEXT NOT NULL           -- JSON.stringify(SetGrade.breakdown), all 18 stats
);

CREATE INDEX idx_set_grades_generated_at ON set_grades(generated_at DESC);
CREATE INDEX idx_set_grades_overall_score ON set_grades(overall_score);
```

**Why this shape:**
- `match_id` as PK: exact 1:1 with completed sets; re-grading overwrites in place via `INSERT OR REPLACE`.
- Category scores/letters as columns: used for filtering and sorting, cheap to query.
- Per-stat breakdown as a single JSON blob: 18 stats × value/score/grade would be 54 columns, and the UI only hydrates it when a row is expanded. JSON keeps the schema small and makes future stat additions a non-migration.

---

## Baseline versioning

Problem: when `grade-benchmarks.ts` regenerates (e.g. after the current rescan), every stored grade computed against the old version is stale.

**Proposed:** emit a `BENCHMARKS_VERSION` constant in `src/lib/grade-benchmarks.ts`, set by `regen_benchmarks.py` from `grade_baselines.json.generated_at` (e.g. `"2026-04-17T12:34:56Z"`). Store that string in `set_grades.baseline_version` on insert.

**UI behavior when version mismatches:**
- Show a subtle "stale — regrade to update" indicator on the row.
- Distribution summary and averages use stored scores (it's fine — users compare their history against themselves).
- "Regrade all" button only re-parses mismatched rows by default; a "Force regrade" sub-option keeps today's behavior.

---

## Insertion points

Two write paths, both already in place as compute points:

1. **`src/lib/watcher.ts` `handleRankedGame`** — after the live `gradeSet()` call (line that assigns `lastSetGrade`), also fire `save_set_grade(...)`. Only when a real grade returns, never on errors.
2. **`src/components/tabs/GradeHistory.svelte` `gradeAllSets()`** — after building `entry` with a successful grade, also fire `save_set_grade(...)`. Covers the backfill path.

Both call the same Tauri command; no client-side duplication logic because `match_id` PK handles overwrites.

---

## Reads / hydration

Currently `$gradeHistory` is a Svelte store that starts empty every app launch and fills as the user presses "Grade". After persistence:

- On app mount (or first Grades tab open), call `get_all_set_grades()` and hydrate the store.
- The "Grade New Sets (N)" button keeps its existing semantics — `N = completedSets.filter(s => !gradedIds.has(s.match_id)).length` — which now reflects durable state.
- If a row exists with stale `baseline_version`, it counts as graded (shown in history) but is eligible for regrade.

---

## Rust / Tauri side

- **Migration**: add a new migration file that creates `set_grades`. The project already has a migration runner (used for the `sets`/`games` tables) — reuse it.
- **Commands**:
  - `save_set_grade(payload: SetGradePayload) -> Result<(), Error>` — `INSERT OR REPLACE`
  - `get_all_set_grades() -> Result<Vec<SetGradePayload>, Error>` — ordered by `generated_at DESC`
  - `delete_set_grade(match_id: String) -> Result<(), Error>` — for "Regrade all" flow
- **Payload type** mirrors the schema; `breakdown_json` travels as a single string. Client-side we `JSON.parse` on read.

---

## Free vs premium

Data is identical regardless of tier — the free/premium split is purely a render decision in `SetGradeDisplay.svelte` (`detailed={$isPremium}`). Storing the full breakdown for free users is fine and future-proofs the case where a user upgrades and wants to retroactively see full details for past sets without re-parsing.

---

## Open questions

1. **Per-set vs per-game rows?** Proposal is per-set because that's what's displayed and graded. Per-game would be useful for analytics later but doubles row count and we don't use it today. → **Decide: per-set, accept the tradeoff.**
2. **Persist errors?** When grading fails (`entry.error` set), should we write a row? Proposal: no. Errors are typically "file unreadable" which can resolve later, and a failure row would block retries. → **Decide: don't persist errors.**
3. **Cross-machine export?** Each connect-code DB is per-machine. Do we want to sync grades across Joey's two machines? Out of scope for v1 — defer. → **Decide: defer.**
4. **Live Session grade**: the live-session grade card shows the most recent grade. Does that read from the store or the DB? Proposal: store-first (which hydrates from DB on launch) — one source of truth, watcher writes to both.
5. **Regrade-on-version-mismatch UX**: silent auto-regrade, or require an explicit click? Proposal: explicit click with a count badge ("12 stale"). Auto-regrade on startup could hammer CPU if history is large.

---

## Out of scope for v1

- Delete/archive individual grades from the UI
- Export grades as CSV
- Multi-user / shared baselines
- Syncing grade rows across machines

---

## Rough effort estimate

- Rust migration + 3 commands: ~1 hr
- Store hydration wiring (`gradeHistory.ts` or equivalent): ~30 min
- Insert calls at the two write points: ~15 min
- Baseline versioning constant + UI stale indicator: ~45 min
- Testing (dev + premium, grade → close app → reopen → verify hydration): ~30 min

**Total: ~3 hrs of focused work.** Nothing in here is complex; the shape is the decision.
