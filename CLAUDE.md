# Claude Code Instructions — Slippi Ranked Stats

## Commits

**NEVER add a Co-Authored-By tag, Signed-off-by, or any line that references Claude or an Anthropic email address to any git commit.**

This causes Claude to appear in the GitHub contributor list. Removing it requires deleting and recreating the branch, which takes a full day for GitHub's cache to clear. There are no exceptions to this rule regardless of how large or complex the change is.

## Security

**NEVER read, print, or otherwise access sensitive files** including `.env`, `.env.*`, `*.pem`, `*.key`, `*.secret`, `credentials.*`, or any file that may contain secrets, API keys, tokens, or passwords. If a task seems to require reading one of these files, stop and ask the user how to proceed instead.

## General

- Read `docs/dev_notes.md` at the start of each session — it is the cross-session handoff document.
- The Set Grading feature ships as a **Premium** feature, gated by `$isPremium` (live since v1.6.0) — it is **not** dev-only.
- The OBS **Live Stats Overlay** ships as a **Premium** feature (live since v1.8.0), gated by `$isPremium` + the in-app toggle. Server-less: the app writes `stats.html` + `stats-state.js` to `<appDataDir>/stream-overlay/` and OBS loads it as a Browser Source. It's an **always-on panel** (tag / rank medal / MMR + session delta / global placement / season W/L / today's session record, opponent line during a set) with a **post-set bridge** that shows the set result + grade + MMR change when a ranked set ends. The **opponent line** (live since v1.8.2) shows the opponent's tag, rank medal + tier-colored name, MMR, and season W–L (green/red) — all from the same `fetchRatingSnapshot(opponentCode)` call already made on set start (`opponent_tier_color`/`opponent_tag`/`opponent_season_*` on `ActiveSet`). **It replaced the standalone v1.7.0 Set Grade Overlay** — the grade is now folded in, and `src/lib/overlay.ts` was removed. Code: `src/lib/stats-overlay.ts` (+ `overlayPreviewHtml` for the in-app iframe preview), `src/lib/rank-medals.ts` (official Slippi rank SVGs in `src/assets/ranks/`, inlined), `statsOverlayPayload`/`statsOverlayPreview` in `store.ts`, app-level write in `App.svelte`.
- Before building anything that touches grade history persistence or premium gating, discuss the approach first.

## Working across machines

This repo is developed on more than one machine, and **git is the only thing that syncs.** Claude's auto-memory (`~/.claude/`), the app's local SQLite DBs, and `.venv/` do NOT travel between machines — never treat memory as shared truth (that's how the "grading is dev-only" note went stale).

- **Start of session:** `git pull`, read `docs/dev_notes.md` (handoff banner + NEXT UP), then `git status`.
- **End of session:** commit + push everything. If a feature's status or gating changed, update this file in the **same commit**.
- Full checklist + what does/doesn't travel: `docs/dev_notes.md` → "Cross-machine workflow".
