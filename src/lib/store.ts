import { writable, derived } from "svelte/store";
import type { GameRow, SnapshotRow, SeasonRow } from "./db";
import type { SetGrade } from "./grading";

// ── Persistent settings (auto-saved to localStorage) ───────────────────────

function persisted<T>(key: string, initial: T) {
  const stored = localStorage.getItem(key);
  const store = writable<T>(stored !== null ? JSON.parse(stored) : initial);
  store.subscribe((v) => localStorage.setItem(key, JSON.stringify(v)));
  return store;
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export const installId = persisted<string>("srs_installId", randomId());

export const connectCode = persisted<string>("srs_connectCode", "");

// Migrate single-folder key to multi-folder key (one-time, self-cleaning)
{
  const _old = localStorage.getItem("srs_replayDir");
  if (_old) {
    const _parsed: string = JSON.parse(_old);
    if (_parsed) localStorage.setItem("srs_replayDirs", JSON.stringify([_parsed]));
    localStorage.removeItem("srs_replayDir");
  }
}
export const replayDirs = persisted<string[]>("srs_replayDirs", []);

// ── Multi-code support ─────────────────────────────────────────────────────

// Additional codes linked to the primary connectCode.
// Stats, sessions, and grade history are unioned across all effective codes.
// Rating, snapshots, and live session watcher always use connectCode (primary).
export const linkedCodes = persisted<string[]>("srs_linkedCodes", []);

// All codes to load game data from
export const effectiveCodes = derived(
  [connectCode, linkedCodes],
  ([$code, $linked]) => ($code ? [$code, ...$linked.filter((c) => c !== $code)] : [])
);

// Alias used by App.svelte (always the primary connect code)
export const primaryCode = derived(connectCode, ($code) => $code);
export const dateRange = persisted<"30d" | "90d" | "all">("srs_dateRange", "all");
export const isPremium = persisted<boolean>("srs_isPremium", false);
export const discordToken = persisted<string | null>("srs_discordToken", null);
export const discordUsername = persisted<string | null>("srs_discordUsername", null);

// ── Raw data ───────────────────────────────────────────────────────────────

export const games = writable<GameRow[]>([]);
export const snapshots = writable<SnapshotRow[]>([]);
export const seasons = writable<SeasonRow[]>([]);

// ── UI state ───────────────────────────────────────────────────────────────

export const activeTab = writable<number>(0);
export const sidebarOpen = writable<boolean>(true);
export const scanProgress = writable<{ scanned: number; total: number; alreadyProcessed: number } | null>(null);
export const isScanning = writable<boolean>(false);
export const isFetchingSnapshot = writable<boolean>(false);
export const watcherActive = writable<boolean>(false);
export const statusMessage = writable<string>("");

// ── Live session state (populated by watcher) ─────────────────────────────

export interface ActiveSet {
  match_id: string;
  opponent_code: string;
  opponent_char_id: number;
  player_char_id: number;
  games_won: number;
  games_lost: number;
  started_at: string;
  opponent_rating: number | null;   // fetched from Slippi API, null while loading
  opponent_tier: string | null;
  all_time_wins: number;            // set-level record vs this opponent in our DB
  all_time_losses: number;
  session_already_faced: boolean;   // did we face them earlier this watcher session?
}

export const activeSet = writable<ActiveSet | null>(null);
export const liveSessionStartRating = writable<number | null>(null);
export const liveSessionStartedAt = writable<string | null>(null); // ISO timestamp of when live session began

export interface LiveGameStats {
  match_id: string;
  result: string;
  kills: number;
  deaths: number;
  openings_per_kill: number | null;
  damage_per_opening: number | null;
  neutral_win_ratio: number | null;
  counter_hit_rate: number | null;
  inputs_per_minute: number | null;
  l_cancel_ratio: number | null;
  avg_kill_percent: number | null;
  avg_death_percent: number | null;
  defensive_option_rate: number | null;
  opening_conversion_rate: number | null;
  stage_control_ratio:     number | null;
  lead_maintenance_rate:   number | null;
  tech_chase_rate:         number | null;
  edgeguard_success_rate:  number | null;
  hit_advantage_rate:      number | null;
  recovery_success_rate:   number | null;
  avg_stock_duration:      number | null;
  respawn_defense_rate:    number | null;
  comeback_rate:           number | null;
  wavedash_miss_rate:      number | null;
  duration_frames: number;
  stage_id: number;
  player_char_id: number;
  opponent_char_id: number;
  opponent_code: string;
  timestamp: string;
}

export const liveGameStats = writable<LiveGameStats[]>([]);

export interface SetResultFlash {
  result: "win" | "loss";
  opponent_code: string;
  wins: number;
  losses: number;
}
export const setResultFlash = writable<SetResultFlash | null>(null);

// ── Dev-only: set grading (not shipped until personally vetted) ───────────
export const lastSetGrade = writable<SetGrade | null>(null);

// ── Grade history (persists for the app session, reset on reload) ──────────

export interface GradeHistoryEntry {
  matchId:         string;
  timestamp:       string;   // ISO string from the set, used for sort order
  date:            string;
  opponentCode:    string;
  opponentChar:    string;
  playerChar:      string;
  result:          "win" | "loss";
  wins:            number;
  losses:          number;
  grade:           SetGrade | null;
  error:           string | null;
  baselineVersion: string | null;  // null = not yet persisted or loaded from old DB
}

export const gradeHistory         = writable<GradeHistoryEntry[]>([]);
export const gradeHistoryBusy     = writable<boolean>(false);
export const gradeHistoryProgress = writable<{ current: number; total: number }>({ current: 0, total: 0 });

// ── Derived: filtered games by date range ─────────────────────────────────

export const filteredGames = derived([games, dateRange], ([$games, $range]) => {
  if ($range === "all") return $games;
  const now = new Date();
  const days = $range === "30d" ? 30 : 90;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return $games.filter((g) => new Date(g.timestamp) >= cutoff);
});

// ── Derived: ranked games only ─────────────────────────────────────────────

export const rankedGames = derived(filteredGames, ($games) =>
  $games.filter((g) => g.match_type === "ranked")
);

// ── Derived: sets (groups of games by match_id, min 2 games) ──────────────

export interface SetResult {
  match_id: string;
  timestamp: string;
  opponent_code: string;
  opponent_char_ids: number[];
  player_char_ids: number[];
  stage_ids: number[];
  games: GameRow[];
  wins: number;
  losses: number;
  result: "win" | "loss";
  hasLras: boolean; // true if any game ended via disconnect/quit
  sourceCode?: string; // in-memory only: connect code this set's games belong to
}

export const sets = derived(rankedGames, ($games): SetResult[] => {
  const byMatchId = new Map<string, GameRow[]>();
  for (const g of $games) {
    if (!g.match_id) continue;
    const arr = byMatchId.get(g.match_id) ?? [];
    arr.push(g);
    byMatchId.set(g.match_id, arr);
  }

  const results: SetResult[] = [];
  for (const [match_id, gs] of byMatchId) {
    if (gs.length < 2) continue; // incomplete sets
    gs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const wins = gs.filter((g) => g.result === "win" || g.result === "lras_win").length;
    const losses = gs.length - wins;
    const hasLras = gs.some((g) => g.result === "lras_win" || g.result === "lras_loss");

    results.push({
      match_id,
      timestamp: gs[0].timestamp,
      opponent_code: gs[0].opponent_code,
      opponent_char_ids: [...new Set(gs.map((g) => g.opponent_char_id))],
      player_char_ids: [...new Set(gs.map((g) => g.player_char_id))],
      stage_ids: [...new Set(gs.map((g) => g.stage_id))],
      games: gs,
      wins,
      losses,
      result: wins > losses ? "win" : "loss",
      hasLras,
      sourceCode: gs[0].sourceCode,
    });
  }

  results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return results;
});

// ── Derived: clean sets (excludes LRAS/disconnect-tainted sets) ───────────

export const cleanSets = derived(sets, ($sets) =>
  $sets.filter((s) => !s.hasLras && Math.max(s.wins, s.losses) >= 2)
);

// ── Derived: header stats ──────────────────────────────────────────────────

export const headerStats = derived([cleanSets, snapshots], ([$sets, $snaps]) => {
  const totalSets = $sets.length;
  const setWins = $sets.filter((s) => s.result === "win").length;
  const setLosses = totalSets - setWins;
  const setWinPct = totalSets > 0 ? (setWins / totalSets) * 100 : 0;

  const latestSnap = $snaps.at(-1);
  const firstSnap = $snaps.at(0);
  const ratingDelta =
    latestSnap && firstSnap ? latestSnap.rating - firstSnap.rating : 0;

  // Streak
  let streak = 0;
  let bestStreak = 0;
  let cur = 0;
  for (const s of [...$sets].reverse()) {
    if (streak === 0) streak = s.result === "win" ? 1 : -1;
    else if (s.result === "win" && streak > 0) streak++;
    else if (s.result === "loss" && streak < 0) streak--;
    else break;
  }
  for (const s of $sets) {
    if (s.result === "win") {
      cur++;
      bestStreak = Math.max(bestStreak, cur);
    } else {
      cur = 0;
    }
  }

  return {
    rating: latestSnap?.rating ?? 0,
    ratingDelta,
    setWinPct,
    setWins,
    setLosses,
    globalRank: latestSnap?.global_rank ?? 0,
    streak,
    bestStreak,
  };
});

// ── Derived: sessions (2-hour gap = new session) ──────────────────────────

export interface Session {
  sets: SetResult[];
  start: string;
  end: string;
  durationMin: number;
  setWins: number;
  setLosses: number;
}

export const sessions = derived(cleanSets, ($sets): Session[] => {
  if ($sets.length === 0) return [];
  const GAP_MS = 1 * 60 * 60 * 1000;
  const result: Session[] = [];
  let current: SetResult[] = [$sets[0]];

  for (let i = 1; i < $sets.length; i++) {
    const prev = new Date(current.at(-1)!.timestamp).getTime();
    const next = new Date($sets[i].timestamp).getTime();
    if (next - prev > GAP_MS) {
      result.push(buildSession(current));
      current = [];
    }
    current.push($sets[i]);
  }
  result.push(buildSession(current));
  return result;
});

function buildSession(sets: SetResult[]): Session {
  const start = sets[0].timestamp;
  const end = sets.at(-1)!.timestamp;
  const durationMin = Math.round(
    (new Date(end).getTime() - new Date(start).getTime()) / 60000
  );
  return {
    sets,
    start,
    end,
    durationMin,
    setWins: sets.filter((s) => s.result === "win").length,
    setLosses: sets.filter((s) => s.result === "loss").length,
  };
}
