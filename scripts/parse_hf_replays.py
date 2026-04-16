#!/usr/bin/env python3
"""
parse_hf_replays.py — Parse Slippi replays from the HuggingFace public dataset
using peppi-py (Rust backend) for fast parsing with all 9 grading stats.

Downloads files in batches, parses with peppi-py's struct-of-arrays API,
computes stats via numpy vectorized operations, then deletes each batch
to conserve disk space.

Computes all 9 stats the grading system needs:
  - neutral_win_ratio, counter_hit_rate           (Neutral)
  - openings_per_kill, damage_per_opening,         (Punish)
    avg_kill_percent
  - avg_death_percent, defensive_option_rate        (Defense)
  - l_cancel_ratio, inputs_per_minute               (Execution)

Outputs grade_baselines.json with three grouping dimensions:
  - by_player_char:  benchmarks by the character the player uses
  - by_opponent_char: benchmarks by the opponent's character
  - by_matchup:      player_char × opponent_char (most precise)
  - _overall:        cross-character fallback in both char sections

Usage:
    python scripts/parse_hf_replays.py [--character FALCO] [--batch-size 200]
                                        [--output scripts/grade_baselines.json]

Requirements: peppi-py, numpy, huggingface_hub
    (install in a Python 3.10+ venv)
"""

import argparse
import json
import os
import shutil
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import numpy as np

# peppi-py uses 'peppi_py' as its import name
import peppi_py as peppi
from huggingface_hub import list_repo_tree, hf_hub_download

# ── Constants ─────────────────────────────────────────────────────────────────

REPO_ID   = "erickfm/slippi-public-dataset-v3.7"
REPO_TYPE = "dataset"

# External (CSS) character IDs → names. peppi-py uses external IDs, NOT the
# internal IDs that py-slippi uses. Verified empirically against filenames in
# the HuggingFace dataset.
CHARACTERS: dict[int, str] = {
    0:  "Captain Falcon",    1:  "Donkey Kong",      2:  "Fox",
    3:  "Mr. Game & Watch",  4:  "Kirby",            5:  "Bowser",
    6:  "Link",              7:  "Luigi",             8:  "Mario",
    9:  "Marth",             10: "Mewtwo",            11: "Ness",
    12: "Peach",             13: "Pikachu",           14: "Ice Climbers",
    15: "Jigglypuff",        16: "Samus",             17: "Yoshi",
    18: "Zelda",             19: "Sheik",             20: "Falco",
    21: "Young Link",        22: "Dr. Mario",         23: "Roy",
    24: "Pichu",             25: "Ganondorf",
}

# Stats included in baselines
STAT_KEYS = [
    "neutral_win_ratio",
    "counter_hit_rate",
    "openings_per_kill",
    "damage_per_opening",
    "avg_kill_percent",
    "avg_death_percent",
    "defensive_option_rate",
    "l_cancel_ratio",
    "inputs_per_minute",
]

MIN_MATCHUP_SAMPLES = 20
DL_WORKERS = 8  # concurrent download threads (I/O-bound, threads are fine)

CHECKPOINT_FILE = "parse_hf_checkpoint.json"

# ── Action-state predicates (mirrors slp_parser.ts exactly) ──────────────────

def _make_state_mask(states_arr, predicate_ranges):
    """Build a boolean mask over a numpy uint16 array using OR of ranges."""
    mask = np.zeros(len(states_arr), dtype=bool)
    for lo, hi in predicate_ranges:
        mask |= (states_arr >= lo) & (states_arr <= hi)
    return mask

IN_CONTROL_RANGES = [
    (14, 24),   # grounded control + controlled jump
    (39, 41),   # squat
    (45, 64),   # ground attack windups (still controllable)
    (212, 212), # grab
]

VULNERABLE_RANGES = [
    (0, 10),      # dying
    (75, 91),     # damaged
    (183, 198),   # down
    (199, 204),   # teching
    (223, 232),   # grabbed
]

ATTACKING_RANGES = [
    (44, 74),     # ground + aerial attacks
    (176, 178),   # special moves (0xB0–0xB2)
]

DEFENSIVE_STATES = {29, 30, 31}  # roll fwd, roll bwd, spot dodge

# ── Stat computation (vectorized with numpy) ─────────────────────────────────

def compute_game_stats(game, player_idx: int, opp_idx: int) -> dict | None:
    """
    Compute all 9 performance stats for player_idx in the given peppi game.

    Uses numpy vectorized operations on peppi-py's PyArrow struct-of-arrays
    for maximum speed (no per-frame Python loop).

    Returns a dict with all STAT_KEYS, or None if the game is unusable.
    """
    p_port = game.frames.ports[player_idx]
    o_port = game.frames.ports[opp_idx]

    if p_port is None or o_port is None:
        return None
    if p_port.leader is None or o_port.leader is None:
        return None

    p_post = p_port.leader.post
    o_post = o_port.leader.post
    p_pre  = p_port.leader.pre

    # Convert PyArrow arrays to numpy (zero-copy when possible)
    p_state = np.array(p_post.state, copy=False)
    o_state = np.array(o_post.state, copy=False)
    p_pct   = np.array(p_post.percent, copy=False)
    o_pct   = np.array(o_post.percent, copy=False)
    p_stocks = np.array(p_post.stocks, copy=False)
    o_stocks = np.array(o_post.stocks, copy=False)

    n_frames = len(p_state)
    if n_frames < 60:  # skip extremely short games (< 1 second)
        return None

    # ── Neutral win/loss detection (vectorized) ──────────────────────────────
    # A neutral win = opponent was in control on prev frame AND is vulnerable now
    p_ctrl = _make_state_mask(p_state, IN_CONTROL_RANGES)
    o_ctrl = _make_state_mask(o_state, IN_CONTROL_RANGES)
    p_vuln = _make_state_mask(p_state, VULNERABLE_RANGES)
    o_vuln = _make_state_mask(o_state, VULNERABLE_RANGES)
    o_atk  = _make_state_mask(o_state, ATTACKING_RANGES)

    # Transitions: prev frame in_control → current frame vulnerable
    neutral_wins  = np.sum(o_ctrl[:-1] & o_vuln[1:])
    neutral_losses = np.sum(p_ctrl[:-1] & p_vuln[1:])

    # Counter hits: subset of neutral wins where opponent was ALSO attacking on prev frame
    # (must require o_ctrl too — counter_hits ⊆ neutral_wins)
    counter_hits = np.sum(o_ctrl[:-1] & o_atk[:-1] & o_vuln[1:])

    total_neutral = int(neutral_wins + neutral_losses)

    # ── Defensive options (rolls + spotdodges) ───────────────────────────────
    p_def = np.isin(p_state, list(DEFENSIVE_STATES))
    # Count transitions INTO a defensive state (not sustained frames in one)
    def_entries = np.sum(p_def[1:] & ~p_def[:-1])
    duration_min = n_frames / 3600.0  # 60 fps * 60 sec

    # ── L-cancel tracking ────────────────────────────────────────────────────
    lc_data = p_post.l_cancel
    lc_successes = 0
    lc_attempts = 0
    if lc_data is not None:
        lc_arr = np.array(lc_data, copy=False)
        lc_successes = int(np.sum(lc_arr == 1))
        lc_failures  = int(np.sum(lc_arr == 2))
        lc_attempts  = lc_successes + lc_failures

    # ── Inputs per minute (from pre-frame buttons_physical) ──────────────────
    ipm = None
    if p_pre is not None and p_pre.buttons_physical is not None:
        bp = np.array(p_pre.buttons_physical, copy=False)
        if len(bp) > 1:
            input_changes = int(np.sum(np.diff(bp) != 0))
            if duration_min > 0:
                ipm = input_changes / duration_min

    # ── Kill / death percent tracking ────────────────────────────────────────
    # Detect stock losses as frames where stock count decreases
    o_stock_diff = np.diff(o_stocks.astype(np.int16))
    p_stock_diff = np.diff(p_stocks.astype(np.int16))

    # Kill = opponent lost a stock (stock_diff < 0)
    kill_frames = np.where(o_stock_diff < 0)[0]  # indices in diff array = frame before stock loss
    death_frames = np.where(p_stock_diff < 0)[0]

    kill_percents = o_pct[kill_frames].tolist() if len(kill_frames) > 0 else []
    death_percents = p_pct[death_frames].tolist() if len(death_frames) > 0 else []

    # Filter out nonsensical values (e.g. 0% kills from timeouts/LRAS)
    kill_percents = [p for p in kill_percents if p > 0]
    death_percents = [p for p in death_percents if p > 0]

    kills = len(kill_percents)

    # ── Damage per opening ───────────────────────────────────────────────────
    # Total damage dealt = sum of all opponent percent resets (stock losses)
    # plus final opponent percent on their last stock
    total_damage = 0.0
    if len(kill_frames) > 0:
        total_damage = float(np.sum(o_pct[kill_frames]))
    # Add damage on the final stock (game-ending percent or surviving percent)
    total_damage += float(o_pct[-1])

    nw = int(neutral_wins)

    # ── Assemble results ─────────────────────────────────────────────────────
    return {
        "neutral_win_ratio":     nw / total_neutral if total_neutral > 0 else None,
        "counter_hit_rate":      int(counter_hits) / nw if nw > 0 else None,
        "openings_per_kill":     nw / kills if kills > 0 else None,
        "damage_per_opening":    total_damage / nw if nw > 0 else None,
        "avg_kill_percent":      sum(kill_percents) / len(kill_percents) if kill_percents else None,
        "avg_death_percent":     sum(death_percents) / len(death_percents) if death_percents else None,
        "defensive_option_rate": float(def_entries) / duration_min if duration_min > 0 else None,
        "l_cancel_ratio":        lc_successes / lc_attempts if lc_attempts > 0 else None,
        "inputs_per_minute":     ipm,
    }


def process_both_ports(filepath: str) -> list[tuple[dict, str, str]]:
    """
    Parse a 1v1 replay once and compute stats from both ports' perspectives.
    Returns list of (stats_dict, player_char_name, opp_char_name) tuples.
    """
    try:
        game = peppi.read_slippi(filepath)
    except BaseException:
        # peppi-py Rust panics propagate as pyo3_runtime.PanicException
        # (inherits BaseException, not Exception) on corrupted .slp files
        return []

    if game.start is None or game.start.players is None:
        return []

    players = [p for p in game.start.players if p is not None]
    if len(players) != 2:
        return []

    # Map player index (0, 1) to character name
    char_names = []
    for p in players:
        char_id = int(p.character)
        char_names.append(CHARACTERS.get(char_id, f"Unknown_{char_id}"))

    results = []
    for player_idx in range(2):
        opp_idx = 1 - player_idx
        stats = compute_game_stats(game, player_idx, opp_idx)
        if stats is not None:
            results.append((stats, char_names[player_idx], char_names[opp_idx]))

    return results


# ── Percentile computation ────────────────────────────────────────────────────

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


# ── HuggingFace file listing ─────────────────────────────────────────────────

def list_all_files(character: str) -> list[str]:
    """List all .slp file paths under the character directory, including batch subdirs."""
    print(f"Listing files in {character}/ directory...", flush=True)

    all_files = []
    top_items = list(list_repo_tree(REPO_ID, path_in_repo=character, repo_type=REPO_TYPE))

    folders = [i for i in top_items if hasattr(i, 'tree_id')]
    files   = [i for i in top_items if not hasattr(i, 'tree_id')]
    all_files.extend([f.path for f in files if f.path.endswith('.slp')])

    for folder in folders:
        batch_name = folder.path
        batch_items = list(list_repo_tree(REPO_ID, path_in_repo=batch_name, repo_type=REPO_TYPE))
        batch_files = [i for i in batch_items if not hasattr(i, 'tree_id') and i.path.endswith('.slp')]
        all_files.extend([f.path for f in batch_files])
        print(f"  {batch_name}: {len(batch_files)} files", flush=True)

    print(f"Total files found: {len(all_files)}", flush=True)
    return all_files


# ── Checkpoint management ────────────────────────────────────────────────────

def load_checkpoint(checkpoint_path: str) -> dict:
    """Load checkpoint data (processed file set + accumulated stats)."""
    if os.path.exists(checkpoint_path):
        with open(checkpoint_path, 'r') as f:
            return json.load(f)
    return {
        "processed_files": [],
        "by_player_char": {},
        "by_opponent_char": {},
        "by_matchup": {},
        "overall": {},
        "total_processed": 0,
        "total_errors": 0,
    }


def save_checkpoint(checkpoint_path: str, data: dict):
    """Save checkpoint atomically (write to tmp, then rename)."""
    tmp_path = checkpoint_path + ".tmp"
    with open(tmp_path, 'w') as f:
        json.dump(data, f)
    os.replace(tmp_path, checkpoint_path)


def accumulate_stats(accum: dict, key: str, stats: dict):
    """Add stats values to an accumulator dict[stat_key] = list[float]."""
    if key not in accum:
        accum[key] = {s: [] for s in STAT_KEYS}
    for stat in STAT_KEYS:
        val = stats.get(stat)
        if val is not None and isinstance(val, (int, float)) and np.isfinite(val):
            accum[key][stat].append(val)


def accumulate_matchup_stats(accum: dict, player_char: str, opp_char: str, stats: dict):
    """Add stats to nested matchup accumulator: accum[player_char][opp_char][stat]."""
    if player_char not in accum:
        accum[player_char] = {}
    if opp_char not in accum[player_char]:
        accum[player_char][opp_char] = {s: [] for s in STAT_KEYS}
    for stat in STAT_KEYS:
        val = stats.get(stat)
        if val is not None and isinstance(val, (int, float)) and np.isfinite(val):
            accum[player_char][opp_char][stat].append(val)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Parse Slippi replays from HuggingFace dataset with peppi-py"
    )
    parser.add_argument("--character",  default="FALCO",
                        help="Character directory in the dataset (default: FALCO)")
    parser.add_argument("--batch-size", type=int, default=500,
                        help="Files to download per batch (default: 500)")
    parser.add_argument("--dl-workers", type=int, default=DL_WORKERS,
                        help=f"Concurrent download threads (default: {DL_WORKERS})")
    parser.add_argument("--output",     default=os.path.join(os.path.dirname(__file__), "grade_baselines.json"),
                        help="Output path for grade_baselines.json")
    parser.add_argument("--checkpoint", default=os.path.join(os.path.dirname(__file__), CHECKPOINT_FILE),
                        help="Checkpoint file for resume support")
    parser.add_argument("--merge",      action="store_true",
                        help="Merge into existing baselines instead of overwriting")
    args = parser.parse_args()

    # List all files from HuggingFace
    all_files = list_all_files(args.character)
    if not all_files:
        print("ERROR: No files found.", file=sys.stderr)
        sys.exit(1)

    # Load checkpoint for resume
    checkpoint = load_checkpoint(args.checkpoint)
    processed_set = set(checkpoint["processed_files"])
    remaining = [f for f in all_files if f not in processed_set]

    # Restore accumulators from checkpoint
    by_player_char  = checkpoint.get("by_player_char", {})
    by_opponent_char = checkpoint.get("by_opponent_char", {})
    by_matchup      = checkpoint.get("by_matchup", {})
    overall_accum   = checkpoint.get("overall", {s: [] for s in STAT_KEYS})
    if not overall_accum:
        overall_accum = {s: [] for s in STAT_KEYS}
    total_processed = checkpoint.get("total_processed", 0)
    total_errors    = checkpoint.get("total_errors", 0)

    print(f"\nResume: {len(processed_set)} already done, {len(remaining)} remaining")
    print(f"Batch size: {args.batch_size}")
    print(f"Checkpoint: {args.checkpoint}")
    print(f"Output: {args.output}\n", flush=True)

    # Process in batches
    download_dir = os.path.join("/tmp", f"hf_parse_{args.character}")
    batch_num = 0
    t_start = time.time()

    for batch_start in range(0, len(remaining), args.batch_size):
        batch_files = remaining[batch_start:batch_start + args.batch_size]
        batch_num += 1
        batch_processed = 0
        batch_errors = 0

        print(f"\n{'='*60}")
        print(f"Batch {batch_num}: downloading {len(batch_files)} files...")
        print(f"  Progress: {len(processed_set)}/{len(all_files)} total "
              f"({100*len(processed_set)/len(all_files):.1f}%)")
        t_batch = time.time()

        # Download batch (concurrent — I/O-bound so threads are ideal)
        def download_one(file_path):
            local = hf_hub_download(
                repo_id=REPO_ID,
                filename=file_path,
                repo_type=REPO_TYPE,
                local_dir=download_dir,
            )
            return (file_path, local)

        local_paths = []
        with ThreadPoolExecutor(max_workers=args.dl_workers) as dl_pool:
            futures = {dl_pool.submit(download_one, fp): fp for fp in batch_files}
            try:
                for future in as_completed(futures, timeout=300):  # 5 min max per batch
                    try:
                        local_paths.append(future.result(timeout=60))
                    except Exception:
                        total_errors += 1
                        batch_errors += 1
            except TimeoutError:
                # Some downloads stalled — cancel remaining and move on
                stalled = sum(1 for f in futures if not f.done())
                print(f"  WARNING: {stalled} downloads timed out, skipping", flush=True)
                for f in futures:
                    f.cancel()
                total_errors += stalled
                batch_errors += stalled

        dl_time = time.time() - t_batch
        print(f"  Downloaded {len(local_paths)} files in {dl_time:.1f}s", flush=True)

        # Parse batch
        t_parse = time.time()
        for file_path, local in local_paths:
            results = process_both_ports(local)
            if results:
                for stats, player_char, opp_char in results:
                    accumulate_stats(by_player_char, player_char, stats)
                    accumulate_stats(by_opponent_char, opp_char, stats)
                    accumulate_matchup_stats(by_matchup, player_char, opp_char, stats)
                    for stat in STAT_KEYS:
                        val = stats.get(stat)
                        if val is not None and isinstance(val, (int, float)) and np.isfinite(val):
                            if stat not in overall_accum:
                                overall_accum[stat] = []
                            overall_accum[stat].append(val)
                batch_processed += 1
            else:
                batch_errors += 1

            processed_set.add(file_path)
            total_processed += 1

        parse_time = time.time() - t_parse
        total_time = time.time() - t_start

        # Clean up downloaded files
        if os.path.exists(download_dir):
            shutil.rmtree(download_dir, ignore_errors=True)

        print(f"  Parsed {batch_processed} games ({batch_errors} errors) in {parse_time:.1f}s")
        print(f"  Rate: {len(local_paths)/max(parse_time, 0.001):.0f} parses/sec")
        print(f"  Total: {len(processed_set)}/{len(all_files)} "
              f"({100*len(processed_set)/len(all_files):.1f}%) "
              f"in {total_time:.0f}s", flush=True)

        # Save checkpoint
        checkpoint = {
            "processed_files": list(processed_set),
            "by_player_char": by_player_char,
            "by_opponent_char": by_opponent_char,
            "by_matchup": by_matchup,
            "overall": overall_accum,
            "total_processed": total_processed,
            "total_errors": total_errors,
        }
        save_checkpoint(args.checkpoint, checkpoint)

    # ── Build final output ────────────────────────────────────────────────────

    print(f"\n{'='*60}")
    print(f"Building baselines from {total_processed} processed games...")

    def build_char_section(accum: dict) -> dict:
        section = {}
        for char_name in sorted(accum.keys()):
            char_data = accum[char_name]
            n = max((len(char_data[k]) for k in STAT_KEYS if k in char_data and char_data[k]), default=0)
            section[char_name] = {"sample_size": n}
            for key in STAT_KEYS:
                vals = char_data.get(key, [])
                section[char_name][key] = compute_percentiles(vals)
        return section

    def build_matchup_section(accum: dict) -> dict:
        section = {}
        for player_char in sorted(accum.keys()):
            section[player_char] = {}
            for opp_char in sorted(accum[player_char].keys()):
                matchup_data = accum[player_char][opp_char]
                n = max((len(matchup_data[k]) for k in STAT_KEYS if k in matchup_data and matchup_data[k]), default=0)
                if n < MIN_MATCHUP_SAMPLES:
                    continue
                section[player_char][opp_char] = {"sample_size": n}
                for key in STAT_KEYS:
                    vals = matchup_data.get(key, [])
                    section[player_char][opp_char][key] = compute_percentiles(vals)
            if not section[player_char]:
                del section[player_char]
        return section

    # Overall entry
    overall_n = max((len(overall_accum.get(k, [])) for k in STAT_KEYS), default=0)
    overall_entry = {"sample_size": overall_n}
    for key in STAT_KEYS:
        overall_entry[key] = compute_percentiles(overall_accum.get(key, []))

    output = {
        "generated_at":    datetime.now(timezone.utc).isoformat(),
        "source":          f"huggingface/{REPO_ID}/{args.character}",
        "replay_count":    total_processed,
        "by_player_char":  build_char_section(by_player_char),
        "by_opponent_char": build_char_section(by_opponent_char),
        "by_matchup":      build_matchup_section(by_matchup),
    }
    output["by_player_char"]["_overall"]   = overall_entry
    output["by_opponent_char"]["_overall"] = overall_entry

    # Optionally merge with existing baselines
    if args.merge and os.path.exists(args.output):
        print(f"Merging with existing {args.output}...")
        with open(args.output, 'r') as f:
            existing = json.load(f)
        # New data overwrites per-character entries but keeps chars not in new data
        for section_key in ["by_player_char", "by_opponent_char"]:
            if section_key in existing:
                for char_name, char_data in existing[section_key].items():
                    if char_name not in output[section_key]:
                        output[section_key][char_name] = char_data
        if "by_matchup" in existing:
            for pc, opp_dict in existing["by_matchup"].items():
                if pc not in output["by_matchup"]:
                    output["by_matchup"][pc] = opp_dict

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2)

    player_chars = sorted(k for k in output["by_player_char"] if k != "_overall")
    print(f"\nBaselines written to: {args.output}")
    print(f"Player chars ({len(player_chars)}): {player_chars}")
    print(f"Total processed: {total_processed}")
    print(f"Total errors: {total_errors}")

    # Clean up checkpoint on successful completion
    if os.path.exists(args.checkpoint):
        os.remove(args.checkpoint)
        print(f"Checkpoint removed (completed successfully)")


if __name__ == "__main__":
    main()
