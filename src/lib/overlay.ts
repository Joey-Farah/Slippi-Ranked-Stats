/**
 * overlay.ts — OBS stream-overlay files (server-less; see docs/dev_notes.md).
 *
 * On a completed ranked set the app writes a tiny `state.js` (`{ letter, setId }`)
 * next to a static `overlay.html`. The streamer adds `overlay.html` as an OBS
 * Browser Source; the page watches `state.js` and animates the grade letter in
 * when `setId` changes. No server — just two files in the app-data folder.
 *
 * Files live under `<appDataDir>/stream-overlay/`. appDataDir resolves per-machine
 * from the bundle identifier, so this works wherever the executable lives.
 */
import { appDataDir, join } from "@tauri-apps/api/path";
import { writeTextFile, mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";

const DIR = "stream-overlay";

/** The OBS Browser Source page. Mirrors overlay-prototype/overlay.html (the version
 *  validated in OBS), with its inline script using string concatenation only so it
 *  embeds cleanly here. Edit both together if the look changes. */
const OVERLAY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Slippi Ranked Stats — Set Grade Overlay</title>
  <style>
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
    #stage {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    #card {
      display: flex; flex-direction: column; align-items: center;
      opacity: 0;
      will-change: transform, opacity;
    }
    #caption {
      font-size: 10vh; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase;
      color: rgba(255, 255, 255, 0.9); text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
      margin-bottom: 0.5vh;
    }
    #letter { font-size: 72vh; font-weight: 800; line-height: 1; }
    @keyframes pop-in {
      0%   { opacity: 0; transform: scale(0.3); }
      60%  { opacity: 1; transform: scale(1.12); }
      100% { opacity: 1; transform: scale(1); }
    }
    .show { animation: pop-in 520ms cubic-bezier(0.18, 0.9, 0.32, 1.2) forwards; }
    .fade { opacity: 0 !important; transition: opacity 700ms ease; }
  </style>
</head>
<body>
  <div id="stage">
    <div id="card">
      <div id="caption">Set Grade</div>
      <div id="letter"></div>
    </div>
  </div>
  <script>
    var POLL_MS = 1000;
    var HOLD_MS = 12000;
    // Grade colors — keep in sync with GRADE_COLORS in src/lib/grading.ts.
    var COLORS = { S: "#FF1493", A: "#00C853", B: "#00B0FF", C: "#FFC400", D: "#FF7300", F: "#FF1744" };

    var cardEl = document.getElementById("card");
    var letterEl = document.getElementById("letter");
    var shownSetId = -1;
    var hideTimer = null;

    function reveal(letter) {
      var color = COLORS[letter] || "#FFFFFF";
      letterEl.textContent = letter;
      letterEl.style.color = color;
      letterEl.style.textShadow = letter === "S" ? ("0 0 6vh " + color + "aa") : "none";
      cardEl.classList.remove("show", "fade");
      void cardEl.offsetWidth;
      cardEl.classList.add("show");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { cardEl.classList.add("fade"); }, HOLD_MS);
    }

    function poll() {
      var s = document.createElement("script");
      s.src = "state.js?t=" + Date.now();
      s.onload = s.onerror = function () {
        s.remove();
        var st = window.__SRS;
        if (st && st.letter && st.setId !== shownSetId) {
          shownSetId = st.setId;
          reveal(st.letter);
        }
      };
      document.head.appendChild(s);
    }

    poll();
    setInterval(poll, POLL_MS);
  </script>
</body>
</html>
`;

const INITIAL_STATE = `// Written by Slippi Ranked Stats on each completed ranked set.\nwindow.__SRS = { letter: null, setId: 0 };\n`;

/** Ensure the overlay dir + a fresh overlay.html and an empty state.js exist.
 *  Called when the overlay is enabled. mkdir(recursive) is idempotent; we always
 *  rewrite overlay.html so styling updates ship, and reset state.js to "nothing
 *  shown" so a stale letter doesn't flash on first load. */
export async function ensureOverlayFiles(): Promise<void> {
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(`${DIR}/overlay.html`, OVERLAY_HTML, { baseDir: BaseDirectory.AppData });
  await writeTextFile(`${DIR}/state.js`, INITIAL_STATE, { baseDir: BaseDirectory.AppData });
}

/** Write the current grade letter so the overlay animates. setId changes each call
 *  (Date.now) so the page re-triggers even on a repeat letter. */
export async function writeOverlayState(letter: string | null): Promise<void> {
  const body = `// Written by Slippi Ranked Stats.\nwindow.__SRS = ${JSON.stringify({ letter, setId: Date.now() })};\n`;
  await writeTextFile(`${DIR}/state.js`, body, { baseDir: BaseDirectory.AppData });
}

/** Absolute path to overlay.html, for display + the OBS Browser Source. */
export async function overlayHtmlPath(): Promise<string> {
  return await join(await appDataDir(), DIR, "overlay.html");
}
