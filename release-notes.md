## Unreleased

### 🗂️ The app reopens on whatever tab you left off on

Switching to a tab is now remembered between launches. If you quit the app on **Live Session** (or any other tab), the next time you open it you'll land right back there instead of getting bounced back to Ranked Sessions.

---

## What's New in v1.8.5

### 🩹 Overlay preview shows up again in the app (Premium)

The **Live preview** box in the OBS overlay setup went blank in v1.8.4 — it showed nothing even though the overlay still worked correctly in OBS itself. That was a side effect of last version's security hardening (the stricter app content policy blocked the preview from rendering). The in-app preview is back, so you can once again see exactly what's on your overlay — and use **Simulate set result** to test it — without leaving the app.

---

## What's New in v1.8.4

### 🔑 Stay premium without re-linking Discord every week (Premium)

Premium access is verified through your linked Discord, and that link used to quietly expire about once a week — which is why some of you have had to **re-link Discord to get premium back** every so often (it often seemed to happen right after an update). The app now **renews the link automatically in the background**, so this should stop happening.

> ⚠️ **One last re-link — heads up:** because the old link can't be renewed, **every premium user will need to re-link Discord *one more time*** the next time their current link expires. After that single re-link, it renews silently on its own and you shouldn't have to do it again. If you find yourself dropped from premium once after updating, just re-link in the **Live Session** tab — that's expected, and it's the last time.

### 🔒 Security hardening

Under-the-hood safety improvements as the app grows: a stricter content policy in the app window, tighter file-access limits, and a locked-down telemetry endpoint. No change to how you use the app — just a smaller attack surface.

---

## What's New in v1.8.3

### 🩹 The previous set's grade no longer lingers into your next set (Premium)

When a ranked set ends, the Live Stats Overlay holds the result and grade for a few minutes — but it now **clears the moment your next set starts**, instead of leaving the old grade up through your first game of the next set. The 3-minute hold still applies whenever you stop playing; a new set just takes priority.

## What's New in v1.8.2

### 🎭 Filter your stats by your own character

The **Matchup Stats**, **All-Time Stats**, and **Unranked & Direct Stats** tabs now have a **Filter by Your Character** selector at the top. Pick one of your characters and the *whole tab* — every chart, the opponent spotlight, and the history tables — narrows to just the sets you played as that character. Perfect for dual mains who want to read each character's matchups separately. (Only appears once you've played more than one character.)

### 👤 Scout your opponent on the overlay (Premium)

While a ranked set is live, the Live Stats Overlay now shows who you're up against **before the set is decided** — their **tag**, **rank** (with the rank medal and color), **MMR**, and **season W–L record** (wins in green, losses in red). When the set ends, it flows into the set grade as before.

### ✨ Cleaner set-grade moment (Premium)

The post-set overlay now places your **standout stat beside the grade letter** instead of beneath it (e.g. `Openings / Kill: S`), filling out the space for a tidier, more readable result card.

---

## What's New in v1.8.1

### 🩹 Overlay fixes & polish (Premium)

- Your **set grade now appears on the overlay the instant it shows in the app** — no more ~10-second lag after a set ends.
- The overlay's **session MMR change** now shows a clear **+ / −** sign, not just color.
- New: a **standout stat under the set grade** — your **best** stat on a win, your **weakest** on a loss (e.g. "Openings / Kill A"), right beneath the letter.

### 🏆 Quit-outs now count

If your **opponent quits mid-set**, the set now completes and earns a **grade** (and counts as your win), as long as at least one full game was actually played. Previously an early ragequit could leave the set ungraded.

### 📈 Smarter Lead Maintenance & Comeback grading

Both stats were rescored to reflect **where the game actually ended up**, not just the size of the swing:

- **Lead Maintenance** now rewards *staying ahead*. Giving back part of a lead but holding on no longer tanks your grade — only truly blowing a big lead (and falling behind) earns an F.
- **Comeback** now rewards *actually completing* the comeback — clawing back to even or retaking the lead scores well, while a partial climb that's still losing scores lower. Deeper comebacks score higher.
- Your existing grades will refresh automatically — look for the **"Regrade stale"** button in the Grading tab.

---

## What's New in v1.8.0

### 📊 Live Stats Overlay for OBS (Premium)

A new always-on overlay that puts your full ranked identity on stream — and the set-grade overlay is now **built right into it**, so it's one Browser Source instead of two.

Always on, it shows:

- Your **tag**, **rank medal**, **MMR** (with your live **session +/− change** right beside it), **global placement**, and **season W/L**.
- A **Today's stats** line — your session record and rating change at a glance.

And the moment a **ranked set** ends, the panel briefly fills in the action — your **opponent**, the **score**, and your **set grade** (the letter that used to be its own overlay) — then shows the **MMR change** as it lands, before settling back to your stats.

**Two layouts** to fit your scene — a wide **side-by-side** card or a compact **stacked** one — switchable in the app. There's a **live preview** of exactly what's on your overlay, plus a **Simulate set result** button so you can set everything up without playing a game.

Setup is the same quick, server-less approach (no server, no extra window):

- Turn on **Live Stats Overlay** in the **Live Session** tab.
- Copy the file path it shows you.
- In **OBS**, add a **Browser Source** → check **Local file** → choose `stats.html`. Size it to taste; the background is transparent.

> **Upgrading from v1.7.0?** This replaces the standalone Set Grade Overlay. If you added that as its own Browser Source, you can remove it — your grade now appears inside the Live Stats overlay.

---

## What's New in v1.7.0

### 📺 Stream Overlay for OBS (Premium)

Show your set grade live on stream. The moment you finish a ranked set, your overall letter grade — in its grade color — **spins onto your overlay**, holds for a few seconds, then spins back off. Perfect for reacting to a fresh **S** on camera.

Setup is quick and runs entirely on your machine (no server, no extra window):

- Turn on **Stream Overlay** in the **Live Session** tab.
- Copy the file path it shows you.
- In **OBS**, add a **Browser Source** → check **Local file** → choose `overlay.html`. Done.

It only fires on completed **ranked sets** (not single games or unranked), the background is transparent so it sits cleanly over your gameplay, and it shows nothing between sets to keep things uncluttered.

---

## What's New in v1.6.2

### 🔄 Comeback & Lead Maintenance, rebuilt (Premium)

Fixed a bug where these two grades could flatly contradict the number next to them — a set could show **0% comeback graded S**, or a 0% lead maintenance graded F. The old stats were a blunt yes/no ("were you ever behind, and did you win?") scored against a lopsided curve, which produced nonsense in close matchups.

They now measure the **degree** of the swing, from stock count alone:

- **Comeback** rewards how much of a stock deficit you clawed back within a game — coming back from two stocks down counts for more than one — and scales up when you actually win the game.
- **Lead Maintenance** is the mirror: how well you held a stock lead instead of handing it back, scaled up when you close out the win.

On top of that, winning a set the hard way now shows in your grade: **coming back to win after dropping game 1 earns a bonus, calmly closing out a lead earns a smaller one, and blowing a game-1 lead costs you.**

Your existing grades will show the **stale** marker — hit **Regrade** to refresh them with the new scoring.

---

## What's New in v1.6.1

### 🛡️ Edgeguard & Recovery now counted correctly (Premium)

Fixed a bug that **undercounted your edgeguards and recoveries**. The grader stopped tracking an offstage exchange after 3 seconds — so kills that took longer to finish (chasing someone out and closing it at 4–6 seconds) were silently dropped, and slow recoveries weren't credited. The window is now 8 seconds, which covers virtually every real offstage exchange, and the community baselines were rebuilt to match. Your **Edgeguard %** and **Recovery %** now reflect what actually happened in your games.

### 🎨 Refreshed grade colors (Premium)

The **S grade is now hot pink** with a soft glow, so it's easy to tell apart from the yellow C grade at a glance. A couple of the other grade colors were nudged for clearer contrast.

### ✨ Quality of life

- **Jump to your Slippi profile**: a new button under your rating in the sidebar opens your slippi.gg profile page in one click.
- **Tidier "How Grading Works" panel**: removed the display-only execution-stats section to keep the focus on the stats that are actually scored.

---

## What's New in v1.6.0

### 🚀 Guided setup for new users (new)

If you haven't scanned any replays yet, the app now greets you with a setup screen that walks you through getting started — entering your connect code, picking your replay folder, and running your first scan — alongside quick-look cards for the main features (Live Session, Set Grades, Matchup Stats, and All-Time Stats).

### 🎯 Set Grades: more accurate and more transparent (Premium)

- **New "How Grading Works" panel**: open it from the Grading tab to see exactly how grades are built — how percentile scoring works, the S–F thresholds, each category's weight, and a plain-English description of what every stat measures.
- **More accurate stats**: several of the underlying calculations were rebuilt to match Slippi's own reference numbers — including respawn defense, average stock duration, opening conversions, tech chase, and neutral wins. Grades are now compared against a freshly rebuilt and much larger benchmark dataset, so your letter grades are more trustworthy than before.

### Grading refinements

- **Retired the "Hit Advantage" stat**: it measured almost the same thing as Opening Conversion Rate, so it was redundant. Its weight has moved to Openings per Kill.
- **Comeback Rate fix**: games where you were never behind in stocks no longer count as a "perfect" comeback — they're now left out of the comeback score instead of inflating it.

---

## What's New in v1.5.2

### Improvements

- **Sort by sample size**: The Win % vs Opponent Character chart (on both Matchup Stats and Unranked & Direct Stats) now has two new sort options — **Most Played** and **Least Played** — so you can quickly see your highest-volume matchups at the top or surface your rarest ones at the bottom.

---

## What's New in v1.5.1

### Improvements

- **Unranked & Direct Stats — Export CSV**: The Opponent History table now has an Export CSV button, matching the same feature on the Matchup Stats tab.

---

## What's New in v1.5.0

### 🕹️ Unranked & Direct Stats tab (new, Premium)

A new tab at the end of the tab bar shows stats for your unranked and direct-mode games — the replays that were always being stored but never surfaced anywhere.

- **Summary**: total games played, win %, and W–L record
- **Win % vs Opponent Character**: bar chart with A-Z, Best, and Worst sorting, plus per-character filter chips to focus on specific matchups
- **Your Characters**: win rate breakdown for each character you played
- **Opponent Spotlight**: Most Played, Best Record, and Worst Record vs individual opponents
- **Stage Win %**: win rate by stage across all your unranked games
- **Opponent History**: full searchable table of every opponent you've played, sorted by games played

### Bug fixes

- **Stage name clipping in charts**: Long stage names like "Fountain of Dreams" were being cut off in horizontal bar charts. All charts now size their label area automatically.

---

## What's New in v1.4.13

### Bug fixes

- **Premium access restored**: A Discord API outage caused some premium members to be incorrectly shown as not having premium access. This release fixes it:
  - If your access was incorrectly removed, it will be restored automatically the next time you launch the app — no need to re-link your Discord.
  - Premium verification now goes through a more reliable backend path that isn't affected by the same Discord endpoint outages.
  - Future Discord API hiccups will no longer silently downgrade your premium status.
- **macOS auto-update fix**: Earlier macOS builds shipped without the bundle format the auto-updater expects, causing the "invalid gzip header" error when trying to install updates. macOS auto-updates now work normally.

Sorry for the disruption.

---

## What's New in v1.4.9

### macOS support

Slippi Ranked Stats is now available on macOS. Download the `.dmg` below — works on both Apple Silicon and Intel Macs. All features including live session tracking, grading, and auto-updates are fully supported.

---

## What's New in v1.4.8

### New feature (Premium)

- **Live Session grade reveal**: When a set ends during a live watcher session, the Live Session tab now shows an animated grade card with your letter grade and the opponent context (e.g. "vs KARD#577 · Win 2–0"). Tap the Grading tab for the full per-category breakdown.

### Bug fixes

- **Rating History — season reset delta**: The first set of a new season was showing a large incorrect negative delta (e.g. −1395) because the change was calculated against the previous season's final rating. The Change column now shows — for any set that crosses a season boundary.

---

## What's New in v1.4.7

### Bug fixes

- **Scan history preserved across updates**: A previous migration could wipe your scan cache when updating, forcing a full rescan of your entire replay folder. This no longer happens — scan history is carried forward through updates.
- **Multi-folder duplicate filename fix**: If two replay folders contained files with the same filename, one would be silently skipped during scanning. Files are now tracked by their full path, so replays in different folders are always treated as distinct.
- **Export CSV confirmation**: Clicking "Export CSV" now briefly shows a "✓ Saved to Downloads" confirmation so it's clear the file was downloaded.

---

## What's New in v1.4.6

### Multi-folder replay scanning + open replays in Explorer (contributed by @customjack)

- **Multiple replay folders**: the sidebar now lets you add more than one replay folder — useful if your replays are spread across drives or directories. All folders are scanned together as one unified set. Existing installs migrate automatically with no data loss.
- **Open game files from Grade History**: expand any graded set and click a **Game 1 / Game 2 / …** button to open that replay's location directly in Explorer (or Finder on Mac).

---

## What's New in v1.4.5

### Improvements

- **Feedback & bug reports**: A new section at the bottom of the sidebar lets you send suggestions or report bugs directly from the app. They go straight to the developer.
- **Update banner**: When a new version is available, the banner now shows a "What's new" toggle so you can see the release notes before installing.

---

## What's New in v1.4.4

### New feature (Premium)

- **Grading tab — By Matchup view**: A new "By Matchup" toggle in the Grading tab lets you see your average grade for every character matchup you've played. Each row shows your record, overall average grade, and average scores for Neutral, Punish, and Defense. Click any matchup to expand a full per-stat breakdown with average values and letter grades for all 15 scored stats.

---

## What's New in v1.4.3

### Bug fixes

- **Premium access for Ko-fi supporters**: Ko-fi supporters who connected their Discord weren't getting premium features unlocked, even though Discord correctly granted them the **Slippi Ranked Stats** role. The app's role check was only looking at the Patreon-specific tier roles, which Ko-fi supporters don't have. The check now recognizes the Slippi Ranked Stats role itself, so anyone the supporter bots have flagged as a supporter (Patreon or Ko-fi) gets premium access. Existing Patreon premium users are unaffected.

---

## What's New in v1.4.2

### Bug fixes

- **Scanner — linked codes now picked up on scan**: Previously, scanning a replay folder only ingested replays where your primary connect code was a participant. Replays played under a linked code were silently skipped and permanently marked as already-scanned, so they wouldn't appear even after adding the code. The scanner now processes all linked codes in a single pass and routes each replay to the correct code's database. If you had replays missing for a linked code, a **Force Rescan All** will pick them up.

---

## What's New in v1.4.1

### Bug fixes

- **Grading tab — set count corrected**: "X of Y sets graded" no longer reports an inflated count when you have linked codes. Previously, grades saved for sets from a linked code were counted in the numerator even after that code was removed. The count, grade distribution chart, and stale-grade detection now all scope correctly to your active code list.
- **Rating History — season-end marker**: The orange diamond marking the end of a past season now correctly appears on the chart. It was previously invisible because the marker's timestamp didn't align with any data point on the axis.
- **Rating History — multi-code note**: A note now appears when you have linked codes explaining that rating history tracks only the code at the top of your list.

---

## What's New in v1.4.0

### ⚡ Ranked Sessions tab (redesigned)
The old "Last Session" tab is now **Ranked Sessions** — a full session browser. All your sessions are listed on the left; click any one to see the complete breakdown on the right. The most recent session is selected by default.

Each session shows:
- Summary stats (duration, sets, games, set W/L, win %, game W/L, wins/hour)
- Sets played with opponent, score, characters, and stages
- Score distribution (2-0, 2-1, 1-2, 0-2), Game 1 win rate, deciding game win rate
- Stage win % chart and momentum chart

### 📝 Grading tab (new)
Every completed ranked set now gets a letter grade — **S through F** — based on how your stats compare to community baselines built from 177,000+ Slippi replays (345,000 samples across 26 characters, 183 matchup entries).

- **Three scored categories**: Neutral (40%), Punish (40%), Defense (20%)
- **18 individual stats** — 15 scored, 3 execution stats shown as info-only (L-cancel, IPM, wavedash miss rate)
- **Matchup-specific baselines** when enough data exists, falling back to character-wide or overall baselines
- **Win bonus**: +5 to your overall score for winning the set
- Grade history persists across sessions; stale grades are flagged with a one-click regrade button
- Filter by grade letter, W/L result, character matchup; sort by date or score
- **Grade distribution bar chart**: the summary card now shows a proportional bar chart for each letter grade
- After a set completes in a live watcher session, the grade appears inline in the Live Session tab

### 🔗 Multi-code support
Link multiple connect codes together in the sidebar — stats, sessions, matchups, and grade history all merge across every linked code. Useful if you have an alt, an old code, or changed codes mid-season. Add or remove codes at any time.

- All codes in the list are equal — no "primary" designation needed
- Grading works correctly for sets from any linked code
- Grades are kept in sync across all linked code databases, so adding or removing a code doesn't require regrading

### 🔓 Ko-fi support
Unlock premium access through Ko-fi in addition to Patreon. Discord role verification works for both.

### Other improvements
- **Sidebar toggle**: replaced with a clean hamburger button consistent in both expanded and collapsed states
- **Tab renamed and reordered**: Ranked Sessions at position 1, Grading at position 5, Live Session at the end
- **Connect code switching**: switching codes correctly reloads all data for the new code
- **Grading tab load fix**: no more blank flash when switching back to the Grading tab

---

Download the installer below. Once installed, future updates are delivered automatically through the app.
