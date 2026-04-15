/**
 * grade-benchmarks.ts — Placeholder stat percentile thresholds for the Set Grading System.
 *
 * !! DEV ONLY — not shipped to users yet !!
 *
 * These placeholder values are rough estimates and will be replaced by the output of
 * scripts/baseline_generator.py once it is run against the full local replay DB.
 * Character-specific benchmarks will also be added at that point.
 *
 * Schema matches grade_baselines.json produced by the Python pipeline:
 *   p5/p10/p25 = low-end percentiles (used for inverted stats like openings_per_kill)
 *   p50        = median
 *   p75/p90/p95 = high-end percentiles (used for normal stats)
 */

export interface StatThresholds {
  p5:  number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface CharacterBenchmarks {
  neutral_win_ratio:  StatThresholds;
  openings_per_kill:  StatThresholds;
  damage_per_opening: StatThresholds;
  l_cancel_ratio:     StatThresholds;
}

/**
 * Stat thresholds keyed by opponent character name (matching CHARACTERS in parser.ts).
 * "_overall" is the character-agnostic fallback used when no character-specific entry exists.
 *
 * Replace this entire object with the "by_character" field from grade_baselines.json
 * after running scripts/baseline_generator.py.
 */
export const BENCHMARKS: Record<string, CharacterBenchmarks> = {
  _overall: {
    neutral_win_ratio:  { p5: 0.33, p10: 0.38, p25: 0.44, p50: 0.50, p75: 0.57, p90: 0.63, p95: 0.67 },
    openings_per_kill:  { p5: 2.0,  p10: 2.3,  p25: 2.8,  p50: 3.3,  p75: 4.1,  p90: 5.2,  p95: 6.0  },
    damage_per_opening: { p5: 8.0,  p10: 10.2, p25: 13.5, p50: 19.2, p75: 24.1, p90: 29.4, p95: 34.0 },
    l_cancel_ratio:     { p5: 0.40, p10: 0.55, p25: 0.68, p50: 0.78, p75: 0.87, p90: 0.93, p95: 0.97 },
  },
};
