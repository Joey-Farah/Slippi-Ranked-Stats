import { describe, it, expect } from "vitest";
import { scrollAffordance } from "./tab-scroll";

// The chevrons are the ONLY signal that clipped tabs exist at all, so a false
// negative here hides the Notes tab exactly the way the plain flex row did.
describe("scrollAffordance", () => {
  it("shows neither chevron when every tab already fits", () => {
    expect(scrollAffordance(0, 800, 800)).toEqual({ left: false, right: false });
  });

  it("shows only the right chevron when parked at the start of an overflowing strip", () => {
    expect(scrollAffordance(0, 1200, 800)).toEqual({ left: false, right: true });
  });

  it("shows only the left chevron when scrolled fully to the end", () => {
    expect(scrollAffordance(400, 1200, 800)).toEqual({ left: true, right: false });
  });

  it("shows both chevrons mid-strip", () => {
    expect(scrollAffordance(200, 1200, 800)).toEqual({ left: true, right: true });
  });

  // Browsers report fractional scrollWidth/clientWidth under zoom, and Ctrl +/- now
  // uses `zoom`, so this is the common case on Joey's machine rather than an edge one.
  it("treats a sub-pixel remainder as fully scrolled, not as more content", () => {
    expect(scrollAffordance(399.6, 1200.4, 800.5)).toEqual({ left: true, right: false });
  });

  it("treats a sub-pixel scrollLeft as still parked at the start", () => {
    expect(scrollAffordance(0.4, 1200, 800)).toEqual({ left: false, right: true });
  });

  // A one-pixel overflow is not worth a chevron; it is almost always a rounding artifact.
  it("ignores an overflow smaller than the tolerance", () => {
    expect(scrollAffordance(0, 800.8, 800)).toEqual({ left: false, right: false });
  });

  it("never reports a negative-space strip as scrollable", () => {
    expect(scrollAffordance(0, 0, 0)).toEqual({ left: false, right: false });
  });
});
