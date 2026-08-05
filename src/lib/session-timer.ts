// How long the current unranked/direct run against one opponent has been going.
//
// Ranked has no use for this: a ranked set is a bounded best-of-3 that ends on its own. An
// unranked/direct match_id is the ENTIRE connection with that opponent and has no end event,
// so "how long have I been playing this person" is a real question with no answer on screen.

/** Elapsed milliseconds between two ISO timestamps, floored at 0. */
export function elapsedMs(startIso: string, nowMs: number): number | null {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return null;
  // A clock adjustment (or a replay whose startAt is slightly ahead of us) can put the start in
  // the future. Showing a negative timer would be worse than showing zero.
  return Math.max(0, nowMs - start);
}

/**
 * Stopwatch formatting: `m:ss` under an hour, `h:mm:ss` at or over it.
 *
 * Minutes are deliberately unpadded in the short form (`7:04`, not `07:04`) so it reads like a
 * stopwatch rather than a timestamp; seconds and the inner minutes are always padded.
 */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
}
