/**
 * stats-overlay.ts — the unified "Live Ranked Stats" OBS overlay (server-less).
 *
 * A single always-on Browser Source showing tag / rank medal / MMR / global placement /
 * season W/L / today's (session) record, an opponent line while a set is live, and — on
 * set completion — a transient "post-set bridge": it holds the set result + the grade
 * letter (spun in), then surfaces the per-set MMR change once the refetched rating lands,
 * before settling back to the standard panel. This replaces the old standalone set-grade
 * overlay (overlay.ts) — the grade now lives inside this one source.
 *
 * Two layouts (stacked column / square side-by-side) are selectable in-app; the page
 * renders whichever the payload's `layout` says. The app writes `stats-state.js` whenever
 * the payload changes and the page (a static `stats.html`) watches that file.
 *
 * Rank medals (rank-medals.ts) are inlined once so OBS's CEF never loads sibling images
 * off the local file:// page — the page just picks the medal by rank name.
 */
import { appDataDir, join } from "@tauri-apps/api/path";
import { writeTextFile, mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";
import { RANK_MEDAL_SVGS } from "./rank-medals";
import { CHAR_ICONS } from "./char-icons";
import type { StatsOverlayPayload } from "./store";

const DIR = "stream-overlay";

/** JSON for safe inlining inside an HTML <script>: also escape `<` so a value like
 *  `</script>` (e.g. in an opponent's Slippi display name, which is attacker-controlled)
 *  can't break out of the tag. Produces valid JS that parses to the identical value. */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

// Inlined into the page as `var MEDALS = {...}` (SVG markup escaped for a <script> context).
const MEDALS_JSON = jsonForScript(RANK_MEDAL_SVGS);
// External char id → stock-icon data URI, inlined once as `var CHARS = {...}`. The overlay
// picks the opponent's icons client-side by id, so a char swap never needs a file rewrite.
const CHARS_JSON = jsonForScript(CHAR_ICONS);

/** Tiny deterministic 32-bit string hash → hex (djb2). Stamps the overlay page so a loaded OBS
 *  Browser Source can notice when stats.html changed on disk (app update / new build) and reload
 *  itself — no manual OBS "Refresh" needed. Not security-sensitive; collisions are irrelevant. */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** The always-on stats panel. The inline script uses string concatenation + literal
 *  Unicode (·, –, —, ▲, ▼) and the &#39; entity for the apostrophe, so it embeds cleanly
 *  in this TS template string with no backslash gymnastics. */
function overlayDoc(boot: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Slippi Ranked Stats — Live Overlay</title>
  <style>
    /* Everything is sized in rem on a vmin-based root, so the panel scales with the OBS
       Browser Source's resolution and stays crisp. Size the SOURCE to the on-stream size
       you want (bigger source = bigger overlay) and leave its scene scale at 1.0 — scaling
       the source in the scene upsamples a small bitmap and looks pixelated. One knob to
       retune overall size: the html font-size below. */
    html { font-size: 4vmin; }
    /* Side-by-side is the shorter layout, so it can run a touch larger and fill more frame. */
    /* Side-by-side is now a wide landscape card (two top columns), so scale it to width. */
    html.side { font-size: 3.7vw; }
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
      font-family: "Segoe UI", system-ui, Arial, sans-serif; }
    /* #stage owns the viewport so the panel and the input viewer stack in normal flow.
       ⚠ #root used to be the fixed, full-viewport element. It cannot be, once anything renders
       BELOW it: a fixed #root covers the whole frame, so a sibling lands underneath it at the
       top-left corner instead of under the panel. Keep the fixed positioning on #stage. */
    #stage { position: fixed; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: flex-start; }
    #root { width: 100%; display: flex; justify-content: center; align-items: flex-start; }
    .panel { display: flex; flex-direction: column; align-items: center; text-align: center;
      gap: 0.1rem; padding: 0.7rem 1rem; color: #fff; text-shadow: 0 0.1em 0.3em rgba(0, 0, 0, 0.85); }
    .tag { font-size: 1.3rem; font-weight: 800; letter-spacing: 0.01em; }
    .medal { width: 3rem; height: 3rem; flex-shrink: 0; }
    .medal svg { width: 100%; height: 100%; display: block; filter: drop-shadow(0 0.1em 0.2em rgba(0, 0, 0, 0.6)); }
    .rank { font-size: 1.25rem; font-weight: 800; letter-spacing: 0.06em; }
    .mmr { font-size: 1.9rem; font-weight: 800; line-height: 1.05; }
    .global { font-size: 0.95rem; font-weight: 700; opacity: 0.96; }
    .season { font-size: 1.15rem; font-weight: 800; }
    .season .l { margin-left: 0.75rem; }
    .w { color: #2ecc71; } .l { color: #ff4d4f; }
    .vs { font-size: 1.05rem; font-weight: 700; margin-top: 0.3rem; padding: 0.2rem 0.75rem;
      border-radius: 0.5rem; background: rgba(255, 255, 255, 0.1); }
    .vs-sub { font-size: 0.85rem; font-weight: 700; opacity: 0.95; margin-top: 0.15rem; }
    .vs-medal { display: inline-block; width: 2.4em; height: 2.4em; vertical-align: -0.85em; margin-right: 0.2em; }
    .vs-medal svg { width: 100%; height: 100%; display: block;
      filter: drop-shadow(0 0.05em 0.12em rgba(0, 0, 0, 0.55)); }
    .vs-rank { font-weight: 800; }
    /* Opponent character stock icons (their profile mains, or the live char as fallback). */
    .vs-chars { display: inline-flex; align-items: center; gap: 0.15em; vertical-align: -0.28em; margin-left: 0.1em; }
    .char-icon { width: 1.3em; height: 1.3em; display: block; image-rendering: auto;
      filter: drop-shadow(0 0.05em 0.12em rgba(0, 0, 0, 0.55)); }
    /* Live set score — its own prominent row so the current count is obvious mid-set. */
    .vs-score { font-size: 1.7rem; font-weight: 800; line-height: 1; margin-top: 0.35rem;
      display: flex; align-items: baseline; justify-content: center; gap: 0.35rem; }
    .vs-score-cap { font-size: 1.05rem; font-weight: 800; letter-spacing: 0.06em;
      color: #fff; align-self: center; margin-right: 0.15rem; }
    .vs-score-dash { color: rgba(255, 255, 255, 0.85); }
    .setresult { font-size: 1.1rem; font-weight: 800; letter-spacing: 0.03em; margin-top: 0.2rem; white-space: nowrap; }
    .grade { font-size: 4.5rem; font-weight: 800; line-height: 1; margin: 0.1rem 0; }
    .grade.show { animation: spin-in 700ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
    @keyframes spin-in {
      0%   { opacity: 0; transform: rotate(-360deg) scale(0); }
      70%  { opacity: 1; transform: rotate(12deg) scale(1.12); }
      100% { opacity: 1; transform: rotate(0) scale(1); }
    }
    .divider { width: 82%; height: 0.12rem; margin: 0.5rem 0 0.3rem;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.45), transparent); }
    .today-label { font-size: 0.95rem; font-weight: 800; letter-spacing: 0.02em; }
    .today-row { display: flex; align-items: baseline; justify-content: center; gap: 1rem;
      font-size: 1.05rem; font-weight: 800; }
    /* side-by-side: a wide card. Top row = two persistent blocks (identity | today's stats);
       the area below fills with the transient set/grade info. */
    .side-head { display: flex; align-items: center; gap: 1.1rem; }
    .side-head .medal { width: 3.4rem; height: 3.4rem; }
    .side-id { display: flex; flex-direction: column; align-items: center; text-align: center; line-height: 1.15; }
    .side-id .rank { font-size: 1.2rem; }
    .side-id .global { font-size: 1rem; }
    .persist { display: flex; align-items: center; justify-content: center; gap: 1.4rem; flex-wrap: nowrap; }
    .vdivider { width: 2px; align-self: stretch; min-height: 3rem;
      background: linear-gradient(180deg, transparent, rgba(255, 255, 255, 0.4), transparent); }
    /* today's stats (right column) — session change + today's W/L, sized to match the left */
    .today-block { display: flex; flex-direction: column; align-items: center; }
    .today-block .today-label { font-size: 1.2rem; margin-bottom: 0.1rem; }
    .today-block .today-mmr { font-size: 2rem; font-weight: 800; line-height: 1.05; }
    .today-wl { display: flex; gap: 1.2rem; font-size: 1.3rem; font-weight: 800; margin-top: 0.15rem; }
    .transient { display: flex; flex-direction: column; align-items: center; }
    /* post-set moment: a labelled grade beside the result text */
    .setblock { display: flex; align-items: center; justify-content: center; gap: 0.9rem; }
    .setinfo { display: flex; flex-direction: column; align-items: center; text-align: center; }
    .gradewrap { display: flex; flex-direction: column; align-items: center; }
    .gradewrap .grade { margin: 0; }
    .gradelabel { font-size: 0.72rem; font-weight: 800; letter-spacing: 0.14em; color: rgba(255, 255, 255, 0.8); }
    /* Standout category under the grade — best on a win, worst on a loss. Readable but
       clearly secondary to the big grade letter. */
    .subgrade { font-size: 1.3rem; font-weight: 800; line-height: 1.2; text-align: center; max-width: 9rem; }
    .subgrade .subcap { display: block; font-size: 0.8rem; font-weight: 800; letter-spacing: 0.1em; color: rgba(255, 255, 255, 0.65); margin-bottom: 0.1rem; }
    /* Per-set MMR change in the post-set moment — labelled THIS SET so it never reads as the
       cumulative session total (which lives, labelled "today", in the Today's stats block). */
    .set-mmr { font-size: 1rem; font-weight: 800; margin-top: 0.25rem; }
    .set-mmr .setcap { font-size: 0.72rem; font-weight: 800; letter-spacing: 0.14em; color: #fff; margin-right: 0.4em; }
    /* ── Live controller input viewer ───────────────────────────────────────
       Its own block outside #root on purpose: it updates 60x a second, while #root re-renders
       by diffing whole-panel innerHTML. Folding it in would rebuild the entire panel every
       frame. Everything here is driven by class + transform changes, never innerHTML.

       Button colours are the real controller's, taken from m-overlay's default skin
       (MIT, (c) 2020 Bkacjios): A rgb(0,225,150), B rgb(230,0,0), X / Y white,
       Z rgb(165,75,165). Unpressed draws as an outline in that colour and pressed fills it, so
       a glance reads as "which buttons are down" rather than "what colour is this".

       ⚠ The D-pad and Start are deliberately absent from both skins. Neither matters to Melee
       gameplay, and leaving them out buys the rest of the layout real room. */
    /* ONE knob for the whole viewer. Everything inside is in em, so changing this font-size
       rescales the layout properly (real reflow, crisp text) instead of transform: scale(),
       which scales rendered output and softens text. JS overrides it from the saved setting. */
    .inputs { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
      font-size: 1.6rem; background: rgba(0, 0, 0, 0.5);
      border-radius: 0.3em; padding: 0.3em 0.4em; }
    .inputs[hidden] { display: none; }

    /* Buttons. "currentColor" carries the per-button colour, so one rule covers outline, fill
       and label without repeating six hex values. */
    .ibtn { position: absolute; display: flex; align-items: center; justify-content: center;
      box-sizing: border-box; transform: translate(-50%, -50%);
      border: 0.09em solid currentColor; background: transparent;
      font-weight: 800; line-height: 1; }
    .ibtn > s { text-decoration: none; color: currentColor; opacity: 0.6;
      font-size: 0.4em; }
    .ibtn.on { background: currentColor; box-shadow: 0 0 0.35em currentColor; }
    .ibtn.on > s { color: #0a0a0a; opacity: 1; }
    .b-a { color: rgb(0, 225, 150); }
    .b-b { color: rgb(230, 0, 0); }
    .b-x, .b-y { color: #f0f0f0; }
    .b-z { color: rgb(206, 118, 235); }

    /* Sticks: a gate ring with a travelling dot. The dot is the only thing that moves. */
    .istick { position: absolute; border-radius: 50%; transform: translate(-50%, -50%);
      background: rgba(255, 255, 255, 0.06); box-shadow: inset 0 0 0 0.07em rgba(255, 255, 255, 0.22); }
    .istick > i { position: absolute; left: 50%; top: 50%; border-radius: 50%;
      background: #e8e8e8; will-change: transform; }
    .istick.c { box-shadow: inset 0 0 0 0.07em rgba(255, 196, 0, 0.5); }
    .istick.c > i { background: rgb(255, 196, 0); }

    /* Analog triggers, styled to match the buttons: outlined pill with a CENTRED label, lit
       the same way on press. The analog travel shows as a translucent fill behind the label.
       ⚠ The fill is translucent currentColor, not a solid light bar — a solid fill sliding under
       a centred label made the label unreadable at partial press, which is what the earlier
       left-aligned-label-with-halo version was working around. */
    .itrig { position: absolute; transform: translate(-50%, -50%); border-radius: 0.14em;
      box-sizing: border-box; display: flex; align-items: center; justify-content: center;
      border: 0.08em solid currentColor; background: transparent; color: #f0f0f0;
      overflow: hidden; }
    .itrig > i { position: absolute; left: 0; top: 0; height: 100%; width: 0;
      background: currentColor; opacity: 0.3; will-change: width; }
    .itrig > u { position: relative; font-size: 0.3em; font-weight: 800; font-style: normal;
      color: currentColor; opacity: 0.75; line-height: 1; }
    .itrig.on { background: currentColor; }
    .itrig.on > i { opacity: 0; }
    .itrig.on > u { color: #0a0a0a; opacity: 1; }

    /* ── Skin: controller ── GameCube shape, m-overlay's arrangement. */
    /* Sized to what the parts actually occupy (~7.6em across) rather than a round number:
       the earlier 11em left a visible hole between the C-stick and the buttons, made worse
       when Start was removed from the middle. */
    .inp-ctl { position: relative; width: 7.8em; height: 4em; }

    /* ── Skin: 20XX ── flat blocks, ported from m-overlay's 20XX skin (MIT, (c) 2020 Bkacjios).
       Square gates with a square travelling dot, and pressed fills WHITE over the base colour
       rather than lighting the colour itself. Its colours: A rgb(0,200,0), B rgb(200,0,0),
       Z rgb(125,0,125), Y/X/triggers grey rgb(100,100,100), C-stick gate dark yellow with a
       bright yellow dot. Geometry is that skin's pixel layout at 0.02em per unit.
       ⚠ .xbtn.on must outrank the per-button colour classes — two classes beats one, so the
       press colour wins without !important. */
    /* 6.9em, not 8em: the original 20XX skin leaves room beside the joystick for the
       D-pad, which this viewer does not draw — that space is pure gap here. */
    .inp-20 { position: relative; width: 6.9em; height: 2.88em; }
    .xbtn, .xgate, .xtrig { position: absolute; background: rgb(100, 100, 100); }
    .xbtn.on { background: #fff; }
    .x-a { background: rgb(0, 200, 0); }
    .x-b { background: rgb(200, 0, 0); }
    .x-z { background: rgb(125, 0, 125); }
    .xgate.c { background: rgb(125, 125, 0); }
    .xdot { position: absolute; width: 0.32em; height: 0.32em; background: #fff;
      will-change: transform; }
    .xdot.c { background: rgb(255, 255, 0); }
    .xtrig { overflow: hidden; }
    .xtrig > i { position: absolute; top: 0; height: 100%; width: 0;
      background: rgb(200, 200, 200); will-change: width; }
    /* R fills right-to-left, mirroring the original. */
    .xtrig > i.flip { left: auto; right: 0; }
    .xtrig.on { background: #fff; }
    .xtrig.on > i { opacity: 0; }
    /* ── Skin: digital ── box / B0XX style, matched to a reference image of the viewer it
       replaces: thick ring on black, label or block arrow inside, fills with its own colour when
       pressed. All shapes are drawn here (CSS circle + inline SVG arrow) — no bundled art. */
    .inp-dig { position: relative; width: 9.91em; height: 5.36em; }
    .dbtn { position: absolute; display: flex; align-items: center; justify-content: center;
      box-sizing: border-box; transform: translate(-50%, -50%);
      border-radius: 50%;
      border: 0.075em solid currentColor; background: transparent;
      color: #fff; font-weight: 800; line-height: 1.05; text-align: center; }
    .dbtn > s { text-decoration: none; color: currentColor; font-size: 0.36em; }
    /* Only the two-line mod labels need the smaller size. */
    .dbtn > s.sm { font-size: 0.24em; }
    .dbtn > svg { width: 62%; height: 62%; display: block; fill: none;
      stroke: currentColor; stroke-width: 2.2; stroke-linejoin: round; }
    .dbtn.on { background: currentColor; }
    .dbtn.on > s { color: #000; }
    .dbtn.on > svg { stroke: #000; fill: #000; }
    .d-a { color: rgb(0, 212, 94); }
    .d-b { color: rgb(255, 32, 32); }
    .d-z { color: rgb(206, 118, 235); }
    .d-c { color: rgb(255, 230, 10); }
  </style>
</head>
<body>
  <div id="stage">
    <div id="root"></div>
    <div id="inputs" class="inputs" hidden></div>
  </div>
  <script>
    var POLL_MS = 500;
    var POSTSET_MS = 180000; // hold the set result + grade until the next set starts or 3 min passes

    var GRADE_COLORS = { S: "#FF1493", A: "#00C853", B: "#00B0FF", C: "#FFC400", D: "#FF7300", F: "#FF1744" };
    var MEDALS = ${MEDALS_JSON};
    var CHARS = ${CHARS_JSON};

    var root = document.getElementById("root");
    var latest = null, lastHtml = "";
    var firstApply = true, shownSetId = null;
    var postSet = false, postSetData = null, animatedSetId = null;
    var holdTimer = null;

    function esc(t) { var d = document.createElement("div"); d.textContent = String(t); return d.innerHTML; }
    function fmt1(n) { return (Math.round(n * 10) / 10).toFixed(1); }
    function fmtDelta(d) { return (d >= 0 ? "+" : "") + fmt1(d); }

    // Per-element visibility. Missing show/key (older payloads) defaults to visible, so the
    // overlay never disappears if a state file predates the toggles.
    function vis(s, k) { return !s || !s.show || s.show[k] !== false; }

    function medalHtml(s) { if (!vis(s, "medal")) return ""; return '<div class="medal">' + (MEDALS[s.rankName] || MEDALS["Unranked"] || "") + "</div>"; }
    function rankHtml(s) { if (!vis(s, "rank")) return ""; return '<div class="rank" style="color:' + esc(s.rankColor) + '">' + esc((s.rankName || "").toUpperCase()) + "</div>"; }

    // Opponent character stock icons (their profile mains, or the live char as a fallback).
    function charsHtml(ids) {
      if (!ids || !ids.length) return "";
      var imgs = "";
      for (var i = 0; i < ids.length; i++) {
        var src = CHARS[ids[i]];
        if (src) imgs += '<img class="char-icon" src="' + src + '" />';
      }
      return imgs ? '<span class="vs-chars">' + imgs + "</span>" : "";
    }

    // Current MMR only — the session change now lives (labelled "today") in the Today's block,
    // and the per-set change shows in the post-set moment, so each number reads unambiguously.
    function mmrHtml(s) {
      if (s.rating == null || !vis(s, "mmr")) return "";
      return '<div class="mmr">' + fmt1(s.rating) + "</div>";
    }

    function globalHtml(s) {
      if (s.globalRank == null || !vis(s, "global")) return "";
      return '<span class="global">#' + esc(s.globalRank) + (s.region ? " [" + esc(s.region) + "]" : "") + "</span>";
    }

    function seasonHtml(s) {
      if (s.seasonWins == null || s.seasonLosses == null || !vis(s, "season")) return "";
      return '<span class="season"><span class="w">W: ' + esc(s.seasonWins) + '</span><span class="l">L: ' + esc(s.seasonLosses) + "</span></span>";
    }

    function contextHtml(s, side) {
      if (postSet && postSetData) {
        var won = postSetData.result === "win";
        var gradeEl = "", subEl = "";
        if (postSetData.gradeLetter && vis(s, "grade")) {
          var gc = GRADE_COLORS[postSetData.gradeLetter] || "#fff";
          var cls = (animatedSetId === postSetData.setId) ? "grade" : "grade show";
          gradeEl = '<div class="gradewrap"><div class="gradelabel">SET GRADE</div><div class="' + cls + '" style="color:' + gc + '">' + esc(postSetData.gradeLetter) + "</div></div>";
          // Standout individual stat — best on a win, worst on a loss. Sits to the RIGHT of the
          // grade letter (its own column) so the wide post-set area fills out horizontally. We
          // drop the category name (Neutral/Punish/Defense); the specific stat is the interesting
          // part. Falls back to the category only if no individual stat scored.
          var sLabel  = postSetData.subStatLabel  || postSetData.subLabel;
          var sLetter = postSetData.subStatLetter || postSetData.subLetter;
          if (sLabel && sLetter) {
            var sgc = GRADE_COLORS[sLetter] || "#fff";
            subEl = '<div class="subgrade"><span class="subcap">' + (won ? "BEST" : "WORST") + "</span>"
              + esc(sLabel) + ': <span style="color:' + sgc + '">' + esc(sLetter) + "</span></div>";
          }
        }
        // Set result line + opponent — gated together by the "setResult" toggle.
        var setResultOn = vis(s, "setResult");
        var resEl = setResultOn ? '<div class="setresult" style="color:' + (won ? "#2ecc71" : "#ff4d4f") + '">' + (won ? "SET WON" : "SET LOST") + " · " + esc(postSetData.wins) + "–" + esc(postSetData.losses) + "</div>" : "";
        // Opponent char as a stock icon (the char they played this set); text name as fallback.
        var vsChar = charsHtml(postSetData.opponentCharId != null ? [postSetData.opponentCharId] : []);
        var vsTail = vsChar ? " " + vsChar : (postSetData.opponentChar ? " · " + esc(postSetData.opponentChar) : "");
        var vsEl = setResultOn ? '<div class="vs">vs ' + esc(postSetData.opponentCode) + vsTail + "</div>" : "";
        // Per-set rating change — appears once the rating refetch lands (rating moved off
        // ratingBefore). Labelled "Last set:" (the set is over by the time it shows) so it's never
        // confused with the session total. Has its own "setRating" toggle, independent of the live
        // "mmr" (current Rating) toggle.
        var setMmrEl = "";
        if (vis(s, "setRating") && s.rating != null && postSetData.ratingBefore != null && s.rating !== postSetData.ratingBefore) {
          var sd = s.rating - postSetData.ratingBefore;
          setMmrEl = '<div class="set-mmr"><span class="setcap">LAST SET:</span><span style="color:' + (sd >= 0 ? "#2ecc71" : "#ff4d4f") + '">' + fmtDelta(sd) + "</span></div>";
        }
        if (side) return '<div class="setblock">' + gradeEl + subEl + '<div class="setinfo">' + resEl + vsEl + setMmrEl + "</div></div>";
        return gradeEl + subEl + resEl + vsEl + setMmrEl;
      }
      if (s.opponent && vis(s, "opponent")) {
        var o = s.opponent;
        // Line 1: tag (code) + char icon(s) — the tag is what a viewer recognizes; the code
        // disambiguates. Char shows the opponent's profile mains as stock icons (so a mid-set
        // char swap isn't shown stale); falls back to the live char name if none resolve.
        var name = o.tag ? esc(o.tag) + " (" + esc(o.code) + ")" : esc(o.code);
        var oChars = charsHtml(o.charIds);
        var l1 = "vs " + name + (oChars ? " " + oChars : (o.char ? " · " + esc(o.char) : ""));
        // Line 2: rank (medal + tier-colored name) · ELO · season record (W green / L red) ·
        // current set score. Each piece is dropped while its value is still loading (the opponent
        // profile fetch is async) so the line never shows blanks.
        var parts = [];
        if (o.tier) {
          var medal = MEDALS[o.tier] || "";
          var medalEl = medal ? '<span class="vs-medal">' + medal + "</span>" : "";
          var rc = o.tierColor || "#fff";
          parts.push(medalEl + '<span class="vs-rank" style="color:' + esc(rc) + '">' + esc(o.tier) + "</span>");
        }
        if (o.rating != null) parts.push(fmt1(o.rating));
        if (o.seasonWins != null && o.seasonLosses != null) {
          parts.push('<span class="w">' + esc(o.seasonWins) + 'W</span>–<span class="l">' + esc(o.seasonLosses) + "L</span>");
        }
        // Scoreboard row (below the stats), not tucked at the end of the stats line — your wins
        // green, the opponent's red, so it's clear mid-set. In ranked this is the set score; in
        // unranked/direct there is no set, so it's the running game tally for the whole
        // connection and the label says so.
        var scoreCap = o.mode === "ranked" ? "Set Count:" : "Games:";
        var scoreEl = '<div class="vs-score"><span class="vs-score-cap">' + scoreCap + '</span><span>' + esc(o.gamesWon) + '</span><span class="vs-score-dash">–</span><span>' + esc(o.gamesLost) + "</span></div>";
        return '<div class="vs">' + l1 + '<div class="vs-sub">' + parts.join(" · ") + "</div>" + scoreEl + "</div>";
      }
      return "";
    }

    // Today's block (stacked): session MMR change + today's set W/L. The current MMR is no
    // longer here (it moved up with the identity), so this block is unambiguously "this session".
    // The change (sessionDelta toggle) and W/L (today toggle) gate independently; block collapses
    // when both are off.
    function todayHtml(s) {
      var showChange = s.sessionDelta != null && vis(s, "sessionDelta");
      var showWl = vis(s, "today");
      if (!showChange && !showWl) return "";
      var parts = "";
      if (showWl) parts += '<span class="w">W: ' + esc(s.sessionWins) + "</span>";
      if (showChange) parts += '<span style="color:' + (s.sessionDelta >= 0 ? "#2ecc71" : "#ff4d4f") + '">' + fmtDelta(s.sessionDelta) + "</span>";
      if (showWl) parts += '<span class="l">L: ' + esc(s.sessionLosses) + "</span>";
      return '<div class="today-label">Today&#39;s stats</div><div class="today-row">' + parts + "</div>";
    }

    function tagHtml(s) { return vis(s, "tag") ? '<div class="tag">' + esc(s.tag) + "</div>" : ""; }

    function buildStacked(s) {
      var h = '<div class="panel">';
      h += tagHtml(s);
      // MMR sits with the identity now (below season W/L), so the Today's block reads purely as
      // session change — no more ambiguity between "current MMR" and "session/this-set change".
      h += medalHtml(s) + rankHtml(s);
      h += globalHtml(s) + seasonHtml(s) + mmrHtml(s);
      // Today's-stats block is persistent (always on screen), so it sits with the identity at the
      // top — above the transient content. Keeps its own divider only when shown.
      var today = todayHtml(s);
      if (today) h += '<div class="divider"></div>' + today;
      // Transient area at the BOTTOM — opponent line during a set, grade + result + this-set
      // rating after. The appear-then-leave content stays below everything that's always on screen.
      var ctx = contextHtml(s, false);
      if (ctx) h += '<div class="divider"></div>' + ctx;
      h += "</div>";
      return h;
    }

    function buildSide(s) {
      // Left identity column — tag/rank/global/season + the current MMR (MMR now lives with the
      // identity, below season W/L). Any piece may be hidden.
      var idParts = tagHtml(s) + rankHtml(s) + globalHtml(s) + seasonHtml(s) + mmrHtml(s);
      var medal = medalHtml(s);
      var left = (medal || idParts)
        ? '<div class="side-head">' + medal + '<div class="side-id">' + idParts + "</div></div>"
        : "";
      // Right "Today's stats" block — session MMR change + today's set W/L (each independently
      // toggled). No raw MMR here anymore, so it reads cleanly as "this session".
      var showChange = s.sessionDelta != null && vis(s, "sessionDelta");
      var changeEl = showChange
        ? '<div class="today-mmr" style="color:' + (s.sessionDelta >= 0 ? "#2ecc71" : "#ff4d4f") + '">' + fmtDelta(s.sessionDelta) + "</div>"
        : "";
      var wl = vis(s, "today")
        ? '<div class="today-wl"><span class="w">W: ' + esc(s.sessionWins) + '</span><span class="l">L: ' + esc(s.sessionLosses) + "</span></div>"
        : "";
      var right = (changeEl || wl)
        ? '<div class="today-block"><div class="today-label">Today&#39;s stats</div>' + changeEl + wl + "</div>"
        : "";

      var h = '<div class="panel"><div class="persist">';
      h += left;
      if (left && right) h += '<div class="vdivider"></div>';
      h += right;
      h += "</div>";
      // Transient area below — fills in during a set (opponent) and after (grade + result).
      var ctx = contextHtml(s, true);
      if (ctx) h += '<div class="divider"></div><div class="transient">' + ctx + "</div>";
      h += "</div>";
      return h;
    }

    function buildHtml(s) {
      if (!s || (!s.tag && s.rating == null)) return "";
      return s.layout === "sidebyside" ? buildSide(s) : buildStacked(s);
    }

    // ── Live controller input viewer ──────────────────────────────────────────
    //
    // Fed by a localhost Server-Sent Events stream the app opens (see src-tauri/src/dolphin.rs),
    // NOT by stats-state.js — 60 updates a second through a file on disk would be pure churn.
    // The port arrives in the state file, which is the one channel this page is guaranteed to
    // have, so the socket stays a detail of this panel alone.
    //
    // If the stream never connects, this panel simply stays hidden and the rest of the overlay
    // is untouched. That is the whole reason it is a separate block.
    //
    // Geometry below is in percent of the skin container, modelled on m-overlay's default skin:
    // A centre-right and largest, B lower-left of it, X right, Y above, Z above-right,
    // sticks left, triggers along the top. Its own skin is drawn through a 3D
    // perspective transform, so these are a faithful 2D interpretation, not a pixel copy.
    // ⚠ No D-pad and no Start on purpose — neither matters to Melee gameplay.
    // ── Skin: digital (box / B0XX) ────────────────────────────────────────────
    //
    // Layout measured from a reference image of the viewer this replaces, normalised to its
    // content bounding box (1708x716 -> ratio 2.385, buttons 6.91% of width). Shapes are drawn
    // here as CSS circles and inline SVG arrows; no third-party art is bundled.
    //
    // ⚠ What this can and cannot know. The console only ever receives ANALOG stick values: a box
    // controller resolves its direction buttons into those before transmitting, so Dolphin's
    // memory holds no record of which physical button was pressed. So:
    //   - A/B/X/Y/Z/L/R/Start are real button bits        -> exact
    //   - directions come from thresholding the stick     -> exact in practice, a box sends a
    //                                                        clean +/-1.0 for a cardinal
    //   - Mod X / Mod Y are INFERRED -> a guess, and an incomplete one.
    //     ⚠ Judge the vector MAGNITUDE, never the individual axes. A full diagonal is about
    //     (0.70, 0.70): each axis looks "intermediate" while the magnitude is 0.99, i.e. fully
    //     deflected and not modified at all. Testing per axis lit a mod on every plain diagonal.
    //     ⚠⚠ A modifier pressed ALONE leaves the stick at neutral, which is byte-identical to
    //     touching nothing. It cannot be detected from game memory at all, at any threshold.
    //     Reading the controller's own USB serial is the only fix; see docs/dev_notes.md.
    var DIR_ON = 0.5;                 // a direction counts as held past this magnitude
    // Band measured on a real box (30s capture, see docs/dev_notes.md): every MODIFIED input
    // landed at magnitude <= 0.796, every full one at >= 0.99 (cardinals 1.00, full
    // diagonals 0.9906-0.9914). 0.15-0.90 sits in that gap with room either side.
    var MOD_LO = 0.15, MOD_HI = 0.90;

    // Block-arrow path, pointing RIGHT in a 24x24 box; rotated per direction.
    var ARROW = "M3,9.5 L13,9.5 L13,4 L21.5,12 L13,20 L13,14.5 L3,14.5 Z";
    var ROT = { left: 180, right: 0, up: 270, down: 90 };

    // x / y are percent of the container, measured from the reference. d = arrow direction.
    // Lightshield / Midshield: dedicated buttons on a box that drive the analog trigger to a
    // partial value WITHOUT the digital click. That is genuinely what they do, so these are read
    // off the analog value rather than inferred. ⚠ Bands are a first estimate, not measured on
    // hardware the way the mod band was — widen them if a shield press does not register.
    var LS_LO = 0.15, LS_HI = 0.55;
    var MS_LO = 0.55, MS_HI = 0.97;

    // Layout verified free of overlaps at these sizes (see docs/dev_notes.md). Buttons are 8.6%
    // of width, up from the reference's 6.91%, with the gap between the two hands compressed so
    // the extra size costs no spill.
    var DIG = [
      { lbl: "L",     s: "bit", m: 0x0040, x: 5.1, y: 27.4, w: 1.02 },
      { d: "left",    s: "jx-", x: 15.6, y: 19.6, w: 1.02 },
      { d: "down",    s: "jy-", x: 27.1, y: 19.6, w: 1.02 },
      { d: "right",   s: "jx+", x: 37.6, y: 27.4, w: 1.02 },
      { lbl: "mod<br>X", s: "modx", x: 29.2, y: 58.2, w: 1.02, small: true },
      { lbl: "mod<br>Y", s: "mody", x: 39.9, y: 71.1, w: 1.02, small: true },
      { lbl: "R",     s: "bit", m: 0x0020, x: 60.9, y: 17.4, w: 1.02 },
      { lbl: "Y",     s: "bit", m: 0x0800, x: 71.8, y: 9.5, w: 1.02 },
      { lbl: "LS",    s: "ls", x: 84.0, y: 9.5, w: 1.02 },
      { lbl: "MS",    s: "ms", x: 94.9, y: 17.4, w: 1.02 },
      { lbl: "B",     s: "bit", m: 0x0200, x: 60.9, y: 39.7, w: 1.02, c: "d-b" },
      { lbl: "X",     s: "bit", m: 0x0400, x: 71.8, y: 31.9, w: 1.02 },
      { lbl: "Z",     s: "bit", m: 0x0010, x: 84.0, y: 31.9, w: 1.02, c: "d-z" },
      { d: "up",      s: "jy+", x: 94.9, y: 39.7, w: 1.02 },
      { d: "up",      s: "cy+", x: 70.0, y: 55.8, w: 1.02, c: "d-c" },
      { d: "left",    s: "cx-", x: 59.9, y: 68.1, w: 1.02, c: "d-c" },
      { d: "right",   s: "cx+", x: 80.1, y: 68.1, w: 1.02, c: "d-c" },
      { lbl: "A",     s: "bit", m: 0x0100, x: 70.0, y: 79.3, w: 1.12, c: "d-a" },
      { d: "down",    s: "cy-", x: 59.9, y: 90.5, w: 1.02, c: "d-c" }
    ];

    function modded(c) {
      var mag = Math.sqrt(c.joy_x * c.joy_x + c.joy_y * c.joy_y);
      return mag > MOD_LO && mag < MOD_HI;
    }

    function trig(c) { return Math.max(c.trigger_l, c.trigger_r); }
    function clicked(c) { return (c.buttons & (L_BIT | R_BIT)) !== 0; }

    function digOn(d, c) {
      var ax = Math.abs(c.joy_x), ay = Math.abs(c.joy_y);
      switch (d.s) {
        case "bit":  return (c.buttons & d.m) !== 0;
        case "jx-":  return c.joy_x <= -DIR_ON;
        case "jx+":  return c.joy_x >= DIR_ON;
        case "jy-":  return c.joy_y <= -DIR_ON;
        case "jy+":  return c.joy_y >= DIR_ON;
        case "cx-":  return c.c_x <= -DIR_ON;
        case "cx+":  return c.c_x >= DIR_ON;
        case "cy-":  return c.c_y <= -DIR_ON;
        case "cy+":  return c.c_y >= DIR_ON;
        // Magnitude decides WHETHER a mod is active; the larger axis decides WHICH, so the two
        // never light together.
        case "modx": return modded(c) && ax >= ay;
        case "mody": return modded(c) && ay > ax;
        case "ls":   return !clicked(c) && trig(c) >= LS_LO && trig(c) < LS_HI;
        case "ms":   return !clicked(c) && trig(c) >= MS_LO && trig(c) < MS_HI;
      }
      return false;
    }

    var IBTN = [
      { k: "A", m: 0x0100, c: "b-a", x: 77, y: 57, w: 1.5,  h: 1.5,  r: "50%" },
      { k: "B", m: 0x0200, c: "b-b", x: 61, y: 78, w: 0.95, h: 0.95, r: "50%" },
      { k: "X", m: 0x0400, c: "b-x", x: 94, y: 47, w: 0.72, h: 1.2,  r: "0.36em" },
      { k: "Y", m: 0x0800, c: "b-y", x: 70, y: 24, w: 1.2,  h: 0.72, r: "0.36em" },
      { k: "Z", m: 0x0010, c: "b-z", x: 87, y: 9,  w: 1.35, h: 0.44, r: "0.22em" }
    ];
    // Digital L/R (the click at the bottom of the trigger) ride on the analog bars.
    var L_BIT = 0x0040, R_BIT = 0x0020;

    var inputsEl = document.getElementById("inputs");
    var iSrc = null, iPort = 0, iSkin = "", iEls = null;

    function px(v) { return v + "em"; }

    function buildInputDom(skin) {
      if (iSkin === skin && iEls) return;
      iSkin = skin;
      var h = "", i, b;
      if (skin === "digital") {
        h += '<div class="inp-dig">';
        for (i = 0; i < DIG.length; i++) {
          var d = DIG[i];
          var inner = d.d
            ? '<svg viewBox="0 0 24 24" style="transform:rotate(' + ROT[d.d] + 'deg)"><path d="'
              + ARROW + '"/></svg>'
            : '<s class="' + (d.small ? "sm" : "") + '">' + d.lbl + "</s>";
          h += '<div class="dbtn ' + (d.c || "") + '" style="left:' + d.x + "%;top:" + d.y
             + "%;width:" + d.w + "em;height:" + d.w + 'em">' + inner + "</div>";
        }
        h += "</div>";
      } else if (skin === "20xx") {
        // Pixel layout of m-overlay's 20XX skin at 0.02em per unit, origin shifted to its
        // top-left (its L bar sits at y=24, so everything is offset by that).
        h += '<div class="inp-20">';
        h += '<div class="xtrig" style="left:0.24em;top:0;width:1.68em;height:0.48em"><i></i></div>';
        h += '<div class="xtrig" style="left:2.9em;top:0;width:1.68em;height:0.48em"><i class="flip"></i></div>';
        h += '<div class="xgate" style="left:0;top:0.64em;width:1.92em;height:1.92em"></div>';
        h += '<div class="xgate c" style="left:4.98em;top:0.64em;width:1.92em;height:1.92em"></div>';
        h += '<div class="xbtn" style="left:2.9em;top:0.64em;width:1.28em;height:0.48em"></div>';
        h += '<div class="xbtn x-z" style="left:4.34em;top:0.64em;width:0.48em;height:0.48em"></div>';
        h += '<div class="xbtn x-a" style="left:2.9em;top:1.28em;width:1.28em;height:1.28em"></div>';
        h += '<div class="xbtn" style="left:4.34em;top:1.28em;width:0.48em;height:1.28em"></div>';
        h += '<div class="xbtn x-b" style="left:2.1em;top:2.24em;width:0.64em;height:0.64em"></div>';
        h += '<div class="xdot" style="left:0.8em;top:1.44em"></div>';
        h += '<div class="xdot c" style="left:5.78em;top:1.44em"></div>';
        h += "</div>";
      } else {
        h += '<div class="inp-ctl">';
        h += '<div class="istick" style="left:15.5%;top:57%;width:2.1em;height:2.1em"><i style="width:0.46em;height:0.46em;margin:-0.23em 0 0 -0.23em"></i></div>';
        h += '<div class="istick c" style="left:42%;top:61%;width:1.6em;height:1.6em"><i style="width:0.38em;height:0.38em;margin:-0.19em 0 0 -0.19em"></i></div>';
        for (i = 0; i < IBTN.length; i++) {
          b = IBTN[i];
          h += '<div class="ibtn ' + b.c + '" style="left:' + b.x + "%;top:" + b.y + "%;width:"
             + px(b.w) + ";height:" + px(b.h) + ";border-radius:" + b.r + '"><s>' + b.k + "</s></div>";
        }
        h += '<div class="itrig" style="left:15.5%;top:7%;width:1.9em;height:0.52em"><i></i><u>L</u></div>';
        h += '<div class="itrig" style="left:42%;top:7%;width:1.9em;height:0.52em"><i></i><u>R</u></div>';
        h += "</div>";
      }
      inputsEl.innerHTML = h;
      scheduleSize();
      if (skin === "digital") {
        iEls = { digital: true, btn: inputsEl.querySelectorAll(".dbtn"), on: [] };
        for (i = 0; i < DIG.length; i++) iEls.on.push(false);
      } else if (skin === "20xx") {
        var xb = inputsEl.querySelectorAll(".xbtn");
        var xd = inputsEl.querySelectorAll(".xdot");
        var xt = inputsEl.querySelectorAll(".xtrig");
        // Document order of .xbtn above: Y, Z, A, X, B.
        iEls = {
          joy: xd[0], c: xd[1],
          btn: [xb[2], xb[4], xb[3], xb[0], xb[1]],   // reordered to IBTN order: A B X Y Z
          lTrack: xt[0], rTrack: xt[1],
          l: xt[0] ? xt[0].querySelector("i") : null,
          r: xt[1] ? xt[1].querySelector("i") : null,
          joyR: 0.8, cR: 0.8, square: true, on: []
        };
      } else {
        var sticks = inputsEl.querySelectorAll(".istick > i");
        var btns = inputsEl.querySelectorAll(".ibtn");
        var trigs = inputsEl.querySelectorAll(".itrig");
        iEls = {
          joy: sticks[0], c: sticks[1],
          btn: btns,
          lTrack: trigs[0], rTrack: trigs[1],
          l: trigs[0] ? trigs[0].querySelector("i") : null,
          r: trigs[1] ? trigs[1].querySelector("i") : null,
          // Travel radius in em — the dot must stay inside its gate.
          joyR: 0.76, cR: 0.58, square: false, on: []
        };
      }
      if (!iEls.digital) { for (i = 0; i < IBTN.length; i++) iEls.on.push(false); }
    }

    // 20XX draws its gates as SQUARES, so the circular stick range has to be mapped onto a
    // square or the dot never reaches a corner. Same mapping the original skin uses.
    function sq(a, b) {
      var r2 = Math.SQRT2;
      var t1 = 2 + a * a - b * b + 2 * a * r2;
      var t2 = 2 + a * a - b * b - 2 * a * r2;
      return 0.5 * Math.sqrt(t1 < 0 ? 0 : t1) - 0.5 * Math.sqrt(t2 < 0 ? 0 : t2);
    }

    // Pick which port to draw. "plugged" is 255 on an empty port (empirical — see dolphin.rs),
    // so prefer a present one; fall back to the first port so a wrong guess still shows
    // something rather than nothing.
    function pickPort(list) {
      if (!list || !list.length) return null;
      for (var i = 0; i < list.length; i++) if (list[i].plugged !== 255) return list[i];
      return list[0];
    }

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    function drawInputs(snap, skin) {
      if (!snap || !snap.controllers) { inputsEl.hidden = true; return; }
      var c = pickPort(snap.controllers);
      if (!c) { inputsEl.hidden = true; return; }
      buildInputDom(skin);
      inputsEl.style.fontSize = (iScale || 1.6) + "rem";
      if (inputsEl.hidden) { inputsEl.hidden = false; scheduleSize(); }
      var e = iEls;

      if (e.digital) {
        for (var d = 0; d < DIG.length; d++) {
          var de = e.btn[d];
          if (!de) continue;
          var don = digOn(DIG[d], c);
          if (don !== e.on[d]) { e.on[d] = don; de.classList.toggle("on", don); }
        }
        return;
      }

      // 20XX uses square gates, so circular stick coords are remapped to reach the corners.
      var jx = e.square ? sq(c.joy_x, c.joy_y) : c.joy_x;
      var jy = e.square ? sq(c.joy_y, c.joy_x) : c.joy_y;
      var cx = e.square ? sq(c.c_x, c.c_y) : c.c_x;
      var cy = e.square ? sq(c.c_y, c.c_x) : c.c_y;
      // y is negated: stick up is negative screen y.
      e.joy.style.transform = "translate(" + (jx * e.joyR) + "em," + (-jy * e.joyR) + "em)";
      e.c.style.transform = "translate(" + (cx * e.cR) + "em," + (-cy * e.cR) + "em)";

      var al = clamp01(c.trigger_l), ar = clamp01(c.trigger_r);
      if (e.l) e.l.style.width = Math.round(al * 100) + "%";
      if (e.r) e.r.style.width = Math.round(ar * 100) + "%";
      // The digital click is a separate bit from the analog value — you can bottom out the
      // analog without clicking, and lightshield is exactly that case.
      // classList.toggle, not className: the two skins give these elements different base
      // classes, and rewriting className would wipe whichever skin's colours are in play.
      if (e.lTrack) e.lTrack.classList.toggle("on", (c.buttons & L_BIT) !== 0);
      if (e.rTrack) e.rTrack.classList.toggle("on", (c.buttons & R_BIT) !== 0);

      for (var i = 0; i < IBTN.length; i++) {
        var el = e.btn[i];
        if (!el) continue;
        var on = (c.buttons & IBTN[i].m) !== 0;
        // Touch the DOM only on change: toggling every button every frame invalidates style on
        // all of them 60 times a second for nothing.
        if (on !== e.on[i]) { e.on[i] = on; el.classList.toggle("on", on); }
      }
    }

    // No game to read: draw the chosen skin with nothing pressed rather than hiding it.
    //
    // ⚠ Hiding was the first behaviour and it is worse: the overlay REFLOWS the moment Melee
    // starts, so everything below the viewer jumps mid-stream. An unlit controller holds the
    // layout and reads as "not playing yet", which is what it is.
    var NEUTRAL = {
      port: 0, buttons: 0, joy_x: 0, joy_y: 0, c_x: 0, c_y: 0,
      trigger_l: 0, trigger_r: 0, plugged: 0
    };
    function idleInputs() {
      drawInputs({ game_id: "", controllers: [NEUTRAL] }, iCurSkin);
    }

    function syncInputStream(s) {
      var want = s && s.inputPort > 0 && vis(s, "inputs");
      var skin = (s && s.inputSkin) || "controller";
      if (!want) {
        if (iSrc) { iSrc.close(); iSrc = null; iPort = 0; }
        inputsEl.hidden = true;
        return;
      }
      // A skin change has to rebuild the DOM even though the stream is fine.
      if (skin !== iSkin) { iEls = null; iSkin = ""; buildInputDom(skin); }
      iCurSkin = skin;
      iScale = (s && s.inputScale) || 1.6;
      if (iSrc && iPort === s.inputPort) return;
      if (iSrc) { iSrc.close(); iSrc = null; }
      iPort = s.inputPort;
      try {
        iSrc = new EventSource("http://127.0.0.1:" + iPort + "/");
        iSrc.onmessage = function (ev) {
          // "null" is meaningful: Dolphin closed or no game booted. Hide, don't freeze on the
          // last frame, or the overlay shows inputs for a game that isn't running.
          if (ev.data === "null") { idleInputs(); return; }
          try { drawInputs(JSON.parse(ev.data), iCurSkin); } catch (err) {}
        };
        // EventSource reconnects on its own; just stop drawing stale state meanwhile.
        iSrc.onerror = function () { idleInputs(); };
      } catch (err) { iSrc = null; iPort = 0; }
    }
    var iCurSkin = "controller";
    var iScale = 1.6;
    // Report the real content height to whoever embeds this page (the in-app preview iframe), so
    // the preview box fits instead of clipping. The OBS Browser Source ignores this: it has no
    // parent and postMessage to self is harmless.
    //
    // ⚠ Only ever used to GROW the box. html font-size is 4vmin, so if the embedder shrank height
    // below width the font would shrink -> content shrinks -> height shrinks: an oscillation.
    // While height >= width, vmin stays pinned to width and the measurement is stable.
    var lastPostedH = -1, sizeTimer = null;
    function postSize() {
      try {
        var r = document.getElementById("root").getBoundingClientRect();
        var inp = document.getElementById("inputs");
        // The viewer is bottom-pinned and out of flow, so its height has to be ADDED to the
        // panel's rather than max()'d with it — otherwise the box reserves no room for it.
        var h = r.bottom;
        if (inp && !inp.hidden) h += inp.getBoundingClientRect().height + 6;
        h = Math.ceil(h);
        if (h > 0 && Math.abs(h - lastPostedH) > 2) {
          lastPostedH = h;
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ __srsOverlayHeight: h }, "*");
          }
        }
      } catch (e) {}
    }
    // Debounced: called after renders and skin changes, never per input frame.
    function scheduleSize() {
      if (sizeTimer) return;
      sizeTimer = setTimeout(function () { sizeTimer = null; postSize(); }, 60);
    }

    function render() {
      // Layout-specific root scale (see html.side in CSS).
      if (latest) document.documentElement.className = latest.layout === "sidebyside" ? "side" : "";
      var h = buildHtml(latest);
      if (h === lastHtml) return;
      root.innerHTML = h;
      lastHtml = h;
      // Mark the grade animated so later re-renders (e.g. when the MMR delta lands) don't re-spin it.
      if (postSet && postSetData && postSetData.gradeLetter) animatedSetId = postSetData.setId;
      scheduleSize();
    }

    function endPostSet() {
      clearTimeout(holdTimer); holdTimer = null;
      postSet = false; postSetData = null;
      render();
    }

    function apply(s) {
      // If the overlay page on disk changed (new app version / build), reload so the new look
      // shows without a manual OBS "Refresh". The app stamps every state with the current page
      // version; PAGE_VERSION is baked into this loaded page (live page only — the in-app preview
      // omits it, so this is a no-op there). Cache-bust via a query so CEF re-reads stats.html.
      if (s && s.htmlVersion && typeof PAGE_VERSION !== "undefined" && s.htmlVersion !== PAGE_VERSION) {
        location.replace(location.href.split("?")[0] + "?v=" + s.htmlVersion);
        return;
      }
      latest = s;
      syncInputStream(s);
      if (firstApply) { firstApply = false; if (s && s.lastSet) shownSetId = s.lastSet.setId; }
      if (s && s.opponent) {
        // a new ranked set is live — drop the post-set hold
        if (postSet) endPostSet();
      } else if (postSet && (!s || !s.lastSet)) {
        // the app cleared the completed set (a new game/set is starting) — dismiss the bridge
        // early so the next set takes priority, even while the 3-min hold would otherwise run.
        endPostSet();
      } else if (s && s.lastSet && s.lastSet.setId !== shownSetId) {
        // a set just completed — hold the result + grade until the next set or POSTSET_MS.
        // (The MMR climb still shows live in the Today's block once the rating refetches.)
        shownSetId = s.lastSet.setId;
        postSet = true; postSetData = s.lastSet;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(endPostSet, POSTSET_MS);
      }
      render();
    }

    function poll() {
      var sc = document.createElement("script");
      sc.src = "stats-state.js?t=" + Date.now();
      sc.onload = sc.onerror = function () { sc.remove(); apply(window.__SRS_STATS); };
      document.head.appendChild(sc);
    }

    ${boot}
  </script>
</body>
</html>
`;
}

/** Fingerprint of the rendered page (CSS + render JS), independent of the per-page boot string and
 *  the version stamp itself — so it changes only when the overlay's look/markup changes, not on
 *  every state write. Written into each state file as `htmlVersion`; the loaded page compares it to
 *  its baked PAGE_VERSION and reloads when they differ. Exported so the app re-writes stats.html
 *  whenever it changes (keeping disk in sync before announcing the new version → no reload loop). */
export const OVERLAY_VERSION = hashStr(overlayDoc("/* version probe */"));

/** The live OBS overlay page: polls stats-state.js and animates on changes. PAGE_VERSION is baked
 *  in so the page can detect a newer stats.html on disk and self-reload (see apply()). */
const STATS_HTML = overlayDoc(
  'var PAGE_VERSION = "' + OVERLAY_VERSION + '";\n    poll();\n    setInterval(poll, POLL_MS);'
);

/** Self-contained overlay HTML with the payload baked in (no polling) — the in-app preview.
 *  It's written to disk as preview.html and loaded into the preview iframe via the asset
 *  protocol. That matters two ways: (1) a real-URL navigation does NOT inherit the app's strict
 *  CSP, so the inline <script> runs — a `srcdoc` iframe would be blocked by `script-src 'self'`;
 *  (2) the asset protocol encodes the whole file path into one URL segment, which breaks the
 *  live page's relative `stats-state.js` fetch — baking the payload in sidesteps that entirely.
 *  The preview can't drift from OBS: it runs the exact same render code as the live overlay. */
export function overlayPreviewHtml(payload: StatsOverlayPayload): string {
  const boot =
    "var __p = " + jsonForScript(payload) + ";\n" +
    "    latest = __p;\n" +
    "    firstApply = false;\n" +
    "    if (__p && __p.lastSet) { shownSetId = __p.lastSet.setId; postSet = true; postSetData = __p.lastSet; }\n" +
    // ⚠ The preview sets `latest` and calls render() directly instead of going through
    // apply(), so anything apply() drives must be started here too. The input viewer is the
    // first such thing: without this line it works on the real OBS overlay and is invisible in
    // the in-app preview, i.e. invisible in the only place it can be checked without playing.
    "    syncInputStream(__p);\n" +
    "    render();";
  return overlayDoc(boot);
}

const INITIAL_STATE = `// Written by Slippi Ranked Stats — live ranked stats overlay.\nwindow.__SRS_STATS = null;\n`;

/** Ensure the overlay dir + a fresh stats.html and a reset stats-state.js exist.
 *  Called when the overlay is enabled. We always rewrite stats.html so styling + medal
 *  updates ship, and reset the state so nothing stale shows on first load. */
export async function ensureStatsOverlayFiles(): Promise<void> {
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(`${DIR}/stats.html`, STATS_HTML, { baseDir: BaseDirectory.AppData });
  await writeTextFile(`${DIR}/stats-state.js`, INITIAL_STATE, { baseDir: BaseDirectory.AppData });
}

/** Write the current live-stats payload so the panel re-renders. Stamps the current page version
 *  (htmlVersion) so a stale OBS page reloads itself after the app ships a new overlay build. */
export async function writeStatsOverlayState(payload: StatsOverlayPayload): Promise<void> {
  const body = `// Written by Slippi Ranked Stats.\nwindow.__SRS_STATS = ${jsonForScript({ ...payload, htmlVersion: OVERLAY_VERSION })};\n`;
  await writeTextFile(`${DIR}/stats-state.js`, body, { baseDir: BaseDirectory.AppData });
}

/** Absolute path to stats.html, for display + the OBS Browser Source. */
export async function statsOverlayHtmlPath(): Promise<string> {
  return await join(await appDataDir(), DIR, "stats.html");
}

/** Write the baked preview page for the in-app iframe (separate from the OBS stats.html, which
 *  keeps polling). Rewritten whenever the preview payload changes. */
export async function writeStatsOverlayPreviewFile(payload: StatsOverlayPayload): Promise<void> {
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(`${DIR}/preview.html`, overlayPreviewHtml(payload), { baseDir: BaseDirectory.AppData });
}

/** Absolute path to preview.html, loaded into the in-app preview iframe via convertFileSrc. */
export async function statsOverlayPreviewPath(): Promise<string> {
  return await join(await appDataDir(), DIR, "preview.html");
}
