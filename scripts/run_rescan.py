#!/usr/bin/env python3
"""
Overnight benchmark rescan — the whole pipeline in one command, safe to re-run.

    <venv python> scripts/run_rescan.py           # run (or resume) everything
    <venv python> scripts/run_rescan.py --check   # preflight only, then exit

Steps (each resumable — just run the same command again after any interruption):
  1. ranked scan  (erickfm/melee-ranked-replays, 934 tarballs, ~1.43 TB) -> DB
  2. v3.7 scan    (erickfm/slippi-public-dataset-v3.7, all characters)   -> DB
  3. build scripts/grade_baselines.json from the DB
  4. regen src/lib/grade-benchmarks.ts

Writes to a NEW sidecar, scripts/raw_stats_v2.sqlite — the July raw_stats.sqlite is never
touched. On the very first run, any existing scan checkpoints (which would mark July's work as
already done and make the scan skip everything) are moved into scripts/logs/ first.

Logs: scripts/logs/rescan_*.log. Keeps the machine awake while running (macOS caffeinate /
Windows SetThreadExecutionState). Does NOT commit anything — review the diff afterwards.
"""
import argparse
import glob
import importlib.metadata
import os
import shutil
import subprocess
import sys
import time

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(SCRIPTS)
LOGS = os.path.join(SCRIPTS, "logs")
DB = os.path.join(SCRIPTS, "raw_stats_v2.sqlite")
STARTED = os.path.join(LOGS, "rescan_v2.started")
CHECKPOINT_GLOBS = ["parse_ranked_checkpoint.json", "parse_hf_checkpoint*.json",
                    "parse_hf_global_checkpoint.json"]
PEPPI_VERSION = "0.8.6"   # the follower (Nana) realignment is written against this


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def preflight():
    """Fail fast on anything that would waste a night or bake the old bugs back in."""
    ok = True
    sys.path.insert(0, SCRIPTS)
    try:
        import parse_hf_replays as P
        if not hasattr(P, "follower_frame_numbers"):
            log("FAIL: parse_hf_replays.py has no parity fixes — `git checkout fix/grading-parity` (or the branch they were merged into) and `git pull`")
            ok = False
    except Exception as e:
        log(f"FAIL: can't import parse_hf_replays ({e}) — install scripts/requirements.txt into this venv")
        return False
    try:
        v = importlib.metadata.version("peppi-py")
        if v != PEPPI_VERSION:
            log(f"FAIL: peppi-py {v} installed, need {PEPPI_VERSION} — pip install -r scripts/requirements.txt")
            ok = False
    except importlib.metadata.PackageNotFoundError:
        log("FAIL: peppi-py not installed — pip install -r scripts/requirements.txt")
        ok = False
    # Test what actually matters — whether the datasets are READABLE — not whether a token
    # happens to be present. Both repos are public: an anonymous read measured 70 MB/s on
    # 2026-10-05 (≈ 6 h of transfer for the 1.43 TB ranked set), so a token buys higher rate
    # limits, not access. Failing on login status alone blocked a run that would have worked.
    try:
        from huggingface_hub import list_repo_tree
        for repo in (P.RANKED_REPO_ID, P.REPO_ID):
            next(iter(list_repo_tree(repo, repo_type=P.REPO_TYPE)))
        try:
            from huggingface_hub import whoami
            log(f"HuggingFace: datasets readable, logged in as {whoami()['name']}")
        except Exception:
            log("HuggingFace: datasets readable ANONYMOUSLY (no token). Fine — rate limits are "
                "lower, so `hf auth login` with a read token if downloads start stalling.")
    except Exception as e:
        log(f"FAIL: cannot read the HuggingFace datasets ({type(e).__name__}: {str(e)[:120]}) — "
            f"check the network, or `hf auth login` if they have been made private")
        ok = False
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "test_parity.py"],
                       cwd=SCRIPTS, capture_output=True, text=True)
    tail = (r.stdout.strip().splitlines() or ["(no output)"])[-1]
    if r.returncode != 0:
        log(f"FAIL: parity test is red — {tail}")
        ok = False
    else:
        log(f"parity test: {tail}")
    free_gb = shutil.disk_usage(SCRIPTS).free / 1e9
    log(f"free disk: {free_gb:.0f} GB")
    if free_gb < 40:
        log("FAIL: need ~40 GB free (tarball downloads + the DB)")
        ok = False
    return ok


def keep_awake():
    """Hold off system sleep for the life of this process. Returns a cleanup callable."""
    if sys.platform == "darwin":
        p = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        return p.terminate
    if sys.platform == "win32":
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        return lambda: ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
    log("note: no sleep prevention on this OS — disable sleep manually")
    return lambda: None


def first_run_setup():
    """Move July's checkpoints aside exactly once, so this run starts from zero but resumes
    from its OWN checkpoints on every later invocation."""
    if os.path.exists(STARTED):
        log("resuming the v2 rescan (checkpoints kept)")
        return
    backup = os.path.join(LOGS, f"checkpoints_before_v2_{time.strftime('%Y%m%d_%H%M%S')}")
    moved = []
    for pattern in CHECKPOINT_GLOBS:
        for path in glob.glob(os.path.join(SCRIPTS, pattern)):
            os.makedirs(backup, exist_ok=True)
            shutil.move(path, backup)
            moved.append(os.path.basename(path))
    if moved:
        log(f"moved old checkpoints to {backup}: {', '.join(moved)}")
    with open(STARTED, "w") as fh:
        fh.write(time.strftime("%Y-%m-%d %H:%M:%S\n"))


def step(name, args):
    path = os.path.join(LOGS, f"rescan_{name}.log")
    log(f"step {name}: {' '.join(args)}  (log: {path})")
    with open(path, "a", encoding="utf-8") as fh:
        rc = subprocess.run([sys.executable, "-u", *args], cwd=REPO, stdout=fh,
                            stderr=subprocess.STDOUT).returncode
    if rc != 0:
        log(f"step {name} FAILED (exit {rc}) — see {path}; re-run this script to resume")
        sys.exit(rc)
    log(f"step {name} done")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="preflight only")
    args = ap.parse_args()

    os.makedirs(LOGS, exist_ok=True)
    if not preflight():
        sys.exit(1)
    if args.check:
        log("preflight OK")
        return

    release = keep_awake()
    try:
        first_run_setup()
        scan = os.path.join("scripts", "parse_hf_replays.py")
        step("ranked", [scan, "--dataset", "ranked", "--db", DB])
        step("v37", [scan, "--dataset", "v37", "--character", "ALL", "--dl-workers", "8",
                     "--db", DB, "--output", os.path.join(LOGS, "v37_only_baselines.json")])
        step("baselines", [scan, "--dataset", "db", "--db", DB,
                           "--output", os.path.join(SCRIPTS, "grade_baselines.json")])
        step("regen", [os.path.join("scripts", "regen_benchmarks.py")])
        log("ALL DONE — review `git diff --stat`, then hand back to Claude to validate")
    finally:
        release()


if __name__ == "__main__":
    main()
