# Multi-Code Scan Bug — Diagnosis & Fix Plan

**Discovered:** 2026-04-28 (Mac dev session) · **Reporter:** external tester via Joey · **Status:** unfixed; design ready

---

## Problem statement

A tester reported that not all of his ranked replays were being picked up by the app. v1.4.0 shipped multi-code support — `linkedCodes` lets a user link any number of connect codes, and stats/sessions/grades union across them. The expectation: scanning a folder should ingest every replay where **any** of the user's linked codes is a participant.

The actual behavior: the scan only ever ingests replays for `$connectCode` (the primary code at the top of the list). Replays where the user is the player but under a *linked* code are silently dropped, and worse, marked "scanned" so they're never retried.

---

## Diagnosis trail

Reproduced on Mac dev with 10 test `.slp` files at `TestingSLPFiles/` (sent by tester, not committed). Inspected each file's mode and connect codes by stringing the binary:

```bash
strings "$f" | grep -oE 'mode\.(ranked|unranked|direct|teams)'
strings "$f" | grep -oE '[A-Z]{1,8}#[0-9]{1,4}' | sort -u
```

Results: all 10 files are `mode.ranked` ✓. Connect codes split:
- 6 files (April 17): contain `FBI#739` + various opponents — no `BONES#0`
- 4 files (April 25): contain `BONES#0` + opponents — no `FBI#739`

Scanning as `BONES#0` yielded only the 4 BONES files. The 6 FBI files dropped silently at `slp_parser.ts:845-846`:

```ts
const playerPort = ports.find((p) => meta.players[p].connectCode.toUpperCase() === cc);
if (playerPort === undefined) return [];   // ← silent drop
```

Linking `FBI#739` after the fact did **not** make those 6 files reprocess, even though the multi-code feature is supposed to combine codes. That's two distinct bugs.

---

## The two bugs

### Bug 1: Scan handler hard-codes primary

`Sidebar.svelte:67-90` (`handleScan`) and `Sidebar.svelte:92-115` (`handleForceRescan`) both use `$connectCode` only — `$linkedCodes` and `$effectiveCodes` are never read at scan time. The multi-code feature unions data **at display time** in `App.svelte:60-98`, but ingestion is single-code.

### Bug 2: `scanned_files` table is not code-scoped

`db.ts`:

```ts
CREATE TABLE IF NOT EXISTS scanned_files (
  filename TEXT PRIMARY KEY
)
```

Once a `.slp` is processed (regardless of whether any games were inserted), the filename goes into this table and is filtered out of every subsequent scan via `parser.ts:104`:

```ts
const already = await getScannedFilenames();
const toProcess = slpFiles.filter((f) => !already.has(f.name));
```

So even if Bug 1 is fixed, files dropped under the old primary-only logic are stuck on the "already scanned" list forever (until the user clicks Force Rescan All, which `DELETE`s the table).

---

## Fix design

### Goals
1. A single scan reads each `.slp` once and routes its game rows to the DB of whichever linked code matches.
2. Adding a new linked code re-processes only the files that haven't been tried for that code yet.
3. Removing a linked code does not regress anything (its rows already in its own DB stay there).

### Approach

**Refactor 1: `parseSlpFile` → batch over codes.**

Current: `parseSlpFile(path: string, connectCode: string): Promise<GameRow[]>`. Internal logic finds the player port for the one given code.

New: `parseSlpFile(path: string, codes: string[]): Promise<{ code: string; game: GameRow }[]>`. Parse `parseEventStream` and `parseMetadata` **once**; then for each code in `codes`, find that code's port, build a GameRow, push to result. Returns 0..N entries depending on how many of the codes are participants (typically 0 or 1).

This is the right place for the change because all the byte parsing, match-type filtering, and metadata reading is per-file work that shouldn't repeat per code.

**Refactor 2: `scanDirectory` takes a code list and a DB map.**

Current: `scanDirectory(dirPath, connectCode, db, onProgress) → ScanResult`.

New: `scanDirectory(dirPath, codes: string[], dbsByCode: Record<string, Database>, onProgress) → ScanResult`. For each batch of files, parse with all codes in one pass; for each `{code, game}` returned, insert into `dbsByCode[code]`.

**Refactor 3: `scanned_files` becomes per-(file, code).**

```sql
CREATE TABLE IF NOT EXISTS scanned_files (
  filename TEXT NOT NULL,
  connect_code TEXT NOT NULL,
  PRIMARY KEY (filename, connect_code)
)
```

`getScannedFilenames` becomes `getScannedPairs(): Promise<Set<string>>` returning a set of `${filename}::${code}` keys (or similar). The "to process" filter becomes: a file enters the work list if there exists any code in `$effectiveCodes` for which `(filename, code)` is **not** in the set. Then within `parseSlpFile`, only the un-tried codes are checked.

Mark each `(filename, code)` as scanned only after the parse for that pair completes (success or "not a participant" — both count as "tried"). Errors in parse stay un-marked so they retry later.

**Migration**: existing `scanned_files` rows have `filename` only. On upgrade, either:
- (a) Drop the table + recreate with the new schema (forces full rescan on first launch — slow but simple, and the user already shipped a "Force Rescan All" button)
- (b) Backfill existing rows with `connect_code = <current primary>` so they remain "already tried for primary." Cleaner upgrade, more code.

I'd lean **(a)** for cleanliness — the inconvenience is one slow first-scan after the upgrade, which the user can pre-empt via the existing rescan button. Either way, document it in release notes.

### Sidebar handler updates

`handleScan` and `handleForceRescan` change from passing `code` + single `db` to passing `$effectiveCodes` + a built `dbsByCode` map. `getDb` is already cache-keyed by code so opening four DBs for four codes is cheap.

### Touched files

| File | Change |
|---|---|
| `src/lib/slp_parser.ts` | New `parseSlpFile(path, codes[])` shape; reuse single parse pass across codes |
| `src/lib/parser.ts` | `scanDirectory` takes codes + dbsByCode; insert per-code |
| `src/lib/db.ts` | `scanned_files` schema → `(filename, connect_code)` PK; helpers updated |
| `src/components/Sidebar.svelte` | `handleScan` / `handleForceRescan` build `dbsByCode` from `$effectiveCodes` |
| `src/lib/watcher.ts` | Live-session watcher path for new replays — verify it stays single-primary (live session is intentionally primary-only per existing design) |

### Out of scope (do separately if needed)
- The watcher itself stays single-primary for now (Live Session is documented as primary-only). If we want live-session awareness across linked codes later, that's a separate change.
- The `match_type` filter (only `ranked`/`unranked`) stays unchanged.

---

## Testing plan

1. **Unit-style**: with the test `.slp` set in `TestingSLPFiles/`, scanning as `BONES#0` alone should ingest 4 games, and no scanned rows for the 6 FBI-only files.
2. **Add `FBI#739` as a linked code, scan again**: the 6 FBI files should now ingest into FBI's DB. The 4 BONES files should be skipped (already tried for BONES) — but if BONES isn't in those files, that pair should be marked scanned-no-op so they don't re-attempt.
3. **Remove `FBI#739`**: BONES's view of stats should not change. Re-add → no rescan needed (FBI's rows still in FBI's DB).
4. **All-time / sessions / grading union**: 10 files should yield up to 10 games unioned across both DBs in the UI.
5. **Force Rescan All**: still works — clears `scanned_files` and re-processes everything for all `$effectiveCodes`.
6. **Single-code users (primary only)**: behavior unchanged.

---

## Side discoveries from this session

- **`statusMessage` was set in five places in `Sidebar.svelte` but never rendered anywhere.** Scan/rescan/rating-fetch results were silent, which masked all of the above. A one-line fix added the render below the scan progress bar — committed as part of this session.
- **Mac dev environment now works** (`npm run tauri dev` launches cleanly). No replay folder yet on Mac; the user will bring `.slp` files over from Windows for ongoing testing.
- **HMR can leave Tauri ↔ Rust callback state stale** after a hot reload mid-async-op (`[TAURI] Couldn't find callback id ...` warning). Cmd+R full reload clears it. Not a real bug, but worth knowing during dev.
