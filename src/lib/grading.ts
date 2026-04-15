/**
 * grading.ts — Set Grading System logic.
 *
 * !! DEV ONLY — not shipped to users yet !!
 *
 * Takes a completed set's LiveGameStats, averages each stat across all games,
 * compares against character-specific (or overall) percentile benchmarks,
 * and returns a letter grade S → F with a per-stat breakdown.
 */

import type { LiveGameStats } from "./store";
import { BENCHMARKS, type StatThresholds } from "./grade-benchmarks";

// ── Types ──────────────────────────────────────────────────────────────────

export type GradeLetter = "S" | "A" | "B" | "C" | "D" | "F";

export interface StatGrade {
  value:  number | null;
  score:  number | null;   // 0–100 performance score
  grade:  GradeLetter | null;
  label:  string;          // human-readable stat name
  formatted: string;       // display-ready value string
}

export interface SetGrade {
  letter:         GradeLetter;
  score:          number;           // 0–100 weighted composite
  breakdown: {
    neutral_win_ratio:  StatGrade;
    openings_per_kill:  StatGrade;
    damage_per_opening: StatGrade;
    l_cancel_ratio:     StatGrade;
  };
  opponentChar:   string;
  baselineSource: "character" | "overall"; // which benchmarks were used
  setResult:      "win" | "loss";
  wins:           number;
  losses:         number;
}

// ── Stat configuration ─────────────────────────────────────────────────────

/** Stats where LOWER raw value = BETTER performance. Use low-end percentiles for grading. */
const INVERTED_STATS = new Set(["openings_per_kill"]);

/** Contribution to the overall weighted score. Must sum to 1.0 across non-null stats. */
const WEIGHTS: Record<string, number> = {
  neutral_win_ratio:  0.40,
  openings_per_kill:  0.30,
  damage_per_opening: 0.20,
  l_cancel_ratio:     0.10,
};

const STAT_LABELS: Record<string, string> = {
  neutral_win_ratio:  "Neutral Win Rate",
  openings_per_kill:  "Openings / Kill",
  damage_per_opening: "Damage / Opening",
  l_cancel_ratio:     "L-Cancel %",
};

// ── Percentile scoring ─────────────────────────────────────────────────────

/**
 * Map a raw stat value to a 0–100 performance score.
 *
 * For normal stats (higher = better): uses p25/p50/p75/p90/p95 as grade boundaries.
 * For inverted stats (lower = better): uses p5/p10/p25/p50/p75 as grade boundaries.
 */
function percentileScore(value: number, t: StatThresholds, inverted: boolean): number {
  let score: number;

  if (!inverted) {
    if      (value >= t.p95) score = 95 + Math.min((value - t.p95) / Math.max(t.p95 - t.p90, 0.001) * 5, 5);
    else if (value >= t.p90) score = 90 + (value - t.p90) / Math.max(t.p95 - t.p90, 0.001) * 5;
    else if (value >= t.p75) score = 75 + (value - t.p75) / Math.max(t.p90 - t.p75, 0.001) * 15;
    else if (value >= t.p50) score = 50 + (value - t.p50) / Math.max(t.p75 - t.p50, 0.001) * 25;
    else if (value >= t.p25) score = 25 + (value - t.p25) / Math.max(t.p50 - t.p25, 0.001) * 25;
    else                     score = Math.max(0, (value / Math.max(t.p25, 0.001)) * 25);
  } else {
    // Lower value = better: p5 = elite threshold, p75 = poor
    if      (value <= t.p5)  score = 95 + Math.min((t.p5 - value) / Math.max(t.p5, 0.001) * 5, 5);
    else if (value <= t.p10) score = 90 + (t.p10 - value) / Math.max(t.p10 - t.p5,  0.001) * 5;
    else if (value <= t.p25) score = 75 + (t.p25 - value) / Math.max(t.p25 - t.p10, 0.001) * 15;
    else if (value <= t.p50) score = 50 + (t.p50 - value) / Math.max(t.p50 - t.p25, 0.001) * 25;
    else if (value <= t.p75) score = 25 + (t.p75 - value) / Math.max(t.p75 - t.p50, 0.001) * 25;
    else                     score = Math.max(0, 25 * (1 - (value - t.p75) / Math.max(t.p75, 0.001)));
  }

  return Math.min(100, Math.max(0, score));
}

function scoreToGrade(score: number): GradeLetter {
  if (score >= 95) return "S";
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 50) return "C";
  if (score >= 25) return "D";
  return "F";
}

function formatStatValue(key: string, value: number | null): string {
  if (value === null) return "—";
  if (key === "neutral_win_ratio" || key === "l_cancel_ratio") return (value * 100).toFixed(0) + "%";
  if (key === "damage_per_opening") return value.toFixed(1);
  if (key === "openings_per_kill")  return value.toFixed(2);
  return value.toFixed(2);
}

// ── Average stats across set games ────────────────────────────────────────

function averageSetStats(games: LiveGameStats[]): Record<string, number | null> {
  const accum: Record<string, number[]> = {};
  for (const key of Object.keys(WEIGHTS)) accum[key] = [];

  for (const g of games) {
    for (const key of Object.keys(WEIGHTS)) {
      const val = (g as Record<string, unknown>)[key] as number | null;
      if (val !== null && val !== undefined && isFinite(val)) accum[key].push(val);
    }
  }

  const result: Record<string, number | null> = {};
  for (const key of Object.keys(WEIGHTS)) {
    const vals = accum[key];
    result[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return result;
}

// ── Main grading function ──────────────────────────────────────────────────

/**
 * Grade a completed set.
 *
 * @param games       All LiveGameStats entries for this set's match_id
 * @param opponentChar  Opponent character name (e.g. "Falco"), used for character-specific benchmarks
 * @param setResult   Whether the player won or lost the set
 * @param wins        Number of games won
 * @param losses      Number of games lost
 */
export function gradeSet(
  games: LiveGameStats[],
  opponentChar: string,
  setResult: "win" | "loss",
  wins: number,
  losses: number
): SetGrade {
  const charBenchmarks = BENCHMARKS[opponentChar] ?? BENCHMARKS["_overall"];
  const baselineSource: "character" | "overall" = BENCHMARKS[opponentChar] ? "character" : "overall";

  const averaged = averageSetStats(games);

  let weightedScore = 0;
  let totalWeight   = 0;
  const breakdown: SetGrade["breakdown"] = {} as SetGrade["breakdown"];

  for (const key of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) {
    const value     = averaged[key] ?? null;
    const weight    = WEIGHTS[key];
    const thresholds = (charBenchmarks as Record<string, StatThresholds>)[key];
    const inverted  = INVERTED_STATS.has(key);

    let score: number | null = null;
    let grade: GradeLetter | null = null;

    if (value !== null && thresholds) {
      score = percentileScore(value, thresholds, inverted);
      grade = scoreToGrade(score);
      weightedScore += score * weight;
      totalWeight   += weight;
    }

    (breakdown as Record<string, StatGrade>)[key] = {
      value,
      score,
      grade,
      label:     STAT_LABELS[key] ?? key,
      formatted: formatStatValue(key, value),
    };
  }

  const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

  return {
    letter:         scoreToGrade(overallScore),
    score:          Math.round(overallScore * 10) / 10,
    breakdown,
    opponentChar,
    baselineSource,
    setResult,
    wins,
    losses,
  };
}
