import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  if (typeof globalThis.localStorage === "undefined") {
    const mem = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    };
  }
});

function game(over: Record<string, any> = {}) {
  return {
    match_id: "m1", match_type: "unranked", result: "win",
    kills: 4, deaths: 2,
    openings_per_kill: 5, damage_per_opening: 25, neutral_win_ratio: 0.55,
    opening_conversion_rate: 0.6, stage_control_ratio: 0.55,
    avg_kill_percent: 110, avg_death_percent: 115,
    edgeguard_success_rate: 0.1, tech_chase_rate: 0.2,
    recovery_success_rate: 0.9, avg_stock_duration: 2600, respawn_defense_rate: 1,
    lead_maintenance_rate: 0.8, comeback_rate: 0.3,
    l_cancel_ratio: 0.8, inputs_per_minute: 400, wavedash_miss_rate: 0.2,
    hit_advantage_rate: 0.6, counter_hit_rate: 0.3, defensive_option_rate: 0.5,
    duration_frames: 7000, stage_id: 31, player_char_id: 20, opponent_char_id: 2,
    opponent_code: "ABC#123", timestamp: "2026-10-06T00:00:00Z",
    ...over,
  } as any;
}

describe("gradeGame", () => {
  it("grades a single game without the set win bonus", async () => {
    const { gradeGame } = await import("./grading");
    const won = gradeGame(game({ result: "win" }), "Falco", "Fox");
    const lost = gradeGame(game({ result: "loss" }), "Falco", "Fox");
    // Identical stats, opposite results: the letter must come from the play, not the outcome.
    // Over a set +5 reads as a difficulty premium; on one game it is half a letter of swing.
    expect(won.winBonus).toBe(0);
    expect(lost.winBonus).toBe(0);
    expect(won.score).toBe(lost.score);
  });

  it("applies no set comeback / closeout / blown-lead modifier", async () => {
    const { gradeGame } = await import("./grading");
    const g = gradeGame(game(), "Falco", "Fox");
    expect(g.setModifier).toBe(0);
    expect(g.setModifierLabel).toBeNull();
  });

  it("still gives a real letter and category scores", async () => {
    const { gradeGame } = await import("./grading");
    const g = gradeGame(game(), "Falco", "Fox");
    expect("SABCDF").toContain(g.letter);
    expect(g.score).toBeGreaterThan(0);
    expect(g.categories.punish.score).not.toBeNull();
  });

  it("works for unranked and direct games, which have no set at all", async () => {
    const { gradeGame } = await import("./grading");
    for (const mode of ["unranked", "direct", "ranked"]) {
      const g = gradeGame(game({ match_type: mode }), "Falco", "Fox");
      expect(g.score).toBeGreaterThan(0);
    }
  });

  it("leaves gradeSet's win bonus intact by default", async () => {
    const { gradeSet } = await import("./grading");
    const s = gradeSet([game()], "Falco", "Fox", "win", 2, 0);
    expect(s.winBonus).toBe(5);
  });
});
