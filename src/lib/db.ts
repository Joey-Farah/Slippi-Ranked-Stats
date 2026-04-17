import Database from "@tauri-apps/plugin-sql";
import { mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";

const DB_DIR = "Slippi Ranked Stats/data";

const _dbCache = new Map<string, Database>();
let _scanned: Database | null = null;

function dbPath(connectCode: string): string {
  const safe = connectCode.replace("#", "_");
  return `sqlite:${DB_DIR}/${safe}.db`;
}

const SCANNED_PATH = `sqlite:${DB_DIR}/scanned.db`;

async function ensureDataDir(): Promise<void> {
  await mkdir(DB_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
}

export async function getDb(connectCode: string): Promise<Database> {
  const key = connectCode.replace("#", "_");
  if (!_dbCache.has(key)) {
    await ensureDataDir();
    const db = await Database.load(dbPath(connectCode));
    await initSchema(db);
    _dbCache.set(key, db);
  }
  return _dbCache.get(key)!;
}

export async function getScannedDb(): Promise<Database> {
  if (!_scanned) {
    await ensureDataDir();
    _scanned = await Database.load(SCANNED_PATH);
    await _scanned.execute(`
      CREATE TABLE IF NOT EXISTS scanned_files (
        filename TEXT PRIMARY KEY
      )
    `);
  }
  return _scanned;
}

async function initSchema(db: Database) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT UNIQUE NOT NULL,
      timestamp TEXT,
      match_type TEXT,
      player_port INTEGER,
      player_char_id INTEGER,
      opponent_code TEXT,
      opponent_char_id INTEGER,
      stage_id INTEGER,
      result TEXT,
      duration_frames INTEGER,
      match_id TEXT,
      filepath TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS rating_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connect_code TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      rating REAL,
      wins INTEGER,
      losses INTEGER,
      global_rank INTEGER,
      regional_rank INTEGER,
      continent TEXT,
      triggered_by_match_id TEXT,
      UNIQUE(connect_code, timestamp)
    )
  `);

  // Migrate: add triggered_by_match_id to existing DBs
  try {
    await db.execute(`ALTER TABLE rating_snapshots ADD COLUMN triggered_by_match_id TEXT`);
  } catch {
    // Column already exists — safe to ignore
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS season_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connect_code TEXT NOT NULL,
      season_id TEXT NOT NULL,
      season_name TEXT,
      season_start TEXT,
      season_end TEXT,
      rating REAL,
      wins INTEGER,
      losses INTEGER,
      UNIQUE(connect_code, season_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS set_grades (
      match_id         TEXT PRIMARY KEY,
      generated_at     TEXT NOT NULL,
      set_timestamp    TEXT NOT NULL,
      baseline_version TEXT NOT NULL,
      player_char      TEXT NOT NULL,
      opponent_char    TEXT NOT NULL,
      opponent_code    TEXT NOT NULL,
      baseline_source  TEXT NOT NULL,
      set_result       TEXT NOT NULL,
      wins             INTEGER NOT NULL,
      losses           INTEGER NOT NULL,
      overall_letter   TEXT NOT NULL,
      overall_score    REAL NOT NULL,
      neutral_score    REAL,
      neutral_letter   TEXT,
      punish_score     REAL,
      punish_letter    TEXT,
      defense_score    REAL,
      defense_letter   TEXT,
      execution_score  REAL,
      execution_letter TEXT,
      breakdown_json   TEXT NOT NULL
    )
  `);
}

// ── Games ──────────────────────────────────────────────────────────────────

export interface GameRow {
  id: number;
  filename: string;
  timestamp: string;
  match_type: string;
  player_port: number;
  player_char_id: number;
  opponent_code: string;
  opponent_char_id: number;
  stage_id: number;
  result: string;
  duration_frames: number;
  match_id: string;
  filepath: string;
}

export async function insertGame(
  db: Database,
  game: Omit<GameRow, "id">
): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO games
      (filename, timestamp, match_type, player_port, player_char_id,
       opponent_code, opponent_char_id, stage_id, result,
       duration_frames, match_id, filepath)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      game.filename,
      game.timestamp,
      game.match_type,
      game.player_port,
      game.player_char_id,
      game.opponent_code,
      game.opponent_char_id,
      game.stage_id,
      game.result,
      game.duration_frames,
      game.match_id,
      game.filepath,
    ]
  );
}

export async function getGames(
  db: Database,
  since?: string
): Promise<GameRow[]> {
  if (since) {
    return db.select<GameRow[]>(
      `SELECT * FROM games WHERE match_type = 'ranked' AND timestamp >= $1 ORDER BY timestamp ASC`,
      [since]
    );
  }
  return db.select<GameRow[]>(
    `SELECT * FROM games WHERE match_type = 'ranked' ORDER BY timestamp ASC`
  );
}

// ── Snapshots ──────────────────────────────────────────────────────────────

export interface SnapshotRow {
  id: number;
  connect_code: string;
  timestamp: string;
  rating: number;
  wins: number;
  losses: number;
  global_rank: number;
  regional_rank: number;
  continent: string;
  triggered_by_match_id?: string;
}

export async function insertSnapshot(
  db: Database,
  snap: Omit<SnapshotRow, "id">
): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO rating_snapshots
      (connect_code, timestamp, rating, wins, losses, global_rank, regional_rank, continent, triggered_by_match_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      snap.connect_code,
      snap.timestamp,
      snap.rating,
      snap.wins,
      snap.losses,
      snap.global_rank,
      snap.regional_rank,
      snap.continent,
      snap.triggered_by_match_id ?? null,
    ]
  );
}

export async function getSnapshots(
  db: Database,
  connectCode: string
): Promise<SnapshotRow[]> {
  return db.select<SnapshotRow[]>(
    `SELECT * FROM rating_snapshots WHERE connect_code = $1 ORDER BY timestamp ASC`,
    [connectCode]
  );
}

// ── Season history ─────────────────────────────────────────────────────────

export interface SeasonRow {
  id: number;
  connect_code: string;
  season_id: string;
  season_name: string;
  season_start: string;
  season_end: string;
  rating: number;
  wins: number;
  losses: number;
}

export async function insertSeason(
  db: Database,
  row: Omit<SeasonRow, "id">
): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO season_history
      (connect_code, season_id, season_name, season_start, season_end, rating, wins, losses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.connect_code,
      row.season_id,
      row.season_name,
      row.season_start,
      row.season_end,
      row.rating,
      row.wins,
      row.losses,
    ]
  );
}

export async function getSeasons(
  db: Database,
  connectCode: string
): Promise<SeasonRow[]> {
  return db.select<SeasonRow[]>(
    `SELECT * FROM season_history WHERE connect_code = $1 ORDER BY season_start ASC`,
    [connectCode]
  );
}

// ── Scanned files ──────────────────────────────────────────────────────────

export async function getScannedFilenames(): Promise<Set<string>> {
  const sdb = await getScannedDb();
  const rows = await sdb.select<{ filename: string }[]>(
    `SELECT filename FROM scanned_files`
  );
  return new Set(rows.map((r) => r.filename));
}

export async function clearScannedFiles(): Promise<void> {
  const sdb = await getScannedDb();
  await sdb.execute(`DELETE FROM scanned_files`);
}

export async function clearGames(db: Database): Promise<void> {
  await db.execute(`DELETE FROM games`);
}

export async function getGamesByMatchId(
  db: Database,
  matchId: string
): Promise<GameRow[]> {
  return db.select<GameRow[]>(
    `SELECT * FROM games WHERE match_id = $1 ORDER BY timestamp ASC`,
    [matchId]
  );
}

export async function getGamesVsOpponent(
  db: Database,
  opponentCode: string
): Promise<GameRow[]> {
  return db.select<GameRow[]>(
    `SELECT * FROM games WHERE opponent_code = $1 AND match_type = 'ranked' ORDER BY timestamp ASC`,
    [opponentCode]
  );
}

export async function markFilesScanned(filenames: string[]): Promise<void> {
  if (filenames.length === 0) return;
  const sdb = await getScannedDb();
  const CHUNK = 500;
  for (let i = 0; i < filenames.length; i += CHUNK) {
    const chunk = filenames.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j + 1})`).join(", ");
    await sdb.execute(
      `INSERT OR IGNORE INTO scanned_files (filename) VALUES ${placeholders}`,
      chunk
    );
  }
}

// ── Set grades ─────────────────────────────────────────────────────────────

export interface SetGradeRow {
  match_id:         string;
  generated_at:     string;
  set_timestamp:    string;
  baseline_version: string;
  player_char:      string;
  opponent_char:    string;
  opponent_code:    string;
  baseline_source:  string;
  set_result:       string;
  wins:             number;
  losses:           number;
  overall_letter:   string;
  overall_score:    number;
  neutral_score:    number | null;
  neutral_letter:   string | null;
  punish_score:     number | null;
  punish_letter:    string | null;
  defense_score:    number | null;
  defense_letter:   string | null;
  execution_score:  number | null;
  execution_letter: string | null;
  breakdown_json:   string;
}

export async function saveSetGrade(db: Database, row: SetGradeRow): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO set_grades
      (match_id, generated_at, set_timestamp, baseline_version,
       player_char, opponent_char, opponent_code, baseline_source,
       set_result, wins, losses,
       overall_letter, overall_score,
       neutral_score, neutral_letter, punish_score, punish_letter,
       defense_score, defense_letter, execution_score, execution_letter,
       breakdown_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      row.match_id, row.generated_at, row.set_timestamp, row.baseline_version,
      row.player_char, row.opponent_char, row.opponent_code, row.baseline_source,
      row.set_result, row.wins, row.losses,
      row.overall_letter, row.overall_score,
      row.neutral_score ?? null, row.neutral_letter ?? null,
      row.punish_score ?? null, row.punish_letter ?? null,
      row.defense_score ?? null, row.defense_letter ?? null,
      row.execution_score ?? null, row.execution_letter ?? null,
      row.breakdown_json,
    ]
  );
}

export async function getAllSetGrades(db: Database): Promise<SetGradeRow[]> {
  return db.select<SetGradeRow[]>(
    `SELECT * FROM set_grades ORDER BY set_timestamp DESC`
  );
}

export async function deleteSetGrade(db: Database, matchId: string): Promise<void> {
  await db.execute(`DELETE FROM set_grades WHERE match_id = $1`, [matchId]);
}
