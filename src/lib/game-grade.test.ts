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
  it("applies the win bonus in ranked, where the result is the point", async () => {
    const { gradeGame } = await import("./grading");
    const won  = gradeGame(game({ result: "win",  match_type: "ranked" }), "Falco", "Fox");
    const lost = gradeGame(game({ result: "loss", match_type: "ranked" }), "Falco", "Fox");
    expect(won.winBonus).toBe(5);
    expect(lost.winBonus).toBe(0);
    expect(won.score).toBeGreaterThan(lost.score);
  });

  it("gives no win bonus in unranked or direct", async () => {
    const { gradeGame } = await import("./grading");
    // Friendlies are practice, and people quit out of them constantly, so "did you win this
    // one" is a much weaker signal than it is in ranked.
    for (const m of ["unranked", "direct"]) {
      const won  = gradeGame(game({ result: "win",  match_type: m }), "Falco", "Fox");
      const lost = gradeGame(game({ result: "loss", match_type: m }), "Falco", "Fox");
      expect(won.winBonus).toBe(0);
      expect(won.score).toBe(lost.score);
    }
  });

  it("treats an unranked quit-out as no result, so it gets no win bonus", async () => {
    const { gradeGame } = await import("./grading");
    const q = gradeGame(game({ result: "lras_win", match_type: "unranked" }), "Falco", "Fox");
    expect(q.winBonus).toBe(0);
    // ...while a ranked forfeit still is a win
    const r = gradeGame(game({ result: "lras_win", match_type: "ranked" }), "Falco", "Fox");
    expect(r.winBonus).toBe(5);
  });

  it("still lets the win bonus be suppressed through gradeSet", async () => {
    const { gradeSet } = await import("./grading");
    const off = gradeSet([game()], "Falco", "Fox", "win", 1, 0, null, false, false);
    expect(off.winBonus).toBe(0);
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

describe("featuredCategory on a single game", () => {
  it("picks the BEST stat on a win and the WORST on a loss", async () => {
    const { gradeGame, featuredCategory } = await import("./grading");
    // Strong punish, weak defense — the same game read two ways.
    const g = gradeGame(game({
      openings_per_kill: 3, damage_per_opening: 45, avg_kill_percent: 80,
      avg_death_percent: 60, recovery_success_rate: 0.3, avg_stock_duration: 1200,
    }), "Falco", "Fox");
    const best = featuredCategory(g, true);
    const worst = featuredCategory(g, false);
    expect(best).not.toBeNull();
    expect(worst).not.toBeNull();
    // They must not be the same pick, or the BEST/WORST caption is meaningless.
    expect(best!.label).not.toBe(worst!.label);
    expect(best!.label).toBe("Punish");
    expect(worst!.label).toBe("Defense");
  });

  it("returns a stat within the chosen category, not just the category", async () => {
    const { gradeGame, featuredCategory } = await import("./grading");
    const f = featuredCategory(gradeGame(game(), "Falco", "Fox"), true);
    expect(f?.stat).not.toBeNull();
    expect(typeof f?.stat?.label).toBe("string");
    expect("SABCDF").toContain(f!.stat!.letter);
  });
});
