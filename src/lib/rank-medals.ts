/**
 * rank-medals.ts — official Slippi rank medal artwork, inlined as raw SVG strings.
 *
 * Source: project-slippi/slippi-launcher (GPL-3.0) — see src/assets/ranks/NOTICE.
 * The SVGs are inlined into the build (not shipped as loose files) so the OBS
 * Browser Source — which runs in CEF off a local file:// page — never has to fetch
 * sibling images at runtime. The stats overlay embeds this whole map once and picks
 * the right medal client-side from the rank tier name, so switching ranks needs no
 * file rewrite.
 *
 * Keys match the tier names returned by getRankTier() in parser.ts exactly.
 */

// Eagerly inline every rank SVG as a raw string at build time.
const RAW = import.meta.glob<string>("../assets/ranks/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Drop the root <svg> width/height attributes so CSS controls the rendered size;
// the viewBox still preserves the aspect ratio.
function sizeAgnostic(svg: string): string {
  return svg.replace(/(<svg\b[^>]*?)\s+width="[^"]*"\s+height="[^"]*"/, "$1");
}

function raw(file: string): string {
  return sizeAgnostic(RAW[`../assets/ranks/${file}.svg`] ?? "");
}

/** Rank tier name (getRankTier().name) → inlined medal SVG markup. */
export const RANK_MEDAL_SVGS: Record<string, string> = {
  "Grandmaster":  raw("rank_Grand_Master"),
  "Master III":   raw("rank_Master_III"),
  "Master II":    raw("rank_Master_II"),
  "Master I":     raw("rank_Master_I"),
  "Diamond III":  raw("rank_Diamond_III"),
  "Diamond II":   raw("rank_Diamond_II"),
  "Diamond I":    raw("rank_Diamond_I"),
  "Platinum III": raw("rank_Platinum_III"),
  "Platinum II":  raw("rank_Platinum_II"),
  "Platinum I":   raw("rank_Platinum_I"),
  "Gold III":     raw("rank_Gold_III"),
  "Gold II":      raw("rank_Gold_II"),
  "Gold I":       raw("rank_Gold_I"),
  "Silver III":   raw("rank_Silver_III"),
  "Silver II":    raw("rank_Silver_II"),
  "Silver I":     raw("rank_Silver_I"),
  "Bronze III":   raw("rank_Bronze_III"),
  "Bronze II":    raw("rank_Bronze_II"),
  "Bronze I":     raw("rank_Bronze_I"),
  "Unranked":     raw("rank_Unranked1"),
};
