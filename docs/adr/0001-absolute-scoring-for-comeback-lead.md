---
status: accepted
date: 2026-05-24
---

# Score Comeback Rate and Lead Maintenance on an absolute curve, not percentile-against-benchmark

Every other graded stat is scored by percentile against the HuggingFace benchmark
distribution (per matchup → per character → overall). **Comeback Rate** and **Lead
Maintenance** deliberately break that pattern: their continuous "degree of stock-margin
recovered / retained" is mapped to a 0–100 score by a fixed absolute curve computed live,
with no benchmark lookup.

We chose this because percentile scoring is what *caused* the bug we're fixing — a binary
0/1 value landed at the 75th percentile of a degenerate distribution and rendered a 0%
comeback as an **S** (and a 0% lead maintenance as an **F**, same set). Climbing out of a
stock deficit is impressive in absolute terms regardless of matchup, so matchup-relativity
adds little here and reintroduces the contradiction risk.

## Considered options

- **Percentile / matchup-aware (rejected for now).** Not flawed in principle — a
  *continuous* value would percentile cleanly, and "is a 2-stock comeback harder in some
  matchups?" is a real question. Rejected because it requires a full ~4-hour HuggingFace
  rescan **and** porting the new stock-margin tracking into `scripts/parse_hf_replays.py`,
  kept byte-for-byte in sync with the live parser — large cost, and it would block the bug
  fix behind it. Banked as a future enhancement.
- **Absolute curve (chosen).** Computed live from the set's games; no benchmark, no rescan,
  no Python parser changes. Comeback + lead maintenance drop out of `grade-benchmarks.ts`
  entirely.

## Consequences

- Only `src/lib/slp_parser.ts` (margin tracking) and `src/lib/grading.ts` (scoring) change.
  The Python pipeline and `grade-benchmarks.ts` thresholds for these two stats become dead.
- We lose matchup-relativity for these two stats. Everything built here (parser
  margin-tracking, the continuous degree value) is the exact input a future matchup-aware
  version would consume, so adding it later is additive, not a rewrite.
- Existing stored grades will need regrading once the scoring logic changes (the stale-grade
  mechanism is keyed on benchmark version; a logic-only change must force a regrade — to be
  handled in implementation).
