/**
 * char-icons.ts — Melee character stock icons, inlined as base64 data URIs.
 *
 * Source: project-slippi/slippi-launcher (GPL-3.0) — see src/assets/characters/NOTICE.
 * Like rank-medals.ts, the icons are inlined into the build (not shipped as loose
 * files) so the OBS Browser Source — CEF on a local file:// page — never has to fetch
 * sibling images at runtime. The stats overlay embeds this whole map once and picks the
 * right icon client-side by external character ID, so a character switch needs no rewrite.
 *
 * IMPORTANT: keys here are EXTERNAL (CSS-order) character IDs, which is what the Slippi
 * API (`characters { character }`) and peppi use — NOT the internal IDs in parser.ts's
 * CHARACTERS table. Use internalToExternal() to convert an in-game (internal) id.
 */
import { CHARACTERS as INTERNAL_CHARACTERS } from "./parser";

// Eagerly inline every character PNG as a base64 data URI at build time (?inline forces
// a data URL regardless of size, so the overlay HTML carries the bytes directly).
const RAW = import.meta.glob<string>("../assets/characters/char_*.png", {
  query: "?inline",
  import: "default",
  eager: true,
});
function icon(id: number): string {
  return RAW[`../assets/characters/char_${id}.png`] ?? "";
}

/** External (CSS-order) character ID → display name. Matches the Slippi API / peppi
 *  ordering; names are kept identical to parser.ts CHARACTERS so name lookups line up. */
export const EXTERNAL_CHARACTERS: Record<number, string> = {
  0:  "Captain Falcon", 1:  "Donkey Kong",     2:  "Fox",          3:  "Mr. Game & Watch",
  4:  "Kirby",          5:  "Bowser",          6:  "Link",         7:  "Luigi",
  8:  "Mario",          9:  "Marth",           10: "Mewtwo",       11: "Ness",
  12: "Peach",          13: "Pikachu",         14: "Ice Climbers", 15: "Jigglypuff",
  16: "Samus",          17: "Yoshi",           18: "Zelda",        19: "Sheik",
  20: "Falco",          21: "Young Link",      22: "Dr. Mario",    23: "Roy",
  24: "Pichu",          25: "Ganondorf",
};

/** Slippi API character enum string → external ID. The API returns SCREAMING_SNAKE_CASE
 *  enum names in `characters { character }` (verified live: FOX, FALCO, MARTH, BOWSER…). */
export const API_CHAR_TO_EXTERNAL: Record<string, number> = {
  CAPTAIN_FALCON: 0, DONKEY_KONG: 1, FOX: 2, GAME_AND_WATCH: 3, KIRBY: 4, BOWSER: 5,
  LINK: 6, LUIGI: 7, MARIO: 8, MARTH: 9, MEWTWO: 10, NESS: 11, PEACH: 12, PIKACHU: 13,
  ICE_CLIMBERS: 14, JIGGLYPUFF: 15, SAMUS: 16, YOSHI: 17, ZELDA: 18, SHEIK: 19, FALCO: 20,
  YOUNG_LINK: 21, DOCTOR_MARIO: 22, ROY: 23, PICHU: 24, GANONDORF: 25,
};

// Reverse of EXTERNAL_CHARACTERS by name, for internal→external conversion by name match.
const NAME_TO_EXTERNAL: Record<string, number> = Object.fromEntries(
  Object.entries(EXTERNAL_CHARACTERS).map(([id, name]) => [name, Number(id)])
);

/** Convert an in-game (internal, parser.ts) character id to its external id, or null if
 *  unknown. Used to icon-ify the live in-game character (the fallback when an opponent's
 *  Slippi profile lists no ranked characters). */
export function internalToExternal(internalId: number): number | null {
  const name = INTERNAL_CHARACTERS[internalId];
  return name != null && name in NAME_TO_EXTERNAL ? NAME_TO_EXTERNAL[name] : null;
}

/** External character ID → inlined stock-icon data URI, embedded once into the overlay. */
export const CHAR_ICONS: Record<number, string> = Object.fromEntries(
  Object.keys(EXTERNAL_CHARACTERS).map((k) => [Number(k), icon(Number(k))])
);
