## What's New

### Set Grading — new feature

Every completed ranked set now gets a letter grade (**S – F**) based on how your performance compares against community baselines built from **177,538 replays across 26 characters**.

- **Three scored categories** per set: Neutral (40%), Punish (40%), Defense (20%). Execution stats (L-cancel, IPM, wavedash miss rate) are shown for reference but not scored.
- **18 stats** — 15 scored across the three categories (neutral win rate, damage per opening, kill/death percent, edgeguard success, tech chase success, recovery, and more) + 3 execution stats displayed as info
- **Matchup-aware** — baselines tier from matchup-specific → character-specific → overall, so your grade reflects the actual matchup when data is available
- **Free for everyone**: overall letter grade + strongest/weakest category for every set
- **Premium**: full per-category scores, per-stat breakdown with values and individual grades, and matchup-specific baselines

Find it in the new **Set Grades** tab. Click any set in the list to expand its breakdown. Tap **"How is this calculated?"** in the tab header to read the full methodology.

This isn't meant to be a perfect grading system — it's a directional read on where you might be strong or weak across a set, not a verdict on your skill.

### Parser accuracy improvements

Under the hood, the replay parser was rewritten to match Slippi Launcher's own methodology (the `@slippi/slippi-js` library) for the stats it computes:

- **Openings / Kill**, **L-Cancel %**: now exact to slippi-js
- **Inputs / Minute**, **Neutral Win Rate**: within ±2 on rollback-affected frames
- Rollback frame handling fixed across the live parser (stats were being inflated on games with heavy rollback)

These fixes also apply retroactively to your existing stats — re-scanning your replays after this update will produce slightly different numbers for the affected stats, matching what Slippi Launcher would show for the same games.

### Multi-folder replay scanning + open replays in Explorer (contributed by @customjack)

- **Multiple replay folders**: the sidebar now lets you add more than one replay folder — useful if your replays are spread across drives or directories. All folders are scanned together as one unified set. Existing installs migrate automatically with no data loss.
- **Open game files from Grade History**: expand any graded set and click a **Game 1 / Game 2 / …** button to open that replay's location directly in Explorer (or Finder on Mac).

### Other improvements

- Set Grades tab header links directly to the grading methodology doc
- `wavedash_miss_rate` detection rewritten (baselines regenerating — will enable in a follow-up)

---

Download the installer below to get started. Once installed, future updates are delivered automatically through the app.
