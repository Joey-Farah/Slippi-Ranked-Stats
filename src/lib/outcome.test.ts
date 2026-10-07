import { describe, it, expect } from "vitest";
import { gameOutcome, tallyOutcomes } from "./outcome";

describe("gameOutcome", () => {
  it("counts normal results the same in every mode", () => {
    for (const m of ["ranked", "unranked", "direct"]) {
      expect(gameOutcome("win", m)).toBe("win");
      expect(gameOutcome("loss", m)).toBe("loss");
    }
  });

  it("keeps forfeit semantics in ranked", () => {
    // Ranked quit-outs ARE forfeits and Slippi scores them that way.
    expect(gameOutcome("lras_win", "ranked")).toBe("win");
    expect(gameOutcome("lras_loss", "ranked")).toBe("loss");
  });

  it("treats a quit-out as no result in unranked and direct", () => {
    // Quitting out of friendlies is how people get back to character select, not conceding.
    for (const m of ["unranked", "direct"]) {
      expect(gameOutcome("lras_win", m)).toBe("none");
      expect(gameOutcome("lras_loss", m)).toBe("none");
    }
  });

  it("treats an unknown result as no result rather than a loss", () => {
    expect(gameOutcome("", "ranked")).toBe("none");
    expect(gameOutcome(null, "unranked")).toBe("none");
    expect(gameOutcome("weird", "direct")).toBe("none");
  });
});

describe("tallyOutcomes", () => {
  it("reproduces the real session that exposed this: 4-2 becomes 2-2", () => {
    const session = [
      { result: "loss",     match_type: "unranked" },
      { result: "win",      match_type: "unranked" },
      { result: "lras_win", match_type: "unranked" },
      { result: "win",      match_type: "unranked" },
      { result: "lras_win", match_type: "unranked" },
      { result: "loss",     match_type: "unranked" },
    ];
    expect(tallyOutcomes(session)).toEqual({ wins: 2, losses: 2, total: 4, noResult: 2 });
  });

  it("still counts ranked forfeits", () => {
    expect(tallyOutcomes([
      { result: "win", match_type: "ranked" },
      { result: "lras_win", match_type: "ranked" },
    ])).toEqual({ wins: 2, losses: 0, total: 2, noResult: 0 });
  });
});
