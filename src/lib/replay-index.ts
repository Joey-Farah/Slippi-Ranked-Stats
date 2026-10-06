/**
 * Locating a replay whose stored path has gone stale.
 *
 * `games.filepath` is an absolute path captured at scan time. Reorganising the replay folder
 * — moving files into subdirectories, renaming a parent folder — leaves every stored path
 * pointing at nothing, while the files themselves are still right there. Nothing notices until
 * a GRADING_LOGIC_VERSION bump forces a regrade: a regrade re-parses the .slp (that is how
 * parser fixes reach stored grades), the read fails, the set produces no gradable games and its
 * grade row is dropped. Observed on the owner's install 2026-10-06 — 1,976 game rows and 211
 * graded sets, with 100% of the files present on disk under a different folder.
 *
 * Replay basenames are unique in practice (Slippi names them `Game_<UTC timestamp>.slp`), so the
 * basename is a stable key across any amount of folder reshuffling. The index is built once per
 * regrade and only when a stored path actually fails, so an install whose paths are all valid
 * pays nothing.
 */

export interface ReplayFileEntry {
  name: string;
  path: string;
}

/**
 * basename → full path. Later entries do NOT overwrite earlier ones: when the same replay
 * exists in two folders (a copy left behind by a half-finished move), the first match is as
 * good as any — same game, same bytes — and keeping it stable makes the result deterministic.
 */
export function indexByBasename(entries: ReplayFileEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const e of entries) {
    if (!index.has(e.name)) index.set(e.name, e.path);
  }
  return index;
}

/** The basename of a stored path, tolerating either separator (paths are written with both). */
export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * Where a game's replay actually is, or null if it can't be found.
 *
 * `filename` is games.filename (the scan-time basename) and is preferred; the stored path's own
 * basename is the fallback for rows where filename is absent. Returns null when the index has no
 * match, which the caller must treat as "skip this game" exactly as before — the point of this
 * module is to recover files that moved, never to guess at ones that are gone.
 */
export function resolveReplayPath(
  storedPath: string | null | undefined,
  filename: string | null | undefined,
  index: Map<string, string>,
): string | null {
  const key = filename || (storedPath ? basename(storedPath) : "");
  if (!key) return null;
  return index.get(key) ?? null;
}
