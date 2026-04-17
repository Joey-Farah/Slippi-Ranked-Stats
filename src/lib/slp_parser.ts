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

interface FrameSnapshot {
  frame: number;
  state: number;
  x: number;
  y: number;
  percent: number;
  stocks: number;
}

interface StreamResult {
  matchId: string;
  stageId: number;
  gameEndMethod: number;
  lrasInitiator: number;
  finalStocks: Record<number, number>;
  // Total damage dealt TO each port, summed across stocks. Counts the peak
  // percent each life since percent resets on respawn. Replaces the old
  // "peak of final stock only" approach which undercounted across a full game.
  totalDamageTaken: Record<number, number>;
  durationFrames: number;
  // ordered action state per port: [frameNum, actionState][]
  actionFrames: Record<number, [number, number][]>;
  // Per-frame snapshots (state, x, y, percent, stocks) used for advanced stats
  frameData: Record<number, FrameSnapshot[]>;
  // L-cancel tracking (replay spec v3.0.0+): offset 0x31 of post-frame payload
  lCancelSuccesses: Record<number, number>;
  lCancelAttempts: Record<number, number>;
  // Per-port percent at each stock loss (for avg kill/death percent)
  stockPercents: Record<number, number[]>;
  // Total button-state changes per port (for inputs/min)
  inputCounts: Record<number, number>;
  // Count of roll/spotdodge uses per port (defensive option rate)
  defensiveOptions: Record<number, number>;
}

// ── Action-state helpers (mirrors slippi-js common.ts) ─────────────────────

function isInControl(s: number): boolean {
  // Matches slippi-js isInControl exactly: grounded control (14–24), squat, ground attack (>44), grab
  return (s >= 14 && s <= 24)
      || (s >= 39 && s <= 41)
      || (s > 44 && s <= 64)    // note: 44 (jab1) excluded per slippi-js
      || s === 212;              // GRAB
}

/** Opponent is "in a conversion" — slippi-js isDamaged || isGrabbed || isCommandGrabbed. */
function isInStun(s: number): boolean {
  return (s >= 75 && s <= 91)                                                           // hitstun
      || s === 38 || s === 185 || s === 193                                              // DamageFall, JabReset states
      || (s >= 223 && s <= 232)                                                         // grabbed
      || (((s >= 266 && s <= 304) || (s >= 327 && s <= 338)) && s !== 293);            // command-grabbed
}

function isVulnerable(s: number): boolean {
  return (s >= 0  && s <= 10)   // dying
      || (s >= 75 && s <= 91)   // damaged
      || (s >= 183 && s <= 198) // down
      || (s >= 199 && s <= 204) // teching
      || (s >= 223 && s <= 232); // grabbed/command-grabbed
}

/** Attack states: opponent was mid-attack when we opened them (counter-hit detection). */
function isAttacking(s: number): boolean {
  return (s >= 44 && s <= 74)    // ground attacks (44–64) + aerial attacks (65–74)
      || (s === 0xB0 || s === 0xB1 || s === 0xB2); // special moves
}

/** Defensive option states: roll forward (29), roll backward (30), spot dodge (31). */
const DEFENSIVE_STATES = new Set([29, 30, 31]);

/** Grounded-knockdown / tech states (0xB7–0xCC) where tech-chase opportunities arise. */
function isKnockdown(s: number): boolean {
  return (s >= 183 && s <= 204); // down-bound, down-wait, tech, get-up family
}

/** Hamming weight — counts set bits. Matches slippi-js countSetBits. */
function countSetBits(x: number): number {
  let bits = x;
  let count = 0;
  while (bits) { bits &= bits - 1; count++; }
  return count;
}

/**
 * Compute conversion-based stats using slippi-js's methodology.
 *
 * A "conversion" (opening) starts when opponent enters hitstun/grabbed/command-grabbed.
 * It ends when: opponent has been in isInControl state for >45 consecutive frames (reset),
 * or the game ends. This matches Slippi Launcher's OPK and neutral win ratio exactly.
 */
function computeConversionStats(
  playerPort: number,
  oppPort: number,
  frameData: Record<number, FrameSnapshot[]>,
  totalDamageTaken: Record<number, number>,
  finalStocks: Record<number, number>,
): {
  openings_per_kill: number | null;
  neutral_win_ratio: number | null;
  damage_per_opening: number | null;
  counter_hit_rate: number | null;
  opening_conversion_rate: number | null;
} {
  const playerFrames = frameData[playerPort] ?? [];
  const oppMap       = new Map<number, FrameSnapshot>();
  for (const snap of frameData[oppPort] ?? []) oppMap.set(snap.frame, snap);

  const NULL_RESULT = {
    openings_per_kill: null, neutral_win_ratio: null, damage_per_opening: null,
    counter_hit_rate: null, opening_conversion_rate: null,
  };
  if (playerFrames.length === 0) return NULL_RESULT;

  const RESET_FRAMES = 45; // slippi-js PUNISH_RESET_FRAMES

  // Our conversion state (punishing opponent)
  let playerConvActive  = false;
  let playerResetCtr    = 0;
  let playerConvCount   = 0;
  let playerNeutralWins = 0;
  let openingConvCount  = 0;
  let convStartPct      = -1;
  let convStartStocks   = -1;

  // Opponent's conversion state (punishing us)
  let oppConvActive  = false;
  let oppResetCtr    = 0;
  let oppConvCount   = 0;
  let oppNeutralWins = 0;

  for (const snap of playerFrames) {
    const opp = oppMap.get(snap.frame);
    if (!opp) continue;

    const oppInStun    = isInStun(opp.state);
    const oppInCtrl    = isInControl(opp.state);
    const playerInStun = isInStun(snap.state);
    const playerInCtrl = isInControl(snap.state);

    // ── Our conversion on opponent ────────────────────────────────────────
    if (oppInStun) {
      if (!playerConvActive) {
        playerConvActive = true;
        playerConvCount++;
        if (!oppConvActive) playerNeutralWins++; // neutral-win if opp wasn't already punishing us
        convStartPct    = opp.percent;
        convStartStocks = opp.stocks;
      }
      playerResetCtr = 0;
    } else if (playerConvActive) {
      // Reset timer runs when opp is in control; once started, continues through other states
      if (oppInCtrl || playerResetCtr > 0) {
        playerResetCtr++;
        if (playerResetCtr > RESET_FRAMES) {
          if (opp.percent - convStartPct >= 20 || opp.stocks < convStartStocks)
            openingConvCount++;
          playerConvActive = false;
          playerResetCtr   = 0;
          convStartPct     = -1;
          convStartStocks  = -1;
        }
      }
    }

    // ── Opponent's conversion on us ───────────────────────────────────────
    if (playerInStun) {
      if (!oppConvActive) {
        oppConvActive = true;
        oppConvCount++;
        if (!playerConvActive) oppNeutralWins++; // neutral-win for opp if we weren't punishing
      }
      oppResetCtr = 0;
    } else if (oppConvActive) {
      if (playerInCtrl || oppResetCtr > 0) {
        oppResetCtr++;
        if (oppResetCtr > RESET_FRAMES) { oppConvActive = false; oppResetCtr = 0; }
      }
    }
  }

  // Finalize any active conversion at game end (typically the killing blow)
  if (playerConvActive) openingConvCount++;

  const kills   = 4 - (finalStocks[oppPort] ?? 0);
  const nwTotal = playerNeutralWins + oppNeutralWins;
  const dmgDealt = totalDamageTaken[oppPort] ?? 0;

  return {
    openings_per_kill:       kills > 0      ? playerConvCount   / kills      : null,
    neutral_win_ratio:       nwTotal > 0    ? playerNeutralWins / nwTotal    : null,
    damage_per_opening:      playerConvCount > 0 ? dmgDealt / playerConvCount      : null,
    counter_hit_rate:        null,
    opening_conversion_rate: playerConvCount > 0 ? openingConvCount / playerConvCount : null,
  };
}

/** Compute position- and timing-based stats. */
function computeAdvancedStats(
  playerPort: number,
  oppPort: number,
  frameData: Record<number, FrameSnapshot[]>,
  result: "win" | "loss",
): {
  stage_control_ratio:    number | null;
  tech_chase_rate:        number | null;
  edgeguard_success_rate: number | null;
  recovery_success_rate:  number | null;
  hit_advantage_rate:     number | null;
  avg_stock_duration:     number | null;
  respawn_defense_rate:   number | null;
  comeback_rate:          number | null;
  lead_maintenance_rate:  number | null;
  wavedash_miss_rate:     number | null;
} {
  const playerFrames = frameData[playerPort] ?? [];
  const oppByFrame   = new Map<number, FrameSnapshot>();
  for (const snap of frameData[oppPort] ?? []) oppByFrame.set(snap.frame, snap);

  const NULL_RESULT = {
    stage_control_ratio: null, tech_chase_rate: null, edgeguard_success_rate: null,
    recovery_success_rate: null, hit_advantage_rate: null, avg_stock_duration: null,
    respawn_defense_rate: null, comeback_rate: null, lead_maintenance_rate: null,
    wavedash_miss_rate: null,
  };
  if (playerFrames.length === 0) return NULL_RESULT;

  const OFFSTAGE_Y     = -5;
  const RETURN_Y       =  5;
  const EG_WINDOW      = 180; // 3 s
  const TC_WINDOW      =  45; // 0.75 s
  const TC_HIT_DMG     =   3;
  const RESPAWN_WINDOW = 150; // 2.5 s
  const JUMP_STATES    = new Set([24, 25]); // JumpF, JumpB
  const AIRDODGE       = 235; // EscapeAir
  const WD_LAND        = 189; // LandingFallSpecial (wavedash landing)
  const WD_JUMP_Y      =   5;
  const WD_DODGE_F     =   4;
  const WD_LAND_F      =   4;

  let centerFrames  = 0;
  let onStageFrames = 0;

  let techSit = 0; let techHit = 0;
  let tcFrame = -1; let tcPct  = -1;
  let prevOppKD = false;

  let egSit = 0; let egSuccess = 0;
  let egFrame = -1; let egStocks = -1;
  let prevOppY = 999;

  let recSit = 0; let recSuccess = 0;
  let recFrame = -1; let recStocks = -1;
  let prevPY = 999;

  let hitOpps      = 0;
  let hitFollowups = 0;
  let hitWindowEnd = -1;
  let prevOppVuln  = false;

  const stockDurations: number[] = [];
  let stockStart    = playerFrames[0].frame;
  let prevPStocks   = playerFrames[0].stocks;

  let respawnSit = 0; let respawnSuccess = 0;
  let respawnEnd = -1; let respawnPct = -1;
  let prevOppStocksR = -1;

  let wasEverDown = false;
  let wasEverUp   = false;

  let wdAttempts = 0; let wdSuccesses = 0;
  let jumpFrame  = -1; let dodgeFrame  = -1;
  let prevPState = -1;

  for (const snap of playerFrames) {
    const opp = oppByFrame.get(snap.frame);

    // ── Stage control: player closer to center than opponent, both on stage ──
    if (opp && snap.y > OFFSTAGE_Y && opp.y > OFFSTAGE_Y) {
      onStageFrames++;
      if (Math.abs(snap.x) < Math.abs(opp.x)) centerFrames++;
    }

    // ── Stock duration ─────────────────────────────────────────────────────
    if (snap.stocks < prevPStocks) {
      stockDurations.push(snap.frame - stockStart);
      stockStart = snap.frame;
    }
    prevPStocks = snap.stocks;

    if (opp) {
      // ── Comeback / lead maintenance ────────────────────────────────────
      if (snap.stocks < opp.stocks) wasEverDown = true;
      if (snap.stocks > opp.stocks) wasEverUp   = true;

      // ── Hit advantage rate: did player attack within 30f of each hit? ────
      const oppVuln = isVulnerable(opp.state);
      if (!prevOppVuln && oppVuln) {
        hitOpps++;
        hitWindowEnd = snap.frame + 30;
      }
      if (hitWindowEnd >= 0) {
        if (snap.frame <= hitWindowEnd && isAttacking(snap.state)) { hitFollowups++; hitWindowEnd = -1; }
        else if (snap.frame > hitWindowEnd)                         {                 hitWindowEnd = -1; }
      }
      prevOppVuln = oppVuln;

      // ── Tech chase ─────────────────────────────────────────────────────
      const oppKD = isKnockdown(opp.state);
      if (!prevOppKD && oppKD) { techSit++; tcFrame = snap.frame; tcPct = opp.percent; }
      if (tcFrame >= 0) {
        if (snap.frame > tcFrame + TC_WINDOW)      { tcFrame = -1; }
        else if (opp.percent > tcPct + TC_HIT_DMG) { techHit++; tcFrame = -1; }
      }
      prevOppKD = oppKD;

      // ── Edgeguard ──────────────────────────────────────────────────────
      const oppOff = opp.y < OFFSTAGE_Y;
      if (egFrame < 0 && oppOff && prevOppY >= OFFSTAGE_Y) { egSit++; egFrame = snap.frame; egStocks = opp.stocks; }
      if (egFrame >= 0) {
        if (opp.stocks < egStocks)                    { egSuccess++; egFrame = -1; }
        else if (opp.y > RETURN_Y)                    {              egFrame = -1; }
        else if (snap.frame > egFrame + EG_WINDOW)    {              egFrame = -1; }
      }
      prevOppY = opp.y;

      // ── Respawn defense ────────────────────────────────────────────────
      if (prevOppStocksR >= 0 && opp.stocks < prevOppStocksR) {
        respawnSit++;
        respawnEnd = snap.frame + RESPAWN_WINDOW;
        respawnPct = snap.percent;
      }
      if (respawnEnd >= 0) {
        if (snap.percent > respawnPct + 5)         { respawnEnd = -1; }
        else if (snap.frame > respawnEnd)           { respawnSuccess++; respawnEnd = -1; }
      }
      prevOppStocksR = opp.stocks;
    }

    // ── Recovery ───────────────────────────────────────────────────────────
    const pOff = snap.y < OFFSTAGE_Y;
    if (recFrame < 0 && pOff && prevPY >= OFFSTAGE_Y) { recSit++; recFrame = snap.frame; recStocks = snap.stocks; }
    if (recFrame >= 0) {
      if (snap.stocks < recStocks)                  {               recFrame = -1; }
      else if (snap.y > RETURN_Y)                   { recSuccess++; recFrame = -1; }
      else if (snap.frame > recFrame + EG_WINDOW)   {               recFrame = -1; }
    }
    prevPY = snap.y;

    // ── Wavedash miss rate ─────────────────────────────────────────────────
    if (snap.state !== prevPState) {
      if (JUMP_STATES.has(snap.state) && snap.y < WD_JUMP_Y) {
        jumpFrame = snap.frame; dodgeFrame = -1;
      } else if (snap.state === AIRDODGE && jumpFrame >= 0 && snap.frame <= jumpFrame + WD_DODGE_F) {
        wdAttempts++; dodgeFrame = snap.frame; jumpFrame = -1;
      } else if (snap.state === WD_LAND && dodgeFrame >= 0 && snap.frame <= dodgeFrame + WD_LAND_F) {
        wdSuccesses++; dodgeFrame = -1;
      }
    }
    if (jumpFrame  >= 0 && snap.frame > jumpFrame  + WD_DODGE_F + 1) jumpFrame  = -1;
    if (dodgeFrame >= 0 && snap.frame > dodgeFrame + WD_LAND_F  + 1) dodgeFrame = -1;
    prevPState = snap.state;
  }

  // If player never died, full game counts as one stock life
  if (stockDurations.length === 0) {
    stockDurations.push(playerFrames.at(-1)!.frame - playerFrames[0].frame);
  }

  return {
    stage_control_ratio:    onStageFrames > 0 ? centerFrames / onStageFrames : null,
    tech_chase_rate:        techSit       > 0 ? techHit      / techSit       : null,
    edgeguard_success_rate: egSit         > 0 ? egSuccess    / egSit         : null,
    recovery_success_rate:  recSit        > 0 ? recSuccess   / recSit        : null,
    hit_advantage_rate:     hitOpps       > 0 ? hitFollowups / hitOpps       : null,
    avg_stock_duration:     stockDurations.reduce((a, b) => a + b, 0) / stockDurations.length,
    respawn_defense_rate:   respawnSit    > 0 ? respawnSuccess / respawnSit  : null,
    comeback_rate:          wasEverDown ? (result === "win" ? 1 : 0) : null,
    lead_maintenance_rate:  wasEverUp   ? (result === "win" ? 1 : 0) : null,
    wavedash_miss_rate:     wdAttempts    > 0 ? (wdAttempts - wdSuccesses) / wdAttempts : null,
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
  // Sum of peak damage reached on each stock before loss — matches the Python
  // baseline pipeline's total-damage-dealt accumulator.
  const totalDamageTaken: Record<number, number> = {};
  const damageThisStock: Record<number, number> = {};
  const actionFrames: Record<number, [number, number][]> = {};
  const lCancelSuccesses: Record<number, number> = {};
  const lCancelAttempts: Record<number, number> = {};
  const stockPercents: Record<number, number[]> = {};
  const prevStocksTrack: Record<number, number> = {};
  const prevPercentsTrack: Record<number, number> = {};
  const inputCounts: Record<number, number> = {};
  const prevButtons: Record<number, number> = {};
  const maxPreFrame: Record<number, number> = {}; // rollback guard: skip already-seen frames
  const defensiveOptions: Record<number, number> = {};
  const prevActionState: Record<number, number> = {};
  const frameData: Record<number, FrameSnapshot[]> = {};
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
          const frameNum    = view.getInt32(ps, false);
          const actionState = view.getUint16(ps + 7, false);
          const stocks      = data[ps + 32];
          const percent     = view.getFloat32(ps + 21, false);
          const x           = view.getFloat32(ps + 9,  false);
          const y           = view.getFloat32(ps + 13, false);

          finalStocks[port] = stocks;
          if (frameNum > durationFrames) durationFrames = frameNum;
          if (!actionFrames[port]) actionFrames[port] = [];
          actionFrames[port].push([frameNum, actionState]);
          if (!frameData[port]) frameData[port] = [];
          frameData[port].push({ frame: frameNum, state: actionState, x, y, percent, stocks });

          // Defensive option: count each new entry into a roll/spotdodge state.
          if (DEFENSIVE_STATES.has(actionState) && !DEFENSIVE_STATES.has(prevActionState[port] ?? -1)) {
            defensiveOptions[port] = (defensiveOptions[port] ?? 0) + 1;
          }

          // L-cancel: count once per new aerial-attack action (matches slippi-js isNewAction guard).
          // States 65-74 = aerial attacks (65-69) + landing-lag states (70-74).
          // l_cancel_status is set on the first frame of the landing-lag transition.
          // slpReader: lCancelStatus = readUint8(view, 0x33); view[0]=cmd byte, so ps offset = 0x33-1 = 0x32 = 50.
          if (size >= 51 && actionState >= 65 && actionState <= 74
              && actionState !== (prevActionState[port] ?? -1)) {
            const lcStatus = data[ps + 50];
            if (lcStatus === 1) {
              lCancelSuccesses[port] = (lCancelSuccesses[port] ?? 0) + 1;
              lCancelAttempts[port]  = (lCancelAttempts[port]  ?? 0) + 1;
            } else if (lcStatus === 2) {
              lCancelAttempts[port] = (lCancelAttempts[port] ?? 0) + 1;
            }
          }
          prevActionState[port] = actionState;

          // Stock transition: record percent at the frame before a stock was lost,
          // and bank the peak damage this life into the per-port total.
          if (prevStocksTrack[port] !== undefined && stocks < prevStocksTrack[port]) {
            if (!stockPercents[port]) stockPercents[port] = [];
            stockPercents[port].push(prevPercentsTrack[port] ?? percent);
            totalDamageTaken[port] = (totalDamageTaken[port] ?? 0) + (damageThisStock[port] ?? 0);
            damageThisStock[port] = 0;
          } else {
            damageThisStock[port] = percent;
          }
          prevStocksTrack[port] = stocks;
          prevPercentsTrack[port] = percent;
        }
      }

    } else if (cmd === 0x37) {
      // PRE_FRAME: count new button presses via Hamming weight — matches slippi-js
      // digitalInputsPerMinute which uses buttonInputCount (new presses only, not joystick/triggers).
      // slpReader: physicalButtons = readUint16(view, 0x31); view[0]=cmd byte, so ps offset = 0x31-1 = 0x30 = 48.
      // Rollback guard: skip frames already processed (frame# <= max seen) to avoid double-counting.
      if (size >= 50) {
        const port = data[ps + 4];
        const isFollower = data[ps + 5];
        if (!isFollower && port <= 3) {
          const pf = view.getInt32(ps, false);
          if (pf > (maxPreFrame[port] ?? -Infinity)) {
            maxPreFrame[port] = pf;
            const btns = view.getUint16(ps + 48, false);
            if (prevButtons[port] !== undefined) {
              inputCounts[port] = (inputCounts[port] ?? 0) + countSetBits((~prevButtons[port] & btns) & 0xfff);
            }
            prevButtons[port] = btns;
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

  // Bank any residual damage on the stock the port was still alive on when the
  // game ended (timeout / LRAS on a fresh stock yields 0, which is a no-op).
  for (const port of Object.keys(damageThisStock).map(Number)) {
    totalDamageTaken[port] = (totalDamageTaken[port] ?? 0) + (damageThisStock[port] ?? 0);
  }

  return { matchId, stageId, gameEndMethod, lrasInitiator, finalStocks, totalDamageTaken, durationFrames, actionFrames, frameData, lCancelSuccesses, lCancelAttempts, stockPercents, inputCounts, defensiveOptions };
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
    playerPort, oppPort, stream.frameData, stream.totalDamageTaken, stream.finalStocks
  );
  const winLoss: "win" | "loss" = (result === "win" || result === "lras_win") ? "win" : "loss";
  const advStats = computeAdvancedStats(playerPort, oppPort, stream.frameData, winLoss);

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
    counter_hit_rate:   convStats.counter_hit_rate,
    opening_conversion_rate: convStats.opening_conversion_rate,
    inputs_per_minute: (() => {
      const inputs = stream.inputCounts[playerPort] ?? 0;
      const mins   = stream.durationFrames / 3600;
      return mins > 0 ? Math.round(inputs / mins) : null;
    })(),
    l_cancel_ratio: (() => {
      const attempts  = stream.lCancelAttempts[playerPort]  ?? 0;
      const successes = stream.lCancelSuccesses[playerPort] ?? 0;
      return attempts > 0 ? successes / attempts : null;
    })(),
    avg_kill_percent: (() => {
      const percents = stream.stockPercents[oppPort] ?? [];
      return percents.length > 0 ? percents.reduce((a, b) => a + b, 0) / percents.length : null;
    })(),
    avg_death_percent: (() => {
      const percents = stream.stockPercents[playerPort] ?? [];
      return percents.length > 0 ? percents.reduce((a, b) => a + b, 0) / percents.length : null;
    })(),
    defensive_option_rate: (() => {
      const opts = stream.defensiveOptions[playerPort] ?? 0;
      const mins = stream.durationFrames / 3600;
      return mins > 0 ? opts / mins : null;
    })(),
    stage_control_ratio:    advStats.stage_control_ratio,
    lead_maintenance_rate:  advStats.lead_maintenance_rate,
    tech_chase_rate:        advStats.tech_chase_rate,
    edgeguard_success_rate: advStats.edgeguard_success_rate,
    hit_advantage_rate:     advStats.hit_advantage_rate,
    recovery_success_rate:  advStats.recovery_success_rate,
    avg_stock_duration:     advStats.avg_stock_duration,
    respawn_defense_rate:   advStats.respawn_defense_rate,
    comeback_rate:          advStats.comeback_rate,
    wavedash_miss_rate:     advStats.wavedash_miss_rate,
  }];
}
