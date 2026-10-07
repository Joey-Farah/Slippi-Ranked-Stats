/**
 * Per-game grading for unranked + direct play: the batch job that fills `game_stats`, and the
 * in-memory scoring that turns those rows into grades.
 *
 * Why this exists: ranked grades a SET and stores the finished grade in `set_grades`. Unranked
 * and direct have no set to grade — one `match_id` is the entire connection with that opponent
 * (verified at up to 62 games) — so the unit is a game. But `games` stores metadata only, so a
 * historical game's stats exist nowhere and have to be re-read from its replay.
 *
 * The split that makes this affordable: we store the parser's STATS and derive the grade, rather
 * than storing the grade. Re-scoring the whole corpus is ~0.1s in memory, so a benchmark rebuild
 * or a weight change costs nothing; only a change to the parser's stat math
 * (`PARSER_STATS_VERSION`) forces replays to be read again.
 *
 * Design detail in docs/plans/per-game-grade-persistence.md.
 */

import { writable, derived } from "svelte/store";
import type Database from "@tauri-apps/plugin-sql";
import {
  getDb, getGames, saveGameStats, getAllGameStats, getCurrentGameStatsFilenames,
  updateGameFilepath, type GameStatsRow, type GameRow,
} from "./db";
import { CHARACTERS, PARSER_STATS_VERSION, collectSlpFiles, parseSlpFile } from "./parser";
import { indexByBasename, resolveReplayPath } from "./replay-index";
import { isGradeCandidate } from "./grade-queue";
import { gradeGame, GRADE_VERSION, type SetGrade } from "./grading";
import type { LiveGameStats, LiveMode } from "./store";

/** Progress is reported every this many games. Deliberately not every game: the point is a bar
 *  that moves, and a store write per game is a re-render per game for a job that can run for an
 *  hour. Deliberately not every commit chunk either — at the in-app ~0.3 s/game a 100-game
 *  chunk is 30 seconds of a frozen bar. */
const PROGRESS_EVERY = 10;

/** Rows per DB write. A kill mid-run costs at most this much work, and nothing has to be
 *  reconciled on restart because the queue IS "no row at the current stats_version". */
const COMMIT_CHUNK = 100;

export const gameGradeBusy = writable<boolean>(false);
export const gameGradeProgress = writable<{ current: number; total: number }>({
  current: 0,
  total: 0,
});
/** Set when a run ends having failed to read files, so the UI can say so instead of silently
 *  reporting fewer grades than the button promised. */
export const gameGradeNote = writable<string>("");

/** Stored per-game stats, newest first. Hydrated by `loadGameStats`. */
export const gameStats = writable<GameStatsRow[]>([]);

let _cancelled = false;
/** Cancel an in-flight batch. Mirrors `cancelScan()` in parser.ts. */
export function cancelGameGrading() {
  _cancelled = true;
}

// ── Scoring (cheap, in memory) ─────────────────────────────────────────────

/** Rebuild the `LiveGameStats` shape `gradeGame` expects from a stored row.
 *
 *  ⚠ `match_type` is load-bearing, not decoration: it decides both the win bonus (ranked only)
 *  and whether a quit-out counts as a result at all (see `outcome.ts`). */
export function rowToLiveGame(row: GameStatsRow): LiveGameStats {
  return {
    match_id:                row.match_id,
    match_type:              row.match_type as LiveMode,
    result:                  row.result,
    kills:                   row.kills ?? 0,
    deaths:                  row.deaths ?? 0,
    openings_per_kill:       row.openings_per_kill,
    damage_per_opening:      row.damage_per_opening,
    neutral_win_ratio:       row.neutral_win_ratio,
    counter_hit_rate:        row.counter_hit_rate,
    inputs_per_minute:       row.inputs_per_minute,
    l_cancel_ratio:          row.l_cancel_ratio,
    avg_kill_percent:        row.avg_kill_percent,
    avg_death_percent:       row.avg_death_percent,
    defensive_option_rate:   row.defensive_option_rate,
    opening_conversion_rate: row.opening_conversion_rate,
    stage_control_ratio:     row.stage_control_ratio,
    lead_maintenance_rate:   row.lead_maintenance_rate,
    tech_chase_rate:         row.tech_chase_rate,
    edgeguard_success_rate:  row.edgeguard_success_rate,
    hit_advantage_rate:      row.hit_advantage_rate,
    recovery_success_rate:   row.recovery_success_rate,
    avg_stock_duration:      row.avg_stock_duration,
    respawn_defense_rate:    row.respawn_defense_rate,
    comeback_rate:           row.comeback_rate,
    wavedash_miss_rate:      row.wavedash_miss_rate,
    duration_frames:         row.duration_frames,
    stage_id:                row.stage_id,
    player_char_id:          -1, // unused by gradeGame; chars are passed by name below
    opponent_char_id:        -1,
    opponent_code:           row.opponent_code,
    timestamp:               row.game_timestamp,
  };
}

export interface GameGradeEntry {
  filename:      string;
  matchId:       string;
  timestamp:     string;
  matchType:     string;
  opponentCode:  string;
  playerChar:    string;
  opponentChar:  string;
  result:        string;
  grade:         SetGrade | null;
  /** Null grade is not an error — see `scoreGameStats`. */
  ungradable:    boolean;
}

/** Score stored rows. Pure and fast (~0.1s for a 15k corpus), which is the whole reason the
 *  grade isn't stored.
 *
 *  ⚠ A row with `avg_stock_duration === null` is stored but NOT gradable: that's the parser's
 *  signal that the replay held no frames at all (opponent left before the game started). The row
 *  exists so the batch job never re-reads that file hunting for stats it doesn't have. */
export function scoreGameStats(rows: readonly GameStatsRow[]): GameGradeEntry[] {
  const out: GameGradeEntry[] = [];
  for (const row of rows) {
    const ungradable = row.avg_stock_duration === null;
    out.push({
      filename:     row.filename,
      matchId:      row.match_id,
      timestamp:    row.game_timestamp,
      matchType:    row.match_type,
      opponentCode: row.opponent_code,
      playerChar:   row.player_char,
      opponentChar: row.opponent_char,
      result:       row.result,
      ungradable,
      grade: ungradable
        ? null
        : gradeGame(rowToLiveGame(row), row.player_char, row.opponent_char),
    });
  }
  return out;
}

/** Non-ranked stored grades, newest first — what the Unranked sub-tab renders.
 *  Scoped here rather than in `store.ts` so the scoring cost is paid only by subscribers. */
export const unrankedGameGrades = derived(gameStats, ($rows) =>
  scoreGameStats($rows.filter((r) => r.match_type !== "ranked"))
);

// ── Hydration ──────────────────────────────────────────────────────────────

/** Load stored stats for every linked code, deduped by filename.
 *  Mirrors the existing grade-history hydration, which also walks `effectiveCodes`. */
export async function loadGameStats(codes: readonly string[]): Promise<void> {
  const byFile = new Map<string, GameStatsRow>();
  for (const code of codes) {
    try {
      const db = await getDb(code);
      for (const row of await getAllGameStats(db)) {
        if (!byFile.has(row.filename)) byFile.set(row.filename, row);
      }
    } catch {
      // A code with no DB yet is normal (a linked code that has never scanned).
    }
  }
  const rows = [...byFile.values()].sort((a, b) =>
    b.game_timestamp.localeCompare(a.game_timestamp)
  );
  gameStats.set(rows);
}

/** How many unranked/direct games the batch job would actually read, counted the same way it
 *  builds its queue: from the DATABASE, ignoring the sidebar Date Range.
 *
 *  ⚠ This must not be derived from `filteredGames` / `unrankedGames`. Those apply the date
 *  filter, so a user on "Last 30 Days" would see a button offering 30 days of games, run it, and
 *  be told everything was done while years of history stayed ungraded. */
export async function countGameStatsQueue(codes: readonly string[]): Promise<number> {
  const seen = new Set<string>();
  for (const code of codes) {
    try {
      const db = await getDb(code);
      const done = await getCurrentGameStatsFilenames(db, PARSER_STATS_VERSION);
      for (const g of await getGames(db)) {
        if (g.match_type === "ranked") continue;
        if (done.has(g.filename)) continue;
        if (!isGradeCandidate(g)) continue;
        seen.add(g.filename);
      }
    } catch {
      // No DB for that code yet.
    }
  }
  return seen.size;
}

// ── The batch job ──────────────────────────────────────────────────────────

export interface GameStatsBatchResult {
  parsed:      number;
  skipped:     number;
  failed:      number;
  cancelled:   boolean;
  note:        string;
}

/**
 * Re-read the replays of every un-stored unranked/direct game and store their stats.
 *
 * ⚠ The queue is built from the DATABASE, not from `filteredGames` — those stores apply the
 * sidebar Date Range, so a user on "Last 30 Days" would grade 30 days of games and then be told
 * they were done.
 *
 * ⚠ Never call this on launch or on tab open. The v1.8.8 startup auto-scan is already reading
 * replays over the same IPC channel, and two jobs fighting over it is the one way to make a
 * 9 ms/game operation slow.
 */
export async function runGameStatsBatch(opts: {
  codes: readonly string[];
  primaryCode: string;
  replayDirs: readonly string[];
}): Promise<GameStatsBatchResult> {
  const { codes, primaryCode, replayDirs } = opts;
  _cancelled = false;

  // Replay lookup for rows whose stored filepath has gone stale (the folder was reorganised).
  // Built lazily, at most once per run, and only after a path has actually failed.
  // ⚠ Not wrapped in a bare `catch {}` — the first version of the equivalent fix on the ranked
  // path repaired nothing precisely because its failure was invisible.
  let replayIndex: Map<string, string> | null = null;
  let replayIndexNote = "";
  const replayIndexFor = async (): Promise<Map<string, string>> => {
    if (replayIndex) return replayIndex;
    const entries: { name: string; path: string }[] = [];
    const problems: string[] = [];
    if (replayDirs.length === 0) problems.push("no replay folders configured");
    for (const dir of replayDirs) {
      try {
        const found = await collectSlpFiles(dir);
        entries.push(...found);
        if (found.length === 0) problems.push(`${dir}: 0 .slp found`);
      } catch (e: any) {
        problems.push(`${dir}: ${e?.message ?? e}`);
      }
    }
    replayIndex = indexByBasename(entries);
    replayIndexNote =
      `replay index: ${replayIndex.size} files` +
      (problems.length ? ` [${problems.join("; ")}]` : "");
    console.warn("[game-grading] " + replayIndexNote);
    return replayIndex;
  };

  const dbMap = new Map<string, Database>();
  for (const c of codes) {
    try {
      dbMap.set(c, await getDb(c));
    } catch {
      // No DB for that code yet; nothing of its to grade.
    }
  }

  // Build the queue: unranked/direct games with no current-version stats row, newest first so
  // the most recent play is what fills in first.
  type Job = { game: GameRow; code: string };
  const jobs: Job[] = [];
  let skipped = 0;
  for (const [code, db] of dbMap) {
    let done: Set<string>;
    try {
      done = await getCurrentGameStatsFilenames(db, PARSER_STATS_VERSION);
    } catch {
      done = new Set();
    }
    let rows: GameRow[];
    try {
      rows = await getGames(db);
    } catch {
      continue;
    }
    for (const g of rows) {
      if (g.match_type === "ranked") continue; // scope: unranked + direct only for now
      if (done.has(g.filename)) { skipped++; continue; }
      if (!isGradeCandidate(g)) { skipped++; continue; }
      jobs.push({ game: g, code });
    }
  }
  jobs.sort((a, b) => (b.game.timestamp ?? "").localeCompare(a.game.timestamp ?? ""));

  gameGradeNote.set("");
  gameGradeBusy.set(true);
  gameGradeProgress.set({ current: 0, total: jobs.length });

  let parsed = 0;
  let failed = 0;
  let pending: { row: GameStatsRow; code: string }[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    // Group by the DB the row belongs to, then double-write into the primary DB for linked
    // codes — the same reason `set_grades` does it: grades must survive a connect-code change.
    const byCode = new Map<string, GameStatsRow[]>();
    for (const p of pending) {
      const list = byCode.get(p.code) ?? [];
      list.push(p.row);
      byCode.set(p.code, list);
    }
    for (const [code, rows] of byCode) {
      const db = dbMap.get(code);
      if (db) {
        try { await saveGameStats(db, rows); } catch (e) { console.warn("[game-grading] save failed", e); }
      }
      if (code !== primaryCode) {
        const primary = dbMap.get(primaryCode);
        if (primary) {
          try { await saveGameStats(primary, rows); } catch { /* best effort mirror */ }
        }
      }
    }
    pending = [];
  };

  for (let i = 0; i < jobs.length; i++) {
    if (_cancelled) break;
    const { game, code } = jobs[i];

    try {
      let rows;
      try {
        rows = await parseSlpFile(game.filepath, code);
      } catch (readErr) {
        // The stored path didn't resolve. Look the replay up by basename before giving up —
        // moving files between subdirectories is routine and must not cost history.
        const found = resolveReplayPath(game.filepath, game.filename, await replayIndexFor());
        if (!found) throw readErr;
        rows = await parseSlpFile(found, code);
        const db = dbMap.get(code);
        if (db) {
          try { await updateGameFilepath(db, game.filename, found); } catch { /* non-fatal */ }
        }
      }

      const p = rows[0];
      if (!p) { failed++; continue; }

      pending.push({
        code,
        row: {
          filename:        game.filename,
          match_id:        p.match_id ?? game.match_id,
          game_timestamp:  p.timestamp ?? game.timestamp,
          match_type:      game.match_type,
          player_char:     CHARACTERS[p.player_char_id] ?? "Unknown",
          opponent_char:   CHARACTERS[p.opponent_char_id] ?? `Char ${p.opponent_char_id}`,
          opponent_code:   p.opponent_code ?? game.opponent_code,
          result:          p.result ?? game.result,
          stage_id:        p.stage_id ?? game.stage_id,
          duration_frames: p.duration_frames ?? game.duration_frames,
          kills:           p.kills,
          deaths:          p.deaths,
          stats_version:   PARSER_STATS_VERSION,
          parsed_at:       new Date().toISOString(),
          openings_per_kill:       p.openings_per_kill,
          damage_per_opening:      p.damage_per_opening,
          neutral_win_ratio:       p.neutral_win_ratio,
          counter_hit_rate:        p.counter_hit_rate,
          inputs_per_minute:       p.inputs_per_minute,
          l_cancel_ratio:          p.l_cancel_ratio,
          avg_kill_percent:        p.avg_kill_percent,
          avg_death_percent:       p.avg_death_percent,
          defensive_option_rate:   p.defensive_option_rate,
          opening_conversion_rate: p.opening_conversion_rate,
          stage_control_ratio:     p.stage_control_ratio,
          lead_maintenance_rate:   p.lead_maintenance_rate,
          tech_chase_rate:         p.tech_chase_rate,
          edgeguard_success_rate:  p.edgeguard_success_rate,
          hit_advantage_rate:      p.hit_advantage_rate,
          recovery_success_rate:   p.recovery_success_rate,
          avg_stock_duration:      p.avg_stock_duration,
          respawn_defense_rate:    p.respawn_defense_rate,
          comeback_rate:           p.comeback_rate,
          wavedash_miss_rate:      p.wavedash_miss_rate,
        },
      });
      parsed++;
    } catch {
      failed++;
    }

    if (pending.length >= COMMIT_CHUNK) await flush();
    if ((i + 1) % PROGRESS_EVERY === 0) {
      gameGradeProgress.set({ current: i + 1, total: jobs.length });
    }
  }

  await flush();
  gameGradeProgress.set({ current: jobs.length, total: jobs.length });
  gameGradeBusy.set(false);

  const note =
    failed > 0
      ? `${failed} replay${failed === 1 ? "" : "s"} could not be read` +
        (replayIndexNote ? ` (${replayIndexNote})` : "")
      : "";
  gameGradeNote.set(note);

  await loadGameStats(codes);

  return { parsed, skipped, failed, cancelled: _cancelled, note };
}

/** The version string a stored row was SCORED under. Stats and scoring invalidate separately —
 *  this one costs ~0.1s to satisfy, `PARSER_STATS_VERSION` costs ~75 min. */
export const GAME_SCORE_VERSION = GRADE_VERSION;
