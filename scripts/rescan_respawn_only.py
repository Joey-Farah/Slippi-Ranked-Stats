#!/usr/bin/env python3
"""
rescan_respawn_only.py — Rescan all HuggingFace replays for respawn_defense_rate only.

Processes all characters from the full dataset but skips every stat except
respawn detection. On completion, patches ONLY the respawn_defense_rate
field in the existing grade_baselines.json (all other stats are untouched).

Run this after the respawn bug fix (SPAWN_STATES = {0, 12}).
Then run regen_benchmarks.py to regenerate grade-benchmarks.ts.

Usage:
    HF_TOKEN="hf_..." .venv/Scripts/python.exe scripts/rescan_respawn_only.py
"""

import json
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import numpy as np
import peppi_py as peppi
from huggingface_hub import list_repo_tree, hf_hub_download

# ── Constants ─────────────────────────────────────────────────────────────────

REPO_ID   = "erickfm/slippi-public-dataset-v3.7"
REPO_TYPE = "dataset"
TOKEN     = os.environ.get("HF_TOKEN")

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

# Same order as parse_hf_replays.py (smallest first → fast early progress)
ALL_CHAR_DIRS = [
    "PICHU", "BOWSER", "MEWTWO", "NESS", "KIRBY",
    "ROY", "YLINK", "GAMEANDWATCH", "MARIO", "LINK",
    "DK", "DOC", "PIKACHU", "YOSHI", "LUIGI",
    "ICE_CLIMBERS", "GANONDORF", "SAMUS",
    "JIGGLYPUFF", "PEACH",
    "ZELDA_SHEIK",
    "CPTFALCON", "MARTH",
    "FALCO", "FOX",
]

# Respawn detection: DeadDown (0) → Entry/spawn platform (12) → actionable (> 12)
# These are the actual peppi-py post-frame state IDs — NOT slippi-js's 10/11.
SPAWN_STATES   = {0, 12}
RESPAWN_WINDOW = 120  # frames after opponent becomes actionable (matches slp_parser.ts)

DL_WORKERS       = 32
BATCH_SIZE       = 200
CHECKPOINT_FILE  = "scripts/parse_hf_respawn_checkpoint.json"
BASELINES_PATH   = "scripts/grade_baselines.json"
MIN_MATCHUP_SAMPLES = 20


# ── Core computation ──────────────────────────────────────────────────────────

def compute_respawn_defense_both_ports(filepath: str) -> list[tuple[str, str, float]]:
    """
    Parse one replay and compute respawn_defense_rate from both ports' perspectives.
    Returns list of (player_char, opp_char, rate) for each port with a valid result.
    """
    try:
        game = peppi.read_slippi(filepath)
    except BaseException:
        return []

    if game.start is None or game.start.players is None:
        return []

    active = [(i, p) for i, p in enumerate(game.start.players) if p is not None]
    if len(active) != 2:
        return []

    char_names = {i: CHARACTERS.get(int(p.character)) for i, p in active}
    if None in char_names.values():
        return []

    results = []
    port_indices = [i for i, _ in active]

    for player_slot, opp_slot in [(0, 1), (1, 0)]:
        player_port = port_indices[player_slot]
        opp_port    = port_indices[opp_slot]
        player_char = char_names[player_port]
        opp_char    = char_names[opp_port]

        frames  = game.frames
        p_post  = frames.ports[player_port].leader.post
        o_post  = frames.ports[opp_port].leader.post

        # peppi-py renamed post.damage -> post.percent in 0.8.x. Support both
        # so this runs against whatever version is installed on either machine.
        p_dmg    = p_post.percent if hasattr(p_post, "percent") else p_post.damage
        p_pct    = np.array(p_dmg, copy=False)
        o_stocks = np.array(o_post.stocks, copy=False)
        o_state  = np.array(o_post.state,  copy=False)

        n_frames = len(o_state)
        if n_frames < 2:
            continue

        # Kill frames: opponent stock count drops
        kill_frames = np.where(np.diff(o_stocks.astype(np.int16)) < 0)[0]
        if len(kill_frames) == 0:
            continue

        ok = 0; valid = 0
        for fd in kill_frames:
            in_spawn = False
            actionable_frame = None
            # Search up to 500 frames for the opponent to exit the spawn platform
            for fi in range(int(fd), min(int(fd) + 500, n_frames)):
                s = int(o_state[fi])
                if s in SPAWN_STATES:
                    in_spawn = True
                elif in_spawn and s > 12:
                    actionable_frame = fi
                    break
            # No actionable frame found = last kill (game over), skip
            if actionable_frame is None:
                continue

            valid += 1
            window_end = min(actionable_frame + RESPAWN_WINDOW, n_frames - 1)
            base_pct   = float(p_pct[actionable_frame])
            safe = all(
                float(p_pct[fw]) <= base_pct + 5.0
                for fw in range(actionable_frame + 1, window_end + 1)
            )
            if safe:
                ok += 1

        if valid > 0:
            results.append((player_char, opp_char, ok / valid))

    return results


# ── HuggingFace listing ────────────────────────────────────────────────────────

def list_all_files(character: str) -> list[str]:
    print(f"Listing files in {character}/...", flush=True)
    all_files = []
    top_items = list(list_repo_tree(REPO_ID, path_in_repo=character,
                                    repo_type=REPO_TYPE, token=TOKEN))
    folders = [i for i in top_items if hasattr(i, "tree_id")]
    files   = [i for i in top_items if not hasattr(i, "tree_id")]
    all_files.extend(f.path for f in files if f.path.endswith(".slp"))
    for folder in folders:
        batch_items = list(list_repo_tree(REPO_ID, path_in_repo=folder.path,
                                          repo_type=REPO_TYPE, token=TOKEN))
        batch_files = [i for i in batch_items
                       if not hasattr(i, "tree_id") and i.path.endswith(".slp")]
        all_files.extend(f.path for f in batch_files)
        print(f"  {folder.path}: {len(batch_files)} files", flush=True)
    print(f"Total: {len(all_files)} files", flush=True)
    return all_files


# ── Checkpoint ────────────────────────────────────────────────────────────────

def load_checkpoint(path: str) -> dict:
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"processed_files": [], "by_player_char": {}, "by_opp_char": {},
            "by_matchup": {}, "overall": []}


def save_checkpoint(path: str, data: dict):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


# ── Accumulation ──────────────────────────────────────────────────────────────

def accum_add(accum: dict, player_char: str, opp_char: str, rate: float):
    """Add one sample to all four accumulator buckets."""
    accum["by_player_char"].setdefault(player_char, []).append(rate)
    accum["by_opp_char"].setdefault(opp_char, []).append(rate)
    accum["by_matchup"].setdefault(player_char, {}).setdefault(opp_char, []).append(rate)
    accum["overall"].append(rate)


# ── Percentiles ───────────────────────────────────────────────────────────────

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


# ── Merge into existing baselines ─────────────────────────────────────────────

def patch_baselines(accum: dict, baselines_path: str, total_processed: int):
    """Patch respawn_defense_rate into the existing grade_baselines.json."""
    print(f"\nPatching {baselines_path} with respawn_defense_rate data...", flush=True)

    with open(baselines_path) as f:
        baselines = json.load(f)

    # by_player_char
    for char, vals in accum["by_player_char"].items():
        if char not in baselines["by_player_char"]:
            continue
        baselines["by_player_char"][char]["respawn_defense_rate"] = compute_percentiles(vals)
        print(f"  by_player_char[{char}]: n={len(vals)}", flush=True)

    # _overall in by_player_char
    baselines["by_player_char"]["_overall"]["respawn_defense_rate"] = \
        compute_percentiles(accum["overall"])
    print(f"  by_player_char[_overall]: n={len(accum['overall'])}", flush=True)

    # by_opponent_char
    for char, vals in accum["by_opp_char"].items():
        if char not in baselines.get("by_opponent_char", {}):
            continue
        baselines["by_opponent_char"][char]["respawn_defense_rate"] = compute_percentiles(vals)

    if "_overall" in baselines.get("by_opponent_char", {}):
        baselines["by_opponent_char"]["_overall"]["respawn_defense_rate"] = \
            compute_percentiles(accum["overall"])

    # by_matchup
    for player_char, opps in accum["by_matchup"].items():
        if player_char not in baselines.get("by_matchup", {}):
            continue
        for opp_char, vals in opps.items():
            if len(vals) < MIN_MATCHUP_SAMPLES:
                continue
            if opp_char not in baselines["by_matchup"][player_char]:
                continue
            baselines["by_matchup"][player_char][opp_char]["respawn_defense_rate"] = \
                compute_percentiles(vals)

    # Update metadata
    baselines["respawn_defense_rescan"] = {
        "generated_at":    datetime.now(timezone.utc).isoformat(),
        "files_processed": total_processed,
        "overall_samples": len(accum["overall"]),
    }

    tmp = baselines_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(baselines, f, indent=2)
    os.replace(tmp, baselines_path)
    print(f"Saved {baselines_path}", flush=True)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    t_start = time.time()
    checkpoint = load_checkpoint(CHECKPOINT_FILE)
    processed_set = set(checkpoint.get("processed_files", []))

    # Restore accumulated samples from checkpoint
    accum = {
        "by_player_char": checkpoint.get("by_player_char", {}),
        "by_opp_char":    checkpoint.get("by_opp_char", {}),
        "by_matchup":     checkpoint.get("by_matchup", {}),
        "overall":        checkpoint.get("overall", []),
    }

    total_processed = len(processed_set)
    total_errors    = 0

    print(f"Respawn-only rescan starting. Resume: {total_processed} files already done.")
    print(f"Overall samples so far: {len(accum['overall'])}\n", flush=True)

    for char_dir in ALL_CHAR_DIRS:
        all_files = list_all_files(char_dir)
        remaining = [f for f in all_files if f not in processed_set]
        if not remaining:
            print(f"  {char_dir}: already complete ({len(all_files)} files)", flush=True)
            continue

        print(f"  {char_dir}: {len(remaining)}/{len(all_files)} files remaining", flush=True)
        download_dir = os.path.join("/tmp", f"hf_respawn_{char_dir}")
        t_char = time.time()

        for batch_start in range(0, len(remaining), BATCH_SIZE):
            batch = remaining[batch_start:batch_start + BATCH_SIZE]
            print(f"\n  Batch {batch_start//BATCH_SIZE + 1}: {len(batch)} files | "
                  f"{char_dir} {batch_start}/{len(remaining)}", flush=True)

            # Download batch
            local_paths = []
            dl_pool = ThreadPoolExecutor(max_workers=DL_WORKERS)
            try:
                futures = {
                    dl_pool.submit(
                        hf_hub_download,
                        repo_id=REPO_ID,
                        filename=fp,
                        repo_type=REPO_TYPE,
                        local_dir=download_dir,
                        token=TOKEN,
                    ): fp for fp in batch
                }
                try:
                    for future in as_completed(futures, timeout=300):
                        fp = futures[future]
                        try:
                            local_paths.append((fp, future.result(timeout=60)))
                        except Exception:
                            total_errors += 1
                except TimeoutError:
                    stalled = sum(1 for f in futures if not f.done())
                    print(f"    WARNING: {stalled} downloads timed out", flush=True)
                    total_errors += stalled
            finally:
                dl_pool.shutdown(wait=False, cancel_futures=True)

            # Parse
            for fp, local in local_paths:
                results = compute_respawn_defense_both_ports(local)
                for player_char, opp_char, rate in results:
                    accum_add(accum, player_char, opp_char, rate)
                processed_set.add(fp)
                total_processed += 1

            # Clean up downloaded files
            if os.path.exists(download_dir):
                shutil.rmtree(download_dir, ignore_errors=True)

            # Checkpoint every batch
            save_checkpoint(CHECKPOINT_FILE, {
                "processed_files": list(processed_set),
                "by_player_char":  accum["by_player_char"],
                "by_opp_char":     accum["by_opp_char"],
                "by_matchup":      accum["by_matchup"],
                "overall":         accum["overall"],
            })
            print(f"  Overall samples so far: {len(accum['overall'])}", flush=True)

        char_elapsed = time.time() - t_char
        print(f"\n  {char_dir} COMPLETE in {char_elapsed:.0f}s "
              f"({total_errors} cumulative errors)", flush=True)

    # Remove checkpoint on clean completion
    if os.path.exists(CHECKPOINT_FILE):
        os.remove(CHECKPOINT_FILE)

    elapsed = time.time() - t_start
    print(f"\n{'='*60}")
    print(f"Scan complete: {total_processed} files, "
          f"{len(accum['overall'])} overall samples, "
          f"{elapsed/60:.1f} min", flush=True)

    # Patch baselines
    patch_baselines(accum, BASELINES_PATH, total_processed)

    print("\nDone. Run regen_benchmarks.py to regenerate grade-benchmarks.ts.")


if __name__ == "__main__":
    main()
