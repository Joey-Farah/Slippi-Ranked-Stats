import { describe, it, expect } from "vitest";
import { indexByBasename, basename, resolveReplayPath } from "./replay-index";

describe("basename", () => {
  it("handles both separators, including the mixed paths the scanner writes", () => {
    expect(basename("C:\\Slippi Replays/Recent/Game_1.slp")).toBe("Game_1.slp");
    expect(basename("C:\\Slippi Replays\\Archive\\Game_1.slp")).toBe("Game_1.slp");
    expect(basename("/home/me/replays/Game_1.slp")).toBe("Game_1.slp");
    expect(basename("Game_1.slp")).toBe("Game_1.slp");
  });
});

describe("indexByBasename", () => {
  it("maps basename to full path", () => {
    const i = indexByBasename([
      { name: "a.slp", path: "C:/R/Archive/a.slp" },
      { name: "b.slp", path: "C:/R/Archive/b.slp" },
    ]);
    expect(i.get("a.slp")).toBe("C:/R/Archive/a.slp");
    expect(i.size).toBe(2);
  });

  it("keeps the FIRST path when a basename appears twice", () => {
    // A half-finished move can leave the same replay in two folders. Either is the same
    // game; deterministic beats clever.
    const i = indexByBasename([
      { name: "a.slp", path: "C:/R/Recent/a.slp" },
      { name: "a.slp", path: "C:/R/Archive/a.slp" },
    ]);
    expect(i.get("a.slp")).toBe("C:/R/Recent/a.slp");
  });
});

describe("resolveReplayPath", () => {
  const index = indexByBasename([{ name: "Game_1.slp", path: "C:/R/Archive/Game_1.slp" }]);

  it("finds a replay that moved to another folder", () => {
    // The real case: stored under Recent/, actually under Slippi Replay Archive/.
    expect(resolveReplayPath("C:\\Slippi Replays/Recent/Game_1.slp", "Game_1.slp", index))
      .toBe("C:/R/Archive/Game_1.slp");
  });

  it("falls back to the stored path's basename when filename is absent", () => {
    expect(resolveReplayPath("C:/R/Recent/Game_1.slp", null, index)).toBe("C:/R/Archive/Game_1.slp");
  });

  it("returns null for a replay that is genuinely gone", () => {
    // Must stay null: recovering moved files is the goal, inventing a substitute is not.
    expect(resolveReplayPath("C:/R/Recent/Game_9.slp", "Game_9.slp", index)).toBeNull();
  });

  it("returns null when there is nothing to key on", () => {
    expect(resolveReplayPath(null, null, index)).toBeNull();
    expect(resolveReplayPath("", "", index)).toBeNull();
  });
});
