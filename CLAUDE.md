# Claude Code Instructions — Slippi Ranked Stats

## Commits

**NEVER add a Co-Authored-By tag, Signed-off-by, or any line that references Claude or an Anthropic email address to any git commit.**

This causes Claude to appear in the GitHub contributor list. Removing it requires deleting and recreating the branch, which takes a full day for GitHub's cache to clear. There are no exceptions to this rule regardless of how large or complex the change is.

## Security

**NEVER read, print, or otherwise access sensitive files** including `.env`, `.env.*`, `*.pem`, `*.key`, `*.secret`, `credentials.*`, or any file that may contain secrets, API keys, tokens, or passwords. If a task seems to require reading one of these files, stop and ask the user how to proceed instead.

## General

- Read `docs/dev_notes.md` at the start of each session — it is the cross-session handoff document.
- The grading feature is dev-only. Do not ship or un-gate it without explicit instruction.
- Before building anything that touches grade history persistence or premium gating, discuss the approach first.
