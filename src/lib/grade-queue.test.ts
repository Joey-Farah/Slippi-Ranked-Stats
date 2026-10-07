import { describe, it, expect } from "vitest";
import {
  QUIT_OUT_MIN_FRAMES,
  countGradeCandidates,
  gradeSkipReason,
  isGradeCandidate,
} from "./grade-queue";

// Yoshi's Story — legal, so it never contributes a skip of its own.
const LEGAL = 8;
// Hyrule Temple — reachable only through direct connect, which is exactly the mode this
// counting is for.
const ILLEGAL = 18;

function row(over: Partial<Parameters<typeof gradeSkipReason>[0]> = {}) {
  return { result: "win", stage_id: LEGAL, duration_frames: 9000, ...over };
}

describe("gradeSkipReason", () => {
  it("accepts an ordinary finished game on a legal stage", () => {
    expect(gradeSkipReason(row())).toBeNull();
    expect(isGradeCandidate(row())).toBe(true);
  });

  it("skips a non-legal stage — the benchmarks are all legal-stage play", () => {
    expect(gradeSkipReason(row({ stage_id: ILLEGAL }))).toBe("non_legal_stage");
  });

  // Quitting out is how people get back to character select, so most quit-outs hold a whole
  // game's worth of play. Excluding all of them gutted the feature in the mode it is for.
  it("keeps a long quit-out, which is a real game somebody ended", () => {
    for (const result of ["lras_win", "lras_loss"]) {
      expect(gradeSkipReason(row({ result, duration_frames: QUIT_OUT_MIN_FRAMES }))).toBeNull();
    }
  });

  it("skips a quit-out that ended before the threshold", () => {
    expect(gradeSkipReason(row({ result: "lras_loss", duration_frames: QUIT_OUT_MIN_FRAMES - 1 })))
      .toBe("short_quit_out");
  });

  // The duration rule is for quit-outs specifically: a genuinely short game that still reached
  // a natural result is a result, and nothing about its stats is a stub.
  it("does not apply the duration rule to a game that finished normally", () => {
    expect(gradeSkipReason(row({ result: "win", duration_frames: 300 }))).toBeNull();
  });

  // The two gates are checked in a fixed order so a row that trips both is attributed once.
  it("reports the stage before the quit-out when a row trips both", () => {
    expect(gradeSkipReason(row({ stage_id: ILLEGAL, result: "lras_win", duration_frames: 10 })))
      .toBe("non_legal_stage");
  });

  // Rows come from SQLite, where any column can read back null.
  it("treats missing metadata as a non-legal stage rather than guessing", () => {
    expect(gradeSkipReason({})).toBe("non_legal_stage");
    expect(gradeSkipReason({ stage_id: null, result: null, duration_frames: null }))
      .toBe("non_legal_stage");
  });

  it("treats a quit-out with no recorded duration as a stub", () => {
    expect(gradeSkipReason({ stage_id: LEGAL, result: "lras_win", duration_frames: null }))
      .toBe("short_quit_out");
  });
});

describe("countGradeCandidates", () => {
  it("splits a mixed pile into candidates and each skip reason", () => {
    const counts = countGradeCandidates([
      row(),
      row({ result: "loss" }),
      row({ stage_id: ILLEGAL }),
      row({ result: "lras_win", duration_frames: 60 }),
      row({ result: "lras_win", duration_frames: 9000 }),
    ]);
    expect(counts).toEqual({ total: 5, candidates: 3, nonLegalStage: 1, shortQuitOut: 1 });
  });

  // Every row lands in exactly one bucket, so a UI can print "N of M" without the two
  // disagreeing — the kind of subtraction that made the live scoreboard read 4–2 against a
  // 2–2 session strip.
  it("accounts for every row exactly once", () => {
    const games = [
      row(), row({ stage_id: ILLEGAL }), row({ result: "lras_loss", duration_frames: 1 }),
      row({ duration_frames: 123 }),
    ];
    const c = countGradeCandidates(games);
    expect(c.candidates + c.nonLegalStage + c.shortQuitOut).toBe(c.total);
    expect(c.total).toBe(games.length);
  });

  it("returns an empty tally for no games", () => {
    expect(countGradeCandidates([])).toEqual({
      total: 0, candidates: 0, nonLegalStage: 0, shortQuitOut: 0,
    });
  });
});
