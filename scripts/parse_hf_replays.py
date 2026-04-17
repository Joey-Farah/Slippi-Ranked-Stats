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
    python scripts/parse_hf_replays.py --character ALL   # parse every character

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

# Stats included in baselines — must match STAT_LABELS keys in grading.ts
STAT_KEYS = [
    # Original scored stats
    "neutral_win_ratio",
    "openings_per_kill",
    "damage_per_opening",
    "avg_kill_percent",
    "avg_death_percent",
    "l_cancel_ratio",
    "inputs_per_minute",
    # New stats (pending benchmarks — remove from DISPLAY_ONLY_STATS in grading.ts once generated)
    "opening_conversion_rate",
    "stage_control_ratio",
    "lead_maintenance_rate",
    "tech_chase_rate",
    "edgeguard_success_rate",
    "hit_advantage_rate",
    "recovery_success_rate",
    "avg_stock_duration",
    "respawn_defense_rate",
    "comeback_rate",
    "wavedash_miss_rate",
]

MIN_MATCHUP_SAMPLES = 20
DL_WORKERS = 8  # concurrent download threads (I/O-bound, threads are fine)

# Lookup table: number of set bits for each 12-bit value (0–4095).
# Used by the IPM Hamming-weight calculation to match slippi-js's buttonInputCount.
_BIT_COUNT_12 = np.array([bin(i).count('1') for i in range(4096)], dtype=np.uint8)

CHECKPOINT_FILE = "parse_hf_checkpoint.json"

# All character directories in the HuggingFace dataset.
# Ordered by replay count (smallest first → quick progress early, big chars last).
ALL_CHAR_DIRS = [
    "PICHU", "BOWSER", "MEWTWO", "NESS", "KIRBY",            # <200–400
    "ROY", "YLINK", "GAMEANDWATCH", "MARIO", "LINK",          # 400–800
    "DK", "DOC", "PIKACHU", "YOSHI", "LUIGI",                 # 1k–2.3k
    "ICE_CLIMBERS", "GANONDORF", "SAMUS",                      # 2.5k–3.6k
    "JIGGLYPUFF", "PEACH",                                     # 5k–6.7k
    "ZELDA_SHEIK",                                             # 21k
    "CPTFALCON", "MARTH",                                      # 33k–36k
    "FALCO", "FOX",                                            # 42k–56k
]

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

DEFENSIVE_STATES = {233, 234, 235}  # roll fwd (233), roll bwd (234), spot dodge (235) — matches slippi-js

# Conversion detection (slippi-js: isDamaged || isGrabbed || isCommandGrabbed)
# A conversion/opening starts when opponent enters any of these states.
# RESET_FRAMES (45): frames of isInControl before the conversion ends.
RESET_FRAMES = 45

def _make_in_stun_mask(states_arr):
    """Opponent is in hitstun/grabbed/command-grabbed — slippi-js conversion start condition."""
    s = states_arr
    return (
        ((s >= 75) & (s <= 91)) |       # isDamaged: hitstun
        (s == 38) |                      # DamageFall
        (s == 185) | (s == 193) |        # JabResetUp, JabResetDown
        ((s >= 223) & (s <= 232)) |      # isGrabbed: capture states
        ((s >= 266) & (s <= 304) & (s != 293)) |  # isCommandGrabbed range 1
        ((s >= 327) & (s <= 338))        # isCommandGrabbed range 2
    )

# ── Stat computation (vectorized with numpy) ─────────────────────────────────

def _get_positions(post):
    """Extract (x, y) numpy arrays from a peppi-py post-frame object. Returns (None, None) on failure."""
    try:
        pos = post.position
        if hasattr(pos, 'x'):
            return np.asarray(pos.x, dtype=float), np.asarray(pos.y, dtype=float)
        # PyArrow StructArray: use field()
        return (np.array(pos.field('x').to_pylist(), dtype=float),
                np.array(pos.field('y').to_pylist(), dtype=float))
    except (AttributeError, TypeError, ValueError):
        pass
    try:
        return np.asarray(post.position_x, dtype=float), np.asarray(post.position_y, dtype=float)
    except (AttributeError, TypeError):
        return None, None


def compute_game_stats(game, player_idx: int, opp_idx: int) -> dict | None:
    """
    Compute all 18 performance stats for player_idx in the given peppi game.

    Uses numpy vectorized operations where possible; per-event Python loops
    for windowed stats (tech chase, edgeguard, recovery, etc.).

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
    p_state  = np.array(p_post.state,   copy=False)
    o_state  = np.array(o_post.state,   copy=False)
    p_pct    = np.array(p_post.percent, copy=False)
    o_pct    = np.array(o_post.percent, copy=False)
    p_stocks = np.array(p_post.stocks,  copy=False)
    o_stocks = np.array(o_post.stocks,  copy=False)

    n_frames = len(p_state)
    if n_frames < 60:
        return None

    # ── Position data (stage_control, edgeguard, recovery, wavedash) ─────────
    p_x, p_y = _get_positions(p_post)
    o_x, o_y = _get_positions(o_post)

    # ── State masks ──────────────────────────────────────────────────────────
    p_ctrl = _make_state_mask(p_state, IN_CONTROL_RANGES)
    o_ctrl = _make_state_mask(o_state, IN_CONTROL_RANGES)
    p_vuln = _make_state_mask(p_state, VULNERABLE_RANGES)
    o_vuln = _make_state_mask(o_state, VULNERABLE_RANGES)

    duration_min = n_frames / 3600.0  # 60 fps × 60 sec

    # ── Conversion detection (slippi-js methodology, 45f reset) ──────────────
    # A conversion starts when opp enters isDamaged/isGrabbed/isCommandGrabbed.
    # It ends when opp has been in isInControl for RESET_FRAMES consecutive frames.
    # This matches Slippi Launcher's openings_per_kill and neutral_win_ratio.
    o_stun = _make_in_stun_mask(o_state)
    p_stun = _make_in_stun_mask(p_state)

    player_conv_count    = 0
    player_neutral_wins  = 0
    player_conv_active   = False
    player_reset_ctr     = 0
    conv_start_pct       = -1.0
    conv_start_stocks    = -1

    opp_conv_count   = 0
    opp_neutral_wins = 0
    opp_conv_active  = False
    opp_reset_ctr    = 0

    opening_conv_count = 0
    conv_hit_count     = 0
    prev_o_stun        = False

    for i in range(n_frames):
        # Our conversion on opponent
        cur_o_stun = bool(o_stun[i])
        if cur_o_stun:
            if not player_conv_active:
                player_conv_active = True
                player_conv_count += 1
                conv_hit_count    = 1
                if not opp_conv_active:    # neutral-win if opp wasn't punishing us
                    player_neutral_wins += 1
                conv_start_pct    = float(o_pct[i])
                conv_start_stocks = int(o_stocks[i])
            elif not prev_o_stun:
                conv_hit_count += 1  # opponent re-entered stun = new hit connected
            player_reset_ctr = 0
        elif player_conv_active:
            if o_ctrl[i] or player_reset_ctr > 0:
                player_reset_ctr += 1
                if player_reset_ctr > RESET_FRAMES:
                    if conv_hit_count >= 2:
                        opening_conv_count += 1
                    player_conv_active = False
                    player_reset_ctr   = 0
                    conv_start_pct     = -1.0
                    conv_start_stocks  = -1
                    conv_hit_count     = 0

        # Stock loss ends our active conversion (kill)
        if i > 0 and int(o_stocks[i]) < int(o_stocks[i - 1]) and player_conv_active:
            if conv_hit_count >= 2:
                opening_conv_count += 1
            player_conv_active = False
            player_reset_ctr   = 0
            conv_start_pct     = -1.0
            conv_start_stocks  = -1
            conv_hit_count     = 0

        prev_o_stun = cur_o_stun

        # Opponent's conversion on us
        if bool(p_stun[i]):
            if not opp_conv_active:
                opp_conv_active = True
                opp_conv_count += 1
                if not player_conv_active:  # neutral-win for opp if we weren't punishing
                    opp_neutral_wins += 1
            opp_reset_ctr = 0
        elif opp_conv_active:
            if p_ctrl[i] or opp_reset_ctr > 0:
                opp_reset_ctr += 1
                if opp_reset_ctr > RESET_FRAMES:
                    opp_conv_active = False
                    opp_reset_ctr   = 0

        if i > 0 and int(p_stocks[i]) < int(p_stocks[i - 1]) and opp_conv_active:
            opp_conv_active = False
            opp_reset_ctr   = 0

    # Finalize any conversion still active at game end (typically the killing blow)
    if player_conv_active and conv_hit_count >= 2:
        opening_conv_count += 1

    nw_total = player_neutral_wins + opp_neutral_wins

    # ── L-cancel tracking ────────────────────────────────────────────────────
    # Count once per new aerial-attack action (slippi-js isNewAction guard).
    # States 65-74 = aerial attacks + landing-lag. l_cancel status is set on
    # the first frame the player transitions into any of these states.
    lc_data = p_post.l_cancel
    lc_successes = lc_attempts = 0
    if lc_data is not None:
        lc_arr  = np.array(lc_data, copy=False)
        aerial  = (p_state >= 65) & (p_state <= 74)
        new_aer = aerial & ~np.concatenate([[False], aerial[:-1]])
        valid   = lc_arr[new_aer]
        lc_successes = int(np.sum(valid == 1))
        lc_attempts  = int(np.sum((valid == 1) | (valid == 2)))

    # ── Inputs per minute ────────────────────────────────────────────────────
    # Match slippi-js digitalInputsPerMinute: Hamming weight of new button
    # presses (rising edges) on the 12 digital buttons (bits 0-11, mask 0x0fff).
    ipm = None
    if p_pre is not None and p_pre.buttons_physical is not None:
        bp = np.array(p_pre.buttons_physical, copy=False)
        if len(bp) > 1:
            bp32       = bp.astype(np.int32)
            new_presses = (~bp32[:-1] & bp32[1:]) & 0x0fff
            input_changes = int(np.sum(_BIT_COUNT_12[new_presses]))
            if duration_min > 0:
                ipm = input_changes / duration_min

    # ── Kill / death percent tracking ────────────────────────────────────────
    o_stock_diff = np.diff(o_stocks.astype(np.int16))
    p_stock_diff = np.diff(p_stocks.astype(np.int16))

    kill_frames  = np.where(o_stock_diff < 0)[0]
    death_frames = np.where(p_stock_diff < 0)[0]

    kill_percents  = [p for p in o_pct[kill_frames].tolist()  if p > 0]
    death_percents = [p for p in p_pct[death_frames].tolist() if p > 0]
    kills = len(kill_percents)

    total_damage = float(np.sum(o_pct[kill_frames])) if len(kill_frames) > 0 else 0.0
    total_damage += float(o_pct[-1])

    # ── Opening conversion rate ──────────────────────────────────────────────
    # Of all conversions (openings), what fraction dealt ≥20% or killed?
    # opening_conv_count accumulated in the conversion loop above.
    opening_conversion_rate = opening_conv_count / player_conv_count if player_conv_count > 0 else None

    # ── Stage control ratio ──────────────────────────────────────────────────
    stage_control_ratio = None
    if p_x is not None and o_x is not None and p_y is not None and o_y is not None:
        on_stage = (p_y > -5.0) & (o_y > -5.0)
        valid = int(np.sum(on_stage))
        if valid > 0:
            stage_control_ratio = float(np.sum((np.abs(p_x) < np.abs(o_x)) & on_stage)) / valid

    # ── Tech chase rate ──────────────────────────────────────────────────────
    o_down       = _make_state_mask(o_state, [(183, 204)])
    down_frames  = np.where(o_down[1:] & ~o_down[:-1])[0] + 1
    tech_chase_rate = None
    if len(down_frames) > 0:
        tc_hits = 0
        for fd in down_frames:
            sp = float(o_pct[fd])
            for fw in range(int(fd) + 1, min(int(fd) + 45, n_frames)):
                if float(o_pct[fw]) > sp + 2.0:
                    tc_hits += 1; break
                if o_ctrl[fw]:
                    break
        tech_chase_rate = tc_hits / len(down_frames)

    # ── Edgeguard success rate ───────────────────────────────────────────────
    edgeguard_success_rate = None
    if o_y is not None:
        o_offstage    = o_y < -5.0
        offstage_frs  = np.where(o_offstage[1:] & ~o_offstage[:-1])[0] + 1
        if len(offstage_frs) > 0:
            eg_kills = 0
            for fo in offstage_frs:
                ss = int(o_stocks[fo])
                for fw in range(int(fo) + 1, min(int(fo) + 180, n_frames)):
                    if int(o_stocks[fw]) < ss:
                        eg_kills += 1; break
            edgeguard_success_rate = eg_kills / len(offstage_frs)

    # ── Recovery success rate ────────────────────────────────────────────────
    recovery_success_rate = None
    if p_y is not None:
        p_offstage    = p_y < -5.0
        p_offstage_frs = np.where(p_offstage[1:] & ~p_offstage[:-1])[0] + 1
        if len(p_offstage_frs) > 0:
            recoveries = 0
            for fo in p_offstage_frs:
                ss = int(p_stocks[fo]); recovered = False
                for fw in range(int(fo) + 1, min(int(fo) + 180, n_frames)):
                    if int(p_stocks[fw]) < ss:
                        break
                    if float(p_y[fw]) > 5.0:
                        recovered = True; break
                if recovered:
                    recoveries += 1
            recovery_success_rate = recoveries / len(p_offstage_frs)

    # ── Hit advantage rate ───────────────────────────────────────────────────
    p_atk      = _make_state_mask(p_state, ATTACKING_RANGES)
    hit_frs    = np.where(o_vuln[1:] & ~o_vuln[:-1])[0] + 1
    hit_advantage_rate = None
    if len(hit_frs) > 0:
        followups = int(np.sum([
            np.any(p_atk[int(fh)+1:min(int(fh)+30, n_frames)])
            for fh in hit_frs
        ]))
        hit_advantage_rate = followups / len(hit_frs)

    # ── Average stock duration (frames) ─────────────────────────────────────
    if len(death_frames) > 0:
        prev = 0; durs = []
        for fd in death_frames:
            durs.append(int(fd) - prev); prev = int(fd) + 1
        avg_stock_duration = float(np.mean(durs))
    else:
        avg_stock_duration = float(n_frames)

    # ── Respawn defense rate ─────────────────────────────────────────────────
    # After each death, did player avoid taking ≥5% in the ~150f respawn window?
    respawn_defense_rate = None
    if len(death_frames) > 0:
        ok = 0
        for fd in death_frames:
            rs = int(fd) + 80  # approx respawn frame
            re = min(rs + 150, n_frames - 1)
            if rs >= n_frames:
                continue
            sp   = float(p_pct[min(rs, n_frames - 1)])
            safe = all(float(p_pct[fw]) <= sp + 5.0 for fw in range(rs + 1, re + 1))
            if safe:
                ok += 1
        respawn_defense_rate = ok / len(death_frames)

    # ── Comeback rate & Lead maintenance rate (binary per game) ──────────────
    player_won   = (int(p_stocks[-1]) > int(o_stocks[-1])) or \
                   (int(p_stocks[-1]) == int(o_stocks[-1]) and float(p_pct[-1]) < float(o_pct[-1]))
    player_ahead = (o_stocks < p_stocks) | ((o_stocks == p_stocks) & (o_pct > p_pct + 15.0))
    player_behind = (p_stocks < o_stocks) | ((p_stocks == o_stocks) & (p_pct > o_pct + 15.0))

    lead_maintenance_rate = (1.0 if player_won else 0.0) if bool(np.any(player_ahead))  else None
    comeback_rate         = (1.0 if player_won else 0.0) if bool(np.any(player_behind)) else None

    # ── Wavedash miss rate ───────────────────────────────────────────────────
    # Mirrors slp_parser.ts detection: Jump (near ground) → Airdodge (within 4f)
    # → LandingFallSpecial (within 4f) = success. Airdodge without LandingFallSpecial = miss.
    JUMP_STATES       = {24, 25}   # JumpSquat (24), JumpF (25)
    ESCAPE_AIR        = 236        # EscapeAir (AIR_DODGE = 236 in slippi-js)
    LANDING_FALL_SPEC = 43         # LandingFallSpecial (state 43 in slippi-js)
    WD_JUMP_Y         = 5.0        # must be near ground when jumping
    WD_DODGE_F        = 4          # airdodge must come within 4 frames of jump
    WD_LAND_F         = 4          # landing must come within 4 frames of airdodge

    wd_attempts = 0; wd_successes = 0
    jump_frame = -1; dodge_frame = -1
    prev_state = -1
    for fi in range(n_frames):
        s = int(p_state[fi])
        if s != prev_state:
            if s in JUMP_STATES and (p_y is None or float(p_y[fi]) < WD_JUMP_Y):
                jump_frame = fi; dodge_frame = -1
            elif s == ESCAPE_AIR and jump_frame >= 0 and fi <= jump_frame + WD_DODGE_F:
                wd_attempts += 1; dodge_frame = fi; jump_frame = -1
            elif s == LANDING_FALL_SPEC and dodge_frame >= 0 and fi <= dodge_frame + WD_LAND_F:
                wd_successes += 1; dodge_frame = -1
        if jump_frame >= 0 and fi > jump_frame + WD_DODGE_F + 1:
            jump_frame = -1
        if dodge_frame >= 0 and fi > dodge_frame + WD_LAND_F + 1:
            dodge_frame = -1
        prev_state = s
    wavedash_miss_rate = (wd_attempts - wd_successes) / wd_attempts if wd_attempts > 0 else None

    # ── Assemble results ─────────────────────────────────────────────────────
    return {
        "neutral_win_ratio":      player_neutral_wins / nw_total if nw_total > 0 else None,
        "openings_per_kill":      player_conv_count / kills if kills > 0 else None,
        "damage_per_opening":     total_damage / player_conv_count if player_conv_count > 0 else None,
        "avg_kill_percent":       sum(kill_percents) / kills if kills > 0 else None,
        "avg_death_percent":      sum(death_percents) / len(death_percents) if death_percents else None,
        "l_cancel_ratio":         lc_successes / lc_attempts if lc_attempts > 0 else None,
        "inputs_per_minute":      ipm,
        "opening_conversion_rate": opening_conversion_rate,
        "stage_control_ratio":    stage_control_ratio,
        "lead_maintenance_rate":  lead_maintenance_rate,
        "tech_chase_rate":        tech_chase_rate,
        "edgeguard_success_rate": edgeguard_success_rate,
        "hit_advantage_rate":     hit_advantage_rate,
        "recovery_success_rate":  recovery_success_rate,
        "avg_stock_duration":     avg_stock_duration,
        "respawn_defense_rate":   respawn_defense_rate,
        "comeback_rate":          comeback_rate,
        "wavedash_miss_rate":     wavedash_miss_rate,
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

def process_character_dir(
    character: str,
    batch_size: int,
    dl_workers: int,
    checkpoint_path: str,
    # Shared accumulators (mutated in-place across characters)
    by_player_char: dict,
    by_opponent_char: dict,
    by_matchup: dict,
    overall_accum: dict,
    # Shared counters — passed as a mutable dict
    counters: dict,
) -> bool:
    """
    Download + parse all replays from a single character directory.
    Returns True on success, False if no files found.
    """
    all_files = list_all_files(character)
    if not all_files:
        print(f"  WARNING: No files found for {character}, skipping", flush=True)
        return False

    # Load checkpoint for resume within this character
    checkpoint = load_checkpoint(checkpoint_path)
    processed_set = set(checkpoint.get("processed_files", []))
    remaining = [f for f in all_files if f not in processed_set]

    if not remaining:
        print(f"  {character}: all {len(all_files)} files already processed (checkpoint)", flush=True)
        return True

    print(f"  Resume: {len(processed_set)} already done, {len(remaining)} remaining", flush=True)

    download_dir = os.path.join("/tmp", f"hf_parse_{character}")
    batch_num = 0
    t_char_start = time.time()

    for batch_start in range(0, len(remaining), batch_size):
        batch_files = remaining[batch_start:batch_start + batch_size]
        batch_num += 1
        batch_processed = 0
        batch_errors = 0

        print(f"\n  Batch {batch_num}: downloading {len(batch_files)} files...")
        print(f"    {character} progress: {len(processed_set)}/{len(all_files)} "
              f"({100*len(processed_set)/len(all_files):.1f}%)")
        t_batch = time.time()

        def download_one(file_path):
            local = hf_hub_download(
                repo_id=REPO_ID,
                filename=file_path,
                repo_type=REPO_TYPE,
                local_dir=download_dir,
            )
            return (file_path, local)

        local_paths = []
        with ThreadPoolExecutor(max_workers=dl_workers) as dl_pool:
            futures = {dl_pool.submit(download_one, fp): fp for fp in batch_files}
            try:
                for future in as_completed(futures, timeout=300):
                    try:
                        local_paths.append(future.result(timeout=60))
                    except Exception:
                        counters["total_errors"] += 1
                        batch_errors += 1
            except TimeoutError:
                stalled = sum(1 for f in futures if not f.done())
                print(f"    WARNING: {stalled} downloads timed out, skipping", flush=True)
                for f in futures:
                    f.cancel()
                counters["total_errors"] += stalled
                batch_errors += stalled

        dl_time = time.time() - t_batch
        print(f"    Downloaded {len(local_paths)} files in {dl_time:.1f}s", flush=True)

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
            counters["total_processed"] += 1

        parse_time = time.time() - t_parse

        # Clean up downloaded files
        if os.path.exists(download_dir):
            shutil.rmtree(download_dir, ignore_errors=True)

        char_elapsed = time.time() - t_char_start
        print(f"    Parsed {batch_processed} games ({batch_errors} errors) in {parse_time:.1f}s")
        print(f"    Rate: {len(local_paths)/max(parse_time, 0.001):.0f} parses/sec")
        print(f"    {character}: {len(processed_set)}/{len(all_files)} "
              f"({100*len(processed_set)/len(all_files):.1f}%) "
              f"in {char_elapsed:.0f}s", flush=True)

        # Save per-character checkpoint (just processed file list for this char)
        save_checkpoint(checkpoint_path, {
            "processed_files": list(processed_set),
        })

    char_elapsed = time.time() - t_char_start
    print(f"\n  {character} COMPLETE: {len(all_files)} files in {char_elapsed:.0f}s "
          f"({counters['total_errors']} cumulative errors)", flush=True)

    # Clean up per-character checkpoint on success
    if os.path.exists(checkpoint_path):
        os.remove(checkpoint_path)

    return True


def build_and_write_output(
    by_player_char: dict,
    by_opponent_char: dict,
    by_matchup: dict,
    overall_accum: dict,
    total_processed: int,
    source_label: str,
    output_path: str,
):
    """Compute percentiles from accumulators and write grade_baselines.json."""
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

    overall_n = max((len(overall_accum.get(k, [])) for k in STAT_KEYS), default=0)
    overall_entry = {"sample_size": overall_n}
    for key in STAT_KEYS:
        overall_entry[key] = compute_percentiles(overall_accum.get(key, []))

    output = {
        "generated_at":     datetime.now(timezone.utc).isoformat(),
        "source":           source_label,
        "replay_count":     total_processed,
        "by_player_char":   build_char_section(by_player_char),
        "by_opponent_char": build_char_section(by_opponent_char),
        "by_matchup":       build_matchup_section(by_matchup),
    }
    output["by_player_char"]["_overall"]   = overall_entry
    output["by_opponent_char"]["_overall"] = overall_entry

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2)

    player_chars = sorted(k for k in output["by_player_char"] if k != "_overall")
    matchup_count = sum(len(v) for v in output["by_matchup"].values())
    print(f"\nBaselines written to: {output_path}")
    print(f"Player chars ({len(player_chars)}): {player_chars}")
    print(f"Matchup entries: {matchup_count}")
    print(f"Total samples: {overall_n}")


def main():
    parser = argparse.ArgumentParser(
        description="Parse Slippi replays from HuggingFace dataset with peppi-py"
    )
    parser.add_argument("--character",  default="FALCO",
                        help="Character directory (default: FALCO). Use ALL for every character.")
    parser.add_argument("--batch-size", type=int, default=500,
                        help="Files to download per batch (default: 500)")
    parser.add_argument("--dl-workers", type=int, default=DL_WORKERS,
                        help=f"Concurrent download threads (default: {DL_WORKERS})")
    parser.add_argument("--output",     default=os.path.join(os.path.dirname(__file__), "grade_baselines.json"),
                        help="Output path for grade_baselines.json")
    args = parser.parse_args()

    # Determine which characters to process
    if args.character.upper() == "ALL":
        char_dirs = ALL_CHAR_DIRS
    else:
        char_dirs = [args.character.upper()]

    # Shared accumulators across all characters
    by_player_char: dict  = {}
    by_opponent_char: dict = {}
    by_matchup: dict      = {}
    overall_accum: dict   = {s: [] for s in STAT_KEYS}
    counters = {"total_processed": 0, "total_errors": 0}

    # Load global checkpoint (tracks which characters are fully done)
    scripts_dir = os.path.dirname(__file__)
    global_ckpt_path = os.path.join(scripts_dir, "parse_hf_global_checkpoint.json")
    global_ckpt = {}
    if os.path.exists(global_ckpt_path):
        with open(global_ckpt_path, 'r') as f:
            global_ckpt = json.load(f)
    completed_chars = set(global_ckpt.get("completed_chars", []))

    t_start = time.time()

    print(f"{'='*60}")
    print(f"HuggingFace parse — {len(char_dirs)} character(s), {len(STAT_KEYS)} stats")
    print(f"Already completed: {sorted(completed_chars) if completed_chars else '(none)'}")
    print(f"{'='*60}", flush=True)

    for i, char_dir in enumerate(char_dirs, 1):
        if char_dir in completed_chars:
            print(f"\n[{i}/{len(char_dirs)}] {char_dir} — SKIPPED (already complete)", flush=True)
            continue

        elapsed = time.time() - t_start
        print(f"\n{'='*60}")
        print(f"[{i}/{len(char_dirs)}] {char_dir} — starting (elapsed: {elapsed/60:.1f}m)")
        print(f"{'='*60}", flush=True)

        # Per-character checkpoint (for resume within a character)
        char_ckpt_path = os.path.join(scripts_dir, f"parse_hf_checkpoint_{char_dir}.json")

        success = process_character_dir(
            character=char_dir,
            batch_size=args.batch_size,
            dl_workers=args.dl_workers,
            checkpoint_path=char_ckpt_path,
            by_player_char=by_player_char,
            by_opponent_char=by_opponent_char,
            by_matchup=by_matchup,
            overall_accum=overall_accum,
            counters=counters,
        )

        if success:
            completed_chars.add(char_dir)
            # Save global progress
            save_checkpoint(global_ckpt_path, {
                "completed_chars": sorted(completed_chars),
                "total_processed": counters["total_processed"],
                "total_errors": counters["total_errors"],
                "last_updated": datetime.now(timezone.utc).isoformat(),
            })

            # Write intermediate baselines after each character so progress is visible
            if len(char_dirs) > 1:
                elapsed = time.time() - t_start
                print(f"\n  Writing intermediate baselines ({len(completed_chars)}/{len(char_dirs)} chars, "
                      f"{elapsed/60:.1f}m elapsed)...", flush=True)
                source = f"huggingface/{REPO_ID}/ALL ({len(completed_chars)}/{len(char_dirs)})"
                build_and_write_output(
                    by_player_char, by_opponent_char, by_matchup, overall_accum,
                    counters["total_processed"], source, args.output,
                )

    # ── Final output ──────────────────────────────────────────────────────────
    total_time = time.time() - t_start
    print(f"\n{'='*60}")
    print(f"ALL CHARACTERS COMPLETE in {total_time/60:.1f} minutes")
    print(f"Processed: {counters['total_processed']}  Errors: {counters['total_errors']}")
    print(f"{'='*60}", flush=True)

    source = f"huggingface/{REPO_ID}/ALL" if len(char_dirs) > 1 else f"huggingface/{REPO_ID}/{char_dirs[0]}"
    build_and_write_output(
        by_player_char, by_opponent_char, by_matchup, overall_accum,
        counters["total_processed"], source, args.output,
    )

    # Clean up global checkpoint on full completion
    if os.path.exists(global_ckpt_path):
        os.remove(global_ckpt_path)
        print("Global checkpoint removed (all characters completed)")


if __name__ == "__main__":
    main()
