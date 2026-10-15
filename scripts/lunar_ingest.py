#!/usr/bin/env python3
"""
Add Lunar Melee's replays (lunarmelee.com) to the benchmark StatsDB. Plan and findings:
docs/plans/lunar-benchmarks.md.

    <venv python> scripts/lunar_ingest.py                   # the full-database snapshot
    <venv python> scripts/lunar_ingest.py --zip bundle.zip  # a local Lunar bundle (top-ups, tests)
    <venv python> scripts/lunar_ingest.py --bundle <job id> # a Lunar bundle by id, over HTTP

Nothing big ever touches the disk. The zip's central directory (its index: every entry's name and
byte offset) is read first and cached; the entries still wanted are cut into chunks of a few GB,
and --connections threads each stream one chunk at a time with an HTTP Range request, unzipping
entry by entry (Lunar's zips are STORED, sizes in each local header). A worker pool unpacks each
`.slpz` to a temp file of a few MB, parses it, and deletes it. Only the StatsDB grows (~0.45 GB per
million player-rows). A free-space guard stops the run, checkpointed, below --min-free-gb.

What goes in, by the entry's top-level folder in Lunar's archive (NOT guessed from the replay's
bytes: an empty connect code also means a pre-connect-code netplay game, which a byte rule took
for an anonymised ranked one and dropped, 143,610 games, before this version):
  - ranked_anonymized/<rank>-<rank>-<hex>.slpz  the erickfm set, same file names: only names NOT
    already in the DB go in (961 on 2026-10-15), as source `ranked` with the name's rank pair
  - netplay/...     source lunar_<ranked|unranked|direct> from the match id, else lunar_netplay
  - tournament/...  source lunar_tournament
Entries already stored (by name) are never downloaded again. A game is also skipped if its stat
fingerprint (characters + four game-specific stats) is already in the DB: the same game arriving
under another file, name or anonymisation, or both players' uploads of one netplay match.

Resumable with no other bookkeeping: an entry counts as handled once it's stored (its name is a
row) or recorded in the `lunar_skipped` table (duplicate, unreadable, not 1v1), committed in the
same transaction as the rows. A re-run plans its chunks from the entries not yet handled. Lunar allows 2
full-database links per 24 h; one link serves every connection and is reused for up to 50 min.

Requires the `slpz` CLI (`cargo install slpz`). Options go BEFORE the input path.
"""
import argparse, collections, hashlib, json, os, queue, shutil, struct, subprocess, sys, tempfile
import threading, time, urllib.error, urllib.request, zipfile
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
LOGS = os.path.join(HERE, "logs")

CHUNK_BYTES = 3_000_000_000   # ~7k replays: small enough that a redo is cheap
MERGE_GAP_BYTES = 50_000_000  # download (and discard) skipped entries rather than split a chunk

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


_log_lock = threading.Lock()


def log(msg):
    with _log_lock:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ── Where an entry goes ────────────────────────────────────────────────────────────────────────

RANKED_DIR, NETPLAY_DIR, TOURNAMENT_DIR = "ranked_anonymized", "netplay", "tournament"


def db_filename(name):
    """The StatsDB key. Ranked entries keep erickfm's own file name, so the two sets line up."""
    if name.startswith(RANKED_DIR + "/"):
        return name.rsplit("/", 1)[1][:-len(".slpz")] + ".slp"
    return f"lunar/{name}"


# ── Zip reading ───────────────────────────────────────────────────────────────────────────────

LOCAL_SIG, CENTRAL_SIG = b"PK\x03\x04", b"PK\x01\x02"


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
    return name, read_exact(stream, csize), 30 + nlen + xlen + csize


def parse_central_directory(cd: bytes):
    """[(local_header_offset, name)] for every entry, in file order."""
    out, i = [], 0
    while i + 46 <= len(cd) and cd[i:i + 4] == CENTRAL_SIG:
        csize, usize, nlen, xlen, clen = struct.unpack("<IIHHH", cd[i + 20:i + 34])
        off = struct.unpack("<I", cd[i + 42:i + 46])[0]
        name = cd[i + 46:i + 46 + nlen].decode("utf-8", "replace")
        extra = cd[i + 46 + nlen:i + 46 + nlen + xlen]
        if off == 0xFFFFFFFF:  # zip64 fields appear in order: usize, csize, offset (only if maxed)
            vals, j = [], 0
            while j + 4 <= len(extra):
                tag, sz = struct.unpack("<HH", extra[j:j + 4])
                if tag == 0x0001:
                    vals = list(struct.unpack("<" + "Q" * (sz // 8), extra[j + 4:j + 4 + sz]))
                j += 4 + sz
            if usize == 0xFFFFFFFF:
                vals.pop(0)
            if csize == 0xFFFFFFFF:
                vals.pop(0)
            off = vals.pop(0)
        out.append((off, name))
        i += 46 + nlen + xlen + clen
    out.sort()
    return out


# ── Sources: a local zip, or a Lunar bundle over HTTP ─────────────────────────────────────────

class LinkBudgetExhausted(Exception):
    pass


def link_expiry(link) -> float:
    """When a signed link stops accepting NEW requests: X-Amz-Date + X-Amz-Expires from the URL
    itself (R2 presigned), else LINK_REUSE_S after it was fetched."""
    import calendar, urllib.parse
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(link["url"]).query)
    try:
        signed = calendar.timegm(time.strptime(q["X-Amz-Date"][0], "%Y%m%dT%H%M%SZ"))
        return signed + int(q["X-Amz-Expires"][0])
    except (KeyError, ValueError):
        return link["at"] + LINK_REUSE_S


class LocalZip:
    def __init__(self, path):
        self.path = path

    def index(self):
        with zipfile.ZipFile(self.path) as z:
            ents = sorted((i.header_offset, i.filename) for i in z.infolist())
            cd_off = z.start_dir
        return ents, cd_off

    def open_range(self, start, end):
        fh = open(self.path, "rb")
        fh.seek(start)
        return fh


class LunarBundle:
    """One signed link, shared by every connection; refreshed (within the daily budget) when old."""

    def __init__(self, bundle_id, state, save_state):
        self.bundle, self.state, self.save_state = bundle_id, state, save_state
        self.full_db = bundle_id == FULL_DB_BUNDLE
        self.lock = threading.Lock()

    def link(self):
        with self.lock:
            now = time.time()
            link = self.state.get("link")
            if link and now < link_expiry(link) - 90:
                return link["url"]
            issued = [t for t in self.state.get("links_issued", []) if now - t < 24 * 3600]
            if self.full_db and len(issued) >= LINKS_PER_DAY:
                wait_h = (24 * 3600 - (now - min(issued))) / 3600
                raise LinkBudgetExhausted(
                    f"Lunar allows {LINKS_PER_DAY} full-database links a day; the next is available "
                    f"in {wait_h:.1f} h. Re-run then.")
            req = urllib.request.Request(f"{API}/api/jobs/{self.bundle}/download",
                                         headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as res:
                body = json.load(res)
            url = body.get("url") or body.get("downloadUrl")
            if not url:
                raise RuntimeError(f"no download url in Lunar's reply: {str(body)[:300]}")
            self.state["link"] = {"url": url, "at": now}
            if self.full_db:
                self.state["links_issued"] = issued + [now]
                log(f"new full-database link ({len(self.state['links_issued'])}/{LINKS_PER_DAY} today)")
            else:
                log(f"new link for bundle {self.bundle}")
            self.save_state()
            return url

    def _get(self, start, end=None):
        rng = f"bytes={start}-" + ("" if end is None else str(end))
        req = urllib.request.Request(self.link(), headers={"User-Agent": USER_AGENT, "Range": rng})
        res = urllib.request.urlopen(req, timeout=120)
        if res.status != 206:
            res.close()
            raise RuntimeError(f"server ignored the Range request (HTTP {res.status})")
        return res

    def index(self):
        os.makedirs(LOGS, exist_ok=True)
        cache = os.path.join(LOGS, f"lunar_cd_{self.bundle}")
        if os.path.exists(cache + ".json") and os.path.exists(cache + ".bin"):
            meta = json.load(open(cache + ".json"))
            cd = open(cache + ".bin", "rb").read()
        else:
            with self._get(0, 0) as r:
                total = int(r.headers["Content-Range"].split("/")[1])
            with self._get(max(0, total - 65536), total - 1) as r:
                tail = r.read()
            loc = tail.rfind(b"PK\x06\x07")
            if loc >= 0:
                z64_off = struct.unpack("<Q", tail[loc + 8:loc + 16])[0]
                with self._get(z64_off, z64_off + 55) as r:
                    z64 = r.read()
                _, cd_size, cd_off = struct.unpack("<QQQ", z64[32:56])
            else:
                eocd = tail.rfind(b"PK\x05\x06")
                cd_size, cd_off = struct.unpack("<II", tail[eocd + 12:eocd + 20])
            with self._get(cd_off, cd_off + cd_size - 1) as r:
                cd = r.read()
            open(cache + ".bin", "wb").write(cd)
            meta = {"cd_off": cd_off, "cd_size": cd_size}
            json.dump(meta, open(cache + ".json", "w"))
        return parse_central_directory(cd), meta["cd_off"]

    def open_range(self, start, end):
        return self._get(start, end - 1)


# ── Worker: one replay ─────────────────────────────────────────────────────────────────────────

_tmp = None


def _worker_init():
    global _tmp
    _tmp = tempfile.mkdtemp(prefix="lunar_")
    import parse_hf_replays  # noqa: F401  (load once per worker)


def netplay_mode(path):
    import peppi_py as peppi
    start = peppi.read_slippi(path, skip_frames=True).start
    mid = (getattr(getattr(start, "match", None), "id", None) or "")
    for mode in ("ranked", "unranked", "direct"):
        if mid.startswith(f"mode.{mode}"):
            return f"lunar_{mode}"
    return "lunar_netplay"


def process_entry(args):
    """(name, slpz bytes) -> (name, outcome, source, rank, rank_pair, results). Never raises."""
    import parse_hf_replays as P
    name, data = args
    src, slp = os.path.join(_tmp, "in.slpz"), os.path.join(_tmp, "out.slp")
    try:
        with open(src, "wb") as fh:
            fh.write(data)
        r = subprocess.run(["slpz", "-q", "-d", "-o", slp, src], capture_output=True)
        if r.returncode != 0 or not os.path.exists(slp):
            return name, "slpz_failed", None, None, None, None
        folder = name.split("/", 1)[0]
        rank = rank_pair = None
        try:
            if folder == RANKED_DIR:
                source = "ranked"
                pair = P.parse_rank_pair(db_filename(name))
                rank_pair = f"{pair[0]}-{pair[1]}" if pair else None
                rank = pair[0] if pair and pair[0] == pair[1] else None
            elif folder == NETPLAY_DIR:
                source = netplay_mode(slp)
            elif folder == TOURNAMENT_DIR:
                source = "lunar_tournament"
            else:
                # A job bundle: flat names, no archive folders. The match id still tells netplay
                # modes apart; anything without one is a console game.
                mode = netplay_mode(slp)
                source = "lunar_console" if mode == "lunar_netplay" else mode
        except BaseException:  # peppi panics are BaseException
            return name, "unreadable", None, None, None, None
        results = P.process_both_ports(slp)
        if not results:
            return name, "not_1v1_or_unreadable", None, None, None, None
        return name, "parsed", source, rank, rank_pair, results
    finally:
        for p in (src, slp):
            try:
                os.remove(p)
            except OSError:
                pass


# ── Planning ──────────────────────────────────────────────────────────────────────────────────

def plan_chunks(index, cd_off, wanted, chunk_bytes=CHUNK_BYTES):
    """Contiguous byte ranges covering every wanted entry, cut at ~chunk_bytes. Each chunk is
    (chunk_id, start, end, [names wanted in it]); end is the next entry's offset. Smallest first:
    stray single entries are one request each, so they go while the link is fresh."""
    bounds = [off for off, _ in index] + [cd_off]
    chunks, cur = [], None
    for k, (off, name) in enumerate(index):
        if name not in wanted:
            continue
        end = bounds[k + 1]
        if cur and off - cur[2] <= MERGE_GAP_BYTES and end - cur[1] <= chunk_bytes:
            cur[2] = end
            cur[3].append(name)
        else:
            if cur:
                chunks.append(cur)
            cur = [None, off, end, [name]]
        # a chunk is identified by its start offset, which is stable across runs
    if cur:
        chunks.append(cur)
    return sorted(((f"{c[1]}", c[1], c[2], c[3]) for c in chunks), key=lambda c: c[2] - c[1])


# ── State ─────────────────────────────────────────────────────────────────────────────────────

def load_state(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {"counts": {}, "links_issued": []}


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
    keep, drop = set(), []
    for row in con.execute(f"SELECT filename, port, player_char, opp_char, {cols} FROM games "
                           f"ORDER BY filename, port"):
        fp = fingerprint(row[2], row[3], dict(zip(FINGERPRINT_STATS, row[4:])))
        if fp in keep:
            drop.append((row[0], row[1]))
        else:
            keep.add(fp)
    with con:
        con.executemany("DELETE FROM games WHERE filename = ? AND port = ?", drop)
    log(f"dropped {len(drop):,} duplicate rows; {len(keep):,} remain")
    con.execute("VACUUM")
    con.close()


def relabel_lunar_rows(db):
    """Rows stored before sources came from the archive's folders (2026-10-15 morning run):
    tournament/ was labelled lunar_console; netplay/ games without a match id likewise."""
    with db.con:
        a = db.con.execute("UPDATE games SET source = 'lunar_tournament' "
                           "WHERE filename LIKE 'lunar/tournament/%' AND source != 'lunar_tournament'").rowcount
        b = db.con.execute("UPDATE games SET source = 'lunar_netplay' "
                           "WHERE filename LIKE 'lunar/netplay/%' AND source = 'lunar_console'").rowcount
    if a or b:
        log(f"relabelled {a:,} tournament and {b:,} netplay rows by their archive folder")


# ── Main ──────────────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src_group = ap.add_mutually_exclusive_group()
    src_group.add_argument("--zip", help="a local Lunar bundle")
    src_group.add_argument("--bundle", help="a Lunar bundle/job id over HTTP (default: the full database)")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--checkpoint", help="default: scripts/lunar_<bundle>.checkpoint.json or <zip>.checkpoint.json")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    ap.add_argument("--connections", type=int, default=6, help="chunks downloaded at once")
    ap.add_argument("--chunk-gb", type=float, default=0,
                    help="bytes per request, in GB (default: the remaining span split evenly across "
                         "--connections, so one link covers the whole run)")
    ap.add_argument("--window", type=int, default=0, help="replays in flight (default 40×workers)")
    ap.add_argument("--batch", type=int, default=2000, help="replays per DB commit")
    ap.add_argument("--limit", type=int, default=0, help="stop soon after this many replays (0 = all; "
                                                      "approximate: work already queued still lands)")
    ap.add_argument("--min-free-gb", type=float, default=20.0)
    args = ap.parse_args()

    if shutil.which("slpz") is None:
        raise SystemExit("slpz not found on PATH: cargo install slpz")
    import parse_hf_replays as P
    from stats_db import StatsDB
    from run_rescan import keep_awake

    bundle = args.bundle or FULL_DB_BUNDLE
    ckpt = args.checkpoint or (args.zip + ".checkpoint.json" if args.zip
                               else os.path.join(HERE, f"lunar_{bundle}.checkpoint.json"))
    state = load_state(ckpt)
    persist = lambda: save_state(ckpt, state)  # noqa: E731
    source = LocalZip(args.zip) if args.zip else LunarBundle(bundle, state, persist)

    prepare_db(args.db)
    db = StatsDB(args.db, P.STAT_KEYS)
    relabel_lunar_rows(db)
    db.con.execute("CREATE TABLE IF NOT EXISTS lunar_skipped (name TEXT PRIMARY KEY, outcome TEXT NOT NULL)")
    stored = {r[0] for r in db.con.execute("SELECT DISTINCT filename FROM games")}
    skipped = {r[0] for r in db.con.execute("SELECT name FROM lunar_skipped")}
    log(f"DB {os.path.basename(args.db)}: {db.count():,} rows, {len(stored):,} replays; fingerprinting…")
    cols = ", ".join(f'"{k}"' for k in FINGERPRINT_STATS)
    seen = {fingerprint(r[0], r[1], dict(zip(FINGERPRINT_STATS, r[2:])))
            for r in db.con.execute(f"SELECT player_char, opp_char, {cols} FROM games")}

    try:
        index, cd_off = source.index()
    except LinkBudgetExhausted as e:
        log(str(e))
        return
    wanted = {n for _, n in index
              if n.endswith(".slpz") and db_filename(n) not in stored and n not in skipped}
    by_dir = collections.Counter(n.split("/", 1)[0] if "/" in n else "(flat bundle)" for n in wanted)
    # The full database's signed link lasts an hour and only 2 are issued a day; storage lets a
    # request that STARTED in time run on past expiry, but not a new one. So by default each
    # connection gets one long segment, all started within minutes of the link being issued.
    span = sum(e - s_ for _, s_, e, _ in plan_chunks(index, cd_off, wanted))
    chunk_bytes = int(args.chunk_gb * 1e9) if args.chunk_gb else max(CHUNK_BYTES, span // args.connections + 1)
    chunks = plan_chunks(index, cd_off, wanted, chunk_bytes)
    log(f"index: {len(index):,} entries; still wanted {len(wanted):,} ({dict(by_dir)}); "
        f"{len(chunks):,} chunks to go, {sum(c[2] - c[1] for c in chunks) / 1e9:,.0f} GB")

    window = args.window or 40 * args.workers
    slots = threading.BoundedSemaphore(window)
    results = queue.Queue()        # (chunk_id, name, AsyncResult) or (chunk_id, None, error|"done")
    todo = queue.Queue()
    for c in chunks:
        todo.put(c)
    stop = threading.Event()
    disk_paths = [os.path.dirname(os.path.abspath(args.db)), tempfile.gettempdir()]
    counts = collections.Counter(state["counts"])

    release = keep_awake()
    pool = Pool(args.workers, initializer=_worker_init)

    def reader():
        """Download chunks one at a time; hand each wanted entry to the pool."""
        while not stop.is_set():
            try:
                cid, start, end, names = todo.get_nowait()
            except queue.Empty:
                return
            want, pos, attempts = set(names), start, 0
            while pos < end and not stop.is_set():
                try:
                    stream = source.open_range(pos, end)
                    try:
                        while pos < end and not stop.is_set():
                            name, data, used = next_entry(stream)
                            pos += used
                            if name in want:
                                slots.acquire()
                                results.put((cid, name, pool.apply_async(process_entry, ((name, data),))))
                    finally:
                        stream.close()
                except LinkBudgetExhausted as e:
                    log(str(e))
                    stop.set()
                except (OSError, EOFError, urllib.error.URLError, ValueError, RuntimeError) as e:
                    attempts += 1
                    if attempts > 8:
                        log(f"chunk {cid}: giving up after {attempts} tries ({e}); a re-run retries it")
                        break
                    log(f"chunk {cid}: {type(e).__name__}: {e}; retrying from byte {pos:,} in {5 * attempts}s")
                    time.sleep(5 * attempts)
            results.put((cid, None, "done" if pos >= end else "incomplete"))

    threads = [threading.Thread(target=reader, daemon=True) for _ in range(args.connections)]
    for t in threads:
        t.start()

    records, skips, since_commit, total = [], [], 0, 0
    chunks_through = 0
    t0, last_log = time.time(), time.time()

    def commit():
        """Rows and skips land in one transaction: together they ARE the resume state."""
        nonlocal records, skips, since_commit
        with db.con:
            if skips:
                db.con.executemany("INSERT OR IGNORE INTO lunar_skipped (name, outcome) VALUES (?, ?)", skips)
            if records:
                db.insert_batch(records)  # its inner `with con` commits the skips and rows together
        records, skips, since_commit = [], [], 0
        state.update(counts=dict(counts))
        persist()

    try:
        while True:
            if all(not t.is_alive() for t in threads) and results.empty():
                break
            try:
                cid, name, item = results.get(timeout=1)
            except queue.Empty:
                continue
            if name is None:
                chunks_through += item == "done"
                continue
            _, outcome, src, rank, rank_pair, rows = item.get()
            slots.release()
            if outcome == "parsed":
                fps = [fingerprint(pc, oc, stats) for stats, pc, oc, _ in rows]
                if any(f in seen for f in fps):
                    outcome = "duplicate"
                else:
                    seen.update(fps)
                    records.extend(P.make_records(db_filename(name), src, rank, rank_pair, rows))
                    outcome = f"added:{src}"
            if not outcome.startswith("added:"):
                skips.append((name, outcome))
            counts[outcome] += 1
            total += 1
            since_commit += 1
            if since_commit >= args.batch:
                commit()
                problem = check_disk(disk_paths, args.min_free_gb)
                if problem:
                    log(f"STOPPING: {problem}. Checkpointed; free some space and re-run.")
                    stop.set()
            if args.limit and total >= args.limit:
                stop.set()
            if time.time() - last_log >= 30:
                last_log = time.time()
                rate = total / max(1e-9, time.time() - t0)
                left = len(wanted) - total
                log(f"{total:,} this run · {rate:,.0f}/s · ~{left / max(rate, 1e-9) / 3600:.1f} h left · "
                    f"chunks {chunks_through:,}/{len(chunks):,} · "
                    + ", ".join(f"{k} {v:,}" for k, v in sorted(counts.items())))
        commit()
    finally:
        stop.set()
        pool.terminate()
        db.close()
        release()
    rate = total / max(1e-9, time.time() - t0)
    log(f"stopped: {total:,} replays this run ({rate:,.0f}/s); chunks {chunks_through:,}/{len(chunks):,}. "
        + ", ".join(f"{k} {v:,}" for k, v in sorted(counts.items())))


if __name__ == "__main__":
    main()
