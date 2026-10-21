"""Fetch every Lunar netplay/tournament replay on a non-legal stage (metadata only) to JSONL.

usage: lunar_nonlegal_fetch.py <out.jsonl>   then: lunar_nonlegal_match.py <db> <out.jsonl> --write
"""
import json, sys, time, urllib.request

UA = "SlippiRankedStats-benchmarks (github.com/Joey-Farah/Slippi-Ranked-Stats)"
API = "https://api.lunarmelee.com/api/replays"
LEGAL = {2, 3, 8, 28, 31, 32}
out_path = sys.argv[1]


def get(params):
    url = API + "?" + "&".join(f"{k}={v}" for k, v in params.items())
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            code = getattr(e, "code", None)
            wait = 30 if code in (429, 503) else 5 * (attempt + 1)
            print(f"  {e}; retry in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"gave up on {url}")


with open(out_path, "w", encoding="utf-8") as out:
    for source in ("netplay", "tournament"):
        for stage in list(range(0, 60)) + [84]:  # 84 = Home-Run Contest; nothing else exists past 58
            if stage in LEGAL:
                continue
            base = {"source": source, "stageId": stage, "includeCpu": "true"}
            total = get({**base, "limit": 1})["pagination"]["total"]
            time.sleep(0.5)
            if not total:
                continue
            print(f"{source} stage {stage}: {total:,}", flush=True)
            pages = (total + 999) // 1000
            for page in range(1, pages + 1):
                data = get({**base, "limit": 1000, "page": page})
                for r in data["replays"]:
                    out.write(json.dumps({
                        "source": source, "stageId": r.get("stageId"), "stageName": r.get("stageName"),
                        "fileHash": r.get("fileHash"), "startAt": r.get("startAt"),
                        "tournamentName": r.get("tournamentName"), "lastFrame": (r.get("stats") or {}).get("lastFrame"),
                        "players": [{"char": p.get("characterName"), "cpu": p.get("cpu")}
                                    for p in r.get("players", [])],
                        "ipm": [p.get("inputsPerMinute") for p in ((r.get("stats") or {}).get("players") or [])],
                    }) + "\n")
                time.sleep(1)
print("done", flush=True)
