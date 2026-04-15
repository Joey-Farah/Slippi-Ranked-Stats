/**
 * grading.ts — Set Grading System logic.
 *
 * !! DEV ONLY — not shipped to users yet !!
 *
 * Grades a completed set across four equally-weighted categories:
 *   Neutral   (neutral_win_ratio, openings_per_kill)
 *   Punish    (damage_per_opening, avg_kill_percent)
 *   Defense   (avg_death_percent)
 *   Execution (l_cancel_ratio, inputs_per_minute)
 *
 * Each stat is scored 0–100 via percentile interpolation against
 * character-specific benchmarks (by_player_char). Category score =
 * equal-weight average of its non-null stats. Overall score = equal-weight
 * average of the four category scores.
 */

import type { LiveGameStats } from "./store";
import { BENCHMARKS, type StatThresholds } from "./grade-benchmarks";

// ── Types ──────────────────────────────────────────────────────────────────

export type GradeLetter = "S" | "A" | "B" | "C" | "D" | "F";
export type CategoryKey  = "neutral" | "punish" | "defense" | "execution";

export interface StatGrade {
  value:     number | null;
  score:     number | null;   // 0–100 performance score
  grade:     GradeLetter | null;
  label:     string;
  formatted: string;
}

export interface CategoryGrade {
  label:  string;
  letter: GradeLetter | null;
  score:  number | null;
}

export interface SetGrade {
  letter:     GradeLetter;
  score:      number;           // 0–100 weighted composite
  categories: Record<CategoryKey, CategoryGrade>;
  breakdown: {
    neutral_win_ratio:  StatGrade;
    openings_per_kill:  StatGrade;
    damage_per_opening: StatGrade;
    avg_kill_percent:   StatGrade;
    avg_death_percent:  StatGrade;
    l_cancel_ratio:     StatGrade;
    inputs_per_minute:  StatGrade;
  };
  playerChar:     string;
  opponentChar:   string;
  baselineSource: "character" | "overall";
  setResult:      "win" | "loss";
  wins:           number;
  losses:         number;
}

// ── Stat configuration ─────────────────────────────────────────────────────

/** Stats where LOWER raw value = BETTER performance. */
const INVERTED_STATS = new Set(["openings_per_kill", "avg_kill_percent"]);

/** Category definitions — stats listed in display order within each category. */
const CATEGORY_DEFS: Record<CategoryKey, { label: string; stats: (keyof SetGrade["breakdown"])[] }> = {
  neutral:   { label: "Neutral",   stats: ["neutral_win_ratio",  "openings_per_kill"]  },
  punish:    { label: "Punish",    stats: ["damage_per_opening", "avg_kill_percent"]   },
  defense:   { label: "Defense",   stats: ["avg_death_percent"]                        },
  execution: { label: "Execution", stats: ["l_cancel_ratio",     "inputs_per_minute"]  },
};

const STAT_LABELS: Record<string, string> = {
  neutral_win_ratio:  "Neutral Win Rate",
  openings_per_kill:  "Openings / Kill",
  damage_per_opening: "Damage / Opening",
  avg_kill_percent:   "Avg Kill %",
  avg_death_percent:  "Avg Death %",
  l_cancel_ratio:     "L-Cancel %",
  inputs_per_minute:  "Inputs / Min",
};

// ── Percentile scoring ─────────────────────────────────────────────────────

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
    if      (value <= t.p5)  score = 95 + Math.min((t.p5  - value) / Math.max(t.p5,        0.001) * 5, 5);
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
  if (key === "avg_kill_percent" || key === "avg_death_percent") return value.toFixed(0) + "%";
  if (key === "inputs_per_minute")  return Math.round(value).toString();
  return value.toFixed(2);
}

// ── Average stats across set games ────────────────────────────────────────

function averageSetStats(games: LiveGameStats[]): Record<string, number | null> {
  const allKeys = Object.keys(STAT_LABELS);
  const accum: Record<string, number[]> = {};
  for (const key of allKeys) accum[key] = [];

  for (const g of games) {
    for (const key of allKeys) {
      const val = (g as unknown as Record<string, unknown>)[key] as number | null;
      if (val !== null && val !== undefined && isFinite(val)) accum[key].push(val);
    }
  }

  const result: Record<string, number | null> = {};
  for (const key of allKeys) {
    const vals = accum[key];
    result[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return result;
}

// ── Main grading function ──────────────────────────────────────────────────

/**
 * Grade a completed set.
 *
 * @param games        All LiveGameStats entries for this set's match_id
 * @param playerChar   Player's character name (used for character-specific benchmarks)
 * @param opponentChar Opponent's character name (stored for display)
 * @param setResult    Whether the player won or lost the set
 * @param wins         Number of games won
 * @param losses       Number of games lost
 */
export function gradeSet(
  games: LiveGameStats[],
  playerChar: string,
  opponentChar: string,
  setResult: "win" | "loss",
  wins: number,
  losses: number,
): SetGrade {
  // Look up benchmarks by player character; fall back to _overall
  const benchmarks    = BENCHMARKS[playerChar] ?? BENCHMARKS["_overall"];
  const baselineSource: "character" | "overall" = BENCHMARKS[playerChar] ? "character" : "overall";

  const averaged = averageSetStats(games);

  // ── Score each stat ──────────────────────────────────────────────────────
  const breakdown = {} as SetGrade["breakdown"];

  for (const key of Object.keys(STAT_LABELS) as (keyof SetGrade["breakdown"])[]) {
    const value      = averaged[key] ?? null;
    const thresholds = (benchmarks as unknown as Record<string, StatThresholds>)[key];
    const inverted   = INVERTED_STATS.has(key);

    let score: number | null = null;
    let grade: GradeLetter | null = null;

    if (value !== null && thresholds) {
      score = percentileScore(value, thresholds, inverted);
      grade = scoreToGrade(score);
    }

    breakdown[key] = {
      value,
      score,
      grade,
      label:     STAT_LABELS[key] ?? key,
      formatted: formatStatValue(key, value),
    };
  }

  // ── Score each category (equal weight among non-null stats) ──────────────
  const categories = {} as SetGrade["categories"];

  for (const [catKey, def] of Object.entries(CATEGORY_DEFS) as [CategoryKey, typeof CATEGORY_DEFS[CategoryKey]][]) {
    const scores = def.stats
      .map((s) => breakdown[s].score)
      .filter((s): s is number => s !== null);

    if (scores.length === 0) {
      categories[catKey] = { label: def.label, letter: null, score: null };
    } else {
      const catScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      categories[catKey] = { label: def.label, letter: scoreToGrade(catScore), score: Math.round(catScore * 10) / 10 };
    }
  }

  // ── Overall score (equal weight across non-null categories) ──────────────
  const catScores = Object.values(categories)
    .map((c) => c.score)
    .filter((s): s is number => s !== null);

  const overallScore = catScores.length > 0
    ? catScores.reduce((a, b) => a + b, 0) / catScores.length
    : 0;

  return {
    letter:     scoreToGrade(overallScore),
    score:      Math.round(overallScore * 10) / 10,
    categories,
    breakdown,
    playerChar,
    opponentChar,
    baselineSource,
    setResult,
    wins,
    losses,
  };
}
