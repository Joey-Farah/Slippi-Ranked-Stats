# Slippi Ranked Stats — Domain Language

The shared vocabulary for the app's ranked match data and the Set Grading system.
This file is a glossary only — definitions of what terms *mean*, not how they are
implemented. Scoring formulas and thresholds live in code and `docs/dev_notes.md`.

## Language

**Game**:
A single match between two players, played to a stock count (4 stocks).
_Avoid_: match (ambiguous with Set).

**Set**:
A ranked series of **Games** against one opponent, grouped by `match_id` and played
best-of-3 (first to 2 **Game** wins).
_Avoid_: match, series.

**Stock margin**:
Your stock count minus the opponent's at a given moment in a **Game**; 0 at game
start, positive when you lead, negative when you trail.

**Comeback**:
Climbing your **Stock margin** back up from its worst point in a **Game** (game-level),
or recovering from a **Game** deficit to win the **Set** (set-level). A bigger climb is
a bigger comeback.

**Lead Maintenance**:
Holding a positive **Stock margin** rather than giving it back from its best point in a
**Game**, and closing out a **Set** lead rather than blowing it. The mirror of **Comeback**.

## Relationships

- A **Set** contains one to three **Games** (best-of-3, first to 2 wins).
- Both **Comeback** and **Lead Maintenance** are measured from **Stock margin** only —
  percent never factors in.
- **Comeback** and **Lead Maintenance** are mirror images: one measures climbing up from
  your worst margin, the other measures not sliding down from your best. Both can occur
  in the same **Game** if the lead changes hands.

## Example dialogue

> **Dev:** "If a player goes down two stocks and claws back to even but still loses the
> **Game**, is that a **Comeback**?"
> **Domain expert:** "Yes — a partial one. They erased the whole **Stock margin** deficit,
> so they get strong credit even without the win. Winning the **Game** would scale it
> higher still."

## Flagged ambiguities

- "Comeback rate" / "Lead maintenance" previously meant the *binary* outcome "were you
  ever behind/ahead, and did you win the **Game**" (1 or 0). Resolved: both now mean the
  *degree* of **Stock margin** recovered / retained, a continuous measure.
