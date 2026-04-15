import { watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { get } from "svelte/store";
import type Database from "@tauri-apps/plugin-sql";
import { parseSlpFile, getRankTier, type ParsedGameRow } from "./parser";
import {
  insertGame,
  getGames,
  insertSnapshot,
  getSnapshots,
  insertSeason,
  getSeasons,
  markFilesScanned,
  getGamesByMatchId,
  getGamesVsOpponent,
  type GameRow,
} from "./db";
import { fetchRatingSnapshot } from "./api";
import {
  games,
  snapshots,
  seasons,
  watcherActive,
  activeSet,
  liveSessionStartRating,
  liveSessionStartedAt,
  setResultFlash,
  statusMessage,
  liveGameStats,
  lastSetGrade,
} from "./store";
import { CHARACTERS } from "./parser";
import { gradeSet } from "./grading";

let _unwatch: UnwatchFn | null = null;
let _snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingMatchId: string | null = null;

// Match IDs that were already in the DB when the watcher started.
// Games with these IDs are from previous sessions and must not go into liveGameStats.
const _preExistingMatchIds = new Set<string>();

// Per-file debounce: maps absolute filepath → timer handle.
// A file is "done" when it stops being modified for FILE_SETTLE_MS.
const _pendingParse = new Map<string, ReturnType<typeof setTimeout>>();
const FILE_SETTLE_MS = 1500; // ms of inactivity before we attempt to parse

// Tracks match_ids seen during this watcher session to detect new vs ongoing sets
const _knownMatchIds = new Set<string>();
// Tracks opponent codes faced during this watcher session for rematch detection
const _sessionOpponents = new Set<string>();
// Tracks match_ids that have already triggered a snapshot fetch (prevents duplicates)
const _completedMatchIds = new Set<string>();

export async function startWatcher(
  dir: string,
  connectCode: string,
  db: Database
): Promise<void> {
  if (_unwatch) return; // already running

  // Initialize session state from current store contents
  _knownMatchIds.clear();
  _sessionOpponents.clear();
  _completedMatchIds.clear();
  liveGameStats.set([]);

  // Snapshot of match_ids that existed BEFORE this session started.
  // Files re-processed from old sessions must not pollute liveGameStats or trigger new snapshots.
  _preExistingMatchIds.clear();
  for (const g of get(games)) {
    if (g.match_id) {
      _knownMatchIds.add(g.match_id);
      _preExistingMatchIds.add(g.match_id);
    }
  }

  // Fetch a fresh rating snapshot on startup:
  // - Updates the sidebar rating without requiring a manual "Get Current Rating" click
  // - Sets an accurate session start baseline (not a stale DB value from days ago)
  liveSessionStartRating.set(null);
  liveSessionStartedAt.set(new Date().toISOString());
  fetchRatingSnapshot(connectCode)
    .then(async ({ snapshot, seasons: fetchedSeasons }) => {
      await insertSnapshot(db, { ...snapshot, connect_code: connectCode });
      for (const s of fetchedSeasons) {
        await insertSeason(db, { ...s, connect_code: connectCode });
      }
      const loadedSnaps = await getSnapshots(db, connectCode);
      snapshots.set(loadedSnaps);
      const loadedSeasons2 = await getSeasons(db, connectCode);
      seasons.set(loadedSeasons2);
      liveSessionStartRating.set(snapshot.rating);
    })
    .catch(() => {
      // API unavailable — fall back to last stored snapshot
      const existingSnaps = get(snapshots);
      liveSessionStartRating.set(existingSnaps.at(-1)?.rating ?? null);
    });

  // Attempt to recover an in-progress set from recent replays
  try {
    await recoverActiveSet(connectCode, db);
  } catch {
    // Non-fatal — watcher still starts even if recovery fails
  }

  _unwatch = await watch(
    dir,
    (event) => {
      const typeStr = typeof event.type === "string" ? event.type : JSON.stringify(event.type);
      const slpPaths = event.paths.filter((p) => p.endsWith(".slp"));

      if (typeof event.type === "string") return;

      const isCreate = "create" in event.type;
      const isModify = "modify" in event.type;
      if (!isCreate && !isModify) return;

      if (slpPaths.length === 0) return;

      for (const filepath of slpPaths) {
        scheduleFileParse(filepath, connectCode, db);
      }
    },
    { recursive: true }
  );

  watcherActive.set(true);
}

export async function stopWatcher(): Promise<void> {
  if (_unwatch) {
    _unwatch();
    _unwatch = null;
  }
  if (_snapshotTimer) {
    clearTimeout(_snapshotTimer);
    _snapshotTimer = null;
  }
  for (const timer of _pendingParse.values()) clearTimeout(timer);
  _pendingParse.clear();
  _knownMatchIds.clear();
  _sessionOpponents.clear();
  _completedMatchIds.clear();
  _preExistingMatchIds.clear();
  _pendingMatchId = null;
  activeSet.set(null);
  liveSessionStartRating.set(null);
  liveGameStats.set([]);
  lastSetGrade.set(null);
  watcherActive.set(false);
}

// ── Per-file debounce: parse the file FILE_SETTLE_MS after its last write ──

function scheduleFileParse(
  filepath: string,
  connectCode: string,
  db: Database
): void {
  if (_pendingParse.has(filepath)) clearTimeout(_pendingParse.get(filepath)!);
  const timer = setTimeout(
    () => processSlpFile(filepath, connectCode, db),
    FILE_SETTLE_MS
  );
  _pendingParse.set(filepath, timer);
}

async function processSlpFile(
  filepath: string,
  connectCode: string,
  db: Database
): Promise<void> {
  _pendingParse.delete(filepath);
  const filename = filepath.split(/[/\\]/).pop()!;

  try {
    const parsed = await parseSlpFile(filepath, connectCode);
    let completedMatchId: string | null = null;

    for (const g of parsed) {
      await insertGame(db, g);
      if (g.match_type === "ranked" && g.match_id) {
        // Only track live stats for games that started this session
        if (!_preExistingMatchIds.has(g.match_id)) {
          liveGameStats.update((s) => {
            // Deduplicate by timestamp in case the same file is processed twice
            if (s.some((gs) => gs.timestamp === g.timestamp && gs.match_id === g.match_id)) return s;
            // If the last game was more than 1 hour ago, this is a new session — reset
            const SESSION_GAP_MS = 60 * 60 * 1000;
            const last = s.at(-1);
            if (last && Date.now() - new Date(last.timestamp).getTime() > SESSION_GAP_MS) {
              s = [];
              liveSessionStartedAt.set(new Date().toISOString());
            }
            return [...s, {
              match_id: g.match_id,
              result: g.result,
              kills: g.kills,
              deaths: g.deaths,
              openings_per_kill: g.openings_per_kill,
              damage_per_opening: g.damage_per_opening,
              neutral_win_ratio: g.neutral_win_ratio,
              inputs_per_minute: g.inputs_per_minute,
              l_cancel_ratio: g.l_cancel_ratio,
              duration_frames: g.duration_frames,
              stage_id: g.stage_id,
              player_char_id: g.player_char_id,
              opponent_char_id: g.opponent_char_id,
              opponent_code: g.opponent_code,
              timestamp: g.timestamp,
            }];
          });
        }
        const setDone = await handleRankedGame(g, connectCode, db);
        // Only fire a snapshot fetch once per set, and never for pre-existing sets
        if (setDone && !_preExistingMatchIds.has(g.match_id) && !_completedMatchIds.has(g.match_id)) {
          _completedMatchIds.add(g.match_id);
          completedMatchId = g.match_id;
        }
      }
    }

    // Mark as scanned so manual scanner skips it
    await markFilesScanned([filename]);

    const loaded = await getGames(db);
    games.set(loaded);

    statusMessage.set("Ranked session being monitored");

    if (completedMatchId) {
      scheduleSnapshotFetch(connectCode, db, completedMatchId);
    }
  } catch (e: any) {
    statusMessage.set(`Error processing ${filename}: ${e?.message ?? String(e)}`);
    // File might be unreadable or still incomplete — leave it unscanned
    // so the manual scanner can retry it later.
  }
}

// ── Handles one new ranked game. Returns true if the set just completed. ──

async function handleRankedGame(
  g: ParsedGameRow,
  connectCode: string,
  db: Database
): Promise<boolean> {
  const isNew = !_knownMatchIds.has(g.match_id);
  _knownMatchIds.add(g.match_id);

  // Get current set state from DB (includes the game we just inserted)
  const setGames = await getGamesByMatchId(db, g.match_id);
  const wins = setGames.filter((sg) => sg.result === "win" || sg.result === "lras_win").length;
  const losses = setGames.length - wins;
  const isComplete = Math.max(wins, losses) >= 2;

  if (isNew) {
    const sessionFaced = _sessionOpponents.has(g.opponent_code);
    _sessionOpponents.add(g.opponent_code);

    const { allTimeWins, allTimeLosses } = await computeAllTimeRecord(db, g.opponent_code);

    activeSet.set({
      match_id: g.match_id,
      opponent_code: g.opponent_code,
      opponent_char_id: g.opponent_char_id,
      player_char_id: g.player_char_id,
      games_won: wins,
      games_lost: losses,
      started_at: g.timestamp,
      opponent_rating: null,
      opponent_tier: null,
      all_time_wins: allTimeWins,
      all_time_losses: allTimeLosses,
      session_already_faced: sessionFaced,
    });

    // Fetch opponent's Slippi profile asynchronously
    fetchRatingSnapshot(g.opponent_code)
      .then(({ snapshot }) => {
        const tier = getRankTier(snapshot.rating);
        activeSet.update((s) =>
          s && s.match_id === g.match_id
            ? { ...s, opponent_rating: snapshot.rating, opponent_tier: tier.name }
            : s
        );
      })
      .catch(() => {});
  } else {
    // Update score and latest char for an ongoing set
    activeSet.update((s) =>
      s && s.match_id === g.match_id
        ? { ...s, games_won: wins, games_lost: losses, opponent_char_id: g.opponent_char_id }
        : s
    );
  }

  if (isComplete) {
    setResultFlash.set({
      result: wins > losses ? "win" : "loss",
      opponent_code: g.opponent_code,
      wins,
      losses,
    });

    if (import.meta.env.DEV) {
      const setStats = get(liveGameStats).filter((s) => s.match_id === g.match_id);
      const opponentChar = CHARACTERS[g.opponent_char_id] ?? "Unknown";
      const setResult = wins > losses ? "win" : "loss";
      try {
        const grade = gradeSet(setStats, opponentChar, setResult, wins, losses);
        lastSetGrade.set(grade);
      } catch {
        lastSetGrade.set(null);
      }
    }

    activeSet.set(null);
  }

  return isComplete;
}

// ── Compute all-time set record vs a specific opponent ─────────────────────

async function computeAllTimeRecord(
  db: Database,
  opponentCode: string
): Promise<{ allTimeWins: number; allTimeLosses: number }> {
  const gamesVsOpp = await getGamesVsOpponent(db, opponentCode);
  const byMatch = new Map<string, GameRow[]>();
  for (const g of gamesVsOpp) {
    const arr = byMatch.get(g.match_id) ?? [];
    arr.push(g);
    byMatch.set(g.match_id, arr);
  }
  let allTimeWins = 0;
  let allTimeLosses = 0;
  for (const gs of byMatch.values()) {
    if (gs.length < 2) continue;
    const w = gs.filter((g) => g.result === "win" || g.result === "lras_win").length;
    const l = gs.length - w;
    if (Math.max(w, l) < 2) continue;
    if (w > l) allTimeWins++;
    else allTimeLosses++;
  }
  return { allTimeWins, allTimeLosses };
}

// ── Reconstruct active set from recent DB state on watcher start ───────────

async function recoverActiveSet(connectCode: string, db: Database): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const recentGames = await db.select<GameRow[]>(
    `SELECT * FROM games
     WHERE match_type = 'ranked' AND match_id IS NOT NULL AND timestamp >= $1
     ORDER BY timestamp ASC`,
    [oneHourAgo]
  );
  if (recentGames.length === 0) return;

  const byMatch = new Map<string, GameRow[]>();
  for (const g of recentGames) {
    const arr = byMatch.get(g.match_id) ?? [];
    arr.push(g);
    byMatch.set(g.match_id, arr);
    _knownMatchIds.add(g.match_id);
  }

  // Find the most recent incomplete set
  const sorted = [...byMatch.entries()].sort(
    (a, b) =>
      (b[1].at(-1)?.timestamp ?? "").localeCompare(a[1].at(-1)?.timestamp ?? "")
  );

  for (const [matchId, gs] of sorted) {
    const wins = gs.filter((g) => g.result === "win" || g.result === "lras_win").length;
    const losses = gs.length - wins;
    if (Math.max(wins, losses) >= 2) continue; // already complete

    const latest = gs.at(-1)!;
    const { allTimeWins, allTimeLosses } = await computeAllTimeRecord(db, latest.opponent_code);

    activeSet.set({
      match_id: matchId,
      opponent_code: latest.opponent_code,
      opponent_char_id: latest.opponent_char_id,
      player_char_id: latest.player_char_id,
      games_won: wins,
      games_lost: losses,
      started_at: gs[0].timestamp,
      opponent_rating: null,
      opponent_tier: null,
      all_time_wins: allTimeWins,
      all_time_losses: allTimeLosses,
      session_already_faced: false,
    });

    fetchRatingSnapshot(latest.opponent_code)
      .then(({ snapshot }) => {
        const tier = getRankTier(snapshot.rating);
        activeSet.update((s) =>
          s && s.match_id === matchId
            ? { ...s, opponent_rating: snapshot.rating, opponent_tier: tier.name }
            : s
        );
      })
      .catch(() => {});

    break;
  }
}

// ── Debounced snapshot fetch — fires 15s after the last set completion ────
// Retries once after 30s if the API rating hasn't updated yet.

function scheduleSnapshotFetch(
  connectCode: string,
  db: Database,
  matchId: string
): void {
  _pendingMatchId = matchId;
  if (_snapshotTimer) clearTimeout(_snapshotTimer);
  _snapshotTimer = setTimeout(
    () => fetchAndStoreSnapshot(connectCode, db, 0),
    10_000
  );
}

async function fetchAndStoreSnapshot(
  connectCode: string,
  db: Database,
  attempt: number,
  triggeredBy: string | null = null
): Promise<void> {
  _snapshotTimer = null;

  // On first attempt, capture and clear the pending match id
  if (attempt === 0) {
    triggeredBy = _pendingMatchId;
    _pendingMatchId = null;
  }

  try {
    const { snapshot: snap, seasons: fetchedSeasons } = await fetchRatingSnapshot(connectCode);

    // If rating is unchanged, the API hasn't processed the set yet.
    // Retry once after 30s, carrying triggeredBy through so it's preserved on success.
    const currentSnaps = get(snapshots);
    const lastRating = currentSnaps.at(-1)?.rating;
    if (attempt === 0 && lastRating !== undefined && snap.rating === lastRating) {
      _snapshotTimer = setTimeout(
        () => fetchAndStoreSnapshot(connectCode, db, 1, triggeredBy),
        30_000
      );
      return;
    }

    await insertSnapshot(db, {
      ...snap,
      connect_code: connectCode,
      triggered_by_match_id: triggeredBy ?? undefined,
    });

    for (const s of fetchedSeasons) {
      await insertSeason(db, { ...s, connect_code: connectCode });
    }

    const loadedSnaps = await getSnapshots(db, connectCode);
    snapshots.set(loadedSnaps);
    const loadedSeasons = await getSeasons(db, connectCode);
    seasons.set(loadedSeasons);
  } catch {
    // Silently fail — user can manually fetch
  }
}
