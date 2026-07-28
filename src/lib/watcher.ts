import { watch, readFile, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { parseSlpHeader, type SlpHeaderInfo } from "./slp_parser";
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
  isLiveMode,
  type LiveMode,
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

// Unranked/direct connections have no end event — a ranked set clears activeSet the moment
// someone reaches 2, but an unranked run just stops when the players leave, and nothing in the
// replay stream says so. Without this the overlay would keep showing the last opponent forever.
// Each new game in the run resets the timer; going quiet this long clears the opponent line.
const IDLE_CLEAR_MS = 15 * 60 * 1000;
let _idleClearTimer: ReturnType<typeof setTimeout> | null = null;

function armIdleClear(matchId: string): void {
  if (_idleClearTimer) clearTimeout(_idleClearTimer);
  _idleClearTimer = setTimeout(() => {
    _idleClearTimer = null;
    // Only clear if the same run is still showing — a newer match already replaced it otherwise.
    activeSet.update((s) => (s && s.match_id === matchId ? null : s));
  }, IDLE_CLEAR_MS);
}

function cancelIdleClear(): void {
  if (_idleClearTimer) clearTimeout(_idleClearTimer);
  _idleClearTimer = null;
}

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
      // A brand-new file means a game just STARTED. Peek at its Game Start block right away so
      // the opponent card appears now rather than after the game ends — the normal parse below
      // can't do this, because it waits for writes to stop and Slippi writes frames at 60fps
      // for the whole match.
      if (isCreate) peekHeader(filepath, connectCode, db);
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
  cancelIdleClear();
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

// ── Game-start peek: show the opponent before the game is over ─────────────
//
// Slippi creates the .slp and writes its Game Start block immediately, but the file keeps
// growing until the match ends, so the debounced parse can't run until then. This reads the
// header alone and puts the opponent on screen straight away. The full parse still runs at
// game end and remains the source of truth for everything else.
//
// The file may exist before the header is fully flushed, so this retries on a short backoff.
const HEADER_PEEK_DELAYS_MS = [120, 400, 1200, 3000];

async function peekHeader(
  filepath: string,
  connectCode: string,
  db: Database,
  attempt = 0
): Promise<void> {
  try {
    // Safe to read whole: a just-created replay is a few KB. We never peek at an existing file.
    const bytes = await readFile(filepath);
    const head = parseSlpHeader(bytes, [connectCode]);
    if (head && isLiveMode(head.match_type)) {
      await showOpponentEarly(head, db);
      return;
    }
    // A valid file that simply isn't ours / isn't 1v1 — no point retrying.
    if (head) return;
  } catch {
    // File not readable yet; fall through to the retry.
  }
  if (attempt + 1 < HEADER_PEEK_DELAYS_MS.length) {
    setTimeout(
      () => peekHeader(filepath, connectCode, db, attempt + 1),
      HEADER_PEEK_DELAYS_MS[attempt + 1]
    );
  }
}

async function showOpponentEarly(head: SlpHeaderInfo, db: Database): Promise<void> {
  // Already showing this match (e.g. game 2 of a set) — leave it alone, otherwise the running
  // score would be reset to 0–0 every time a new game file appears.
  if (get(activeSet)?.match_id === head.match_id) return;
  // Don't resurrect a ranked set that already finished.
  if (_completedMatchIds.has(head.match_id)) return;

  const mode = head.match_type as LiveMode;
  const { allTimeWins, allTimeLosses, unit } = await computeAllTimeRecord(db, head.opponent_code, mode);
  if (get(activeSet)?.match_id === head.match_id) return; // lost a race with the real parse

  if (mode !== "ranked") armIdleClear(head.match_id);

  activeSet.set({
    match_id: head.match_id,
    mode,
    opponent_code: head.opponent_code,
    // Character comes from the metadata block at game end; the header's ids are in a different
    // id space than the rest of the app uses, so it stays unknown until the full parse.
    opponent_char_id: -1,
    player_char_id: -1,
    games_won: 0,
    games_lost: 0,
    started_at: new Date().toISOString(),
    opponent_rating: null,
    opponent_tier: null,
    opponent_tier_color: null,
    opponent_tag: null,
    opponent_season_wins: null,
    opponent_season_losses: null,
    opponent_chars: null,
    all_time_wins: allTimeWins,
    all_time_losses: allTimeLosses,
    all_time_unit: unit,
    session_already_faced: _sessionOpponents.has(head.opponent_code),
  });

  fetchRatingSnapshot(head.opponent_code)
    .then(({ snapshot, displayName: oppTag, characters }) => {
      const tier = getRankTier(snapshot.rating, snapshot.global_rank > 0);
      activeSet.update((s) =>
        s && s.match_id === head.match_id
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
      if (isLiveMode(g.match_type) && g.match_id) {
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
              match_type: g.match_type as LiveMode,
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
        const setDone = await handleLiveGame(g, connectCode, db);
        // Only fire a snapshot fetch once per set, and never for pre-existing sets.
        // handleLiveGame only ever reports completion for ranked, so unranked/direct games
        // can't trip a rating refetch — that would write phantom snapshots into the rating
        // history for modes that don't move your Rating at all.
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

    statusMessage.set("Session being monitored");

    if (completedMatchId) {
      scheduleSnapshotFetch(connectCode, db, completedMatchId);
    }
  } catch (e: any) {
    statusMessage.set(`Error processing ${filename}: ${e?.message ?? String(e)}`);
    // File might be unreadable or still incomplete — leave it unscanned
    // so the manual scanner can retry it later.
  }
}

// ── Handles one new live game. Returns true if a ranked set just completed. ──
//
// Ranked is the only mode with sets, so it's the only mode that can return true — and
// completion is what drives grading, the set-result flash, the overlay's post-set bridge and
// the rating refetch. Unranked and direct share a single match_id for the whole connection,
// so they only ever keep the running tally on activeSet up to date.

async function handleLiveGame(
  g: ParsedGameRow,
  connectCode: string,
  db: Database
): Promise<boolean> {
  const mode = g.match_type as LiveMode;
  const isRanked = mode === "ranked";
  const isNew = !_knownMatchIds.has(g.match_id);
  _knownMatchIds.add(g.match_id);

  // Get current state from DB (includes the game we just inserted). For ranked this is the
  // set; for unranked/direct it's every game played against them on this connection.
  const setGames = await getGamesByMatchId(db, g.match_id);
  const wins = setGames.filter((sg) => sg.result === "win" || sg.result === "lras_win").length;
  const losses = setGames.length - wins;
  // A set ends at first-to-2 games OR the moment someone quits out (LRAS forfeits the set).
  // We only treat a quit-out as a completed, gradeable set when at least one *full* game was
  // actually played — a 0-0 instant ragequit has no real gameplay to grade.
  const endedByQuit = setGames.some((sg) => sg.result === "lras_win" || sg.result === "lras_loss");
  const hasFullGame = setGames.some((sg) => sg.result === "win" || sg.result === "loss");
  const isComplete = isRanked && (Math.max(wins, losses) >= 2 || (endedByQuit && hasFullGame));

  // Unranked/direct runs never "complete", so they need an idle timeout to stop showing a
  // stale opponent once the players part ways. Re-armed on every game in the run.
  if (!isRanked) armIdleClear(g.match_id);

  // Rebuild the whole card for a genuinely new match, and also when an unranked/direct run is
  // no longer the one on screen — the idle timeout clears a quiet run, but the players may just
  // have been between games, and the same match_id picking back up has to restore the opponent
  // line. Ranked deliberately doesn't do this: a set that already completed stays completed.
  const current = get(activeSet);
  const rebuild = isNew || (!isRanked && current?.match_id !== g.match_id);

  if (rebuild) {
    // "Rematch this session" means a *separate* earlier match against them. A resumed run is
    // the same match continuing, so it must not light up the rematch warning.
    const sessionFaced = isNew && _sessionOpponents.has(g.opponent_code);
    _sessionOpponents.add(g.opponent_code);

    const { allTimeWins, allTimeLosses, unit } = await computeAllTimeRecord(db, g.opponent_code, mode);

    // The game-start peek usually got here first and already fetched the opponent's profile.
    // Carry those fields over rather than resetting them to null — otherwise the card would
    // visibly blank out at the end of game 1 and repopulate a moment later.
    const prev = get(activeSet);
    const carry =
      prev && prev.match_id === g.match_id && prev.opponent_code === g.opponent_code ? prev : null;

    activeSet.set({
      match_id: g.match_id,
      mode,
      opponent_code: g.opponent_code,
      opponent_char_id: g.opponent_char_id,
      player_char_id: g.player_char_id,
      games_won: wins,
      games_lost: losses,
      started_at: g.timestamp,
      opponent_rating: carry?.opponent_rating ?? null,
      opponent_tier: carry?.opponent_tier ?? null,
      opponent_tier_color: carry?.opponent_tier_color ?? null,
      opponent_tag: carry?.opponent_tag ?? null,
      opponent_season_wins: carry?.opponent_season_wins ?? null,
      opponent_season_losses: carry?.opponent_season_losses ?? null,
      opponent_chars: carry?.opponent_chars ?? null,
      all_time_wins: allTimeWins,
      all_time_losses: allTimeLosses,
      all_time_unit: unit,
      session_already_faced: carry ? carry.session_already_faced : sessionFaced,
    });

    // Skip the profile fetch when the game-start peek already landed one — same data, and a
    // second call per set is pure waste. Anything else below still runs normally.
    if (carry?.opponent_rating == null) {
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
    }
  } else {
    // Update score and latest char for an ongoing set / run
    activeSet.update((s) =>
      s && s.match_id === g.match_id
        ? { ...s, games_won: wins, games_lost: losses, opponent_char_id: g.opponent_char_id }
        : s
    );
  }

  if (isComplete) {
    // A ranked set superseding an unranked run: drop the pending idle clear so it can't fire
    // later and wipe whatever is on screen by then.
    cancelIdleClear();
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

// ── Compute all-time record vs a specific opponent ─────────────────────────
//
// Counted in whatever unit the mode actually has. Ranked groups games into completed sets and
// counts those. Unranked/direct have no sets — a match_id there is one whole connection — so
// they're counted in games, which is also the number that means something across many nights
// of friendlies with the same person.

async function computeAllTimeRecord(
  db: Database,
  opponentCode: string,
  mode: LiveMode
): Promise<{ allTimeWins: number; allTimeLosses: number; unit: "sets" | "games" }> {
  const gamesVsOpp = await getGamesVsOpponent(db, opponentCode, mode);
  let allTimeWins = 0;
  let allTimeLosses = 0;

  if (mode !== "ranked") {
    for (const g of gamesVsOpp) {
      if (g.result === "win" || g.result === "lras_win") allTimeWins++;
      else allTimeLosses++;
    }
    return { allTimeWins, allTimeLosses, unit: "games" };
  }

  const byMatch = new Map<string, GameRow[]>();
  for (const g of gamesVsOpp) {
    const arr = byMatch.get(g.match_id) ?? [];
    arr.push(g);
    byMatch.set(g.match_id, arr);
  }
  for (const gs of byMatch.values()) {
    if (gs.length < 2) continue;
    const w = gs.filter((g) => g.result === "win" || g.result === "lras_win").length;
    const l = gs.length - w;
    if (Math.max(w, l) < 2) continue;
    if (w > l) allTimeWins++;
    else allTimeLosses++;
  }
  return { allTimeWins, allTimeLosses, unit: "sets" };
}

// ── Reconstruct active set from recent DB state on watcher start ───────────

async function recoverActiveSet(connectCode: string, db: Database): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const recentGames = await db.select<GameRow[]>(
    `SELECT * FROM games
     WHERE match_type IN ('ranked', 'unranked', 'direct')
       AND match_id IS NOT NULL AND timestamp >= $1
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

  // Find the most recent still-running match
  const sorted = [...byMatch.entries()].sort(
    (a, b) =>
      (b[1].at(-1)?.timestamp ?? "").localeCompare(a[1].at(-1)?.timestamp ?? "")
  );

  for (const [matchId, gs] of sorted) {
    const latest = gs.at(-1)!;
    const mode = (isLiveMode(latest.match_type) ? latest.match_type : "ranked") as LiveMode;
    const wins = gs.filter((g) => g.result === "win" || g.result === "lras_win").length;
    const losses = gs.length - wins;
    // Only ranked can be "already complete" — an unranked/direct run within the recovery
    // window is still live no matter the score, since nothing ends it but walking away.
    if (mode === "ranked" && Math.max(wins, losses) >= 2) continue;
    // An unranked/direct run only counts as live if it's the most recent thing played. Without
    // this, finishing a ranked set would fall through to an abandoned unranked run from earlier
    // in the window and put a stale opponent back on screen.
    if (mode !== "ranked" && matchId !== sorted[0][0]) continue;

    const { allTimeWins, allTimeLosses, unit } = await computeAllTimeRecord(db, latest.opponent_code, mode);
    if (mode !== "ranked") armIdleClear(matchId);

    activeSet.set({
      match_id: matchId,
      mode,
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
      all_time_unit: unit,
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
