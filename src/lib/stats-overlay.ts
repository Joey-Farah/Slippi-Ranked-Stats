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
import type { StatsOverlayPayload } from "./store";

const DIR = "stream-overlay";

// Inlined into the page as `var MEDALS = {...}`. JSON.stringify escapes the SVG markup
// safely; the SVGs contain no backticks, "${", or "</script>".
const MEDALS_JSON = JSON.stringify(RANK_MEDAL_SVGS);

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
    .medal { width: 3.7rem; height: 3.7rem; flex-shrink: 0; }
    .medal svg { width: 100%; height: 100%; display: block; filter: drop-shadow(0 0.1em 0.2em rgba(0, 0, 0, 0.6)); }
    .rank { font-size: 1.25rem; font-weight: 800; letter-spacing: 0.06em; }
    .mmr { font-size: 1.9rem; font-weight: 800; line-height: 1.05; }
    .mmr-delta { font-size: 1.05rem; font-weight: 800; }
    .global { font-size: 0.95rem; font-weight: 700; opacity: 0.96; }
    .season { font-size: 1.15rem; font-weight: 800; }
    .season .l { margin-left: 0.75rem; }
    .w { color: #2ecc71; } .l { color: #ff4d4f; }
    .vs { font-size: 1.05rem; font-weight: 700; margin-top: 0.3rem; padding: 0.2rem 0.75rem;
      border-radius: 0.5rem; background: rgba(255, 255, 255, 0.1); }
    .vs-sub { font-size: 0.85rem; font-weight: 700; opacity: 0.95; margin-top: 0.15rem; }
    .vs-medal { display: inline-block; width: 1.25em; height: 1.25em; vertical-align: -0.32em; margin-right: 0.18em; }
    .vs-medal svg { width: 100%; height: 100%; display: block;
      filter: drop-shadow(0 0.05em 0.12em rgba(0, 0, 0, 0.55)); }
    .vs-rank { font-weight: 800; }
    .setresult { font-size: 1.25rem; font-weight: 800; letter-spacing: 0.03em; margin-top: 0.2rem; }
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
    .side-head .medal { width: 5rem; height: 5rem; }
    .side-id { display: flex; flex-direction: column; align-items: center; text-align: center; line-height: 1.15; }
    .side-id .rank { font-size: 1.2rem; }
    .side-id .global { font-size: 1rem; }
    .persist { display: flex; align-items: center; justify-content: center; gap: 1.4rem; flex-wrap: nowrap; }
    .vdivider { width: 2px; align-self: stretch; min-height: 3rem;
      background: linear-gradient(180deg, transparent, rgba(255, 255, 255, 0.4), transparent); }
    /* today's stats (right column) — holds the MMR now, so it's sized to match the left */
    .today-block { display: flex; flex-direction: column; align-items: center; }
    .today-block .today-label { font-size: 1.2rem; margin-bottom: 0.1rem; }
    .today-block .mmr { font-size: 2rem; }
    .today-wl { display: flex; gap: 1.2rem; font-size: 1.3rem; font-weight: 800; margin-top: 0.15rem; }
    .transient { display: flex; flex-direction: column; align-items: center; }
    /* post-set moment: a labelled grade beside the result text */
    .setblock { display: flex; align-items: center; justify-content: center; gap: 0.9rem; }
    .setinfo { display: flex; flex-direction: column; align-items: flex-start; }
    .gradewrap { display: flex; flex-direction: column; align-items: center; }
    .gradewrap .grade { margin: 0; }
    .gradelabel { font-size: 0.72rem; font-weight: 800; letter-spacing: 0.14em; color: rgba(255, 255, 255, 0.8); }
    /* Standout category under the grade — best on a win, worst on a loss. Readable but
       clearly secondary to the big grade letter. */
    .subgrade { font-size: 1.3rem; font-weight: 800; line-height: 1.2; text-align: center; max-width: 9rem; }
    .subgrade .subcap { display: block; font-size: 0.8rem; font-weight: 800; letter-spacing: 0.1em; color: rgba(255, 255, 255, 0.65); margin-bottom: 0.1rem; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    var POLL_MS = 500;
    var POSTSET_MS = 180000; // hold the set result + grade until the next set starts or 3 min passes

    var GRADE_COLORS = { S: "#FF1493", A: "#00C853", B: "#00B0FF", C: "#FFC400", D: "#FF7300", F: "#FF1744" };
    var MEDALS = ${MEDALS_JSON};

    var root = document.getElementById("root");
    var latest = null, lastHtml = "";
    var firstApply = true, shownSetId = null;
    var postSet = false, postSetData = null, animatedSetId = null;
    var holdTimer = null;

    function esc(t) { var d = document.createElement("div"); d.textContent = String(t); return d.innerHTML; }
    function fmt1(n) { return (Math.round(n * 10) / 10).toFixed(1); }
    function fmtDelta(d) { return (d >= 0 ? "+" : "") + fmt1(d); }

    function medalHtml(s) { return '<div class="medal">' + (MEDALS[s.rankName] || MEDALS["Unranked"] || "") + "</div>"; }
    function rankHtml(s) { return '<div class="rank" style="color:' + esc(s.rankColor) + '">' + esc((s.rankName || "").toUpperCase()) + "</div>"; }

    function mmrHtml(s) {
      if (s.rating == null) return "";
      var extra = "";
      // Session MMR change stays beside the MMR all session (not just during the post-set moment).
      // Signed (+/-) AND colored so the direction reads at a glance even on a busy stream.
      if (s.sessionDelta != null) {
        var up = s.sessionDelta >= 0;
        extra = ' <span class="mmr-delta" style="color:' + (up ? "#2ecc71" : "#ff4d4f") + '">' + fmtDelta(s.sessionDelta) + "</span>";
      }
      return '<div class="mmr">' + fmt1(s.rating) + extra + "</div>";
    }

    function globalHtml(s) {
      if (s.globalRank == null) return "";
      return '<span class="global">#' + esc(s.globalRank) + (s.region ? " [" + esc(s.region) + "]" : "") + "</span>";
    }

    function seasonHtml(s) {
      if (s.seasonWins == null || s.seasonLosses == null) return "";
      return '<span class="season"><span class="w">W: ' + esc(s.seasonWins) + '</span><span class="l">L: ' + esc(s.seasonLosses) + "</span></span>";
    }

    function contextHtml(s, side) {
      if (postSet && postSetData) {
        var won = postSetData.result === "win";
        var gradeEl = "", subEl = "";
        if (postSetData.gradeLetter) {
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
        var vsEl = '<div class="vs">vs ' + esc(postSetData.opponentCode) + " · " + esc(postSetData.opponentChar) + "</div>";
        if (side) return '<div class="setblock">' + gradeEl + subEl + '<div class="setinfo">' + resEl + vsEl + "</div></div>";
        return gradeEl + subEl + resEl + vsEl;
      }
      if (s.opponent) {
        var o = s.opponent;
        // Line 1: tag (code) · char — the tag is what a viewer recognizes; the code disambiguates.
        var name = o.tag ? esc(o.tag) + " (" + esc(o.code) + ")" : esc(o.code);
        var l1 = "vs " + name + " · " + esc(o.char);
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
        if (o.rating != null) parts.push(fmt1(o.rating) + " MMR");
        if (o.seasonWins != null && o.seasonLosses != null) {
          parts.push('<span class="w">' + esc(o.seasonWins) + 'W</span>–<span class="l">' + esc(o.seasonLosses) + "L</span>");
        }
        parts.push("(" + esc(o.gamesWon) + "–" + esc(o.gamesLost) + ")");
        return '<div class="vs">' + l1 + '<div class="vs-sub">' + parts.join(" · ") + "</div></div>";
      }
      return "";
    }

    function todayHtml(s) {
      var startTxt = s.sessionStartRating != null ? fmt1(s.sessionStartRating) : (s.rating != null ? fmt1(s.rating) : "—");
      var deltaTxt = "";
      if (s.sessionDelta != null) {
        deltaTxt = ' <span style="color:' + (s.sessionDelta >= 0 ? "#2ecc71" : "#ff4d4f") + '">(' + fmtDelta(s.sessionDelta) + ")</span>";
      }
      return '<div class="today-label">Today&#39;s stats</div>'
        + '<div class="today-row"><span class="w">W: ' + esc(s.sessionWins) + "</span>"
        + "<span>" + startTxt + deltaTxt + "</span>"
        + '<span class="l">L: ' + esc(s.sessionLosses) + "</span></div>";
    }

    function buildStacked(s) {
      var h = '<div class="panel">';
      h += '<div class="tag">' + esc(s.tag) + "</div>";
      h += medalHtml(s) + rankHtml(s) + mmrHtml(s);
      h += globalHtml(s) + seasonHtml(s);
      h += contextHtml(s, false);
      h += '<div class="divider"></div>' + todayHtml(s);
      h += "</div>";
      return h;
    }

    function buildSide(s) {
      var h = '<div class="panel">';
      // Persistent top row: identity + global rank (left) | today's stats with the MMR (right).
      h += '<div class="persist">';
      h += '<div class="side-head">' + medalHtml(s)
        + '<div class="side-id">'
        + '<div class="tag">' + esc(s.tag) + "</div>"
        + rankHtml(s) + globalHtml(s) + seasonHtml(s)
        + "</div></div>";
      h += '<div class="vdivider"></div>';
      h += '<div class="today-block">'
        + '<div class="today-label">Today&#39;s stats</div>'
        + mmrHtml(s)
        + '<div class="today-wl"><span class="w">W: ' + esc(s.sessionWins) + '</span><span class="l">L: ' + esc(s.sessionLosses) + "</span></div>"
        + "</div>";
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
      latest = s;
      if (firstApply) { firstApply = false; if (s && s.lastSet) shownSetId = s.lastSet.setId; }
      if (s && s.opponent) {
        // a new ranked set is live — drop the post-set hold
        if (postSet) endPostSet();
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

/** The live OBS overlay page: polls stats-state.js and animates on changes. */
const STATS_HTML = overlayDoc("poll();\n    setInterval(poll, POLL_MS);");

/** Self-contained overlay HTML with a fixed payload baked in (no polling) — renders the
 *  exact overlay markup for the in-app live preview, so the preview can never drift from it.
 *  Unlike the live overlay (whose first poll suppresses a pre-existing set so OBS doesn't
 *  replay a stale grade on load), the preview is explicitly asked to show THIS payload — so
 *  if it carries a completed set we activate the post-set bridge directly rather than going
 *  through apply()'s first-call guard (which would record the set as "already shown"). */
export function overlayPreviewHtml(payload: StatsOverlayPayload): string {
  const boot =
    "var __p = " + JSON.stringify(payload) + ";\n" +
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

/** Write the current live-stats payload so the panel re-renders. */
export async function writeStatsOverlayState(payload: StatsOverlayPayload): Promise<void> {
  const body = `// Written by Slippi Ranked Stats.\nwindow.__SRS_STATS = ${JSON.stringify(payload)};\n`;
  await writeTextFile(`${DIR}/stats-state.js`, body, { baseDir: BaseDirectory.AppData });
}

/** Absolute path to stats.html, for display + the OBS Browser Source. */
export async function statsOverlayHtmlPath(): Promise<string> {
  return await join(await appDataDir(), DIR, "stats.html");
}
