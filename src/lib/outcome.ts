/**
 * What a game's stored `result` means for a win/loss record.
 *
 * `lras_win` / `lras_loss` mark a game that ended because somebody quit out. In RANKED that is a
 * forfeit: the player who left loses, and Slippi scores it that way. In UNRANKED and DIRECT it
 * means nothing of the sort — quitting out is simply how people end a game or get back to
 * character select, and it happens constantly (2 of 6 games in one measured session). Counting
 * those as forfeit wins made a 2–2 friendlies session read as 4–2.
 *
 * So a quit-out outside ranked is "none": not a win, not a loss, excluded from the record
 * entirely rather than guessed at. The game still exists, still shows in lists, and is still
 * graded if it ran long enough to be worth grading.
 */
export type Outcome = "win" | "loss" | "none";

const QUIT_OUT = new Set(["lras_win", "lras_loss"]);

export function gameOutcome(result: string | null | undefined, matchType: string | null | undefined): Outcome {
  const r = result ?? "";
  if (QUIT_OUT.has(r)) {
    // Ranked keeps forfeit semantics; everything else treats a quit-out as no result.
    if (matchType !== "ranked") return "none";
    return r === "lras_win" ? "win" : "loss";
  }
  if (r === "win") return "win";
  if (r === "loss") return "loss";
  return "none";
}

/** Tally a set of games into a record, skipping anything with no result. */
export function tallyOutcomes<T extends { result?: string | null; match_type?: string | null }>(
  games: T[],
): { wins: number; losses: number; total: number; noResult: number } {
  let wins = 0, losses = 0, noResult = 0;
  for (const g of games) {
    const o = gameOutcome(g.result, g.match_type);
    if (o === "win") wins++;
    else if (o === "loss") losses++;
    else noResult++;
  }
  return { wins, losses, total: wins + losses, noResult };
}
