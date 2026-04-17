/**
 * bulk_ocr_compare.cjs — run with: node scripts/bulk_ocr_compare.cjs
 *
 * Scans all .slp files in the replay directory, runs both slippi-js (ground
 * truth) and our frame-based parser on each game, then reports OCR accuracy
 * statistics across the full sample.
 *
 * Only games where JOEY#870 is present, result is unambiguous (METHOD_GAME=2),
 * and both parsers produce a non-null OCR are included.
 */

'use strict';
process.env.NODE_ENV = 'production';

const fs   = require('fs');
const path = require('path');
const { SlippiGame } = require('@slippi/slippi-js');

const CONNECT_CODE = 'JOEY#870';
const REPLAY_DIR   = 'C:/Slippi Replays/Recent';

// ── Action-state helpers (port of slp_parser.ts) ───────────────────────────

function isInControl(s) {
  return (s >= 14 && s <= 24) || (s >= 39 && s <= 41) || (s > 44 && s <= 64) || s === 212;
}
function isInStun(s) {
  return (s >= 75 && s <= 91) || s === 38 || s === 185 || s === 193
      || (s >= 223 && s <= 232)
      || (((s >= 266 && s <= 304) || (s >= 327 && s <= 338)) && s !== 293);
}
function countSetBits(x) { let b = x, c = 0; while (b) { b &= b-1; c++; } return c; }

// ── UBJSON parser ──────────────────────────────────────────────────────────

function parseUbjson(buf, startPos) {
  const data = new Uint8Array(buf);
  const view = new DataView(buf);
  let pos = startPos;
  function readLen() {
    const m = String.fromCharCode(data[pos++]);
    if (m==='i') { const v=view.getInt8(pos);     pos+=1; return v; }
    if (m==='U') { return data[pos++]; }
    if (m==='I') { const v=view.getInt16(pos,false); pos+=2; return v; }
    if (m==='l') { const v=view.getInt32(pos,false); pos+=4; return v; }
    throw new Error('bad length: '+m);
  }
  function parse() {
    const m = String.fromCharCode(data[pos++]);
    if (m==='{') {
      const o={};
      while (String.fromCharCode(data[pos])!=='}') {
        const kl=readLen(), k=Buffer.from(buf,pos,kl).toString('utf8'); pos+=kl; o[k]=parse();
      }
      pos++; return o;
    }
    if (m==='[') { const a=[]; while (String.fromCharCode(data[pos])!==']') a.push(parse()); pos++; return a; }
    if (m==='S') { const l=readLen(), s=Buffer.from(buf,pos,l).toString('utf8'); pos+=l; return s; }
    if (m==='i') { const v=view.getInt8(pos);      pos+=1; return v; }
    if (m==='U') { return data[pos++]; }
    if (m==='I') { const v=view.getInt16(pos,false);  pos+=2; return v; }
    if (m==='l') { const v=view.getInt32(pos,false);  pos+=4; return v; }
    if (m==='d') { const v=view.getFloat32(pos,false); pos+=4; return v; }
    if (m==='D') { const v=view.getFloat64(pos,false); pos+=8; return v; }
    if (m==='T') return true; if (m==='F') return false; if (m==='Z') return null;
    throw new Error('unknown type: '+m);
  }
  return [parse(), pos];
}

// ── Our OCR (frame-based parser) ───────────────────────────────────────────

function ourOCR(filepath, connectCode) {
  let nodeBuf;
  try { nodeBuf = fs.readFileSync(filepath.replace(/\//g,'\\')); } catch { return null; }
  const buf  = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
  const data = new Uint8Array(buf);
  const view = new DataView(buf);

  // mode string check
  let hasMode = false;
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i]===109&&data[i+1]===111&&data[i+2]===100&&data[i+3]===101&&data[i+4]===46) { hasMode=true; break; }
  }
  if (!hasMode) return null;

  const evStart = 15;
  const rawLen  = view.getInt32(11, false);
  const evEnd   = evStart + rawLen;
  if (data[evStart] !== 0x35) return null;
  const epSize = data[evStart+1];
  const payloadSizes = {};
  for (let i=0; i<Math.floor((epSize-1)/3); i++) {
    const off = evStart+2+i*3;
    payloadSizes[data[off]] = view.getUint16(off+1, false);
  }

  let pos = evStart+1+epSize;
  let gameEndMethod=-1, lrasInitiator=-1;
  const finalStocks={}, frameData={}, prevActionState={}, maxPreFrame={};
  const prevButtons={}, inputCounts={};

  while (pos < evEnd) {
    const cmd=data[pos], size=payloadSizes[cmd];
    if (size===undefined) { pos++; continue; }
    const ps=pos+1;
    if (cmd===0x38 && size>=33) {
      const port=data[ps+4], isF=data[ps+5];
      if (!isF && port<=3) {
        const frameNum=view.getInt32(ps,false), state=view.getUint16(ps+7,false);
        const stocks=data[ps+32], percent=view.getFloat32(ps+21,false);
        finalStocks[port]=stocks;
        if (!frameData[port]) frameData[port]=[];
        frameData[port].push({frame:frameNum,state,percent,stocks});
        prevActionState[port]=state;
      }
    } else if (cmd===0x39 && size>=2) {
      gameEndMethod=data[ps]; lrasInitiator=view.getInt8(ps+1);
    }
    pos+=1+size;
  }

  if (gameEndMethod!==2) return null;

  // Metadata
  const rawLen2=view.getInt32(11,false);
  const metaStart=15+rawLen2+10;
  let meta={};
  try { [meta]=parseUbjson(buf.slice(metaStart,buf.byteLength-1),0); } catch {}

  const players={};
  if (meta&&meta.players) {
    for (const [portStr,pd] of Object.entries(meta.players)) {
      const port=parseInt(portStr,10);
      const chars=pd.characters;
      let charId=null;
      if (chars&&Object.keys(chars).length>0) {
        const best=Object.entries(chars).reduce((a,b)=>b[1]>a[1]?b:a);
        charId=parseInt(best[0],10);
      }
      players[port]={connectCode:pd.names?.code??'',charId};
    }
  }

  const cc=connectCode.toUpperCase();
  const ports=Object.keys(players).map(Number);
  const playerPort=ports.find(p=>players[p].connectCode.toUpperCase()===cc);
  if (playerPort===undefined) return null;
  const oppPort=ports.find(p=>p!==playerPort);
  if (oppPort===undefined) return null;

  const ps2=finalStocks[playerPort]??-1, os=finalStocks[oppPort]??-1;
  if (ps2===os) return null;

  // Deduplicate frames
  for (const port of Object.keys(frameData).map(Number)) {
    const seen=new Map();
    for (const snap of frameData[port]) seen.set(snap.frame,snap);
    frameData[port]=Array.from(seen.values()).sort((a,b)=>a.frame-b.frame);
  }

  const playerFrames=frameData[playerPort]??[];
  const oppMap=new Map();
  for (const snap of frameData[oppPort]??[]) oppMap.set(snap.frame,snap);

  const RESET=45;
  let pConvActive=false, pResetCtr=0, pConvCount=0;
  let oConvActive=false, oResetCtr=0;
  let openingConvCount=0, convHitCount=0, convLastOppPct=-1;
  let prevOppStocks=-1, prevPlayerStocks=-1, prevOppStun=false;

  for (const snap of playerFrames) {
    const opp=oppMap.get(snap.frame);
    if (!opp) continue;

    if (prevOppStocks>=0 && opp.stocks<prevOppStocks && pConvActive) {
      if (convHitCount>=2) openingConvCount++;
      pConvActive=false; pResetCtr=0; convHitCount=0; convLastOppPct=-1;
    }
    if (prevPlayerStocks>=0 && snap.stocks<prevPlayerStocks && oConvActive) {
      oConvActive=false; oResetCtr=0;
    }
    prevOppStocks=opp.stocks; prevPlayerStocks=snap.stocks;

    const oppStun=isInStun(opp.state), oppCtrl=isInControl(opp.state);
    const playerStun=isInStun(snap.state), playerCtrl=isInControl(snap.state);

    if (oppStun) {
      if (!pConvActive) {
        pConvActive=true; pConvCount++; convHitCount=1; convLastOppPct=opp.percent;
        if (!oConvActive) {} // neutral win tracking omitted — not needed here
      } else if (!prevOppStun) {
        convHitCount++; convLastOppPct=opp.percent;
      } else if (opp.percent > convLastOppPct+0.5) {
        convHitCount++; convLastOppPct=opp.percent;
      }
      pResetCtr=0;
    } else if (pConvActive) {
      if (oppCtrl||pResetCtr>0) {
        pResetCtr++;
        if (pResetCtr>RESET) {
          if (convHitCount>=2) openingConvCount++;
          pConvActive=false; pResetCtr=0; convHitCount=0; convLastOppPct=-1;
        }
      }
    }

    if (playerStun) {
      if (!oConvActive) { oConvActive=true; }
      oResetCtr=0;
    } else if (oConvActive) {
      if (playerCtrl||oResetCtr>0) { oResetCtr++; if (oResetCtr>RESET) { oConvActive=false; oResetCtr=0; } }
    }

    prevOppStun=oppStun;
  }
  if (pConvActive && convHitCount>=2) openingConvCount++;

  return pConvCount>0 ? openingConvCount/pConvCount : null;
}

// ── slippi-js OCR ──────────────────────────────────────────────────────────

function slippiOCR(filepath, connectCode) {
  let game;
  try { game=new SlippiGame(filepath.replace(/\//g,'\\')); } catch { return null; }
  const settings=game.getSettings();
  if (!settings) return null;
  const cc=connectCode.toUpperCase();
  const playerIdx=settings.players.findIndex(p=>p&&p.connectCode&&p.connectCode.toUpperCase()===cc);
  if (playerIdx===-1) return null;
  const stats=game.getStats();
  const overall=stats&&stats.overall?stats.overall:[];
  const pO=overall.find(o=>o.playerIndex===playerIdx);
  return pO&&pO.successfulConversions ? pO.successfulConversions.ratio : null;
}

// ── Main ───────────────────────────────────────────────────────────────────

const cc = CONNECT_CODE.toUpperCase();
const files = fs.readdirSync(REPLAY_DIR)
  .filter(f=>f.endsWith('.slp'))
  .map(f=>path.join(REPLAY_DIR,f));

console.log(`Scanning ${files.length} replays...`);

const diffs=[], skipped={noPlayer:0, nullOCR:0, notGame:0, error:0};
let processed=0;

for (const fp of files) {
  try {
    const theirs = slippiOCR(fp, cc);
    if (theirs===null) { skipped.nullOCR++; continue; }

    const ours = ourOCR(fp, cc);
    if (ours===null) { skipped.nullOCR++; continue; }

    diffs.push({ file: path.basename(fp), ours, theirs, diff: ours-theirs });
    processed++;
  } catch {
    skipped.error++;
  }
}

console.log(`\nProcessed: ${processed} games  |  Skipped: ${JSON.stringify(skipped)}`);
console.log('');

if (diffs.length===0) { console.log('No comparable games found.'); process.exit(0); }

const absDiffs = diffs.map(d=>Math.abs(d.diff)*100);
const rawDiffs  = diffs.map(d=>d.diff*100);

const avg  = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
const pct  = v => v.toFixed(1)+'%';

const avgAbs = avg(absDiffs);
const maxAbs = Math.max(...absDiffs);
const maxPos = Math.max(...rawDiffs);   // our biggest overcount
const maxNeg = Math.min(...rawDiffs);   // our biggest undercount (most negative)

const exact  = absDiffs.filter(d=>d<0.15).length;  // within 0.15% = rounding only
const within1 = absDiffs.filter(d=>d<=1.0).length;
const within3 = absDiffs.filter(d=>d<=3.0).length;
const within5 = absDiffs.filter(d=>d<=5.0).length;
const over5   = absDiffs.filter(d=>d>5.0).length;

console.log('='.repeat(60));
console.log('OCR ACCURACY SUMMARY  (our parser vs slippi-js)');
console.log('='.repeat(60));
console.log(`  Games compared:     ${processed}`);
console.log(`  Exact (±0.15%):     ${exact}  (${(exact/processed*100).toFixed(1)}%)`);
console.log(`  Within 1%:          ${within1}  (${(within1/processed*100).toFixed(1)}%)`);
console.log(`  Within 3%:          ${within3}  (${(within3/processed*100).toFixed(1)}%)`);
console.log(`  Within 5%:          ${within5}  (${(within5/processed*100).toFixed(1)}%)`);
console.log(`  >5% gap:            ${over5}  (${(over5/processed*100).toFixed(1)}%)`);
console.log('');
console.log(`  Avg absolute gap:   ${pct(avgAbs)}`);
console.log(`  Max overcount:      +${pct(maxPos)}  (ours > slippi-js)`);
console.log(`  Max undercount:     ${pct(maxNeg)}  (ours < slippi-js)`);

// Distribution of raw diffs
const buckets = {
  'ours > +5%':   rawDiffs.filter(d=>d>5).length,
  '+1% to +5%':   rawDiffs.filter(d=>d>1&&d<=5).length,
  '±1% (close)':  rawDiffs.filter(d=>Math.abs(d)<=1).length,
  '-1% to -5%':   rawDiffs.filter(d=>d<-1&&d>=-5).length,
  'ours < -5%':   rawDiffs.filter(d=>d<-5).length,
};
console.log('\n  Distribution (ours − slippi-js):');
for (const [label, count] of Object.entries(buckets)) {
  const bar='█'.repeat(Math.round(count/processed*40));
  console.log(`    ${label.padEnd(16)} ${count.toString().padStart(4)}  ${bar}`);
}

// Top 10 outliers both directions
const sorted = [...diffs].sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));
console.log('\n  Top 10 largest gaps:');
console.log('  '+('File').padEnd(32)+' slippi-js'.padStart(10)+' ours'.padStart(8)+' diff'.padStart(8));
for (const d of sorted.slice(0,10)) {
  const sign=d.diff>0?'+':'';
  console.log('  '+d.file.padEnd(32)+(d.theirs*100).toFixed(1).padStart(9)+'%'+(d.ours*100).toFixed(1).padStart(7)+'%'+(sign+(d.diff*100).toFixed(1)+'%').padStart(8));
}
