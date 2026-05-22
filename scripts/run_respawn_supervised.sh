#!/bin/bash
# Supervises rescan_respawn_only.py with the fast Xet download backend.
# Auto-restarts (resume from per-batch checkpoint = lossless) on a wedge
# (log silent > FREEZE seconds) or an unexpected exit. On REAL completion it
# regenerates grade-benchmarks.ts and verifies respawn_defense_rate is
# populated, so the whole pipeline finishes unattended overnight.
# HF_TOKEN is inherited from the launch environment (never written here).
set -u
cd /Users/joeyfarah/Documents/GitHub/Slippi-Ranked-Stats || exit 1
LOG=scripts/logs/respawn_rescan.log
FREEZE=300        # seconds of log silence that counts as a wedge
MAXR=80           # restart safety cap (generous for an overnight run)

finish() {
  echo "[supervisor] Scan complete at $(date '+%F %T') — regenerating benchmarks" | tee -a "$LOG"
  if .venv/bin/python scripts/regen_benchmarks.py >> "$LOG" 2>&1; then
    echo "[supervisor] regen_benchmarks.py OK — grade-benchmarks.ts regenerated" | tee -a "$LOG"
  else
    echo "[supervisor] regen_benchmarks.py FAILED — run it manually" | tee -a "$LOG"
  fi
  .venv/bin/python - >> "$LOG" 2>&1 <<'PY'
import json
b = json.load(open("scripts/grade_baselines.json"))
def cnt(n):
    t = p = 0
    if isinstance(n, dict):
        r = n.get("respawn_defense_rate")
        if isinstance(r, dict):
            t += 1
            if r.get("sample_size"):
                p += 1
        for v in n.values():
            a, c = cnt(v); t += a; p += c
    return t, p
t, p = cnt(b)
print(f"[verify] respawn_defense_rate populated entries: {p}/{t} (was 0 before this run)")
print(f"[verify] rescan metadata: {b.get('respawn_defense_rescan', {})}")
PY
  echo "[supervisor] ALL DONE at $(date '+%F %T')" | tee -a "$LOG"
  exit 0
}

r=0
while [ "$r" -lt "$MAXR" ]; do
  grep -q "Scan complete" "$LOG" 2>/dev/null && finish
  r=$((r+1))
  echo "[supervisor] launch #$r at $(date '+%T') (Xet on, 32 workers)" | tee -a "$LOG"
  .venv/bin/python -u scripts/rescan_respawn_only.py >> "$LOG" 2>&1 &
  PID=$!

  while kill -0 "$PID" 2>/dev/null; do
    grep -q "Scan complete" "$LOG" 2>/dev/null && break
    age=$(( $(date +%s) - $(stat -f %m "$LOG" 2>/dev/null || echo 0) ))
    if [ "$age" -gt "$FREEZE" ]; then
      echo "[supervisor] FREEZE ${age}s on: $(tail -1 "$LOG") — killing+resuming" | tee -a "$LOG"
      kill "$PID" 2>/dev/null; sleep 2
      pkill -f "MacOS/Python -u scripts/rescan_respawn_only.py" 2>/dev/null; sleep 3
      break
    fi
    sleep 15
  done

  wait "$PID" 2>/dev/null               # let python fully finish patch_baselines
  grep -q "Scan complete" "$LOG" 2>/dev/null && finish
  echo "[supervisor] python ended without completion; resuming in 3s" | tee -a "$LOG"
  sleep 3
done

echo "[supervisor] hit MAXR=$MAXR restarts — stopping; check the log" | tee -a "$LOG"
exit 1
