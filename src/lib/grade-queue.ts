/**
 * Which games a grading pass should even attempt, decided from stored metadata alone.
 *
 * Grading a game means re-parsing its replay, and the `games` table stores metadata only (13
 * columns, no stats) — so the cheap row-level gates belong in front of that work rather than
 * inside it. Nothing here opens a file: it decides which files are worth opening, which is
 * also what lets a count be shown instantly on a tab that has nothing graded yet.
 *
 * ⚠ These are the METADATA gates only, so this counts *candidates*, not gradeable games. One
 * disqualifier is only knowable after the parse: `avg_stock_duration === null` means the
 * replay held no frames at all (the opponent left before the game started), which no stored
 * column reveals. Any UI built on these numbers has to say "candidates", not "will be graded".
 */

import { isLegalStage } from "./parser";

/** A quit-out shorter than this is a stub, not a game: 45 s at 60 fps.
 *
 *  ⚠ `LiveRankedSession.svelte` holds an identical local copy (it predates this module and is
 *  being edited elsewhere right now) — fold it into this import next time that file is touched,
 *  so the threshold can only be changed in one place. */
export const QUIT_OUT_MIN_FRAMES = 45 * 60;

const QUIT_OUT_RESULTS = new Set(["lras_win", "lras_loss"]);

/** The columns of a `games` row this decision needs. Loose/optional so both a `GameRow` and a
 *  `LiveGameStats` entry satisfy it without a cast. */
export interface GradeCandidateRow {
  result?: string | null;
  stage_id?: number | null;
  duration_frames?: number | null;
}

/** Why a row isn't worth parsing, or null when it is. */
export type GradeSkipReason = "non_legal_stage" | "short_quit_out";

export function gradeSkipReason(g: GradeCandidateRow): GradeSkipReason | null {
  // The benchmarks are built entirely from legal-stage ranked play, so a Hyrule Temple game
  // graded against them scores the stage rather than the player. Direct connect is the only
  // mode that produces these at all (see LEGAL_STAGES).
  if (!isLegalStage(g.stage_id ?? -1)) return "non_legal_stage";

  // A quit-out only disqualifies a game if it ended EARLY — most of them are a full game that
  // someone ended to get back to character select, not a rage quit (measured: 2.70/2.72 min
  // against a 2.47-min median). What isn't worth grading is a stub, where a single opening
  // becomes the whole damage-per-opening average.
  if (QUIT_OUT_RESULTS.has(g.result ?? "") && (g.duration_frames ?? 0) < QUIT_OUT_MIN_FRAMES) {
    return "short_quit_out";
  }

  return null;
}

export function isGradeCandidate(g: GradeCandidateRow): boolean {
  return gradeSkipReason(g) === null;
}

export interface GradeQueueCounts {
  total: number;
  candidates: number;
  nonLegalStage: number;
  shortQuitOut: number;
}

/** Split a pile of game rows into what a grading pass would attempt and what it would skip.
 *
 *  ⚠ Fed from the `unrankedGames` / `directGames` stores, `nonLegalStage` is always 0 — those
 *  derive from `filteredGames`, which already drops non-legal stages for every statistic in the
 *  app. It is non-zero only when rows come straight from the database, which is what a batch
 *  job would do. Don't read a 0 there as "there are none". */
export function countGradeCandidates(games: readonly GradeCandidateRow[]): GradeQueueCounts {
  let candidates = 0, nonLegalStage = 0, shortQuitOut = 0;
  for (const g of games) {
    const skip = gradeSkipReason(g);
    if (skip === null) candidates++;
    else if (skip === "non_legal_stage") nonLegalStage++;
    else shortQuitOut++;
  }
  return { total: games.length, candidates, nonLegalStage, shortQuitOut };
}
