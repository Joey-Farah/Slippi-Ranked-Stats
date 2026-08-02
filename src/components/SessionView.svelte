<script lang="ts">
  import { snapshots, sessionRatingDelta, type Session } from "../lib/store";
  import { CHARACTERS, STAGES } from "../lib/parser";
  import LineChart from "./charts/LineChart.svelte";
  import BarChart from "./charts/BarChart.svelte";

  let { session }: { session: Session } = $props();

  let sessionGames = $derived(session.sets.flatMap((s) => s.games));

  // Net Rating across the session. null whenever it can't be pinned down exactly — most
  // older sessions predate rating snapshots entirely — in which case the card is dropped
  // rather than showing a placeholder.
  let rating = $derived(sessionRatingDelta(session, $snapshots));

  let stageStats = $derived((() => {
    const m = new Map<number, { wins: number; total: number }>();
    for (const g of sessionGames) {
      const id = g.stage_id;
      if (id == null) continue;
      const e = m.get(id) ?? { wins: 0, total: 0 };
      e.total++;
      if (g.result === "win" || g.result === "lras_win") e.wins++;
      m.set(id, e);
    }
    return [...m.entries()]
      .map(([id, v]) => ({ name: STAGES[id] ?? `Stage ${id}`, ...v, pct: (v.wins / v.total) * 100 }))
      .sort((a, b) => b.total - a.total);
  })());

  let gameWins   = $derived(sessionGames.filter((g) => g.result === "win" || g.result === "lras_win").length);
  let gameLosses = $derived(sessionGames.length - gameWins);
  let gameWinPct = $derived(sessionGames.length > 0 ? (gameWins / sessionGames.length) * 100 : 0);
  let winsPerHour = $derived(session.durationMin > 0 ? (gameWins / session.durationMin) * 60 : 0);

  let scores = $derived((() => {
    const s = session.sets;
    return {
      w20: s.filter((s) => s.result === "win"  && s.losses === 0).length,
      w21: s.filter((s) => s.result === "win"  && s.losses === 1).length,
      l12: s.filter((s) => s.result === "loss" && s.wins   === 1).length,
      l02: s.filter((s) => s.result === "loss" && s.wins   === 0).length,
    };
  })());

  let game1 = $derived((() => {
    const sets = session.sets;
    const total = sets.length;
    const wins = sets.filter((s) => {
      const first = s.games[0];
      return first && (first.result === "win" || first.result === "lras_win");
    }).length;
    return { wins, total, pct: total > 0 ? (wins / total) * 100 : 0 };
  })());

  let deciding = $derived((() => {
    const deciders = session.sets.filter((s) => s.wins + s.losses === 3);
    const wins = deciders.filter((s) => s.result === "win").length;
    return { wins, total: deciders.length, pct: deciders.length > 0 ? (wins / deciders.length) * 100 : 0 };
  })());

  let momentumData = $derived((() => {
    let bal = 0;
    return sessionGames.map((g, i) => {
      if (g.result === "win" || g.result === "lras_win") bal++;
      else bal--;
      return { x: i + 1, y: bal };
    });
  })());

  function fmt(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
</script>

<!-- Session summary cards. The Rating card only exists when the change could be established
     exactly (see sessionRatingDelta), so the grid widens to 9 columns to make room for it. -->
<div style="display:grid; grid-template-columns: repeat({rating ? 9 : 8}, 1fr); gap:10px; margin-bottom:16px">
  {#if rating}
    <div class="stat-card" title="Rating {rating.from.toFixed(1)} → {rating.to.toFixed(1)}">
      <div class="label">Net Rating</div>
      <div class="value" class:win-text={rating.delta > 0} class:loss-text={rating.delta < 0}>
        {rating.delta >= 0 ? "+" : ""}{rating.delta.toFixed(1)}
      </div>
    </div>
  {/if}
  <div class="stat-card">
    <div class="label">Duration</div>
    <div class="value">{fmt(session.durationMin)}</div>
  </div>
  <div class="stat-card">
    <div class="label">Sets</div>
    <div class="value">{session.sets.length}</div>
  </div>
  <div class="stat-card">
    <div class="label">Games</div>
    <div class="value">{sessionGames.length}</div>
  </div>
  <div class="stat-card">
    <div class="label">Set W/L</div>
    <div class="value">
      <span class="win-text">{session.setWins}</span>
      –
      <span class="loss-text">{session.setLosses}</span>
    </div>
  </div>
  <div class="stat-card">
    <div class="label">Set Win %</div>
    <div class="value">
      {session.sets.length > 0
        ? ((session.setWins / session.sets.length) * 100).toFixed(1) + "%"
        : "—"}
    </div>
  </div>
  <div class="stat-card">
    <div class="label">Game W/L</div>
    <div class="value">
      <span class="win-text">{gameWins}</span>
      –
      <span class="loss-text">{gameLosses}</span>
    </div>
  </div>
  <div class="stat-card">
    <div class="label">Game Win %</div>
    <div class="value">{gameWinPct.toFixed(1)}%</div>
  </div>
  <div class="stat-card">
    <div class="label">Game Wins / Hour</div>
    <div class="value">{winsPerHour.toFixed(1)}</div>
  </div>
</div>

<!-- Sets list + Session Breakdown side by side -->
<div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:16px; align-items:stretch">
  <div>
    <div class="card" style="padding:0; overflow:hidden; display:flex; flex-direction:column">
      <div class="section-title" style="padding:12px 16px 0; flex-shrink:0">Sets This Session</div>
      <div style="overflow-y:auto; max-height:300px">
        <table>
          <thead>
            <tr>
              <th>Result</th>
              <th>Opponent</th>
              <th>Score</th>
              <th>Characters</th>
              <th>Stages</th>
            </tr>
          </thead>
          <tbody>
            {#each session.sets as s}
              <tr>
                <td>
                  <span class={s.result === "win" ? "win-text" : "loss-text"}>
                    {s.result === "win" ? "Win" : "Loss"}
                  </span>
                </td>
                <td>{s.opponent_code}</td>
                <td>{s.wins}–{s.losses}</td>
                <td>{s.opponent_char_ids.map((id) => CHARACTERS[id] ?? id).join(", ")}</td>
                <td>{s.stage_ids.map((id) => STAGES[id] ?? id).join(", ")}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Session Breakdown card -->
  <div class="card" style="display:flex; flex-direction:column">
    <div class="section-title">Session Breakdown</div>
    <div style="display:flex; gap:48px; flex-wrap:wrap; flex:1">
      <!-- Score distribution -->
      <div style="display:flex; flex-direction:column; flex:1">
        <div style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px">Score Distribution</div>
        <div style="display:flex; flex-direction:column; justify-content:space-between; flex:1">
          {#each [["2-0", scores.w20, "win"], ["2-1", scores.w21, "win"], ["1-2", scores.l12, "loss"], ["0-2", scores.l02, "loss"]] as [label, count, cls]}
            <div style="display:flex; justify-content:space-between; align-items:center; padding:3px 0">
              <span class="{cls}-text" style="font-size:16px; font-weight:600">{label}</span>
              <span style="font-size:16px; color:var(--text)">{count} set{count !== 1 ? "s" : ""}</span>
            </div>
          {/each}
        </div>
      </div>
      <!-- Game 1 win rate -->
      <div>
        <div style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px">Game 1 Win Rate</div>
        <div style="font-size:26px; font-weight:700; color:{game1.pct >= 50 ? 'var(--win)' : 'var(--loss)'}">
          {game1.total > 0 ? game1.pct.toFixed(1) + "%" : "—"}
        </div>
        <div style="font-size:12px; color:var(--muted); margin-top:2px">
          {game1.wins}W / {game1.total - game1.wins}L
        </div>
      </div>
      <!-- Deciding game win rate -->
      <div>
        <div style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px">Deciding Game Win Rate</div>
        <div style="font-size:26px; font-weight:700; color:{deciding.pct >= 50 ? 'var(--win)' : 'var(--loss)'}">
          {deciding.total > 0 ? deciding.pct.toFixed(1) + "%" : "—"}
        </div>
        <div style="font-size:12px; color:var(--muted); margin-top:2px">
          {deciding.wins}W / {deciding.total - deciding.wins}L ({deciding.total} set{deciding.total !== 1 ? "s" : ""})
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Charts row -->
<div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:16px">
  {#if stageStats.length > 0}
    <div class="card">
      <div class="section-title">Stage Win % <span style="font-size:10px; font-weight:400; color:var(--muted)">(per game)</span></div>
      <BarChart
        categories={stageStats.map((s) => s.name)}
        values={stageStats.map((s) => s.pct)}
        label="Win %"
        horizontal={true}
        paired={true}
      />
    </div>
  {/if}

  {#if momentumData.length > 1}
    <div class="card">
      <div class="section-title">Momentum</div>
      <LineChart
        xData={momentumData.map((d) => d.x)}
        yData={momentumData.map((d) => d.y)}
        label="W/L Balance"
        color="#2ecc71"
        fill={true}
        height={200}
        xAxisLabel="Game"
        yAxisLabel="W/L Balance"
      />
    </div>
  {/if}
</div>
