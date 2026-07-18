#!/usr/bin/env python3
"""TEMP inspection: how does Nana (follower) frame data behave?

Scans replay dirs for the first Ice Climbers (external char 14) game, then
dumps follower semantics: frame coverage, stocks field, percent resets, and
the states Nana emits around her death (does she stop, or emit dying states?).
"""
import sys
import numpy as np
import peppi_py as peppi
from pathlib import Path

IC = 14
DIRS = [r"C:\Slippi Replays\Recent", r"D:\Slippi Replay Archive"]


def find_ic_game(limit=4000):
    n = 0
    for d in DIRS:
        p = Path(d)
        if not p.is_dir():
            continue
        for f in sorted(p.glob("*.slp")):
            n += 1
            if n > limit:
                return
            try:
                game = peppi.read_slippi(str(f))
            except BaseException:
                continue
            if game.start is None or game.start.players is None:
                continue
            players = [pl for pl in game.start.players if pl is not None]
            if len(players) != 2:
                continue
            chars = [int(pl.character) for pl in players]
            if IC in chars:
                yield f, game, chars


def inspect(f, game, chars):
    ic_idx = chars.index(IC)
    print(f"\n=== IC GAME: {f.name} ===")
    print(f"chars (external ids): {chars}  -> IC is player index {ic_idx}")
    try:
        md = game.metadata
        print(f"FULLPATH: {f}")
        print(f"metadata players: {md.get('players') if isinstance(md, dict) else md}")
    except Exception as e:
        print(f"(metadata unavailable: {e})")

    port = game.frames.ports[ic_idx]
    print(f"port.leader is None?   {port.leader is None}")
    print(f"port.follower is None? {port.follower is None}")
    if port.follower is None:
        print("!! No follower data — peppi did not expose Nana for this game")
        return

    lead = port.leader.post
    foll = port.follower.post

    # Follower arrays are null-padded to leader length; nulls = Nana absent/dead.
    # to_pylist() yields None for nulls (zero-copy numpy can't represent them).
    l_state = lead.state.to_pylist()
    f_state = foll.state.to_pylist()
    f_stocks = foll.stocks.to_pylist()
    f_pct = foll.percent.to_pylist()
    l_stocks = lead.stocks.to_pylist()

    n = len(l_state)
    f_null = [s is None for s in f_state]
    n_null = sum(f_null)
    print(f"\nleader frames:   {n}")
    print(f"follower frames: {len(f_state)} (len match? {len(f_state)==n}); NULLs={n_null} "
          f"({100*n_null/n:.0f}% of game Nana is absent)")

    # Are nulls contiguous at the end (Nana died once, gone forever) or interleaved
    # (she respawns with Popo)? Cluster the present->null transitions.
    present_to_null = [i for i in range(1, n) if not f_null[i-1] and f_null[i]]
    null_to_present = [i for i in range(1, n) if f_null[i-1] and not f_null[i]]
    print(f"present->NULL transitions (Nana deaths): {len(present_to_null)} at {present_to_null[:10]}")
    print(f"NULL->present transitions (Nana respawns): {len(null_to_present)} at {null_to_present[:10]}")

    # What are Nana's last states/stocks/pct right BEFORE she goes null (death)?
    for d in present_to_null[:4]:
        lo = max(0, d-3)
        print(f"  death@{d}: leadstate={[l_state[i] for i in range(lo,d)]} "
              f"follstate={[f_state[i] for i in range(lo,d)]} "
              f"follstk={[f_stocks[i] for i in range(lo,d)]} "
              f"follpct={[round(f_pct[i],1) if f_pct[i] is not None else None for i in range(lo,d)]} "
              f"| leadstk_at_death={l_stocks[d]}")

    # Follower stocks semantics (only on present frames)
    present_stk = sorted(set(s for s in f_stocks if s is not None))
    present_lead_stk = sorted(set(s for s in l_stocks if s is not None))
    print(f"\nfollower stocks values (present frames): {present_stk}")
    print(f"leader   stocks values:                  {present_lead_stk}")

    # Does follower stocks ever differ from leader on present frames?
    diverge = [i for i in range(n) if not f_null[i] and f_stocks[i] != l_stocks[i]]
    print(f"present frames where follower stocks != leader stocks: {len(diverge)}"
          + (f" (first @ {diverge[0]}: foll={f_stocks[diverge[0]]} lead={l_stocks[diverge[0]]})" if diverge else ""))

    # Dying states among present frames (does she emit 0-10 before going null?)
    dying = [i for i in range(n) if not f_null[i] and 0 <= f_state[i] <= 10]
    print(f"\nfollower present-frames in dying states (0-10): {len(dying)} (first few idx {dying[:8]})")


def main():
    count = 0
    for f, game, chars in find_ic_game():
        inspect(f, game, chars)
        count += 1
        if count >= 3:
            break
    if count == 0:
        print("No Ice Climbers games found in scanned replays.")


if __name__ == "__main__":
    main()
