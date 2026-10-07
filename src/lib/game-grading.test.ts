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

/** A stored `game_stats` row. Mirrors the real column set, including the metadata the scorer
 *  needs — the point of the table is that these numbers survive without the replay. */
function row(over: Record<string, any> = {}) {
  return {
    filename: "Game_20261006T120000.slp",
    match_id: "m1",
    game_timestamp: "2026-10-06T12:00:00Z",
    match_type: "unranked",
    player_char: "Falco",
    opponent_char: "Fox",
    opponent_code: "ABC#123",
    result: "win",
    stage_id: 31,
    duration_frames: 7000,
    kills: 4,
    deaths: 2,
    stats_version: 1,
    parsed_at: "2026-10-07T00:00:00Z",
    openings_per_kill: 5, damage_per_opening: 25, neutral_win_ratio: 0.55,
    counter_hit_rate: 0.3, inputs_per_minute: 400, l_cancel_ratio: 0.8,
    avg_kill_percent: 110, avg_death_percent: 115, defensive_option_rate: 0.5,
    opening_conversion_rate: 0.6, stage_control_ratio: 0.55,
    lead_maintenance_rate: 0.8, tech_chase_rate: 0.2, edgeguard_success_rate: 0.1,
    hit_advantage_rate: 0.6, recovery_success_rate: 0.9, avg_stock_duration: 2600,
    respawn_defense_rate: 1, comeback_rate: 0.3, wavedash_miss_rate: 0.2,
    ...over,
  } as any;
}

describe("rowToLiveGame", () => {
  it("carries every stat across unchanged", async () => {
    const { rowToLiveGame } = await import("./game-grading");
    const { GAME_STAT_FIELDS } = await import("./db");
    const r = row();
    const g = rowToLiveGame(r) as any;
    for (const f of GAME_STAT_FIELDS) {
      expect(g[f], `stat ${f} should survive the round trip`).toBe(r[f]);
    }
  });

  it("preserves match_type, which decides the win bonus and the quit-out rule", async () => {
    const { rowToLiveGame } = await import("./game-grading");
    expect(rowToLiveGame(row({ match_type: "direct" })).match_type).toBe("direct");
    expect(rowToLiveGame(row({ match_type: "ranked" })).match_type).toBe("ranked");
  });

  it("maps the stored timestamp onto the field the grader reads", async () => {
    const { rowToLiveGame } = await import("./game-grading");
    expect(rowToLiveGame(row()).timestamp).toBe("2026-10-06T12:00:00Z");
  });
});

describe("scoreGameStats", () => {
  it("grades a stored row without ever touching its replay", async () => {
    const { scoreGameStats } = await import("./game-grading");
    const [e] = scoreGameStats([row()]);
    expect(e.grade).not.toBeNull();
    expect(e.ungradable).toBe(false);
    expect(e.grade!.letter).toMatch(/^[SABCDF]$/);
    expect(e.playerChar).toBe("Falco");
    expect(e.opponentChar).toBe("Fox");
  });

  it("marks a frameless replay ungradable instead of scoring zeros", async () => {
    // avg_stock_duration === null is the parser's only signal that a replay held no frames at
    // all (the opponent left before the game started). The row is still STORED, so the batch
    // job never re-reads that file looking for stats it does not have.
    const { scoreGameStats } = await import("./game-grading");
    const [e] = scoreGameStats([row({ avg_stock_duration: null })]);
    expect(e.ungradable).toBe(true);
    expect(e.grade).toBeNull();
  });

  it("gives no win bonus to a stored unranked game, but does to a ranked one", async () => {
    const { scoreGameStats } = await import("./game-grading");
    const [unranked] = scoreGameStats([row({ match_type: "unranked", result: "win" })]);
    const [ranked]   = scoreGameStats([row({ match_type: "ranked",   result: "win" })]);
    expect(unranked.grade!.winBonus).toBe(0);
    expect(ranked.grade!.winBonus).toBe(5);
  });

  it("scores a quit-out outside ranked as no result, not a loss", async () => {
    // Mirrors outcome.ts: quitting a friendly is how people get back to character select.
    const { scoreGameStats } = await import("./game-grading");
    const [quit] = scoreGameStats([row({ match_type: "unranked", result: "lras_win" })]);
    expect(quit.grade!.winBonus).toBe(0);
    expect(quit.result).toBe("lras_win");
  });

  it("is deterministic — the same row scores the same twice", async () => {
    // The whole design rests on the grade being derivable, so re-scoring must be stable.
    const { scoreGameStats } = await import("./game-grading");
    const a = scoreGameStats([row()])[0].grade!;
    const b = scoreGameStats([row()])[0].grade!;
    expect(a.score).toBe(b.score);
    expect(a.letter).toBe(b.letter);
  });

  it("keeps row order and returns one entry per row", async () => {
    const { scoreGameStats } = await import("./game-grading");
    const out = scoreGameStats([
      row({ filename: "a.slp" }),
      row({ filename: "b.slp", avg_stock_duration: null }),
      row({ filename: "c.slp" }),
    ]);
    expect(out.map((e) => e.filename)).toEqual(["a.slp", "b.slp", "c.slp"]);
    expect(out.map((e) => e.ungradable)).toEqual([false, true, false]);
  });
});

describe("GAME_STAT_FIELDS", () => {
  it("matches the stat fields LiveGameStats declares", async () => {
    // These two lists are the contract between the stored table and the grader. A stat added to
    // the parser but not to the table would be silently dropped on every stored row, and the
    // grade would quietly fall back to the benchmark default forever.
    const { GAME_STAT_FIELDS } = await import("./db");
    expect(new Set(GAME_STAT_FIELDS).size).toBe(GAME_STAT_FIELDS.length);
    expect(GAME_STAT_FIELDS).toContain("openings_per_kill");
    expect(GAME_STAT_FIELDS).toContain("wavedash_miss_rate");
    expect(GAME_STAT_FIELDS.length).toBe(20);
  });
});
