#!/usr/bin/env python3
"""Supervises rescan_recovery_edgeguard_only.py with the Xet backend ON.

Cross-platform Python port of run_respawn_supervised.sh (that one is macOS-only:
hardcoded /Users path, .venv/bin/python, `stat -f`, `pkill`). Written for the
Windows wired-Ethernet machine.

Auto-restarts (resume from the per-batch checkpoint = lossless) when the log
goes silent > FREEZE seconds (the documented Xet wedge) or the child exits
non-zero. On a real completion (child exits 0), regenerates grade-benchmarks.ts
and verifies recovery/edgeguard baselines are populated, so the pipeline
finishes unattended.

HF_TOKEN is inherited from the launch environment — never written here.
"""
import os
import subprocess
import sys
import time
from datetime import datetime

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON = sys.executable                       # the venv python running this
SCRIPT = os.path.join("scripts", "rescan_recovery_edgeguard_only.py")
LOG    = os.path.join(ROOT, "scripts", "logs", "recov_eg_rescan.log")
FREEZE = 300      # seconds of log silence that counts as a wedge
POLL   = 15       # monitor poll interval
MAXR   = 80       # restart safety cap


def log(msg: str):
    line = f"[supervisor {datetime.now():%F %T}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def kill_tree(proc: subprocess.Popen):
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True)
        else:
            proc.kill()
    except Exception as e:
        log(f"kill error: {e}")
    try:
        proc.wait(timeout=15)
    except Exception:
        pass


def run_once() -> str:
    """Launch the rescan once. Returns 'done' (exit 0), 'wedge', or 'exited'."""
    logf = open(LOG, "a", encoding="utf-8")
    proc = subprocess.Popen([PYTHON, "-u", SCRIPT], cwd=ROOT,
                            stdout=logf, stderr=subprocess.STDOUT)
    try:
        while True:
            rc = proc.poll()
            if rc is not None:
                return "done" if rc == 0 else "exited"
            try:
                age = time.time() - os.path.getmtime(LOG)
            except OSError:
                age = 0.0
            if age > FREEZE:
                log(f"FREEZE {age:.0f}s of log silence — killing + resuming from checkpoint")
                kill_tree(proc)
                return "wedge"
            time.sleep(POLL)
    finally:
        logf.close()


def finish():
    log("Scan complete — regenerating benchmarks")
    with open(LOG, "a", encoding="utf-8") as lf:
        rc = subprocess.run([PYTHON, "scripts/regen_benchmarks.py"], cwd=ROOT,
                            stdout=lf, stderr=subprocess.STDOUT).returncode
    log("regen_benchmarks.py OK" if rc == 0 else "regen_benchmarks.py FAILED — run manually")

    verify = r'''
import json
b = json.load(open("scripts/grade_baselines.json"))
def cnt(node, stat):
    t = p = 0
    if isinstance(node, dict):
        s = node.get(stat)
        if isinstance(s, dict) and "sample_size" in s:
            t += 1
            if s.get("sample_size"):
                p += 1
        for v in node.values():
            a, c = cnt(v, stat); t += a; p += c
    return t, p
for stat in ("recovery_success_rate", "edgeguard_success_rate"):
    t, p = cnt(b, stat)
    print(f"[verify] {stat}: {p}/{t} entries populated")
print("[verify] rescan meta:", b.get("recovery_edgeguard_rescan", {}))
'''
    with open(LOG, "a", encoding="utf-8") as lf:
        subprocess.run([PYTHON, "-c", verify], cwd=ROOT, stdout=lf, stderr=subprocess.STDOUT)
    log("ALL DONE")


def main():
    if not os.environ.get("HF_TOKEN"):
        log("ERROR: HF_TOKEN not set in environment")
        sys.exit(1)
    os.makedirs(os.path.join(ROOT, "scripts", "logs"), exist_ok=True)
    for r in range(1, MAXR + 1):
        log(f"launch #{r} (Xet on, 32 download workers)")
        result = run_once()
        if result == "done":
            finish()
            return
        log(f"rescan ended ({result}); resuming in 3s")
        time.sleep(3)
    log(f"hit MAXR={MAXR} restarts — stopping; check the log")
    sys.exit(1)


if __name__ == "__main__":
    main()
