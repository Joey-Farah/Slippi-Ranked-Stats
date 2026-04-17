/**
 * our_stats.cjs
 * Port of the key parts of src/lib/slp_parser.ts to plain JS.
 * Run: node scripts/our_stats.cjs
 * Prints the same stats our app computes so we can diff against compare_stats.cjs output.
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

// ── Action state helpers (mirrors slp_parser.ts exactly) ───────────────────

function isInControl(s) {
  return (s >= 14 && s <= 24) || (s >= 39 && s <= 41) || (s > 44 && s <= 64) || s === 212;
}

function isInStun(s) {
  return (s >= 75 && s <= 91) || s === 38 || s === 185 || s === 193
      || (s >= 223 && s <= 232)
      || (((s >= 266 && s <= 304) || (s >= 327 && s <= 338)) && s !== 293);
}

// Hamming weight — count set bits (matches slippi-js countSetBits)
function countSetBits(x) {
  let bits = x;
  let count = 0;
  while (bits) { bits &= bits - 1; count++; }
  return count;
}

// ── UBJSON parser (minimal, mirrors slp_parser.ts) ─────────────────────────

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

// ── Parser ─────────────────────────────────────────────────────────────────

function parseGame(filepath, connectCode) {
  const nodeBuf = fs.readFileSync(filepath.replace(/\//g, '\\'));
  const buf     = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
  const data    = new Uint8Array(buf);
  const view    = new DataView(buf);

  // Quick "mode." check
  let hasModeStr = false;
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i]===109&&data[i+1]===111&&data[i+2]===100&&data[i+3]===101&&data[i+4]===46) { hasModeStr=true; break; }
  }
  if (!hasModeStr) return null;

  // Event payloads map
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
  const finalStocks = {};
  const totalDameTaken = {};
  const damageThisStock = {};
  const frameData = {};     // port -> [{frame, state, x, y, percent, stocks}]
  const lCancelSucc = {};
  const lCancelAtt  = {};
  const prevButtons = {};
  const inputCounts = {};
  const maxPreFrame = {}; // rollback guard
  const prevStocks  = {};
  const prevPercents = {};
  const stockPercents = {};
  const prevActionState = {}; // for l-cancel isNewAction guard

  while (pos < evEnd) {
    const cmd  = data[pos];
    const size = payloadSizes[cmd];
    if (size === undefined) { pos++; continue; }
    const ps = pos + 1;

    if (cmd === 0x36) { // GAME_START
      if (size >= 20) stageId = data[ps + 19];
      for (let i = ps; i < ps + size - 4; i++) {
        if (data[i]===109&&data[i+1]===111&&data[i+2]===100&&data[i+3]===101&&data[i+4]===46) {
          let end = i;
          while (end < i+60 && end < ps+size && data[end]!==0) end++;
          matchId = Buffer.from(buf, i, end-i).toString('utf8');
          break;
        }
      }
    } else if (cmd === 0x38) { // POST_FRAME
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

          // L-cancel: count once per new aerial-attack action (matches slippi-js isNewAction).
          // States 65-74 = aerial attacks (65-69) + landing-lag states (70-74).
          // l_cancel_status is set on the first frame of the landing-lag transition.
          // slpReader: lCancelStatus = readUint8(view, 0x33); view[0]=cmd, so ps offset = 0x32 = 50.
          if (size >= 51 && state >= 65 && state <= 74
              && state !== (prevActionState[port] ?? -1)) {
            const lc = data[ps + 50];
            if (lc === 1) {
              lCancelSucc[port] = (lCancelSucc[port] || 0) + 1;
              lCancelAtt[port]  = (lCancelAtt[port]  || 0) + 1;
            } else if (lc === 2) {
              lCancelAtt[port] = (lCancelAtt[port] || 0) + 1;
            }
          }
          prevActionState[port] = state;

          // Damage tracking
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
    } else if (cmd === 0x37) { // PRE_FRAME: new button presses via Hamming weight
      // slpReader: physicalButtons = readUint16(view, 0x31); view[0]=cmd, so ps offset = 0x30 = 48.
      // Rollback guard: skip frames already processed.
      if (size >= 50) {
        const port = data[ps + 4];
        const isF  = data[ps + 5];
        if (!isF && port <= 3) {
          const pf = view.getInt32(ps, false);
          if (pf > (maxPreFrame[port] ?? -Infinity)) {
            maxPreFrame[port] = pf;
            const btns = view.getUint16(ps + 48, false);
            if (prevButtons[port] !== undefined) {
              inputCounts[port] = (inputCounts[port] || 0) + countSetBits((~prevButtons[port] & btns) & 0xfff);
            }
            prevButtons[port] = btns;
          }
        }
      }
    } else if (cmd === 0x39) { // GAME_END
      if (size >= 2) { gameEndMethod = data[ps]; lrasInitiator = view.getInt8(ps + 1); }
    }

    pos += 1 + size;
  }

  // Bank residual damage
  for (const port of Object.keys(damageThisStock).map(Number)) {
    totalDameTaken[port] = (totalDameTaken[port] || 0) + (damageThisStock[port] || 0);
  }

  // De-duplicate frameData: keep last occurrence of each frame number (handles rollback).
  // Mirrors slippi-js frames Map behavior where rollback events overwrite earlier ones.
  for (const port of Object.keys(frameData).map(Number)) {
    const seen = new Map();
    for (const snap of frameData[port]) seen.set(snap.frame, snap);
    frameData[port] = Array.from(seen.values()).sort((a, b) => a.frame - b.frame);
  }

  const rawLen2 = view.getInt32(11, false);
  const metaStart = 15 + rawLen2 + 10;
  let meta = {};
  try {
    const metaSlice = buf.slice(metaStart, buf.byteLength - 1);
    [meta] = parseUbjson(metaSlice, 0);
  } catch(_) {}

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
    const ps2 = finalStocks[playerPort] ?? -1;
    const os  = finalStocks[oppPort]    ?? -1;
    if (ps2 > os) result = 'win';
    else if (ps2 < os) result = 'loss';
    else return null;
  } else { return null; }

  const kills  = 4 - (finalStocks[oppPort]    || 0);
  const deaths = 4 - (finalStocks[playerPort] || 0);

  // Conversion stats with neutral-win classification (mirrors slp_parser.ts)
  const playerFrames = frameData[playerPort] ?? [];
  const oppMap = new Map();
  for (const snap of frameData[oppPort] ?? []) oppMap.set(snap.frame, snap);

  const RESET = 45;
  let playerConvActive=false, playerResetCtr=0, playerConvCount=0, playerNeutralWins=0;
  let openingConvCount=0, convStartPct=-1, convStartStocks=-1;
  let oppConvActive=false, oppResetCtr=0, oppConvCount=0, oppNeutralWins=0;
  let prevOppStocks=-1, prevPlayerStocks=-1;

  for (const snap of playerFrames) {
    const opp = oppMap.get(snap.frame);
    if (!opp) continue;

    // Terminate conversions immediately on stock loss (matches slippi-js).
    if (prevOppStocks >= 0 && opp.stocks < prevOppStocks && playerConvActive) {
      if (opp.percent - convStartPct >= 20 || convStartStocks > opp.stocks) openingConvCount++;
      playerConvActive=false; playerResetCtr=0; convStartPct=-1; convStartStocks=-1;
    }
    if (prevPlayerStocks >= 0 && snap.stocks < prevPlayerStocks && oppConvActive) {
      oppConvActive=false; oppResetCtr=0;
    }
    prevOppStocks    = opp.stocks;
    prevPlayerStocks = snap.stocks;

    const oppStun    = isInStun(opp.state);
    const oppCtrl    = isInControl(opp.state);
    const playerStun = isInStun(snap.state);
    const playerCtrl = isInControl(snap.state);

    if (oppStun) {
      if (!playerConvActive) {
        playerConvActive = true;
        playerConvCount++;
        if (!oppConvActive) playerNeutralWins++;
        convStartPct = opp.percent;
        convStartStocks = opp.stocks;
      }
      playerResetCtr = 0;
    } else if (playerConvActive) {
      if (oppCtrl || playerResetCtr > 0) {
        playerResetCtr++;
        if (playerResetCtr > RESET) {
          if (opp.percent - convStartPct >= 20 || opp.stocks < convStartStocks) openingConvCount++;
          playerConvActive=false; playerResetCtr=0; convStartPct=-1; convStartStocks=-1;
        }
      }
    }

    if (playerStun) {
      if (!oppConvActive) {
        oppConvActive = true;
        oppConvCount++;
        if (!playerConvActive) oppNeutralWins++;
      }
      oppResetCtr = 0;
    } else if (oppConvActive) {
      if (playerCtrl || oppResetCtr > 0) {
        oppResetCtr++;
        if (oppResetCtr > RESET) { oppConvActive=false; oppResetCtr=0; }
      }
    }
  }
  if (playerConvActive) openingConvCount++;

  const nwTotal  = playerNeutralWins + oppNeutralWins;
  const dmgDealt = totalDameTaken[oppPort] ?? 0;
  const durationFrames = (frameData[playerPort] ?? []).reduce((mx,s) => s.frame > mx ? s.frame : mx, 0);
  const durationMins   = durationFrames / 3600;

  const lc_att  = lCancelAtt[playerPort]  || 0;
  const lc_succ = lCancelSucc[playerPort] || 0;

  const oppKillPcts = (stockPercents[oppPort] || []).filter(p => p > 0);

  return {
    file: filepath.split('/').pop(),
    result,
    kills,
    deaths,
    opk:      kills > 0             ? playerConvCount   / kills             : null,
    dpo:      playerConvCount > 0   ? dmgDealt          / playerConvCount   : null,
    nwr:      nwTotal > 0           ? playerNeutralWins / nwTotal           : null,
    ocr:      playerConvCount > 0   ? openingConvCount  / playerConvCount   : null,
    lc:       lc_att > 0            ? lc_succ           / lc_att            : null,
    ipm:      durationMins > 0      ? (inputCounts[playerPort] || 0) / durationMins : null,
    avgKillPct: oppKillPcts.length > 0 ? oppKillPcts.reduce((a,b)=>a+b,0)/oppKillPcts.length : null,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

const cc = CONNECT_CODE.toUpperCase();
function pct(v)  { return v != null ? (v*100).toFixed(1)+'%' : '—'; }
function n2(v)   { return v != null ? v.toFixed(2) : '—'; }
function n1(v)   { return v != null ? v.toFixed(1) : '—'; }

for (const set of SETS) {
  console.log('\n' + '='.repeat(76));
  console.log(set.label + '  [OUR PARSER]');
  console.log('='.repeat(76));
  console.log(
    'File'.padEnd(36), 'OPK'.padStart(5), 'D/O'.padStart(6),
    'NWR%'.padStart(6), 'L-C%'.padStart(6), 'IPM'.padStart(5), 'AvgKill%'.padStart(9), 'Kills'.padStart(6),
  );
  console.log('-'.repeat(76));

  const rows = [];
  for (const fp of set.files) {
    let r;
    try { r = parseGame(fp, cc); } catch(e) { console.log(fp.split('/').pop().padEnd(36), 'ERROR:', e.message); continue; }
    if (!r) { console.log(fp.split('/').pop().padEnd(36), 'skipped'); continue; }
    rows.push(r);
    console.log(
      r.file.padEnd(36),
      n2(r.opk).padStart(5),
      n1(r.dpo).padStart(6),
      pct(r.nwr).padStart(6),
      pct(r.lc).padStart(6),
      (r.ipm != null ? Math.round(r.ipm).toString() : '—').padStart(5),
      (r.avgKillPct != null ? r.avgKillPct.toFixed(0)+'%' : '—').padStart(9),
      r.kills.toString().padStart(6),
    );
  }

  if (rows.length > 1) {
    const avg = key => { const vs=rows.map(r=>r[key]).filter(v=>v!=null); return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : null; };
    console.log('-'.repeat(76));
    console.log(
      'SET AVG'.padEnd(36),
      n2(avg('opk')).padStart(5),
      n1(avg('dpo')).padStart(6),
      pct(avg('nwr')).padStart(6),
      pct(avg('lc')).padStart(6),
      (avg('ipm')!=null ? Math.round(avg('ipm')).toString() : '—').padStart(5),
      (avg('avgKillPct')!=null ? avg('avgKillPct').toFixed(0)+'%' : '—').padStart(9),
    );
  }
}
