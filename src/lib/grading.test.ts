import { describe, it, expect } from "vitest";
import { gradeSet, scoreToGrade, CATEGORY_DEFS, type GradeLetter } from "./grading";
import type { LiveGameStats } from "./store";
import { BENCHMARKS } from "./grade-benchmarks";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Minimal LiveGameStats with defensible middle-of-the-pack values. Tests that
 *  need specific stat values override individual fields. */
function mockGame(overrides: Partial<LiveGameStats> = {}): LiveGameStats {
  return {
    match_id: "test-match",
    result:   "win",
    kills:    4,
    deaths:   2,
    openings_per_kill:       3.0,
    damage_per_opening:      18.0,
    neutral_win_ratio:       0.50,
    counter_hit_rate:        0.2,
    inputs_per_minute:       350,
    l_cancel_ratio:          0.80,
    avg_kill_percent:        90,
    avg_death_percent:       100,
    defensive_option_rate:   0.3,
    opening_conversion_rate: 0.5,
    stage_control_ratio:     0.5,
    lead_maintenance_rate:   0.5,
    tech_chase_rate:         0.3,
    edgeguard_success_rate:  0.5,
    hit_advantage_rate:      0.5,
    recovery_success_rate:   0.6,
    avg_stock_duration:      1800,
    respawn_defense_rate:    0.5,
    comeback_rate:           0.3,
    wavedash_miss_rate:      0.1,
    duration_frames:         7200,
    stage_id:                32,
    player_char_id:          20,
    opponent_char_id:        2,
    opponent_code:           "TEST#000",
    timestamp:               "2026-04-17T12:00:00Z",
    ...overrides,
  };
}

// ── scoreToGrade ───────────────────────────────────────────────────────────

describe("scoreToGrade", () => {
  it("maps scores to correct letters at exact thresholds", () => {
    expect(scoreToGrade(75)).toBe("S");
    expect(scoreToGrade(63)).toBe("A");
    expect(scoreToGrade(52)).toBe("B");
    expect(scoreToGrade(40)).toBe("C");
    expect(scoreToGrade(28)).toBe("D");
    expect(scoreToGrade(27.99)).toBe("F");
  });

  it("maps scores just below each threshold to the lower grade", () => {
    expect(scoreToGrade(74.99)).toBe("A");
    expect(scoreToGrade(62.99)).toBe("B");
    expect(scoreToGrade(51.99)).toBe("C");
    expect(scoreToGrade(39.99)).toBe("D");
  });

  it("handles edge values", () => {
    expect(scoreToGrade(100)).toBe("S");
    expect(scoreToGrade(0)).toBe("F");
  });
});

// ── gradeSet — shape + invariants ──────────────────────────────────────────

describe("gradeSet", () => {
  it("returns a fully-populated SetGrade with all 18 breakdown keys", () => {
    const grade = gradeSet([mockGame()], "Fox", "Falco", "win", 2, 0);

    const expectedKeys = [
      "neutral_win_ratio", "opening_conversion_rate", "stage_control_ratio",
      "lead_maintenance_rate", "openings_per_kill", "damage_per_opening",
      "avg_kill_percent", "edgeguard_success_rate", "tech_chase_rate",
      "hit_advantage_rate", "avg_death_percent", "recovery_success_rate",
      "avg_stock_duration", "respawn_defense_rate", "comeback_rate",
      "l_cancel_ratio", "inputs_per_minute", "wavedash_miss_rate",
    ];
    expect(Object.keys(grade.breakdown).sort()).toEqual(expectedKeys.sort());
  });

  it("produces all four category grades", () => {
    const grade = gradeSet([mockGame()], "Fox", "Falco", "win", 2, 0);
    expect(Object.keys(grade.categories).sort()).toEqual(
      ["defense", "execution", "neutral", "punish"]
    );
  });

  it("overall score is clamped to [0, 100]", () => {
    const grade = gradeSet([mockGame()], "Fox", "Falco", "win", 2, 0);
    expect(grade.score).toBeGreaterThanOrEqual(0);
    expect(grade.score).toBeLessThanOrEqual(100);
  });

  it("overall letter matches overall score via scoreToGrade", () => {
    const grade = gradeSet([mockGame()], "Fox", "Falco", "win", 2, 0);
    expect(grade.letter).toBe(scoreToGrade(grade.score));
  });

  it("preserves set metadata (players, result, record)", () => {
    const grade = gradeSet([mockGame()], "Fox", "Falco", "loss", 1, 2);
    expect(grade.playerChar).toBe("Fox");
    expect(grade.opponentChar).toBe("Falco");
    expect(grade.setResult).toBe("loss");
    expect(grade.wins).toBe(1);
    expect(grade.losses).toBe(2);
  });
});

// ── Win bonus ──────────────────────────────────────────────────────────────

describe("gradeSet win bonus", () => {
  it("adds +5 to overall score for a win (capped at 100)", () => {
    const game = mockGame();
    const win  = gradeSet([game], "Fox", "Falco", "win",  2, 0);
    const loss = gradeSet([game], "Fox", "Falco", "loss", 0, 2);

    // Same stats, different result → win score should be exactly 5 higher
    // unless the loss score was ≥ 95 (then win is capped at 100).
    if (loss.score < 95) {
      expect(win.score).toBeCloseTo(Math.min(100, loss.score + 5), 1);
    } else {
      expect(win.score).toBe(100);
    }
  });

  it("never produces a score above 100, even at max stats with a win", () => {
    // Stats so high they'd score 100+ without clamping
    const game = mockGame({
      neutral_win_ratio:       0.99,
      opening_conversion_rate: 0.99,
      stage_control_ratio:     0.99,
      lead_maintenance_rate:   0.99,
      openings_per_kill:       0.1,
      damage_per_opening:      60,
      avg_kill_percent:        20,
      edgeguard_success_rate:  0.99,
      tech_chase_rate:         0.99,
      hit_advantage_rate:      0.99,
      avg_death_percent:       200,
      recovery_success_rate:   0.99,
      avg_stock_duration:      10000,
      respawn_defense_rate:    0.99,
      comeback_rate:           0.99,
      l_cancel_ratio:          1.0,
      inputs_per_minute:       1200,
    });
    const grade = gradeSet([game], "Fox", "Falco", "win", 2, 0);
    expect(grade.score).toBeLessThanOrEqual(100);
  });
});

// ── Baseline source selection ──────────────────────────────────────────────

describe("gradeSet baseline source", () => {
  it("falls back to 'overall' baseline for an unknown player character", () => {
    const grade = gradeSet([mockGame()], "NotARealChar", "AlsoFake", "win", 2, 0);
    expect(grade.baselineSource).toBe("overall");
  });

  it("uses 'character' baseline when player char exists but matchup does not", () => {
    // Pick a real character with benchmark data but an invented opponent
    const realCharWithData = Object.keys(BENCHMARKS.by_player_char).find(
      (c) => c !== "_overall"
    );
    if (!realCharWithData) return; // benchmarks not populated yet — skip

    const grade = gradeSet([mockGame()], realCharWithData, "TotallyFakeOpp", "win", 2, 0);
    expect(grade.baselineSource).toBe("character");
  });
});

// ── Category weighting sanity check ────────────────────────────────────────

describe("category definitions", () => {
  it("every scored stat appears in exactly one category", () => {
    const allStats = new Set<string>();
    for (const catKey of Object.keys(CATEGORY_DEFS) as (keyof typeof CATEGORY_DEFS)[]) {
      for (const statKey of CATEGORY_DEFS[catKey].stats) {
        expect(allStats.has(statKey), `${statKey} appears in multiple categories`).toBe(false);
        allStats.add(statKey);
      }
    }
  });

  it("has exactly 4 categories", () => {
    expect(Object.keys(CATEGORY_DEFS)).toHaveLength(4);
  });
});
