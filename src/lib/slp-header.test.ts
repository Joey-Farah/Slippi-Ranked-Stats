import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSlpHeader } from "./slp_parser";

// Real replays on this machine. The header offsets are a binary-layout contract with Slippi,
// so the only test worth having is one against actual files — a synthetic fixture would just
// re-encode whatever assumption the parser already makes.
const REPLAY_DIR = "C:/Slippi Replays/Recent";
const OWN_CODE = "JOEY#870";

function recentReplays(limit: number): string[] {
  if (!existsSync(REPLAY_DIR)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2 || out.length > 4000) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".slp")) out.push(p);
    }
  };
  walk(REPLAY_DIR, 0);
  return out
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((x) => x.p);
}

const files = recentReplays(60);
const maybe = files.length > 0 ? describe : describe.skip;

maybe("parseSlpHeader — against real replays", () => {
  it("reads the opponent's connect code from the Game Start block alone", () => {
    let parsed = 0;
    for (const f of files) {
      // Only the first 4 KB — proving it never needs the trailing metadata block.
      const head = readFileSync(f).subarray(0, 4096);
      const info = parseSlpHeader(head, [OWN_CODE]);
      if (!info) continue;
      parsed++;
      expect(info.opponent_code).toMatch(/^[A-Z]+#\d+$/);
      expect(info.opponent_code).not.toBe(OWN_CODE);
      expect(info.match_id).toContain("mode.");
      expect(info.player_port).not.toBe(info.opponent_port);
    }
    // The sample is all recent netplay, so effectively all of it should parse.
    expect(parsed).toBeGreaterThan(files.length * 0.8);
  });

  it("agrees with the full parse on who the opponent is", async () => {
    const { parseSlpBytes } = await import("./slp_parser");
    const { externalToInternal } = await import("./char-icons");
    let compared = 0;
    let charAgreed = 0;
    for (const f of files.slice(0, 25)) {
      const bytes = readFileSync(f);
      const full = parseSlpBytes(bytes, f, OWN_CODE);
      if (full.length === 0) continue;
      const info = parseSlpHeader(bytes.subarray(0, 4096), [OWN_CODE]);
      expect(info).not.toBeNull();
      compared++;
      expect(info!.opponent_code).toBe(full[0].opponent_code);
      expect(info!.match_id).toBe(full[0].match_id);
      expect(info!.match_type).toBe(full[0].match_type);
      expect(info!.stage_id).toBe(full[0].stage_id);
      // Characters usually agree, but not always: the full parse takes the character played
      // for the most frames, so a Zelda who spends the game as Sheik legitimately differs
      // from what Game Start recorded. Counted rather than asserted per-file.
      if (externalToInternal(info!.opponent_char_external) === full[0].opponent_char_id) {
        charAgreed++;
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(charAgreed).toBeGreaterThan(compared * 0.8);
  });

  it("reads the opponent's tag from the file, with no API call", () => {
    let withTag = 0;
    for (const f of files) {
      const info = parseSlpHeader(readFileSync(f).subarray(0, 4096), [OWN_CODE]);
      if (!info) continue;
      if (info.opponent_tag.length > 0) withTag++;
      // A tag must never be the connect code — that would mean we read the wrong field.
      expect(info.opponent_tag).not.toBe(info.opponent_code);
    }
    expect(withTag).toBeGreaterThan(files.length * 0.8);
  });

  it("maps external character ids back to the app's internal ids", async () => {
    const { externalToInternal, internalToExternal } = await import("./char-icons");
    // Round-trip every character so the two directions can't silently drift apart.
    for (let ext = 0; ext <= 25; ext++) {
      const internal = externalToInternal(ext);
      expect(internal).not.toBeNull();
      expect(internalToExternal(internal!)).toBe(ext);
    }
  });

  it("returns null for a truncated header instead of guessing", () => {
    const bytes = readFileSync(files[0]);
    // Cut inside the Game Start block — mirrors a file caught mid-flush at game start.
    expect(parseSlpHeader(bytes.subarray(0, 300), [OWN_CODE])).toBeNull();
    expect(parseSlpHeader(bytes.subarray(0, 20), [OWN_CODE])).toBeNull();
    expect(parseSlpHeader(new Uint8Array(0), [OWN_CODE])).toBeNull();
  });

  it("returns null when we aren't one of the players", () => {
    const head = readFileSync(files[0]).subarray(0, 4096);
    expect(parseSlpHeader(head, ["NOPE#999"])).toBeNull();
  });
});
