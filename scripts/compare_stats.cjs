/**
 * compare_stats.cjs  — run with: node scripts/compare_stats.cjs
 *
 * Uses @slippi/slippi-js (the library Slippi Launcher uses) to compute the
 * stats we grade on, game by game.  Compare the output against what the app's
 * Grade History shows for the same sets to spot any remaining discrepancies.
 */

'use strict';
process.env.NODE_ENV = 'production';
const { SlippiGame } = require('@slippi/slippi-js');

const CONNECT_CODE = 'JOEY#870';

const SETS = [
  {
    label: 'vs LAX#116 (Apr 7)',
    files: [
      'C:/Slippi Replays/Recent/Game_20260407T180736.slp',
      'C:/Slippi Replays/Recent/Game_20260407T180916.slp',
    ],
  },
  {
    label: 'vs ALOE#731 (Apr 7)',
    files: [
      'C:/Slippi Replays/Recent/Game_20260407T180138.slp',
      'C:/Slippi Replays/Recent/Game_20260407T180422.slp',
    ],
  },
  {
    label: 'vs BERI#229 (Apr 7)',
    files: [
      'C:/Slippi Replays/Recent/Game_20260407T175116.slp',
      'C:/Slippi Replays/Recent/Game_20260407T175414.slp',
      'C:/Slippi Replays/Recent/Game_20260407T175816.slp',
    ],
  },
  {
    label: 'vs JCHU#536 (Apr 7)',
    files: [
      'C:/Slippi Replays/Recent/Game_20260407T174052.slp',
      'C:/Slippi Replays/Recent/Game_20260407T174418.slp',
      'C:/Slippi Replays/Recent/Game_20260407T174706.slp',
    ],
  },
  {
    label: 'vs EL#900 (Apr 7)',
    files: [
      'C:/Slippi Replays/Recent/Game_20260407T173423.slp',
      'C:/Slippi Replays/Recent/Game_20260407T173715.slp',
    ],
  },
];

const cc = CONNECT_CODE.toUpperCase();

function pct(r)  { return r != null ? (r * 100).toFixed(1) + '%' : '—'; }
function n2(r)   { return r != null ? r.toFixed(2) : '—'; }
function n1(r)   { return r != null ? r.toFixed(1) : '—'; }

for (const set of SETS) {
  console.log('\n' + '='.repeat(76));
  console.log(set.label);
  console.log('='.repeat(76));
  console.log(
    'File'.padEnd(36),
    'OPK'.padStart(5),
    'D/O'.padStart(6),
    'NWR%'.padStart(6),
    'OCR%'.padStart(6),
    'L-C%'.padStart(6),
    'DigIPM'.padStart(7),
    'AvgKill%'.padStart(9),
    'Kills'.padStart(6),
  );
  console.log('-'.repeat(82));

  const rowsOPK  = [];
  const rowsDPO  = [];
  const rowsNWR  = [];
  const rowsOCR  = [];
  const rowsLC   = [];
  const rowsIPM  = [];
  const rowsKPct = [];

  for (const fp of set.files) {
    let game;
    try {
      game = new SlippiGame(fp.replace(/\//g, '\\'));
    } catch (e) {
      console.log(fp.split('/').pop().padEnd(36), 'ERROR:', e.message);
      continue;
    }

    const settings = game.getSettings();
    if (!settings) { console.log(fp.split('/').pop().padEnd(36), 'no settings'); continue; }

    const playerIdx = settings.players.findIndex(
      p => p && p.connectCode && p.connectCode.toUpperCase() === cc
    );
    if (playerIdx === -1) {
      console.log(fp.split('/').pop().padEnd(36), cc + ' not in game');
      continue;
    }

    const stats   = game.getStats();
    const overall = stats && stats.overall ? stats.overall : [];
    const actions = stats && stats.actionCounts ? stats.actionCounts : [];

    const pO = overall.find(o => o.playerIndex === playerIdx);
    const pA = actions.find(a => a.playerIndex === playerIdx);

    const opk    = pO && pO.openingsPerKill      ? pO.openingsPerKill.ratio      : null;
    const dpo    = pO && pO.damagePerOpening      ? pO.damagePerOpening.ratio     : null;
    const nwr    = pO && pO.neutralWinRatio       ? pO.neutralWinRatio.ratio      : null;
    const dipm   = pO && pO.digitalInputsPerMinute? pO.digitalInputsPerMinute.ratio : null;

    const lcSucc = pA && pA.lCancelCount ? pA.lCancelCount.success : 0;
    const lcFail = pA && pA.lCancelCount ? pA.lCancelCount.fail    : 0;
    const lcTot  = lcSucc + lcFail;
    const lc     = lcTot > 0 ? lcSucc / lcTot : null;

    // successfulConversions ratio — use slippi-js pre-computed value (player's overall)
    const ocr = pO && pO.successfulConversions ? pO.successfulConversions.ratio : null;

    // avg kill % from conversions that killed, hit by us
    const convs = stats && stats.conversions ? stats.conversions : [];
    const ourKills = convs.filter(c => c.didKill && c.lastHitBy === playerIdx);
    const kPcts = ourKills.map(c => c.endPercent).filter(p => p != null && p > 0);
    const avgKillPct = kPcts.length > 0 ? kPcts.reduce((a, b) => a + b, 0) / kPcts.length : null;

    if (opk  != null) rowsOPK.push(opk);
    if (dpo  != null) rowsDPO.push(dpo);
    if (nwr  != null) rowsNWR.push(nwr);
    if (ocr  != null) rowsOCR.push(ocr);
    if (lc   != null) rowsLC.push(lc);
    if (dipm != null) rowsIPM.push(dipm);
    if (avgKillPct != null) rowsKPct.push(avgKillPct);

    console.log(
      fp.split('/').pop().padEnd(36),
      n2(opk).padStart(5),
      n1(dpo).padStart(6),
      pct(nwr).padStart(6),
      pct(ocr).padStart(6),
      pct(lc).padStart(6),
      (dipm != null ? Math.round(dipm).toString() : '—').padStart(7),
      (avgKillPct != null ? avgKillPct.toFixed(0) + '%' : '—').padStart(9),
      (pO ? pO.killCount.toString() : '—').padStart(6),
    );
  }

  if (rowsOPK.length > 1) {
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log('-'.repeat(82));
    console.log(
      'SET AVG'.padEnd(36),
      n2(rowsOPK.length ? avg(rowsOPK) : null).padStart(5),
      n1(rowsDPO.length ? avg(rowsDPO) : null).padStart(6),
      pct(rowsNWR.length ? avg(rowsNWR) : null).padStart(6),
      pct(rowsOCR.length ? avg(rowsOCR) : null).padStart(6),
      pct(rowsLC.length  ? avg(rowsLC)  : null).padStart(6),
      (rowsIPM.length ? Math.round(avg(rowsIPM)).toString() : '—').padStart(7),
      (rowsKPct.length ? avg(rowsKPct).toFixed(0) + '%' : '—').padStart(9),
    );
  }
}
