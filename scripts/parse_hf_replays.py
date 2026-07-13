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
import re
import shutil
import sys
import tarfile
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

# --dataset ranked: anonymized plat+ ranked replays, tarballs per (char, rank pair,
# archive). Filenames carry the rank pair: "master-platinum-<hex>.slp". The hex
# hash is globally unique → dedup key (each non-ditto replay appears in BOTH
# players' character tarballs).
RANKED_REPO_ID = "erickfm/melee-ranked-replays"
RANK_RE = re.compile(r"^([a-z]+)-([a-z]+)-[0-9a-f]+\.slp$")

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


def _is_grounded(s):
    """Standing on a surface: grounded control (14–24), squat/landing/ground
    attacks (39–64), grab (212). Excludes airborne and ledge. Mirrors
    slp_parser.ts isGrounded."""
    return (14 <= s <= 24) or (39 <= s <= 64) or s == 212


def _is_on_ledge(s):
    """Hanging on / acting from the ledge (CliffCatch 252 .. cliff jump family
    263). Reaching the ledge means you survived the offstage trip. Mirrors
    slp_parser.ts isOnLedge."""
    return 252 <= s <= 263


def _made_it_back(s):
    """Back to safety after an offstage trip: on the stage OR on the ledge.
    Shared by recovery (your success) and edgeguard (opponent escaped)."""
    return _is_grounded(s) or _is_on_ledge(s)


def _blast_kill(state, offstage, fd):
    """A death is a 'blast kill' if it came from one continuous knockback (states
    75-91) that began ON-STAGE — the launching hit carried them straight to the
    blast zone, so no edgeguard/recovery happened. Such trips are excluded from
    both stats. Mirrors the *Ko* tracking in slp_parser.ts."""
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


# ── Ice Climbers follower (Nana) support ──────────────────────────────────────
# peppi NULL-PADS the follower arrays to leader length: None on every frame Nana
# is dead. Her stocks field MIRRORS Popo's shared stock, so the ONLY death signal
# is the present->null transition. We fold hits on Nana into openings/damage and
# her offstage trips into edgeguard/recovery; kills stay Popo-only (Nana ≠ a stock).

def _follower_lists(post):
    """Extract (state, x, y, percent) as Python lists with None on absent frames."""
    states = post.state.to_pylist()
    pcts   = post.percent.to_pylist()
    try:
        pos = post.position
        if hasattr(pos, 'x'):
            xs = pos.x.to_pylist(); ys = pos.y.to_pylist()
        else:
            xs = pos.field('x').to_pylist(); ys = pos.field('y').to_pylist()
    except (AttributeError, TypeError, ValueError):
        xs = [None] * len(states); ys = [None] * len(states)
    return states, xs, ys, pcts


def _nullable_mask(states, predicate_ranges):
    """Boolean mask over a None-padded state list; None frames are always False."""
    mask = np.zeros(len(states), dtype=bool)
    for i, s in enumerate(states):
        if s is None:
            continue
        for lo, hi in predicate_ranges:
            if lo <= s <= hi:
                mask[i] = True
                break
    return mask


def _follower_in_stun(states):
    """In-stun mask for a None-padded follower state list (mirrors _make_in_stun_mask)."""
    mask = np.zeros(len(states), dtype=bool)
    for i, s in enumerate(states):
        if s is None:
            continue
        if ((75 <= s <= 91) or s == 38 or s == 185 or s == 193
                or (223 <= s <= 232)
                or (266 <= s <= 304 and s != 293)
                or (327 <= s <= 338)):
            mask[i] = True
    return mask


def _follower_percent_array(pcts):
    """Follower percent with None->0.0 (so combined = popo + 0 when Nana is dead)."""
    return np.array([0.0 if v is None else float(v) for v in pcts], dtype=float)


def _follower_damage(pcts):
    """Total damage dealt to Nana = sum of positive percent deltas, resetting across
    death gaps (None). Matches the Popo 'peak per life' total when summed in."""
    total = 0.0
    prev = None
    for v in pcts:
        if v is None:
            prev = None        # reset across the death gap
            continue
        if prev is not None and v > prev:
            total += v - prev
        prev = v
    return total


def _follower_offstage_trips(states, xs, ys, ledge_x, is_edgeguard):
    """Count Nana's independent offstage trips to FOLD INTO the Popo edgeguard/recovery
    totals. Death = present->null transition; her last present frame's position says
    whether she died offstage. is_edgeguard=True: death offstage = success. False
    (recovery): death offstage = counted failure; making it back = success. Blast
    kills (one on-stage-origin knockback to the blast zone) are excluded. Mirrors
    countFollowerTrips in slp_parser.ts."""
    OFF_Y = -5.0
    EG_WINDOW = 480

    def is_off(x, y):
        if x is None or y is None:
            return False
        return abs(x) > ledge_x or y < OFF_Y

    sit = 0; success = 0
    trip_open = False; trip_start = -1
    prev_i = None; prev_x = None; prev_y = None
    ko_active = False; ko_started_on = False; prev_in_kb = False
    n = len(states)

    for i in range(n):
        st = states[i]
        if st is None:
            if prev_i is not None:                      # present->null = Nana died here
                if trip_open and is_off(prev_x, prev_y):
                    if ko_active and ko_started_on:
                        sit -= 1                         # blast kill → exclude trip
                    elif is_edgeguard:
                        success += 1                     # died offstage = edgeguard success
                    # recovery: died offstage = failed recovery, already in sit
                trip_open = False
                ko_active = False; prev_in_kb = False
                prev_i = None
            continue

        x = xs[i]; y = ys[i]
        off = is_off(x, y)
        prev_off = (prev_x is not None) and is_off(prev_x, prev_y)
        if not trip_open and off and (prev_i is None or not prev_off):
            sit += 1; trip_open = True; trip_start = i
        if trip_open:
            if (not off) or _made_it_back(int(st)):
                if not is_edgeguard:
                    success += 1                         # recovery: made it back
                trip_open = False
            elif i > trip_start + EG_WINDOW:
                trip_open = False

        in_kb = 75 <= int(st) <= 91
        if in_kb and not prev_in_kb:
            ko_active = True; ko_started_on = not off
        elif not in_kb:
            ko_active = False
        prev_in_kb = in_kb
        prev_i = i; prev_x = x; prev_y = y

    return sit, success


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
    # Followers (Nana) — present only for Ice Climbers ports, None otherwise.
    p_foll = p_port.follower
    o_foll = o_port.follower

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
    try:
        stage_id = int(game.start.stage)
    except (AttributeError, TypeError, ValueError):
        stage_id = -1
    ledge_x = STAGE_LEDGE_X.get(stage_id, DEFAULT_LEDGE_X)

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

    # ── Ice Climbers: fold Nana into the opponent/player entity ───────────────
    # Entity is in-stun / in-control if EITHER climber is, so hits on Nana count
    # as openings. Combined percent (Popo + Nana, Nana=0 when dead) drives the
    # conversion-start / multi-hit tracking. Position lists feed Nana's edgeguard
    # / recovery trips below. All no-ops when the port isn't Ice Climbers.
    of_states = of_x = of_y = of_pct = None
    pf_states = pf_x = pf_y = pf_pct = None
    o_pct_conv = o_pct
    if o_foll is not None:
        of_states, of_x, of_y, of_pct = _follower_lists(o_foll.post)
        o_stun = o_stun | _follower_in_stun(of_states)
        o_ctrl = o_ctrl | _nullable_mask(of_states, IN_CONTROL_RANGES)
        o_pct_conv = o_pct + _follower_percent_array(of_pct)
    if p_foll is not None:
        pf_states, pf_x, pf_y, pf_pct = _follower_lists(p_foll.post)
        p_stun = p_stun | _follower_in_stun(pf_states)
        p_ctrl = p_ctrl | _nullable_mask(pf_states, IN_CONTROL_RANGES)

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

    opening_conv_count  = 0
    conv_hit_count      = 0
    conv_last_opp_pct   = -1.0
    prev_o_stun         = False

    for i in range(n_frames):
        # Our conversion on opponent
        cur_o_stun = bool(o_stun[i])
        cur_o_pct  = float(o_pct_conv[i])   # combined Popo+Nana for multi-hit tracking
        if cur_o_stun:
            if not player_conv_active:
                player_conv_active  = True
                player_conv_count  += 1
                conv_hit_count      = 1
                conv_last_opp_pct   = cur_o_pct
                if not opp_conv_active:
                    player_neutral_wins += 1
                conv_start_pct    = cur_o_pct
                conv_start_stocks = int(o_stocks[i])
            elif not prev_o_stun:
                conv_hit_count     += 1      # re-entered stun = new hit
                conv_last_opp_pct   = cur_o_pct
            elif cur_o_pct > conv_last_opp_pct + 0.5:
                conv_hit_count     += 1      # damage while already in stun = multi-hit
                conv_last_opp_pct   = cur_o_pct
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
                    conv_last_opp_pct  = -1.0

        # Stock loss ends our active conversion (kill)
        if i > 0 and int(o_stocks[i]) < int(o_stocks[i - 1]) and player_conv_active:
            if conv_hit_count >= 2:
                opening_conv_count += 1
            player_conv_active = False
            player_reset_ctr   = 0
            conv_start_pct     = -1.0
            conv_start_stocks  = -1
            conv_hit_count     = 0
            conv_last_opp_pct  = -1.0

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

    # ── Kill / death percent tracking ─────────────────────────────────────────
    # Use lastHitBy (post-frame field) for attribution: a stock loss is player's
    # kill only when opp's lastHitBy == player_idx, matching slippi-js exactly.
    o_stock_diff = np.diff(o_stocks.astype(np.int16))
    p_stock_diff = np.diff(p_stocks.astype(np.int16))

    raw_kill_frames  = np.where(o_stock_diff < 0)[0]
    raw_death_frames = np.where(p_stock_diff < 0)[0]

    try:
        o_last_hit_by = np.array(o_post.last_hit_by, copy=False)
        p_last_hit_by = np.array(p_post.last_hit_by, copy=False)
        kill_frames  = [f for f in raw_kill_frames  if int(o_last_hit_by[f]) == player_idx]
        death_frames = [f for f in raw_death_frames if int(p_last_hit_by[f]) == opp_idx]
    except Exception:
        # Fallback if last_hit_by unavailable in this peppi version
        kill_frames  = [f for f in raw_kill_frames  if float(o_pct[f]) > 0]
        death_frames = [f for f in raw_death_frames if float(p_pct[f]) > 0]

    kill_percents  = [float(o_pct[f]) for f in kill_frames]
    death_percents = [float(p_pct[f]) for f in death_frames]
    kills = len(kill_percents)

    # total_damage counts all damage dealt (all stock losses + final stock), regardless of
    # kill attribution. D/O = total damage / total openings.
    total_damage = float(np.sum(o_pct[raw_kill_frames])) if len(raw_kill_frames) > 0 else 0.0
    total_damage += float(o_pct[-1])
    # Ice Climbers: add damage dealt to Nana so damage_per_opening counts hits on her
    # (and a Nana kill shows up as a high-damage opening). No-op for non-IC opponents.
    if of_pct is not None:
        total_damage += _follower_damage(of_pct)

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
                if float(o_pct[fw]) > sp + 3.0:
                    tc_hits += 1; break
        tech_chase_rate = tc_hits / len(down_frames)

    # ── Edgeguard success rate ───────────────────────────────────────────────
    # Opens when the opponent goes offstage (|x| past the ledge, or y < -5).
    # Success = they die there. Dropped = they make it back (grounded OR ledge —
    # a ledge grab counts as recovered). A blast kill (death from one on-stage-
    # origin knockback) is excluded from the stat entirely. 8 s timeout closes
    # without a success. Overlapping dips collapsed to one trip (matches slp_parser.ts).
    edgeguard_success_rate = None
    eg_sit = 0; eg_success = 0
    if o_x is not None and o_y is not None:
        o_offstage    = (np.abs(o_x) > ledge_x) | (o_y < -5.0)
        offstage_frs  = np.where(o_offstage[1:] & ~o_offstage[:-1])[0] + 1
        if len(offstage_frs) > 0:
            next_allowed = 0
            for fo in offstage_frs:
                fo = int(fo)
                if fo < next_allowed:
                    continue
                eg_sit += 1
                ss = int(o_stocks[fo]); resolved = fo + 480
                for fw in range(fo + 1, min(fo + 480, n_frames)):
                    if int(o_stocks[fw]) < ss:                         # died offstage
                        if _blast_kill(o_state, o_offstage, fw):
                            eg_sit -= 1                                 #   blast kill → exclude trip
                        else:
                            eg_success += 1                            #   real edgeguard
                        resolved = fw; break
                    if (not o_offstage[fw]) or _made_it_back(int(o_state[fw])):  # dropped: back over stage / ledge
                        resolved = fw; break
                next_allowed = resolved
    # Ice Climbers opponent: fold Nana's independent offstage trips into the same
    # counters (death-by-absence). No-op when the opponent isn't Ice Climbers.
    if of_states is not None:
        ns, nsucc = _follower_offstage_trips(of_states, of_x, of_y, ledge_x, True)
        eg_sit += ns; eg_success += nsucc
    if eg_sit > 0:
        edgeguard_success_rate = eg_success / eg_sit

    # ── Recovery success rate ────────────────────────────────────────────────
    # Mirror of edgeguard, from your side. Opens when you go offstage. Success =
    # you make it back (grounded OR ledge — a sweetspot ledge grab counts) before
    # losing the stock. Failure = you died there, or 8 s passed without making it
    # back. A blast kill (death from one on-stage-origin knockback) is excluded.
    # Overlapping dips collapsed to one trip (matches slp_parser.ts).
    recovery_success_rate = None
    rec_sit = 0; rec_success = 0
    if p_x is not None and p_y is not None:
        p_offstage    = (np.abs(p_x) > ledge_x) | (p_y < -5.0)
        p_offstage_frs = np.where(p_offstage[1:] & ~p_offstage[:-1])[0] + 1
        if len(p_offstage_frs) > 0:
            next_allowed = 0
            for fo in p_offstage_frs:
                fo = int(fo)
                if fo < next_allowed:
                    continue
                rec_sit += 1
                ss = int(p_stocks[fo]); resolved = fo + 480
                for fw in range(fo + 1, min(fo + 480, n_frames)):
                    if int(p_stocks[fw]) < ss:                         # died offstage
                        if _blast_kill(p_state, p_offstage, fw):
                            rec_sit -= 1                                #   blast kill → exclude trip
                        resolved = fw; break                           #   else: failed recovery (counted)
                    if (not p_offstage[fw]) or _made_it_back(int(p_state[fw])):  # back over stage / on ledge
                        rec_success += 1; resolved = fw; break
                next_allowed = resolved
    # Ice Climbers player: fold Nana's offstage trips (death-by-absence) into the
    # same counters — Nana dying offstage = a failed recovery. No-op for non-IC.
    if pf_states is not None:
        ns, nsucc = _follower_offstage_trips(pf_states, pf_x, pf_y, ledge_x, False)
        rec_sit += ns; rec_success += nsucc
    if rec_sit > 0:
        recovery_success_rate = rec_success / rec_sit

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
    # Always include the last surviving stock. Exclude "never died" games from
    # the benchmark — they'd contribute the full game length as one stock duration,
    # inflating the distribution.
    avg_stock_duration = None
    if len(raw_death_frames) > 0:
        prev = 0; durs = []
        for fd in raw_death_frames:
            durs.append(int(fd) - prev); prev = int(fd) + 1
        durs.append(n_frames - prev)  # last surviving stock
        avg_stock_duration = float(np.mean(durs))

    # ── Respawn defense rate ─────────────────────────────────────────────────
    # After opponent respawns, did the player avoid taking ≥5% for 120f?
    # Trigger: opponent loses a stock. Window starts when opponent exits spawn
    # states and becomes actionable.
    # NOTE: peppi-py reports states 0 (death anim) then 12 (invincible respawn),
    # NOT the slippi-js 10/11 (Rebirth/RebirthWait). Same logic, different IDs.
    SPAWN_STATES_PY = {0, 12}
    respawn_defense_rate = None
    if len(raw_kill_frames) > 0:
        ok = 0; valid = 0
        for fd in raw_kill_frames:
            in_spawn = False; actionable_frame = None
            for fi in range(int(fd), min(int(fd) + 500, n_frames)):
                s = int(o_state[fi])
                if s in SPAWN_STATES_PY:
                    in_spawn = True
                elif in_spawn and s > 12:
                    actionable_frame = fi; break
            if actionable_frame is None:
                continue
            valid += 1
            re = min(actionable_frame + 120, n_frames - 1)
            sp = float(p_pct[actionable_frame])
            safe = all(float(p_pct[fw]) <= sp + 5.0 for fw in range(actionable_frame + 1, re + 1))
            if safe:
                ok += 1
        respawn_defense_rate = ok / valid if valid > 0 else None

    # ── Comeback rate & Lead maintenance rate (binary per game) ──────────────
    player_won   = (int(p_stocks[-1]) > int(o_stocks[-1])) or \
                   (int(p_stocks[-1]) == int(o_stocks[-1]) and float(p_pct[-1]) < float(o_pct[-1]))
    player_ahead  = o_stocks < p_stocks
    player_behind = p_stocks < o_stocks

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


def process_both_ports(filepath: str) -> list[tuple[dict, str, str, int]]:
    """
    Parse a 1v1 replay once and compute stats from both ports' perspectives.
    Returns list of (stats_dict, player_char_name, opp_char_name, player_idx) tuples.
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
            results.append((stats, char_names[player_idx], char_names[opp_idx], player_idx))

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


# ── Ranked dataset (tarball) scan ────────────────────────────────────────────

def parse_rank_pair(filename: str) -> tuple[str, str] | None:
    """Rank pair from a ranked-dataset filename, e.g. 'master-platinum-<hex>.slp'."""
    m = RANK_RE.match(os.path.basename(filename))
    return (m.group(1), m.group(2)) if m else None


def make_records(filename: str, source: str, rank: str | None, rank_pair: str | None,
                 results: list) -> list[tuple]:
    """StatsDB record tuples from process_both_ports results."""
    return [(filename, port, source, player_char, opp_char, rank, rank_pair, stats)
            for stats, player_char, opp_char, port in results]


def scan_tarball_file(tar_path: str, db, work_dir: str, source: str = "ranked",
                      insert_chunk: int = 1000) -> tuple[int, int, int]:
    """
    Stream a local .tar.gz of replays into the StatsDB.
    Members are extracted one at a time and deleted after parsing, so peak
    disk is the tarball plus one replay. Rank is attributed per player only
    for same-rank pairs; mixed pairs keep rank_pair but rank=NULL (no
    port→rank mapping exists in the dataset).
    Returns (new_replays, dup_replays, errors).
    """
    os.makedirs(work_dir, exist_ok=True)
    new = dup = err = 0
    records = []

    def flush():
        if records:
            db.insert_batch(records)
            records.clear()

    with tarfile.open(tar_path, "r:gz") as tf:
        for member in tf:
            if not member.isfile() or not member.name.endswith(".slp"):
                continue
            fname = os.path.basename(member.name)
            if db.seen(fname):
                dup += 1
                continue
            pair = parse_rank_pair(fname)
            rank_pair = f"{pair[0]}-{pair[1]}" if pair else None
            rank = pair[0] if pair and pair[0] == pair[1] else None

            tf.extract(member, path=work_dir, filter="data")
            local = os.path.join(work_dir, member.name)
            try:
                results = process_both_ports(local)
            finally:
                os.remove(local)

            if not results:
                err += 1
                continue
            records.extend(make_records(fname, source, rank, rank_pair, results))
            new += 1
            if len(records) >= insert_chunk:
                flush()
    flush()
    return new, dup, err


def list_ranked_tarballs() -> list[tuple[str, int]]:
    """All (tarball_path, size_bytes) in the ranked dataset, discovered live
    (the repo's README disagrees with its actual layout, so trust the tree)."""
    top = list(list_repo_tree(RANKED_REPO_ID, repo_type=REPO_TYPE))
    char_dirs = sorted(i.path for i in top if hasattr(i, "tree_id"))
    tarballs = []
    for d in char_dirs:
        for it in list_repo_tree(RANKED_REPO_ID, path_in_repo=d, repo_type=REPO_TYPE):
            if not hasattr(it, "tree_id") and it.path.endswith(".tar.gz"):
                tarballs.append((it.path, it.size))
    return tarballs


def run_ranked_scan(args):
    """Full melee-ranked-replays scan: download tarballs one at a time
    (smallest first), stream-parse into the StatsDB, checkpoint per tarball.
    The next tarball is prefetched while the current one parses."""
    from stats_db import StatsDB

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    ckpt_path = os.path.join(scripts_dir, "parse_ranked_checkpoint.json")
    db = StatsDB(args.db, STAT_KEYS)

    print("Listing ranked-dataset tarballs...", flush=True)
    tarballs = sorted(list_ranked_tarballs(), key=lambda t: t[1])
    total_bytes = sum(s for _, s in tarballs)
    print(f"{len(tarballs)} tarballs, {total_bytes/1e12:.2f} TB total", flush=True)
    if args.limit_tarballs:
        tarballs = tarballs[:args.limit_tarballs]
        print(f"--limit-tarballs: processing first {len(tarballs)} (smallest)", flush=True)

    ckpt = {}
    if os.path.exists(ckpt_path):
        with open(ckpt_path) as f:
            ckpt = json.load(f)
    completed = set(ckpt.get("completed_tarballs", []))
    totals = ckpt.get("totals", {"new": 0, "dup": 0, "err": 0})

    remaining = [(p, s) for p, s in tarballs if p not in completed]
    done_bytes = sum(s for p, s in tarballs if p in completed)
    print(f"Resume: {len(completed)} tarballs done, {len(remaining)} remaining "
          f"({(total_bytes - done_bytes)/1e12:.2f} TB to go)", flush=True)

    dl_dir = os.path.join("/tmp", "hf_ranked_dl")
    work_dir = os.path.join("/tmp", "hf_ranked_work")
    # dl_dir is intentionally NOT wiped: hf_hub_download resumes partial
    # downloads (.incomplete files), so restarts after a stall are cheap.

    def download(path):
        for attempt in range(3):
            try:
                return hf_hub_download(repo_id=RANKED_REPO_ID, filename=path,
                                       repo_type=REPO_TYPE, local_dir=dl_dir)
            except Exception as e:
                wait = 30 * (attempt + 1)
                print(f"    download failed ({type(e).__name__}), retry in {wait}s", flush=True)
                time.sleep(wait)
        return None

    t_start = time.time()
    session_bytes = 0

    # Stall watchdog: hf_hub_download has no transfer timeout, so a hung TCP
    # connection blocks the scan forever (observed in practice). The watchdog
    # hard-exits the process when no tarball completes within a generous
    # size-based deadline; run the scan under a supervisor loop that relaunches
    # it (resume is free via the per-tarball checkpoint).
    watchdog_state = {"deadline": time.time() + 1800}

    def _dl_bytes():
        total = 0
        for root, _dirs, files in os.walk(dl_dir):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return total

    def watchdog():
        # Two triggers: (a) downloaded bytes frozen for 10 min (primary — hung
        # TCP connections are common on big tarballs), (b) absolute size-based
        # deadline (backup). Partial downloads survive the restart.
        last_bytes = -1
        last_change = time.time()
        while True:
            time.sleep(60)
            b = _dl_bytes()
            if b != last_bytes:
                last_bytes = b
                last_change = time.time()
            elif time.time() - last_change > 600:
                print(f"\nWATCHDOG: downloaded bytes frozen for 10 min — "
                      f"stalled connection, exiting for supervisor restart", flush=True)
                os._exit(42)
            if time.time() > watchdog_state["deadline"]:
                print(f"\nWATCHDOG: no tarball completed by deadline — "
                      f"assuming stalled download, exiting for supervisor restart", flush=True)
                os._exit(42)
    import threading
    threading.Thread(target=watchdog, daemon=True).start()

    def arm_watchdog(size_bytes):
        # ≥30 min, or the tarball's size at a floor of 0.5 MB/s — whichever is longer
        watchdog_state["deadline"] = time.time() + max(1800, size_bytes / 500_000)

    prefetch_pool = ThreadPoolExecutor(max_workers=1)
    next_future = prefetch_pool.submit(download, remaining[0][0]) if remaining else None
    if remaining:
        arm_watchdog(remaining[0][1])

    try:
        for i, (path, size) in enumerate(remaining):
            local = next_future.result() if next_future else download(path)
            if i + 1 < len(remaining):
                next_future = prefetch_pool.submit(download, remaining[i + 1][0])
                # deadline covers current parse + next download, sized to the larger
                arm_watchdog(max(size, remaining[i + 1][1]))
            else:
                next_future = None
                arm_watchdog(size)
            if local is None:
                print(f"  SKIP {path} (3 download failures)", flush=True)
                totals["err"] += 1
                continue

            t0 = time.time()
            new, dup, err = scan_tarball_file(local, db, work_dir)
            os.remove(local)
            shutil.rmtree(work_dir, ignore_errors=True)

            totals["new"] += new
            totals["dup"] += dup
            totals["err"] += err
            completed.add(path)
            done_bytes += size
            session_bytes += size
            save_checkpoint(ckpt_path, {
                "completed_tarballs": sorted(completed),
                "totals": totals,
                "last_updated": datetime.now(timezone.utc).isoformat(),
            })

            elapsed = time.time() - t_start
            rate = session_bytes / max(elapsed, 1)
            eta_h = (total_bytes - done_bytes) / max(rate, 1) / 3600
            print(f"  [{i+1}/{len(remaining)}] {path}"
                  f"  {size/1e6:.0f}MB  new={new} dup={dup} err={err}"
                  f"  ({time.time()-t0:.0f}s)"
                  f"  | total {done_bytes/1e9:.1f}/{total_bytes/1e9:.0f}GB"
                  f"  {rate/1e6:.1f}MB/s  ETA {eta_h:.1f}h"
                  f"  rows={db.count()}", flush=True)
    finally:
        prefetch_pool.shutdown(wait=False, cancel_futures=True)
        db.close()

    print(f"\nRANKED SCAN COMPLETE: new={totals['new']} dup={totals['dup']} "
          f"err={totals['err']} in {(time.time()-t_start)/3600:.1f}h", flush=True)


# ── Baseline generation from the StatsDB sidecar ────────────────────────────

def build_baselines_from_db(db_path: str, output_path: str):
    """
    grade_baselines.json from the raw-stats sidecar: pooled sections
    (by_player_char / by_opponent_char / by_matchup / _overall) over ALL rows
    regardless of source or rank, plus a by_rank section (ranked rows with a
    per-player rank only) and per-source row counts.
    """
    import sqlite3
    con = sqlite3.connect(db_path)
    stat_cols = ", ".join(f'"{k}"' for k in STAT_KEYS)

    def entry_for(where: str, params: tuple = ()) -> dict:
        """Percentile entry (sample_size + one block per stat) for one group."""
        rows = con.execute(f"SELECT {stat_cols} FROM games {where}", params).fetchall()
        entry = {"sample_size": len(rows)}
        cols = list(zip(*rows)) if rows else [[] for _ in STAT_KEYS]
        for key, col in zip(STAT_KEYS, cols):
            entry[key] = compute_percentiles([v for v in col if v is not None])
        return entry

    def distinct(sql: str, params: tuple = ()) -> list:
        return [r[0] for r in con.execute(sql, params)]

    print(f"Building baselines from {db_path}...", flush=True)
    total = con.execute("SELECT COUNT(*) FROM games").fetchone()[0]
    sources = dict(con.execute("SELECT source, COUNT(*) FROM games GROUP BY source"))

    by_player_char = {c: entry_for("WHERE player_char = ?", (c,))
                      for c in distinct("SELECT DISTINCT player_char FROM games")}
    by_opponent_char = {c: entry_for("WHERE opp_char = ?", (c,))
                        for c in distinct("SELECT DISTINCT opp_char FROM games")}

    by_matchup: dict = {}
    pairs = con.execute(
        "SELECT player_char, opp_char, COUNT(*) FROM games GROUP BY player_char, opp_char"
    ).fetchall()
    for player_char, opp_char, n in pairs:
        if n < MIN_MATCHUP_SAMPLES:
            continue
        by_matchup.setdefault(player_char, {})[opp_char] = entry_for(
            "WHERE player_char = ? AND opp_char = ?", (player_char, opp_char))

    overall_entry = entry_for("")
    by_player_char["_overall"] = overall_entry
    by_opponent_char["_overall"] = overall_entry

    by_rank: dict = {}
    for rank in distinct("SELECT DISTINCT rank FROM games WHERE rank IS NOT NULL"):
        by_rank[rank] = {"_overall": entry_for("WHERE rank = ?", (rank,))}
        for c in distinct("SELECT DISTINCT player_char FROM games WHERE rank = ?", (rank,)):
            by_rank[rank][c] = entry_for("WHERE rank = ? AND player_char = ?", (rank, c))
    con.close()

    output = {
        "generated_at":     datetime.now(timezone.utc).isoformat(),
        "source":           "stats_db:" + "+".join(sorted(sources)),
        "sources":          sources,
        "replay_count":     total,
        "by_player_char":   dict(sorted(by_player_char.items())),
        "by_opponent_char": dict(sorted(by_opponent_char.items())),
        "by_matchup":       {p: dict(sorted(v.items())) for p, v in sorted(by_matchup.items())},
        "by_rank":          by_rank,
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    matchup_count = sum(len(v) for v in by_matchup.values())
    print(f"Baselines written to: {output_path}")
    print(f"Rows: {total}  Sources: {sources}")
    print(f"Player chars: {len(by_player_char) - 1}  Matchups: {matchup_count}  "
          f"Ranks: {sorted(by_rank)}", flush=True)


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
    # Optional StatsDB sidecar — v37 rows keyed by full repo path (v3.7
    # basenames are human-readable timestamps, not collision-safe)
    db=None,
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
        dl_pool = ThreadPoolExecutor(max_workers=dl_workers)
        try:
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
                counters["total_errors"] += stalled
                batch_errors += stalled
        finally:
            # cancel_futures=True + wait=False: don't block on stuck download threads
            # (e.g. threads backed off on 429 retries). Threads finish in background.
            dl_pool.shutdown(wait=False, cancel_futures=True)

        dl_time = time.time() - t_batch
        print(f"    Downloaded {len(local_paths)} files in {dl_time:.1f}s", flush=True)

        # Parse batch
        t_parse = time.time()
        for file_path, local in local_paths:
            results = process_both_ports(local)
            if results:
                if db is not None:
                    db.insert_batch(make_records(file_path, "v37", None, None, results))
                for stats, player_char, opp_char, _port in results:
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
    parser.add_argument("--dataset",    choices=["v37", "ranked", "db"], default="v37",
                        help="v37 = per-file tournament dataset (default); "
                             "ranked = melee-ranked-replays tarballs into the StatsDB sidecar; "
                             "db = no scan, build grade_baselines.json from the sidecar")
    parser.add_argument("--db", default=os.path.join(os.path.dirname(__file__), "raw_stats.sqlite"),
                        help="StatsDB path for --dataset ranked (default: scripts/raw_stats.sqlite)")
    parser.add_argument("--limit-tarballs", type=int, default=0,
                        help="ranked only: stop after N smallest tarballs (testing)")
    args = parser.parse_args()

    if args.dataset == "ranked":
        run_ranked_scan(args)
        return
    if args.dataset == "db":
        build_baselines_from_db(args.db, args.output)
        return

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

    # v37 scans also seed the StatsDB sidecar so future re-pools are queries
    from stats_db import StatsDB
    db = StatsDB(args.db, STAT_KEYS)

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
            db=db,
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

    db.close()

    # Clean up global checkpoint on full completion
    if os.path.exists(global_ckpt_path):
        os.remove(global_ckpt_path)
        print("Global checkpoint removed (all characters completed)")


if __name__ == "__main__":
    main()
