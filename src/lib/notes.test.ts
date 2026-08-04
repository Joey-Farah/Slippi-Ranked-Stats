import { describe, it, expect, beforeAll } from "vitest";
import type { NoteRow } from "./db";

// See live-record.test.ts — notes.ts pulls in store.ts, which touches localStorage at module
// load, and vitest runs in the node environment where it doesn't exist.
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

// notes.ts must not be imported until the stub above is installed, and describe() bodies run
// at collection time — before beforeAll — so fixtures use the literal "" wildcard rather than
// reading ANY_CHAR off the module. (ANY_CHAR === "" is asserted in its own test.)
let N: typeof import("./notes");
beforeAll(async () => {
  N = await import("./notes");
});

let nextId = 1;
function note(over: Partial<NoteRow> = {}): NoteRow {
  const t = over.updated_at ?? "2026-08-01T12:00:00.000Z";
  return {
    id: over.id ?? nextId++,
    kind: "opponent",
    opponent_code: "",
    opponent_tag: "",
    player_char: "",
    opponent_char: "",
    body: "note body",
    pinned: 0,
    created_at: t,
    updated_at: t,
    ...over,
  };
}

function opp(code: string, over: Partial<NoteRow> = {}): NoteRow {
  return note({ kind: "opponent", opponent_code: code, ...over });
}

function matchup(playerChar: string, opponentChar: string, over: Partial<NoteRow> = {}): NoteRow {
  return note({ kind: "matchup", player_char: playerChar, opponent_char: opponentChar, ...over });
}

describe("opponent matching", () => {
  it("matches the same connect code regardless of case or surrounding space", () => {
    const n = opp("FOX#123");
    expect(N.matchesOpponent(n, "FOX#123")).toBe(true);
    expect(N.matchesOpponent(n, "fox#123")).toBe(true);
    expect(N.matchesOpponent(n, "  Fox#123 ")).toBe(true);
  });

  it("does not match a different player", () => {
    expect(N.matchesOpponent(opp("FOX#123"), "FOX#124")).toBe(false);
  });

  // Both sides guard against '': a matchup note has an empty opponent_code, and an unknown
  // opponent must not pull in every note that also happens to have one.
  it("never matches on an empty code from either side", () => {
    expect(N.matchesOpponent(opp(""), "")).toBe(false);
    expect(N.matchesOpponent(opp("FOX#123"), "")).toBe(false);
    expect(N.matchesOpponent(matchup("Fox", "Marth"), "")).toBe(false);
  });

  it("ignores matchup notes", () => {
    const n = matchup("Fox", "Marth", { opponent_code: "FOX#123" });
    expect(N.matchesOpponent(n, "FOX#123")).toBe(false);
  });
});

describe("matchup matching", () => {
  it("matches the exact pairing", () => {
    expect(N.matchesMatchup(matchup("Fox", "Marth"), "Fox", "Marth")).toBe(true);
  });

  // The whole reason matchup notes are keyed on a *pair* and not just the opposing character.
  it("is directional — Fox vs Marth is not Marth vs Fox", () => {
    expect(N.matchesMatchup(matchup("Fox", "Marth"), "Marth", "Fox")).toBe(false);
  });

  it("does not match when your character differs", () => {
    expect(N.matchesMatchup(matchup("Fox", "Marth"), "Falco", "Marth")).toBe(false);
  });

  it("exposes the wildcard as the empty string", () => {
    expect(N.ANY_CHAR).toBe("");
  });

  it("treats an empty player_char as a wildcard over your side", () => {
    const n = matchup("", "Marth");
    expect(N.matchesMatchup(n, "Fox", "Marth")).toBe(true);
    expect(N.matchesMatchup(n, "Falco", "Marth")).toBe(true);
    expect(N.matchesMatchup(n, "", "Marth")).toBe(true);
    // Still keyed on their character, wildcard or not.
    expect(N.matchesMatchup(n, "Fox", "Falco")).toBe(false);
  });

  // Showing "your Fox notes" when we can't confirm you're on Fox is worse than showing nothing.
  it("does not apply a character-specific note when your character is unknown", () => {
    expect(N.matchesMatchup(matchup("Fox", "Marth"), "", "Marth")).toBe(false);
  });

  it("never matches when their character is unknown", () => {
    expect(N.matchesMatchup(matchup("Fox", "Marth"), "Fox", "")).toBe(false);
    expect(N.matchesMatchup(matchup("", "Marth"), "Fox", "")).toBe(false);
  });

  it("ignores opponent notes", () => {
    expect(N.matchesMatchup(opp("FOX#123"), "Fox", "Marth")).toBe(false);
  });
});

describe("sortNotes", () => {
  it("puts pinned notes first, then the most recently edited", () => {
    const old = opp("A#1", { id: 1, updated_at: "2026-01-01T00:00:00.000Z" });
    const recent = opp("A#1", { id: 2, updated_at: "2026-08-01T00:00:00.000Z" });
    const pinnedOld = opp("A#1", { id: 3, updated_at: "2025-01-01T00:00:00.000Z", pinned: 1 });
    expect(N.sortNotes([old, recent, pinnedOld]).map((n) => n.id)).toEqual([3, 2, 1]);
  });

  it("breaks a same-timestamp tie by newest id and does not mutate its input", () => {
    const t = "2026-08-01T00:00:00.000Z";
    const input = [opp("A#1", { id: 5, updated_at: t }), opp("A#1", { id: 9, updated_at: t })];
    expect(N.sortNotes(input).map((n) => n.id)).toEqual([9, 5]);
    expect(input.map((n) => n.id)).toEqual([5, 9]);
  });
});

describe("notesForContext", () => {
  const all = [
    opp("FOX#123", { id: 1, body: "techs in place" }),
    opp("OTHER#99", { id: 2, body: "not this one" }),
    matchup("Fox", "Marth", { id: 3, body: "camp the ledge" }),
    matchup("", "Marth", { id: 4, body: "he over-commits with fair" }),
    matchup("Fox", "Falco", { id: 5, body: "different matchup" }),
  ];

  it("returns both kinds for the live opponent, and nothing that doesn't apply", () => {
    const got = N.notesForContext(all, {
      opponentCode: "fox#123",
      playerChar: "Fox",
      opponentChar: "Marth",
    });
    expect(got.opponent.map((n) => n.id)).toEqual([1]);
    expect(got.matchup.map((n) => n.id).sort()).toEqual([3, 4]);
  });

  // The window between the header peek and the profile fetch: we know who, not always as what.
  it("still returns the opponent's notes when characters are unknown", () => {
    const got = N.notesForContext(all, { opponentCode: "FOX#123", playerChar: "", opponentChar: "" });
    expect(got.opponent.map((n) => n.id)).toEqual([1]);
    expect(got.matchup).toEqual([]);
  });

  it("returns empty lists for someone with nothing written about them", () => {
    const got = N.notesForContext(all, {
      opponentCode: "NEW#1",
      playerChar: "Jigglypuff",
      opponentChar: "Peach",
    });
    expect(got).toEqual({ opponent: [], matchup: [] });
  });
});

describe("groupNotes", () => {
  it("groups by subject and keeps matchup directions apart", () => {
    const groups = N.groupNotes([
      opp("FOX#123", { id: 1 }),
      opp("fox#123", { id: 2 }), // same person, typed differently
      matchup("Fox", "Marth", { id: 3 }),
      matchup("Marth", "Fox", { id: 4 }),
    ]);
    expect(groups).toHaveLength(3);
    const oppGroup = groups.find((g) => g.kind === "opponent")!;
    expect(oppGroup.notes.map((n) => n.id).sort()).toEqual([1, 2]);
    expect(oppGroup.subtitle).toBe("FOX#123");
    expect(groups.filter((g) => g.kind === "matchup").map((g) => g.title).sort()).toEqual([
      "Fox vs Marth",
      "Marth vs Fox",
    ]);
  });

  it("titles a player by their newest known tag, falling back to the code", () => {
    const groups = N.groupNotes([
      opp("FOX#123", { id: 1, opponent_tag: "OldName", updated_at: "2026-01-01T00:00:00.000Z" }),
      opp("FOX#123", { id: 2, opponent_tag: "NewName", updated_at: "2026-08-01T00:00:00.000Z" }),
      opp("BAR#7", { id: 3 }),
    ]);
    expect(groups.find((g) => g.subtitle === "FOX#123")!.title).toBe("NewName");
    expect(groups.find((g) => g.subtitle === "BAR#7")!.title).toBe("BAR#7");
  });

  it("orders groups by their most recent note", () => {
    const groups = N.groupNotes([
      opp("STALE#1", { id: 1, updated_at: "2026-01-01T00:00:00.000Z" }),
      opp("FRESH#1", { id: 2, updated_at: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(groups.map((g) => g.subtitle)).toEqual(["FRESH#1", "STALE#1"]);
  });

  it("labels a wildcard matchup group by the opposing character alone", () => {
    const [group] = N.groupNotes([matchup("", "Marth")]);
    expect(group.title).toBe("Any character vs Marth");
  });
});

describe("preferredTag", () => {
  it("prefers the live tag when there is one", () => {
    expect(N.preferredTag("LiveName", [opp("FOX#123", { opponent_tag: "FiledName" })])).toBe("LiveName");
  });

  // After a set ends there's no live profile to read a tag from, but the notes remember one.
  it("falls back to the name their notes were filed under", () => {
    expect(N.preferredTag("", [opp("FOX#123", { opponent_tag: "FiledName" })])).toBe("FiledName");
  });

  it("skips notes with no tag rather than returning an empty one", () => {
    const list = [opp("FOX#123", { opponent_tag: "" }), opp("FOX#123", { opponent_tag: "FiledName" })];
    expect(N.preferredTag("", list)).toBe("FiledName");
  });

  it("returns empty when nothing knows their name", () => {
    expect(N.preferredTag("", [])).toBe("");
  });
});

describe("liveNoteSubject", () => {
  /** Read a derived store's current value without leaving a live subscription behind. */
  function read<T>(store: { subscribe: (fn: (v: T) => void) => () => void }): T {
    let value!: T;
    store.subscribe((v) => (value = v))();
    return value;
  }

  function liveGame(over: Record<string, unknown> = {}) {
    return {
      match_id: "m1", match_type: "ranked", result: "win",
      kills: 2, deaths: 1,
      openings_per_kill: null, damage_per_opening: null, neutral_win_ratio: null,
      counter_hit_rate: null, inputs_per_minute: null, l_cancel_ratio: null,
      avg_kill_percent: null, avg_death_percent: null, defensive_option_rate: null,
      opening_conversion_rate: null, stage_control_ratio: null, lead_maintenance_rate: null,
      tech_chase_rate: null, edgeguard_success_rate: null, hit_advantage_rate: null,
      recovery_success_rate: null, avg_stock_duration: null, respawn_defense_rate: null,
      comeback_rate: null, wavedash_miss_rate: null,
      duration_frames: 7200, stage_id: 31,
      player_char_id: 1,   // Fox
      opponent_char_id: 18, // Marth
      opponent_code: "OPP#123",
      timestamp: "2026-08-03T20:00:00Z",
      ...over,
    };
  }

  it("uses the live opponent while a set is running", async () => {
    const { activeSet, liveGameStats } = await import("./store");
    liveGameStats.set([]);
    activeSet.set({
      match_id: "m1", mode: "ranked", opponent_code: "OPP#123",
      opponent_char_id: 18, player_char_id: 1,
      games_won: 1, games_lost: 0, started_at: "2026-08-03T20:00:00Z",
      opponent_rating: 1800, opponent_tier: "Master I", opponent_tier_color: "#fff",
      opponent_tag: "Sample", opponent_season_wins: 10, opponent_season_losses: 5,
      opponent_prev_season: null, opponent_chars: null,
      all_time_wins: 0, all_time_losses: 0, all_time_unit: "sets",
      session_already_faced: false,
    } as any);
    expect(read(N.liveNoteSubject)).toEqual({
      opponentCode: "OPP#123",
      playerChar: "Fox",
      opponentChar: "Marth",
      tag: "Sample",
      live: true,
    });
  });

  // The whole reason the panel isn't gated on activeSet: a ranked set clears it at first-to-2,
  // and right after a set is when you actually want to write the note.
  it("falls back to the last game of the session once the set ends", async () => {
    const { activeSet, liveGameStats } = await import("./store");
    activeSet.set(null);
    liveGameStats.set([liveGame(), liveGame({ opponent_code: "LATER#9" })] as any);
    const subject = read(N.liveNoteSubject);
    expect(subject?.opponentCode).toBe("LATER#9");
    expect(subject?.live).toBe(false);
    expect(subject?.playerChar).toBe("Fox");
    expect(subject?.opponentChar).toBe("Marth");
  });

  it("is null when nothing has been played this session", async () => {
    const { activeSet, liveGameStats } = await import("./store");
    activeSet.set(null);
    liveGameStats.set([]);
    expect(read(N.liveNoteSubject)).toBeNull();
  });

  it("leaves characters blank when the header peek hasn't identified them", async () => {
    const { activeSet, liveGameStats } = await import("./store");
    liveGameStats.set([]);
    activeSet.set({
      match_id: "m2", mode: "ranked", opponent_code: "OPP#123",
      opponent_char_id: -1, player_char_id: -1,
      games_won: 0, games_lost: 0, started_at: "2026-08-03T20:00:00Z",
      opponent_rating: null, opponent_tier: null, opponent_tier_color: null,
      opponent_tag: null, opponent_season_wins: null, opponent_season_losses: null,
      opponent_prev_season: null, opponent_chars: null,
      all_time_wins: 0, all_time_losses: 0, all_time_unit: "sets",
      session_already_faced: false,
    } as any);
    const subject = read(N.liveNoteSubject);
    expect(subject?.playerChar).toBe("");
    expect(subject?.opponentChar).toBe("");
    expect(subject?.tag).toBe("");
  });
});

describe("searchNotes", () => {
  const all = [
    opp("FOX#123", { id: 1, opponent_tag: "Sample", body: "techs in place" }),
    matchup("Fox", "Marth", { id: 2, body: "camp the ledge" }),
  ];

  it("finds notes by body, tag, code or character", () => {
    expect(N.searchNotes(all, "techs").map((n) => n.id)).toEqual([1]);
    expect(N.searchNotes(all, "sample").map((n) => n.id)).toEqual([1]);
    expect(N.searchNotes(all, "fox#12").map((n) => n.id)).toEqual([1]);
    expect(N.searchNotes(all, "marth").map((n) => n.id)).toEqual([2]);
  });

  it("returns everything for an empty query", () => {
    expect(N.searchNotes(all, "   ")).toHaveLength(2);
  });
});
