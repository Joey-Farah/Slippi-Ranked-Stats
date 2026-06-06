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
import { fetchRatingSnapshot, type ProfileCharacter } from "./api";
import { API_CHAR_TO_EXTERNAL, internalToExternal } from "./char-icons";
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
  displayName,
  lastOverlaySet,
  setResultFromGames,
} from "./store";
import { CHARACTERS } from "./parser";
import { gradeSet, featuredCategory, GRADE_VERSION } from "./grading";
import { saveSetGrade } from "./db";
import { pingTelemetry } from "./telemetry";

let _unwatchers: UnwatchFn[] = [];
let _snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingMatchId: string | null = null;

// Match IDs that were already in the DB when the watcher started.
// Games with these IDs are from previous sessions and must not go into liveGameStats.
const _preExistingMatchIds = new Set<string>();

// Per-file debounce: maps absolute filepath → timer handle.
// A file is "done" when it stops being modified for FILE_SETTLE_MS.
const _pendingParse = new Map<string, ReturnType<typeof setTimeout>>();
const FILE_SETTLE_MS = 800; // ms of write-inactivity before we parse (the file is already complete once writes stop)

// Tracks match_ids seen during this watcher session to detect new vs ongoing sets
const _knownMatchIds = new Set<string>();
// Tracks opponent codes faced during this watcher session for rematch detection
const _sessionOpponents = new Set<string>();
// Tracks match_ids that have already triggered a snapshot fetch (prevents duplicates)
const _completedMatchIds = new Set<string>();

// The opponent's "mains" for the overlay: top characters from their Slippi profile as
// external char ids, most-played first. Always keeps their #1, then any other character
// with >=15% of their season games, capped at 3. Empty when the profile lists none (season
// reset / new player), so the overlay falls back to the live in-game char.
function topOpponentChars(chars: ProfileCharacter[]): number[] {
  const mapped = chars
    .map((c) => ({ id: API_CHAR_TO_EXTERNAL[c.character], n: c.gameCount }))
    .filter((c) => c.id !== undefined && c.n > 0)
    .sort((a, b) => b.n - a.n);
  if (mapped.length === 0) return [];
  const total = mapped.reduce((sum, c) => sum + c.n, 0);
  const threshold = total * 0.15;
  return mapped
    .filter((c, i) => i === 0 || c.n >= threshold)
    .slice(0, 3)
    .map((c) => c.id);
}

export async function startWatcher(
  dirs: string | string[],
  connectCode: string,
  db: Database
): Promise<void> {
  if (_unwatchers.length > 0) return; // already running

  pingTelemetry("watcher_start");

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
    .then(async ({ snapshot, seasons: fetchedSeasons, displayName: tag }) => {
      if (tag) displayName.set(tag);
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

  const watchDirs = Array.isArray(dirs) ? dirs : [dirs];
  const handler = (event: Parameters<Parameters<typeof watch>[1]>[0]) => {
    const slpPaths = event.paths.filter((p) => p.endsWith(".slp"));
    if (typeof event.type === "string") return;
    const isCreate = "create" in event.type;
    const isModify = "modify" in event.type;
    if (!isCreate && !isModify) return;
    if (slpPaths.length === 0) return;
    // A brand-new .slp while no set is live means the next set is starting. If a just-completed
    // set's grade is still showing on the overlay (within its 3-min post-set hold), clear it now
    // so the new set takes priority — the hold otherwise stays put for the full duration, and the
    // new opponent line won't arrive until this game finishes and parses. The (activeSet === null
    // && lastOverlaySet !== null) guard pins this to exactly the "between sets, grade still up"
    // window, so it never fires for games 2/3 of an ongoing set.
    if (isCreate && get(activeSet) === null && get(lastOverlaySet) !== null) {
      lastOverlaySet.set(null);
    }
    for (const filepath of slpPaths) {
      scheduleFileParse(filepath, connectCode, db);
    }
  };

  _unwatchers = await Promise.all(
    watchDirs.map((dir) => watch(dir, handler, { recursive: true }))
  );

  watcherActive.set(true);
}

export async function stopWatcher(): Promise<void> {
  for (const uw of _unwatchers) uw();
  _unwatchers = [];
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
              counter_hit_rate: g.counter_hit_rate,
              inputs_per_minute: g.inputs_per_minute,
              l_cancel_ratio: g.l_cancel_ratio,
              avg_kill_percent: g.avg_kill_percent,
              avg_death_percent: g.avg_death_percent,
              defensive_option_rate: g.defensive_option_rate,
              opening_conversion_rate: g.opening_conversion_rate,
              stage_control_ratio: g.stage_control_ratio,
              lead_maintenance_rate: g.lead_maintenance_rate,
              tech_chase_rate: g.tech_chase_rate,
              edgeguard_success_rate: g.edgeguard_success_rate,
              hit_advantage_rate: g.hit_advantage_rate,
              recovery_success_rate: g.recovery_success_rate,
              avg_stock_duration: g.avg_stock_duration,
              respawn_defense_rate: g.respawn_defense_rate,
              comeback_rate: g.comeback_rate,
              wavedash_miss_rate: g.wavedash_miss_rate,
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
    await markFilesScanned([filename], connectCode);

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
  // A set ends at first-to-2 games OR the moment someone quits out (LRAS forfeits the set).
  // We only treat a quit-out as a completed, gradeable set when at least one *full* game was
  // actually played — a 0-0 instant ragequit has no real gameplay to grade.
  const endedByQuit = setGames.some((sg) => sg.result === "lras_win" || sg.result === "lras_loss");
  const hasFullGame = setGames.some((sg) => sg.result === "win" || sg.result === "loss");
  const isComplete = Math.max(wins, losses) >= 2 || (endedByQuit && hasFullGame);

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
      opponent_tier_color: null,
      opponent_tag: null,
      opponent_season_wins: null,
      opponent_season_losses: null,
      opponent_chars: null,
      all_time_wins: allTimeWins,
      all_time_losses: allTimeLosses,
      session_already_faced: sessionFaced,
    });

    // Fetch opponent's Slippi profile asynchronously
    fetchRatingSnapshot(g.opponent_code)
      .then(({ snapshot, displayName: oppTag, characters }) => {
        const tier = getRankTier(snapshot.rating, snapshot.global_rank > 0);
        activeSet.update((s) =>
          s && s.match_id === g.match_id
            ? {
                ...s,
                opponent_rating: snapshot.rating,
                opponent_tier: tier.name,
                opponent_tier_color: tier.color,
                opponent_tag: oppTag || null,
                opponent_season_wins: snapshot.wins,
                opponent_season_losses: snapshot.losses,
                opponent_chars: topOpponentChars(characters),
              }
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
    // Forfeit-aware: an opponent quit-out is a set win even at an even game count.
    const setResult = setResultFromGames(setGames);
    // Won only because the opponent quit out — suppresses the set-comeback bonus in grading.
    const forfeitWin = setResult === "win" && setGames.some((sg) => sg.result === "lras_win");
    setResultFlash.set({
      result: setResult,
      opponent_code: g.opponent_code,
      wins,
      losses,
    });

    const allSetStats   = get(liveGameStats).filter((s) => s.match_id === g.match_id);
    const setStats      = allSetStats.filter((s) => s.avg_stock_duration !== null);
    const playerChar   = CHARACTERS[g.player_char_id]   ?? "Unknown";
    const opponentChar = CHARACTERS[g.opponent_char_id] ?? "Unknown";
    // Game 1 result (earliest by timestamp) drives the set-level comeback modifier.
    // Use the unfiltered list so a no-frames Game 1 still anchors the order.
    const orderedSet = [...allSetStats].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const wonGame1   = orderedSet.length > 0 ? orderedSet[0].result === "win" : null;
    let gradeLetter: string | null = null;
    let gradeToSave: ReturnType<typeof gradeSet> | null = null;
    try {
      if (setStats.length === 0) {
        lastSetGrade.set(null);
      } else {
        const grade = gradeSet(setStats, playerChar, opponentChar, setResult, wins, losses, wonGame1, forfeitWin);
        // Skip caching if all categories are null — stats were bad (e.g. live store
        // hadn't populated both games yet). The set will appear ungraded and the user
        // can regrade from the history tab to get real results.
        const hasRealData = Object.values(grade.categories).some((c) => c.score !== null);
        lastSetGrade.set(hasRealData ? grade : null);
        if (hasRealData) {
          gradeLetter = grade.letter;
          gradeToSave = grade; // persisted below, AFTER the live stores update
          pingTelemetry("set_graded");
        }
      }
    } catch {
      lastSetGrade.set(null);
    }

    // Unified stream overlay: record the completed set (with its grade) so the overlay
    // can run its post-set bridge — hold the result + grade letter, then surface the MMR
    // change once the refetched rating lands.
    //
    // This MUST happen before the saveSetGrade() await below. The grade letter is already
    // computed, and the overlay's post-set bridge doesn't depend on the DB row. Gating this
    // store update behind the persistence write made the overlay lag the in-app grade by
    // however long the INSERT took (seconds, under DB contention) — the app showed the grade
    // immediately but the overlay only caught up once the write resolved.
    // Feature the standout category under the grade: best on a win, worst on a loss.
    const featured = gradeToSave ? featuredCategory(gradeToSave, setResult === "win") : null;
    lastOverlaySet.set({
      setId: Date.now(),
      result: setResult,
      wins,
      losses,
      opponentCode: g.opponent_code,
      opponentChar,
      opponentCharId: internalToExternal(g.opponent_char_id),
      ratingBefore: get(snapshots).at(-1)?.rating ?? null,
      gradeLetter,
      subLabel: featured?.label ?? null,
      subLetter: featured?.letter ?? null,
      subStatLabel: featured?.stat?.label ?? null,
      subStatLetter: featured?.stat?.letter ?? null,
    });

    activeSet.set(null);

    // Persist the grade last — the live UI (tab + overlay) is already updated, so a slow or
    // failing DB write no longer delays them.
    if (gradeToSave) {
      try {
        await saveSetGrade(db, {
          match_id:         g.match_id,
          generated_at:     new Date().toISOString(),
          set_timestamp:    g.timestamp,
          baseline_version: GRADE_VERSION,
          player_char:      playerChar,
          opponent_char:    opponentChar,
          opponent_code:    g.opponent_code,
          baseline_source:  gradeToSave.baselineSource,
          set_result:       gradeToSave.setResult,
          wins:             gradeToSave.wins,
          losses:           gradeToSave.losses,
          overall_letter:   gradeToSave.letter,
          overall_score:    gradeToSave.score,
          neutral_score:    gradeToSave.categories.neutral.score,
          neutral_letter:   gradeToSave.categories.neutral.letter,
          punish_score:     gradeToSave.categories.punish.score,
          punish_letter:    gradeToSave.categories.punish.letter,
          defense_score:    gradeToSave.categories.defense.score,
          defense_letter:   gradeToSave.categories.defense.letter,
          execution_score:  null,
          execution_letter: null,
          breakdown_json:   JSON.stringify(gradeToSave.breakdown),
        });
      } catch { /* don't fail live session on DB write error */ }
    }
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
      opponent_tier_color: null,
      opponent_tag: null,
      opponent_season_wins: null,
      opponent_season_losses: null,
      opponent_chars: null,
      all_time_wins: allTimeWins,
      all_time_losses: allTimeLosses,
      session_already_faced: false,
    });

    fetchRatingSnapshot(latest.opponent_code)
      .then(({ snapshot, displayName: oppTag, characters }) => {
        const tier = getRankTier(snapshot.rating, snapshot.global_rank > 0);
        activeSet.update((s) =>
          s && s.match_id === matchId
            ? {
                ...s,
                opponent_rating: snapshot.rating,
                opponent_tier: tier.name,
                opponent_tier_color: tier.color,
                opponent_tag: oppTag || null,
                opponent_season_wins: snapshot.wins,
                opponent_season_losses: snapshot.losses,
                opponent_chars: topOpponentChars(characters),
              }
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
    const { snapshot: snap, seasons: fetchedSeasons, displayName: tag } = await fetchRatingSnapshot(connectCode);
    if (tag) displayName.set(tag);

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
