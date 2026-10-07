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

function entry(over: Record<string, any> = {}) {
  const score = over.score ?? 70;
  return {
    playerChar: "Falco",
    opponentChar: "Fox",
    result: "win",
    ...over,
    grade: over.grade === null ? null : {
      letter: "A",
      score,
      categories: {
        neutral: { label: "Neutral", letter: "A", score: over.neutral ?? score },
        punish:  { label: "Punish",  letter: "A", score: over.punish  ?? score },
        defense: { label: "Defense", letter: "A", score: over.defense ?? score },
      },
      breakdown: {},
      baselineSource: "matchup",
      setResult: "win",
      wins: 1, losses: 0, winBonus: 0,
    },
  } as any;
}

describe("buildMatchupSummaries", () => {
  it("groups by matchup and averages the score", async () => {
    const { buildMatchupSummaries } = await import("./matchup-summary");
    const out = buildMatchupSummaries([
      entry({ score: 60 }),
      entry({ score: 80 }),
      entry({ opponentChar: "Marth", score: 50 }),
    ]);
    expect(out).toHaveLength(2);
    const vsFox = out.find((m) => m.opponentChar === "Fox")!;
    expect(vsFox.setCount).toBe(2);
    expect(vsFox.avgScore).toBe(70);
  });

  it("keys the matchup DIRECTIONALLY", async () => {
    // Falco-vs-Marth and Marth-vs-Falco are different matchups; merging them would average
    // two unrelated populations.
    const { buildMatchupSummaries } = await import("./matchup-summary");
    const out = buildMatchupSummaries([
      entry({ playerChar: "Falco", opponentChar: "Marth" }),
      entry({ playerChar: "Marth", opponentChar: "Falco" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("drops ungraded entries instead of scoring them zero", async () => {
    // A game with no frame data has no grade, which is not the same as a bad grade.
    const { buildMatchupSummaries } = await import("./matchup-summary");
    const out = buildMatchupSummaries([
      entry({ score: 80 }),
      entry({ grade: null }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].setCount).toBe(1);
    expect(out[0].avgScore).toBe(80);
  });

  it("never derives losses by subtraction", async () => {
    // Outside ranked a quit-out counts as neither a win nor a loss, so wins + losses can be
    // less than the entry count. Subtracting would file every quit-out as a loss.
    const { buildMatchupSummaries } = await import("./matchup-summary");
    const out = buildMatchupSummaries([
      entry({ result: "win" }),
      entry({ result: "loss" }),
      entry({ result: "lras_win" }),
    ]);
    expect(out[0].setCount).toBe(3);
    expect(out[0].wins).toBe(1);
    expect(out[0].losses).toBe(1);
    expect(out[0].wins + out[0].losses).toBeLessThan(out[0].setCount);
  });

  it("sorts the busiest matchup first", async () => {
    const { buildMatchupSummaries } = await import("./matchup-summary");
    const out = buildMatchupSummaries([
      entry({ opponentChar: "Marth" }),
      entry({ opponentChar: "Fox" }),
      entry({ opponentChar: "Fox" }),
      entry({ opponentChar: "Fox" }),
    ]);
    expect(out[0].opponentChar).toBe("Fox");
    expect(out[0].setCount).toBe(3);
  });

  it("averages categories independently of the overall score", async () => {
    const { buildMatchupSummaries } = await import("./matchup-summary");
    const out = buildMatchupSummaries([
      entry({ score: 70, neutral: 40, punish: 90 }),
      entry({ score: 70, neutral: 60, punish: 70 }),
    ]);
    expect(out[0].categories.neutral.avgScore).toBe(50);
    expect(out[0].categories.punish.avgScore).toBe(80);
  });

  it("returns nothing for an empty or fully ungraded list", async () => {
    const { buildMatchupSummaries } = await import("./matchup-summary");
    expect(buildMatchupSummaries([])).toEqual([]);
    expect(buildMatchupSummaries([entry({ grade: null })])).toEqual([]);
  });
});
