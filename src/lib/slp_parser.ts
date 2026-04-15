/**
 * Native binary .slp parser — no @slippi/slippi-js dependency.
 *
 * Ported directly from replay_parser.py. Reads the raw binary event stream
 * and UBJSON metadata block without any Buffer/Node.js polyfill dependencies.
 *
 * Key Slippi event command bytes (spec 3.x):
 *   0x35 = Event Payloads   0x36 = Game Start
 *   0x38 = Post-Frame       0x39 = Game End
 */

const dec = new TextDecoder("utf-8");

// ── UBJSON parser ──────────────────────────────────────────────────────────

function parseUbjson(data: Uint8Array, startPos: number): [unknown, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = startPos;

  function readLength(): number {
    const m = String.fromCharCode(data[pos++]);
    if (m === "i") { const v = view.getInt8(pos);              pos += 1; return v; }
    if (m === "U") { return data[pos++]; }
    if (m === "I") { const v = view.getInt16(pos, false);      pos += 2; return v; }
    if (m === "l") { const v = view.getInt32(pos, false);      pos += 4; return v; }
    if (m === "L") { const v = Number(view.getBigInt64(pos, false)); pos += 8; return v; }
    throw new Error(`Unexpected UBJSON length marker: ${m}`);
  }

  function parse(): unknown {
    const m = String.fromCharCode(data[pos++]);
    if (m === "{") {
      const obj: Record<string, unknown> = {};
      while (String.fromCharCode(data[pos]) !== "}") {
        const keyLen = readLength();
        const key = dec.decode(data.subarray(pos, pos + keyLen));
        pos += keyLen;
        obj[key] = parse();
      }
      pos++; // consume '}'
      return obj;
    }
    if (m === "[") {
      const arr: unknown[] = [];
      while (String.fromCharCode(data[pos]) !== "]") {
        arr.push(parse());
      }
      pos++; // consume ']'
      return arr;
    }
    if (m === "S") {
      const len = readLength();
      const s = dec.decode(data.subarray(pos, pos + len));
      pos += len;
      return s;
    }
    if (m === "i") { const v = view.getInt8(pos);              pos += 1; return v; }
    if (m === "U") { return data[pos++]; }
    if (m === "I") { const v = view.getInt16(pos, false);      pos += 2; return v; }
    if (m === "l") { const v = view.getInt32(pos, false);      pos += 4; return v; }
    if (m === "L") { const v = Number(view.getBigInt64(pos, false)); pos += 8; return v; }
    if (m === "d") { const v = view.getFloat32(pos, false);    pos += 4; return v; }
    if (m === "D") { const v = view.getFloat64(pos, false);    pos += 8; return v; }
    if (m === "T") return true;
    if (m === "F") return false;
    if (m === "Z") return null;
    throw new Error(`Unknown UBJSON type marker: ${m}`);
  }

  const value = parse();
  return [value, pos];
}

// ── Event stream parser ────────────────────────────────────────────────────

interface StreamResult {
  matchId: string;
  stageId: number;
  gameEndMethod: number;
  lrasInitiator: number;
  finalStocks: Record<number, number>;
  maxPercents: Record<number, number>; // max damage % reached per port
  durationFrames: number;
  // ordered action state per port: [frameNum, actionState][]
  actionFrames: Record<number, [number, number][]>;
  // L-cancel tracking (replay spec v2.1.0+): byte 35 of post-frame payload
  lCancelSuccesses: Record<number, number>;
  lCancelAttempts: Record<number, number>;
}

// ── Action-state helpers (mirrors slippi-js common.ts) ─────────────────────

function isInControl(s: number): boolean {
  return (s >= 14 && s <= 34)   // grounded control + controlled jump
      || (s >= 39 && s <= 41)   // squat
      || (s >= 44 && s <= 64)   // ground attack
      || s === 0xB0 || s === 0xB1 || s === 0xB2; // special (B-moves)
}

function isVulnerable(s: number): boolean {
  return (s >= 0  && s <= 10)   // dying
      || (s >= 75 && s <= 91)   // damaged
      || (s >= 183 && s <= 198) // down
      || (s >= 199 && s <= 204) // teching
      || (s >= 223 && s <= 232); // grabbed/command-grabbed
}

/** Compute conversion-based stats from ordered action state frames. */
function computeConversionStats(
  playerPort: number,
  oppPort: number,
  actionFrames: Record<number, [number, number][]>,
  maxPercents: Record<number, number>,
  finalStocks: Record<number, number>
): { openings_per_kill: number | null; neutral_win_ratio: number | null; damage_per_opening: number | null } {
  const pFrames = actionFrames[playerPort] ?? [];
  const oFrames = actionFrames[oppPort] ?? [];

  // Build per-frame lookup for the opponent so we can access both ports by frame
  const oByFrame = new Map<number, number>();
  for (const [f, s] of oFrames) oByFrame.set(f, s);

  let neutralWins = 0;   // times we put opponent into vulnerable state from control
  let neutralLosses = 0; // times opponent put us into vulnerable state from control

  let prevPlayerCtrl = false;
  let prevOppCtrl = false;

  // Iterate player frames (same frame set as opponent in a 1v1)
  for (const [frame, playerState] of pFrames) {
    const oppState = oByFrame.get(frame);
    if (oppState === undefined) continue;

    const playerCtrl = isInControl(playerState);
    const oppCtrl    = isInControl(oppState);

    // Opponent transitions: was in control → now vulnerable = we opened them up
    if (prevOppCtrl && isVulnerable(oppState)) neutralWins++;
    // Player transitions: was in control → now vulnerable = they opened us up
    if (prevPlayerCtrl && isVulnerable(playerState)) neutralLosses++;

    prevPlayerCtrl = playerCtrl;
    prevOppCtrl    = oppCtrl;
  }

  const kills      = 4 - (finalStocks[oppPort] ?? 0);
  const totalNeutral = neutralWins + neutralLosses;
  const dmgDealt   = maxPercents[oppPort] ?? 0;

  return {
    openings_per_kill:  kills > 0         ? neutralWins / kills         : null,
    neutral_win_ratio:  totalNeutral > 0  ? neutralWins / totalNeutral  : null,
    damage_per_opening: neutralWins > 0   ? dmgDealt    / neutralWins   : null,
  };
}

function parseEventStream(data: Uint8Array): StreamResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // raw event stream length: big-endian int32 at offset 11
  const rawLen = view.getInt32(11, false);
  const eventsStart = 15;
  const eventsEnd = eventsStart + rawLen;

  // First event must be Event Payloads (0x35)
  if (data[eventsStart] !== 0x35) {
    throw new Error(`Expected 0x35 at byte 15, got 0x${data[eventsStart].toString(16)}`);
  }

  // epSize is the payload size of the 0x35 event (including its own size byte)
  const epSize = data[eventsStart + 1];
  const pairCount = Math.floor((epSize - 1) / 3);
  const payloadSizes: Record<number, number> = {};
  for (let i = 0; i < pairCount; i++) {
    const off = eventsStart + 2 + i * 3;
    const cmd = data[off];
    const size = view.getUint16(off + 1, false);
    payloadSizes[cmd] = size;
  }

  // Start walking events after the 0x35 event (cmd=1 byte + epSize bytes)
  let pos = eventsStart + 1 + epSize;
  let matchId = "";
  let stageId = -1;
  let gameEndMethod = -1;
  let lrasInitiator = -1;
  const finalStocks: Record<number, number> = {};
  const maxPercents: Record<number, number> = {};
  const actionFrames: Record<number, [number, number][]> = {};
  const lCancelSuccesses: Record<number, number> = {};
  const lCancelAttempts: Record<number, number> = {};
  let durationFrames = 0;

  while (pos < eventsEnd) {
    const cmd = data[pos];
    const size = payloadSizes[cmd];
    if (size === undefined) { pos++; continue; }

    const ps = pos + 1; // payload start

    if (cmd === 0x36) {
      // GAME_START: stage_id is a uint8 at payload byte 19
      if (size >= 20) {
        stageId = data[ps + 19];
      }
      // match_id: search for "mode." in payload
      for (let i = ps; i < ps + size - 4; i++) {
        if (data[i] === 109 && data[i+1] === 111 && data[i+2] === 100 && data[i+3] === 101 && data[i+4] === 46) {
          let end = i;
          while (end < i + 60 && end < ps + size && data[end] !== 0) end++;
          matchId = dec.decode(data.subarray(i, end));
          break;
        }
      }

    } else if (cmd === 0x38) {
      // POST_FRAME
      // Offsets: 0=frame_num(i32), 4=port, 5=is_follower, 7=action_state(u16),
      //          21=percent(f32), 32=stocks
      if (size >= 33) {
        const port = data[ps + 4];
        const isFollower = data[ps + 5];
        if (!isFollower && port <= 3) {
          const frameNum = view.getInt32(ps, false);
          const actionState = view.getUint16(ps + 7, false);
          const stocks = data[ps + 32];
          const percent = view.getFloat32(ps + 21, false);

          finalStocks[port] = stocks;
          if (frameNum > durationFrames) durationFrames = frameNum;
          if (percent > (maxPercents[port] ?? 0)) maxPercents[port] = percent;
          if (!actionFrames[port]) actionFrames[port] = [];
          actionFrames[port].push([frameNum, actionState]);

          // L-cancel status byte at offset 35 (added in replay spec v2.1.0)
          // 0x01 = success, 0x02 = failure; 0x00 = no attempt this frame
          if (size >= 36) {
            const lcStatus = data[ps + 35];
            if (lcStatus === 1 || lcStatus === 2) {
              lCancelAttempts[port] = (lCancelAttempts[port] ?? 0) + 1;
              if (lcStatus === 1) lCancelSuccesses[port] = (lCancelSuccesses[port] ?? 0) + 1;
            }
          }
        }
      }

    } else if (cmd === 0x39) {
      // GAME_END
      if (size >= 2) {
        gameEndMethod = data[ps];
        lrasInitiator = view.getInt8(ps + 1);
      }
    }

    pos += 1 + size;
  }

  return { matchId, stageId, gameEndMethod, lrasInitiator, finalStocks, maxPercents, durationFrames, actionFrames, lCancelSuccesses, lCancelAttempts };
}

// ── Metadata parser ────────────────────────────────────────────────────────

interface PlayerMeta {
  connectCode: string;
  charId: number | null;
}

interface MetadataResult {
  players: Record<number, PlayerMeta>;
  timestamp: string;
}

function parseMetadata(data: Uint8Array): MetadataResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rawLen = view.getInt32(11, false);

  // .slp layout: 15 bytes header + rawLen event stream + 10 bytes UBJSON key "U\x08metadata"
  const metaStart = 15 + rawLen + 10;
  // Strip top-level closing '}' at end
  const metaSlice = data.subarray(metaStart, data.byteLength - 1);

  let meta: Record<string, unknown>;
  try {
    const [value] = parseUbjson(metaSlice, 0);
    meta = value as Record<string, unknown>;
  } catch {
    return { players: {}, timestamp: "" };
  }

  const players: Record<number, PlayerMeta> = {};
  const playersData = meta.players as Record<string, unknown> | undefined;
  if (playersData) {
    for (const [portStr, pdata] of Object.entries(playersData)) {
      const port = parseInt(portStr, 10);
      const pd = pdata as Record<string, unknown>;
      const chars = pd.characters as Record<string, number> | undefined;

      // Primary character = the one played for the most frames
      let charId: number | null = null;
      if (chars && Object.keys(chars).length > 0) {
        const best = Object.entries(chars).reduce((a, b) => (b[1] > a[1] ? b : a));
        charId = parseInt(best[0], 10);
      }

      const names = pd.names as Record<string, string> | undefined;
      players[port] = {
        connectCode: names?.code ?? "",
        charId,
      };
    }
  }

  return {
    players,
    timestamp: (meta.startAt as string) ?? "",
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ParsedGameRow {
  filename: string;
  filepath: string;
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
  // Live stats — not stored in DB, used for in-session display
  kills: number;
  deaths: number;
  // Advanced stats populated by slippi-js in parser.ts (null until augmented)
  openings_per_kill: number | null;
  damage_per_opening: number | null;
  neutral_win_ratio: number | null;
  inputs_per_minute: number | null;
  l_cancel_ratio: number | null;
}

const METHOD_GAME = 2;
const METHOD_NO_CONTEST = 7;

/**
 * Parse a raw .slp file's bytes and return the game row for the given
 * connect code. Returns an empty array if the file is not a ranked/unranked
 * match, the connect code is not in the game, or the result is ambiguous.
 */
export function parseSlpBytes(
  bytes: Uint8Array,
  filepath: string,
  connectCode: string
): ParsedGameRow[] {
  // Quick filter: check for "mode." string before full parse
  let hasModeStr = false;
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 109 && bytes[i+1] === 111 && bytes[i+2] === 100 && bytes[i+3] === 101 && bytes[i+4] === 46) {
      hasModeStr = true;
      break;
    }
  }
  if (!hasModeStr) return [];

  let stream: StreamResult;
  try {
    stream = parseEventStream(bytes);
  } catch {
    return [];
  }
  if (!stream.matchId) return [];

  // Parse match type from matchId (e.g. "mode.ranked-...")
  const matchTypeRaw = stream.matchId.split("-")[0]; // "mode.ranked"
  const match_type = matchTypeRaw.replace("mode.", ""); // "ranked", "unranked", etc.
  if (match_type !== "ranked" && match_type !== "unranked") return [];

  let meta: MetadataResult;
  try {
    meta = parseMetadata(bytes);
  } catch {
    return [];
  }

  const ports = Object.keys(meta.players).map(Number);
  if (ports.length < 2) return [];

  const cc = connectCode.toUpperCase();
  const playerPort = ports.find((p) => meta.players[p].connectCode.toUpperCase() === cc);
  if (playerPort === undefined) return [];

  const oppPort = ports.find((p) => p !== playerPort);
  if (oppPort === undefined) return [];

  const { gameEndMethod, lrasInitiator, finalStocks, durationFrames } = stream;

  let result: string;
  if (gameEndMethod === METHOD_GAME) {
    const ps = finalStocks[playerPort] ?? -1;
    const os = finalStocks[oppPort] ?? -1;
    if (ps > os) result = "win";
    else if (ps < os) result = "loss";
    else return []; // tied stocks — ambiguous, skip
  } else if (gameEndMethod === METHOD_NO_CONTEST) {
    if (lrasInitiator === playerPort) result = "lras_loss";
    else if (lrasInitiator >= 0) result = "lras_win";
    else return [];
  } else {
    return [];
  }

  const filename = filepath.split(/[/\\]/).pop() ?? filepath;

  const kills  = 4 - (stream.finalStocks[oppPort]    ?? 0);
  const deaths = 4 - (stream.finalStocks[playerPort] ?? 0);

  const convStats = computeConversionStats(
    playerPort, oppPort, stream.actionFrames, stream.maxPercents, stream.finalStocks
  );

  return [{
    filename,
    filepath,
    timestamp: meta.timestamp,
    match_type,
    player_port: playerPort,
    player_char_id: meta.players[playerPort].charId ?? -1,
    opponent_code: meta.players[oppPort].connectCode,
    opponent_char_id: meta.players[oppPort].charId ?? -1,
    stage_id: stream.stageId,
    result,
    duration_frames: durationFrames,
    match_id: stream.matchId,
    kills,
    deaths,
    openings_per_kill:  convStats.openings_per_kill,
    damage_per_opening: convStats.damage_per_opening,
    neutral_win_ratio:  convStats.neutral_win_ratio,
    inputs_per_minute:  null, // requires per-frame input data, not tracked yet
    l_cancel_ratio: (() => {
      const attempts  = stream.lCancelAttempts[playerPort]  ?? 0;
      const successes = stream.lCancelSuccesses[playerPort] ?? 0;
      return attempts > 0 ? successes / attempts : null;
    })(),
  }];
}
