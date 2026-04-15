#!/usr/bin/env python3
"""
fetch_slippilab_replays.py — Build grade baselines from SlippiLab community replays.

Downloads .slp files one at a time from the SlippiLab public API, computes
performance stats for both player ports immediately, then deletes the file.
Never stores more than one replay on disk at a time.

Outputs grade_baselines.json with two grouping dimensions:
  - by_player_char: benchmarks for each character the user might PLAY
  - by_opponent_char: benchmarks vs each character the user might FACE

Some stats are inherently character-specific (damage/opening, kill %) and
should be compared against by_player_char. Others are more universal
(neutral win ratio) and can fall back to _overall if no character data exists.

Usage:
    python scripts/fetch_slippilab_replays.py [--limit 1000] [--output scripts/grade_baselines.json]

Requirements: py-slippi, numpy  (pip install -r scripts/requirements.txt)
"""

import argparse
import json
import os
import sys
import tempfile
import urllib.request
import urllib.error
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone

import numpy as np
from slippi import Game
from slippi.event import LCancel

# ── Constants ─────────────────────────────────────────────────────────────────

BASE_URL    = "https://slippilab.com"
TIMEOUT     = 30   # seconds per HTTP request
MAX_WORKERS = 4    # parallel download+parse workers (py-slippi is GIL-bound, so processes)

# Internal character IDs as used by the game binary (mirrors parser.ts CHARACTERS).
CHARACTERS: dict[int, str] = {
    0:  "Mario",            1:  "Fox",           2:  "Captain Falcon",
    3:  "Donkey Kong",      4:  "Kirby",          5:  "Bowser",
    6:  "Link",             7:  "Sheik",          8:  "Ness",
    9:  "Peach",            10: "Ice Climbers",   12: "Pikachu",
    13: "Samus",            14: "Yoshi",          15: "Jigglypuff",
    16: "Mewtwo",           17: "Luigi",          18: "Marth",
    19: "Zelda",            20: "Young Link",     21: "Dr. Mario",
    22: "Falco",            23: "Pichu",          24: "Mr. Game & Watch",
    25: "Ganondorf",        26: "Roy",
}

# Stats included in baselines.
# Grouped to clarify which dimension each stat is most meaningful for:
#
#   CHARACTER-SPECIFIC (compare vs same player character):
#     openings_per_kill   — Fox combos kill in 2 openings; Jiggs needs 5+
#     damage_per_opening  — Fox/Falco routinely deal 40+; Jiggs/Puff much less
#     avg_kill_percent    — Marth kills at 80–100%; Jiggs kills at 110–140%
#     avg_death_percent   — weight-dependent; heavier chars survive longer
#     l_cancel_ratio      — aerial-heavy chars (Fox, Falco, Marth) have more attempts
#
#   CROSS-CHARACTER (fair to compare to all players):
#     neutral_win_ratio   — winning neutral is a universal skill; all chars aim for ~50%+
#
STAT_KEYS = [
    "neutral_win_ratio",
    "openings_per_kill",
    "damage_per_opening",
    "l_cancel_ratio",
    "avg_kill_percent",
    "avg_death_percent",
]

# ── Action-state helpers (mirrors slippi-js common.ts / slp_parser.ts) ────────
# The previous ranges here diverged from the authoritative slippi-js source and
# caused severe miscounting (e.g. states 0–10 are DYING, not control). The
# ranges below match src/lib/slp_parser.ts exactly so baseline stats stay
# consistent with the values the live app computes.

def is_in_control(state: int) -> bool:
    return (
        (14 <= state <= 24) or   # grounded control + controlled jump
        (39 <= state <= 41) or   # squat
        (45 <= state <= 64) or   # ground attack
        state == 212             # grab
    )

def is_vulnerable(state: int) -> bool:
    return (
        (0   <= state <= 10)  or   # dying
        (75  <= state <= 91)  or   # damaged
        (183 <= state <= 198) or   # down
        (199 <= state <= 204) or   # teching
        (223 <= state <= 232)      # grabbed
    )

# ── Stat computation ───────────────────────────────────────────────────────────

def compute_game_stats(game, player_port: int, opp_port: int):
    """
    Compute all performance stats for player_port in the given pre-parsed Game.

    Returns a dict with all STAT_KEYS, or None if stats can't be computed.
    Values may be None for stats that couldn't be computed (e.g. 0 kills).
    Accepts a pre-parsed Game object so the caller can parse once and reuse
    across both ports (avoids the 3x parse that was a major bottleneck).
    """
    neutral_wins   = 0
    neutral_losses = 0
    prev_p_ctrl    = False
    prev_o_ctrl    = False
    lc_attempts    = 0
    lc_successes   = 0

    # Per-stock kill/death percent tracking
    kill_percents:  list[float] = []   # opp % at moment of each kill
    death_percents: list[float] = []   # player % at moment of each death

    prev_opp_stocks    = None
    prev_player_stocks = None
    prev_opp_damage    = 0.0
    prev_player_damage = 0.0

    # For damage_per_opening we accumulate total damage dealt across all stocks
    total_damage_dealt = 0.0
    damage_this_stock  = 0.0

    for frame in game.frames:
        p_data = frame.ports[player_port]
        o_data = frame.ports[opp_port]
        if p_data is None or o_data is None:
            continue

        p_post = p_data.leader.post
        o_post = o_data.leader.post

        p_state = int(p_post.state) if p_post.state is not None else 0
        o_state = int(o_post.state) if o_post.state is not None else 0

        # ── Neutral win/loss transitions ──────────────────────────────────────
        if prev_o_ctrl and is_vulnerable(o_state):
            neutral_wins += 1
        if prev_p_ctrl and is_vulnerable(p_state):
            neutral_losses += 1
        prev_p_ctrl = is_in_control(p_state)
        prev_o_ctrl = is_in_control(o_state)

        # ── L-cancel tracking ─────────────────────────────────────────────────
        lc = p_post.l_cancel
        if lc is not None:
            lc_attempts += 1
            if lc == LCancel.SUCCESS:
                lc_successes += 1

        # ── Kill / death percent tracking ─────────────────────────────────────
        curr_opp_stocks    = o_post.stocks if o_post.stocks is not None else prev_opp_stocks
        curr_player_stocks = p_post.stocks if p_post.stocks is not None else prev_player_stocks
        curr_opp_damage    = float(o_post.damage)    if o_post.damage    is not None else 0.0
        curr_player_damage = float(p_post.damage)    if p_post.damage    is not None else 0.0

        if prev_opp_stocks is not None and curr_opp_stocks is not None:
            if curr_opp_stocks < prev_opp_stocks:
                # We scored a kill — record the % they were at
                kill_percents.append(prev_opp_damage)
                total_damage_dealt += damage_this_stock
                damage_this_stock = 0.0
            else:
                damage_this_stock = curr_opp_damage

        if prev_player_stocks is not None and curr_player_stocks is not None:
            if curr_player_stocks < prev_player_stocks:
                # We died — record the % we were at
                death_percents.append(prev_player_damage)

        prev_opp_stocks    = curr_opp_stocks
        prev_player_stocks = curr_player_stocks
        prev_opp_damage    = curr_opp_damage
        prev_player_damage = curr_player_damage

    # Capture damage on the final stock (game ended before a stock was taken)
    if damage_this_stock > 0:
        total_damage_dealt += damage_this_stock

    last_frame = game.frames[-1] if game.frames else None
    if last_frame is None or last_frame.ports[opp_port] is None:
        return None

    final_opp_stocks = last_frame.ports[opp_port].leader.post.stocks or 0
    kills         = 4 - final_opp_stocks
    total_neutral = neutral_wins + neutral_losses

    return {
        "neutral_win_ratio":  neutral_wins / total_neutral       if total_neutral > 0  else None,
        "openings_per_kill":  neutral_wins / kills               if kills > 0          else None,
        "damage_per_opening": total_damage_dealt / neutral_wins  if neutral_wins > 0   else None,
        "l_cancel_ratio":     lc_successes / lc_attempts         if lc_attempts > 0    else None,
        "avg_kill_percent":   sum(kill_percents) / len(kill_percents)   if kill_percents   else None,
        "avg_death_percent":  sum(death_percents) / len(death_percents) if death_percents  else None,
    }


def process_both_ports(filepath: str):
    """
    Parse a 1v1 replay once and compute stats from both ports.

    Returns a list of (stats_dict, player_char_name, opp_char_name) tuples.
    Processing both ports doubles the population-level sample size per replay.
    """
    try:
        game = Game(filepath)
    except Exception:
        return []

    if not game.start:
        return []

    active_ports = [i for i in range(4) if game.start.players[i] is not None]
    if len(active_ports) != 2:
        return []

    results = []
    for player_port in active_ports:
        opp_port = next(p for p in active_ports if p != player_port)

        player_char_id = int(game.start.players[player_port].character)
        opp_char_id    = int(game.start.players[opp_port].character)

        player_char_name = CHARACTERS.get(player_char_id, f"Unknown_{player_char_id}")
        opp_char_name    = CHARACTERS.get(opp_char_id,    f"Unknown_{opp_char_id}")

        stats = compute_game_stats(game, player_port, opp_port)
        if stats is not None:
            results.append((stats, player_char_name, opp_char_name))

    return results

# ── Percentile helpers ─────────────────────────────────────────────────────────

def compute_percentiles(values: list[float]) -> dict:
    if not values:
        return {"sample_size": 0, "avg": None,
                "p5": None, "p10": None, "p25": None, "p50": None,
                "p75": None, "p90": None, "p95": None}
    arr  = np.array(values, dtype=float)
    pcts = np.percentile(arr, [5, 10, 25, 50, 75, 90, 95])
    return {
        "sample_size": len(values),
        "avg":  round(float(np.mean(arr)), 4),
        "p5":   round(float(pcts[0]),      4),
        "p10":  round(float(pcts[1]),      4),
        "p25":  round(float(pcts[2]),      4),
        "p50":  round(float(pcts[3]),      4),
        "p75":  round(float(pcts[4]),      4),
        "p90":  round(float(pcts[5]),      4),
        "p95":  round(float(pcts[6]),      4),
    }

# ── API helpers ────────────────────────────────────────────────────────────────

def fetch_replay_list(limit: int) -> list[dict]:
    url = f"{BASE_URL}/api/replays"
    print(f"Fetching replay list from {url} ...")
    req = urllib.request.Request(
        url, headers={"User-Agent": "slippi-ranked-stats-baseline/1.0"}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        body = json.loads(resp.read().decode())

    replays = body.get("data") if isinstance(body, dict) else body
    if not isinstance(replays, list):
        raise ValueError(f"Unexpected API response shape: {type(body)}")

    replays = [r for r in replays if not r.get("is_teams")]
    print(f"Found {len(replays)} 1v1 replays. Will process up to {limit}.")
    return replays[:limit]


def process_one_replay(replay: dict):
    """
    Worker entry point: download a replay, parse it once, compute stats for
    both ports, and clean up. Runs in a separate process so the py-slippi parse
    (CPU-bound, GIL-bound) can run in parallel with other workers.

    Returns:
        ("ok",      port_results)  on a successful parse
        ("empty",   None)          when parsing succeeded but yielded no usable rows
        ("skip",    reason_str)    when the replay couldn't be downloaded/identified
    """
    file_name = replay.get("file_name")
    if not file_name:
        return ("skip", "no file_name")

    url = f"{BASE_URL}/api/replay/{file_name}"
    tmp_path = None
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": "slippi-ranked-stats-baseline/1.0"}
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = resp.read()

        with tempfile.NamedTemporaryFile(suffix=".slp", delete=False) as tf:
            tf.write(data)
            tmp_path = tf.name

        port_results = process_both_ports(tmp_path)
        if not port_results:
            return ("empty", None)
        return ("ok", port_results)

    except urllib.error.HTTPError as e:
        return ("skip", f"HTTP {e.code}")
    except Exception as e:
        return ("skip", f"{type(e).__name__}: {e}")
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Build grade baselines from SlippiLab community replays"
    )
    parser.add_argument("--limit",   type=int, default=1000,
                        help="Max replays to process (default: 1000)")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS,
                        help=f"Parallel download+parse workers (default: {MAX_WORKERS})")
    parser.add_argument("--output",  default=os.path.join(os.path.dirname(__file__), "grade_baselines.json"),
                        help="Output path for grade_baselines.json")
    args = parser.parse_args()

    replays = fetch_replay_list(args.limit)
    total   = len(replays)

    # Two grouping dimensions:
    #   by_player_char — for character-specific stat comparisons
    #   by_opponent_char — for opponent-context stat comparisons
    #   overall — cross-character fallback for universal stats
    by_player_char:   dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    by_opponent_char: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    overall:          dict[str, list[float]]             = defaultdict(list)

    processed = 0
    errors    = 0
    skipped   = 0
    completed = 0

    print(f"Dispatching {total} replays across {args.workers} workers...", flush=True)

    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(process_one_replay, r) for r in replays]

        for future in as_completed(futures):
            completed += 1
            status, payload = future.result()

            if status == "ok":
                for stats, player_char, opp_char in payload:
                    for key in STAT_KEYS:
                        val = stats.get(key)
                        if val is None:
                            continue
                        if isinstance(val, float) and val != val:  # NaN guard
                            continue
                        by_player_char[player_char][key].append(val)
                        by_opponent_char[opp_char][key].append(val)
                        overall[key].append(val)
                processed += 1
            elif status == "empty":
                errors += 1
            else:  # "skip"
                skipped += 1

            if completed % 100 == 0 or completed == 1 or completed == total:
                print(f"[{completed}/{total}]  processed={processed}  errors={errors}  skipped={skipped}",
                      flush=True)

    print(f"\nFinished. Processed: {processed}  Errors: {errors}  Skipped: {skipped}")

    def build_char_section(accum: dict[str, dict[str, list[float]]]) -> dict:
        section = {}
        for char_name in sorted(accum.keys()):
            char_data = accum[char_name]
            n = max((len(char_data[k]) for k in STAT_KEYS if char_data[k]), default=0)
            section[char_name] = {"sample_size": n}
            for key in STAT_KEYS:
                section[char_name][key] = compute_percentiles(char_data[key])
        return section

    # _overall fallback entry (character-agnostic)
    overall_entry: dict = {"sample_size": processed * 2}
    for key in STAT_KEYS:
        overall_entry[key] = compute_percentiles(overall[key])

    output: dict = {
        "generated_at":    datetime.now(timezone.utc).isoformat(),
        "source":          "slippilab",
        "replay_count":    processed,
        # by_player_char: use when grading a Fox player's damage/opening vs other Fox players
        "by_player_char":  build_char_section(by_player_char),
        # by_opponent_char: available for future opponent-specific context grading
        "by_opponent_char": build_char_section(by_opponent_char),
    }
    # Add _overall fallback to both sections
    output["by_player_char"]["_overall"]   = overall_entry
    output["by_opponent_char"]["_overall"] = overall_entry

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    player_chars   = sorted(k for k in output["by_player_char"]   if k != "_overall")
    opponent_chars = sorted(k for k in output["by_opponent_char"] if k != "_overall")
    print(f"\nBaselines written to: {args.output}")
    print(f"Player chars  ({len(player_chars)}):   {player_chars}")
    print(f"Opponent chars ({len(opponent_chars)}): {opponent_chars}")


if __name__ == "__main__":
    main()
