import { describe, it, expect } from "vitest";
import { Stage } from "@slippi/slippi-js";
import { STAGES } from "./parser";

// The stage table is a hand-written mirror of Slippi's external stage IDs, and it was wrong
// for every non-tournament-legal stage until v1.8.14 (e.g. id 24 read "Mushroom Kingdom II"
// when it is really Big Blue). Nothing caught it because ranked and unranked only ever produce
// the six legal stages — direct connect is what made the rest reachable. This pins the table
// to slippi-js's own enum so it can't drift again.

/** slippi-js enum member name -> the display name this app uses. */
const EXPECTED_NAME: Record<string, string> = {
  FOUNTAIN_OF_DREAMS: "Fountain of Dreams",
  POKEMON_STADIUM: "Pokémon Stadium",
  PEACHS_CASTLE: "Peach's Castle",
  KONGO_JUNGLE: "Kongo Jungle",
  BRINSTAR: "Brinstar",
  CORNERIA: "Corneria",
  YOSHIS_STORY: "Yoshi's Story",
  ONETT: "Onett",
  MUTE_CITY: "Mute City",
  RAINBOW_CRUISE: "Rainbow Cruise",
  JUNGLE_JAPES: "Jungle Japes",
  GREAT_BAY: "Great Bay",
  HYRULE_TEMPLE: "Hyrule Temple",
  BRINSTAR_DEPTHS: "Brinstar Depths",
  YOSHIS_ISLAND: "Yoshi's Island",
  GREEN_GREENS: "Green Greens",
  FOURSIDE: "Fourside",
  MUSHROOM_KINGDOM: "Mushroom Kingdom",
  MUSHROOM_KINGDOM_2: "Mushroom Kingdom II",
  VENOM: "Venom",
  POKE_FLOATS: "Poké Floats",
  BIG_BLUE: "Big Blue",
  ICICLE_MOUNTAIN: "Icicle Mountain",
  ICETOP: "Icetop",
  FLAT_ZONE: "Flat Zone",
  DREAMLAND: "Dream Land N64",
  YOSHIS_ISLAND_N64: "Yoshi's Island N64",
  KONGO_JUNGLE_N64: "Kongo Jungle N64",
  BATTLEFIELD: "Battlefield",
  FINAL_DESTINATION: "Final Destination",
};

describe("STAGES", () => {
  it("maps every real stage id to the name slippi-js gives it", () => {
    for (const [member, name] of Object.entries(EXPECTED_NAME)) {
      const id = Stage[member as keyof typeof Stage] as unknown as number;
      expect(typeof id, `${member} missing from slippi-js Stage enum`).toBe("number");
      expect(STAGES[id], `stage id ${id} (${member})`).toBe(name);
    }
  });

  it("covers all six tournament-legal stages", () => {
    // The set that ranked and unranked actually use — a regression here is user-visible
    // on almost every game, unlike the rest of the table.
    expect(STAGES[Stage.FOUNTAIN_OF_DREAMS]).toBe("Fountain of Dreams");
    expect(STAGES[Stage.POKEMON_STADIUM]).toBe("Pokémon Stadium");
    expect(STAGES[Stage.YOSHIS_STORY]).toBe("Yoshi's Story");
    expect(STAGES[Stage.DREAMLAND]).toBe("Dream Land N64");
    expect(STAGES[Stage.BATTLEFIELD]).toBe("Battlefield");
    expect(STAGES[Stage.FINAL_DESTINATION]).toBe("Final Destination");
  });

  it("has no entries slippi-js doesn't know about", () => {
    const known = new Set(
      Object.values(Stage).filter((v): v is number => typeof v === "number")
    );
    for (const id of Object.keys(STAGES).map(Number)) {
      expect(known.has(id), `STAGES has unknown stage id ${id}`).toBe(true);
    }
  });
});
