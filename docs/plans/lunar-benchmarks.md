---
status: PLAN, agreed in outline with Joey 2026-10-15; nothing built yet. Branch feat/lunar-benchmarks.
date: 2026-10-15
---

# Adding Lunar Melee's replays to the grading benchmarks

Lunar Melee (lunarmelee.com) is a free public archive of 3,252,369 Slippi replays with an open
API (`https://api.lunarmelee.com`, OpenAPI at `/openapi.json`). This plan adds its **netplay and
tournament** games to the benchmark pool behind `grade-benchmarks.ts`, next to the two sources
we already pool (erickfm ranked + the v3.7 public set).

## Decided (Joey, 2026-10-15)

| # | Decision | Why |
|---|---|---|
| 1 | **Skip Lunar's ranked games.** | Verified to be the erickfm ranked set we already have: 849,041 (ours) vs 850,106 (Lunar), and a full slice (Ness, master-master) matched 28/28 by exact file size. |
| 2 | **Add all of Lunar's netplay (2,009,375) and tournament (392,888) games, unlabelled.** No per-player rating lookups. | Joey: people play to win in friendlies too, the set is too large to throw out, and the app now grades unranked/direct games. Per-code Slippi API lookups would be too much load. |
| 3 | **De-duplicate against the v3.7 set** we already scanned. | A 25-replay sample found 4 of them in Lunar (matched by exact size; MD5s differ, since Lunar's `fileHash` is the MD5 of its pre-processing original). Partial overlap, so the sets can't simply be swapped. |

Accepted consequence: the comparison population changes, so grades will shift. Measure it
over Joey's stored sets before release (as for v1.10.0) and say it plainly in the release notes.

## Facts the plan rests on (checked live 2026-10-15)

- Source split: ranked 850,106 · netplay 2,009,375 · tournament 392,888. Ranked games are
  anonymised (display name = rank tier, no connect code, no date). Netplay records carry connect
  codes, display names, `startAt` and `mode` (`unranked` seen).
- Character ids in the API are **external (CSS) ids**: Fox 2, Mario 8, Ness 11, Sheik 19.
- Bulk jobs: filter or ≤100,000 ids → zip of `.slpz` + `lunar-manifest.json`; ≤10 GB per job
  (`maxSizeMb`), 3 concurrent, 5 created/hour. **Packing netplay alone as jobs = ~877 GB and ~8.6
  days of their single server's time** (their own estimate endpoint) — too heavy on a free
  community service.
- The **full-database snapshot (~1.3 TB zip) is pre-built**: costs them bandwidth only. Signed
  links last an hour, support range/resume, and are limited to 2 per 24 h.
- Fair-use page: cache, prefer bulk over per-replay, back off on 429/503, descriptive
  User-Agent, credit "Data from Lunar Melee (lunarmelee.com)" (appreciated, not required), and
  "don't use the API to identify or track people beyond what their games show".
- `.slpz` = zstd-compressed slp (Rust crate `slpz`, 8–12× smaller, metadata left uncompressed).
- No drive on the Windows machine fits 1.3 TB (free: C 115 GB, D 379 GB, F 267 GB) → **stream it**.
- Our `--dataset db` builder already pools every source in the StatsDB, so a new source needs no
  change there.

## Plan

### 0. Ask Lunar first (Joey) — before any bulk pull
A ~1 TB pull is a big ask of a one-server, Patreon-funded project, and grades are a Premium
feature, so this is commercial use of data that comes with no stated licence. A short message on
their Discord: who we are, what we'd use (aggregate stat distributions only, no per-player data
kept), which download they'd prefer (snapshot vs jobs), and that we'll credit them. Consider
supporting their Patreon.

### 1. Trial on one small bundle (no snapshot yet)
One fast-lane job (≤200 MB, ~2,000 netplay + a few hundred tournament games). Proves, end to end:
- decompressing `.slpz` from Python (a Python binding if one exists; otherwise the `slpz` CLI
  from its GitHub releases or `cargo install slpz`);
- `process_both_ports` parses them unchanged;
- each file can be classified **from its own bytes**: ranked (anonymised names /
  `mode.ranked` match id) vs unranked/direct netplay vs tournament (no match id) — so the snapshot
  needs no API metadata to split;
- the v3.7 de-dup key works (below);
- the manifest's shape.

### 2. De-dup key against v3.7
`(decompressed .slp byte size, sorted character pair)`. v3.7 sizes come free from HuggingFace's
`list_repo_tree` (no downloads); characters are already in the StatsDB. A Lunar game whose key
is in the v3.7 set is skipped. Validate the key on the trial bundle before trusting it.

### 3. `--dataset lunar` in `parse_hf_replays.py`
Streams the snapshot zip with one sequential GET, unzipping entry by entry (local headers) and
parsing each replay in memory: nothing over a few MB ever lands on disk. Skips ranked games and
v3.7 duplicates; inserts the rest as `source = 'lunar_netplay'` / `'lunar_tournament'` (kept
apart so they can be compared or dropped later), keyed by Lunar's `fileHash` (via the manifest)
so `db.seen()` makes it re-runnable. Checkpoints the byte offset; on a drop, resumes with an HTTP
Range request on a fresh link (2/day — so the checkpoint must be solid). Parallel parse workers.
Writes to a new sidecar (`raw_stats_v3.sqlite`, seeded from v2) so the current one stays as is.

### 4. Wire into `run_rescan.py`
A `lunar` step after the existing ones (they're already done in v2, so they no-op), then the
existing `baselines` + `regen` steps. Multi-day run, resumable, keeps the machine awake.

### 5. Validate, measure, ship
- Parity: `scripts/test_parity.py` must stay green (no stat-logic change is planned).
- Compare per-stat distributions by source (ranked / v3.7 / lunar netplay / lunar tournament) —
  for the record, not as a gate (decision 2).
- Regrade Joey's stored sets; report the mean shift and letter changes like v1.10.0.
- `BENCHMARKS_VERSION` bumps automatically (generation timestamp), so stored grades regrade.
- Release notes: short and plain ("the grading benchmark grew to ~N games, so grades may move a
  little") + the Lunar credit. Update the website's replay-count HUD (`site/index.html`).

## Open questions

- Lunar's answer to step 0 may change the download route (they may prefer jobs, or offer something
  better).
- Does the `netplay` source include `mode.ranked` games with connect codes (i.e. de-anonymised
  copies of erickfm games)? The trial will show; if so, they're skipped as ranked.
- Where to run it: this Windows machine has `raw_stats_v2.sqlite` and the venv. Bandwidth and
  uptime decide.
