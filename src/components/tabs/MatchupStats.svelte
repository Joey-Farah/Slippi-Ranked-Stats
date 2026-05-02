<script lang="ts">
  import { rankedGames, cleanSets as sets } from "../../lib/store";
  import { CHARACTERS } from "../../lib/parser";
  import BarChart from "../charts/BarChart.svelte";

  const MIN_SETS = 1;
  const MIN_SETS_SPOTLIGHT = 3;

  // Character filter — hidden chars are excluded from stats
  let hiddenChars = $state<number[]>([]);
  let allCharIds = $derived([...new Set($sets.flatMap((s) => s.opponent_char_ids))].sort());

  function toggleChar(id: number) {
    if (hiddenChars.includes(id)) {
      hiddenChars = hiddenChars.filter((c) => c !== id);
    } else {
      hiddenChars = [...hiddenChars, id];
    }
  }

  // Filtered sets — exclude hidden characters
  let filtered = $derived(hiddenChars.length > 0
    ? $sets.filter((s) => !s.opponent_char_ids.some((id) => hiddenChars.includes(id)))
    : $sets);

  type SortMode = "alpha" | "best" | "worst";
  let oppCharSort = $state<SortMode>("alpha");

  // Opponent char win rates (set-based)
  let oppCharStats = $derived((() => {
    const m = new Map<number, { wins: number; total: number }>();
    for (const s of filtered) {
      for (const id of s.opponent_char_ids) {
        const e = m.get(id) ?? { wins: 0, total: 0 };
        e.total++;
        if (s.result === "win") e.wins++;
        m.set(id, e);
      }
    }
    const rows = [...m.entries()]
      .filter(([, v]) => v.total >= MIN_SETS)
      .map(([id, v]) => ({
        id,
        name: CHARACTERS[id] ?? `Char ${id}`,
        wins: v.wins,
        total: v.total,
        pct: (v.wins / v.total) * 100,
      }));
    // BarChart reverses horizontal data so the first item appears at the top.
    // Best/Worst sort directions are inverted here so the reversal produces the correct visual order.
    if (oppCharSort === "alpha") rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (oppCharSort === "best") rows.sort((a, b) => b.pct - a.pct);
    else rows.sort((a, b) => a.pct - b.pct);
    return rows;
  })());

  // Your character breakdown (set-based)
  let myCharStats = $derived((() => {
    const m = new Map<number, { wins: number; total: number }>();
    for (const s of filtered) {
      for (const id of s.player_char_ids) {
        const e = m.get(id) ?? { wins: 0, total: 0 };
        e.total++;
        if (s.result === "win") e.wins++;
        m.set(id, e);
      }
    }
    return [...m.entries()]
      .filter(([, v]) => v.total >= MIN_SETS)
      .map(([id, v]) => ({
        name: CHARACTERS[id] ?? `Char ${id}`,
        wins: v.wins,
        total: v.total,
        pct: (v.wins / v.total) * 100,
      }))
      .sort((a, b) => b.name.localeCompare(a.name));
  })());

  // Opponent history (all sets, sorted by most played)
  let oppHistory = $derived((() => {
    const m = new Map<string, { wins: number; losses: number; sets: number }>();
    for (const s of $sets) {
      const e = m.get(s.opponent_code) ?? { wins: 0, losses: 0, sets: 0 };
      e.sets++;
      if (s.result === "win") e.wins++;
      else e.losses++;
      m.set(s.opponent_code, e);
    }
    return [...m.entries()]
      .map(([code, v]) => ({ code, ...v, pct: (v.wins / v.sets) * 100 }))
      .sort((a, b) => b.sets - a.sets);
  })());

  // Opponent spotlight derived stats
  let mostPlayed = $derived(oppHistory.slice(0, 5));
  let bestRecord  = $derived(
    [...oppHistory]
      .filter((o) => o.sets >= MIN_SETS_SPOTLIGHT)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5)
  );
  let worstRecord = $derived(
    [...oppHistory]
      .filter((o) => o.sets >= MIN_SETS_SPOTLIGHT)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 5)
  );

  // Search state
  let recentSearch = $state("");
  let historySearch = $state("");

  // Recent sets — filtered by search
  let recentSets = $derived(
    [...$sets]
      .reverse()
      .slice(0, 50)
      .filter((s) => !recentSearch || s.opponent_code.toLowerCase().includes(recentSearch.toLowerCase()))
  );

  // Opponent history — filtered by search
  let filteredOppHistory = $derived(
    historySearch
      ? oppHistory.filter((o) => o.code.toLowerCase().includes(historySearch.toLowerCase()))
      : oppHistory
  );

  let csvFlash: "recent" | "history" | null = $state(null);

  function downloadCSV(data: any[], name: string, key: "recent" | "history") {
    const keys = Object.keys(data[0] ?? {});
    const rows = [keys.join(","), ...data.map((r) => keys.map((k) => r[k]).join(","))];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    csvFlash = key;
    setTimeout(() => { csvFlash = null; }, 2000);
  }

  const TABLE_MAX_HEIGHT = 300;
</script>

<!-- Character filter chips -->
<div style="margin-bottom:12px">
  <div class="section-title">Filter by Opponent Character</div>
  <div style="display:flex; flex-wrap:wrap; gap:6px">
    {#each allCharIds as id}
      <button
        onclick={() => toggleChar(id)}
        style="
          padding: 4px 10px;
          border-radius: 20px;
          border: 1px solid {hiddenChars.includes(id) ? 'var(--loss)' : 'var(--border)'};
          background: {hiddenChars.includes(id) ? 'rgba(231,76,60,0.15)' : 'var(--card)'};
          color: {hiddenChars.includes(id) ? 'var(--loss)' : 'var(--text)'};
          font-size: 12px;
          cursor: pointer;
          text-decoration: {hiddenChars.includes(id) ? 'line-through' : 'none'};
          opacity: {hiddenChars.includes(id) ? '0.6' : '1'};
        "
      >
        {CHARACTERS[id] ?? id}
      </button>
    {/each}
    {#if hiddenChars.length > 0}
      <button
        onclick={() => hiddenChars = []}
        style="padding:4px 10px; border-radius:20px; border:1px solid var(--border); background:transparent; color:var(--muted); font-size:12px; cursor:pointer"
      >
        Show All
      </button>
    {/if}
  </div>
</div>

<!-- Charts row -->
<div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:16px">
  {#if oppCharStats.length > 0}
    <div class="card">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px">
        <div class="section-title" style="margin-bottom:0">Win % vs Opponent Character</div>
        <div style="display:flex; gap:4px">
          {#each [["alpha", "A-Z"], ["best", "Best"], ["worst", "Worst"]] as [mode, label]}
            <button
              onclick={() => oppCharSort = mode as SortMode}
              style="
                padding: 3px 10px;
                border-radius: 20px;
                border: 1px solid {oppCharSort === mode ? 'var(--accent)' : 'var(--border)'};
                background: {oppCharSort === mode ? 'rgba(46,139,46,0.2)' : 'var(--card)'};
                color: {oppCharSort === mode ? 'var(--accent)' : 'var(--muted)'};
                font-size: 11px;
                cursor: pointer;
              "
            >{label}</button>
          {/each}
        </div>
      </div>
      <BarChart
        categories={oppCharStats.map((c) => `${c.name} (${c.total})`)}
        values={oppCharStats.map((c) => c.pct)}
        label="Win %"
        horizontal={true}
        paired={true}
      />
    </div>
  {/if}

  <!-- Right column: Your Character Win % + Opponent Spotlight -->
  <div style="display:flex; flex-direction:column; gap:12px">
    {#if myCharStats.length > 0}
      <div class="card">
        <div class="section-title">Your Character Win %</div>
        <!-- Cap to ~3 bars visible, scroll for more -->
        <div style="max-height:{3 * 36 + 48}px; overflow-y:auto">
          <BarChart
            categories={myCharStats.map((c) => `${c.name} (${c.total})`)}
            values={myCharStats.map((c) => c.pct)}
            label="Win %"
            horizontal={true}
            paired={true}
          />
        </div>
      </div>
    {/if}

    <!-- Opponent Spotlight — stacked vertically -->
    {#if oppHistory.length > 0}
      <div class="card" style="flex:1">
        <div class="section-title" style="margin-bottom:10px">Opponent Spotlight</div>
        <div style="display:flex; flex-direction:column; gap:14px">

          <!-- Most Played -->
          <div>
            <div style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px">Most Played</div>
            {#each mostPlayed as o}
              <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border)">
                <span style="font-size:13px; font-weight:600">{o.code}</span>
                <span style="font-size:12px; color:var(--muted)">{o.sets} sets &nbsp;·&nbsp; {o.pct.toFixed(0)}% WR</span>
              </div>
            {/each}
          </div>

          <!-- Best Record -->
          <div>
            <div style="font-size:11px; font-weight:700; color:#2ecc71; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px">Best Record</div>
            {#if bestRecord.length === 0}
              <div style="font-size:11px; color:var(--muted)">Need {MIN_SETS_SPOTLIGHT}+ sets vs an opponent</div>
            {:else}
              {#each bestRecord as o}
                <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border)">
                  <span style="font-size:13px; font-weight:600">{o.code}</span>
                  <span style="font-size:12px; color:#2ecc71">{o.wins}W – {o.losses}L</span>
                </div>
              {/each}
            {/if}
          </div>

          <!-- Worst Record -->
          <div>
            <div style="font-size:11px; font-weight:700; color:#e74c3c; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px">Worst Record</div>
            {#if worstRecord.length === 0}
              <div style="font-size:11px; color:var(--muted)">Need {MIN_SETS_SPOTLIGHT}+ sets vs an opponent</div>
            {:else}
              {#each worstRecord as o}
                <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border)">
                  <span style="font-size:13px; font-weight:600">{o.code}</span>
                  <span style="font-size:12px; color:#e74c3c">{o.wins}W – {o.losses}L</span>
                </div>
              {/each}
            {/if}
          </div>

        </div>
      </div>
    {/if}
  </div>
</div>

<!-- Recent Sets table -->
<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
  <div class="section-title" style="margin-bottom:0">Recent Sets</div>
  <input
    type="text"
    placeholder="Search by connect code..."
    bind:value={recentSearch}
    style="font-size:12px; padding:3px 8px; border-radius:4px; border:1px solid var(--border); background:var(--card); color:var(--text); width:180px"
  />
  {#if recentSets.length > 0}
    <button
      onclick={() => downloadCSV(recentSets.map((s) => ({
        date: s.timestamp.slice(0, 10),
        opponent: s.opponent_code,
        result: s.result,
        score: `${s.wins}-${s.losses}`,
      })), "recent_sets.csv", "recent")}
      style="font-size:11px; background:var(--card); border:1px solid var(--border); color:var(--muted); padding:2px 8px; border-radius:4px; cursor:pointer"
    >
      Export CSV
    </button>
    {#if csvFlash === "recent"}
      <span style="font-size:11px; color:var(--win)">✓ Saved to Downloads</span>
    {/if}
  {/if}
</div>
<div class="card" style="padding:0; overflow:hidden; margin-bottom:16px; max-height:{TABLE_MAX_HEIGHT}px; overflow-y:auto">
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Opponent</th>
        <th>Result</th>
        <th>Score</th>
        <th>Opponent Char</th>
        <th>Your Char</th>
      </tr>
    </thead>
    <tbody>
      {#each recentSets as s}
        <tr>
          <td class="muted">{s.timestamp.slice(0, 10)}</td>
          <td>{s.opponent_code}</td>
          <td class={s.result === "win" ? "win-text" : "loss-text"}>
            {s.result === "win" ? "Win" : "Loss"}
          </td>
          <td>{s.wins}–{s.losses}</td>
          <td>{s.opponent_char_ids.map((id) => CHARACTERS[id] ?? id).join(", ")}</td>
          <td>{s.player_char_ids.map((id) => CHARACTERS[id] ?? id).join(", ")}</td>
        </tr>
      {/each}
      {#if recentSets.length === 0}
        <tr><td colspan="6" style="text-align:center; color:var(--muted); padding:16px">No results</td></tr>
      {/if}
    </tbody>
  </table>
</div>

<!-- Opponent History -->
<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
  <div class="section-title" style="margin-bottom:0">Opponent History</div>
  <input
    type="text"
    placeholder="Search by connect code..."
    bind:value={historySearch}
    style="font-size:12px; padding:3px 8px; border-radius:4px; border:1px solid var(--border); background:var(--card); color:var(--text); width:180px"
  />
  {#if oppHistory.length > 0}
    <button
      onclick={() => downloadCSV(oppHistory, "opponent_history.csv", "history")}
      style="font-size:11px; background:var(--card); border:1px solid var(--border); color:var(--muted); padding:2px 8px; border-radius:4px; cursor:pointer"
    >
      Export CSV
    </button>
    {#if csvFlash === "history"}
      <span style="font-size:11px; color:var(--win)">✓ Saved to Downloads</span>
    {/if}
  {/if}
</div>
<div class="card" style="padding:0; overflow:hidden; max-height:{TABLE_MAX_HEIGHT}px; overflow-y:auto">
  <table>
    <thead>
      <tr>
        <th>Opponent</th>
        <th>Sets</th>
        <th>Wins</th>
        <th>Losses</th>
        <th>Win %</th>
      </tr>
    </thead>
    <tbody>
      {#each filteredOppHistory as o}
        <tr>
          <td>{o.code}</td>
          <td>{o.sets}</td>
          <td class="win-text">{o.wins}</td>
          <td class="loss-text">{o.losses}</td>
          <td class={o.pct >= 50 ? "win-text" : "loss-text"}>{o.pct.toFixed(1)}%</td>
        </tr>
      {/each}
      {#if filteredOppHistory.length === 0}
        <tr><td colspan="5" style="text-align:center; color:var(--muted); padding:16px">No results</td></tr>
      {/if}
    </tbody>
  </table>
</div>
