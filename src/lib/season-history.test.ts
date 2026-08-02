import { describe, it, expect } from "vitest";
import { previousSeason, type SeasonData } from "./api";
import { getRankTier } from "./parser";

// Shapes below mirror real `rankedNetplayProfileHistory` responses captured from
// internal.slippi.gg while building this feature — same field names, same ordering
// (newest first), same "placement is only present for the top ~300" behaviour.

function season(
  name: string,
  end: string,
  rating: number,
  wins = 0,
  losses = 0,
  global_rank = 0
): SeasonData {
  return {
    season_id: name.toLowerCase().replace(/\s+/g, "-"),
    season_name: name,
    season_start: "",
    season_end: end,
    rating,
    wins,
    losses,
    global_rank,
  };
}

const S4 = season("Season 4", "2026-04-20T17:07:46.817Z", 2600.58, 137, 17, 37);
const S3 = season("Season 3", "2025-10-20T13:38:56.629Z", 2597.07, 181, 34, 34);
const S2 = season("Season 2", "2025-04-21T14:17:57.718Z", 2680.39, 295, 49, 16);

describe("previousSeason", () => {
  it("returns the most recently completed season", () => {
    expect(previousSeason([S4, S3, S2])?.season_name).toBe("Season 4");
  });

  it("does not depend on the order the API returned", () => {
    expect(previousSeason([S2, S4, S3])?.season_name).toBe("Season 4");
    expect(previousSeason([S3, S2, S4])?.season_name).toBe("Season 4");
  });

  it("returns null for a profile with no season history", () => {
    expect(previousSeason([])).toBeNull();
  });

  // The API puts the season in progress on `rankedNetplayProfile`, not in the history, so this
  // shouldn't arise — but if it ever started appearing there we must not label it "last season".
  it("skips a season that hasn't ended yet", () => {
    const inProgress = season("Season 5", "2099-01-01T00:00:00.000Z", 2500);
    expect(previousSeason([inProgress, S4])?.season_name).toBe("Season 4");
  });

  it("ignores entries with an unusable end date", () => {
    const malformed = season("Mystery Season", "", 2500);
    expect(previousSeason([malformed, S4])?.season_name).toBe("Season 4");
    expect(previousSeason([malformed])).toBeNull();
  });

  // Slippi's history omits seasons a player didn't play. A returning player's "last season" can
  // therefore be several seasons back, which is exactly why the UI prints the season name rather
  // than calling it "last season" — verified against a real lapsed profile whose newest history
  // entry was Season 2 while Season 4 was the most recent season overall.
  it("handles a lapsed player whose history skips recent seasons", () => {
    const prev = previousSeason([S2, season("Season 1", "2024-10-14T15:30:33.823Z", 2275.1)]);
    expect(prev?.season_name).toBe("Season 2");
  });
});

describe("past-season rank", () => {
  // A global placement is only reported for roughly the top 300, in past seasons exactly as in
  // the current one, so it doubles as the Grandmaster flag. Every historical placement observed
  // across a sample of real profiles was <= 300; everyone outside it returned none at all.
  it("resolves Grandmaster when the season ended with a placement", () => {
    const prev = previousSeason([S4])!;
    expect(getRankTier(prev.rating, prev.global_rank > 0).name).toBe("Grandmaster");
  });

  it("stays in the Master range when the season ended without a placement", () => {
    // Same rating, no leaderboard placement — must not be promoted to Grandmaster.
    const noPlacement = season("Season 4", S4.season_end, 2600.58, 137, 17, 0);
    expect(getRankTier(noPlacement.rating, noPlacement.global_rank > 0).name).toBe("Master III");
  });

  it("maps a mid-ladder past season to its real tier", () => {
    // Real capture: a player who finished Season 4 at 1804.8 with no placement.
    const mid = season("Season 4", S4.season_end, 1804.8, 98, 98, 0);
    expect(getRankTier(mid.rating, mid.global_rank > 0).name).toBe("Platinum I");
  });
});
