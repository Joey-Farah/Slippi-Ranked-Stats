import { describe, it, expect, beforeAll } from "vitest";
import type { StatsOverlayPayload, LiveMode } from "./store";

// See live-record.test.ts — store.ts touches localStorage at module load and vitest runs in
// the node environment, so a stub has to exist before the import.
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

function payload(mode: LiveMode, show: any): StatsOverlayPayload {
  return {
    tag: "Joey Dadnuts",
    rankName: "Master 1", rankColor: "#ff4444",
    rating: 2210.4, globalRank: 412, region: "NA",
    seasonWins: 388, seasonLosses: 351,
    sessionStartRating: 2190.2, sessionDelta: 20.2,
    sessionWins: 3, sessionLosses: 1,
    opponent: {
      code: "FUDG#228", mode, char: "Falco", charIds: [2, 20],
      tier: "Diamond 2", tierColor: "#00bcd4", rating: 2050.6,
      tag: "Fudgesicle", seasonWins: 412, seasonLosses: 388,
      // Ranked is a set score; unranked/direct is a running game count for the connection.
      gamesWon: mode === "ranked" ? 1 : 7,
      gamesLost: mode === "ranked" ? 1 : 5,
    },
    lastSet: null,
    layout: "stacked",
    show,
  };
}

describe("stats overlay — scoreboard unit", () => {
  // The overlay deliberately shows NO mode indicator: unranked/direct look the same as ranked
  // apart from the number being counted. The scoreboard caption is the one place the difference
  // surfaces, because calling a running game tally a "Set Count" would just be wrong.
  it("counts sets in ranked and games in unranked/direct", async () => {
    const { overlayPreviewHtml } = await import("./stats-overlay");
    const { OVERLAY_VISIBILITY_DEFAULT } = await import("./store");
    const vis = OVERLAY_VISIBILITY_DEFAULT;

    const ranked = overlayPreviewHtml(payload("ranked", vis));
    const unranked = overlayPreviewHtml(payload("unranked", vis));
    const direct = overlayPreviewHtml(payload("direct", vis));

    expect(ranked).toContain("Set Count:");
    expect(unranked).toContain("Games:");
    expect(direct).toContain("Games:");
  });

  it("keeps the opponent's identity and rank on the line in every mode", async () => {
    const { overlayPreviewHtml } = await import("./stats-overlay");
    const { OVERLAY_VISIBILITY_DEFAULT } = await import("./store");

    for (const mode of ["ranked", "unranked", "direct"] as const) {
      const html = overlayPreviewHtml(payload(mode, OVERLAY_VISIBILITY_DEFAULT));
      expect(html).toContain("Fudgesicle");   // tag
      expect(html).toContain("FUDG#228");     // connect code
      expect(html).toContain("Diamond 2");    // rank tier
      expect(html).toContain("2050.6");       // opponent Rating
    }
  });
});
