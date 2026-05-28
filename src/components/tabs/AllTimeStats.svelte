<script lang="ts">
  import { cleanSets as sets } from "../../lib/store";
  import { STAGES, CHARACTERS } from "../../lib/parser";
  import BarChart from "../charts/BarChart.svelte";

  const MIN_SETS_HOUR = 3;

  // Your-character filter (tab-level, single-select): null = all characters. When set, every
  // stat on the tab is scoped to sets in which you played that character.
  let playerCharFilter = $state<number | null>(null);
  let myPlayedCharIds = $derived([...new Set($sets.flatMap((s) => s.player_char_ids))].sort());
  let baseSets = $derived(
    playerCharFilter === null
      ? $sets
      : $sets.filter((s) => s.player_char_ids.includes(playerCharFilter as number))
  );

  // Set stats
  let totalSets = $derived(baseSets.length);
  let setWins = $derived(baseSets.filter((s) => s.result === "win").length);
  let setLosses = $derived(totalSets - setWins);
  let setWinPct = $derived(totalSets > 0 ? (setWins / totalSets) * 100 : 0);

  // Game stats (individual games, kept for the Game Win % card only)
  let totalGames = $derived(baseSets.reduce((n, s) => n + s.games.length, 0));
  let gameWins = $derived(baseSets.reduce((n, s) => n + s.games.filter((g) => g.result === "win" || g.result === "lras_win").length, 0));
  let gameLosses = $derived(totalGames - gameWins);
  let gameWinPct = $derived(totalGames > 0 ? (gameWins / totalGames) * 100 : 0);

  // Comeback rate: sets won after losing game 1
  let comebackRate = $derived((() => {
    const lostG1 = baseSets.filter((s) => {
      const g1 = s.games[0];
      return g1 && (g1.result === "loss" || g1.result === "lras_loss");
    });
    if (lostG1.length === 0) return null;
    const won = lostG1.filter((s) => s.result === "win").length;
    return { pct: (won / lostG1.length) * 100, won, total: lostG1.length };
  })());

  // Deciding game win %: win rate in game 3 of sets with exactly 3 games
  let decidingRate = $derived((() => {
    const went3 = baseSets.filter((s) => s.games.length === 3);
    if (went3.length === 0) return null;
    const won = went3.filter((s) => s.result === "win").length;
    return { pct: (won / went3.length) * 100, won, total: went3.length };
  })());

  // Stage stats (set-based)
  let stageStats = $derived((() => {
    const m = new Map<number, { wins: number; losses: number }>();
    for (const s of baseSets) {
      for (const id of s.stage_ids) {
        const e = m.get(id) ?? { wins: 0, losses: 0 };
        if (s.result === "win") e.wins++; else e.losses++;
        m.set(id, e);
      }
    }
    return [...m.entries()]
      .map(([id, v]) => ({
        id, name: STAGES[id] ?? `Stage ${id}`,
        wins: v.wins, losses: v.losses,
        total: v.wins + v.losses,
        pct: (v.wins / (v.wins + v.losses)) * 100,
      }))
      .sort((a, b) => b.total - a.total);
  })());
  let bestStage = $derived(stageStats.filter((s) => s.total >= 3).sort((a, b) => b.pct - a.pct).at(0));
  let worstStage = $derived(stageStats.filter((s) => s.total >= 3).sort((a, b) => a.pct - b.pct).at(0));

  // Time-of-day win % by hour (set-based)
  let hourStats = $derived((() => {
    const m = new Map<number, { wins: number; total: number }>();
    for (const s of baseSets) {
      const hour = new Date(s.timestamp).getHours();
      const e = m.get(hour) ?? { wins: 0, total: 0 };
      e.total++;
      if (s.result === "win") e.wins++;
      m.set(hour, e);
    }
    return [...m.entries()]
      .filter(([, v]) => v.total >= MIN_SETS_HOUR)
      .map(([h, v]) => ({
        hour: `${h}:00`,
        wins: v.wins,
        total: v.total,
        pct: (v.wins / v.total) * 100,
      }))
      .sort((a, b) => parseInt(a.hour) - parseInt(b.hour));
  })());

  function fmt(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

</script>

<!-- Your-character filter (single-select, scopes the whole tab) -->
{#if myPlayedCharIds.length > 1}
  <div style="margin-bottom:12px">
    <div class="section-title">Filter by Your Character</div>
    <div style="display:flex; flex-wrap:wrap; gap:6px">
      <button
        onclick={() => playerCharFilter = null}
        style="
          padding: 4px 10px;
          border-radius: 20px;
          border: 1px solid {playerCharFilter === null ? 'var(--accent)' : 'var(--border)'};
          background: {playerCharFilter === null ? 'rgba(46,139,46,0.2)' : 'var(--card)'};
          color: {playerCharFilter === null ? 'var(--accent)' : 'var(--text)'};
          font-size: 12px;
          cursor: pointer;
        "
      >All Characters</button>
      {#each myPlayedCharIds as id}
        <button
          onclick={() => playerCharFilter = id}
          style="
            padding: 4px 10px;
            border-radius: 20px;
            border: 1px solid {playerCharFilter === id ? 'var(--accent)' : 'var(--border)'};
            background: {playerCharFilter === id ? 'rgba(46,139,46,0.2)' : 'var(--card)'};
            color: {playerCharFilter === id ? 'var(--accent)' : 'var(--text)'};
            font-size: 12px;
            cursor: pointer;
          "
        >{CHARACTERS[id] ?? id}</button>
      {/each}
    </div>
  </div>
{/if}

<!-- Summary cards row -->
<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:12px; margin-bottom:16px">
  <div class="stat-card">
    <div class="label">Set Win %</div>
    <div class="value">{setWinPct.toFixed(1)}%</div>
    <div class="sub">{setWins}W – {setLosses}L ({totalSets} sets)</div>
  </div>

  <div class="stat-card">
    <div class="label">Game Win %</div>
    <div class="value">{gameWinPct.toFixed(1)}%</div>
    <div class="sub">{gameWins}W – {gameLosses}L ({totalGames} games)</div>
  </div>

  {#if comebackRate}
    <div class="stat-card">
      <div class="label">Comeback Rate</div>
      <div class="value">{comebackRate.pct.toFixed(1)}%</div>
      <div class="sub">{comebackRate.won}/{comebackRate.total} sets after losing G1</div>
    </div>
  {/if}

  {#if decidingRate}
    <div class="stat-card">
      <div class="label">Deciding Game Win %</div>
      <div class="value">{decidingRate.pct.toFixed(1)}%</div>
      <div class="sub">{decidingRate.won}/{decidingRate.total} game 3s</div>
    </div>
  {/if}
</div>

<!-- Time of day chart -->
{#if hourStats.length > 0}
  <div class="card">
    <div class="section-title">Win % by Time of Day (min {MIN_SETS_HOUR} sets per hour)</div>
    <BarChart
      categories={hourStats.map((h) => `${h.hour} (${h.total})`)}
      values={hourStats.map((h) => h.pct)}
      label="Win %"
      color="#2ecc71"
      horizontal={false}
    />
  </div>
{:else}
  <p class="muted">Not enough data yet for time-of-day analysis.</p>
{/if}

<!-- Stage stats -->
{#if bestStage && worstStage}
  <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:16px; margin-bottom:16px">
    <div class="card" style="border-top: 3px solid var(--win)">
      <div class="label">Best Stage</div>
      <div style="font-size:16px; font-weight:700; color:var(--win); margin: 4px 0">{bestStage.name}</div>
      <div class="muted">{bestStage.pct.toFixed(1)}% ({bestStage.wins}W–{bestStage.losses}L)</div>
    </div>
    <div class="card" style="border-top: 3px solid var(--loss)">
      <div class="label">Worst Stage</div>
      <div style="font-size:16px; font-weight:700; color:var(--loss); margin: 4px 0">{worstStage.name}</div>
      <div class="muted">{worstStage.pct.toFixed(1)}% ({worstStage.wins}W–{worstStage.losses}L)</div>
    </div>
  </div>
{/if}

{#if stageStats.length > 0}
  <div class="card">
    <div class="section-title">Stage Win %</div>
    <BarChart
      categories={stageStats.map((s) => `${s.name} (${s.total})`)}
      values={stageStats.map((s) => s.pct)}
      label="Win %"
      horizontal={true}
      paired={true}
    />
  </div>
{/if}
