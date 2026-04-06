<script lang="ts">
  import { cleanSets as sets, sessions } from "../../lib/store";
  import { STAGES } from "../../lib/parser";
  import BarChart from "../charts/BarChart.svelte";

  const MIN_SETS_HOUR = 3;

  // Set stats
  let totalSets = $derived($sets.length);
  let setWins = $derived($sets.filter((s) => s.result === "win").length);
  let setLosses = $derived(totalSets - setWins);
  let setWinPct = $derived(totalSets > 0 ? (setWins / totalSets) * 100 : 0);

  // Game stats (individual games, kept for the Game Win % card only)
  let totalGames = $derived($sets.reduce((n, s) => n + s.games.length, 0));
  let gameWins = $derived($sets.reduce((n, s) => n + s.games.filter((g) => g.result === "win" || g.result === "lras_win").length, 0));
  let gameLosses = $derived(totalGames - gameWins);
  let gameWinPct = $derived(totalGames > 0 ? (gameWins / totalGames) * 100 : 0);

  // Comeback rate: sets won after losing game 1
  let comebackRate = $derived((() => {
    const lostG1 = $sets.filter((s) => {
      const g1 = s.games[0];
      return g1 && (g1.result === "loss" || g1.result === "lras_loss");
    });
    if (lostG1.length === 0) return null;
    const won = lostG1.filter((s) => s.result === "win").length;
    return { pct: (won / lostG1.length) * 100, won, total: lostG1.length };
  })());

  // Deciding game win %: win rate in game 3 of sets with exactly 3 games
  let decidingRate = $derived((() => {
    const went3 = $sets.filter((s) => s.games.length === 3);
    if (went3.length === 0) return null;
    const won = went3.filter((s) => s.result === "win").length;
    return { pct: (won / went3.length) * 100, won, total: went3.length };
  })());

  // Stage stats (set-based)
  let stageStats = $derived((() => {
    const m = new Map<number, { wins: number; losses: number }>();
    for (const s of $sets) {
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
    for (const s of $sets) {
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

  function downloadCSV(data: any[], name: string) {
    const keys = Object.keys(data[0] ?? {});
    const rows = [keys.join(","), ...data.map((r) => keys.map((k) => r[k]).join(","))];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }
</script>

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

{#if $sessions.length > 0}
  <div class="section-title" style="margin-top:16px; margin-bottom:8px">
    Session History
    <button
      onclick={() => downloadCSV($sessions.map((s, i) => ({
        session: i + 1,
        date: s.start.slice(0, 10),
        sets: s.sets.length,
        wins: s.setWins,
        losses: s.setLosses,
        win_pct: s.sets.length > 0 ? ((s.setWins / s.sets.length) * 100).toFixed(1) : "0.0",
        duration: fmt(s.durationMin),
      })), "session_history.csv")}
      style="font-size:11px; margin-left:8px; background:var(--card); border:1px solid var(--border); color:var(--muted); padding:2px 8px; border-radius:4px; cursor:pointer"
    >Export CSV</button>
  </div>
  <div class="card" style="padding:0; overflow:hidden; max-height:300px; overflow-y:auto">
    <table>
      <thead>
        <tr><th>#</th><th>Date</th><th>Duration</th><th>Sets</th><th>W</th><th>L</th><th>Win %</th></tr>
      </thead>
      <tbody>
        {#each [...$sessions].reverse() as s, i}
          <tr>
            <td class="muted">{$sessions.length - i}</td>
            <td>{s.start.slice(0, 10)}</td>
            <td class="muted">{fmt(s.durationMin)}</td>
            <td>{s.sets.length}</td>
            <td class="win-text">{s.setWins}</td>
            <td class="loss-text">{s.setLosses}</td>
            <td class={s.sets.length > 0 ? (s.setWins / s.sets.length >= 0.5 ? "win-text" : "loss-text") : ""}>
              {s.sets.length > 0 ? ((s.setWins / s.sets.length) * 100).toFixed(1) + "%" : "—"}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
