import { describe, it, expect, beforeAll } from "vitest";
import type { LiveGameStats, LiveMode } from "./store";

// store.ts reads localStorage at module load (the persisted() helpers run top-level), and
// vitest defaults to the node environment where it doesn't exist. Install a minimal in-memory
// stub before the module is imported.
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

function game(match_id: string, match_type: LiveMode, result: string): LiveGameStats {
  return {
    match_id,
    match_type,
    result,
    kills: 4, deaths: 2,
    openings_per_kill: null, damage_per_opening: null, neutral_win_ratio: null,
    counter_hit_rate: null, inputs_per_minute: null, l_cancel_ratio: null,
    avg_kill_percent: null, avg_death_percent: null, defensive_option_rate: null,
    opening_conversion_rate: null, stage_control_ratio: null, lead_maintenance_rate: null,
    tech_chase_rate: null, edgeguard_success_rate: null, hit_advantage_rate: null,
    recovery_success_rate: null, avg_stock_duration: null, respawn_defense_rate: null,
    comeback_rate: null, wavedash_miss_rate: null,
    duration_frames: 7200, stage_id: 31,
    player_char_id: 2, opponent_char_id: 9,
    opponent_code: "OPP#123",
    timestamp: "2026-07-28T20:00:00Z",
  };
}

/** Read a derived store's current value without leaving a live subscription behind. */
async function read<T>(store: { subscribe: (fn: (v: T) => void) => () => void }): Promise<T> {
  let value!: T;
  const unsub = store.subscribe((v) => (value = v));
  unsub();
  return value;
}

describe("live session records", () => {
  it("counts ranked sets, ignoring unranked and direct games", async () => {
    const { liveGameStats, liveSetRecord } = await import("./store");
    liveGameStats.set([
      // Won ranked set 2–0
      game("r1", "ranked", "win"),
      game("r1", "ranked", "win"),
      // Lost ranked set 1–2
      game("r2", "ranked", "win"),
      game("r2", "ranked", "loss"),
      game("r2", "ranked", "loss"),
      // Ranked set still in progress — must not count either way
      game("r3", "ranked", "win"),
    ]);
    expect(await read(liveSetRecord)).toEqual({ wins: 1, losses: 1, total: 2 });
  });

  it("does not let a long unranked run masquerade as a set", async () => {
    const { liveGameStats, liveSetRecord, liveUnrankedRecord } = await import("./store");
    // One unranked connection, 12 games — a single match_id. Under the old first-to-2 logic
    // this would have registered as one completed "set" win and polluted the ranked tally.
    const run: LiveGameStats[] = [];
    for (let i = 0; i < 9; i++) run.push(game("u1", "unranked", "win"));
    for (let i = 0; i < 3; i++) run.push(game("u1", "unranked", "loss"));
    liveGameStats.set(run);

    expect(await read(liveSetRecord)).toEqual({ wins: 0, losses: 0, total: 0 });
    expect(await read(liveUnrankedRecord)).toEqual({ wins: 9, losses: 3, total: 12 });
  });

  it("counts direct games and keeps the two records separate", async () => {
    const { liveGameStats, liveSetRecord, liveUnrankedRecord } = await import("./store");
    liveGameStats.set([
      game("r1", "ranked", "win"),
      game("r1", "ranked", "win"),
      game("d1", "direct", "win"),
      game("d1", "direct", "loss"),
      game("d1", "direct", "win"),
      game("u1", "unranked", "loss"),
    ]);
    expect(await read(liveSetRecord)).toEqual({ wins: 1, losses: 0, total: 1 });
    expect(await read(liveUnrankedRecord)).toEqual({ wins: 2, losses: 2, total: 4 });
  });

  it("treats a forfeit win as a win in both records", async () => {
    const { liveGameStats, liveSetRecord, liveUnrankedRecord } = await import("./store");
    liveGameStats.set([
      game("r1", "ranked", "win"),
      game("r1", "ranked", "lras_win"),
      game("d1", "direct", "lras_win"),
    ]);
    expect(await read(liveSetRecord)).toEqual({ wins: 1, losses: 0, total: 1 });
    expect(await read(liveUnrankedRecord)).toEqual({ wins: 1, losses: 0, total: 1 });
  });
});
