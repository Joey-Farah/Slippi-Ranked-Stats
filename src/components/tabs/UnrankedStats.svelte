<script lang="ts">
  import { unrankedGames, isPremium } from "../../lib/store";
  import { CHARACTERS, STAGES } from "../../lib/parser";
  import BarChart from "../charts/BarChart.svelte";
  import PremiumGate from "../PremiumGate.svelte";

  // ── Character filter ───────────────────────────────────────────────────────

  // Your-character filter (tab-level, single-select): null = all characters. When set, the
  // whole tab is scoped to games in which you played that character.
  let playerCharFilter = $state<number | null>(null);
  let myPlayedCharIds = $derived([...new Set($unrankedGames.map((g) => g.player_char_id))].sort());
  let baseGames = $derived(
    playerCharFilter === null
      ? $unrankedGames
      : $unrankedGames.filter((g) => g.player_char_id === playerCharFilter)
  );

  // Opponent-character filter — hidden chars excluded from the matchup chart.
  let hiddenChars = $state<number[]>([]);
  let allCharIds = $derived([...new Set(baseGames.map((g) => g.opponent_char_id))].sort());

  function toggleChar(id: number) {
    hiddenChars = hiddenChars.includes(id)
      ? hiddenChars.filter((c) => c !== id)
      : [...hiddenChars, id];
  }

  // Games feeding the matchup chart — your-character scope, then exclude hidden opponent chars
  let filtered = $derived(
    hiddenChars.length > 0
      ? baseGames.filter((g) => !hiddenChars.includes(g.opponent_char_id))
      : baseGames
  );

  // ── Summary (respects the your-character filter) ────────────────────────────

  let totalGames = $derived(baseGames.length);
  let wins = $derived(baseGames.filter((g) => g.result === "win" || g.result === "lras_win").length);
  let losses = $derived(totalGames - wins);
  let winPct = $derived(totalGames > 0 ? (wins / totalGames) * 100 : 0);

  // ── Chart stats (respect char filter) ─────────────────────────────────────

  type SortMode = "alpha" | "best" | "worst" | "most" | "least";
  let oppCharSort = $state<SortMode>("alpha");

  let oppCharStats = $derived((() => {
    const m = new Map<number, { wins: number; total: number }>();
    for (const g of filtered) {
      const e = m.get(g.opponent_char_id) ?? { wins: 0, total: 0 };
      e.total++;
      if (g.result === "win" || g.result === "lras_win") e.wins++;
      m.set(g.opponent_char_id, e);
    }
    const rows = [...m.entries()].map(([id, v]) => ({
      id,
      name: CHARACTERS[id] ?? `Char ${id}`,
      wins: v.wins,
      total: v.total,
      pct: (v.wins / v.total) * 100,
    }));
    // BarChart reverses horizontal data, so best/worst sort directions are inverted
    if (oppCharSort === "alpha") rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (oppCharSort === "best") rows.sort((a, b) => b.pct - a.pct);
    else if (oppCharSort === "worst") rows.sort((a, b) => a.pct - b.pct);
    else if (oppCharSort === "most") rows.sort((a, b) => b.total - a.total);
    else rows.sort((a, b) => a.total - b.total);
    return rows;
  })());

  let myCharStats = $derived((() => {
    const m = new Map<number, { wins: number; total: number }>();
    for (const g of baseGames) {
      const e = m.get(g.player_char_id) ?? { wins: 0, total: 0 };
      e.total++;
      if (g.result === "win" || g.result === "lras_win") e.wins++;
      m.set(g.player_char_id, e);
    }
    return [...m.entries()]
      .map(([id, v]) => ({
        name: CHARACTERS[id] ?? `Char ${id}`,
        wins: v.wins,
        total: v.total,
        pct: (v.wins / v.total) * 100,
      }))
      .sort((a, b) => b.total - a.total);
  })());

  let stageStats = $derived((() => {
    const m = new Map<number, { wins: number; losses: number }>();
    for (const g of baseGames) {
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
        pct: (v.wins / (v.wins + v.losses)) * 100,
      }))
      .sort((a, b) => b.total - a.total);
  })());

  // ── Opponent history (always unfiltered, matches MatchupStats behavior) ────

  let oppHistory = $derived((() => {
    const m = new Map<string, { wins: number; losses: number }>();
    for (const g of baseGames) {
      const e = m.get(g.opponent_code) ?? { wins: 0, losses: 0 };
      if (g.result === "win" || g.result === "lras_win") e.wins++;
      else e.losses++;
      m.set(g.opponent_code, e);
    }
    return [...m.entries()]
      .map(([code, v]) => ({
        code,
        wins: v.wins,
        losses: v.losses,
        games: v.wins + v.losses,
        pct: (v.wins / (v.wins + v.losses)) * 100,
      }))
      .sort((a, b) => b.games - a.games);
  })());

  const MIN_SPOTLIGHT = 3;
  let mostPlayed  = $derived(oppHistory.slice(0, 5));
  let bestRecord  = $derived([...oppHistory].filter((o) => o.games >= MIN_SPOTLIGHT).sort((a, b) => b.pct - a.pct).slice(0, 5));
  let worstRecord = $derived([...oppHistory].filter((o) => o.games >= MIN_SPOTLIGHT).sort((a, b) => a.pct - b.pct).slice(0, 5));

  let search = $state("");
  let filteredOpp = $derived(
    search
      ? oppHistory.filter((o) => o.code.toLowerCase().includes(search.toLowerCase()))
      : oppHistory
  );

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

{#if !$isPremium}
  <PremiumGate
    featureName="Unranked & Direct Stats"
    description="See your win rates, character usage, and opponent history for unranked and direct games."
  />
{:else if $unrankedGames.length === 0}
  <p class="muted" style="padding:32px; text-align:center">No unranked or direct games found in your replay folder.</p>
{:else}
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

  <!-- Summary cards -->
  <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-bottom:16px">
    <div class="stat-card">
      <div class="label">Games Played</div>
      <div class="value">{totalGames}</div>
    </div>
    <div class="stat-card">
      <div class="label">Win %</div>
      <div class="value">{winPct.toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="label">Record</div>
      <div class="value" style="font-size:20px">
        <span class="win-text">{wins}W</span>
        <span style="color:var(--muted)"> – </span>
        <span class="loss-text">{losses}L</span>
      </div>
    </div>
  </div>

  <!-- Top charts row: opp char + your chars -->
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:16px">
    {#if oppCharStats.length > 0}
      <div class="card">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px">
          <div class="section-title" style="margin-bottom:0">Win % vs Opponent Character</div>
          <div style="display:flex; gap:4px">
            {#each [["alpha", "A-Z"], ["best", "Best"], ["worst", "Worst"], ["most", "Most Played"], ["least", "Least Played"]] as [mode, lbl]}
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
              >{lbl}</button>
            {/each}
          </div>
        </div>
        <!-- Character filter chips — scoped to this chart -->
        <div style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px">
          {#each allCharIds as id}
            <button
              onclick={() => toggleChar(id)}
              style="
                padding: 3px 8px;
                border-radius: 20px;
                border: 1px solid {hiddenChars.includes(id) ? 'var(--loss)' : 'var(--border)'};
                background: {hiddenChars.includes(id) ? 'rgba(231,76,60,0.15)' : 'transparent'};
                color: {hiddenChars.includes(id) ? 'var(--loss)' : 'var(--muted)'};
                font-size: 11px;
                cursor: pointer;
                text-decoration: {hiddenChars.includes(id) ? 'line-through' : 'none'};
                opacity: {hiddenChars.includes(id) ? '0.6' : '1'};
              "
            >{CHARACTERS[id] ?? id}</button>
          {/each}
          {#if hiddenChars.length > 0}
            <button
              onclick={() => hiddenChars = []}
              style="padding:3px 8px; border-radius:20px; border:1px solid var(--border); background:transparent; color:var(--muted); font-size:11px; cursor:pointer"
            >Show All</button>
          {/if}
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

    <!-- Right column: your chars + opponent spotlight -->
    <div style="display:flex; flex-direction:column; gap:12px">
      {#if myCharStats.length > 0}
        <div class="card">
          <div class="section-title">Your Characters</div>
          <BarChart
            categories={myCharStats.map((c) => `${c.name} (${c.total})`)}
            values={myCharStats.map((c) => c.pct)}
            label="Win %"
            horizontal={true}
            paired={true}
          />
        </div>
      {/if}

      {#if oppHistory.length > 0}
        <div class="card" style="flex:1">
          <div class="section-title" style="margin-bottom:10px">Opponent Spotlight</div>
          <div style="display:flex; flex-direction:column; gap:14px">
            <div>
              <div style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px">Most Played</div>
              {#each mostPlayed as o}
                <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border)">
                  <span style="font-size:13px; font-weight:600">{o.code}</span>
                  <span style="font-size:12px; color:var(--muted)">{o.games} games &nbsp;·&nbsp; {o.pct.toFixed(0)}% WR</span>
                </div>
              {/each}
            </div>
            <div>
              <div style="font-size:11px; font-weight:700; color:#2ecc71; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px">Best Record</div>
              {#if bestRecord.length === 0}
                <div style="font-size:11px; color:var(--muted)">Need {MIN_SPOTLIGHT}+ games vs an opponent</div>
              {:else}
                {#each bestRecord as o}
                  <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border)">
                    <span style="font-size:13px; font-weight:600">{o.code}</span>
                    <span style="font-size:12px; color:#2ecc71">{o.wins}W – {o.losses}L</span>
                  </div>
                {/each}
              {/if}
            </div>
            <div>
              <div style="font-size:11px; font-weight:700; color:#e74c3c; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px">Worst Record</div>
              {#if worstRecord.length === 0}
                <div style="font-size:11px; color:var(--muted)">Need {MIN_SPOTLIGHT}+ games vs an opponent</div>
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

  <!-- Stage win % -->
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

  <!-- Opponent history table -->
  <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
    <div class="section-title" style="margin-bottom:0">Opponent History</div>
    <input
      type="text"
      placeholder="Search by connect code..."
      bind:value={search}
      style="font-size:12px; padding:3px 8px; border-radius:4px; border:1px solid var(--border); background:var(--card); color:var(--text); width:180px"
    />
    {#if oppHistory.length > 0}
      <button
        onclick={() => downloadCSV(oppHistory, "unranked_opponent_history.csv")}
        style="font-size:11px; background:var(--card); border:1px solid var(--border); color:var(--muted); padding:2px 8px; border-radius:4px; cursor:pointer"
      >Export CSV</button>
      {#if csvFlash}
        <span style="font-size:11px; color:var(--win)">✓ Saved to Downloads</span>
      {/if}
    {/if}
  </div>
  <div class="card" style="padding:0; overflow:hidden; max-height:320px; overflow-y:auto">
    <table>
      <thead>
        <tr>
          <th>Opponent</th>
          <th>Games</th>
          <th>W</th>
          <th>L</th>
          <th>Win %</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredOpp as o}
          <tr>
            <td>{o.code}</td>
            <td>{o.games}</td>
            <td class="win-text">{o.wins}</td>
            <td class="loss-text">{o.losses}</td>
            <td class={o.pct >= 50 ? "win-text" : "loss-text"}>{o.pct.toFixed(1)}%</td>
          </tr>
        {/each}
        {#if filteredOpp.length === 0}
          <tr>
            <td colspan="5" style="text-align:center; color:var(--muted); padding:16px">No results</td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>
{/if}
