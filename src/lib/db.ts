import Database from "@tauri-apps/plugin-sql";
import { mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";

const DB_DIR = "Slippi Ranked Stats/data";

const _dbCache = new Map<string, Database>();
let _scanned: Database | null = null;
let _notes: Database | null = null;

function dbPath(connectCode: string): string {
  const safe = connectCode.replace("#", "_");
  return `sqlite:${DB_DIR}/${safe}.db`;
}

const SCANNED_PATH = `sqlite:${DB_DIR}/scanned.db`;
const NOTES_PATH = `sqlite:${DB_DIR}/notes.db`;

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
        filename     TEXT NOT NULL,
        connect_code TEXT NOT NULL,
        PRIMARY KEY (filename, connect_code)
      )
    `);
    // Migrate old single-column schema: preserve existing filenames by copying them
    // into the new table with connect_code='' (a sentinel meaning "scanned by all codes").
    try {
      await _scanned.select(`SELECT connect_code FROM scanned_files LIMIT 0`);
    } catch {
      await _scanned.execute(`ALTER TABLE scanned_files RENAME TO scanned_files_old`);
      await _scanned.execute(`
        CREATE TABLE scanned_files (
          filename     TEXT NOT NULL,
          connect_code TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (filename, connect_code)
        )
      `);
      await _scanned.execute(`
        INSERT OR IGNORE INTO scanned_files (filename, connect_code)
        SELECT filename, '' FROM scanned_files_old
      `);
      await _scanned.execute(`DROP TABLE scanned_files_old`);
    }
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
  sourceCode?: string; // in-memory only: which connect code's DB this game came from
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
      `SELECT * FROM games WHERE timestamp >= $1 ORDER BY timestamp ASC`,
      [since]
    );
  }
  return db.select<GameRow[]>(
    `SELECT * FROM games ORDER BY timestamp ASC`
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

export async function getScannedFilenames(connectCode: string): Promise<Set<string>> {
  const sdb = await getScannedDb();
  const rows = await sdb.select<{ filename: string }[]>(
    `SELECT filename FROM scanned_files WHERE connect_code = $1 OR connect_code = ''`,
    [connectCode]
  );
  return new Set(rows.map((r) => r.filename));
}

export async function clearScannedFiles(): Promise<void> {
  const sdb = await getScannedDb();
  await sdb.execute(`DELETE FROM scanned_files`);
}

// Drop scanned marks for files that produced no game row, so the next scan retries them.
//
// scanDirectory marks a file scanned even when the parse yields nothing (only a *thrown*
// error skips the mark) — that's deliberate, otherwise every local/CPU/teams replay would
// be re-parsed on every scan forever. The cost is that widening the set of supported modes
// can't reach already-scanned files: when direct-connect support landed in v1.8.12, every
// direct replay in the user's history stayed invisible because it had already been marked
// scanned back when the parser discarded it.
//
// `productive` holds every key that DID yield a row across all known codes — both the
// basename (games.filename) and the full path (games.filepath), since scanned_files stores
// full paths for new records and basenames for legacy pre-multi-folder ones. Anything else
// is unproductive and gets its mark dropped. Over-pruning is harmless: the file is simply
// re-parsed once and re-marked (insertGame is INSERT OR IGNORE on a UNIQUE filename, so a
// retry can't duplicate a game).
export async function pruneUnproductiveScannedFiles(
  dbsByCode: Record<string, Database>
): Promise<number> {
  const sdb = await getScannedDb();

  const productive = new Set<string>();
  for (const db of Object.values(dbsByCode)) {
    const rows = await db.select<{ filename: string; filepath: string | null }[]>(
      `SELECT filename, filepath FROM games`
    );
    for (const r of rows) {
      productive.add(r.filename);
      if (r.filepath) productive.add(r.filepath);
    }
  }

  const scanned = await sdb.select<{ filename: string }[]>(
    `SELECT DISTINCT filename FROM scanned_files`
  );
  const stale = scanned.map((r) => r.filename).filter((f) => !productive.has(f));
  if (stale.length === 0) return 0;

  const CHUNK = 500;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const chunk = stale.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(", ");
    await sdb.execute(
      `DELETE FROM scanned_files WHERE filename IN (${placeholders})`,
      chunk
    );
  }
  return stale.length;
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

// Start of the earliest game in a match, for the live session clock. Unbounded by design:
// recoverActiveSet only looks back 15 minutes, but an unranked/direct match_id is the whole
// connection and can run for hours, so the run's real start is usually outside that window.
// MIN() rather than getGamesByMatchId so a 60-game run doesn't load 60 rows for one timestamp.
export async function getMatchStartTime(
  db: Database,
  matchId: string
): Promise<string | null> {
  const rows = await db.select<{ started: string | null }[]>(
    `SELECT MIN(timestamp) AS started FROM games WHERE match_id = $1`,
    [matchId]
  );
  return rows[0]?.started ?? null;
}

// All games vs an opponent in one mode. Modes are kept separate on purpose: a ranked set
// record and a pile of unranked friendlies against the same person aren't the same statistic
// and must never be summed into one "all-time vs them" number.
export async function getGamesVsOpponent(
  db: Database,
  opponentCode: string,
  matchType: string = "ranked"
): Promise<GameRow[]> {
  return db.select<GameRow[]>(
    `SELECT * FROM games WHERE opponent_code = $1 AND match_type = $2 ORDER BY timestamp ASC`,
    [opponentCode, matchType]
  );
}

export async function markFilesScanned(filenames: string[], connectCode: string): Promise<void> {
  if (filenames.length === 0) return;
  const sdb = await getScannedDb();
  const CHUNK = 500;
  for (let i = 0; i < filenames.length; i += CHUNK) {
    const chunk = filenames.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(", ");
    const values = chunk.flatMap((f) => [f, connectCode]);
    await sdb.execute(
      `INSERT OR IGNORE INTO scanned_files (filename, connect_code) VALUES ${placeholders}`,
      values
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

// ── Notes ──────────────────────────────────────────────────────────────────
//
// Scouting notes the user writes for themselves: things to remember about a specific
// opponent ("always techs in place off the top platform") or about a character matchup
// ("camp the ledge, they over-commit with fair"). Surfaced on the Live Session tab the
// moment an opponent is detected, which is the only moment they're actually useful.
//
// One row = one bullet, not one blob per subject. Bullets are what gets written mid-session —
// a single field you type into and hit Enter — and individually addressable rows are what make
// pinning, deleting the one that stopped being true, and capping the live list possible.

// Notes deliberately live in their own database rather than the per-connect-code one. A note
// is about a *person* or a *matchup*, not about which of your accounts you happened to face
// them on: linked codes should all see the same notes, and switching your primary connect code
// must not strand them in a file the app stops opening.
export async function getNotesDb(): Promise<Database> {
  if (!_notes) {
    await ensureDataDir();
    _notes = await Database.load(NOTES_PATH);
    // Absent keys are '' rather than NULL throughout: every lookup is then plain equality,
    // instead of the NULL-never-equals-NULL footgun on an indexed column.
    await _notes.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT NOT NULL,
        opponent_code TEXT NOT NULL DEFAULT '',
        opponent_tag  TEXT NOT NULL DEFAULT '',
        player_char   TEXT NOT NULL DEFAULT '',
        opponent_char TEXT NOT NULL DEFAULT '',
        body          TEXT NOT NULL,
        pinned        INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `);
    await _notes.execute(
      `CREATE INDEX IF NOT EXISTS idx_notes_opponent ON notes (kind, opponent_code)`
    );
    await _notes.execute(
      `CREATE INDEX IF NOT EXISTS idx_notes_matchup ON notes (kind, opponent_char, player_char)`
    );
  }
  return _notes;
}

export interface NoteRow {
  id: number;
  kind: string;           // 'opponent' | 'matchup' — see NoteKind in notes.ts
  opponent_code: string;  // opponent notes: their connect code (upper-cased). '' for matchup notes.
  opponent_tag: string;   // their Slippi display name when known — connect codes alone are unmemorable
  player_char: string;    // matchup notes: your character name. '' means "any character I play".
  opponent_char: string;  // matchup notes: their character name. '' for opponent notes.
  body: string;
  pinned: number;         // 0 | 1 (SQLite has no boolean)
  created_at: string;
  updated_at: string;
}

export async function listNotes(db: Database): Promise<NoteRow[]> {
  return db.select<NoteRow[]>(`SELECT * FROM notes`);
}

export async function insertNote(db: Database, note: Omit<NoteRow, "id">): Promise<void> {
  await db.execute(
    `INSERT INTO notes
      (kind, opponent_code, opponent_tag, player_char, opponent_char, body, pinned, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      note.kind,
      note.opponent_code,
      note.opponent_tag,
      note.player_char,
      note.opponent_char,
      note.body,
      note.pinned,
      note.created_at,
      note.updated_at,
    ]
  );
}

export async function updateNoteBody(
  db: Database,
  id: number,
  body: string,
  updatedAt: string
): Promise<void> {
  await db.execute(`UPDATE notes SET body = $1, updated_at = $2 WHERE id = $3`, [
    body,
    updatedAt,
    id,
  ]);
}

export async function updateNotePinned(db: Database, id: number, pinned: number): Promise<void> {
  await db.execute(`UPDATE notes SET pinned = $1 WHERE id = $2`, [pinned, id]);
}

// Keeps the display name fresh on every note about a player, so a tag change doesn't leave
// the Notes tab showing whatever they were called the first time you wrote about them.
export async function updateOpponentTag(
  db: Database,
  opponentCode: string,
  tag: string
): Promise<void> {
  await db.execute(
    `UPDATE notes SET opponent_tag = $1 WHERE kind = 'opponent' AND opponent_code = $2 AND opponent_tag <> $1`,
    [tag, opponentCode]
  );
}

export async function deleteNote(db: Database, id: number): Promise<void> {
  await db.execute(`DELETE FROM notes WHERE id = $1`, [id]);
}
