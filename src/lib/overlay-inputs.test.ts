/**
 * Regression tests for the overlay's input viewer.
 *
 * ⚠ The overlay page's JavaScript lives inside a TypeScript TEMPLATE LITERAL, so `tsc` and
 * `vite build` never look at it — a defect in there ships silently. These tests pull the real
 * shipped functions back out of the rendered page and exercise them, which is the only check
 * this code gets.
 *
 * What they pin (found live on 2026-10-11): the viewer stayed blank for the whole session on a
 * NON-VANILLA Melee build. `dolphin.rs` refuses to read its controller block for any disc that
 * isn't GALE01 — correct, the address table is 1.02-only — and returns `controllers: []`. But a
 * BOX controller reports every digital button over its own USB serial, independently of Dolphin,
 * so the digital skin needs nothing from memory. `drawInputs` hid on the empty list anyway and
 * threw that data away.
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

/** Slice a balanced `{...}` or `[...]` block that starts at `marker`. */
function block(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`marker not found in the rendered page: ${marker}`);
  const openIdx = start + marker.length - 1;
  const open = src[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced block for ${marker}`);
}

/** Pull the input-decoding half of the page out and evaluate it in isolation. */
async function renderPage(): Promise<string> {
  // Imported lazily so the localStorage stub above is in place first.
  const { overlayPreviewHtml } = await import("./stats-overlay");
  return overlayPreviewHtml({ show: {} } as any);
}

async function loadInputLogic(): Promise<{ pickPort: Function; digOn: Function; DIG: any[]; NEUTRAL: any }> {
  const page = await renderPage();

  const consts = [
    /var DIR_ON = [^\n]+/,
    /var MOD_LO = [^\n]+/,
    /var LS_LO = [^\n]+/,
    /var MS_LO = [^\n]+/,
    /var L_BIT = [^\n]+/,
  ].map((re) => {
    const m = page.match(re);
    if (!m) throw new Error(`constant not found in the rendered page: ${re}`);
    return m[0];
  });

  const src = [
    ...consts,
    block(page, "var DIG = ["),
    block(page, "function modded(c) {"),
    block(page, "function trig(c) {"),
    block(page, "function clicked(c) {"),
    block(page, "function digOn(d, c, dig) {"),
    block(page, "function pickPort(list) {"),
    block(page, "var NEUTRAL = {"),
    "return { pickPort: pickPort, digOn: digOn, DIG: DIG, NEUTRAL: NEUTRAL };",
  ].join("\n");

  return new Function(src)() as any;
}

const DIGITAL_KEYS = [
  "start", "y", "x", "b", "a", "l", "r", "z", "up", "down", "right", "left",
  "mod_x", "mod_y", "c_left", "c_right", "c_up", "c_down", "ls", "ms",
] as const;

/** A box frame exactly as `boxx.rs` puts it on the wire: every key present, booleans only. */
function boxFrame(pressed: string[] = []): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of DIGITAL_KEYS) out[k] = pressed.includes(k);
  return out;
}

describe("overlay input viewer", () => {
  it("still ships the no-controller fallback", async () => {
    // The whole defect was one `if (!c) { hidden = true; return; }`. Pin the replacement in the
    // rendered output, since nothing else in the toolchain reads this code.
    const page = await renderPage();
    expect(page).toContain("var c = pickPort(snap.controllers) || NEUTRAL;");
  });

  it("the page's inline script actually parses", async () => {
    // ⚠ The one check this code never had. `tsc` and `vite build` both treat the whole page as
    // an opaque string, so an unbalanced quote or a stray backtick inside the template literal
    // builds clean and breaks only in OBS. `new Function` COMPILES without running, which is
    // exactly a syntax check.
    const page = await renderPage();
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const body of scripts) expect(() => new Function(body)).not.toThrow();
  });

  it("pickPort returns null for the empty list Dolphin sends for a non-GALE01 disc", async () => {
    const { pickPort } = await loadInputLogic();
    expect(pickPort([])).toBeNull();
    // ...which is exactly why the caller must not treat null as "draw nothing".
    expect(pickPort([]) || "fallback").toBe("fallback");
  });

  it("decodes every digital button from the box alone, with no controller in memory", async () => {
    // The real failing case: Melee mod booted, memory read empty, box plugged in and pressed.
    const { digOn, DIG, NEUTRAL } = await loadInputLogic();
    const frame = boxFrame(["y", "l", "r", "down", "left", "mod_x"]);
    for (const d of DIG) {
      expect(typeof d.dk, `every digital button needs a box key: ${d.lbl ?? d.d}`).toBe("string");
      expect(digOn(d, NEUTRAL, frame), `button ${d.dk}`).toBe(frame[d.dk]);
    }
  });

  it("lights nothing on a neutral box frame", async () => {
    const { digOn, DIG, NEUTRAL } = await loadInputLogic();
    const frame = boxFrame();
    for (const d of DIG) expect(digOn(d, NEUTRAL, frame), `button ${d.dk}`).toBe(false);
  });

  it("reports a lone modifier, which memory inference cannot represent", async () => {
    // The reason the USB path exists at all: with no direction held, the stick is centred and a
    // modifier is invisible from memory at any threshold.
    const { digOn, DIG, NEUTRAL } = await loadInputLogic();
    const modX = DIG.find((d: any) => d.dk === "mod_x");
    expect(digOn(modX, NEUTRAL, boxFrame(["mod_x"]))).toBe(true);
    // Same neutral stick, no box key set -> inference correctly finds nothing.
    expect(digOn(modX, NEUTRAL, boxFrame())).toBe(false);
  });
});
