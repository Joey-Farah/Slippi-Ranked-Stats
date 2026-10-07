/**
 * Average a pile of graded entries into per-matchup summaries.
 *
 * Extracted from the Grading tab so the Ranked and Unranked & Direct views share one
 * implementation. It is deliberately generic over "what got graded": ranked passes SETS and
 * unranked passes GAMES. The maths is identical — only the noun the UI prints differs, and the
 * two must never be summed or described interchangeably, since one unranked `match_id` is an
 * entire connection rather than a best-of-three.
 *
 * Pure, so the averaging is unit-testable without a component.
 */

import {
  scoreToGrade, CATEGORY_DEFS,
  type SetGrade, type GradeLetter, type CategoryKey,
} from "./grading";

/** The minimum an entry must carry to be summarised. Loose so both view models satisfy it. */
export interface GradedEntry {
  grade: SetGrade | null;
  playerChar: string;
  opponentChar: string;
  result: string;
}

export interface CategoryAvg {
  avgScore: number | null;
  letter: GradeLetter | null;
}

export interface StatAvg {
  avgValue: number | null;
  avgScore: number | null;
  letter: GradeLetter | null;
  label: string;
}

export interface MatchupSummary {
  key: string;
  playerChar: string;
  opponentChar: string;
  /** Entries in this matchup — sets for ranked, games for unranked. */
  setCount: number;
  wins: number;
  losses: number;
  avgScore: number;
  avgLetter: GradeLetter;
  categories: Record<CategoryKey, CategoryAvg>;
  statAvgs: Map<keyof SetGrade["breakdown"], StatAvg>;
}

const CATEGORY_ORDER: CategoryKey[] = ["neutral", "punish", "defense"];

function avgCategory(entries: GradedEntry[], key: CategoryKey): CategoryAvg {
  const scores = entries
    .map((r) => r.grade!.categories[key].score)
    .filter((s): s is number => s !== null);
  if (scores.length === 0) return { avgScore: null, letter: null };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { avgScore: avg, letter: scoreToGrade(avg) };
}

/**
 * Group graded entries by (your character → their character) and average each group.
 *
 * ⚠ The matchup key is DIRECTIONAL — Falco-vs-Marth is a different matchup from
 * Marth-vs-Falco, and merging them would average two unrelated populations.
 *
 * ⚠ Ungraded entries are dropped, not scored as zero. A game with no frame data has no grade,
 * which is not the same as a bad one.
 */
export function buildMatchupSummaries(entries: readonly GradedEntry[]): MatchupSummary[] {
  const graded = entries.filter((r) => r.grade !== null);
  const groups = new Map<string, GradedEntry[]>();
  for (const r of graded) {
    const k = `${r.playerChar}::${r.opponentChar}`;
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }

  const allStatKeys = CATEGORY_ORDER.flatMap(
    (c) => CATEGORY_DEFS[c].stats
  ) as (keyof SetGrade["breakdown"])[];

  return [...groups.entries()]
    .map(([key, group]) => {
      const [playerChar, opponentChar] = key.split("::");
      // ⚠ Only an explicit "win" counts. Outside ranked a quit-out is neither a win nor a loss
      // (see outcome.ts), so losses cannot be derived by subtraction.
      const wins = group.filter((r) => r.result === "win").length;
      const losses = group.filter((r) => r.result === "loss").length;
      const rawAvg = group.reduce((s, r) => s + r.grade!.score, 0) / group.length;

      const statAvgs = new Map<keyof SetGrade["breakdown"], StatAvg>();
      for (const sk of allStatKeys) {
        const first = group[0]?.grade?.breakdown[sk];
        if (!first) continue;
        const scores = group
          .map((r) => r.grade!.breakdown[sk].score)
          .filter((s): s is number => s !== null);
        const values = group
          .map((r) => r.grade!.breakdown[sk].value)
          .filter((v): v is number => v !== null);
        const avgSc = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const avgVl = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
        statAvgs.set(sk, {
          avgValue: avgVl,
          avgScore: avgSc,
          letter: avgSc !== null ? scoreToGrade(avgSc) : null,
          label: first.label,
        });
      }

      return {
        key,
        playerChar,
        opponentChar,
        setCount: group.length,
        wins,
        losses,
        avgScore: Math.round(rawAvg * 10) / 10,
        avgLetter: scoreToGrade(rawAvg),
        categories: {
          neutral: avgCategory(group, "neutral"),
          punish: avgCategory(group, "punish"),
          defense: avgCategory(group, "defense"),
        } as Record<CategoryKey, CategoryAvg>,
        statAvgs,
      };
    })
    .sort((a, b) => b.setCount - a.setCount);
}
