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
