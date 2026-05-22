#!/usr/bin/env python3
"""
rescan_recovery_edgeguard_only.py — Rescan all HuggingFace replays for the two
redefined stats only: recovery_success_rate and edgeguard_success_rate.

Run this after the 2026-05-22 recovery/edgeguard redefinitions (see
docs/dev_notes.md → "Recovery & edgeguard redefinition"). Computes ONLY those
two stats from the full dataset and patches ONLY those two fields in the
existing scripts/grade_baselines.json — every other stat is left untouched.
Then run regen_benchmarks.py to regenerate src/lib/grade-benchmarks.ts.

Logic is kept byte-for-byte in sync with the new blocks in
scripts/parse_hf_replays.py and src/lib/slp_parser.ts:
  • Recovery  — opens when YOU go offstage (y < -5). Success = you reach a
    grounded OR ledge state before losing the stock. Overlapping dips collapsed.
  • Edgeguard — opens when the OPPONENT goes offstage. Success = you landed a
    hit (their % rose) OR took the stock, before they made it back onto the
    stage (grounded only — ledge-hang stays open). Overlapping dips collapsed.

Usage (run on the wired-Ethernet machine — download is bandwidth-bound):
    macOS:    HF_TOKEN="hf_..." caffeinate -i .venv/bin/python scripts/rescan_recovery_edgeguard_only.py
    Windows:  set HF_TOKEN=hf_... && .venv\\Scripts\\python.exe scripts\\rescan_recovery_edgeguard_only.py
Resumable: re-running picks up from scripts/parse_hf_recov_eg_checkpoint.json.
"""

import json
import os
import shutil
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

OFFSTAGE_Y  = -5.0
EG_WINDOW   = 180   # 3 s (matches slp_parser.ts)
STATS       = ["recovery_success_rate", "edgeguard_success_rate"]

DL_WORKERS          = 32
BATCH_SIZE          = 200
CHECKPOINT_FILE     = "scripts/parse_hf_recov_eg_checkpoint.json"
BASELINES_PATH      = "scripts/grade_baselines.json"
MIN_MATCHUP_SAMPLES = 20


# ── Action-state predicates (mirror parse_hf_replays.py / slp_parser.ts) ────────

def _is_grounded(s):
    """Standing on a surface: grounded control (14–24), squat/landing/ground
    attacks (39–64), grab (212). Excludes airborne and ledge."""
    return (14 <= s <= 24) or (39 <= s <= 64) or s == 212


def _is_on_ledge(s):
    """Hanging on / acting from the ledge (CliffCatch 252 .. cliff jump 263).
    Reaching the ledge means you survived the offstage trip."""
    return 252 <= s <= 263


def _made_it_back(s):
    """Back to safety after an offstage trip: on the stage OR on the ledge."""
    return _is_grounded(s) or _is_on_ledge(s)


def _blast_kill(state, offstage, fd):
    """Death from one continuous knockback (75-91) that began ON-STAGE — the
    launching hit carried them to the blast zone, so no edgeguard/recovery
    happened. Such trips are excluded from both stats."""
    f = fd - 1
    if f < 0 or not (75 <= int(state[f]) <= 91):
        return False
    while f - 1 >= 0 and 75 <= int(state[f - 1]) <= 91:
        f -= 1
    return not bool(offstage[f])   # run began on-stage


# Ground-edge X per stage (ledge-grab position, measured from 700+ replays).
# |x| beyond this = off the stage horizontally. Mirrors slp_parser.ts.
STAGE_LEDGE_X = {2: 67.4, 3: 91.8, 8: 60.1, 28: 81.3, 31: 72.5, 32: 89.6}
DEFAULT_LEDGE_X = 90.0


def _get_positions(post):
    """Extract (x, y) numpy arrays from a peppi-py post-frame object."""
    try:
        pos = post.position
        if hasattr(pos, 'x'):
            return np.asarray(pos.x, dtype=float), np.asarray(pos.y, dtype=float)
        return (np.array(pos.field('x').to_pylist(), dtype=float),
                np.array(pos.field('y').to_pylist(), dtype=float))
    except (AttributeError, TypeError, ValueError):
        pass
    try:
        return np.asarray(post.position_x, dtype=float), np.asarray(post.position_y, dtype=float)
    except (AttributeError, TypeError):
        return None, None


# ── Core computation ──────────────────────────────────────────────────────────

def compute_recovery_edgeguard_both_ports(filepath: str):
    """
    Parse one replay and compute (recovery_success_rate, edgeguard_success_rate)
    from both ports' perspectives. Returns list of
    (player_char, opp_char, recovery_or_None, edgeguard_or_None).
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
    frames = game.frames
    try:
        ledge_x = STAGE_LEDGE_X.get(int(game.start.stage), DEFAULT_LEDGE_X)
    except (AttributeError, TypeError, ValueError):
        ledge_x = DEFAULT_LEDGE_X

    for player_slot, opp_slot in [(0, 1), (1, 0)]:
        player_port = port_indices[player_slot]
        opp_port    = port_indices[opp_slot]
        player_char = char_names[player_port]
        opp_char    = char_names[opp_port]

        p_post = frames.ports[player_port].leader.post
        o_post = frames.ports[opp_port].leader.post

        p_state  = np.array(p_post.state,  copy=False)
        o_state  = np.array(o_post.state,  copy=False)
        p_stocks = np.array(p_post.stocks, copy=False)
        o_stocks = np.array(o_post.stocks, copy=False)

        p_x, p_y = _get_positions(p_post)
        o_x, o_y = _get_positions(o_post)

        n_frames = len(p_state)
        if n_frames < 2:
            continue

        # ── Recovery ───────────────────────────────────────────────────────
        # Offstage = |x| past the ledge OR y < -5. Success = make it back (over
        # the stage, or grounded/ledge) before dying. Blast kills excluded.
        recovery = None
        if p_x is not None and p_y is not None:
            offstage = (np.abs(p_x) > ledge_x) | (p_y < OFFSTAGE_Y)
            edges = np.where(offstage[1:] & ~offstage[:-1])[0] + 1
            if len(edges) > 0:
                rec_sit = 0; rec_success = 0; next_allowed = 0
                for fo in edges:
                    fo = int(fo)
                    if fo < next_allowed:
                        continue
                    rec_sit += 1
                    ss = int(p_stocks[fo]); resolved = fo + EG_WINDOW
                    for fw in range(fo + 1, min(fo + EG_WINDOW, n_frames)):
                        if int(p_stocks[fw]) < ss:                     # died offstage
                            if _blast_kill(p_state, offstage, fw):
                                rec_sit -= 1                           #   blast kill → exclude
                            resolved = fw; break                       #   else: failed recovery
                        if (not offstage[fw]) or _made_it_back(int(p_state[fw])):
                            rec_success += 1; resolved = fw; break     # made it back
                    next_allowed = resolved
                recovery = rec_success / rec_sit if rec_sit > 0 else None

        # ── Edgeguard ──────────────────────────────────────────────────────
        # Mirror of recovery, on the opponent's trips. Success = they die there.
        # Dropped = they make it back. Blast kills excluded.
        edgeguard = None
        if o_x is not None and o_y is not None:
            offstage = (np.abs(o_x) > ledge_x) | (o_y < OFFSTAGE_Y)
            edges = np.where(offstage[1:] & ~offstage[:-1])[0] + 1
            if len(edges) > 0:
                eg_sit = 0; eg_success = 0; next_allowed = 0
                for fo in edges:
                    fo = int(fo)
                    if fo < next_allowed:
                        continue
                    eg_sit += 1
                    ss = int(o_stocks[fo]); resolved = fo + EG_WINDOW
                    for fw in range(fo + 1, min(fo + EG_WINDOW, n_frames)):
                        if int(o_stocks[fw]) < ss:                     # died offstage
                            if _blast_kill(o_state, offstage, fw):
                                eg_sit -= 1                            #   blast kill → exclude
                            else:
                                eg_success += 1                        #   real edgeguard
                            resolved = fw; break
                        if (not offstage[fw]) or _made_it_back(int(o_state[fw])):
                            resolved = fw; break                       # dropped (recovered)
                    next_allowed = resolved
                edgeguard = eg_success / eg_sit if eg_sit > 0 else None

        if recovery is not None or edgeguard is not None:
            results.append((player_char, opp_char, recovery, edgeguard))

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

def _empty_accum() -> dict:
    return {stat: {"by_player_char": {}, "by_opp_char": {},
                   "by_matchup": {}, "overall": []} for stat in STATS}


def load_checkpoint(path: str) -> dict:
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"processed_files": [], "accum": _empty_accum()}


def save_checkpoint(path: str, processed_set: set, accum: dict):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"processed_files": list(processed_set), "accum": accum}, f)
    os.replace(tmp, path)


# ── Accumulation ──────────────────────────────────────────────────────────────

def accum_add(accum: dict, stat: str, player_char: str, opp_char: str, rate: float):
    a = accum[stat]
    a["by_player_char"].setdefault(player_char, []).append(rate)
    a["by_opp_char"].setdefault(opp_char, []).append(rate)
    a["by_matchup"].setdefault(player_char, {}).setdefault(opp_char, []).append(rate)
    a["overall"].append(rate)


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
    print(f"\nPatching {baselines_path} with {', '.join(STATS)}...", flush=True)

    with open(baselines_path) as f:
        baselines = json.load(f)

    for stat in STATS:
        a = accum[stat]

        for char, vals in a["by_player_char"].items():
            if char not in baselines["by_player_char"]:
                continue
            baselines["by_player_char"][char][stat] = compute_percentiles(vals)

        baselines["by_player_char"]["_overall"][stat] = compute_percentiles(a["overall"])
        print(f"  {stat}: by_player_char[_overall] n={len(a['overall'])}", flush=True)

        for char, vals in a["by_opp_char"].items():
            if char not in baselines.get("by_opponent_char", {}):
                continue
            baselines["by_opponent_char"][char][stat] = compute_percentiles(vals)
        if "_overall" in baselines.get("by_opponent_char", {}):
            baselines["by_opponent_char"]["_overall"][stat] = compute_percentiles(a["overall"])

        for player_char, opps in a["by_matchup"].items():
            if player_char not in baselines.get("by_matchup", {}):
                continue
            for opp_char, vals in opps.items():
                if len(vals) < MIN_MATCHUP_SAMPLES:
                    continue
                if opp_char not in baselines["by_matchup"][player_char]:
                    continue
                baselines["by_matchup"][player_char][opp_char][stat] = compute_percentiles(vals)

    baselines["recovery_edgeguard_rescan"] = {
        "generated_at":    datetime.now(timezone.utc).isoformat(),
        "files_processed": total_processed,
        "overall_samples": {stat: len(accum[stat]["overall"]) for stat in STATS},
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
    accum = checkpoint.get("accum") or _empty_accum()
    for stat in STATS:  # tolerate older checkpoints missing a stat
        accum.setdefault(stat, {"by_player_char": {}, "by_opp_char": {},
                                "by_matchup": {}, "overall": []})

    total_processed = len(processed_set)
    total_errors    = 0

    print(f"Recovery+edgeguard rescan starting. Resume: {total_processed} files done.")
    for stat in STATS:
        print(f"  {stat}: {len(accum[stat]['overall'])} samples so far", flush=True)

    for char_dir in ALL_CHAR_DIRS:
        all_files = list_all_files(char_dir)
        remaining = [f for f in all_files if f not in processed_set]
        if not remaining:
            print(f"  {char_dir}: already complete ({len(all_files)} files)", flush=True)
            continue

        print(f"  {char_dir}: {len(remaining)}/{len(all_files)} files remaining", flush=True)
        download_dir = os.path.join("/tmp", f"hf_recoveg_{char_dir}")
        t_char = time.time()

        for batch_start in range(0, len(remaining), BATCH_SIZE):
            batch = remaining[batch_start:batch_start + BATCH_SIZE]
            print(f"\n  Batch {batch_start//BATCH_SIZE + 1}: {len(batch)} files | "
                  f"{char_dir} {batch_start}/{len(remaining)}", flush=True)

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

            for fp, local in local_paths:
                for player_char, opp_char, recovery, edgeguard in \
                        compute_recovery_edgeguard_both_ports(local):
                    if recovery is not None:
                        accum_add(accum, "recovery_success_rate", player_char, opp_char, recovery)
                    if edgeguard is not None:
                        accum_add(accum, "edgeguard_success_rate", player_char, opp_char, edgeguard)
                processed_set.add(fp)
                total_processed += 1

            if os.path.exists(download_dir):
                shutil.rmtree(download_dir, ignore_errors=True)

            save_checkpoint(CHECKPOINT_FILE, processed_set, accum)
            print(f"  Samples: " + ", ".join(
                f"{stat}={len(accum[stat]['overall'])}" for stat in STATS), flush=True)

        char_elapsed = time.time() - t_char
        print(f"\n  {char_dir} COMPLETE in {char_elapsed:.0f}s "
              f"({total_errors} cumulative errors)", flush=True)

    if os.path.exists(CHECKPOINT_FILE):
        os.remove(CHECKPOINT_FILE)

    elapsed = time.time() - t_start
    print(f"\n{'='*60}")
    print(f"Scan complete: {total_processed} files, {elapsed/60:.1f} min", flush=True)

    patch_baselines(accum, BASELINES_PATH, total_processed)

    print("\nDone. Run regen_benchmarks.py to regenerate grade-benchmarks.ts.")


if __name__ == "__main__":
    main()
