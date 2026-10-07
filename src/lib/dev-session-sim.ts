/**
 * DEV ONLY — load a real past session into the Live Session tab.
 *
 * The live card is driven by the file watcher, so the only way to see it (the per-game grade
 * column, the unranked/direct run clock, the opponent panel) is to be mid-match. That makes it
 * untestable at a desk, which is how the session timer sat unreleased for two months waiting for
 * someone to happen to play.
 *
 * This replays a stored match through the same stores the watcher writes to: it re-parses the
 * real .slp files, so the stats and therefore the grades are genuine, not mocked.
 *
 * Every entry point is behind `import.meta.env.DEV`, so none of this exists in a production
 * bundle — see the guard in simulateLiveSession().
 */
import { get } from "svelte/store";
import { activeSet, liveGameStats, connectCode, type LiveGameStats, type LiveMode } from "./store";
import { getDb, getGamesByMatchId, type GameRow } from "./db";
import { parseSlpFile } from "./parser";
import { resolveReplayPath, indexByBasename } from "./replay-index";
import { collectSlpFiles } from "./parser";
import { replayDirs } from "./store";

export interface SimResult {
  matchId: string;
  mode: LiveMode;
  opponent: string;
  games: number;
  parsed: number;
  runStartedAt: string;
}

/** The most recent match with at least `minGames` games, preferring a mode that has a run clock
 *  (unranked/direct) so the timer is actually visible. */
interface MatchRow { match_id: string; n: number; match_type: string }

async function pickMatch(db: any, minGames: number, preferUnranked: boolean): Promise<string | null> {
  const rows: MatchRow[] = await db.select(
    `SELECT match_id, COUNT(*) AS n, match_type FROM games
      WHERE match_id IS NOT NULL
      GROUP BY match_id HAVING n >= $1
      ORDER BY MIN(timestamp) DESC LIMIT 40`,
    [minGames],
  );
  if (rows.length === 0) return null;
  if (preferUnranked) {
    const u = rows.find((r: MatchRow) => r.match_type !== "ranked");
    if (u) return u.match_id;
  }
  return rows[0].match_id;
}

/**
 * Replay a stored match into the live stores.
 *
 * `run_started_at` is set to (now − the match's real span) rather than its original timestamp:
 * the clock then reads the session's true length and keeps ticking, instead of showing however
 * many hours ago the session happened to be.
 */
export async function simulateLiveSession(
  opts: { minGames?: number; preferUnranked?: boolean } = {},
): Promise<SimResult> {
  if (!import.meta.env.DEV) throw new Error("simulateLiveSession is dev-only");
  const { minGames = 2, preferUnranked = true } = opts;

  const code = get(connectCode);
  const db = await getDb(code);
  const matchId = await pickMatch(db, minGames, preferUnranked);
  if (!matchId) throw new Error("no stored match with enough games");

  const rows: GameRow[] = await getGamesByMatchId(db, matchId);
  if (rows.length === 0) throw new Error("match has no games");

  // Replay folders get reorganised, so stored paths go stale — reuse the same basename lookup
  // the regrade uses rather than failing on a file that has simply moved.
  let index: Map<string, string> | null = null;
  const indexFor = async () => {
    if (index) return index;
    const entries: { name: string; path: string }[] = [];
    for (const dir of get(replayDirs)) {
      try { entries.push(...await collectSlpFiles(dir)); } catch { /* unreadable */ }
    }
    index = indexByBasename(entries);
    return index;
  };

  const stats: LiveGameStats[] = [];
  for (const g of rows) {
    if (!g.filepath) continue;
    try {
      let parsed;
      try {
        parsed = await parseSlpFile(g.filepath, code);
      } catch (e) {
        const found = resolveReplayPath(g.filepath, g.filename, await indexFor());
        if (!found) throw e;
        parsed = await parseSlpFile(found, code);
      }
      for (const p of parsed) stats.push(p as unknown as LiveGameStats);
    } catch { /* skip unreadable game */ }
  }
  if (stats.length === 0) throw new Error("no replays could be parsed for that match");

  const mode = (rows[0].match_type as LiveMode) ?? "unranked";
  const first = new Date(rows[0].timestamp).getTime();
  const last = new Date(rows[rows.length - 1].timestamp).getTime();
  const spanMs = Math.max(0, last - first);
  const runStartedAt = new Date(Date.now() - spanMs).toISOString();

  const won = stats.filter((s) => s.result === "win" || s.result === "lras_win").length;

  liveGameStats.set(stats);
  activeSet.set({
    match_id: matchId,
    mode,
    opponent_code: rows[0].opponent_code ?? "DEV#000",
    opponent_char_id: rows[0].opponent_char_id ?? 2,
    player_char_id: rows[0].player_char_id ?? 20,
    games_won: won,
    games_lost: stats.length - won,
    started_at: rows[0].timestamp,
    run_started_at: runStartedAt,
    opponent_rating: null,
    opponent_tier: null,
    opponent_tier_color: null,
    opponent_tag: null,
    opponent_season_wins: null,
    opponent_season_losses: null,
    opponent_prev_season: null,
    opponent_chars: null,
    all_time_wins: 0,
    all_time_losses: 0,
    all_time_unit: mode === "ranked" ? "sets" : "games",
  } as any);

  return { matchId, mode, opponent: rows[0].opponent_code ?? "", games: rows.length, parsed: stats.length, runStartedAt };
}

/** Put the live stores back to idle. */
export function clearLiveSimulation() {
  liveGameStats.set([]);
  activeSet.set(null);
}
