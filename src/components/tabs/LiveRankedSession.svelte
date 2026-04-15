<script lang="ts">
  import {
    isPremium, watcherActive, activeSet, liveSessionStartRating,
    snapshots, liveGameStats, sets, lastSetGrade,
  } from "../../lib/store";
  import { CHARACTERS, STAGES, getRankTier } from "../../lib/parser";
  import LineChart from "../charts/LineChart.svelte";
  import PremiumGate from "../PremiumGate.svelte";
  import SetGradeDisplay from "../SetGradeDisplay.svelte";

  let sessionDelta = $derived(
    $liveSessionStartRating !== null && $snapshots.length > 0
      ? ($snapshots.at(-1)!.rating - $liveSessionStartRating)
      : null
  );

  // Group live game stats by match_id, preserving insertion order
  let statsByMatch = $derived((() => {
    const map = new Map<string, typeof $liveGameStats>();
    for (const g of $liveGameStats) {
      const arr = map.get(g.match_id) ?? [];
      arr.push(g);
      map.set(g.match_id, arr);
    }
    return [...map.entries()];
  })());

  // Most recent match
  let lastMatch = $derived(statsByMatch.at(-1));

  // Derive session set W/L directly from liveGameStats so it always reflects the current run
  let liveSetRecord = $derived((() => {
    let wins = 0, losses = 0;
    for (const [, games] of statsByMatch) {
      if (!isSetComplete(games)) continue;
      if (setResult(games) === "win") wins++; else losses++;
    }
    return { wins, losses, total: wins + losses };
  })());


  function fmtDelta(d: number): string {
    return (d >= 0 ? "+" : "") + d.toFixed(1);
  }

  function fmtDuration(frames: number): string {
    const totalSec = Math.round(frames / 60);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function isSetComplete(games: typeof $liveGameStats): boolean {
    const wins = games.filter((g) => g.result === "win" || g.result === "lras_win").length;
    const losses = games.length - wins;
    return Math.max(wins, losses) >= 2;
  }

  function setResult(games: typeof $liveGameStats): "win" | "loss" {
    const wins = games.filter((g) => g.result === "win" || g.result === "lras_win").length;
    return wins >= 2 ? "win" : "loss";
  }

  // Rolling 20-set win rate (all-time sets, not just live)
  let rolling = $derived((() => {
    const WINDOW = 20;
    const completedSets = $sets.filter((s) => Math.max(s.wins, s.losses) >= 2);
    if (completedSets.length < WINDOW) return [];
    return completedSets.slice(WINDOW - 1).map((_, i) => {
      const w = completedSets.slice(i, i + WINDOW);
      const wins = w.filter((s) => s.result === "win").length;
      return { x: String(i + WINDOW), y: (wins / WINDOW) * 100 };
    });
  })());

  function fmtRatio(v: number | null, decimals = 1): string {
    return v !== null ? v.toFixed(decimals) : "—";
  }

  function fmtPct(v: number | null): string {
    return v !== null ? (v * 100).toFixed(0) + "%" : "—";
  }
</script>

{#if !$isPremium}
  <PremiumGate
    featureName="Live Session Tracking"
    description="NOW PLAYING, per-game stats (openings/kill, neutral win rate), and session rating delta are available to Patreon supporters. Sign up for any tier at patreon.com/joeydonuts to unlock access."
  />

{:else}
  {#if !$watcherActive}
    <p class="muted" style="margin-bottom: 16px">
      Monitoring will begin automatically when a ranked game is detected.
    </p>
  {:else if $liveGameStats.length === 0}
    <!-- Empty state — watcher is running but no games this session yet -->
    <div style="
      background: var(--card); border: 1px solid var(--border);
      border-left: 3px solid var(--muted); border-radius: 8px;
      padding: 16px 20px; margin-bottom: 16px;
      display: flex; align-items: flex-start; gap: 14px;
    ">
      <div style="font-size: 22px; line-height: 1; padding-top: 2px">🎮</div>
      <div>
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px">No games tracked yet this session</div>
        <div style="font-size: 12px; color: var(--muted); line-height: 1.5">
          Head into a ranked match and this page will update automatically — no need to refresh.
        </div>
      </div>
    </div>

    <!-- Session overview with zeroed-out cards so the layout isn't empty -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; opacity: 0.4">
      <div class="stat-card"><div class="label">Session Sets</div><div class="value">0–0</div></div>
      <div class="stat-card"><div class="label">Win Rate</div><div class="value">—</div></div>
      <div class="stat-card"><div class="label">Rating Change</div><div class="value">—</div></div>
      {#if $liveSessionStartRating !== null}
        <div class="stat-card"><div class="label">Session Start</div><div class="value">{$liveSessionStartRating.toFixed(1)}</div></div>
      {/if}
    </div>

  {:else}

    <!-- NOW PLAYING card -->
    {#if $activeSet}
      {@const oppTier = $activeSet.opponent_tier
        ? { name: $activeSet.opponent_tier, color: getRankTier($activeSet.opponent_rating ?? 0).color }
        : null}
      <div style="
        background: var(--card); border: 1px solid var(--border);
        border-left: 3px solid #2ecc71; border-radius: 8px;
        padding: 14px 16px; margin-bottom: 16px;
      ">
        <div style="font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: #2ecc71; margin-bottom: 10px">
          NOW PLAYING
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px">
          <div>
            <div style="font-size: 18px; font-weight: 700">{$activeSet.opponent_code}</div>
            {#if $activeSet.opponent_rating !== null}
              <div style="font-size: 12px; color: {oppTier?.color ?? 'var(--muted)'}">
                {oppTier?.name ?? ""} · {$activeSet.opponent_rating.toFixed(0)}
              </div>
            {:else}
              <div style="font-size: 12px; color: var(--muted)">Fetching rating…</div>
            {/if}
            {#if $activeSet.opponent_char_id != null}
              <div style="font-size: 12px; color: var(--muted)">
                {CHARACTERS[$activeSet.opponent_char_id] ?? `Char ${$activeSet.opponent_char_id}`}
              </div>
            {/if}
          </div>
          <div style="text-align: center">
            <div style="font-size: 30px; font-weight: 700; letter-spacing: 4px; line-height: 1">
              <span class="win-text">{$activeSet.games_won}</span>
              <span style="color: var(--muted)">–</span>
              <span class="loss-text">{$activeSet.games_lost}</span>
            </div>
            <div style="font-size: 10px; color: var(--muted); margin-top: 2px">Current Set</div>
          </div>
          <div style="text-align: right">
            {#if $activeSet.all_time_wins + $activeSet.all_time_losses > 0}
              <div style="font-size: 13px">
                All-time: <span class="win-text">{$activeSet.all_time_wins}W</span>–<span class="loss-text">{$activeSet.all_time_losses}L</span>
              </div>
              <div style="font-size: 11px; color: var(--muted)">vs this opponent</div>
            {:else}
              <div style="font-size: 13px; color: var(--muted)">First match vs<br/>this opponent</div>
            {/if}
            {#if $activeSet.session_already_faced}
              <div style="font-size: 11px; color: #f39c12; margin-top: 4px">⚠ Rematch this session</div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- Per-game stats for the current/last match -->
    {#if lastMatch}
      {@const [matchId, games] = lastMatch}
      {@const complete = isSetComplete(games)}
      <div class="card" style="margin-bottom: 16px">
        <div class="section-title" style="margin-bottom: 10px">
          {complete ? `Set ${setResult(games) === "win" ? "Won" : "Lost"}` : "Games This Set"}
          <span style="font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 6px">
            vs {games[0].opponent_code}
          </span>
        </div>

        <!-- Column headers -->
        <div style="
          display: grid; grid-template-columns: 28px 1fr 60px 70px 65px 65px 48px;
          gap: 8px; padding: 0 10px 4px;
          font-size: 10px; font-weight: 600; color: var(--muted); letter-spacing: 0.04em;
        ">
          <div></div>
          <div>Stage</div>
          <div>K / D</div>
          <div>Opn/Kill</div>
          <div>Neutral</div>
          <div>Dmg/Opn</div>
          <div style="text-align:right">Time</div>
        </div>

        <!-- Per-game rows -->
        <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: {complete ? '12px' : '0'}">
          {#each games as g, i}
            {@const isWin = g.result === "win" || g.result === "lras_win"}
            <div style="
              display: grid; grid-template-columns: 28px 1fr 60px 70px 65px 65px 48px;
              align-items: center; gap: 8px;
              background: var(--bg); border-radius: 6px; padding: 8px 10px;
              border-left: 3px solid {isWin ? '#2ecc71' : '#e74c3c'};
            ">
              <div style="font-size: 11px; color: var(--muted)">G{i + 1}</div>
              <div style="font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                {STAGES[g.stage_id] ?? `Stage ${g.stage_id}`}
              </div>
              <div style="font-size: 12px">
                <span class="win-text">{g.kills}</span><span style="color:var(--muted)">/</span><span class="loss-text">{g.deaths}</span>
              </div>
              <div style="font-size: 11px">{fmtRatio(g.openings_per_kill)}</div>
              <div style="font-size: 11px">{fmtPct(g.neutral_win_ratio)}</div>
              <div style="font-size: 11px">{fmtRatio(g.damage_per_opening)}</div>
              <div style="font-size: 11px; color: var(--muted); text-align: right">
                {fmtDuration(g.duration_frames)}
              </div>
            </div>
          {/each}
        </div>

      </div>

      {#if import.meta.env.DEV && complete && $lastSetGrade && $lastSetGrade.wins + $lastSetGrade.losses === games.length}
        <SetGradeDisplay grade={$lastSetGrade} />
      {/if}
    {/if}

    <!-- Session overview -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px">
      <div class="stat-card">
        <div class="label">Session Sets</div>
        <div class="value">
          <span class="win-text">{liveSetRecord.wins}</span>–<span class="loss-text">{liveSetRecord.losses}</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="label">Win Rate</div>
        <div class="value">
          {liveSetRecord.total > 0 ? ((liveSetRecord.wins / liveSetRecord.total) * 100).toFixed(1) + "%" : "—"}
        </div>
      </div>
      {#if sessionDelta !== null}
        <div class="stat-card">
          <div class="label">Rating Change</div>
          <div class="value" class:win-text={sessionDelta > 0} class:loss-text={sessionDelta < 0}>
            {fmtDelta(sessionDelta)}
          </div>
        </div>
      {/if}
      {#if $liveSessionStartRating !== null}
        <div class="stat-card">
          <div class="label">Session Start</div>
          <div class="value">{$liveSessionStartRating.toFixed(1)}</div>
        </div>
      {/if}
      {#if $snapshots.at(-1)}
        <div class="stat-card">
          <div class="label">Current Rating</div>
          <div class="value">{$snapshots.at(-1)!.rating.toFixed(1)}</div>
        </div>
      {/if}
    </div>

  <!-- Rolling 20-set win rate -->
  {#if rolling.length > 0}
    <div class="card" style="margin-top:16px">
      <div class="section-title">Rolling 20-Set Win Rate</div>
      <div style="font-size:11px; color:var(--muted); margin-bottom:8px">Set win % across your last 20 completed sets.</div>
      <LineChart
        xData={rolling.map((d) => d.x)}
        yData={rolling.map((d) => d.y)}
        label="Win %"
        color="#7c3aed"
        fill={true}
        height={200}
      />
    </div>
  {/if}

  {/if}
{/if}
