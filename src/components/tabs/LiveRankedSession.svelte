<script lang="ts">
  import {
    isPremium, watcherActive, activeSet, liveSessionStartRating,
    snapshots, liveGameStats, sets, lastSetGrade,
    statsOverlayEnabled, statsOverlayExpanded, statsOverlayPayload, statsOverlayLayout,
    statsOverlayPreview, liveSetRecord, setResultFromGames,
  } from "../../lib/store";
  import { get } from "svelte/store";
  import { CHARACTERS, STAGES, getRankTier } from "../../lib/parser";
  import { gradeColor } from "../../lib/grading";
  import { ensureStatsOverlayFiles, statsOverlayHtmlPath, statsOverlayPreviewPath, writeStatsOverlayPreviewFile } from "../../lib/stats-overlay";
  import { pingTelemetry } from "../../lib/telemetry";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import LineChart from "../charts/LineChart.svelte";
  import PremiumGate from "../PremiumGate.svelte";

  // ── Live Stats overlay (OBS) ───────────────────────────────────────────────
  const LAYOUT_OPTS: { id: "stacked" | "sidebyside"; label: string }[] = [
    { id: "sidebyside", label: "Side-by-side" },
    { id: "stacked",    label: "Stacked" },
  ];
  // Always-on panel. The actual state writes happen at the app root (App.svelte);
  // here we just toggle it, show the file path, and preview the live payload.
  let statsOverlayPath = $state("");
  let statsPathCopied  = $state(false);

  $effect(() => { statsOverlayHtmlPath().then((p) => (statsOverlayPath = p)).catch(() => {}); });

  async function toggleStatsOverlay() {
    const next = !$statsOverlayEnabled;
    statsOverlayEnabled.set(next);
    if (next) {
      statsOverlayExpanded.set(true);
      pingTelemetry("overlay_enabled");
      try { await ensureStatsOverlayFiles(); } catch (e) { console.error("stats overlay setup failed", e); }
    } else {
      stopPreview();
    }
  }

  async function copyStatsPath() {
    try {
      await navigator.clipboard.writeText(statsOverlayPath);
      statsPathCopied = true;
      setTimeout(() => (statsPathCopied = false), 1500);
    } catch (e) { console.error(e); }
  }

  // ── Test: simulate a set result on the overlay, no set required ─────────────
  let simTimers: ReturnType<typeof setTimeout>[] = [];

  function clearSimTimers() { simTimers.forEach((t) => clearTimeout(t)); simTimers = []; }
  function stopPreview() { clearSimTimers(); statsOverlayPreview.set(null); }

  // Play the full set-end sequence on the overlay: live set → grade → MMR climb → back to live.
  function simulateSet() {
    clearSimTimers();
    const p = get(statsOverlayPayload);
    const before = p.rating ?? 1850;
    const setId = Date.now();
    const code = "OPP#123", char = "Fox";
    const base = { ...p, sessionWins: 0, sessionLosses: 0, sessionStartRating: before, sessionDelta: 0, rating: before };
    const result = { setId, result: "win" as const, wins: 2, losses: 1, opponentCode: code, opponentChar: char, ratingBefore: before, gradeLetter: "A", subLabel: "Punish", subLetter: "S", subStatLabel: "Openings / Kill", subStatLetter: "S" };

    const ot = getRankTier(before + 80, p.globalRank != null);
    statsOverlayPreview.set({ ...base, opponent: { code, char, tier: ot.name, tierColor: ot.color, rating: before + 80, tag: "Sample", seasonWins: 412, seasonLosses: 388, gamesWon: 1, gamesLost: 1 }, lastSet: null });
    simTimers.push(setTimeout(() => statsOverlayPreview.set({ ...base, opponent: null, sessionWins: 1, lastSet: result }), 6000));
    simTimers.push(setTimeout(() => {
      const t = getRankTier(before + 78, p.globalRank != null);
      statsOverlayPreview.set({ ...base, rating: before + 78, rankName: t.name, rankColor: t.color, opponent: null, sessionWins: 1, sessionDelta: 78, lastSet: result });
    }, 10000));
    simTimers.push(setTimeout(() => statsOverlayPreview.set(null), 38000));
  }

  // The exact payload the live preview renders: the simulate/test override if active, else the
  // real live payload with any completed set suppressed (the idle preview shows just the panel).
  let previewPayload = $derived($statsOverlayPreview ?? { ...$statsOverlayPayload, lastSet: null });
  // Transient content (opponent line during a set, or post-set grade) sits below the persistent
  // panel, so the preview box must grow taller when it's present or overflow:hidden clips it.
  let previewHasTransient = $derived(!!(previewPayload.opponent || previewPayload.lastSet));

  // The in-app preview loads a baked preview.html (payload inlined, no polling) via the asset
  // protocol. A real-URL frame doesn't inherit the app's strict CSP, so its inline script runs
  // (a srcdoc iframe would be blocked by script-src 'self'); baking the payload in also avoids
  // the live page's relative stats-state.js fetch, which the asset protocol's encoded single-
  // segment path can't resolve. It's a separate file from the OBS stats.html, so the two never
  // interfere. previewVer bumps after each write to cache-bust the iframe so it reloads.
  let previewPath = $state("");
  let previewVer  = $state(0);
  $effect(() => { statsOverlayPreviewPath().then((p) => (previewPath = p)).catch(() => {}); });
  $effect(() => {
    if (!$statsOverlayExpanded) return;
    const payload = { ...previewPayload, layout: $statsOverlayLayout };
    (async () => {
      try { await writeStatsOverlayPreviewFile(payload); previewVer++; }
      catch (e) { console.error("overlay preview write failed", e); }
    })();
  });
  // Only point the iframe at the file once it's been written at least once (previewVer > 0),
  // so it never loads a not-yet-existing preview.html (which would 404 to a blank box).
  let previewSrc = $derived(previewPath && previewVer > 0 ? convertFileSrc(previewPath) + "?v=" + previewVer : "");

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

  // Session set W/L (today's record) comes from the shared `liveSetRecord` store so
  // the tab and the stats overlay always agree.


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
    // Forfeit-aware (mirrors the watcher): a quit-out ends the set once a full game was played.
    const endedByQuit = games.some((g) => g.result === "lras_win" || g.result === "lras_loss");
    const hasFullGame = games.some((g) => g.result === "win" || g.result === "loss");
    return Math.max(wins, losses) >= 2 || (endedByQuit && hasFullGame);
  }

  function setResult(games: typeof $liveGameStats): "win" | "loss" {
    return setResultFromGames(games);
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

{#snippet gradeRevealCard(letter: string, subtitle?: string)}
  {#key letter}
    <div class="grade-reveal">
      <div class="grade-reveal-label">Last Set Grade</div>
      {#if subtitle}
        <div style="font-size:11px; color:var(--muted); margin-bottom:6px">{subtitle}</div>
      {/if}
      <div class="grade-reveal-letter" style="color: {gradeColor(letter)}">{letter}</div>
      <div class="grade-reveal-hint">Check the Grading tab for a full breakdown.</div>
    </div>
  {/key}
{/snippet}

{#if !$isPremium}
  <PremiumGate
    featureName="Live Session Tracking"
    description="Live session tracking includes NOW PLAYING, per-game stats (openings/kill, neutral win rate), and session rating delta. Premium also unlocks in-depth set grades with per-category scores, a full 14-stat breakdown, and matchup grade averages in the Grading tab. Support on Ko-fi or Patreon to unlock access."
  />

{:else}

  <!-- Live Stats Overlay (OBS) — always-on panel (tag / rank / MMR / global / season +
       today's session record), written to a local file OBS reads as a Browser Source. -->
  <div class="card" style="margin-bottom: 16px">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
      <div>
        <div style="font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px">
          <span>📊</span> Live Stats Overlay
          <span style="font-size: 10px; font-weight: 700; color: #29ABE0; border: 1px solid #29ABE055; border-radius: 4px; padding: 1px 6px">OBS</span>
        </div>
        <div style="font-size: 12px; color: var(--muted); margin-top: 3px">
          One always-on panel: tag, rank, MMR, global placement, season W/L, today's gains — plus your set grade + result when a set ends.
        </div>
      </div>
      <button
        type="button"
        onclick={toggleStatsOverlay}
        aria-pressed={$statsOverlayEnabled}
        style="
          flex-shrink: 0; min-width: 64px; padding: 6px 14px; border-radius: 6px;
          font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit;
          border: 1px solid {$statsOverlayEnabled ? '#2ecc7155' : 'var(--border)'};
          background: {$statsOverlayEnabled ? '#2ecc7122' : 'var(--bg)'};
          color: {$statsOverlayEnabled ? '#2ecc71' : 'var(--muted)'};
        "
      >{$statsOverlayEnabled ? "On" : "Off"}</button>
    </div>

    {#if $statsOverlayEnabled}
      <button
        type="button"
        onclick={() => statsOverlayExpanded.set(!$statsOverlayExpanded)}
        style="
          margin-top: 10px; background: none; border: none; padding: 0; cursor: pointer;
          font-family: inherit; font-size: 11px; color: var(--muted);
          text-decoration: underline; text-underline-offset: 2px;
        "
      >{$statsOverlayExpanded ? "Hide setup ▴" : "Setup ▾"}</button>

      {#if $statsOverlayExpanded}
        {@const p = $statsOverlayPayload}
        {@const side = $statsOverlayLayout === "sidebyside"}
        <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px">
          <div style="display: flex; gap: 18px; flex-wrap: wrap; align-items: flex-start">
          <!-- LEFT column: layout + OBS source -->
          <div style="flex: 1 1 300px; min-width: 280px">
          <!-- Layout -->
          <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px">Layout</div>
          <div style="display: flex; gap: 6px; margin-bottom: 14px">
            {#each LAYOUT_OPTS as opt}
              {@const active = $statsOverlayLayout === opt.id}
              <button
                type="button"
                onclick={() => statsOverlayLayout.set(opt.id)}
                aria-pressed={active}
                style="
                  flex: 1; padding: 7px 10px; border-radius: 6px; cursor: pointer;
                  font-family: inherit; font-size: 12px; font-weight: 700;
                  border: 1px solid {active ? '#2ecc7155' : 'var(--border)'};
                  background: {active ? '#2ecc7122' : 'var(--bg)'};
                  color: {active ? '#2ecc71' : 'var(--muted)'};
                "
              >{opt.label}</button>
            {/each}
          </div>

          <!-- Step 1: the file path -->
          <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px">
            In OBS: <strong>Sources → + → Browser</strong>, check <strong>Local file</strong>, and select:
          </div>
          <div style="display: flex; gap: 8px; align-items: center">
            <code style="
              flex: 1; font-size: 11px; background: var(--bg); border: 1px solid var(--border);
              border-radius: 6px; padding: 8px 10px; overflow-x: auto; white-space: nowrap;
            ">{statsOverlayPath || "resolving…"}</code>
            <button
              type="button"
              onclick={copyStatsPath}
              style="
                flex-shrink: 0; padding: 8px 12px; border-radius: 6px; cursor: pointer;
                font-family: inherit; font-size: 12px; font-weight: 600;
                border: 1px solid var(--border); background: var(--bg); color: var(--text);
              "
            >{statsPathCopied ? "Copied" : "Copy"}</button>
          </div>
          <div class="muted" style="font-size: 11px; margin-top: 5px; line-height: 1.5">
            Transparent background. Set the Browser Source's <strong>Width/Height</strong> to the size you want
            on stream (bigger = bigger overlay) and leave its scene scale at 100% — stretching the source in
            the scene upsamples it and looks soft. The panel scales to fit whatever size you give it.
          </div>
          </div>

          <!-- RIGHT column: live preview + test -->
          <div style="flex: 1 1 320px; min-width: 300px">
          <!-- Live preview (honors the layout above) -->
          <div style="font-size: 12px; font-weight: 600; margin: 0 0 6px">
            Live preview — what's on your overlay now:
          </div>
          <!-- The preview IS the real overlay: the iframe loads the same stats.html OBS uses
               (via the asset protocol), so it can never drift from what OBS shows. aspect-ratio
               gives a responsive box; it must grow taller when transient content (the opponent
               line during a set, or the post-set grade) is present, since that area sits below
               the persistent panel and would otherwise be clipped by overflow:hidden.
               (aspect-ratio is relative to the box's own width, unlike padding-top %.) -->
          <div style="
            position: relative; width: 100%; overflow: hidden;
            border: 1px solid var(--border); border-radius: 8px; background: #15171b;
            {side
              ? (previewHasTransient ? 'aspect-ratio: 1.3;' : 'aspect-ratio: 2;')
              : 'max-width: 280px; ' + (previewHasTransient ? 'aspect-ratio: 1 / 1.5;' : 'aspect-ratio: 1 / 1.05;')}
          ">
            {#if previewSrc}
              <iframe
                title="Live overlay preview"
                src={previewSrc}
                scrolling="no"
                style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block;"
              ></iframe>
            {/if}
          </div>

          <!-- Step 3: push test data to the actual OBS overlay -->
          <div style="font-size: 12px; font-weight: 600; margin: 14px 0 6px">
            Test it on your overlay — no set needed:
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              type="button"
              onclick={simulateSet}
              style="
                padding: 7px 12px; border-radius: 6px; cursor: pointer;
                font-family: inherit; font-size: 12px; font-weight: 700;
                border: 1px solid var(--border); background: var(--bg); color: var(--text);
              "
            >Simulate set result</button>
          </div>
          <div class="muted" style="font-size: 11px; margin-top: 6px; line-height: 1.5">
            Plays the full set-end sequence on your overlay (opponent → grade → MMR change), then returns to live.
            Your persistent stats are always shown straight from live data.
          </div>
          </div>
          </div>

          <div class="muted" style="font-size: 11px; margin-top: 14px; line-height: 1.5">
            Updates automatically as you play — and when a set ends it briefly shows the result, your grade, and the MMR change.
          </div>
        </div>
      {/if}
    {/if}
  </div>

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

      <!-- Post-set grade reveal — hides automatically when a new set starts -->
      {#if complete && $lastSetGrade}
        {@render gradeRevealCard(
          $lastSetGrade.letter,
          `vs ${games[0].opponent_code} · ${$lastSetGrade.setResult === "win" ? "Win" : "Loss"} ${$lastSetGrade.wins}–${$lastSetGrade.losses}`
        )}
      {/if}
    {/if}

    <!-- Session overview -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px">
      <div class="stat-card">
        <div class="label">Session Sets</div>
        <div class="value">
          <span class="win-text">{$liveSetRecord.wins}</span>–<span class="loss-text">{$liveSetRecord.losses}</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="label">Win Rate</div>
        <div class="value">
          {$liveSetRecord.total > 0 ? (($liveSetRecord.wins / $liveSetRecord.total) * 100).toFixed(1) + "%" : "—"}
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

<style>
  .grade-reveal {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px 16px 16px;
    margin-bottom: 16px;
    text-align: center;
    animation: gradeCardIn 0.35s ease-out both;
  }

  .grade-reveal-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--muted);
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  .grade-reveal-letter {
    font-size: 80px;
    font-weight: 800;
    line-height: 1;
    animation: gradeLetterPop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s both;
  }

  .grade-reveal-hint {
    font-size: 12px;
    color: var(--muted);
    margin-top: 10px;
  }

  @keyframes gradeCardIn {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @keyframes gradeLetterPop {
    from { opacity: 0; transform: scale(0.35); }
    to   { opacity: 1; transform: scale(1); }
  }
</style>
