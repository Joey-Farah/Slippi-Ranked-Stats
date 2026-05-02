<script lang="ts">
  import { rankedGames, sessions } from "../../lib/store";
  import { STAGES } from "../../lib/parser";
  import BarChart from "../charts/BarChart.svelte";

  let stageStats = $derived((() => {
    const m = new Map<number, { wins: number; losses: number }>();
    for (const g of $rankedGames) {
      const e = m.get(g.stage_id) ?? { wins: 0, losses: 0 };
      if (g.result === "win" || g.result === "lras_win") e.wins++;
      else e.losses++;
      m.set(g.stage_id, e);
    }
    return [...m.entries()]
      .map(([id, v]) => ({
        id,
        name: STAGES[id] ?? `Stage ${id}`,
        wins: v.wins,
        losses: v.losses,
        total: v.wins + v.losses,
        pct: ((v.wins / (v.wins + v.losses)) * 100),
      }))
      .sort((a, b) => b.total - a.total);
  })());

  let best = $derived(stageStats.filter((s) => s.total >= 3).sort((a, b) => b.pct - a.pct).at(0));
  let worst = $derived(stageStats.filter((s) => s.total >= 3).sort((a, b) => a.pct - b.pct).at(0));

  function fmt(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  let csvFlash = $state(false);

  function downloadCSV(data: any[], name: string) {
    const keys = Object.keys(data[0] ?? {});
    const rows = [keys.join(","), ...data.map((r) => keys.map((k) => r[k]).join(","))];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    csvFlash = true;
    setTimeout(() => { csvFlash = false; }, 2000);
  }
</script>

<!-- Best / worst callout -->
{#if best && worst}
  <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px">
    <div class="card" style="border-top: 3px solid var(--win)">
      <div class="label">Best Stage</div>
      <div style="font-size:16px; font-weight:700; color:var(--win); margin: 4px 0">{best.name}</div>
      <div class="muted">{best.pct.toFixed(1)}% ({best.wins}W–{best.losses}L)</div>
    </div>
    <div class="card" style="border-top: 3px solid var(--loss)">
      <div class="label">Worst Stage</div>
      <div style="font-size:16px; font-weight:700; color:var(--loss); margin: 4px 0">{worst.name}</div>
      <div class="muted">{worst.pct.toFixed(1)}% ({worst.wins}W–{worst.losses}L)</div>
    </div>
  </div>
{/if}

<!-- Stage win % chart -->
{#if stageStats.length > 0}
  <div class="card" style="margin-bottom:16px">
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

<!-- Session history -->
<div class="section-title" style="margin-bottom:8px">
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
  >
    Export CSV
  </button>
  {#if csvFlash}
    <span style="font-size:11px; color:var(--win)">✓ Saved to Downloads</span>
  {/if}
</div>
<div class="card" style="padding:0; overflow:hidden; max-height:520px; overflow-y:auto">
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Date</th>
        <th>Duration</th>
        <th>Sets</th>
        <th>W</th>
        <th>L</th>
        <th>Win %</th>
      </tr>
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
