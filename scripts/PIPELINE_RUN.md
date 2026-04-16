# HuggingFace Benchmark Pipeline — Run Instructions

This guide walks through regenerating `grade_baselines.json` and
`src/lib/grade-benchmarks.ts` after pulling the latest `main` branch.
It is written for both human runners and a Claude Code (AI) session.

---

## If You Are Claude Code

Run these steps in order using the Bash tool. The parser takes 45–120 minutes
and prints progress every batch — do not time out or cancel it. After the
parser finishes, run the regen script, then commit only the two output files.
Do NOT commit `scripts/parse_hf_checkpoint.json` (it is deleted automatically
on success) or any source files. Do NOT add a Co-Authored-By tag to the commit.

```
Step 1:  python3 -m venv .venv && source .venv/bin/activate
Step 2:  pip install peppi-py numpy huggingface_hub
Step 3:  python scripts/parse_hf_replays.py          ← long-running, resume-safe
Step 4:  python scripts/regen_benchmarks.py
Step 5:  git add scripts/grade_baselines.json src/lib/grade-benchmarks.ts
Step 6:  git commit -m "Regenerate benchmarks: 18 stats from HuggingFace FALCO dataset"
Step 7:  git push
```

If Step 3 errors or is interrupted, re-run the exact same command — the
checkpoint at `scripts/parse_hf_checkpoint.json` resumes automatically.

---

## Prerequisites

- Python 3.10+
- Git (already pulled `main`)

---

## One-Time Setup

```bash
cd /path/to/Slippi-Ranked-Stats

python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

pip install peppi-py numpy huggingface_hub
```

---

## Step 1 — Run the Parser

```bash
source .venv/bin/activate        # Windows: .venv\Scripts\activate

python scripts/parse_hf_replays.py
```

**What it does:**
- Lists all ~42 k Falco replays from the HuggingFace dataset
- Downloads in batches of 500, parses with peppi-py, accumulates stat percentiles
- Saves progress to `scripts/parse_hf_checkpoint.json` after every batch
- Deletes each batch from disk immediately after parsing (conserves space)
- Writes final output to `scripts/grade_baselines.json`

**Expected runtime:** 45–120 minutes depending on network speed.

**Progress output (one line per batch):**
```
Batch 12: downloading 500 files...
  Progress: 5500/42318 total (13.0%)
  Downloaded 500 files in 38.2s
  Parsed 487 games (13 errors) in 4.1s
  Total: 5500/42318 (13.0%) in 512s
```

**If it crashes or is interrupted:** just re-run the exact same command.
The checkpoint file resumes automatically from where it stopped.

---

## Step 2 — Regenerate TypeScript Benchmarks

```bash
python scripts/regen_benchmarks.py
```

Reads `scripts/grade_baselines.json` and writes
`src/lib/grade-benchmarks.ts` with all 18 stat percentile thresholds.

Sample output:
```
Source: huggingface/erickfm/slippi-public-dataset-v3.7/FALCO · 42318 replays
Overall sample_size: 84636
Included 24 chars (>= 50 samples) + _overall:
  Falco                n=84636
  ...
Wrote src/lib/grade-benchmarks.ts
```

---

## Step 3 — Commit and Push

```bash
git add scripts/grade_baselines.json src/lib/grade-benchmarks.ts
git commit -m "Regenerate benchmarks: 18 stats from HuggingFace FALCO dataset"
git push
```

Commit **only** those two files. Do not stage `parse_hf_checkpoint.json`
(deleted on success) or any source code files.

---

## Optional: Multi-Character Run

To add Fox, Marth, etc. on top of Falco (uses `--merge` to keep existing data):

```bash
python scripts/parse_hf_replays.py --character FOX   --merge
python scripts/parse_hf_replays.py --character MARTH --merge
python scripts/regen_benchmarks.py
```

Delete `scripts/parse_hf_checkpoint.json` between characters if you want
each run to start fresh rather than resume a prior partial run.

---

## Troubleshooting

**`ModuleNotFoundError: No module named 'peppi_py'`**
```bash
pip install --upgrade peppi-py
```

**New stats (stage_control, edgeguard, recovery) all come back `null`:**
Position field names vary by peppi-py version. Run this to diagnose:
```python
import peppi_py as peppi
game = peppi.read_slippi('path/to/any.slp')
port = game.frames.ports[0].leader.post
print(dir(port))            # look for: position, position_x, position_y
pos = port.position
print(type(pos), dir(pos))  # look for: x, y  (or .field('x') for PyArrow)
```
Open a GitHub issue with that output and `pip show peppi-py`.

**Start from scratch (discard checkpoint):**
```bash
rm scripts/parse_hf_checkpoint.json
python scripts/parse_hf_replays.py
```

**Check peppi-py version:**
```bash
pip show peppi-py
```
