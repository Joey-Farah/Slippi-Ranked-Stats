"""Benchmark-parser parity: compute_game_stats must reproduce the app parser's numbers.

A player's per-game value (slp_parser.ts) is percentile-scored against the distribution this
script builds, so any per-game disagreement silently shifts every grade. expected.json is the
app parser's output on real replays (see scripts/gen_parity_expected.ts); src/lib/parity.test.ts
keeps it in sync with the parser.
"""
import json
import os

import pytest

import parse_hf_replays as P
import peppi_py as peppi

DIR = os.path.join(os.path.dirname(__file__), "parity_fixtures")
with open(os.path.join(DIR, "expected.json"), encoding="utf-8") as fh:
    EXPECTED = json.load(fh)

CASES = [(f, port) for f in sorted(EXPECTED) for port in sorted(EXPECTED[f])]


def _close(a, b):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= max(1e-3, 0.01 * abs(b))   # 1%: avg_stock_duration differs by a frame


@pytest.mark.parametrize("fixture,port", CASES)
def test_benchmark_matches_app(fixture, port):
    game = peppi.read_slippi(os.path.join(DIR, fixture))
    players = [p for p in game.start.players if p is not None]
    idx = [int(p.port.value) for p in players].index(int(port))
    stats = P.compute_game_stats(game, idx, 1 - idx)
    want = EXPECTED[fixture][port]
    diffs = {k: (stats.get(k), v) for k, v in want.items() if not _close(stats.get(k), v)}
    assert not diffs, f"(benchmark, app) disagree: {diffs}"
