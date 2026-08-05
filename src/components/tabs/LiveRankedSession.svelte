<script lang="ts">
  import {
    isPremium, watcherActive, activeSet, liveSessionStartRating,
    snapshots, liveGameStats, lastSetGrade,
    statsOverlayEnabled, statsOverlayExpanded, statsOverlayPayload, statsOverlayLayout,
    statsOverlayPreview, liveSetRecord, liveUnrankedRecord, setResultFromGames,
    statsOverlayVisibility, type OverlayVisibility,
  } from "../../lib/store";
  import { get } from "svelte/store";
  import { CHARACTERS, STAGES, getRankTier } from "../../lib/parser";
  import { RANK_MEDAL_SVGS } from "../../lib/rank-medals";
  import { gradeColor } from "../../lib/grading";
  import { elapsedMs, formatElapsed } from "../../lib/session-timer";
  import { ensureStatsOverlayFiles, statsOverlayHtmlPath, statsOverlayPreviewPath, writeStatsOverlayPreviewFile } from "../../lib/stats-overlay";
  import { pingTelemetry } from "../../lib/telemetry";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import PremiumGate from "../PremiumGate.svelte";
  import OpponentNotes from "../OpponentNotes.svelte";
  import NoteLookup from "../NoteLookup.svelte";

  // ── Live Stats overlay (OBS) ───────────────────────────────────────────────
  const LAYOUT_OPTS: { id: "stacked" | "sidebyside"; label: string }[] = [
    { id: "sidebyside", label: "Side-by-side" },
    { id: "stacked",    label: "Stacked" },
  ];
  // Per-element overlay toggles, in display order. Each maps to a key on statsOverlayVisibility.
  const VIS_OPTS: { key: keyof OverlayVisibility; label: string }[] = [
    { key: "tag",          label: "Tag" },
    { key: "medal",        label: "Rank medal" },
    { key: "rank",         label: "Rank name" },
    { key: "mmr",          label: "Rating" },
    { key: "sessionDelta", label: "Session Rating change" },
    { key: "global",       label: "Global placement" },
    { key: "season",       label: "Season W/L" },
    { key: "today",        label: "Today's W/L" },
    { key: "opponent",     label: "Opponent line" },
    { key: "grade",        label: "Post-set grade" },
    { key: "setResult",    label: "Set result" },
    { key: "setRating",    label: "Set Rating change" },
  ];
  function toggleVis(key: keyof OverlayVisibility) {
    statsOverlayVisibility.update((v) => ({ ...v, [key]: !v[key] }));
  }
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
    // Pretend the session already had some gains so the per-set change (THIS SET) and the
    // cumulative session change (Today's stats) read as visibly different numbers in the demo.
    const base = { ...p, sessionWins: 1, sessionLosses: 1, sessionStartRating: before - 40, sessionDelta: 40, rating: before };
    const result = { setId, result: "win" as const, wins: 2, losses: 1, opponentCode: code, opponentChar: char, opponentCharId: 2, ratingBefore: before, gradeLetter: "A", subLabel: "Punish", subLetter: "S", subStatLabel: "Openings / Kill", subStatLetter: "S" };

    const ot = getRankTier(before + 80, p.globalRank != null);
    // Live set: opponent line shows their profile mains as icons (Fox + Falco here).
    statsOverlayPreview.set({ ...base, opponent: { code, mode: "ranked" as const, char, charIds: [2, 20], tier: ot.name, tierColor: ot.color, rating: before + 80, tag: "Sample", seasonWins: 412, seasonLosses: 388, gamesWon: 1, gamesLost: 1 }, lastSet: null });
    // Set ends: grade + result shown; MMR refetch hasn't landed yet (rating still == ratingBefore),
    // so the THIS SET line is intentionally absent here.
    simTimers.push(setTimeout(() => statsOverlayPreview.set({ ...base, opponent: null, sessionWins: 2, lastSet: result }), 6000));
    // Refetch lands: rating climbs, the THIS SET change (+78) appears and Today's change updates (+118).
    simTimers.push(setTimeout(() => {
      const t = getRankTier(before + 78, p.globalRank != null);
      statsOverlayPreview.set({ ...base, rating: before + 78, rankName: t.name, rankColor: t.color, opponent: null, sessionWins: 2, sessionDelta: 118, lastSet: result });
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
    // layout + visibility are re-applied from the live stores rather than taken from the
    // (possibly frozen) simulation snapshot — see the matching comment in App.svelte.
    const payload = { ...previewPayload, layout: $statsOverlayLayout, show: $statsOverlayVisibility };
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

  // ── Session clock (unranked/direct only) ───────────────────────────────────
  // A ranked set is a bounded best-of-3 that ends by itself, so there's nothing to time. An
  // unranked/direct match_id is the whole connection with that opponent and has no end event,
  // so how long you've been at it is otherwise invisible.
  let nowMs = $state(Date.now());

  $effect(() => {
    const s = $activeSet;
    if (!s || s.mode === "ranked") return;   // no interval running while ranked / idle
    nowMs = Date.now();                       // don't show a stale second on the first frame
    const id = setInterval(() => { nowMs = Date.now(); }, 1000);
    return () => clearInterval(id);
  });

  let runClock = $derived.by(() => {
    const s = $activeSet;
    if (!s || s.mode === "ranked") return null;
    const ms = elapsedMs(s.run_started_at, nowMs);
    return ms === null ? null : formatElapsed(ms);
  });

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

  // The per-game list shows every game of the match and scrolls (an unranked/direct run shares
  // one match_id for the whole connection and can reach 50+ games). Newest game is at the
  // bottom, so the view follows it as games land — unless the user has scrolled up to read
  // older ones, in which case it stays put until they scroll back down.
  let gamesEl: HTMLDivElement | null = $state(null);
  // Plain lets, not $state: only ever read inside the effect/handler below, never in markup.
  let followLatest = true;
  let followedMatch = "";

  function onGamesScroll() {
    const el = gamesEl;
    if (!el) return;
    followLatest = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  $effect(() => {
    const matchId = lastMatch?.[0] ?? "";
    const count = lastMatch?.[1].length ?? 0;
    // A new opponent starts pinned to the latest game again.
    if (matchId !== followedMatch) {
      followedMatch = matchId;
      followLatest = true;
    }
    if (gamesEl && followLatest && count > 0) gamesEl.scrollTop = gamesEl.scrollHeight;
  });

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
    // Only ranked has sets to complete. An unranked/direct run shares one match_id for the
    // whole connection, so the first-to-2 test would declare it "won" after two games and
    // keep that label for the next fifty.
    if (games[0]?.match_type !== "ranked") return false;
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

  function fmtRatio(v: number | null, decimals = 1): string {
    return v !== null ? v.toFixed(decimals) : "—";
  }

  function fmtPct(v: number | null): string {
    return v !== null ? (v * 100).toFixed(0) + "%" : "—";
  }

  // Win rate of a W–L record, for the opponent's season lines. Slippi shows ranked records as
  // raw W–L; the percentage is the part you'd otherwise work out in your head mid-set.
  function winRate(wins: number, losses: number): string {
    const played = wins + losses;
    return played > 0 ? Math.round((wins / played) * 100) + "%" : "—";
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
          One always-on panel: tag, rank, Rating, global placement, season W/L, today's gains — plus your set grade + result when a set ends.
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

          <!-- Per-element visibility -->
          <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px">Show on overlay</div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px">
            {#each VIS_OPTS as opt}
              {@const on = $statsOverlayVisibility[opt.key]}
              <button
                type="button"
                onclick={() => toggleVis(opt.key)}
                aria-pressed={on}
                title={on ? "Showing — click to hide" : "Hidden — click to show"}
                style="
                  padding: 5px 10px; border-radius: 6px; cursor: pointer;
                  font-family: inherit; font-size: 11px; font-weight: 700;
                  border: 1px solid {on ? '#2ecc7155' : 'var(--border)'};
                  background: {on ? '#2ecc7122' : 'var(--bg)'};
                  color: {on ? '#2ecc71' : 'var(--muted)'};
                "
              >{on ? "✓ " : ""}{opt.label}</button>
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
            Plays the full set-end sequence on your overlay (opponent → grade → Rating change), then returns to live.
            Your persistent stats are always shown straight from live data.
          </div>
          </div>
          </div>

          <div class="muted" style="font-size: 11px; margin-top: 14px; line-height: 1.5">
            Updates automatically as you play — and when a set ends it briefly shows the result, your grade, and the Rating change.
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Session numbers as one compact strip rather than a grid of cards at the bottom of the page.
       These are the "how's tonight going" figures you want in view the whole time, and as
       full-height cards below everything else they were both the least glanceable thing here and
       a chunk of what forced the scrolling. Always rendered, so an empty session shows the same
       shape with zeroes instead of needing a separate placeholder grid. -->
  <div class="session-strip">
    <div class="s-item">
      <span class="s-label">Sets</span>
      <span class="s-value"><span class="win-text">{$liveSetRecord.wins}</span>–<span class="loss-text">{$liveSetRecord.losses}</span></span>
    </div>
    <div class="s-item">
      <span class="s-label">Win rate</span>
      <span class="s-value">{$liveSetRecord.total > 0 ? (($liveSetRecord.wins / $liveSetRecord.total) * 100).toFixed(0) + "%" : "—"}</span>
    </div>
    {#if sessionDelta !== null}
      <div class="s-item">
        <span class="s-label">Rating</span>
        <span class="s-value" class:win-text={sessionDelta > 0} class:loss-text={sessionDelta < 0}>{fmtDelta(sessionDelta)}</span>
      </div>
    {/if}
    {#if $snapshots.at(-1)}
      <div class="s-item">
        <span class="s-label">Now</span>
        <span class="s-value">{$snapshots.at(-1)!.rating.toFixed(0)}</span>
      </div>
    {/if}
    {#if $liveSessionStartRating !== null}
      <div class="s-item">
        <span class="s-label">Started</span>
        <span class="s-value">{$liveSessionStartRating.toFixed(0)}</span>
      </div>
    {/if}
    <!-- Counted in games, not sets — unranked/direct have none. Only appears once some have
         actually been played, so a purely ranked session reads exactly as it did. -->
    {#if $liveUnrankedRecord.total > 0}
      <div class="s-item">
        <span class="s-label">Unranked/direct</span>
        <span class="s-value"><span class="win-text">{$liveUnrankedRecord.wins}</span>–<span class="loss-text">{$liveUnrankedRecord.losses}</span></span>
      </div>
    {/if}
  </div>

  <!-- Two columns on a wide window, one when narrow: the live match on the left, your notes on
       the right. Everything was previously full-width and stacked, which left a lot of dead
       horizontal space while still needing a scroll to reach the bottom. -->
  <div class="live-grid">
  <div class="live-col">

  <!-- NOW PLAYING card. Hoisted above the state branches below along with the notes panel:
       when the app launches into a set already in progress the watcher recovers the opponent
       from the DB, but those games are pre-existing so liveGameStats stays empty — this used to
       fall inside the "no games tracked yet" branch and hide the opponent we'd just identified. -->
  {#if $activeSet}
    <!-- Tier colour comes from the watcher (opponent_tier_color), which computed it with the
         opponent's leaderboard placement — recomputing it from rating alone here would drop
         Grandmaster back to a Master colour. -->
    {@const oppMedal = $activeSet.opponent_tier ? RANK_MEDAL_SVGS[$activeSet.opponent_tier] : ""}
    <div style="
      background: var(--card); border: 1px solid var(--border);
      border-left: 3px solid #2ecc71; border-radius: 8px;
      padding: 14px 16px; margin-bottom: 16px;
    ">
      <div style="font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: #2ecc71; margin-bottom: 10px">
        NOW PLAYING
      </div>
      <!-- Fixed proportions rather than space-between: the old flex row pushed the three
           blocks to the far edges of a wide window and left a void in the middle. -->
      <div style="
        display: grid; grid-template-columns: minmax(0, 1.5fr) auto minmax(0, 1fr);
        align-items: center; gap: 20px;
      ">
        <!-- Opponent identity -->
        <div style="display: flex; align-items: center; gap: 12px; min-width: 0">
          {#if oppMedal}
            <div style="width: 42px; height: 42px; flex-shrink: 0" aria-hidden="true">
              {@html oppMedal}
            </div>
          {/if}
          <div style="min-width: 0">
            <div style="
              font-size: 17px; font-weight: 700; line-height: 1.2;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            ">{$activeSet.opponent_tag || $activeSet.opponent_code}</div>
            {#if $activeSet.opponent_tag}
              <div style="font-size: 11px; color: var(--muted)">{$activeSet.opponent_code}</div>
            {/if}
            {#if $activeSet.opponent_rating !== null}
              <!-- An unranked player's rating is Slippi's 1100 placeholder (or a provisional
                   mid-placement number), so printing it would present a non-number as fact. -->
              <div style="font-size: 12px; color: {$activeSet.opponent_tier_color ?? 'var(--muted)'}">
                {#if $activeSet.opponent_tier === "Unranked"}
                  Unranked
                {:else}
                  {$activeSet.opponent_tier ?? ""} · {$activeSet.opponent_rating.toFixed(0)}
                {/if}
              </div>
            {:else}
              <div style="font-size: 12px; color: var(--muted)">Fetching rank…</div>
            {/if}
            <!-- Their ranked record this season, straight off their Slippi profile. Someone
                 who hasn't played yet gets a plain note instead of "0W–0L (—)", which reads
                 like a missing value rather than a fact about them. -->
            {#if $activeSet.opponent_season_wins !== null && $activeSet.opponent_season_losses !== null}
              {@const sw = $activeSet.opponent_season_wins}
              {@const sl = $activeSet.opponent_season_losses}
              {#if sw + sl > 0}
                <div style="font-size: 12px; margin-top: 1px">
                  <span class="win-text">{sw}W</span>–<span class="loss-text">{sl}L</span>
                  <span style="color: var(--muted)">({winRate(sw, sl)}) this season</span>
                </div>
              {:else}
                <div style="font-size: 12px; margin-top: 1px; color: var(--muted)">
                  No ranked games this season
                </div>
              {/if}
            {/if}
            <!-- >= 0 rather than != null: the game-start peek leaves this as -1 because the
                 character only becomes known from the metadata block when the game ends. -->
            {#if $activeSet.opponent_char_id >= 0}
              <div style="font-size: 11px; color: var(--muted)">
                {CHARACTERS[$activeSet.opponent_char_id] ?? `Char ${$activeSet.opponent_char_id}`}
              </div>
            {/if}
          </div>
        </div>
        <div style="text-align: center">
          <div style="font-size: 30px; font-weight: 700; letter-spacing: 4px; line-height: 1">
            <span class="win-text">{$activeSet.games_won}</span>
            <span style="color: var(--muted)">–</span>
            <span class="loss-text">{$activeSet.games_lost}</span>
          </div>
          <div style="font-size: 10px; color: var(--muted); margin-top: 2px">
            {$activeSet.mode === "ranked" ? "Current Set" : "Games This Session"}
          </div>
          <!-- Unranked/direct only: how long this connection has been going. Ranked sets end on
               their own, so there's nothing to count. Survives the 15-minute idle clear, so a
               run that goes quiet and resumes under the same match_id keeps its total. -->
          {#if runClock}
            <div class="run-clock" title="Time playing this opponent">
              <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"
                   fill="none" stroke="currentColor" stroke-width="2.4"
                   stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <span>{runClock}</span>
            </div>
          {/if}
        </div>
        <div style="text-align: right">
          {#if $activeSet.all_time_wins + $activeSet.all_time_losses > 0}
            <div style="font-size: 13px">
              All-time: <span class="win-text">{$activeSet.all_time_wins}W</span>–<span class="loss-text">{$activeSet.all_time_losses}L</span>
            </div>
            <div style="font-size: 11px; color: var(--muted)">
              {$activeSet.all_time_unit === "sets" ? "sets" : "games"} vs this opponent
            </div>
          {:else}
            <div style="font-size: 13px; color: var(--muted)">First match vs<br/>this opponent</div>
          {/if}
          {#if $activeSet.session_already_faced}
            <div style="font-size: 11px; color: #f39c12; margin-top: 4px">⚠ Rematch this session</div>
          {/if}
        </div>
      </div>

      <!-- Where they finished last season. A full-width footer rather than another line in the
           identity column: that column is already the tallest of the three, and the season name
           needs the room. The name is spelled out because Slippi's profile history skips seasons
           a player sat out — for a returning player this may be several seasons back. -->
      {#if $activeSet.opponent_prev_season}
        {@const ps = $activeSet.opponent_prev_season}
        {@const psMedal = RANK_MEDAL_SVGS[ps.tier] ?? ""}
        <div style="
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
          margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);
          font-size: 12px;
        ">
          <span style="font-size: 10px; font-weight: 700; letter-spacing: 0.06em; color: var(--muted)">
            {ps.name.toUpperCase()}
          </span>
          {#if psMedal}
            <div style="width: 20px; height: 20px; flex-shrink: 0" aria-hidden="true">
              {@html psMedal}
            </div>
          {/if}
          <span style="color: {ps.tier_color}; font-weight: 600">{ps.tier}</span>
          {#if ps.tier !== "Unranked"}
            <span style="color: var(--muted)">· {ps.rating.toFixed(0)}</span>
          {/if}
          <span>
            <span class="win-text">{ps.wins}W</span>–<span class="loss-text">{ps.losses}L</span>
            <span style="color: var(--muted)">({winRate(ps.wins, ps.losses)})</span>
          </span>
        </div>
      {/if}
    </div>
  {/if}

  {#if !$watcherActive}
    <p class="muted" style="margin-bottom: 16px">
      Monitoring will begin automatically when a game is detected.
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
          Head into a ranked, unranked or direct match and this page will update automatically — no need to refresh.
        </div>
      </div>
    </div>

    <!-- No placeholder stat grid here any more: the session strip above is always rendered and
         already shows the zeroed figures, so duplicating them was pure height. -->

  {:else}

    <!-- Per-game stats for the current/last match -->
    {#if lastMatch}
      {@const [matchId, allGames] = lastMatch}
      {@const complete = isSetComplete(allGames)}
      {@const isRankedMatch = allGames[0]?.match_type === "ranked"}
      <div class="card" style="margin-bottom: 16px">
        <div class="section-title" style="margin-bottom: 10px">
          {complete
            ? `Set ${setResult(allGames) === "win" ? "Won" : "Lost"}`
            : isRankedMatch ? "Games This Set" : "Games This Session"}
          <span style="font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 6px">
            vs {allGames[0].opponent_code}
          </span>
          {#if !isRankedMatch && allGames.length > 1}
            <span style="font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 6px">
              ({allGames.length} games)
            </span>
          {/if}
        </div>

        <!-- Every game of the match, scrollable. An unranked/direct run can reach 50+ games on
             one connection, so the list is capped at a share of the window height: a tall window
             stretches to show more rows, a short one gets a scrollbar. Ranked sets are 2–3 games
             and never reach the cap. -->
        <div
          class="game-list"
          bind:this={gamesEl}
          onscroll={onGamesScroll}
          style="margin-bottom: {complete ? '12px' : '0'}"
        >
          <!-- Column headers — sticky so they survive scrolling a long run -->
          <div class="game-grid game-head">
            <div></div>
            <div>Stage</div>
            <div>K / D</div>
            <div>Opn/Kill</div>
            <div>Neutral</div>
            <div>Dmg/Opn</div>
            <div style="text-align:right">Time</div>
          </div>

          <!-- Per-game rows -->
          <!-- Rows stay compact because an unranked run stacks dozens of them; at the old
               8px/6px spacing that block dominated the tab. -->
          <div class="game-rows">
            {#each allGames as g, i}
              {@const isWin = g.result === "win" || g.result === "lras_win"}
              <div class="game-grid game-row" style="border-left-color: {isWin ? '#2ecc71' : '#e74c3c'}">
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

      </div>

      <!-- Post-set grade reveal — hides automatically when a new set starts -->
      {#if complete && $lastSetGrade}
        {@render gradeRevealCard(
          $lastSetGrade.letter,
          `vs ${allGames[0].opponent_code} · ${$lastSetGrade.setResult === "win" ? "Win" : "Loss"} ${$lastSetGrade.wins}–${$lastSetGrade.losses}`
        )}
      {/if}
    {/if}

  {/if}
  </div><!-- /.live-col -->

  <div class="live-col">
    <!-- Look a player up by the tag on your striking screen, and everything you've written about
         whoever is in front of you. Both resolve their own subject and render nothing when there
         isn't one, so this column simply collapses when there's nobody to show. -->
    <NoteLookup />
    <OpponentNotes />
  </div>
  </div><!-- /.live-grid -->
{/if}

<style>
  /* Session figures: one horizontal strip of label/value pairs. Wraps rather than scrolls, so a
     narrow window stacks them instead of clipping.

     Label sits ABOVE its value rather than beside it. Inline, the row read as one run-on
     sentence — "SETS 0–0 WIN RATE — RATING +0.0" — because the 7px label/value gap and the 22px
     item gap were close enough that nothing marked where one figure ended and the next began. */
  .session-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 4px 2px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 6px;
    margin-bottom: 16px;
  }

  .s-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 7px 16px;
  }

  /* Hairline between neighbours, drawn as an inset shadow rather than a border so it costs no
     layout width (a border would shift every figure 1px as items appear and vanish). No radius
     on .s-item on purpose: rounded corners would clip this into a curved tick instead of a
     clean full-height rule. A wrapped row can lead with a divider — accepted. */
  .s-item + .s-item {
    box-shadow: inset 1px 0 0 var(--border);
  }

  .s-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--muted);
    white-space: nowrap;
  }

  .s-value {
    font-size: 17px;
    font-weight: 700;
    line-height: 1.1;
    white-space: nowrap;
    /* Equal-width digits: these tick over live, and proportional figures make the whole strip
       twitch sideways every time a number changes width. */
    font-variant-numeric: tabular-nums;
  }

  /* Session clock under the running score. Tabular figures so a ticking second never nudges the
     scoreboard sideways, and a fixed pill so 9:59 → 10:00 → 1:00:00 doesn't reflow the column. */
  .run-clock {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    margin-top: 7px;
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    white-space: nowrap;
  }

  /* Two columns when there's room for both to be useful, one when there isn't. auto-fit with a
     min track means the breakpoint follows the actual available width — including after a
     Ctrl +/− zoom, which now re-runs layout rather than just scaling the pixels. */
  .live-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 0 16px;
    align-items: start;
  }

  /* Each column owns its own vertical rhythm; the cards inside already carry bottom margins. */
  .live-col {
    min-width: 0;
  }

  /* Per-game list for the current match. The cap is viewport-relative so the list stretches
     on a tall window and scrolls on a short one, instead of being truncated to a fixed count. */
  .game-list {
    max-height: clamp(140px, 48vh, 620px);
    overflow-y: auto;
  }

  .game-grid {
    display: grid;
    grid-template-columns: 26px minmax(0, 1.5fr) repeat(4, minmax(0, 1fr)) minmax(0, 0.7fr);
    gap: 8px;
  }

  /* Sticky inside the scroll container, so it shrinks with the rows when the scrollbar
     appears and stays aligned with them (a header outside the container would not). */
  .game-head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--card);
    padding: 0 10px 4px;
    font-size: 10px;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.04em;
  }

  .game-rows {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .game-row {
    align-items: center;
    background: var(--bg);
    border-radius: 6px;
    padding: 5px 10px;
    border-left: 3px solid transparent;
  }

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
