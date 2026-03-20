# Slippi Ranked Stats

A desktop app for tracking your Super Smash Bros. Melee ranked stats on Slippi. Scan your replay folder and get detailed breakdowns of your performance — matchups, stages, sessions, and more.

![Version](https://img.shields.io/github/v/release/Joey-Farah/Slippi-Ranked-Stats)
![Platform](https://img.shields.io/badge/platform-Windows-blue)

---

## Features

- **Automatic replay scanning** — point it at your Slippi replay folder and it imports everything instantly
- **Live monitor** — watches your replay folder in real time so stats update after every game
- **Matchup stats** — win rates vs every character you've faced, sortable and filterable
- **Stage stats** — win rates per stage, best and worst stages highlighted
- **Session tracking** — each play session broken out with duration, sets, momentum chart
- **All-time stats** — overall win rate, comeback rate, deciding game win %, time-of-day breakdown
- **Rating tracking** — fetch your current Slippi rating, rank tier, and global rank on demand
- **Auto-updates** — app notifies you and installs updates with one click

---

## Installation

1. Go to the [Releases](https://github.com/Joey-Farah/Slippi-Ranked-Stats/releases/latest) page
2. Download `Slippi Ranked Stats_x.x.x_x64-setup.exe`
3. Run the installer

---

## Getting Started

1. Enter your **Connect Code** (e.g. `JOEY#870`)
2. Click **Browse…** and select your Slippi replay folder
   - Usually located at `C:\Users\<you>\Documents\Slippi`
3. Click **Scan Replays**
4. Click **Get Current Rating** to load your current Slippi rating

Your connect code and folder path are saved automatically — next time you open the app it will scan for new replays on its own.

---

## Requirements

- Windows 10 or later
- [Slippi](https://slippi.gg) with ranked replays saved locally

---

## Privacy

All data is stored **locally on your machine**. The app only makes two external requests:
- The Slippi GraphQL API (`internal.slippi.gg`) to fetch your current rating when you click "Get Current Rating"
- GitHub releases to check for app updates on launch

No data is ever uploaded or shared.

---

## Support

If you find this app useful, consider supporting development:

[Support on Patreon](https://www.patreon.com/joeydonuts)

---

## Issues

Found a bug or have a feature request? [Open an issue](https://github.com/Joey-Farah/Slippi-Ranked-Stats/issues)
