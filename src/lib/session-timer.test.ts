import { describe, it, expect } from "vitest";
import { elapsedMs, formatElapsed } from "./session-timer";

const AT = (iso: string) => Date.parse(iso);

describe("elapsedMs", () => {
  it("measures forward from the run start", () => {
    expect(elapsedMs("2026-08-05T18:00:00Z", AT("2026-08-05T18:00:30Z"))).toBe(30_000);
    expect(elapsedMs("2026-08-05T18:00:00Z", AT("2026-08-05T20:30:00Z"))).toBe(9_000_000);
  });

  it("floors at zero when the start is in the future", () => {
    // A clock adjustment mid-session, or a replay startAt slightly ahead of us. A counter
    // running backwards past 0:00 is a worse answer than 0:00.
    expect(elapsedMs("2026-08-05T18:00:10Z", AT("2026-08-05T18:00:00Z"))).toBe(0);
  });

  it("returns null for an unparseable timestamp rather than NaN", () => {
    expect(elapsedMs("", AT("2026-08-05T18:00:00Z"))).toBeNull();
    expect(elapsedMs("not a date", AT("2026-08-05T18:00:00Z"))).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("uses m:ss below an hour, with padded seconds and bare minutes", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(4_000)).toBe("0:04");
    expect(formatElapsed(64_000)).toBe("1:04");
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59:59");
  });

  it("switches to h:mm:ss at exactly one hour and pads the minutes there", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_600_000 + 4 * 60_000 + 7_000)).toBe("1:04:07");
    expect(formatElapsed(3_600_000 - 1_000)).toBe("59:59"); // one second short stays short-form
  });

  it("keeps counting past the point a long session gets silly", () => {
    expect(formatElapsed(12 * 3_600_000 + 34 * 60_000 + 56_000)).toBe("12:34:56");
    expect(formatElapsed(100 * 3_600_000)).toBe("100:00:00");
  });

  it("truncates rather than rounds, so the clock never shows a second early", () => {
    expect(formatElapsed(1_999)).toBe("0:01");
    expect(formatElapsed(3_599_999)).toBe("59:59");
  });

  it("treats negative input as zero", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});
