import { describe, it, expect, beforeAll } from "vitest";
import { get } from "svelte/store";

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

const DAY = 24 * 60 * 60 * 1000;

function gameDaysAgo(days: number, stage_id = 31) {
  return {
    filename: `g${days}.slp`,
    timestamp: new Date(Date.now() - days * DAY).toISOString(),
    stage_id,
  } as any;
}

describe("date-range presets", () => {
  it("keeps the ids that are already persisted on existing installs", async () => {
    const { DATE_RANGES } = await import("./store");
    const ids = DATE_RANGES.map((r) => r.id);
    // These three were the only options before 180d/1y/2y were added, and the chosen one is
    // stored verbatim in localStorage — renaming or dropping one strands existing installs.
    expect(ids).toContain("all");
    expect(ids).toContain("90d");
    expect(ids).toContain("30d");
  });

  it("maps every preset to its window, with all-time as the only null", async () => {
    const { DATE_RANGES, rangeDays } = await import("./store");
    expect(rangeDays("all")).toBeNull();
    expect(rangeDays("30d")).toBe(30);
    expect(rangeDays("90d")).toBe(90);
    expect(rangeDays("180d")).toBe(180);
    expect(rangeDays("1y")).toBe(365);
    expect(rangeDays("2y")).toBe(730);
    for (const r of DATE_RANGES) {
      if (r.id !== "all") expect(rangeDays(r.id)).toBeGreaterThan(0);
    }
  });

  it("falls back to all-time on an id it doesn't know", async () => {
    const { rangeDays } = await import("./store");
    // A value left behind by a future build, or hand-edited in localStorage. Showing
    // everything is the safe degradation; the old ternary silently meant 90 days.
    expect(rangeDays("5y")).toBeNull();
    expect(rangeDays("")).toBeNull();
    expect(rangeDays("garbage")).toBeNull();
  });

  it("widens filteredGames to the selected window", async () => {
    const { games, dateRange, filteredGames } = await import("./store");
    games.set([gameDaysAgo(5), gameDaysAgo(60), gameDaysAgo(200), gameDaysAgo(500)]);

    dateRange.set("30d");
    expect(get(filteredGames)).toHaveLength(1);
    dateRange.set("90d");
    expect(get(filteredGames)).toHaveLength(2);
    dateRange.set("180d");
    expect(get(filteredGames)).toHaveLength(2);
    dateRange.set("1y");
    expect(get(filteredGames)).toHaveLength(3);
    dateRange.set("2y");
    expect(get(filteredGames)).toHaveLength(4);
    dateRange.set("all");
    expect(get(filteredGames)).toHaveLength(4);

    games.set([]);
    dateRange.set("all");
  });

  it("applies the same window to rating snapshots as to games", async () => {
    // The Rating History line comes from `snapshots`, which is a plain writable and so never
    // went through filteredGames. Before dateFilteredSnapshots the chart drew all of history
    // while the win-rate overlaid on it honoured the filter.
    const { snapshots, dateRange, dateFilteredSnapshots, filteredGames, games } = await import("./store");
    snapshots.set([
      { timestamp: new Date(Date.now() - 5 * DAY).toISOString(), rating: 1500 },
      { timestamp: new Date(Date.now() - 200 * DAY).toISOString(), rating: 1400 },
      { timestamp: new Date(Date.now() - 500 * DAY).toISOString(), rating: 1300 },
    ] as any);
    games.set([gameDaysAgo(5), gameDaysAgo(200), gameDaysAgo(500)]);

    dateRange.set("30d");
    expect(get(dateFilteredSnapshots)).toHaveLength(1);
    dateRange.set("1y");
    expect(get(dateFilteredSnapshots)).toHaveLength(2);
    dateRange.set("all");
    expect(get(dateFilteredSnapshots)).toHaveLength(3);

    // and the two stores agree on the same window — the bug was them disagreeing
    for (const r of ["30d", "1y", "all"] as const) {
      dateRange.set(r);
      expect(get(dateFilteredSnapshots).length).toBe(get(filteredGames).length);
    }

    snapshots.set([]);
    games.set([]);
    dateRange.set("all");
  });

  it("still drops non-legal stages inside a window", async () => {
    const { games, dateRange, filteredGames } = await import("./store");
    games.set([gameDaysAgo(100, 31), gameDaysAgo(100, 4 /* Peach's Castle */)]);
    dateRange.set("1y");
    expect(get(filteredGames)).toHaveLength(1);

    games.set([]);
    dateRange.set("all");
  });
});
