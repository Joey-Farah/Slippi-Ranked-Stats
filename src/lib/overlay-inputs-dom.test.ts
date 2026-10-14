// @vitest-environment happy-dom

/**
 * The input viewer, driven through the real page in a real DOM.
 *
 * ⚠ Why this file exists: the overlay page is a TypeScript template literal, so `tsc` and
 * `vite build` never read a line of its JavaScript, and the other overlay test can only check
 * the SOURCE TEXT of the render path. That is not the same as checking it renders. A defect
 * here is invisible until it is on someone's stream.
 *
 * What it pins is the promise we actually make: **the viewer appears whatever disc is booted.**
 * A box controller is read over its own USB serial, completely independently of Dolphin, so a
 * mod ISO, an unknown disc, or no game at all must never be able to blank it. That exact
 * failure shipped in v1.12.2 — `drawInputs` hid on the empty controller list that every
 * non-GALE01 disc produces, throwing away box data it already had.
 */

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

const DIGITAL_KEYS = [
  "start", "y", "x", "b", "a", "l", "r", "z", "up", "down", "right", "left",
  "mod_x", "mod_y", "c_left", "c_right", "c_up", "c_down", "ls", "ms",
] as const;

function boxFrame(pressed: string[] = []): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of DIGITAL_KEYS) out[k] = pressed.includes(k);
  return out;
}

/** The stand-in for the browser's EventSource, so the test can push frames at the page. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  /** Read the latest instance through a call, so TS does not narrow `last` to the `null` it
   *  was reset to - the page assigns it from inside `window.eval`, which TS cannot see. */
  static take(): FakeEventSource | null {
    return FakeEventSource.last;
  }
  close() {
    this.closed = true;
  }
  /** Deliver one SSE frame exactly as dolphin.rs serialises it. */
  send(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

/** Mount the real overlay page in this DOM and return handles to poke at it. */
async function mountOverlay(skin = "digital") {
  const { overlayPreviewHtml } = await import("./stats-overlay");
  const page = overlayPreviewHtml({
    show: { inputs: true },
    inputPort: 14524,
    inputSkin: skin,
    inputScale: 2.6,
  } as any);

  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length, "the page should carry an inline script").toBeGreaterThan(0);

  // Install the DOM first, then run the script against it - the script resolves its elements
  // at top level, exactly as it does in OBS.
  document.documentElement.innerHTML = page.replace(/<script>[\s\S]*?<\/script>/g, "");

  (window as any).EventSource = FakeEventSource;
  FakeEventSource.last = null;
  // Classic-script semantics: top-level `var`s become globals, which is how the page's own
  // functions find each other.
  for (const body of scripts) (window as any).eval(body);

  const inputsEl = document.getElementById("inputs")!;
  expect(inputsEl, "the page should have an #inputs host").toBeTruthy();
  const src = FakeEventSource.take();
  expect(src, "the page should have opened an input stream").toBeTruthy();
  return { inputsEl, src: src! };
}

/** How many buttons are currently lit. */
function litCount(inputsEl: Element): number {
  return inputsEl.querySelectorAll(".on").length;
}

describe("input viewer in a real DOM", () => {
  // The whole point: the disc must not matter. GTME01 is the real mod ISO this was found on.
  const DISCS = ["GALE01", "GTME01", "GALJ01", "", "ZZZZ99"];

  for (const disc of DISCS) {
    it(`appears and lights up on disc "${disc || "(none)"}" with only box data`, async () => {
      const { inputsEl, src } = await mountOverlay("digital");

      // Exactly what dolphin.rs sends for a disc it will not read: no controllers at all.
      src.send({
        game_id: disc,
        controllers: [],
        digital: boxFrame(["y", "l", "left", "mod_x"]),
      });

      expect(
        (inputsEl as HTMLElement).hidden,
        `the viewer must not hide on "${disc}" - the box is read over USB, not from the game`
      ).toBe(false);
      expect(litCount(inputsEl), "the pressed buttons should be lit").toBe(4);
    });
  }

  it("lights the exact buttons the box reports, and no others", async () => {
    const { inputsEl, src } = await mountOverlay("digital");
    src.send({ game_id: "GTME01", controllers: [], digital: boxFrame(["a", "z"]) });
    expect(litCount(inputsEl)).toBe(2);

    src.send({ game_id: "GTME01", controllers: [], digital: boxFrame([]) });
    expect(litCount(inputsEl), "releasing everything should clear the viewer").toBe(0);
  });

  it("reports a modifier pressed on its own", async () => {
    // Unrepresentable from memory at any threshold - the stick never leaves neutral. This is
    // the reason the USB path exists, so it gets its own guard.
    const { inputsEl, src } = await mountOverlay("digital");
    src.send({ game_id: "GTME01", controllers: [], digital: boxFrame(["mod_x"]) });
    expect(litCount(inputsEl)).toBe(1);
  });

  it("stays visible on the analog skin when there is nothing to read", async () => {
    // It cannot show stick positions without the memory read, but vanishing is worse: the
    // overlay reflows and everything below it jumps mid-stream.
    const { inputsEl, src } = await mountOverlay("controller");
    src.send({ game_id: "GTME01", controllers: [], digital: boxFrame() });
    expect((inputsEl as HTMLElement).hidden).toBe(false);
  });

  it("still renders a real controller from memory when one is present", async () => {
    // The GALE01 path must not regress while fixing the others.
    const { inputsEl, src } = await mountOverlay("controller");
    src.send({
      game_id: "GALE01",
      controllers: [
        {
          port: 0, buttons: 0x0100, joy_x: -0.65, joy_y: -0.15,
          c_x: 0, c_y: 0, trigger_l: 1, trigger_r: 0, plugged: 0,
        },
      ],
    });
    expect((inputsEl as HTMLElement).hidden).toBe(false);
    expect(litCount(inputsEl), "A is held in this frame").toBeGreaterThan(0);
  });

  it("does not render at all when the toggle is off", async () => {
    const { overlayPreviewHtml } = await import("./stats-overlay");
    const page = overlayPreviewHtml({ show: { inputs: false }, inputPort: 14524 } as any);
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    document.documentElement.innerHTML = page.replace(/<script>[\s\S]*?<\/script>/g, "");
    (window as any).EventSource = FakeEventSource;
    FakeEventSource.last = null;
    for (const body of scripts) (window as any).eval(body);

    expect(FakeEventSource.take(), "no stream should be opened when inputs are hidden").toBeNull();
    expect((document.getElementById("inputs") as HTMLElement).hidden).toBe(true);
  });
});
