import { describe, it, expect, beforeAll } from "vitest";
import type { SnapshotRow } from "./db";

// store.ts reads localStorage at module load, and vitest's node environment has none.
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

type Session = import("./store").Session;

function snap(timestamp: string, rating: number, wins: number, losses: number): SnapshotRow {
  return {
    id: 0, connect_code: "JOEY#870", timestamp, rating, wins, losses,
    global_rank: 0, regional_rank: 0, continent: "NA",
  };
}

/** A session of `n` sets, one every 10 minutes from `start`. */
function session(start: string, n: number): Session {
  const t0 = new Date(start).getTime();
  const sets = Array.from({ length: n }, (_, i) => ({
    match_id: `m${i}`,
    timestamp: new Date(t0 + i * 10 * 60_000).toISOString(),
    opponent_code: "OPP#1", opponent_char_ids: [], player_char_ids: [], stage_ids: [],
    games: [], wins: 2, losses: 0, result: "win" as const, hasLras: false,
  }));
  const end = sets.at(-1)!.timestamp;
  return {
    sets,
    start: sets[0].timestamp,
    end,
    durationMin: Math.round((new Date(end).getTime() - t0) / 60000),
    setWins: n,
    setLosses: 0,
  };
}

// Mirrors the real shape captured from the app's own database: a baseline snapshot taken when
// the watcher started, then one after each completed set.
describe("sessionRatingDelta", () => {
  it("returns the change across a bracketed session", async () => {
    const { sessionRatingDelta } = await import("./store");
    const s = session("2026-08-01T21:20:00Z", 3);
    const snaps = [
      snap("2026-08-01T20:29:05Z", 2471.76, 75, 15), // watcher-start baseline
      snap("2026-08-01T21:33:14Z", 2475.76, 76, 15),
      snap("2026-08-01T21:43:02Z", 2479.72, 77, 15),
      snap("2026-08-01T21:54:24Z", 2462.15, 77, 16),
    ];
    const r = sessionRatingDelta(s, snaps)!;
    expect(r).not.toBeNull();
    expect(r.delta).toBeCloseTo(-9.61, 2);
    expect(r.from).toBeCloseTo(2471.76, 2);
    expect(r.to).toBeCloseTo(2462.15, 2);
  });

  it("returns null when no snapshot precedes the session", async () => {
    const { sessionRatingDelta } = await import("./store");
    const s = session("2026-08-01T21:20:00Z", 2);
    // Both snapshots land after the session started — no baseline to measure from.
    expect(sessionRatingDelta(s, [
      snap("2026-08-01T21:33:14Z", 2475.76, 76, 15),
      snap("2026-08-01T21:43:02Z", 2479.72, 77, 15),
    ])).toBeNull();
  });

  it("returns null when nothing was recorded after the session", async () => {
    const { sessionRatingDelta } = await import("./store");
    const s = session("2026-08-01T21:20:00Z", 2);
    expect(sessionRatingDelta(s, [snap("2026-08-01T20:29:05Z", 2471.76, 75, 15)])).toBeNull();
  });

  it("returns null for a session with no snapshot coverage at all", async () => {
    const { sessionRatingDelta } = await import("./store");
    // The common case: most historical sessions predate rating snapshots entirely.
    const s = session("2024-06-01T21:20:00Z", 4);
    expect(sessionRatingDelta(s, [snap("2026-08-01T20:29:05Z", 2471.76, 75, 15)])).toBeNull();
  });

  // The guard that matters: a stale baseline would otherwise silently attribute an earlier
  // session's results to this one. The snapshots' season W/L reveal how many sets actually
  // elapsed between them, so a bracket that spans more than this session is rejected.
  it("rejects a bracket that spans more sets than the session contains", async () => {
    const { sessionRatingDelta } = await import("./store");
    const s = session("2026-08-01T21:20:00Z", 3);
    const snaps = [
      snap("2026-07-30T18:00:00Z", 2400.0, 60, 12), // days old — 20 sets have happened since
      snap("2026-08-01T21:54:24Z", 2462.15, 77, 16),
    ];
    expect(sessionRatingDelta(s, snaps)).toBeNull();
  });

  it("rejects an off-by-one bracket", async () => {
    const { sessionRatingDelta } = await import("./store");
    const s = session("2026-08-01T21:20:00Z", 3);
    const snaps = [
      snap("2026-08-01T20:29:05Z", 2471.76, 75, 15),
      snap("2026-08-01T21:54:24Z", 2462.15, 78, 16), // 4 sets apart, session has 3
    ];
    expect(sessionRatingDelta(s, snaps)).toBeNull();
  });

  it("ignores a snapshot beyond the post-session grace window", async () => {
    const { sessionRatingDelta } = await import("./store");
    const s = session("2026-08-01T21:20:00Z", 1);
    const snaps = [
      snap("2026-08-01T20:29:05Z", 2471.76, 75, 15),
      // 40 minutes past the session's last set — belongs to whatever came next, not here.
      snap("2026-08-01T22:00:00Z", 2500.0, 76, 15),
    ];
    expect(sessionRatingDelta(s, snaps)).toBeNull();
  });

  it("handles an empty snapshot list", async () => {
    const { sessionRatingDelta } = await import("./store");
    expect(sessionRatingDelta(session("2026-08-01T21:20:00Z", 2), [])).toBeNull();
  });
});
