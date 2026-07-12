"""Tests for the melee-ranked-replays scan mode (stats_db + rank parsing).

Run:  .venv/bin/python -m pytest scripts/test_ranked_scan.py -q
"""
import os
import sqlite3

import pytest

from stats_db import StatsDB
from parse_hf_replays import STAT_KEYS, parse_rank_pair

# Two real dataset tarballs (PICHU master-master a3 + master-platinum a1),
# kept out of git — the tarball test skips when they aren't present.
PROBE_DIR = os.environ.get(
    "RANKED_PROBE_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "TestingSLPFiles", "ranked-probe"),
)


# ── parse_rank_pair ───────────────────────────────────────────────────────────

def test_same_rank_pair():
    assert parse_rank_pair("master-master-352042b65130720d6407ada7.slp") == ("master", "master")

def test_mixed_rank_pair():
    assert parse_rank_pair("master-platinum-0a8059dc72f38b5cf1571b79.slp") == ("master", "platinum")

def test_non_rank_filename_returns_none():
    assert parse_rank_pair("Game_20240101T120000.slp") is None

def test_path_prefix_is_stripped():
    assert parse_rank_pair("some/dir/diamond-diamond-abc123.slp") == ("diamond", "diamond")


# ── StatsDB ───────────────────────────────────────────────────────────────────

def make_stats(**overrides):
    stats = {k: 0.5 for k in STAT_KEYS}
    stats.update(overrides)
    return stats

def test_insert_and_dedup(tmp_path):
    db = StatsDB(str(tmp_path / "t.sqlite"), STAT_KEYS)
    rec = ("f1.slp", 0, "ranked", "Fox", "Marth", "master", "master-master", make_stats())
    assert db.insert_batch([rec]) == 1
    # exact duplicate ignored
    assert db.insert_batch([rec]) == 0
    # same file, other port is a new row
    rec2 = ("f1.slp", 1, "ranked", "Marth", "Fox", "master", "master-master", make_stats())
    assert db.insert_batch([rec2]) == 1
    assert db.count() == 2
    db.close()

def test_seen(tmp_path):
    db = StatsDB(str(tmp_path / "t.sqlite"), STAT_KEYS)
    assert not db.seen("f1.slp")
    db.insert_batch([("f1.slp", 0, "ranked", "Fox", "Marth", None, "master-platinum", make_stats())])
    assert db.seen("f1.slp")
    db.close()

def test_none_stats_stored_as_null(tmp_path):
    path = str(tmp_path / "t.sqlite")
    db = StatsDB(path, STAT_KEYS)
    stats = make_stats(**{STAT_KEYS[0]: None})
    db.insert_batch([("f1.slp", 0, "ranked", "Fox", "Marth", "master", "master-master", stats)])
    db.close()
    con = sqlite3.connect(path)
    val = con.execute(f"SELECT {STAT_KEYS[0]} FROM games").fetchone()[0]
    con.close()
    assert val is None

def test_reopen_preserves_rows(tmp_path):
    path = str(tmp_path / "t.sqlite")
    db = StatsDB(path, STAT_KEYS)
    db.insert_batch([("f1.slp", 0, "ranked", "Fox", "Marth", "master", "master-master", make_stats())])
    db.close()
    db2 = StatsDB(path, STAT_KEYS)
    assert db2.count() == 1
    assert db2.seen("f1.slp")
    db2.close()


# ── build_baselines_from_db ───────────────────────────────────────────────────

def seed_db(path, n_per_char=25):
    """Two matchups' worth of synthetic rows: Fox vs Marth (ranked, master)
    and Marth vs Fox mirrors, plus a handful of v37 rows."""
    db = StatsDB(path, STAT_KEYS)
    recs = []
    for i in range(n_per_char):
        recs.append((f"m-{i}.slp", 0, "ranked", "Fox", "Marth", "master", "master-master",
                     make_stats(neutral_win_ratio=0.6)))
        recs.append((f"m-{i}.slp", 1, "ranked", "Marth", "Fox", "master", "master-master",
                     make_stats(neutral_win_ratio=0.4)))
    for i in range(5):
        recs.append((f"FOX/v37-{i}.slp", 0, "v37", "Fox", "Marth", None, None,
                     make_stats(neutral_win_ratio=0.8)))
    db.insert_batch(recs)
    db.close()

def test_build_baselines_from_db(tmp_path):
    from parse_hf_replays import build_baselines_from_db
    db_path = str(tmp_path / "t.sqlite")
    out_path = str(tmp_path / "baselines.json")
    seed_db(db_path)
    build_baselines_from_db(db_path, out_path)

    import json
    with open(out_path) as f:
        data = json.load(f)

    # same top-level shape regen_benchmarks.py expects
    assert "_overall" in data["by_player_char"]
    assert data["by_player_char"]["Fox"]["sample_size"] == 30          # 25 ranked + 5 v37
    assert data["by_player_char"]["Marth"]["sample_size"] == 25
    # matchup below MIN_MATCHUP_SAMPLES threshold is dropped, above kept
    assert "Marth" in data["by_matchup"]["Fox"]
    # pooled = ranked + v37 values mixed
    fox_nwr = data["by_player_char"]["Fox"]["neutral_win_ratio"]
    assert fox_nwr["sample_size"] == 30
    assert 0.6 < fox_nwr["avg"] < 0.7
    # by_rank captures ranked-only, per-rank
    assert data["by_rank"]["master"]["_overall"]["neutral_win_ratio"]["sample_size"] == 50
    assert data["by_rank"]["master"]["Fox"]["neutral_win_ratio"]["avg"] == 0.6
    # source counts recorded
    assert data["sources"] == {"ranked": 50, "v37": 5}

def test_make_records_maps_ports_and_rank():
    from parse_hf_replays import make_records
    results = [(make_stats(), "Fox", "Marth", 0), (make_stats(), "Marth", "Fox", 1)]
    recs = make_records("f.slp", "ranked", "master", "master-master", results)
    assert [(r[0], r[1], r[2], r[3], r[4], r[5], r[6]) for r in recs] == [
        ("f.slp", 0, "ranked", "Fox", "Marth", "master", "master-master"),
        ("f.slp", 1, "ranked", "Marth", "Fox", "master", "master-master"),
    ]


# ── scan_tarball_file against real probe tarballs ────────────────────────────

@pytest.mark.skipif(not os.path.exists(os.path.join(PROBE_DIR, "mm_a3.tar.gz")),
                    reason="probe tarballs not present on this machine")
def test_scan_real_tarball(tmp_path):
    from parse_hf_replays import scan_tarball_file
    db = StatsDB(str(tmp_path / "t.sqlite"), STAT_KEYS)

    new, dup, err = scan_tarball_file(os.path.join(PROBE_DIR, "mm_a3.tar.gz"), db,
                                      work_dir=str(tmp_path / "x1"))
    assert new == 4 and dup == 0 and err == 0        # 4 replays, 1 row per port = 8 rows
    assert db.count() == 8

    # same-rank pair → rank attributed to both ports
    con = sqlite3.connect(str(tmp_path / "t.sqlite"))
    ranks = {r[0] for r in con.execute("SELECT DISTINCT rank FROM games")}
    assert ranks == {"master"}

    # mixed-pair tarball → rank NULL, rank_pair kept
    new, dup, err = scan_tarball_file(os.path.join(PROBE_DIR, "mp_a1.tar.gz"), db,
                                      work_dir=str(tmp_path / "x2"))
    assert new == 9 and dup == 0 and err == 0
    mixed = con.execute("SELECT rank, rank_pair FROM games WHERE rank_pair='master-platinum'").fetchall()
    assert len(mixed) == 18
    assert all(r[0] is None for r in mixed)

    # re-scan of the same tarball is fully deduped
    new, dup, err = scan_tarball_file(os.path.join(PROBE_DIR, "mm_a3.tar.gz"), db,
                                      work_dir=str(tmp_path / "x3"))
    assert new == 0 and dup == 4
    assert db.count() == 26
    con.close()
    db.close()
