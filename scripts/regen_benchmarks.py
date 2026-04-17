#!/usr/bin/env python3
"""
regen_benchmarks.py — Regenerate src/lib/grade-benchmarks.ts from the
current scripts/grade_baselines.json.

Reads by_player_char and by_matchup sections, emits one BENCHMARKS entry
per character with sample_size >= MIN_SAMPLES, plus an _overall fallback.
Skips "Unknown_*" buckets (parser couldn't map the char ID).

Now supports all 9 stats including counter_hit_rate, defensive_option_rate,
and inputs_per_minute from the HuggingFace peppi-py parse pipeline.

Usage:
    python3 scripts/regen_benchmarks.py
"""

import json
import os
import sys

REPO_ROOT     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT_PATH    = os.path.join(REPO_ROOT, "scripts", "grade_baselines.json")
OUTPUT_PATH   = os.path.join(REPO_ROOT, "src", "lib", "grade-benchmarks.ts")
MIN_SAMPLES   = 50

STAT_KEYS = [
    "neutral_win_ratio",
    "openings_per_kill",
    "damage_per_opening",
    "avg_kill_percent",
    "avg_death_percent",
    "l_cancel_ratio",
    "inputs_per_minute",
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


def fmt_thresholds(t: dict) -> str:
    """{ p5: X, p10: X, p25: X, p50: X, p75: X, p90: X, p95: X }"""
    parts = [f"p{n}: {round(t[f'p{n}'], 4)}" for n in (5, 10, 25, 50, 75, 90, 95)]
    return "{ " + ", ".join(parts) + " }"


def emit_char_entry(name: str, data: dict, *, indent: int = 2) -> str:
    pad  = " " * indent
    pad2 = " " * (indent + 2)
    key  = json.dumps(name)  # safe quoting for any char name
    lines = [f"{pad}{key}: {{"]
    for stat in STAT_KEYS:
        thr = data.get(stat)
        if thr is None or thr.get("p50") is None:
            continue
        line = f"{pad2}{stat + ':':22s}{fmt_thresholds(thr)},"
        lines.append(line)
    lines.append(f"{pad}}},")
    return "\n".join(lines)


HEADER = '''/**
 * grade-benchmarks.ts — Stat percentile thresholds for the Set Grading System.
 *
 * !! DEV ONLY — not shipped to users yet !!
 *
 * Generated from scripts/grade_baselines.json via scripts/regen_benchmarks.py.
 * Source: {source} ({replay_count} replays).
 * Characters with fewer than {min_samples} samples fall back to by_player_char["_overall"].
 */

export interface StatThresholds {{
  p5:  number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}}

export interface CharacterBenchmarks {{
  neutral_win_ratio?:       StatThresholds;
  openings_per_kill?:       StatThresholds;  // inverted: lower = better
  damage_per_opening?:      StatThresholds;
  avg_kill_percent?:        StatThresholds;  // inverted: lower = better (killing early)
  avg_death_percent?:       StatThresholds;
  l_cancel_ratio?:          StatThresholds;
  inputs_per_minute?:       StatThresholds;
  opening_conversion_rate?: StatThresholds;
  stage_control_ratio?:     StatThresholds;
  lead_maintenance_rate?:   StatThresholds;
  tech_chase_rate?:         StatThresholds;
  edgeguard_success_rate?:  StatThresholds;
  hit_advantage_rate?:      StatThresholds;
  recovery_success_rate?:   StatThresholds;
  avg_stock_duration?:      StatThresholds;
  respawn_defense_rate?:    StatThresholds;
  comeback_rate?:           StatThresholds;
  wavedash_miss_rate?:      StatThresholds;  // inverted: lower = better
}}

export interface Benchmarks {{
  by_player_char: Record<string, CharacterBenchmarks>;
  by_matchup: Record<string, Record<string, CharacterBenchmarks>>;
}}

export const BENCHMARKS: Benchmarks = {{
  by_player_char: {{
'''


def main():
    if not os.path.exists(INPUT_PATH):
        print(f"ERROR: {INPUT_PATH} not found.", file=sys.stderr)
        sys.exit(1)

    with open(INPUT_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    by_player = data.get("by_player_char", {})
    by_matchup = data.get("by_matchup", {})

    if "_overall" not in by_player:
        print("ERROR: _overall bucket missing from grade_baselines.json", file=sys.stderr)
        sys.exit(1)

    overall_n = by_player["_overall"].get("sample_size", 0)
    source = data.get("source", "?")
    replay_count = data.get("replay_count", 0)
    generated_at = data.get("generated_at", "unknown")
    print(f"Source: {source} · {replay_count} replays")
    print(f"Overall sample_size: {overall_n}")

    eligible = []
    excluded = []
    for name in sorted(k for k in by_player if k != "_overall"):
        n = by_player[name].get("sample_size", 0)
        if name.startswith("Unknown_"):
            excluded.append((name, n, "unmapped char id"))
            continue
        if n < MIN_SAMPLES:
            excluded.append((name, n, f"< {MIN_SAMPLES}"))
            continue
        eligible.append((name, n))

    # ── Emit by_player_char section ──────────────────────────────────────────
    parts = [HEADER.format(min_samples=MIN_SAMPLES, source=source, replay_count=replay_count)]
    parts.append(emit_char_entry("_overall", by_player["_overall"], indent=4))
    parts.append("")
    for name, _ in eligible:
        parts.append(emit_char_entry(name, by_player[name], indent=4))
    parts.append("  },")

    # ── Emit by_matchup section ──────────────────────────────────────────────
    parts.append("  by_matchup: {")
    matchup_count = 0
    for player_char in sorted(by_matchup.keys()):
        if player_char.startswith("Unknown_"):
            continue
        opp_entries = by_matchup[player_char]
        valid_opps = {k: v for k, v in opp_entries.items()
                      if not k.startswith("Unknown_")
                      and v.get("sample_size", 0) >= MIN_SAMPLES}
        if not valid_opps:
            continue
        parts.append(f"    {json.dumps(player_char)}: {{")
        for opp_char in sorted(valid_opps.keys()):
            parts.append(emit_char_entry(opp_char, valid_opps[opp_char], indent=6))
            matchup_count += 1
        parts.append("    },")
    parts.append("  },")

    parts.append("};")
    parts.append("")
    parts.append(f'export const BENCHMARKS_VERSION = "{generated_at}";')
    parts.append("")
    output = "\n".join(parts)

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(output)

    print()
    print(f"Wrote {OUTPUT_PATH}")
    print(f"Included {len(eligible)} chars (>= {MIN_SAMPLES} samples) + _overall:")
    for name, n in eligible:
        print(f"  {name:20s}  n={n}")
    print(f"Included {matchup_count} matchup entries (>= {MIN_SAMPLES} samples)")
    if excluded:
        print(f"\nExcluded {len(excluded)} chars:")
        for name, n, reason in excluded:
            print(f"  {name:20s}  n={n}  ({reason})")


if __name__ == "__main__":
    main()
