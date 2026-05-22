# How Set Grading Works

Every completed ranked set gets a letter grade — **S, A, B, C, D, or F** — based on how your performance compares to community baselines. This page walks through what we measure, how the score is calculated, and where the numbers come from so you can read a grade with confidence.

> **This isn't meant to be a perfect grading system, and it will evolve.** It's a tool to help you see where you might be strong and weak across a set — a directional read, not a verdict on your skill. The specific stats, weights, and thresholds may change over time as we gather feedback. Treat a grade as a conversation starter with yourself, not a scorecard.

---

## The grade, at a glance

Each set produces:

- An **overall letter** (S–F) and a 0–100 score
- Three **category grades**: Neutral, Punish, Defense
- A **per-stat breakdown** — 15 scored stats across the three categories (Premium)

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

We score 15 stats across three categories, each with its own internal weighting.

### Neutral — 40% of overall

Winning the early game exchange and controlling tempo.

| Stat | Weight | What it measures |
|------|--------|-----------------|
| **Neutral Win Rate** | 30% | Out of all neutral exchanges, how often you came out ahead |
| **Opening Conversion %** | 30% | When you got a hit, how often it turned into meaningful damage |
| **Stage Control %** | 15% | How often you held the center / offensive position |
| **Lead Maintenance %** | 15% | When ahead in stocks, how often you stayed ahead |
| **Comeback Rate** | 10% | How often you recovered from being behind in stocks |

### Punish — 40% of overall

Turning openings into stocks.

| Stat | Weight | What it measures |
|------|--------|-----------------|
| **Openings / Kill** | 35% | How many openings it took to take each stock (lower is better) |
| **Damage / Opening** | 30% | Average damage dealt per successful opening |
| **Edgeguard %** | 15% | Success rate when your opponent was offstage |
| **Avg Kill %** | 15% | Average percent you took stocks at (lower is better) |
| **Tech Chase %** | 5% | Success rate following up tech situations |

### Defense — 20% of overall

Staying alive and minimizing damage taken.

| Stat | Weight | What it measures |
|------|--------|-----------------|
| **Recovery %** | 35% | How often you made it back to stage when offstage |
| **Avg Death %** | 30% | Average percent you died at (higher is better) |
| **Avg Stock Duration** | 20% | How long each of your stocks lasted |
| **Respawn Defense %** | 15% | How well you defended immediately after respawning |

---

## Why these weights?

**Punish and Neutral are equally weighted and together make up 80% of your score** because they are the primary expressions of skill in Melee — converting openings and winning neutral exchanges separate stronger players from weaker ones more cleanly than anything else. Within Punish, **Damage/Opening and Openings/Kill together account for 60% of the category** because raw punish efficiency is the most direct signal of how well your punish game is working.

**Defense is weighted at 20%** because it's partly a byproduct of how neutral is going — if you're winning exchanges, you're also not taking as many hits. It still matters, and recovery is the single most weighted individual stat in the category, but it's a secondary axis.

**Execution stats (L-cancel %, Inputs/Minute, Missed Wavedash Rate) are not scored.** They're informative but plateau quickly and don't differentiate players reliably at most skill levels. A top player and a mid-ladder player can both L-cancel at 95%+. These stats are parsed and available for your own reference, but excluding them from scoring keeps the grade focused on what actually matters.

---

## How a stat becomes a score

For each stat, we look up where your value falls in the community distribution and interpolate linearly between percentile thresholds. A value at the 50th percentile scores 50. At the 95th, 95. Between thresholds, the score scales proportionally.

**Stat score** = linear interpolation through community percentiles.  
**Category score** = weighted average of the stat scores in that category (using the per-stat weights above).  
**Overall score** = weighted average of the three category scores (40/40/20).  
**Letter** = the overall score mapped through the table above.

### The win bonus

Winning the set adds **+5** to your overall score (capped at 100). Winning reflects adaptability, reads, and in-the-moment decisions that raw stats can't fully capture. Losing a close set won't tank your grade — but the win bonus is there to recognize that wins are themselves evidence of performance.

---

## Baselines — where the numbers come from

Stat percentiles are computed from the **HuggingFace `erickfm/slippi-public-dataset-v3.7` dataset** — a public archive of Slippi replays. We parsed **177,538 ranked replays across 26 characters** to build the benchmark distributions shipped in the app.

For each of your sets, we look up baselines in a three-tier fallback:

1. **Matchup-specific** — your character × opponent character (most precise, used when ≥20 replays exist for that matchup)
2. **Character** — your character across all opponents (fallback when matchup data is thin)
3. **Overall** — all characters pooled together (last resort)

The grade card tells you which tier was used, so you can see whether your grade is matchup-tuned or falling back to a broader benchmark.

### A note on kill% and death% baselines

`Avg Kill %` and `Avg Death %` are only scored when character-specific or matchup-specific baselines exist. The pooled "overall" bucket has identical values for both by construction (every kill is also a death in the same dataset), so scoring against it would produce misleading results.

---

## What's excluded, and why

Stats we parse but don't score:

- **L-Cancel %**, **Inputs / Min**, **Missed Wavedash Rate** — technical stats that plateau quickly and don't reliably separate players at most skill levels. Informative as context, but not part of the grade.
- **Counter-hit rate** and **defensive option rate** — too confounded by opponent quality. Facing a stronger opponent who probes more carefully can actually lower your counter-hit rate, which doesn't reflect on your skill.

---

## Parser accuracy

Our replay parser matches Slippi Launcher's own methodology (the `@slippi/slippi-js` library) for the stats it also computes:

- **Openings / Kill**, **L-Cancel %**: exact match
- **Inputs / Minute**: within ±2 on rollback-affected frames (exact match on most games)
- **Neutral Win Rate**: within 3pp on typical games
- **Damage / Opening**: differs by ~1 on average due to a methodology difference (we use peak-percent-per-stock; slippi-js uses per-conversion move damage). Values are consistent across both the benchmark dataset and your live grades, so percentiles remain valid.
- **Opening Conversion %**: we systematically overcount slightly (avg +1pp, max +13pp) due to multi-hit moves. We never undercount, so you will never see a lower number here than in Slippi Launcher.

Custom stats (stage control, edgeguards, tech chase, recovery, etc.) are not computed by slippi-js — we derive them from frame-by-frame action-state tracking using the same state-ID definitions slippi-js uses.

---

## Limits to keep in mind

- **One set is a small sample.** Your grade reflects how that particular set went, not your overall level. A single C doesn't mean you're a C-tier player; a single S doesn't mean you've arrived. Patterns across many sets are more meaningful.
- **Matchup context isn't fully in the model.** We pick a baseline tier, but we don't adjust for opponent rating within that tier. Losing a close set to a much stronger opponent and losing one to a weaker one produce similar grades.
- **Character strengths aren't normalized.** A top-tier character playing into a bottom-tier one will see inflated stats compared to community baselines. Matchup baselines help but don't fully erase this.
- **Grades are relative to the community baseline, not your personal baseline.** If you're improving, your grades will trend upward regardless of whether play "felt" good or bad on a given night.
- **The methodology will change.** Weights and structure are based on our best current judgment and will be updated as we get feedback. Stale grades from old baseline versions are flagged in-app so you can regrade with the latest numbers.

---

## Free vs Premium

- **Free** — every user sees the overall letter, overall score, and which category was strongest / weakest for every graded set.
- **Premium** — adds the full per-category scores, the per-stat breakdown with values and individual grades, matchup-specific baselines, and unlimited grade history.

Grading quality is identical regardless of tier — premium unlocks depth, not accuracy.

---

*Last updated: 2026-04-18*
