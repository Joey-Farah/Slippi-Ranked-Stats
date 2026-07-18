#!/usr/bin/env python3
"""TEMP A/B: prove the Nana fix moves IC stats in the expected direction.

Computes each perspective with follower handling ON (real _follower_lists) vs
OFF (monkeypatched to all-None = old Popo-only behavior) and diffs them.
"""
import sys
import peppi_py as peppi
import parse_hf_replays as P

GAMES = [
    r"C:\Slippi Replays\Recent\Game_20260316T185946.slp",
    r"C:\Slippi Replays\Recent\Game_20260222T203612.slp",
    r"C:\Slippi Replays\Recent\Game_20260222T203850.slp",
]
KEYS = ["openings_per_kill", "damage_per_opening", "neutral_win_ratio",
        "opening_conversion_rate", "edgeguard_success_rate", "recovery_success_rate"]

_orig = P._follower_lists


def _all_none(post):
    n = len(post.state.to_pylist())
    return [None] * n, [None] * n, [None] * n, [None] * n


def fmt(v):
    return f"{v:.3f}" if isinstance(v, float) else str(v)


def compare(label, game, pidx, oidx):
    P._follower_lists = _orig
    on = P.compute_game_stats(game, pidx, oidx)
    P._follower_lists = _all_none
    off = P.compute_game_stats(game, pidx, oidx)
    P._follower_lists = _orig
    print(f"\n  {label}")
    print(f"    {'stat':<26}{'OFF (Popo-only)':>18}{'ON (Nana fix)':>18}")
    for k in KEYS:
        o, n = off.get(k), on.get(k)
        flag = "" if o == n else "   <-- changed"
        print(f"    {k:<26}{fmt(o):>18}{fmt(n):>18}{flag}")


def main():
    for path in GAMES:
        game = peppi.read_slippi(path)
        players = [pl for pl in game.start.players if pl is not None]
        chars = [int(pl.character) for pl in players]
        if 14 not in chars:
            continue
        ic = chars.index(14)
        other = 1 - ic
        print(f"\n=== {path.split(chr(92))[-1]}  chars(ext)={chars} ===")
        compare(f"NON-IC player (idx {other}) FACING Ice Climbers", game, other, ic)
        compare(f"ICE CLIMBERS player (idx {ic})", game, ic, other)


if __name__ == "__main__":
    main()
