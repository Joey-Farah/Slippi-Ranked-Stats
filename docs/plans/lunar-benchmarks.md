---
status: PLAN agreed with Joey 2026-10-15 (steps 1–5 approved; step 0 dropped). Steps 1–4 built 2026-10-15; the ingest is half done, see Status. Branch feat/lunar-benchmarks.
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
| 1 | **Skip Lunar's ranked games.** Adding them would count ~850k games twice and silently double ranked play's weight; the ~1,065 extra Lunar has can't be told apart without re-downloading erickfm's 1.4 TB (its per-file sizes aren't listed), so skipping costs ~0.1%. | Verified to be the erickfm ranked set we already have: 849,041 (ours) vs 850,106 (Lunar), and a full slice (Ness, master-master) matched 28/28 by exact file size. |
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

## ⚠ Status 2026-10-15 evening — the ingest is HALF DONE; resume at/after 11:32 on 2026-10-16

`scripts/lunar_ingest.py` (this branch) streams the full-database snapshot into
`scripts/raw_stats_v3.sqlite` (Windows machine only; gitignored). After two runs it holds
**~347,600 Lunar games** (rows: lunar_tournament 365,920, lunar_netplay 146,978, lunar_unranked
72,260, lunar_direct 71,222, lunar_ranked 38,810, + 62 new `ranked`) on top of erickfm ranked
(1,698,201 rows) and de-duplicated v3.7 (182,943 rows). **~1.87M entries still wanted**, ~4 h at
~130/s (CPU-bound on 16 workers).

**Resume:** `.venv/Scripts/python.exe -u scripts/lunar_ingest.py --workers 16 --connections 12
>> scripts/logs/lunar_ingest.log 2>&1`. Everything already stored or recorded in `lunar_skipped`
is skipped by name, so a re-run plans only what's left (no checkpoint needed beyond the DB).

What today taught (all handled in the code now):
- ⚠ **Lunar issues only 2 full-database links per 24 h, per IP** (server-enforced: HTTP 429
  `fulldb_rate_limited`, `retryAfterSeconds`). A link is an R2 presigned URL valid for **1 h for
  NEW requests**; a request that started in time runs on past expiry. So every segment must be
  requested within the hour (`--connections` ≥ the number of planned segments), and a segment
  whose stream drops after expiry is **parked** (a later run with a fresh link finishes it).
  Stopping all connections on a single drop cost a whole run on 10-15; fixed.
- Restarts burn links: each relaunch after the reuse window fetches a new one. Don't restart
  needlessly; both of 10-15's links went on restarts.
- Long streams drop now and then (`stream ended N bytes early`, ~3 in 1.5 h across 8 streams);
  the reader retries in place while the link is valid.
- The first run used a byte rule for "anonymised ranked" (netplay block, empty codes) that also
  matched pre-connect-code netplay and online-tournament games: 143,610 real games skipped. Now
  classified by the archive's folders (`netplay/`, `tournament/`, `ranked_anonymized/`);
  `ranked_anonymized/` keeps erickfm's exact file names (848,784 of 849,751 already ours).
- The machine blue-screened once under the full load (0x13A, a driver; Intel I225-V suspected;
  minidump `C:\Windows\Minidump\101526-17437-01.dmp`; Joey updating drivers via Armoury
  Crate). The run resumed with nothing lost.

After it finishes: `parse_hf_replays.py --dataset db --db scripts/raw_stats_v3.sqlite --output
scripts/grade_baselines.json`, then `regen_benchmarks.py`, then measure the grade shift over
Joey's stored sets (plan step 5).

## Trial results (2026-10-15) — read before building

Two fast-lane jobs, 330 netplay + 105 tournament games (newest first), run through the real
`process_both_ports`. The scratch scripts aren't in the repo; the findings are:

- **Bundles stream trivially**: zip entries are STORED (method 0) with sizes in the local headers
  (no data descriptors). `lunar-manifest.json` maps `file` → `replayId`/`fileHash`.
- **`slpz`**: no Python package exists; `cargo install slpz` (v1.3.0) gives a CLI. ⚠ Options must
  come BEFORE the input: `slpz -q -d -o out.slp in.slpz` (`-o -` = stdout, input `-` = stdin).
- **435/435 parsed** (2 player-rows each). **~16 replays/s in one process**, so ~42 h
  single-threaded for 2.4M and a few hours with a worker pool. Median replay 3.4–3.9 MB unpacked.
- **The `netplay` source mixes modes**: 215 direct, 105 **ranked (with connect codes)**, 10
  unranked. The tournament bundle: 98 direct, 7 unranked (online tournaments run over direct).
- **None of the 435 is already in our DB**, ranked ones included. They're recent (Sept 2026),
  newer than the erickfm snapshot, so netplay's ranked-mode games are KEPT.

### De-dup key: the game's own stats, not its file
A replay's stats come from its frame data, so two copies of one game give identical stats even
when names were anonymised (which changes the file's bytes and size). Key =
`(player_char, opp_char` + `round(x, 4)` of `inputs_per_minute, avg_stock_duration,
damage_per_opening, l_cancel_ratio)`. No file sizes or downloads needed, and it works across every
source. **Positive control passed**: Lunar's copies of 4 v3.7 games we hold (Lunar files them
under `tournament`) fingerprint identically to our local files and match their DB rows 8/8. This
replaces the `(size, chars)` key in step 2.

### ⚠ Bug in the CURRENT benchmark: v3.7 games are counted ~2.35×
The v3.7 dataset stores each game once per player's character folder, sometimes in several batch
folders too: `FALCO/…/15_26_13 Falco + Fox (PS).slp` and `FOX/…/15_26_13 Falco + Fox (PS).slp`.
Our scan de-dups by path, so **247,169 of 430,112 v3.7 rows (57.5%) are duplicates**. v3.7 is
20.2% of the pool as counted and ~9.7% really. Ranked is clean (5 of 1.7M). Fix: de-dup by the stat
fingerprint when building baselines (`--dataset db`), which covers Lunar too. Modest grade impact;
it ships in the same benchmark rebuild.

## Plan

### 0. ~~Ask Lunar first~~ — dropped (Joey, 2026-10-15)
Lunar publishes the full-database download for exactly this kind of use. We still use the
pre-built snapshot rather than ~100 custom jobs (no packing load on their server) and credit them.

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

### 2. De-dup key against v3.7 — SUPERSEDED by the stat fingerprint (see Trial results)
`(decompressed .slp byte size, sorted character pair)`. v3.7 sizes come free from HuggingFace's
`list_repo_tree` (no downloads); characters are already in the StatsDB. A Lunar game whose key
is in the v3.7 set is skipped. Validate the key on the trial bundle before trusting it.

### 3. `--dataset lunar` in `parse_hf_replays.py`
Streams the snapshot zip with one sequential GET, unzipping entry by entry (local headers) and
parsing each replay in memory: nothing over a few MB ever lands on disk. Skips Lunar's anonymised
`ranked`-source entries (the erickfm set) and any game whose stat fingerprint is already in the DB; inserts the rest as `source = 'lunar_netplay'` / `'lunar_tournament'` (kept
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

- Does the `netplay` source include `mode.ranked` games with connect codes (i.e. de-anonymised
  copies of erickfm games)? The trial will show; if so, they're skipped as ranked.
- Where to run it: this Windows machine has `raw_stats_v2.sqlite` and the venv. Bandwidth and
  uptime decide.
