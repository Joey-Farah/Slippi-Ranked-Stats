#!/usr/bin/env python3
"""
baseline_generator.py — Phase 1 of the Set Grading System.

Reads the Slippi Ranked Stats SQLite DB to get all ranked game file paths,
re-parses each .slp file with py-slippi to compute per-game performance stats,
groups results by opponent character, computes percentile distributions,
and writes everything to grade_baselines.json.

Usage:
    python baseline_generator.py --db-path "C:/Users/You/AppData/Roaming/Slippi Ranked Stats/data/JOEY_290.db"

Note: The DB connect code replaces '#' with '_' in the filename (e.g. JOEY#290 → JOEY_290.db).
"""

import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import numpy as np
from slippi import Game
from slippi.event import LCancel

# ── Character ID lookup ────────────────────────────────────────────────────
# Internal character IDs from the app's DB (parser.ts CHARACTERS table).
# These are the CSS selection order used by Slippi's internal metadata.
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

# ── Action-state helpers ───────────────────────────────────────────────────
# Kept in sync with fetch_slippilab_replays.py and slp_parser.ts.

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

def is_attacking(state: int) -> bool:
    """True when the character is performing an attack (counter-hit detection)."""
    return (44 <= state <= 74) or (176 <= state <= 178)

DEFENSIVE_STATES: set[int] = {29, 30, 31}  # roll forward, roll backward, spot dodge

MIN_MATCHUP_SAMPLES = 20

# ── Per-game stat computation ──────────────────────────────────────────────

def compute_game_stats(filepath: str, player_port: int):
    """
    Parse a .slp file and compute performance stats for the given player port.

    Returns a dict with all STAT_KEYS values, or None if the file cannot be
    parsed or is not a valid 1v1.
    """
    try:
        game = Game(filepath)
    except Exception as e:
        print(f"  [WARN] Could not parse {os.path.basename(filepath)}: {e}", file=sys.stderr)
        return None

    # Validate: must be a 1v1 with the expected player port active
    active_ports = [i for i in range(4) if game.start and game.start.players[i] is not None]
    if len(active_ports) != 2 or player_port not in active_ports:
        return None

    opp_port = next(p for p in active_ports if p != player_port)

    # Accumulators
    neutral_wins        = 0
    neutral_losses      = 0
    counter_hits        = 0
    prev_p_ctrl         = False
    prev_o_ctrl         = False
    prev_o_state        = -1
    lc_attempts         = 0
    lc_successes        = 0
    defensive_options   = 0
    prev_p_action_state = -1

    # Per-stock kill/death percent tracking
    kill_percents:  list[float] = []
    death_percents: list[float] = []

    # For total damage: track per-stock damage by watching stock transitions
    total_damage_dealt = 0.0
    damage_this_stock  = 0.0
    prev_opp_stocks    = None  # type: Optional[int]
    prev_opp_damage    = 0.0
    prev_player_stocks = None
    prev_player_damage = 0.0
    frame_count        = 0

    for frame in game.frames:
        p_data = frame.ports[player_port]
        o_data = frame.ports[opp_port]
        if p_data is None or o_data is None:
            continue

        p_post = p_data.leader.post
        o_post = o_data.leader.post

        p_state = int(p_post.state) if p_post.state is not None else 0
        o_state = int(o_post.state) if o_post.state is not None else 0
        frame_count += 1

        # ── Neutral win/loss transitions with counter-hit tracking ────────
        if prev_o_ctrl and is_vulnerable(o_state):
            neutral_wins += 1
            if is_attacking(prev_o_state):
                counter_hits += 1
        if prev_p_ctrl and is_vulnerable(p_state):
            neutral_losses += 1
        prev_p_ctrl  = is_in_control(p_state)
        prev_o_ctrl  = is_in_control(o_state)
        prev_o_state = o_state

        # ── Defensive option tracking ─────────────────────────────────────
        if p_state in DEFENSIVE_STATES and prev_p_action_state not in DEFENSIVE_STATES:
            defensive_options += 1
        prev_p_action_state = p_state

        # ── L-cancel tracking ─────────────────────────────────────────────
        lc = p_post.l_cancel
        if lc is not None:
            lc_attempts += 1
            if lc == LCancel.SUCCESS:
                lc_successes += 1

        # ── Kill / death percent + total damage tracking ──────────────────
        curr_opp_stocks    = o_post.stocks if o_post.stocks is not None else prev_opp_stocks
        curr_player_stocks = p_post.stocks if p_post.stocks is not None else prev_player_stocks
        curr_opp_damage    = float(o_post.damage) if o_post.damage is not None else 0.0
        curr_player_damage = float(p_post.damage) if p_post.damage is not None else 0.0

        if prev_opp_stocks is not None and curr_opp_stocks is not None:
            if curr_opp_stocks < prev_opp_stocks:
                kill_percents.append(prev_opp_damage)
                total_damage_dealt += damage_this_stock
                damage_this_stock = 0.0
            else:
                damage_this_stock = curr_opp_damage
        else:
            damage_this_stock = curr_opp_damage

        if prev_player_stocks is not None and curr_player_stocks is not None:
            if curr_player_stocks < prev_player_stocks:
                death_percents.append(prev_player_damage)

        prev_opp_stocks    = curr_opp_stocks
        prev_player_stocks = curr_player_stocks
        prev_opp_damage    = curr_opp_damage
        prev_player_damage = curr_player_damage

    if damage_this_stock > 0:
        total_damage_dealt += damage_this_stock

    last_frame = game.frames[-1] if game.frames else None
    if last_frame is None or last_frame.ports[opp_port] is None:
        return None

    final_opp_stocks  = last_frame.ports[opp_port].leader.post.stocks or 0
    kills             = 4 - final_opp_stocks
    total_neutral     = neutral_wins + neutral_losses
    duration_min      = frame_count / 3600.0

    return {
        "neutral_win_ratio":     neutral_wins / total_neutral            if total_neutral > 0  else None,
        "openings_per_kill":     neutral_wins / kills                    if kills > 0          else None,
        "damage_per_opening":    total_damage_dealt / neutral_wins       if neutral_wins > 0   else None,
        "counter_hit_rate":      counter_hits / neutral_wins             if neutral_wins > 0   else None,
        "defensive_option_rate": defensive_options / duration_min        if duration_min > 0   else None,
        "l_cancel_ratio":        lc_successes / lc_attempts              if lc_attempts > 0    else None,
        "avg_kill_percent":      sum(kill_percents) / len(kill_percents)   if kill_percents     else None,
        "avg_death_percent":     sum(death_percents) / len(death_percents) if death_percents    else None,
    }

# ── Percentile helpers ─────────────────────────────────────────────────────

def compute_percentiles(values: list[float]) -> dict:
    """Return avg + P5/P10/P25/P50/P75/P90/P95 for a list of float values.

    We compute both tails so that the grader can correctly handle stats where
    lower is better (e.g. openings_per_kill) using the low-end percentiles
    (p5/p10/p25) as high-performance thresholds.
    """
    if not values:
        return {
            "sample_size": 0,
            "avg": None,
            "p5": None, "p10": None, "p25": None,
            "p50": None,
            "p75": None, "p90": None, "p95": None,
        }
    arr = np.array(values, dtype=float)
    pcts = np.percentile(arr, [5, 10, 25, 50, 75, 90, 95])
    return {
        "sample_size": len(values),
        "avg":  round(float(np.mean(arr)),  4),
        "p5":   round(float(pcts[0]),       4),
        "p10":  round(float(pcts[1]),       4),
        "p25":  round(float(pcts[2]),       4),
        "p50":  round(float(pcts[3]),       4),
        "p75":  round(float(pcts[4]),       4),
        "p90":  round(float(pcts[5]),       4),
        "p95":  round(float(pcts[6]),       4),
    }

# ── Main ───────────────────────────────────────────────────────────────────

STAT_KEYS = [
    "neutral_win_ratio",
    "openings_per_kill",
    "damage_per_opening",
    "counter_hit_rate",
    "defensive_option_rate",
    "l_cancel_ratio",
    "avg_kill_percent",
    "avg_death_percent",
]

def main():
    parser = argparse.ArgumentParser(description="Generate grade baselines from local Slippi replay DB")
    parser.add_argument("--db-path", required=True,
                        help="Path to the SQLite DB, e.g. 'C:/Users/You/AppData/Roaming/Slippi Ranked Stats/data/JOEY_290.db'")
    parser.add_argument("--output", default=os.path.join(os.path.dirname(__file__), "grade_baselines.json"),
                        help="Output path for grade_baselines.json (default: scripts/grade_baselines.json)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Limit number of games to process (for testing)")
    args = parser.parse_args()

    db_path = os.path.expanduser(args.db_path)
    if not os.path.exists(db_path):
        print(f"ERROR: DB not found at: {db_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Connecting to DB: {db_path}")
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT filepath, player_port, player_char_id, opponent_char_id, result "
        "FROM games WHERE filepath IS NOT NULL"
    ).fetchall()
    conn.close()

    if args.limit:
        rows = rows[:args.limit]

    total = len(rows)
    print(f"Found {total} ranked games to process.")

    # Accumulators
    by_player_char: dict[str, dict[str, list[float]]]                   = defaultdict(lambda: defaultdict(list))
    by_matchup:     dict[str, dict[str, dict[str, list[float]]]]         = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    overall:        dict[str, list[float]]                               = defaultdict(list)

    errors    = 0
    skipped   = 0
    processed = 0

    for i, (filepath, player_port, player_char_id, opponent_char_id, result) in enumerate(rows):
        if (i + 1) % 500 == 0 or (i + 1) == total:
            print(f"  Progress: {i+1}/{total} ({errors} errors, {skipped} skipped)")

        if not filepath or not os.path.exists(filepath):
            skipped += 1
            continue

        stats = compute_game_stats(filepath, player_port)
        if stats is None:
            errors += 1
            continue

        player_char_name = CHARACTERS.get(player_char_id,   f"Unknown_{player_char_id}")
        opp_char_name    = CHARACTERS.get(opponent_char_id,  f"Unknown_{opponent_char_id}")

        for key in STAT_KEYS:
            val = stats.get(key)
            if val is not None and not (isinstance(val, float) and (val != val)):  # skip NaN
                by_player_char[player_char_name][key].append(val)
                by_matchup[player_char_name][opp_char_name][key].append(val)
                overall[key].append(val)

        processed += 1

    print(f"\nDone. Processed: {processed}, Skipped: {skipped}, Errors: {errors}")

    def build_char_section(accum: dict[str, dict[str, list[float]]]) -> dict:
        section = {}
        for char_name in sorted(accum.keys()):
            char_data = accum[char_name]
            n = max((len(char_data[k]) for k in STAT_KEYS if char_data[k]), default=0)
            section[char_name] = {"sample_size": n}
            for key in STAT_KEYS:
                section[char_name][key] = compute_percentiles(char_data[key])
        return section

    def build_matchup_section(accum: dict[str, dict[str, dict[str, list[float]]]]) -> dict:
        section: dict = {}
        for player_char in sorted(accum.keys()):
            section[player_char] = {}
            for opp_char in sorted(accum[player_char].keys()):
                matchup_data = accum[player_char][opp_char]
                n = max((len(matchup_data[k]) for k in STAT_KEYS if matchup_data[k]), default=0)
                if n < MIN_MATCHUP_SAMPLES:
                    continue
                section[player_char][opp_char] = {"sample_size": n}
                for key in STAT_KEYS:
                    section[player_char][opp_char][key] = compute_percentiles(matchup_data[key])
            if not section[player_char]:
                del section[player_char]
        return section

    overall_entry: dict = {"sample_size": processed}
    for key in STAT_KEYS:
        overall_entry[key] = compute_percentiles(overall[key])

    by_player_char_section = build_char_section(by_player_char)
    by_player_char_section["_overall"] = overall_entry

    output = {
        "generated_at":  datetime.now(timezone.utc).isoformat(),
        "sample_size":   processed,
        "by_player_char": by_player_char_section,
        "by_matchup":    build_matchup_section(by_matchup),
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"\nBaselines written to: {args.output}")
    print(f"Player chars with data: {sorted(k for k in output['by_player_char'] if k != '_overall')}")


if __name__ == "__main__":
    main()
