import { writable, derived } from "svelte/store";
import type { GameRow, SnapshotRow, SeasonRow } from "./db";
import type { SetGrade } from "./grading";
import { getRankTier, CHARACTERS } from "./parser";

// ── Persistent settings (auto-saved to localStorage) ───────────────────────

function persisted<T>(key: string, initial: T) {
  const stored = localStorage.getItem(key);
  const store = writable<T>(stored !== null ? JSON.parse(stored) : initial);
  store.subscribe((v) => localStorage.setItem(key, JSON.stringify(v)));
  return store;
}

// Like persisted(), but for object values: merges the stored value over the defaults so a
// newly-added key defaults to its initial value instead of undefined (forward-compatible
// when more fields are added to the shape later).
function persistedMerged<T extends object>(key: string, initial: T) {
  const stored = localStorage.getItem(key);
  const value: T = stored !== null ? { ...initial, ...JSON.parse(stored) } : initial;
  const store = writable<T>(value);
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

// The player's Slippi display tag (e.g. "Joey Dadnuts"). Fetched from the API
// alongside each rating snapshot for the primary connect code; persisted so the
// stream overlay can show it before the first fetch of a session.
export const displayName = persisted<string>("srs_displayName", "");

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

// Live Ranked Stats overlay (premium): the unified always-on OBS Browser Source showing
// tag / rank / MMR / global placement / season + today's record, plus a post-set bridge
// (result + grade + MMR change) when a set ends. statsOverlayEnabled gates the app-level
// write; statsOverlayExpanded is UI state for the setup panel.
export const statsOverlayEnabled  = persisted<boolean>("srs_statsOverlayEnabled", false);
export const statsOverlayExpanded = persisted<boolean>("srs_statsOverlayExpanded", false);
// Overlay layout: "stacked" (tall column) or "sidebyside" (square, medal beside identity).
export const statsOverlayLayout = persisted<"stacked" | "sidebyside">("srs_statsOverlayLayout", "sidebyside");

// Per-element overlay visibility: each data piece on the Live Stats panel can be hidden
// independently so a streamer only shows what they want. Defaults to everything on (the
// pre-toggle behavior). Stored as one object, merged over the defaults on load.
export interface OverlayVisibility {
  tag: boolean;          // player tag
  medal: boolean;        // rank medal art
  rank: boolean;         // rank tier name
  mmr: boolean;          // current MMR number
  sessionDelta: boolean; // +/- MMR change this session (beside the MMR and in today's row)
  global: boolean;       // global placement (#rank [region])
  season: boolean;       // season W/L
  today: boolean;        // today's session W/L record
  opponent: boolean;     // opponent scouting line during a set
  grade: boolean;        // post-set grade letter (+ standout stat)
}
export const OVERLAY_VISIBILITY_DEFAULT: OverlayVisibility = {
  tag: true, medal: true, rank: true, mmr: true, sessionDelta: true,
  global: true, season: true, today: true, opponent: true, grade: true,
};
export const statsOverlayVisibility = persistedMerged<OverlayVisibility>(
  "srs_statsOverlayVisibility", OVERLAY_VISIBILITY_DEFAULT
);

// Transient test/preview override (not persisted): when non-null, the app writes this to
// the overlay instead of the live payload, so a streamer can study the overlay and
// simulate a set result from the Live Stats card without playing. See statsOverlayPreview
// usage in App.svelte. Type is StatsOverlayPayload (declared below — types hoist).
export const statsOverlayPreview = writable<StatsOverlayPayload | null>(null);
export const discordToken = persisted<string | null>("srs_discordToken", null);
export const discordUsername = persisted<string | null>("srs_discordUsername", null);

// Discord OAuth refresh token + access-token expiry (ms epoch). Discord access tokens expire
// after ~7 days; persisting the refresh token lets the app silently mint a fresh one instead
// of clearing premium and forcing a re-link. (Installs that linked BEFORE this shipped have no
// stored refresh token — they re-link once to populate it, then renew seamlessly forever.)
export const discordRefreshToken = persisted<string | null>("srs_discordRefreshToken", null);
export const discordTokenExpiresAt = persisted<number | null>("srs_discordTokenExpiresAt", null);

// ── Raw data ───────────────────────────────────────────────────────────────

export const games = writable<GameRow[]>([]);
export const snapshots = writable<SnapshotRow[]>([]);
export const seasons = writable<SeasonRow[]>([]);

// ── UI state ───────────────────────────────────────────────────────────────

export const activeTab = persisted<number>("srs_activeTab", 0);
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
  opponent_tier: string | null;         // rank tier name, also selects the medal
  opponent_tier_color: string | null;   // rank tier color (getRankTier().color)
  opponent_tag: string | null;          // opponent's Slippi display name, null while loading
  opponent_season_wins: number | null;  // opponent's current-season ranked W, null while loading
  opponent_season_losses: number | null;
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

// Most recently completed ranked set, for the stats overlay's post-set "bridge"
// (hold the result while the MMR refetch lands, then show the per-set delta).
// setId (Date.now at completion) lets the overlay detect a genuinely new set;
// ratingBefore is the MMR at completion so the client can compute the per-set delta
// once the refetched rating differs. Not persisted — null on a fresh launch.
export interface OverlaySetResult {
  setId: number;
  result: "win" | "loss";
  wins: number;
  losses: number;
  opponentCode: string;
  opponentChar: string;
  ratingBefore: number | null;
  gradeLetter: string | null;  // null when the set couldn't be graded (bad/partial stats)
  // Featured category to show under the overall grade: best category on a win, worst on a
  // loss. Both null when ungraded (or no category scored). See featuredCategory() in grading.ts.
  subLabel: string | null;
  subLetter: string | null;
  // The standout individual stat within that category (best on a win, worst on a loss),
  // shown beneath the category line. Null when no stat in the category scored.
  subStatLabel: string | null;
  subStatLetter: string | null;
}
export const lastOverlaySet = writable<OverlaySetResult | null>(null);

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

// ── Derived: unranked games only ───────────────────────────────────────────

export const unrankedGames = derived(filteredGames, ($games) =>
  $games.filter((g) => g.match_type === "unranked")
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

/** A set's win/loss, accounting for quit-outs. When a set ends because someone left
 *  (LRAS / no-contest), Slippi ranked scores it as a forfeit regardless of the game count:
 *  a WIN when the OPPONENT quit (lras_win) and a LOSS when the player quit (lras_loss).
 *  This matters at e.g. 1-1, where the raw game count is even but the forfeit decides it.
 *  Without an LRAS it's simply who won more (full) games. */
export function setResultFromGames(games: { result: string }[]): "win" | "loss" {
  if (games.some((g) => g.result === "lras_win")) return "win";
  if (games.some((g) => g.result === "lras_loss")) return "loss";
  const fullWins = games.filter((g) => g.result === "win").length;
  return fullWins > games.length - fullWins ? "win" : "loss";
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
      result: setResultFromGames(gs),
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

// ── Derived: live session set record (today's W/L) ─────────────────────────
// Set W/L for the current watcher session, derived straight from liveGameStats so
// it always reflects the games tracked this run. Shared by the Live Session tab and
// the stats overlay. "Complete set" = a side reached 2 (best-of-3, first-to-2).

export const liveSetRecord = derived(liveGameStats, ($stats) => {
  const byMatch = new Map<string, LiveGameStats[]>();
  for (const g of $stats) {
    const arr = byMatch.get(g.match_id) ?? [];
    arr.push(g);
    byMatch.set(g.match_id, arr);
  }
  let wins = 0, losses = 0;
  for (const [, gs] of byMatch) {
    const w = gs.filter((g) => g.result === "win" || g.result === "lras_win").length;
    const l = gs.length - w;
    if (Math.max(w, l) < 2) continue; // set not complete yet
    if (w >= 2) wins++; else losses++;
  }
  return { wins, losses, total: wins + losses };
});

// ── Derived: stream-overlay live-stats payload ─────────────────────────────
// Everything the always-on "Live Ranked Stats" OBS panel renders. Recomputed when
// any underlying store changes; the app-level subscription writes it to the overlay
// state file (diff-guarded). See src/lib/stats-overlay.ts.

export interface StatsOverlayOpponent {
  code: string;
  char: string;
  tier: string | null;         // rank tier name, also selects the medal
  tierColor: string | null;    // rank tier color
  rating: number | null;
  tag: string | null;          // opponent's Slippi display name, null while loading
  seasonWins: number | null;   // opponent's current-season ranked record, null while loading
  seasonLosses: number | null;
  gamesWon: number;            // current set score (live)
  gamesLost: number;
}

export interface StatsOverlayPayload {
  tag: string;
  rankName: string;            // getRankTier().name — also selects the medal
  rankColor: string;
  rating: number | null;       // current MMR
  globalRank: number | null;   // null when unplaced
  region: string;              // continent code, e.g. "NA"
  seasonWins: number | null;
  seasonLosses: number | null;
  sessionStartRating: number | null;
  sessionDelta: number | null; // current rating − session start
  sessionWins: number;         // today's set record
  sessionLosses: number;
  opponent: StatsOverlayOpponent | null; // present only during an active set
  lastSet: OverlaySetResult | null;      // most recent completed set (post-set bridge)
  layout: "stacked" | "sidebyside";
  show: OverlayVisibility;               // per-element visibility toggles
}

// Slippi `continent` enum → short region code for the overlay (e.g. NORTH_AMERICA → NA).
// Unknown values fall back to the raw value with underscores replaced by spaces.
const REGION_LABELS: Record<string, string> = {
  NORTH_AMERICA: "NA", SOUTH_AMERICA: "SA", EUROPE: "EU", ASIA: "AS", OCEANIA: "OCE", AFRICA: "AF",
};
function regionLabel(continent: string | null | undefined): string {
  if (!continent) return "";
  return REGION_LABELS[continent] ?? continent.replace(/_/g, " ");
}

export const statsOverlayPayload = derived(
  [displayName, connectCode, snapshots, liveSessionStartRating, liveSetRecord, activeSet, lastOverlaySet, statsOverlayLayout, statsOverlayVisibility],
  ([$tag, $code, $snaps, $startRating, $record, $active, $lastSet, $layout, $show]): StatsOverlayPayload => {
    const snap = $snaps.at(-1);
    const rating = snap?.rating ?? null;
    const tier = rating !== null ? getRankTier(rating, (snap?.global_rank ?? 0) > 0) : { name: "Unranked", color: "#9aa0a6" };
    const sessionDelta =
      rating !== null && $startRating !== null ? rating - $startRating : null;

    const opponent: StatsOverlayOpponent | null = $active
      ? {
          code: $active.opponent_code,
          char: CHARACTERS[$active.opponent_char_id] ?? "Unknown",
          tier: $active.opponent_tier,
          tierColor: $active.opponent_tier_color,
          rating: $active.opponent_rating,
          tag: $active.opponent_tag,
          seasonWins: $active.opponent_season_wins,
          seasonLosses: $active.opponent_season_losses,
          gamesWon: $active.games_won,
          gamesLost: $active.games_lost,
        }
      : null;

    return {
      tag: $tag || $code || "",
      rankName: tier.name,
      rankColor: tier.color,
      rating,
      globalRank: snap?.global_rank ? snap.global_rank : null,
      region: regionLabel(snap?.continent),
      seasonWins: snap?.wins ?? null,
      seasonLosses: snap?.losses ?? null,
      sessionStartRating: $startRating,
      sessionDelta,
      sessionWins: $record.wins,
      sessionLosses: $record.losses,
      opponent,
      lastSet: $lastSet,
      layout: $layout,
      show: $show,
    };
  }
);
