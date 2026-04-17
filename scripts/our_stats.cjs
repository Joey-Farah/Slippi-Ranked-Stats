/**
 * our_stats.cjs — port of slp_parser.ts for comparison testing.
 * Run: node scripts/our_stats.cjs
 * Prints all 18 graded stats so we can verify them against slippi-js
 * (for stats slippi-js also computes) and sanity-check the custom ones.
 */
'use strict';
const fs = require('fs');

const CONNECT_CODE = 'JOEY#870';

const SETS = [
  { label: 'vs LAX#116',  files: ['C:/Slippi Replays/Recent/Game_20260407T180736.slp','C:/Slippi Replays/Recent/Game_20260407T180916.slp'] },
  { label: 'vs ALOE#731', files: ['C:/Slippi Replays/Recent/Game_20260407T180138.slp','C:/Slippi Replays/Recent/Game_20260407T180422.slp'] },
  { label: 'vs BERI#229', files: ['C:/Slippi Replays/Recent/Game_20260407T175116.slp','C:/Slippi Replays/Recent/Game_20260407T175414.slp','C:/Slippi Replays/Recent/Game_20260407T175816.slp'] },
  { label: 'vs JCHU#536', files: ['C:/Slippi Replays/Recent/Game_20260407T174052.slp','C:/Slippi Replays/Recent/Game_20260407T174418.slp','C:/Slippi Replays/Recent/Game_20260407T174706.slp'] },
  { label: 'vs EL#900',   files: ['C:/Slippi Replays/Recent/Game_20260407T173423.slp','C:/Slippi Replays/Recent/Game_20260407T173715.slp'] },
];

// ── Action state helpers ───────────────────────────────────────────────────

function isInControl(s) {
  return (s >= 14 && s <= 24) || (s >= 39 && s <= 41) || (s > 44 && s <= 64) || s === 212;
}
function isInStun(s) {
  return (s >= 75 && s <= 91) || s === 38 || s === 185 || s === 193
      || (s >= 223 && s <= 232)
      || (((s >= 266 && s <= 304) || (s >= 327 && s <= 338)) && s !== 293);
}
function isVulnerable(s) {
  return (s >= 0 && s <= 10) || (s >= 75 && s <= 91) || (s >= 183 && s <= 198)
      || (s >= 199 && s <= 204) || (s >= 223 && s <= 232);
}
function isAttacking(s) {
  return (s >= 44 && s <= 74) || s === 0xB0 || s === 0xB1 || s === 0xB2;
}
function isKnockdown(s) {
  return s >= 183 && s <= 204;
}

// Correct IDs from slippi-js common.esm.js (previously wrong: {29,30,31} = fall states)
const DEFENSIVE_STATES_SET = new Set([233, 234, 235]);

function countSetBits(x) {
  let bits = x, count = 0;
  while (bits) { bits &= bits - 1; count++; }
  return count;
}

// ── UBJSON parser ──────────────────────────────────────────────────────────

function parseUbjson(buf, startPos) {
  const data = new Uint8Array(buf);
  const view = new DataView(buf);
  let pos = startPos;
  function readLength() {
    const m = String.fromCharCode(data[pos++]);
    if (m === 'i') { const v = view.getInt8(pos); pos += 1; return v; }
    if (m === 'U') { return data[pos++]; }
    if (m === 'I') { const v = view.getInt16(pos, false); pos += 2; return v; }
    if (m === 'l') { const v = view.getInt32(pos, false); pos += 4; return v; }
    throw new Error('bad length marker: ' + m);
  }
  function parse() {
    const m = String.fromCharCode(data[pos++]);
    if (m === '{') {
      const obj = {};
      while (String.fromCharCode(data[pos]) !== '}') {
        const keyLen = readLength();
        const key = Buffer.from(buf, pos, keyLen).toString('utf8');
        pos += keyLen;
        obj[key] = parse();
      }
      pos++; return obj;
    }
    if (m === '[') {
      const arr = [];
      while (String.fromCharCode(data[pos]) !== ']') arr.push(parse());
      pos++; return arr;
    }
    if (m === 'S') { const len = readLength(); const s = Buffer.from(buf, pos, len).toString('utf8'); pos += len; return s; }
    if (m === 'i') { const v = view.getInt8(pos);   pos += 1; return v; }
    if (m === 'U') { return data[pos++]; }
    if (m === 'I') { const v = view.getInt16(pos, false); pos += 2; return v; }
    if (m === 'l') { const v = view.getInt32(pos, false); pos += 4; return v; }
    if (m === 'd') { const v = view.getFloat32(pos, false); pos += 4; return v; }
    if (m === 'D') { const v = view.getFloat64(pos, false); pos += 8; return v; }
    if (m === 'T') return true;
    if (m === 'F') return false;
    if (m === 'Z') return null;
    throw new Error('unknown UBJSON type: ' + m);
  }
  return [parse(), pos];
}

// ── Advanced stats (port of computeAdvancedStats from slp_parser.ts) ──────

function computeAdvancedStats(playerFrames, oppByFrame, result) {
  if (playerFrames.length === 0) return null;

  const OFFSTAGE_Y = -5, RETURN_Y = 5;
  const EG_WINDOW = 180, TC_WINDOW = 45, TC_HIT_DMG = 3, RESPAWN_WINDOW = 150;
  // Correct wavedash state IDs (previously: AIRDODGE=235 spot-dodge, WD_LAND=189 knockdown state)
  const JUMP_STATES = new Set([24, 25]); // JumpSquat, JumpF
  const AIRDODGE    = 236; // EscapeAir (AIR_DODGE in slippi-js)
  const WD_LAND     = 43;  // LandingFallSpecial
  const WD_JUMP_Y = 5, WD_DODGE_F = 4, WD_LAND_F = 4;

  let centerFrames = 0, onStageFrames = 0;
  let techSit = 0, techHit = 0, tcFrame = -1, tcPct = -1, prevOppKD = false;
  let egSit = 0, egSuccess = 0, egFrame = -1, egStocks = -1, prevOppY = 999;
  let recSit = 0, recSuccess = 0, recFrame = -1, recStocks = -1, prevPY = 999;
  let hitOpps = 0, hitFollowups = 0, hitWindowEnd = -1, prevOppVuln = false;
  const stockDurations = [];
  let stockStart = playerFrames[0].frame, prevPStocks = playerFrames[0].stocks;
  let respawnSit = 0, respawnSuccess = 0, respawnEnd = -1, respawnPct = -1;
  let prevOppStocksR = -1;
  let wasEverDown = false, wasEverUp = false;
  let wdAttempts = 0, wdSuccesses = 0, jumpFrame = -1, dodgeFrame = -1, prevPState = -1;

  for (const snap of playerFrames) {
    const opp = oppByFrame.get(snap.frame);

    if (opp && snap.y > OFFSTAGE_Y && opp.y > OFFSTAGE_Y) {
      onStageFrames++;
      if (Math.abs(snap.x) < Math.abs(opp.x)) centerFrames++;
    }

    if (snap.stocks < prevPStocks) {
      stockDurations.push(snap.frame - stockStart);
      stockStart = snap.frame;
    }
    prevPStocks = snap.stocks;

    if (opp) {
      if (snap.stocks < opp.stocks) wasEverDown = true;
      if (snap.stocks > opp.stocks) wasEverUp   = true;

      const oppVuln = isVulnerable(opp.state);
      if (!prevOppVuln && oppVuln) { hitOpps++; hitWindowEnd = snap.frame + 30; }
      if (hitWindowEnd >= 0) {
        if (snap.frame <= hitWindowEnd && isAttacking(snap.state)) { hitFollowups++; hitWindowEnd = -1; }
        else if (snap.frame > hitWindowEnd)                         {                 hitWindowEnd = -1; }
      }
      prevOppVuln = oppVuln;

      const oppKD = isKnockdown(opp.state);
      if (!prevOppKD && oppKD) { techSit++; tcFrame = snap.frame; tcPct = opp.percent; }
      if (tcFrame >= 0) {
        if (snap.frame > tcFrame + TC_WINDOW)       { tcFrame = -1; }
        else if (opp.percent > tcPct + TC_HIT_DMG)  { techHit++; tcFrame = -1; }
      }
      prevOppKD = oppKD;

      const oppOff = opp.y < OFFSTAGE_Y;
      if (egFrame < 0 && oppOff && prevOppY >= OFFSTAGE_Y) { egSit++; egFrame = snap.frame; egStocks = opp.stocks; }
      if (egFrame >= 0) {
        if (opp.stocks < egStocks)                 { egSuccess++; egFrame = -1; }
        else if (opp.y > RETURN_Y)                 {              egFrame = -1; }
        else if (snap.frame > egFrame + EG_WINDOW) {              egFrame = -1; }
      }
      prevOppY = opp.y;

      if (prevOppStocksR >= 0 && opp.stocks < prevOppStocksR) {
        respawnSit++; respawnEnd = snap.frame + RESPAWN_WINDOW; respawnPct = snap.percent;
      }
      if (respawnEnd >= 0) {
        if (snap.percent > respawnPct + 5)    { respawnEnd = -1; }
        else if (snap.frame > respawnEnd)      { respawnSuccess++; respawnEnd = -1; }
      }
      prevOppStocksR = opp.stocks;
    }

    const pOff = snap.y < OFFSTAGE_Y;
    if (recFrame < 0 && pOff && prevPY >= OFFSTAGE_Y) { recSit++; recFrame = snap.frame; recStocks = snap.stocks; }
    if (recFrame >= 0) {
      if (snap.stocks < recStocks)                { recFrame = -1; }
      else if (snap.y > RETURN_Y)                 { recSuccess++; recFrame = -1; }
      else if (snap.frame > recFrame + EG_WINDOW) { recFrame = -1; }
    }
    prevPY = snap.y;

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

  if (stockDurations.length === 0)
    stockDurations.push(playerFrames.at(-1).frame - playerFrames[0].frame);

  const win = result === 'win';
  return {
    stage_control_ratio:    onStageFrames > 0 ? centerFrames / onStageFrames : null,
    tech_chase_rate:        techSit    > 0 ? techHit    / techSit    : null,
    edgeguard_success_rate: egSit      > 0 ? egSuccess  / egSit      : null,
    recovery_success_rate:  recSit     > 0 ? recSuccess / recSit     : null,
    hit_advantage_rate:     hitOpps    > 0 ? hitFollowups / hitOpps  : null,
    avg_stock_duration:     stockDurations.reduce((a, b) => a + b, 0) / stockDurations.length,
    respawn_defense_rate:   respawnSit > 0 ? respawnSuccess / respawnSit : null,
    comeback_rate:          wasEverDown ? (win ? 1 : 0) : null,
    lead_maintenance_rate:  wasEverUp   ? (win ? 1 : 0) : null,
    wavedash_miss_rate:     wdAttempts > 0 ? (wdAttempts - wdSuccesses) / wdAttempts : null,
    _wdAttempts: wdAttempts, // expose for null-check diagnostics
    _egSit: egSit, _recSit: recSit, _techSit: techSit, _respawnSit: respawnSit,
  };
}

// ── Game parser ────────────────────────────────────────────────────────────

function parseGame(filepath, connectCode) {
  const nodeBuf = fs.readFileSync(filepath.replace(/\//g, '\\'));
  const buf     = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
  const data    = new Uint8Array(buf);
  const view    = new DataView(buf);

  let hasModeStr = false;
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i]===109&&data[i+1]===111&&data[i+2]===100&&data[i+3]===101&&data[i+4]===46) { hasModeStr=true; break; }
  }
  if (!hasModeStr) return null;

  const evStart = 15;
  const rawLen  = view.getInt32(11, false);
  const evEnd   = evStart + rawLen;
  if (data[evStart] !== 0x35) return null;
  const epSize = data[evStart + 1];
  const pairCount = Math.floor((epSize - 1) / 3);
  const payloadSizes = {};
  for (let i = 0; i < pairCount; i++) {
    const off = evStart + 2 + i * 3;
    payloadSizes[data[off]] = view.getUint16(off + 1, false);
  }

  let pos = evStart + 1 + epSize;
  let matchId = '', stageId = -1, gameEndMethod = -1, lrasInitiator = -1;
  const finalStocks = {}, totalDameTaken = {}, damageThisStock = {};
  const frameData = {};
  const lCancelSucc = {}, lCancelAtt = {};
  const prevButtons = {}, inputCounts = {}, maxPreFrame = {};
  const prevStocks = {}, prevPercents = {}, stockPercents = {};
  const prevActionState = {};
  const defensiveOptions = {};

  while (pos < evEnd) {
    const cmd  = data[pos];
    const size = payloadSizes[cmd];
    if (size === undefined) { pos++; continue; }
    const ps = pos + 1;

    if (cmd === 0x36) {
      if (size >= 20) stageId = data[ps + 19];
      for (let i = ps; i < ps + size - 4; i++) {
        if (data[i]===109&&data[i+1]===111&&data[i+2]===100&&data[i+3]===101&&data[i+4]===46) {
          let end = i;
          while (end < i+60 && end < ps+size && data[end]!==0) end++;
          matchId = Buffer.from(buf, i, end-i).toString('utf8');
          break;
        }
      }
    } else if (cmd === 0x38) {
      if (size >= 33) {
        const port = data[ps + 4];
        const isF  = data[ps + 5];
        if (!isF && port <= 3) {
          const frameNum = view.getInt32(ps, false);
          const state    = view.getUint16(ps + 7, false);
          const stocks   = data[ps + 32];
          const percent  = view.getFloat32(ps + 21, false);
          const x        = view.getFloat32(ps + 9,  false);
          const y        = view.getFloat32(ps + 13, false);

          finalStocks[port] = stocks;
          if (!frameData[port]) frameData[port] = [];
          frameData[port].push({ frame: frameNum, state, x, y, percent, stocks });

          // L-cancel (once per new aerial action)
          if (size >= 51 && state >= 65 && state <= 74
              && state !== (prevActionState[port] ?? -1)) {
            const lc = data[ps + 50];
            if (lc === 1) { lCancelSucc[port] = (lCancelSucc[port] || 0) + 1; lCancelAtt[port] = (lCancelAtt[port] || 0) + 1; }
            else if (lc === 2) { lCancelAtt[port] = (lCancelAtt[port] || 0) + 1; }
          }

          // Defensive options (correct IDs: 233=roll fwd, 234=roll bwd, 235=spot dodge)
          if (DEFENSIVE_STATES_SET.has(state) && !DEFENSIVE_STATES_SET.has(prevActionState[port] ?? -1)) {
            defensiveOptions[port] = (defensiveOptions[port] || 0) + 1;
          }
          prevActionState[port] = state;

          // Damage / stock tracking
          if (prevStocks[port] !== undefined && stocks < prevStocks[port]) {
            if (!stockPercents[port]) stockPercents[port] = [];
            stockPercents[port].push(prevPercents[port] ?? percent);
            totalDameTaken[port] = (totalDameTaken[port] || 0) + (damageThisStock[port] || 0);
            damageThisStock[port] = 0;
          } else {
            damageThisStock[port] = percent;
          }
          prevStocks[port]   = stocks;
          prevPercents[port] = percent;
        }
      }
    } else if (cmd === 0x37) {
      if (size >= 50) {
        const port = data[ps + 4];
        const isF  = data[ps + 5];
        if (!isF && port <= 3) {
          const pf = view.getInt32(ps, false);
          if (pf > (maxPreFrame[port] ?? -Infinity)) {
            maxPreFrame[port] = pf;
            const btns = view.getUint16(ps + 48, false);
            if (prevButtons[port] !== undefined)
              inputCounts[port] = (inputCounts[port] || 0) + countSetBits((~prevButtons[port] & btns) & 0xfff);
            prevButtons[port] = btns;
          }
        }
      }
    } else if (cmd === 0x39) {
      if (size >= 2) { gameEndMethod = data[ps]; lrasInitiator = view.getInt8(ps + 1); }
    }
    pos += 1 + size;
  }

  for (const port of Object.keys(damageThisStock).map(Number))
    totalDameTaken[port] = (totalDameTaken[port] || 0) + (damageThisStock[port] || 0);

  // Deduplicate frameData (keep last occurrence per frame number — handles rollback)
  for (const port of Object.keys(frameData).map(Number)) {
    const seen = new Map();
    for (const snap of frameData[port]) seen.set(snap.frame, snap);
    frameData[port] = Array.from(seen.values()).sort((a, b) => a.frame - b.frame);
  }

  // Metadata
  const rawLen2 = view.getInt32(11, false);
  const metaStart = 15 + rawLen2 + 10;
  let meta = {};
  try { const metaSlice = buf.slice(metaStart, buf.byteLength - 1); [meta] = parseUbjson(metaSlice, 0); } catch(_) {}

  const players = {};
  if (meta && meta.players) {
    for (const [portStr, pdata] of Object.entries(meta.players)) {
      const port = parseInt(portStr, 10);
      const chars = pdata.characters;
      let charId = null;
      if (chars && Object.keys(chars).length > 0) {
        const best = Object.entries(chars).reduce((a, b) => b[1] > a[1] ? b : a);
        charId = parseInt(best[0], 10);
      }
      players[port] = { connectCode: pdata.names?.code ?? '', charId };
    }
  }

  const cc = connectCode.toUpperCase();
  const ports = Object.keys(players).map(Number);
  const playerPort = ports.find(p => players[p].connectCode.toUpperCase() === cc);
  if (playerPort === undefined) return null;
  const oppPort = ports.find(p => p !== playerPort);
  if (oppPort === undefined) return null;

  const METHOD_GAME = 2;
  let result;
  if (gameEndMethod === METHOD_GAME) {
    const ps2 = finalStocks[playerPort] ?? -1, os = finalStocks[oppPort] ?? -1;
    if (ps2 > os) result = 'win';
    else if (ps2 < os) result = 'loss';
    else return null;
  } else { return null; }

  const kills  = 4 - (finalStocks[oppPort]    || 0);

  // ── Conversion stats ──────────────────────────────────────────────────────
  const playerFrames = frameData[playerPort] ?? [];
  const oppMap = new Map();
  for (const snap of frameData[oppPort] ?? []) oppMap.set(snap.frame, snap);

  const RESET = 45;
  let playerConvActive=false, playerResetCtr=0, playerConvCount=0, playerNeutralWins=0;
  let openingConvCount=0, convHitCount=0, convStartPct=-1, convStartStocks=-1;
  let oppConvActive=false, oppResetCtr=0, oppConvCount=0, oppNeutralWins=0;
  let prevOppStocks=-1, prevPlayerStocks=-1, prevOppStun=false;

  for (const snap of playerFrames) {
    const opp = oppMap.get(snap.frame);
    if (!opp) continue;

    if (prevOppStocks >= 0 && opp.stocks < prevOppStocks && playerConvActive) {
      if (convHitCount >= 2) openingConvCount++;
      playerConvActive=false; playerResetCtr=0; convStartPct=-1; convStartStocks=-1; convHitCount=0;
    }
    if (prevPlayerStocks >= 0 && snap.stocks < prevPlayerStocks && oppConvActive) {
      oppConvActive=false; oppResetCtr=0;
    }
    prevOppStocks    = opp.stocks;
    prevPlayerStocks = snap.stocks;

    const oppStun=isInStun(opp.state), oppCtrl=isInControl(opp.state);
    const playerStun=isInStun(snap.state), playerCtrl=isInControl(snap.state);

    if (oppStun) {
      if (!playerConvActive) {
        playerConvActive=true; playerConvCount++; convHitCount=1;
        if (!oppConvActive) playerNeutralWins++;
        convStartPct=opp.percent; convStartStocks=opp.stocks;
      } else if (!prevOppStun) {
        convHitCount++;  // opponent re-enters stun = new hit connected
      }
      playerResetCtr=0;
    } else if (playerConvActive) {
      if (oppCtrl || playerResetCtr > 0) {
        playerResetCtr++;
        if (playerResetCtr > RESET) {
          if (convHitCount >= 2) openingConvCount++;
          playerConvActive=false; playerResetCtr=0; convStartPct=-1; convStartStocks=-1; convHitCount=0;
        }
      }
    }
    if (playerStun) {
      if (!oppConvActive) { oppConvActive=true; oppConvCount++; if (!playerConvActive) oppNeutralWins++; }
      oppResetCtr=0;
    } else if (oppConvActive) {
      if (playerCtrl || oppResetCtr > 0) { oppResetCtr++; if (oppResetCtr > RESET) { oppConvActive=false; oppResetCtr=0; } }
    }
    prevOppStun = oppStun;
  }
  if (playerConvActive && convHitCount >= 2) openingConvCount++;

  const nwTotal  = playerNeutralWins + oppNeutralWins;
  const dmgDealt = totalDameTaken[oppPort] ?? 0;
  const durationFrames = playerFrames.reduce((mx,s) => s.frame > mx ? s.frame : mx, 0);
  const durationMins   = durationFrames / 3600;

  const lc_att  = lCancelAtt[playerPort]  || 0;
  const lc_succ = lCancelSucc[playerPort] || 0;
  const oppKillPcts  = (stockPercents[oppPort]    || []).filter(p => p > 0);
  const playerDthPcts = (stockPercents[playerPort] || []).filter(p => p > 0);

  // ── Advanced stats ────────────────────────────────────────────────────────
  const oppByFrame = new Map();
  for (const snap of frameData[oppPort] ?? []) oppByFrame.set(snap.frame, snap);
  const adv = computeAdvancedStats(playerFrames, oppByFrame, result);

  return {
    file: filepath.split('/').pop(),
    result,
    kills,
    // ── Slippi-comparable stats ──
    opk:        kills > 0           ? playerConvCount / kills              : null,
    dpo:        playerConvCount > 0 ? dmgDealt / playerConvCount           : null,
    nwr:        nwTotal > 0         ? playerNeutralWins / nwTotal          : null,
    lc:         lc_att > 0          ? lc_succ / lc_att                     : null,
    ipm:        durationMins > 0    ? (inputCounts[playerPort]||0) / durationMins : null,
    avgKillPct: oppKillPcts.length > 0 ? oppKillPcts.reduce((a,b)=>a+b,0)/oppKillPcts.length : null,
    // ── Custom stats ────────────────────────────────────────────────────────
    ocr:        playerConvCount > 0 ? openingConvCount / playerConvCount   : null,
    avgDeathPct: playerDthPcts.length > 0 ? playerDthPcts.reduce((a,b)=>a+b,0)/playerDthPcts.length : null,
    defRate:    durationMins > 0    ? (defensiveOptions[playerPort]||0) / durationMins : null,
    // From computeAdvancedStats:
    stage_control_ratio:    adv?.stage_control_ratio    ?? null,
    tech_chase_rate:        adv?.tech_chase_rate        ?? null,
    edgeguard_success_rate: adv?.edgeguard_success_rate ?? null,
    recovery_success_rate:  adv?.recovery_success_rate  ?? null,
    hit_advantage_rate:     adv?.hit_advantage_rate     ?? null,
    avg_stock_duration:     adv?.avg_stock_duration     ?? null,
    respawn_defense_rate:   adv?.respawn_defense_rate   ?? null,
    comeback_rate:          adv?.comeback_rate          ?? null,
    lead_maintenance_rate:  adv?.lead_maintenance_rate  ?? null,
    wavedash_miss_rate:     adv?.wavedash_miss_rate     ?? null,
    // Diagnostics for null-checks
    _wdAttempts: adv?._wdAttempts ?? 0,
    _egSit:      adv?._egSit      ?? 0,
    _recSit:     adv?._recSit     ?? 0,
    _techSit:    adv?._techSit    ?? 0,
    _respawnSit: adv?._respawnSit ?? 0,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const cc = CONNECT_CODE.toUpperCase();
const pct = v  => v != null ? (v*100).toFixed(1)+'%' : '—';
const n2  = v  => v != null ? v.toFixed(2) : '—';
const n1  = v  => v != null ? v.toFixed(1) : '—';
const fi  = v  => v != null ? Math.round(v).toString() : '—';
const avg = (rows, key) => { const vs=rows.map(r=>r[key]).filter(v=>v!=null); return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : null; };

// ── Accumulator for range checks ───────────────────────────────────────────

const ALL_ROWS = [];

// ── Main ───────────────────────────────────────────────────────────────────

for (const set of SETS) {
  console.log('\n' + '='.repeat(78));
  console.log(set.label + '  [OUR PARSER]');
  console.log('='.repeat(78));

  // Section 1: slippi-comparable stats (compact table)
  console.log('File'.padEnd(36),'OPK'.padStart(5),'D/O'.padStart(6),'NWR%'.padStart(6),'L-C%'.padStart(6),'IPM'.padStart(5),'Kill%'.padStart(7),'Kills'.padStart(6));
  console.log('-'.repeat(78));

  const rows = [];
  for (const fp of set.files) {
    let r;
    try { r = parseGame(fp, cc); } catch(e) { console.log(fp.split('/').pop().padEnd(36),'ERROR:',e.message); continue; }
    if (!r) { console.log(fp.split('/').pop().padEnd(36),'skipped'); continue; }
    rows.push(r);
    ALL_ROWS.push(r);
    console.log(
      r.file.padEnd(36),
      n2(r.opk).padStart(5), n1(r.dpo).padStart(6), pct(r.nwr).padStart(6),
      pct(r.lc).padStart(6), fi(r.ipm).padStart(5),
      (r.avgKillPct!=null?r.avgKillPct.toFixed(0)+'%':'—').padStart(7),
      r.kills.toString().padStart(6),
    );
  }
  if (rows.length > 1) {
    console.log('-'.repeat(78));
    console.log(
      'SET AVG'.padEnd(36),
      n2(avg(rows,'opk')).padStart(5), n1(avg(rows,'dpo')).padStart(6),
      pct(avg(rows,'nwr')).padStart(6), pct(avg(rows,'lc')).padStart(6),
      fi(avg(rows,'ipm')).padStart(5),
      (avg(rows,'avgKillPct')!=null?avg(rows,'avgKillPct').toFixed(0)+'%':'—').padStart(7),
    );
  }

  // Section 2: custom stats per game
  console.log('\n  Custom stats:');
  const CUSTOM = [
    ['OCR',       r=>pct(r.ocr)],
    ['AvgDeath%', r=>(r.avgDeathPct!=null?r.avgDeathPct.toFixed(0)+'%':'—')],
    ['DefRate/m', r=>(r.defRate!=null?r.defRate.toFixed(1):'—')],
    ['StageCtrl', r=>pct(r.stage_control_ratio)],
    ['TechChase', r=>pct(r.tech_chase_rate)],
    ['Edgeguard', r=>pct(r.edgeguard_success_rate)],
    ['Recovery',  r=>pct(r.recovery_success_rate)],
    ['HitAdv',    r=>pct(r.hit_advantage_rate)],
    ['StockDur',  r=>(r.avg_stock_duration!=null?Math.round(r.avg_stock_duration)+'f':'—')],
    ['RespawnDef',r=>pct(r.respawn_defense_rate)],
    ['WDMiss%',   r=>pct(r.wavedash_miss_rate)],
    ['Comeback',  r=>(r.comeback_rate!=null?(r.comeback_rate>0?'W':'L'):'—')],
    ['LeadMain',  r=>(r.lead_maintenance_rate!=null?(r.lead_maintenance_rate>0?'W':'L'):'—')],
  ];

  const header = '  ' + 'Stat'.padEnd(12) + rows.map(r => r.file.slice(5,21).padStart(18)).join('');
  console.log(header);
  for (const [label, fn] of CUSTOM) {
    console.log('  ' + label.padEnd(12) + rows.map(r => fn(r).padStart(18)).join(''));
  }
  // Situational denominators so we know if null means "no situations arose"
  console.log('  ' + '(situations)'.padEnd(12) + rows.map(r =>
    `eg:${r._egSit} rec:${r._recSit} tc:${r._techSit} rs:${r._respawnSit} wd:${r._wdAttempts}`.padStart(18)
  ).join(''));
}

// ── Range check summary ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(78));
console.log('RANGE CHECK SUMMARY  (' + ALL_ROWS.length + ' games)');
console.log('='.repeat(78));

const RATIO_STATS = [
  'nwr','lc','ocr','stage_control_ratio','tech_chase_rate','edgeguard_success_rate',
  'recovery_success_rate','hit_advantage_rate','respawn_defense_rate','wavedash_miss_rate',
];
const OTHER_STATS = [
  { key:'opk',              min:0,    max:30,   label:'openings_per_kill [>0 is fine]' },
  { key:'dpo',              min:0,    max:300,  label:'damage_per_opening' },
  { key:'ipm',              min:10,   max:800,  label:'inputs_per_minute' },
  { key:'avgKillPct',       min:0,    max:300,  label:'avg_kill_percent' },
  { key:'avgDeathPct',      min:0,    max:300,  label:'avg_death_percent' },
  { key:'defRate',          min:0,    max:60,   label:'defensive_option_rate (per min)' },
  { key:'avg_stock_duration', min:0,  max:1e6,  label:'avg_stock_duration (frames)' },
  { key:'comeback_rate',    min:0,    max:1,    label:'comeback_rate (binary)' },
  { key:'lead_maintenance_rate', min:0, max:1,  label:'lead_maintenance_rate (binary)' },
];

let allGood = true;

for (const key of RATIO_STATS) {
  const vals = ALL_ROWS.map(r => r[key]).filter(v => v != null);
  const outOfRange = vals.filter(v => v < 0 || v > 1);
  const nullCount  = ALL_ROWS.length - vals.length;
  const label = key.length > 22 ? key.slice(0,22) : key;
  const status = outOfRange.length > 0 ? `FAIL out-of-range: ${outOfRange.map(v=>v.toFixed(3)).join(',')}` :
                 vals.length === 0     ? 'WARN always null (no situations?)' :
                 `OK  ${vals.length}/${ALL_ROWS.length} non-null, range [${Math.min(...vals).toFixed(2)}, ${Math.max(...vals).toFixed(2)}]`;
  if (outOfRange.length > 0) allGood = false;
  console.log(`  ${label.padEnd(28)} ${status}`);
}

for (const { key, min, max, label } of OTHER_STATS) {
  const vals = ALL_ROWS.map(r => r[key]).filter(v => v != null);
  const outOfRange = vals.filter(v => v < min || v > max);
  const lbl = (label || key).slice(0, 28).padEnd(28);
  const status = outOfRange.length > 0 ? `FAIL out-of-range: ${outOfRange.map(v=>v.toFixed(1)).join(',')}` :
                 vals.length === 0     ? 'WARN always null' :
                 `OK  ${vals.length}/${ALL_ROWS.length} non-null, range [${Math.min(...vals).toFixed(1)}, ${Math.max(...vals).toFixed(1)}]`;
  if (outOfRange.length > 0) allGood = false;
  console.log(`  ${lbl} ${status}`);
}

// Direction check: win vs loss averages for key custom stats
console.log('\n  Direction check (wins should generally be better):');
const wins  = ALL_ROWS.filter(r => r.result === 'win');
const losses = ALL_ROWS.filter(r => r.result === 'loss');
const DIR_STATS = [
  { key:'stage_control_ratio', higher:'win', label:'StageCtrl' },
  { key:'tech_chase_rate',     higher:'win', label:'TechChase' },
  { key:'edgeguard_success_rate', higher:'win', label:'Edgeguard' },
  { key:'recovery_success_rate',  higher:'win', label:'Recovery' },
  { key:'nwr',                 higher:'win', label:'NWR' },
  { key:'ocr',                 higher:'win', label:'OCR' },
  { key:'avgDeathPct',         higher:'loss', label:'AvgDeath% (lower=better)', raw:true },
];
for (const { key, higher, label, raw } of DIR_STATS) {
  const wAvg = avg(wins, key), lAvg = avg(losses, key);
  if (wAvg == null || lAvg == null) { console.log(`  ${label.padEnd(28)} — (insufficient data)`); continue; }
  const ok = higher === 'win' ? wAvg >= lAvg : wAvg <= lAvg;
  const marker = ok ? '✓' : '?';
  const fmt = raw ? v => v.toFixed(1)+'%' : v => (v*100).toFixed(1)+'%';
  console.log(`  ${label.padEnd(28)} ${marker}  wins=${fmt(wAvg)}  losses=${fmt(lAvg)}`);
}

console.log(allGood ? '\nAll range checks passed.' : '\nSome range checks FAILED — see above.');
