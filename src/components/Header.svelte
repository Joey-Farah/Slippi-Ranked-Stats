<script lang="ts">
  import { headerStats, cleanSets as sets, snapshots, sidebarOpen } from "../lib/store";
  import { getRankTier } from "../lib/parser";

  // Recent form: last N sets
  let formCount = $state(10);
  const FORM_OPTIONS = [5, 10, 25];
</script>

<div class="card-grid">
  <!-- Rating (only shown when sidebar is collapsed) -->
  {#if !$sidebarOpen && $snapshots.length > 0}
    {@const snap = $snapshots.at(-1)!}
    {@const tier = getRankTier(snap.rating)}
    <div class="stat-card">
      <div class="label">Rating</div>
      <div class="value">{snap.rating.toFixed(1)}</div>
      <div class="sub">{tier.name}</div>
    </div>
  {/if}

  <!-- Set Win % -->
  <div class="stat-card">
    <div class="label">Set Win %</div>
    <div class="value">{$headerStats.setWinPct.toFixed(1)}%</div>
  </div>

  <!-- Set Wins -->
  <div class="stat-card">
    <div class="label">Set Wins</div>
    <div class="value win-text">{$headerStats.setWins}</div>
  </div>

  <!-- Set Losses -->
  <div class="stat-card">
    <div class="label">Set Losses</div>
    <div class="value loss-text">{$headerStats.setLosses}</div>
  </div>

  <!-- Global Rank -->
  <div class="stat-card">
    <div class="label">Global Rank</div>
    <div class="value">
      {$headerStats.globalRank > 0 ? "#" + $headerStats.globalRank.toLocaleString() : "—"}
    </div>
  </div>

  <!-- Streak -->
  <div class="stat-card">
    <div class="label">Streak</div>
    <div
      class="value"
      class:win-text={$headerStats.streak > 0}
      class:loss-text={$headerStats.streak < 0}
    >
      {$headerStats.streak > 0 ? "🔥 " : ""}{$headerStats.streak > 0 ? "+" : ""}{$headerStats.streak}
    </div>
  </div>

  <!-- Best Streak -->
  <div class="stat-card">
    <div class="label">Best Streak</div>
    <div class="value win-text">{$headerStats.bestStreak}</div>
  </div>
</div>

<!-- Recent Form Dots -->
<div class="form-dots" style="align-items: center; gap: 6px">
  <span class="muted" style="font-size:11px; margin-right:4px">Recent:</span>
  {#each $sets.slice(-formCount) as s}
    <div
      class="dot {s.result}"
      title="{s.opponent_code} — {s.wins}-{s.losses}"
    ></div>
  {/each}
  <select
    bind:value={formCount}
    style="width:60px; margin-left:auto; font-size:11px; padding:3px 6px"
  >
    {#each FORM_OPTIONS as n}
      <option value={n}>{n}</option>
    {/each}
  </select>
</div>
