"""Match Lunar API records (from lunar_nonlegal_fetch.py) to raw_stats_v3 games by character pair + start time.

Slippi names netplay replays Game_YYYYMMDDTHHMMSS from the game's LOCAL start time; Lunar's
`startAt` is the same instant in UTC. So a game matches on its character pair and on a start time
that differs from `startAt` by a whole time-zone offset (a multiple of 15 min, within ±14 h),
allowing ±1 s for rounding. Ambiguous matches are all kept: excluding a stray legal game costs
nothing, keeping a non-legal one is what we're trying to avoid.

usage: lunar_nonlegal_match.py <db> <records: .jsonl from the fetcher | .json API page> [--write]
"""
import collections, json, re, sqlite3, sys
from datetime import datetime, timezone

TS = re.compile(r"Game_(\d{8}T\d{6})")


def load_records(path):
    if path.endswith(".jsonl"):
        for line in open(path, encoding="utf-8"):
            r = json.loads(line)
            yield r.get("stageName"), [p["char"] for p in r["players"]], r.get("startAt")
    else:
        for r in json.load(open(path, encoding="utf-8"))["replays"]:
            yield r.get("stageName"), [p["characterName"] for p in r["players"]], r.get("startAt")


def main():
    db, path = sys.argv[1], sys.argv[2]
    con = sqlite3.connect(db)
    chars = collections.defaultdict(list)
    for fn, pc in con.execute("SELECT filename, player_char FROM games WHERE source LIKE 'lunar%'"):
        chars[fn].append(pc)
    index = collections.defaultdict(list)   # (charA, charB, second-of-15-min) -> [(filename, local ts)]
    for fn, cs in chars.items():
        m = TS.search(fn)
        if not m or len(cs) != 2:
            continue
        t = datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc).timestamp()
        index[(*sorted(cs), int(t) % 900)].append((fn, t))
    print(f"indexed {sum(map(len, index.values())):,} timestamped lunar games", flush=True)

    outcome, matched, by_stage = collections.Counter(), set(), collections.Counter()
    for stage, cs, start in load_records(path):
        if len(cs) != 2 or not start:
            outcome["not_1v1_or_no_time"] += 1
            continue
        u = datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp()
        cands = [(fn, t) for ds in (-1, 0, 1)
                 for fn, t in index.get((*sorted(cs), (int(u) + ds) % 900), ())
                 if abs(t - u) <= 14 * 3600 + 1]
        # Most players sit in whole-hour time zones; only fall back to :30/:45 ones when no
        # whole-hour candidate exists.
        whole = [(fn, t) for fn, t in cands if min((t - u) % 3600, -(t - u) % 3600) <= 1]
        hits = {fn for fn, _ in (whole or cands)}
        outcome["no_match" if not hits else "unique" if len(hits) == 1 else "ambiguous"] += 1
        matched |= hits
        if hits:
            by_stage[stage] += 1
    print(dict(outcome))
    print(f"filenames matched: {len(matched):,}")
    print("by stage:", by_stage.most_common())
    if "--write" in sys.argv:
        with con:
            con.execute("CREATE TABLE IF NOT EXISTS benchmark_excluded (filename TEXT PRIMARY KEY, reason TEXT)")
            con.executemany("INSERT OR IGNORE INTO benchmark_excluded VALUES (?, 'non_legal_stage')",
                            [(f,) for f in matched])
        print("written")


main()
