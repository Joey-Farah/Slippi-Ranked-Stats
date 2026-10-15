#!/usr/bin/env python3
"""
Add Lunar Melee's replays (lunarmelee.com) to the benchmark StatsDB. Plan and findings:
docs/plans/lunar-benchmarks.md.

    <venv python> scripts/lunar_ingest.py                   # stream the full-database snapshot
    <venv python> scripts/lunar_ingest.py --zip bundle.zip  # a local Lunar bundle (top-ups, tests)
    <venv python> scripts/lunar_ingest.py --limit 2000      # stop after N replays (trial runs)

Nothing big ever touches the disk. The 1.3 TB snapshot is read as ONE sequential HTTP stream and
unzipped entry by entry (Lunar's zips are STORED, with sizes in each local header), each `.slpz`
is unpacked to a temp file of a few MB by a worker, parsed, and deleted. The only thing that
grows is the StatsDB (~0.45 GB per million player-rows). A free-space guard stops the run,
checkpointed, if any drive involved drops below --min-free-gb.

What goes in (classified from each replay's own bytes, no API metadata needed):
  - anonymised ranked games (Lunar's `ranked` source = the erickfm set we already have):
    netplay block present, every connect code empty  ->  SKIPPED
  - netplay games: match id `mode.<ranked|unranked|direct>-...`  ->  source lunar_<mode>
  - console / LAN games (no netplay block): tournament and offline  ->  source lunar_console
A game is also skipped if its stat fingerprint (characters + four game-specific stats) is
already in the DB: that catches the same game arriving from another dataset under a different
file, name or anonymisation. See fingerprint().

Resumable: the byte offset of the next unprocessed zip entry is checkpointed after every
committed batch, so a re-run (or a dropped connection) continues with an HTTP Range request.
Lunar allows 2 full-database links per 24 h; a link is reused for up to 50 minutes, and the
checkpoint remembers how many have been issued.

Requires the `slpz` CLI (`cargo install slpz`). Options go BEFORE the input path.
"""
import argparse, collections, hashlib, json, os, shutil, struct, subprocess, sys, tempfile, time
import urllib.error, urllib.request
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

API = "https://api.lunarmelee.com"
FULL_DB_BUNDLE = "a11db000a11db000a11db000"  # GET /api/jobs/bundles, fullDb: true
USER_AGENT = "SlippiRankedStats-benchmarks/1.0 (github.com/Joey-Farah/Slippi-Ranked-Stats)"
LINK_REUSE_S = 50 * 60      # signed links last an hour
LINKS_PER_DAY = 2

DEFAULT_DB = os.path.join(HERE, "raw_stats_v3.sqlite")
SEED_DB = os.path.join(HERE, "raw_stats_v2.sqlite")
CHECKPOINT = os.path.join(HERE, "lunar_checkpoint.json")

# The four stats that, with the character pair, identify one game. All come from frame data, so
# anonymising names (which changes the file's bytes) doesn't change them. Validated 2026-10-15:
# Lunar's copies of v3.7 games matched their DB rows 8/8, and every shared fingerprint in the
# v2 DB was a genuine duplicate file (the same game under several character folders).
FINGERPRINT_STATS = ("inputs_per_minute", "avg_stock_duration", "damage_per_opening", "l_cancel_ratio")


def fingerprint(player_char, opp_char, stats) -> int:
    """64-bit fingerprint of one player-row. Ints keep millions of them cheap in a set."""
    parts = [player_char, opp_char] + [
        "" if stats.get(k) is None else f"{stats[k]:.4f}" for k in FINGERPRINT_STATS]
    return int.from_bytes(hashlib.blake2b("|".join(parts).encode(), digest_size=8).digest(), "big")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ── Zip streaming ─────────────────────────────────────────────────────────────────────────────

LOCAL_SIG, CENTRAL_SIG = b"PK\x03\x04", b"PK\x01\x02"


class EndOfEntries(Exception):
    """The central directory: no more file entries."""


def read_exact(stream, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            raise EOFError(f"stream ended {n - len(buf)} bytes early")
        buf += chunk
    return bytes(buf)


def next_entry(stream):
    """Read one STORED local entry. Returns (name, data, bytes_consumed)."""
    head = read_exact(stream, 30)
    if head[:4] == CENTRAL_SIG:
        raise EndOfEntries
    if head[:4] != LOCAL_SIG:
        raise ValueError(f"not a zip local header: {head[:4]!r}")
    (_, _, flags, method, _, _, _, csize, _, nlen, xlen) = struct.unpack("<IHHHHHIIIHH", head)
    name = read_exact(stream, nlen).decode("utf-8", "replace")
    extra = read_exact(stream, xlen)
    if flags & 0x08:
        raise ValueError(f"{name}: data descriptor (sizes not in the header); can't stream it")
    if method != 0:
        raise ValueError(f"{name}: compression method {method}; expected STORED (0)")
    if csize == 0xFFFFFFFF:  # zip64: the real size is in the extra field
        i = 0
        while i + 4 <= len(extra):
            tag, size = struct.unpack("<HH", extra[i:i + 4])
            if tag == 0x0001:
                csize = struct.unpack("<Q", extra[i + 12:i + 20] if size >= 16 else extra[i + 4:i + 12])[0]
                break
            i += 4 + size
    data = read_exact(stream, csize)
    return name, data, 30 + nlen + xlen + csize


# ── Worker: one replay ─────────────────────────────────────────────────────────────────────────

_tmp = None


def _worker_init():
    global _tmp
    _tmp = tempfile.mkdtemp(prefix="lunar_")
    import parse_hf_replays  # noqa: F401  (load once per worker)


def classify(path):
    """'skip' for an anonymised ranked game, else the source label to store it under."""
    import peppi_py as peppi
    start = peppi.read_slippi(path, skip_frames=True).start
    players = [p for p in start.players if p is not None]
    if players and all(p.netplay is not None for p in players):
        if all(not (p.netplay.code or "").strip() for p in players):
            return "skip"
    mid = (getattr(getattr(start, "match", None), "id", None) or "")
    for mode in ("ranked", "unranked", "direct"):
        if mid.startswith(f"mode.{mode}"):
            return f"lunar_{mode}"
    return "lunar_netplay" if players and players[0].netplay is not None else "lunar_console"


def process_entry(args):
    """(name, slpz bytes) -> (name, outcome, source, results). Never raises."""
    import parse_hf_replays as P
    name, data = args
    src, slp = os.path.join(_tmp, "in.slpz"), os.path.join(_tmp, "out.slp")
    try:
        with open(src, "wb") as fh:
            fh.write(data)
        r = subprocess.run(["slpz", "-q", "-d", "-o", slp, src], capture_output=True)
        if r.returncode != 0 or not os.path.exists(slp):
            return name, "slpz_failed", None, None
        try:
            source = classify(slp)
        except BaseException:  # peppi panics are BaseException
            return name, "unreadable", None, None
        if source == "skip":
            return name, "anonymised_ranked", None, None
        results = P.process_both_ports(slp)
        return (name, "parsed", source, results) if results else (name, "not_1v1", None, None)
    finally:
        for p in (src, slp):
            try:
                os.remove(p)
            except OSError:
                pass


# ── Sources: local zip or the snapshot over HTTP ───────────────────────────────────────────────

class LinkBudgetExhausted(Exception):
    pass


def get_link(state):
    now = time.time()
    link = state.get("link")
    if link and now - link["at"] < LINK_REUSE_S:
        return link["url"]
    full_db = state.get("bundle", FULL_DB_BUNDLE) == FULL_DB_BUNDLE
    issued = [t for t in state.get("links_issued", []) if now - t < 24 * 3600]
    if full_db and len(issued) >= LINKS_PER_DAY:
        wait_h = (24 * 3600 - (now - min(issued))) / 3600
        raise LinkBudgetExhausted(f"Lunar allows {LINKS_PER_DAY} full-database links a day; "
                                  f"the next is available in {wait_h:.1f} h. Re-run then.")
    bundle = state.get("bundle", FULL_DB_BUNDLE)
    req = urllib.request.Request(f"{API}/api/jobs/{bundle}/download",
                                 headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
        body = json.load(res)
    url = body.get("url") or body.get("downloadUrl")
    if not url:
        raise RuntimeError(f"no download url in Lunar's reply: {str(body)[:300]}")
    state["link"] = {"url": url, "at": now}
    if full_db:
        state["links_issued"] = issued + [now]
        log(f"new full-database link ({len(state['links_issued'])}/{LINKS_PER_DAY} today)")
    else:
        log(f"new link for bundle {bundle}")
    return url


def open_http(state, offset):
    url = get_link(state)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Range": f"bytes={offset}-"})
    res = urllib.request.urlopen(req, timeout=120)
    if offset and res.status != 206:
        res.close()
        raise RuntimeError(f"server ignored the Range request (HTTP {res.status}); can't resume safely")
    return res


# ── Main loop ─────────────────────────────────────────────────────────────────────────────────

def load_state(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {"offset": 0, "entries": 0, "counts": {}, "links_issued": []}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1)
    os.replace(tmp, path)


def check_disk(paths, min_free_gb):
    for p in paths:
        free = shutil.disk_usage(p).free / 1e9
        if free < min_free_gb:
            return f"only {free:.1f} GB free on the drive holding {p} (minimum {min_free_gb} GB)"
    return None


def prepare_db(db_path):
    """The new sidecar starts as a copy of v2 (v2 is never modified), minus its duplicate games."""
    if not os.path.exists(db_path):
        if not os.path.exists(SEED_DB):
            raise SystemExit(f"{db_path} doesn't exist and there's no {SEED_DB} to seed it from")
        log(f"seeding {os.path.basename(db_path)} from {os.path.basename(SEED_DB)} (copy, v2 untouched)")
        shutil.copyfile(SEED_DB, db_path + ".partial")
        drop_duplicate_rows(db_path + ".partial")
        os.replace(db_path + ".partial", db_path)


def drop_duplicate_rows(db_path):
    """Keep one row per stat fingerprint. The v3.7 dataset files each game under every player's
    character folder (FALCO/…/x.slp and FOX/…/x.slp), and the v3.7 scan de-duplicated by path, so
    57.5% of its rows in v2 are repeats: those games counted ~2.35× in every benchmark built from
    it. The lexicographically first filename of each group survives."""
    import sqlite3
    con = sqlite3.connect(db_path)
    cols = ", ".join(f'"{k}"' for k in FINGERPRINT_STATS)
    keep, drop = {}, []
    for row in con.execute(f"SELECT filename, port, player_char, opp_char, {cols} FROM games "
                           f"ORDER BY filename, port"):
        fp = fingerprint(row[2], row[3], dict(zip(FINGERPRINT_STATS, row[4:])))
        if fp in keep:
            drop.append((row[0], row[1]))
        else:
            keep[fp] = row[0]
    with con:
        con.executemany("DELETE FROM games WHERE filename = ? AND port = ?", drop)
    by_source = collections.Counter()
    for fname, _ in drop:
        by_source["v37" if "/" in fname and not fname.startswith("lunar/") else "other"] += 1
    log(f"dropped {len(drop):,} duplicate rows ({dict(by_source)}); {len(keep):,} remain")
    con.execute("VACUUM")
    con.close()


def load_fingerprints(db):
    cols = ", ".join(f'"{k}"' for k in FINGERPRINT_STATS)
    seen = set()
    for row in db.con.execute(f"SELECT player_char, opp_char, {cols} FROM games"):
        seen.add(fingerprint(row[0], row[1], dict(zip(FINGERPRINT_STATS, row[2:]))))
    return seen


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", help="ingest a local Lunar bundle instead of streaming the snapshot")
    ap.add_argument("--bundle", help="stream this Lunar bundle/job id instead of the full-database "
                                     "snapshot (top-ups, and testing the HTTP path)")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--checkpoint", help="default: scripts/lunar_checkpoint.json (snapshot) or "
                                         "<zip>.checkpoint.json (--zip)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 4))
    ap.add_argument("--window", type=int, default=0, help="replays in flight (default 25×workers)")
    ap.add_argument("--batch", type=int, default=2000, help="replays per DB commit + checkpoint")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many replays (0 = all)")
    ap.add_argument("--min-free-gb", type=float, default=20.0)
    args = ap.parse_args()

    if shutil.which("slpz") is None:
        raise SystemExit("slpz not found on PATH: cargo install slpz")
    import parse_hf_replays as P
    from stats_db import StatsDB

    ckpt = args.checkpoint or (args.zip + ".checkpoint.json" if args.zip else
                               os.path.join(HERE, f"lunar_{args.bundle}.checkpoint.json") if args.bundle else CHECKPOINT)
    state = load_state(ckpt)
    if args.bundle:
        state["bundle"] = args.bundle
    prepare_db(args.db)
    db = StatsDB(args.db, P.STAT_KEYS)
    log(f"DB {args.db}: {db.count():,} rows; loading fingerprints…")
    seen = load_fingerprints(db)
    log(f"{len(seen):,} fingerprints; resuming at byte {state['offset']:,} "
        f"after {state['entries']:,} replays")

    window = args.window or 25 * args.workers
    disk_paths = [os.path.dirname(os.path.abspath(args.db)), tempfile.gettempdir()]
    counts = collections.Counter(state["counts"])
    records, offset, entries, done = [], state["offset"], state["entries"], False
    t0, entries0 = time.time(), entries
    pending = collections.deque()  # (name, end_offset, AsyncResult), in stream order

    def commit():
        nonlocal records
        if records:
            db.insert_batch(records)
            records = []
        state.update(offset=offset, entries=entries, counts=dict(counts))
        save_state(ckpt, state)

    def settle(item):
        """Fold one finished replay into the batch (in stream order)."""
        nonlocal offset, entries
        name, end, res = item
        _, outcome, source, results = res.get()
        if outcome == "parsed":
            fps = [fingerprint(pc, oc, stats) for stats, pc, oc, _ in results]
            if any(f in seen for f in fps):
                outcome = "duplicate"
            else:
                seen.update(fps)
                records.extend(P.make_records(f"lunar/{name}", source, None, None, results))
                outcome = f"added:{source}"
        counts[outcome] += 1
        offset, entries = end, entries + 1

    from run_rescan import keep_awake  # same sleep prevention as the overnight rescan
    release = keep_awake()
    stream = None
    try:
        with Pool(args.workers, initializer=_worker_init) as pool:
            while not done:
                # (Re)open the stream at the first byte not yet settled.
                read_from = pending[-1][1] if pending else offset
                if args.zip:
                    stream = open(args.zip, "rb")
                    stream.seek(read_from)
                else:
                    try:
                        stream = open_http(state, read_from)
                    except LinkBudgetExhausted as e:
                        log(str(e))
                        break
                pos = read_from
                try:
                    while True:
                        if args.limit and entries + len(pending) >= args.limit:
                            done = True
                            break
                        try:
                            name, data, used = next_entry(stream)
                        except EndOfEntries:
                            done = True
                            break
                        pos += used
                        if not name.endswith(".slpz"):
                            continue  # the manifest
                        pending.append((name, pos, pool.apply_async(process_entry, ((name, data),))))
                        while len(pending) >= window or (pending and pending[0][2].ready()):
                            settle(pending.popleft())
                            if entries % args.batch == 0:
                                commit()
                                problem = check_disk(disk_paths, args.min_free_gb)
                                if problem:
                                    log(f"STOPPING: {problem}. Checkpointed; free some space and re-run.")
                                    done = True
                                    break
                                rate = (entries - entries0) / max(1e-9, time.time() - t0)
                                log(f"{entries:,} replays · {offset / 1e9:,.1f} GB · {rate:,.0f}/s · "
                                    + ", ".join(f"{k} {v:,}" for k, v in sorted(counts.items())))
                        if done:
                            break
                except (OSError, EOFError, urllib.error.URLError) as e:
                    if args.zip:
                        raise
                    log(f"connection problem ({e}); reconnecting in 15 s from byte {pending[-1][1] if pending else offset:,}")
                    time.sleep(15)
                finally:
                    stream.close()
            while pending:
                settle(pending.popleft())
            commit()
    finally:
        db.close()
        release()
    rate = (entries - entries0) / max(1e-9, time.time() - t0)
    log(f"stopped at {entries:,} replays ({rate:,.0f}/s this run). "
        + ", ".join(f"{k} {v:,}" for k, v in sorted(counts.items())))


if __name__ == "__main__":
    main()
