---
status: INGEST DONE + benchmarks rebuilt 2026-10-21, not released (see Status). Branch feat/lunar-benchmarks.
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

## ✅ Status 2026-10-21 — INGEST DONE, benchmarks rebuilt, NOT released

The last ~786k entries ran 10:41–12:50 on 10-21 (`--workers 8 --connections 20 --chunk-gb 52`,
XMP off, XTU at defaults, RGB tools closed): no crash, nothing parked. ⚠ `--connections` must be
≥ the planned chunk count, and the chunk count grows with `--connections` (chunk size = span ÷
connections), so pin `--chunk-gb` and raise `--connections` until they agree.

**Pool:** `raw_stats_v3.sqlite` holds 2,895,376 games (ranked 849k, lunar netplay 745k / unranked
417k / direct 409k / ranked 199k / tournament 184k, v3.7 91k after de-dup).

**Two exclusions the builder now applies** (`build_baselines_from_db`, via a `pool` view; rows
stay in `games`, so both are reversible):
- **Non-playable characters** (`Unknown_26`…`Unknown_42`: Master Hand, Wireframes, Giga Bowser,
  Sandbag…, ~5.1k modded games): the whole game is dropped.
- **Non-legal stages**, listed in a `benchmark_excluded` table (13,773 files). The DB has no stage
  column, so: v3.7 by its file-name code (1,716 `(YI)`), Lunar by matching its API's non-legal
  replays (`scripts/lunar_nonlegal_fetch.py` → `lunar_nonlegal_match.py --write`) on character
  pair + start time (Slippi's `Game_YYYYMMDDTHHMMSS` local time vs the API's UTC `startAt`, any
  whole-hour offset). Validated on 976 known Battlefield games: 958 matched (98%), ~6% extra
  files from ambiguity (extra exclusions are harmless). Of Lunar's 78,777 non-legal games,
  61,900 aren't 1v1 (Target Test / Home-Run), so were never ingested; 11,778 matched our rows.
  ⚠ The API's inputs/min is NOT ours (~4× higher), so it can't be a match key. Not covered:
  ~52.7k v3.7 files with no stage in their name (est. ~2k non-legal) and tournament files with
  custom names; both negligible.

**Rebuilt** `grade_baselines.json` + `grade-benchmarks.ts` (`BENCHMARKS_VERSION`
`2026-10-21T18:34:47`): 5,755,828 player-rows, all 26 characters, **676/676 matchups ≥50
samples** (was 569). Parity test green.

**Grade shift over Joey's 1,566 stored sets** (stat values fixed, only benchmarks swapped; the
harness reproduced 1,566/1,566 stored category scores first): overall −0.49 mean, neutral −0.40,
punish −1.19, defense +0.71; 64 sets drop a letter (mostly S→A), 17 rise, 1,485 unchanged.
Largest per-stat moves: inputs/min −4.49, kill% −2.23, death% +2.19, L-cancel −1.64.

**Next:** Joey decides whether to ship. Release = merge into `main`, version bump, release notes
(short and plain + "Data from Lunar Melee (lunarmelee.com)"), the website's replay-count HUD
(`site/index.html`), and the banked quit-out rule + chart hover fix ride along.

## Status 2026-10-19 (superseded above) — ~796k netplay entries left

The 10-19 run (13:35) got through ~870k replays before the PC **blue-screened twice** (~15:05,
~15:16; the second only 6 min after restarting). The DB passed `pragma quick_check` both times and
nothing was lost: it now holds ~2.2M replays, and a re-run plans only the **~796k netplay entries**
left (16 chunks, ~329 GB). Both of the day's links went (13:35 and 14:31; the 15:09 restart reused
the 14:31 one), so the next frees ~13:35 on 10-20.

**The crashes are the machine, not the script.** Four minidumps (`cdb !analyze -v`): 0x13A heap
corruption ×2, 0x139 corrupted AVL tree, 0x18 corrupt refcount, all inside `nt`, each in a
different process (SignalRgb, PowerShell, System, WebView2). That's memory corruption under
full load, not one faulty driver, and not the I225-V NIC. Suspects: an Intel XTU profile on the
i7-12700K, 4×8 GB DDR4 from two kits at 3600 XMP, and several RGB/hardware-access drivers running
at once (SignalRGB, Armoury Crate `AsIO3`/`IOMap`, `MSIO`, `CTIAIO`). Long streams also hit
`SSL: DECRYPTION_FAILED_OR_BAD_RECORD_MAC` several times, which fits the same cause.

**Before the next run:** XTU to defaults, RAM to default speed, quit SignalRGB / Armoury Crate /
other RGB tools. Then resume lighter:
`.venv/Scripts/python.exe -u scripts/lunar_ingest.py --workers 8 --connections 6
>> scripts/logs/lunar_ingest.log 2>&1` (~2.5–3 h).

## Status 2026-10-15 evening (superseded above) — the ingest was HALF DONE

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
