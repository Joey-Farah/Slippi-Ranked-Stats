/**
 * notes.ts — scouting notes on opponents and matchups.
 *
 * Two kinds of note, deliberately kept as one table and one mental model:
 *
 *   - **opponent** — about a specific person, keyed by their connect code. "Always techs in
 *     place off the top platform." Useful the moment you queue into them again.
 *   - **matchup**  — about a character pairing, keyed by (your character → their character).
 *     Directional, because Fox-vs-Marth and Marth-vs-Fox are not the same problem. A note may
 *     leave `player_char` empty to mean "any character I play", which is what you want for a
 *     fact about the opposing character rather than about the pairing.
 *
 * Both surface together on the Live Session tab as soon as an opponent is detected — which,
 * since v1.8.13/v1.8.14, is at game *start* (the .slp header peek gives us their code and both
 * characters within ~100ms), so the notes are on screen before the match does.
 *
 * The whole table is held in memory (`notes`). A note list is tiny — hundreds of rows at the
 * very most — and keeping it resident means the live panel renders synchronously off the same
 * store update that puts the opponent on screen, with no query to wait on at the one moment
 * the feature has to be instant.
 *
 * ⚠ Notes are deliberately NOT on the OBS overlay. The panel is a scouting report on the
 * person you are playing; putting it on stream hands it straight to them.
 */

import { writable, derived, get } from "svelte/store";
import {
  getNotesDb,
  listNotes,
  insertNote,
  updateNoteBody,
  updateNotePinned,
  updateOpponentTag,
  deleteNote,
  type NoteRow,
} from "./db";
import { CHARACTERS } from "./parser";
import { activeSet, liveGameStats } from "./store";

export type NoteKind = "opponent" | "matchup";

/** A matchup note's `player_char` when it applies whatever character you're playing. */
export const ANY_CHAR = "";

// ── Pure helpers (no I/O — unit-tested in notes.test.ts) ───────────────────

/** Connect codes are stored and compared upper-cased; Slippi treats them case-insensitively
 *  and the same person typed two ways must not end up with two separate note lists. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function sameCode(a: string, b: string): boolean {
  return !!a && normalizeCode(a) === normalizeCode(b);
}

export function sameChar(a: string, b: string): boolean {
  return !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Does this note apply to the given opponent? */
export function matchesOpponent(n: NoteRow, opponentCode: string): boolean {
  return n.kind === "opponent" && sameCode(n.opponent_code, opponentCode);
}

/** Does this note apply to the given matchup, in this direction?
 *
 *  A note with an empty `player_char` is a wildcard over your side of the matchup. A note that
 *  names a specific character requires us to actually know yours — an unknown character is not
 *  treated as a match, since claiming "this is your Fox note" when we don't know you're on Fox
 *  is worse than showing nothing. */
export function matchesMatchup(n: NoteRow, playerChar: string, opponentChar: string): boolean {
  if (n.kind !== "matchup") return false;
  if (!sameChar(n.opponent_char, opponentChar)) return false;
  if (n.player_char === ANY_CHAR) return true;
  return sameChar(n.player_char, playerChar);
}

/** Pinned first, then most recently edited. Pinning is how a note stays at the top of a list
 *  that's capped on screen; within each band, the newest observation is the most relevant. */
export function sortNotes(notes: NoteRow[]): NoteRow[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned - a.pinned;
    return b.updated_at.localeCompare(a.updated_at) || b.id - a.id;
  });
}

export interface NoteContext {
  opponentCode: string;
  playerChar: string;   // "" when not yet known
  opponentChar: string; // "" when not yet known
}

export interface ContextNotes {
  opponent: NoteRow[];
  matchup: NoteRow[];
}

/** Everything written that applies to the player currently in front of you. */
export function notesForContext(all: NoteRow[], ctx: NoteContext): ContextNotes {
  return {
    opponent: sortNotes(all.filter((n) => matchesOpponent(n, ctx.opponentCode))),
    matchup: sortNotes(all.filter((n) => matchesMatchup(n, ctx.playerChar, ctx.opponentChar))),
  };
}

/** Stable identity for the subject a note is about, used to group the Notes tab. */
export function noteGroupKey(n: NoteRow): string {
  return n.kind === "opponent"
    ? `opponent:${normalizeCode(n.opponent_code)}`
    : `matchup:${n.player_char.toLowerCase()}>${n.opponent_char.toLowerCase()}`;
}

export function matchupTitle(playerChar: string, opponentChar: string): string {
  return playerChar === ANY_CHAR
    ? `Any character vs ${opponentChar}`
    : `${playerChar} vs ${opponentChar}`;
}

export interface NoteGroup {
  key: string;
  kind: NoteKind;
  title: string;     // "Sample" / "Fox vs Marth"
  subtitle: string;  // "FOX#123" / "your character → theirs"
  notes: NoteRow[];  // already sorted
  updated_at: string; // newest note in the group, for ordering groups
}

/** Group every note by its subject, newest-touched subject first. */
export function groupNotes(all: NoteRow[]): NoteGroup[] {
  const byKey = new Map<string, NoteRow[]>();
  for (const n of all) {
    const key = noteGroupKey(n);
    const arr = byKey.get(key) ?? [];
    arr.push(n);
    byKey.set(key, arr);
  }

  const groups: NoteGroup[] = [];
  for (const [key, rows] of byKey) {
    const sorted = sortNotes(rows);
    const kind = (rows[0].kind === "matchup" ? "matchup" : "opponent") as NoteKind;
    // Tags drift — someone renames themselves and old rows keep the old name. The most
    // recently written note carries the freshest tag we've seen, so prefer that one.
    const tag = [...rows]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((r) => r.opponent_tag)
      .find((t) => !!t) ?? "";
    groups.push({
      key,
      kind,
      title:
        kind === "opponent"
          ? tag || normalizeCode(rows[0].opponent_code)
          : matchupTitle(rows[0].player_char, rows[0].opponent_char),
      subtitle: kind === "opponent" ? normalizeCode(rows[0].opponent_code) : "",
      notes: sorted,
      updated_at: sorted.reduce((max, n) => (n.updated_at > max ? n.updated_at : max), ""),
    });
  }

  groups.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return groups;
}

/** What to call the player on screen. Prefer the name the live card has (freshest), but fall
 *  back to whatever their notes were filed under — after a set ends there's no live profile to
 *  read a tag from, and "the person you have six notes about" is worth naming. */
export function preferredTag(liveTag: string, opponentNotes: NoteRow[]): string {
  if (liveTag) return liveTag;
  return opponentNotes.find((n) => !!n.opponent_tag)?.opponent_tag ?? "";
}

/** Free-text filter over a note's body and everything identifying its subject, so typing a
 *  connect code, a tag or a character name all find the same notes. */
export function searchNotes(all: NoteRow[], query: string): NoteRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((n) =>
    [n.body, n.opponent_code, n.opponent_tag, n.player_char, n.opponent_char]
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
}

// ── Stores ─────────────────────────────────────────────────────────────────

/** Every note, resident in memory. Refreshed wholesale after any write — the table is small
 *  enough that a re-read is cheaper to reason about than patching the array by hand. */
export const notes = writable<NoteRow[]>([]);

export interface LiveNoteSubject extends NoteContext {
  tag: string;
  live: boolean; // false = the set is over; this is who you last played
}

/** Who the live notes panel is about.
 *
 *  Not just `activeSet`: a ranked set clears it the instant someone reaches 2, and the moment
 *  you most want to write a note is *right after* playing someone ("he always techs in place"),
 *  not during. So when nothing is live it falls back to the last game of the session — the same
 *  match the per-game stats card keeps showing — and the panel stays put until the next game
 *  starts. `liveGameStats` is already reset on a session gap, so this can't resurrect somebody
 *  you played last night. */
export const liveNoteSubject = derived(
  [activeSet, liveGameStats],
  ([$active, $stats]): LiveNoteSubject | null => {
    if ($active) {
      return {
        opponentCode: $active.opponent_code,
        // -1 until the character is known; CHARACTERS has no such key, so this lands on "".
        playerChar: CHARACTERS[$active.player_char_id] ?? "",
        opponentChar: CHARACTERS[$active.opponent_char_id] ?? "",
        tag: $active.opponent_tag ?? "",
        live: true,
      };
    }
    const last = $stats.at(-1);
    if (!last) return null;
    return {
      opponentCode: last.opponent_code,
      playerChar: CHARACTERS[last.player_char_id] ?? "",
      opponentChar: CHARACTERS[last.opponent_char_id] ?? "",
      // Per-game rows carry no display name — preferredTag() recovers one from their notes.
      tag: "",
      live: false,
    };
  }
);

/** The notes that apply to whoever the panel is about, recomputed whenever either that subject
 *  or the note list changes. `context` is null when there's nobody to show. */
export const liveNotes = derived(
  [notes, liveNoteSubject],
  ([$notes, $subject]): ContextNotes & { context: LiveNoteSubject | null } => {
    if (!$subject) return { opponent: [], matchup: [], context: null };
    const found = notesForContext($notes, $subject);
    return {
      ...found,
      context: { ...$subject, tag: preferredTag($subject.tag, found.opponent) },
    };
  }
);

// ── Actions ────────────────────────────────────────────────────────────────

export async function refreshNotes(): Promise<void> {
  const db = await getNotesDb();
  notes.set(await listNotes(db));
}

function stamp(): string {
  return new Date().toISOString();
}

export async function addOpponentNote(
  opponentCode: string,
  opponentTag: string,
  body: string
): Promise<void> {
  const text = body.trim();
  if (!text || !opponentCode) return;
  const db = await getNotesDb();
  const now = stamp();
  await insertNote(db, {
    kind: "opponent",
    opponent_code: normalizeCode(opponentCode),
    opponent_tag: opponentTag.trim(),
    player_char: "",
    opponent_char: "",
    body: text,
    pinned: 0,
    created_at: now,
    updated_at: now,
  });
  await refreshNotes();
}

export async function addMatchupNote(
  playerChar: string,
  opponentChar: string,
  body: string
): Promise<void> {
  const text = body.trim();
  if (!text || !opponentChar) return;
  const db = await getNotesDb();
  const now = stamp();
  await insertNote(db, {
    kind: "matchup",
    opponent_code: "",
    opponent_tag: "",
    player_char: playerChar.trim(),
    opponent_char: opponentChar.trim(),
    body: text,
    pinned: 0,
    created_at: now,
    updated_at: now,
  });
  await refreshNotes();
}

export async function editNote(id: number, body: string): Promise<void> {
  const text = body.trim();
  // An emptied note is a deleted note — clearing the box and saving is how you get rid of one
  // without hunting for the delete control.
  if (!text) return removeNote(id);
  const db = await getNotesDb();
  await updateNoteBody(db, id, text, stamp());
  await refreshNotes();
}

export async function toggleNotePin(id: number): Promise<void> {
  const current = get(notes).find((n) => n.id === id);
  if (!current) return;
  const db = await getNotesDb();
  await updateNotePinned(db, id, current.pinned ? 0 : 1);
  await refreshNotes();
}

export async function removeNote(id: number): Promise<void> {
  const db = await getNotesDb();
  await deleteNote(db, id);
  await refreshNotes();
}

/** Keep the stored display name for a player current. Called when the live card learns their
 *  tag, so the Notes tab lists them under the name they use now rather than the one they had
 *  when the first note was written. No-ops unless they actually have notes. */
export async function syncOpponentTag(opponentCode: string, tag: string): Promise<void> {
  const code = normalizeCode(opponentCode);
  const clean = tag.trim();
  if (!code || !clean) return;
  const stale = get(notes).some(
    (n) => n.kind === "opponent" && normalizeCode(n.opponent_code) === code && n.opponent_tag !== clean
  );
  if (!stale) return;
  const db = await getNotesDb();
  await updateOpponentTag(db, code, clean);
  await refreshNotes();
}
