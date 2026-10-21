import { describe, it, expect } from "vitest";
import { gameOutcome, tallyOutcomes, QUIT_OUT_COUNTS_AFTER_FRAMES as LIMIT } from "./outcome";

const FULL_GAME = 3 * 60 * 60;

describe("gameOutcome", () => {
  it("counts normal results the same in every mode", () => {
    for (const m of ["ranked", "unranked", "direct"]) {
      expect(gameOutcome("win", m, FULL_GAME)).toBe("win");
      expect(gameOutcome("loss", m, FULL_GAME)).toBe("loss");
    }
  });

  it("keeps forfeit semantics in ranked, however early", () => {
    // Ranked quit-outs ARE forfeits and Slippi scores them that way.
    expect(gameOutcome("lras_win", "ranked", 1)).toBe("win");
    expect(gameOutcome("lras_loss", "ranked", 1)).toBe("loss");
  });

  it("treats an early quit-out as no result in unranked and direct", () => {
    // A misclick, wrong character, unwanted stage: not a game.
    for (const m of ["unranked", "direct"]) {
      expect(gameOutcome("lras_win", m, LIMIT - 1)).toBe("none");
      expect(gameOutcome("lras_loss", m, LIMIT - 1)).toBe("none");
    }
  });

  it("counts a later quit-out against whoever quit in unranked and direct", () => {
    // The common case: a whole game played, then they leave just before losing.
    for (const m of ["unranked", "direct"]) {
      expect(gameOutcome("lras_win", m, LIMIT)).toBe("win");
      expect(gameOutcome("lras_loss", m, LIMIT)).toBe("loss");
      expect(gameOutcome("lras_win", m, FULL_GAME)).toBe("win");
    }
  });

  it("does not guess when a quit-out's duration is unknown", () => {
    expect(gameOutcome("lras_win", "unranked", null)).toBe("none");
    expect(gameOutcome("lras_loss", "direct", undefined)).toBe("none");
  });

  it("treats an unknown result as no result rather than a loss", () => {
    expect(gameOutcome("", "ranked", FULL_GAME)).toBe("none");
    expect(gameOutcome(null, "unranked", FULL_GAME)).toBe("none");
    expect(gameOutcome("weird", "direct", FULL_GAME)).toBe("none");
  });
});

describe("tallyOutcomes", () => {
  it("counts full-length quit-outs and drops early ones", () => {
    const session = [
      { result: "loss",      match_type: "unranked", duration_frames: FULL_GAME },
      { result: "win",       match_type: "unranked", duration_frames: FULL_GAME },
      { result: "lras_win",  match_type: "unranked", duration_frames: FULL_GAME }, // they rage-quit
      { result: "lras_loss", match_type: "unranked", duration_frames: 60 },        // 1 s: nothing
      { result: "lras_win",  match_type: "unranked", duration_frames: 60 },        // 1 s: nothing
      { result: "loss",      match_type: "unranked", duration_frames: FULL_GAME },
    ];
    expect(tallyOutcomes(session)).toEqual({ wins: 2, losses: 2, total: 4, noResult: 2 });
  });

  it("still counts ranked forfeits", () => {
    expect(tallyOutcomes([
      { result: "win", match_type: "ranked", duration_frames: FULL_GAME },
      { result: "lras_win", match_type: "ranked", duration_frames: 60 },
    ])).toEqual({ wins: 2, losses: 0, total: 2, noResult: 0 });
  });
});
