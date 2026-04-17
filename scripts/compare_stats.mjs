/**
 * compare_stats.mjs
 *
 * Parses recent .slp files using @slippi/slippi-js (the same library Slippi
 * Launcher uses) and prints the stats we grade on.  Run with:
 *
 *   node scripts/compare_stats.mjs
 *
 * Then compare the output to what the app's Grade History shows for the same
 * games.  Any discrepancy between the two is a bug in our parser.
 */

import pkg from '@slippi/slippi-js';
const { SlippiGame } = pkg;

const CONNECT_CODE = 'JOEY#870';

// Recent sets from the DB (most recent first)
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

function pct(r) { return r?.ratio != null ? (r.ratio * 100).toFixed(1) + '%' : '—'; }
function num(r) { return r?.ratio != null ? r.ratio.toFixed(2) : '—'; }
function dmg(r) { return r?.ratio != null ? r.ratio.toFixed(1) : '—'; }
function ipm(r) { return r?.ratio != null ? Math.round(r.ratio).toString() : '—'; }

for (const set of SETS) {
  console.log('\n' + '='.repeat(72));
  console.log(set.label);
  console.log('='.repeat(72));
  console.log(
    'File'.padEnd(35),
    'OPK'.padStart(5),
    'D/O'.padStart(6),
    'NWR%'.padStart(6),
    'L-C%'.padStart(6),
    'IPM'.padStart(5),
    'KillPct'.padStart(8),
    'Kills'.padStart(6),
  );
  console.log('-'.repeat(72));

  const setStats = [];

  for (const fp of set.files) {
    let game;
    try {
      game = new SlippiGame(fp);
    } catch (e) {
      console.log(fp.split('/').pop().padEnd(35), 'ERROR:', e.message);
      continue;
    }

    const settings = game.getSettings();
    if (!settings) { console.log(fp.split('/').pop().padEnd(35), 'no settings'); continue; }

    // Find player index by connect code
    const playerIdx = settings.players.findIndex(
      p => p?.connectCode?.toUpperCase() === cc
    );
    if (playerIdx === -1) {
      console.log(fp.split('/').pop().padEnd(35), `${cc} not found in game`);
      continue;
    }

    const stats    = game.getStats();
    const actions  = game.getStats()?.actionCounts ?? [];
    const overall  = stats?.overall ?? [];

    const pOverall  = overall.find(o => o.playerIndex === playerIdx);
    const pActions  = actions.find(a => a.playerIndex === playerIdx);

    // L-cancel
    const lcSucc = pActions?.lCancelCount?.success ?? 0;
    const lcFail = pActions?.lCancelCount?.fail ?? 0;
    const lcTotal = lcSucc + lcFail;
    const lcRatio = lcTotal > 0 ? (lcSucc / lcTotal * 100).toFixed(1) + '%' : '—';

    // Kill percents: from conversions that killed
    const conversions = stats?.conversions ?? [];
    const kills = conversions.filter(c => c.didKill && c.lastHitBy === playerIdx);
    const killPcts = kills.map(c => c.endPercent).filter(p => p != null && p > 0);
    const avgKillPct = killPcts.length > 0
      ? (killPcts.reduce((a, b) => a + b, 0) / killPcts.length).toFixed(0) + '%'
      : '—';

    const row = {
      file:   fp.split('/').pop(),
      opk:    pOverall ? num(pOverall.openingsPerKill) : '—',
      dpo:    pOverall ? dmg(pOverall.damagePerOpening) : '—',
      nwr:    pOverall ? pct(pOverall.neutralWinRatio) : '—',
      lc:     lcRatio,
      ipm:    pOverall ? ipm(pOverall.digitalInputsPerMinute) : '—',
      killPct: avgKillPct,
      kills:  pOverall?.killCount?.toString() ?? '—',
    };

    setStats.push(row);

    console.log(
      row.file.padEnd(35),
      row.opk.padStart(5),
      row.dpo.padStart(6),
      row.nwr.padStart(6),
      row.lc.padStart(6),
      row.ipm.padStart(5),
      row.killPct.padStart(8),
      row.kills.padStart(6),
    );
  }

  // Set averages
  if (setStats.length > 1) {
    const avg = (arr, key) => {
      const vals = arr.map(r => parseFloat(r[key])).filter(v => !isNaN(v));
      return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    console.log('-'.repeat(72));
    console.log(
      'SET AVG'.padEnd(35),
      (avg(setStats, 'opk')?.toFixed(2) ?? '—').padStart(5),
      (avg(setStats, 'dpo')?.toFixed(1) ?? '—').padStart(6),
      (avg(setStats, 'nwr')?.toFixed(1) + '%' || '—').padStart(6),
      (avg(setStats, 'lc')?.toFixed(1) + '%' || '—').padStart(6),
      (Math.round(avg(setStats, 'ipm')) || '—').toString().padStart(5),
      (avg(setStats, 'killPct')?.toFixed(0) + '%' || '—').padStart(8),
    );
  }
}
