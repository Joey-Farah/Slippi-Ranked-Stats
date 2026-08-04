import { describe, it, expect } from "vitest";
import { leadMaintenanceDegree, comebackDegree } from "./slp_parser";

// Margin = yourStocks − oppStocks. Both players start at 4 and stocks are lost one at a time,
// so a margin path moves in steps of ±1 starting from 0.
//
// The parser derives the two lead inputs by walking that path; these helpers replicate that walk
// so the tests are written in terms of what actually happened in a game rather than in terms of
// pre-computed numbers. That matters here specifically: the original bug, and my first attempt at
// fixing it, were both cases of feeding this formula a quantity that didn't mean what it looked
// like it meant.
// Paths are [yourStocks, oppStocks] pairs — the real quantity the parser walks — rather than
// bare margins, because the `oppAlive` gate can't be expressed in margins alone. Taking an
// opponent's last stock produces a positive margin but is winning, not going ahead.
type StockPath = [number, number][];

function leadInputs(path: StockPath): { givenBack: number; low: number; everUp: boolean } {
  let everUp = false;
  let peak = -Infinity;
  let givenBack = 0;
  let low = 0;
  for (const [mine, theirs] of path) {
    const margin = mine - theirs;
    const oppAlive = theirs > 0;
    if (margin > 0 && oppAlive) everUp = true;
    if (!everUp || !oppAlive) continue;
    if (margin > peak) peak = margin;
    const drawdown = peak - margin;
    if (drawdown > givenBack) { givenBack = drawdown; low = margin; }
  }
  return { givenBack, low, everUp };
}

/** null mirrors the parser emitting null when you never held a lead — the stat is dropped from
 *  the category rather than scored as zero. */
function lead(path: StockPath, won = true): number | null {
  const { givenBack, low, everUp } = leadInputs(path);
  return everUp ? leadMaintenanceDegree(givenBack, low, won) : null;
}

/** A clean run of stock losses, for readability: `race(4, 0)` = you 4, them 0. */
function toZero(mine: number, theirs: number): StockPath {
  const path: StockPath = [[4, 4]];
  for (let t = 3; t >= theirs; t--) path.push([4, t]);
  for (let m = 3; m >= mine; m--) path.push([m, theirs]);
  return path;
}

describe("leadMaintenanceDegree", () => {
  // The bug this fix exists for. A flawless win drives the peak to +4, and the old formula
  // docked by the peak alone: 0.70 − 0.04×3 = 0.58, a B. It was also the stat's ceiling, since
  // never dipping is the only way to keep the trough at its best value.
  it("gives a flawless win a perfect score", () => {
    expect(lead(toZero(4, 0))).toBe(1);
  });

  // The case Joey caught: trailed the entire game, then closed it out. Going ahead by taking
  // their last stock isn't a lead — there was never one to maintain, so the stat is dropped.
  // Before the oppAlive gate this scored a free 100, and since the other two games of that set
  // were null it made a 1–2 SET LOSS average out to 100.
  it("returns null when the only 'lead' was the winning stock itself", () => {
    const trailedThenWon: StockPath = [
      [4, 4], [3, 4], [2, 4], [1, 4], // down to 1-4
      [1, 3], [1, 2], [1, 1], [1, 0], // ran their four stocks
    ];
    expect(lead(trailedThenWon)).toBeNull();
  });

  it("gives a perfect score whenever no part of a real lead was surrendered", () => {
    expect(lead(toZero(4, 0))).toBe(1);
    expect(lead(toZero(2, 0))).toBe(1);
  });

  // The heart of it: a bigger lead that was never given back cannot score worse than a small one.
  it("does not penalise the size of a lead that was never given back", () => {
    expect(lead(toZero(4, 0))).toBe(lead(toZero(1, 0)));
  });

  it("scores handing back a bigger lead worse than a smaller one, holding the end fixed", () => {
    // Up +3 (4-1), given all the way back to even (1-1).
    const gaveBackThree = lead([[4, 4], [4, 3], [4, 2], [4, 1], [3, 1], [2, 1], [1, 1], [1, 0]]);
    // Up +1 (4-3), given back to even (3-3).
    const gaveBackOne = lead([[4, 4], [4, 3], [3, 3], [3, 2], [3, 1], [3, 0]]);
    expect(gaveBackThree!).toBeLessThan(gaveBackOne!);
    expect(gaveBackOne).toBeCloseTo(0.45, 5); // leadCbPos(0); the first stock back isn't nudged
    expect(gaveBackThree).toBeCloseTo(0.45 - 0.04 * 2, 5);
  });

  it("scores blowing a real lead and losing at zero", () => {
    // Up +1 (4-3), then taken all the way down and three-stocked.
    const blown: StockPath = [[4, 4], [4, 3], [3, 3], [2, 3], [1, 3], [0, 3]];
    expect(lead(blown, false)).toBe(0);
  });

  it("scores a partially blown lead above one blown completely", () => {
    // Up +1 (4-3) and taken to −1 (2-3), but survived to win.
    const dipped: StockPath = [[4, 4], [4, 3], [3, 3], [2, 3], [2, 2], [2, 1], [2, 0]];
    expect(lead(dipped)).toBeCloseTo(0.30 - 0.04, 5);
  });

  // A deficit suffered BEFORE the first lead belongs to comeback; it must not be charged here.
  it("ignores a deficit that preceded the first lead", () => {
    const downThenAhead: StockPath = [[4, 4], [3, 4], [2, 4], [2, 3], [2, 2], [2, 1], [2, 0]];
    expect(lead(downThenAhead)).toBe(1);
  });

  it("measures the worst drawdown, not merely the final position", () => {
    // Up +2 (4-2), surrendered it back to even (2-2), then closed out 2-0.
    const surrendered: StockPath = [[4, 4], [4, 3], [4, 2], [3, 2], [2, 2], [2, 1], [2, 0]];
    expect(lead(surrendered)).toBeCloseTo(0.45 - 0.04, 5);
  });

  it("applies the loss multiplier", () => {
    const path: StockPath = [[4, 4], [4, 3], [4, 2], [4, 1], [3, 1], [2, 1], [1, 1], [0, 1]];
    expect(lead(path, false)!).toBeCloseTo(lead(path, true)! * 0.75, 5);
  });

  it("never leaves the 0–1 range", () => {
    for (let givenBack = 0; givenBack <= 8; givenBack++) {
      for (let low = -4; low <= 4; low++) {
        for (const won of [true, false]) {
          const v = leadMaintenanceDegree(givenBack, low, won);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// The exact mirror of leadInputs: best run-up from the running trough, only while you're alive.
function comebackInputs(path: StockPath): { clawedBack: number; high: number; everDown: boolean } {
  let everDown = false;
  let trough = Infinity;
  let clawedBack = 0;
  let high = 0;
  for (const [mine, theirs] of path) {
    const margin = mine - theirs;
    const alive = mine > 0;
    if (margin < 0 && alive) everDown = true;
    if (!everDown || !alive) continue;
    if (margin < trough) trough = margin;
    const runUp = margin - trough;
    if (runUp > clawedBack) { clawedBack = runUp; high = margin; }
  }
  return { clawedBack, high, everDown };
}

function comeback(path: StockPath, won = true): number | null {
  const { clawedBack, high, everDown } = comebackInputs(path);
  return everDown ? comebackDegree(clawedBack, high, won) : null;
}

describe("comebackDegree", () => {
  it("rewards a full comeback from a deep deficit", () => {
    // Down to 1-4, then took all four of theirs — a 4-stock swing finishing at +1.
    const path: StockPath = [[4, 4], [3, 4], [2, 4], [1, 4], [1, 3], [1, 2], [1, 1], [1, 0]];
    expect(comeback(path)).toBeCloseTo(0.70 + 0.04 * 3, 5); // leadCbPos(1), lifted by the swing
  });

  it("saturates when the comeback finishes comfortably ahead", () => {
    // Down to 2-4, then closed out 2-0 — finishing at +2 tops the curve.
    const path: StockPath = [[4, 4], [3, 4], [2, 4], [2, 3], [2, 2], [2, 1], [2, 0]];
    expect(comeback(path)).toBe(1);
  });

  it("rates clawing back to even as middling", () => {
    // Down 3-4, back to 3-3, then lost.
    const path: StockPath = [[4, 4], [3, 4], [3, 3], [2, 3], [1, 3], [0, 3]];
    expect(comeback(path, false)).toBeCloseTo(0.45 * 0.75, 5);
  });

  // The bug this fix exists for: the old formula floored the base at leadCbPos(-1) = 0.30 and
  // then ADDED depth credit for a hole you never climbed out of, so being 4-stocked (31.5) beat
  // going down one and never recovering (22.5). Recovering nothing is now simply 0.
  it("scores never recovering any of the deficit at zero", () => {
    // Getting four-stocked is the only shape where nothing at all is recovered: taking any of
    // their stocks IS a recovery, so every other losing path has a non-zero run-up.
    const fourStocked: StockPath = [[4, 4], [3, 4], [2, 4], [1, 4], [0, 4]];
    expect(comeback(fourStocked, false)).toBe(0);
  });

  it("scores a token recovery just above zero, not below a blowout", () => {
    // Down 1-4, took one of theirs, then lost. Under the old formula the blowout above scored
    // 31.5 and this scored less — depth credit was being handed out for a hole never climbed.
    const tookOne: StockPath = [[4, 4], [3, 4], [2, 4], [1, 4], [1, 3], [0, 3]];
    const fourStocked: StockPath = [[4, 4], [3, 4], [2, 4], [1, 4], [0, 4]];
    expect(comeback(tookOne, false)).toBeCloseTo(0.13 * 0.75, 5);
    expect(comeback(tookOne, false)!).toBeGreaterThan(comeback(fourStocked, false)!);
  });

  it("credits a deeper deficit climbed out of, holding the end fixed", () => {
    const fromThree: StockPath = [[4, 4], [3, 4], [2, 4], [1, 4], [1, 3], [1, 2], [1, 1], [0, 1]];
    const fromOne: StockPath = [[4, 4], [3, 4], [3, 3], [2, 3], [1, 3], [0, 3]];
    expect(comeback(fromThree, false)!).toBeGreaterThan(comeback(fromOne, false)!);
  });

  it("returns null when you were never behind", () => {
    expect(comeback(toZero(4, 0))).toBeNull();
  });

  it("applies the loss multiplier", () => {
    const path: StockPath = [[4, 4], [3, 4], [3, 3], [3, 2], [3, 1], [3, 0]];
    expect(comeback(path, false)!).toBeCloseTo(comeback(path, true)! * 0.75, 5);
  });

  it("never leaves the 0–1 range", () => {
    for (let clawedBack = 0; clawedBack <= 8; clawedBack++) {
      for (let high = -4; high <= 4; high++) {
        for (const won of [true, false]) {
          const v = comebackDegree(clawedBack, high, won);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// Lead and comeback are meant to be mirrors; this pins that they behave like it.
describe("lead / comeback symmetry", () => {
  it("gives a game with no swing in either direction the extreme of each scale", () => {
    const flawlessWin = toZero(4, 0);
    expect(lead(flawlessWin)).toBe(1); // kept everything
    expect(comeback(flawlessWin)).toBeNull(); // never behind, so not applicable

    const fourStocked: StockPath = [[4, 4], [3, 4], [2, 4], [1, 4], [0, 4]];
    expect(comeback(fourStocked, false)).toBe(0); // recovered nothing
    expect(lead(fourStocked, false)).toBeNull(); // never ahead, so not applicable
  });
});
