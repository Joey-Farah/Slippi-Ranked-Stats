# How Set Grading Works

Every completed ranked set gets a letter grade — **S, A, B, C, D, or F** — based on how your performance compares to community baselines. This page walks through what we measure, how the score is calculated, and where the numbers come from so you can read a grade with confidence.

> **This isn't meant to be a perfect grading system.** It's a tool to help you see where you might be strong and weak across a set — a directional read, not a verdict on your skill. Treat it as a conversation starter with yourself, not a scorecard.

---

## The grade, at a glance

Each set produces:

- An **overall letter** (S–F) and a 0–100 score
- Four **category grades**: Neutral, Punish, Defense, Execution
- A **per-stat breakdown** — 17 scored stats across the four categories (Premium)

Letters map to score thresholds:

| Grade | Score    | Meaning                                    |
|-------|----------|--------------------------------------------|
| **S** | ≥ 75     | Top-tier performance                       |
| **A** | 63 – 74  | Strong — above typical community level     |
| **B** | 52 – 62  | Solid — around the 75th percentile of play |
| **C** | 40 – 51  | Average                                    |
| **D** | 28 – 39  | Below average                              |
| **F** | < 28     | Rough set — expect to see weak stats       |

A grade is **not a rating**. It's not comparing you against the global ladder — it's comparing the specific stats you produced during this set against a snapshot of how Slippi players as a whole perform on those same stats.

---

## What we measure

We score 17 stats grouped into four categories.

### Neutral — 35% of overall

Winning the early game exchange and controlling tempo.

| Stat | What it measures |
|------|-------------------|
| **Neutral Win Rate** | Out of all neutral exchanges, how often you came out ahead |
| **Opening Conversion %** | When you got a hit, how often it turned into stock damage |
| **Stage Control %** | How often you held the center / offensive position |
| **Lead Maintenance %** | When ahead, how often you stayed ahead |
| **Comeback Rate** | How often you recovered from being behind |

### Punish — 35% of overall

Turning openings into stocks.

| Stat | What it measures |
|------|-------------------|
| **Damage / Opening** | Average damage dealt per successful opening |
| **Openings / Kill** | How many openings it took to take each stock (lower is better) |
| **Avg Kill %** | Average percent you took stocks at (lower is better) |
| **Edgeguard %** | Success rate when your opponent was offstage |
| **Tech Chase %** | Success rate following up tech situations |
| **Hit Advantage Rate** | How often you won the beat-to-beat exchange during engagements |

### Defense — 25% of overall

Staying alive and minimizing damage taken.

| Stat | What it measures |
|------|-------------------|
| **Avg Death %** | Average percent you died at |
| **Recovery %** | How often you made it back to stage when offstage |
| **Avg Stock Duration** | How long each of your stocks lasted |
| **Respawn Defense %** | How well you defended immediately after respawning |

### Execution — 5% of overall

Clean technical play.

| Stat | What it measures |
|------|-------------------|
| **L-Cancel %** | Successful L-cancels out of total attempts |
| **Inputs / Min** | Sustained input rate |
| **Missed WD Rate** | Wavedash miss rate (shown but not scored — pending accuracy fix) |

---

## Why these weights?

**Punish and Neutral are weighted highest because they are the primary expression of skill** — converting openings and winning neutral exchanges separate stronger players from weaker ones more than anything else.

**Defense is weighted below them** because it's partly a byproduct of how well you're winning neutral: if you're the one dealing damage, you're also the one not taking it.

**Execution is intentionally small (5%)** because raw technical stats plateau quickly. A top player and a mid-ladder player can both L-cancel at 95%+. Using execution as a tiebreaker rather than a primary axis keeps the grade honest about what actually matters.

Within a category, each stat is weighted equally — except **Inputs / Min**, which is half-weight so it doesn't dominate Execution alongside L-cancels.

---

## How a stat becomes a score

For each stat, we look up where your value falls in the community distribution and interpolate linearly between percentile thresholds. A value at the 50th percentile scores 50. At the 95th, 95. Between thresholds, the score scales proportionally.

**Category score** = weighted average of the stat scores in that category.
**Overall score** = weighted average of the category scores (35/35/25/5).
**Letter** = the overall score mapped through the table above.

### The win bonus

Winning the set adds **+5** to your overall score (capped at 100). Winning reflects adaptability, reads, and in-the-moment decisions that raw stats can't fully capture. Losing a close set won't tank your grade — but the win bonus is there to recognize that wins are themselves evidence of performance.

---

## Baselines — where the numbers come from

Stat percentiles are computed from the **HuggingFace `erickfm/slippi-public-dataset-v3.7` dataset** — a public archive of Slippi replays. We parsed **221,942 ranked replays across all 25 characters** to build the benchmark distributions shipped in the app.

For each of your sets, we look up baselines in a three-tier fallback:

1. **Matchup-specific** — your character × opponent character (most precise, used when ≥20 replays exist for that matchup)
2. **Character** — your character across all opponents (fallback when matchup data is thin)
3. **Overall** — all characters pooled together (last resort)

The grade card tells you which tier was used, so you can see whether your grade is matchup-tuned or falling back to a broader bench.

### A note on kill% and death% baselines

`Avg Kill %` and `Avg Death %` are only scored when character-specific or matchup-specific baselines exist. The pooled "overall" bucket has identical values for both by construction (every kill is also a death in the same dataset), so scoring against it would produce misleading results.

---

## What's excluded, and why

Two stats we parse but don't score:

- **Counter-hit rate** and **defensive option rate** were removed from grading because they're too confounded by opponent quality. Facing a stronger opponent who probes more carefully can actually *lower* your counter-hit rate, which doesn't reflect on your skill.
- **Missed wavedash rate** is currently shown but not scored. The detection logic in the parser was recently rewritten and the benchmark data is being regenerated. When it's in, this stat will be added to the Execution category.

---

## Parser accuracy

Our replay parser matches Slippi Launcher's own methodology (the `@slippi/slippi-js` library) for the stats it computes:

- **Openings / Kill**, **L-Cancel %**: exact match
- **Inputs / Minute**, **Neutral Win Rate**: within ±2 on rollback-affected frames
- **Damage / Opening**: methodology differs slightly (we use peak-percent-per-stock; slippi-js uses per-conversion move damage). Values differ by ~1 on average, but the methodology is consistent across both the benchmark dataset and your live grades, so percentiles remain valid.

Custom stats (stage control, edgeguards, tech chase, hit advantage, recovery, etc.) are not computed by slippi-js — we derive them from frame-by-frame action-state tracking using the same state-ID definitions slippi-js uses.

---

## Limits to keep in mind

- **One set is a small sample.** Your grade reflects how that particular set went, not your overall level. A single C doesn't mean you're a C-tier player; a single S doesn't mean you've arrived. Patterns across many sets are more meaningful than any individual grade.
- **Matchup context isn't fully in the model.** We pick a baseline tier, but we don't adjust for opponent rating within that tier. Losing a close set to a much stronger opponent and losing a close set to a weaker one produce similar grades.
- **Character strengths aren't normalized.** A top-tier character playing into a bottom-tier one will see inflated stats compared to community baselines, and vice versa. Matchup baselines help but don't fully erase this.
- **Grades are relative to the community baseline, not to your personal baseline.** If you're improving, your grades will trend upward regardless of whether your play "felt" good or bad on a given night.

---

## Free vs Premium

- **Free** — every user sees the overall letter, overall score, and which category was strongest / weakest for every graded set.
- **Premium** — adds the full per-category scores, the per-stat breakdown with values and individual grades, matchup-specific baselines, and unlimited grade history.

Grading quality is identical regardless of tier — premium unlocks depth, not accuracy.

---

*Last updated: 2026-04-17*
