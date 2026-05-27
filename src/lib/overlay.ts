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

/** The OBS Browser Source page. This string is the single source of truth for the
 *  overlay (no separate prototype file). Its inline script uses string concatenation
 *  only so it embeds cleanly here. Animation: spin-in on a new setId, hold HOLD_MS,
 *  spin-out. */
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
      font-size: 6vh; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase;
      color: rgba(255, 255, 255, 0.9); text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
      margin-bottom: 0.5vh;
    }
    /* 62vh (not larger) so the spin's 1.1x scale + rotation stays inside the
       viewport — at ~72vh the rotated diagonal clipped against overflow:hidden. */
    #letter { font-size: 62vh; font-weight: 800; line-height: 1; }
    @keyframes spin-in {
      0%   { opacity: 0; transform: rotate(-540deg) scale(0); }
      70%  { opacity: 1; transform: rotate(20deg) scale(1.1); }
      100% { opacity: 1; transform: rotate(0) scale(1); }
    }
    @keyframes spin-out {
      0%   { opacity: 1; transform: rotate(0) scale(1); }
      100% { opacity: 0; transform: rotate(540deg) scale(0); }
    }
    .show { animation: spin-in 720ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards; }
    .hide { animation: spin-out 620ms cubic-bezier(0.6, 0, 0.7, 0.2) forwards; }
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
    var HOLD_MS = 25000;
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
      cardEl.classList.remove("show", "hide");
      void cardEl.offsetWidth;
      cardEl.classList.add("show");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        cardEl.classList.remove("show");
        void cardEl.offsetWidth;   // reflow so the exit animation restarts cleanly
        cardEl.classList.add("hide");
      }, HOLD_MS);
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
