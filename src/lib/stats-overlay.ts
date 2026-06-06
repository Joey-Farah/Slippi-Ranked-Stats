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
    #root { position: fixed; inset: 0; display: flex; justify-content: center; align-items: flex-start; }
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
  </style>
</head>
<body>
  <div id="root"></div>
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
        var resEl = '<div class="setresult" style="color:' + (won ? "#2ecc71" : "#ff4d4f") + '">' + (won ? "SET WON" : "SET LOST") + " · " + esc(postSetData.wins) + "–" + esc(postSetData.losses) + "</div>";
        // Opponent char as a stock icon (the char they played this set); text name as fallback.
        var vsChar = charsHtml(postSetData.opponentCharId != null ? [postSetData.opponentCharId] : []);
        var vsTail = vsChar ? " " + vsChar : (postSetData.opponentChar ? " · " + esc(postSetData.opponentChar) : "");
        var vsEl = '<div class="vs">vs ' + esc(postSetData.opponentCode) + vsTail + "</div>";
        // Per-set MMR change — appears once the rating refetch lands (rating moved off
        // ratingBefore). Labelled THIS SET so it's never confused with the session total.
        var setMmrEl = "";
        if (vis(s, "mmr") && s.rating != null && postSetData.ratingBefore != null && s.rating !== postSetData.ratingBefore) {
          var sd = s.rating - postSetData.ratingBefore;
          setMmrEl = '<div class="set-mmr"><span class="setcap">THIS SET</span><span style="color:' + (sd >= 0 ? "#2ecc71" : "#ff4d4f") + '">' + fmtDelta(sd) + "</span></div>";
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
        // Current set score is now its own scoreboard row (below the stats), not tucked at the
        // end of the stats line — your wins green, the opponent's red, so it's clear mid-set.
        var scoreEl = '<div class="vs-score"><span class="vs-score-cap">Set Count:</span><span>' + esc(o.gamesWon) + '</span><span class="vs-score-dash">–</span><span>' + esc(o.gamesLost) + "</span></div>";
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
      h += contextHtml(s, false);
      // The today block carries its own divider only when it's actually shown.
      var today = todayHtml(s);
      if (today) h += '<div class="divider"></div>' + today;
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

    function render() {
      // Layout-specific root scale (see html.side in CSS).
      if (latest) document.documentElement.className = latest.layout === "sidebyside" ? "side" : "";
      var h = buildHtml(latest);
      if (h === lastHtml) return;
      root.innerHTML = h;
      lastHtml = h;
      // Mark the grade animated so later re-renders (e.g. when the MMR delta lands) don't re-spin it.
      if (postSet && postSetData && postSetData.gradeLetter) animatedSetId = postSetData.setId;
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
