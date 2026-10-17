/**
 * What a game's stored `result` means for a win/loss record.
 *
 * `lras_win` / `lras_loss` mark a game that ended because somebody quit out (`lras_win` = the
 * opponent quit, `lras_loss` = the player did). In RANKED that is always a forfeit: the player
 * who left loses, and Slippi scores it that way.
 *
 * In UNRANKED and DIRECT it depends on when they left (Joey, 2026-10-16):
 *  - inside the first `QUIT_OUT_COUNTS_AFTER_FRAMES` (30 s) it's "none" — a misclick, a wrong
 *    character, a stage someone didn't want. Not a win, not a loss, excluded from the record.
 *  - after that it counts against the player who quit. The common case is someone playing a
 *    whole game and leaving just before they lose; that's a loss, not a non-game.
 *
 * A quit-out with no known duration stays "none" rather than being guessed at.
 */
export type Outcome = "win" | "loss" | "none";

/** Outside ranked, a quit-out this early is no result; at or after it, the quitter loses. */
export const QUIT_OUT_COUNTS_AFTER_FRAMES = 30 * 60;

const QUIT_OUT = new Set(["lras_win", "lras_loss"]);

export function gameOutcome(
  result: string | null | undefined,
  matchType: string | null | undefined,
  durationFrames: number | null | undefined,
): Outcome {
  const r = result ?? "";
  if (QUIT_OUT.has(r)) {
    const forfeit = r === "lras_win" ? "win" : "loss";
    if (matchType === "ranked") return forfeit;
    if (durationFrames == null || durationFrames < QUIT_OUT_COUNTS_AFTER_FRAMES) return "none";
    return forfeit;
  }
  if (r === "win") return "win";
  if (r === "loss") return "loss";
  return "none";
}

/** Tally a set of games into a record, skipping anything with no result. */
export function tallyOutcomes<
  T extends { result?: string | null; match_type?: string | null; duration_frames?: number | null },
>(games: T[]): { wins: number; losses: number; total: number; noResult: number } {
  let wins = 0, losses = 0, noResult = 0;
  for (const g of games) {
    const o = gameOutcome(g.result, g.match_type, g.duration_frames);
    if (o === "win") wins++;
    else if (o === "loss") losses++;
    else noResult++;
  }
  return { wins, losses, total: wins + losses, noResult };
}
