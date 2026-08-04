<script lang="ts">
  import Sidebar from "./components/Sidebar.svelte";
  import Header from "./components/Header.svelte";
  import RankedSessions from "./components/tabs/RankedSessions.svelte";
  import MatchupStats from "./components/tabs/MatchupStats.svelte";
  import RatingProgression from "./components/tabs/RatingProgression.svelte";
  import LiveRankedSession from "./components/tabs/LiveRankedSession.svelte";
  import AllTimeStats from "./components/tabs/AllTimeStats.svelte";
  import GradeHistory from "./components/tabs/GradeHistory.svelte";
  import UnrankedStats from "./components/tabs/UnrankedStats.svelte";
  import Notes from "./components/tabs/Notes.svelte";
  import OnboardingView from "./components/OnboardingView.svelte";
  import { activeTab, connectCode, replayDirs, games, snapshots, seasons, sidebarOpen, isPremium, setResultFlash, discordToken, effectiveCodes, primaryCode, statsOverlayPayload, statsOverlayEnabled, statsOverlayPreview, statsOverlayLayout, statsOverlayVisibility, parserCapabilityVersion, uiZoom } from "./lib/store";
  import { pingTelemetry } from "./lib/telemetry";
  import { getDb, getGames, getSnapshots, getSeasons, pruneUnproductiveScannedFiles } from "./lib/db";
  import { startWatcher, stopWatcher } from "./lib/watcher";
  import { scanDirectory, PARSER_CAPABILITY_VERSION } from "./lib/parser";
  import { ensureStatsOverlayFiles, writeStatsOverlayState, OVERLAY_VERSION } from "./lib/stats-overlay";
  import { verifyPatronRoleWithRetry } from "./lib/discord";
  import { refreshNotes } from "./lib/notes";
  import { onOpenUrl, register } from "@tauri-apps/plugin-deep-link";
  import { get } from "svelte/store";
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";

  // Auto-dismiss the set result flash after 5 seconds
  let _flashTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    if ($setResultFlash) {
      if (_flashTimer) clearTimeout(_flashTimer);
      _flashTimer = setTimeout(() => setResultFlash.set(null), 5000);
    }
  });

  // Live Ranked Stats overlay: always-on, so the write lives at the app root (not a
  // tab) and runs even when statsOverlayEnabled persisted true from a prior session.
  // Ensures the files once per enable, then writes the payload whenever it changes.
  let _statsOverlayReady = false;
  let _lastStatsJson = "";
  let _lastEnsuredVersion = "";
  $effect(() => {
    // A non-null preview override (set by the Live Stats card's test controls) wins over
    // the live payload; layout and per-element visibility always track the real toggles so
    // they keep working during a preview. The override is a snapshot taken when the test
    // started — without re-applying these, flipping a "Show on overlay" chip mid-simulation
    // did nothing until the simulation ended.
    const preview = $statsOverlayPreview;
    const payload = preview
      ? { ...preview, layout: $statsOverlayLayout, show: $statsOverlayVisibility }
      : $statsOverlayPayload;
    if (!($isPremium && $statsOverlayEnabled)) {
      _statsOverlayReady = false;
      _lastStatsJson = "";
      return;
    }
    const json = JSON.stringify(payload);
    // Re-ensure (rewrite stats.html) on first run AND whenever the overlay build changes, so the
    // page on disk matches the version we stamp into the state. That ordering — new stats.html
    // written before the state announces the new version — lets a stale OBS source self-reload to
    // the new look with no manual "Refresh" (and avoids a reload loop). After an app update this
    // fires on launch; during dev it fires when the overlay code (hence OVERLAY_VERSION) changes.
    const needEnsure = !_statsOverlayReady || OVERLAY_VERSION !== _lastEnsuredVersion;
    if (!needEnsure && json === _lastStatsJson) return;
    // Record intent synchronously so rapid payload changes don't double-write.
    _statsOverlayReady = true;
    _lastStatsJson = json;
    _lastEnsuredVersion = OVERLAY_VERSION;
    (async () => {
      try {
        if (needEnsure) await ensureStatsOverlayFiles();
        await writeStatsOverlayState(payload);
      } catch (e) {
        _statsOverlayReady = false;        // retry the file-ensure next change
        _lastEnsuredVersion = "";
        console.error("stats overlay write failed", e);
      }
    })();
  });
  import { check } from "@tauri-apps/plugin-updater";
  import { relaunch } from "@tauri-apps/plugin-process";

  let updateAvailable = $state(false);
  let updateVersion = $state("");
  let updateNotes = $state("");
  let showUpdateNotes = $state(false);
  let isUpdating = $state(false);
  let updateError = $state("");

  function stripMarkdown(md: string): string {
    return md
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .trim();
  }

  onMount(async () => {
    // Register deep link scheme (needed in dev; installer handles production)
    try { await register("srs"); } catch { /* already registered or not needed */ }

    // Deep link listener (reserved for future use)
    onOpenUrl((_urls) => {});

    // Re-verify Discord patron status on launch if a token is stored,
    // otherwise ensure isPremium is false (clears any leftover test state).
    // Uses retry-with-backoff so existing patrons whose last check hit a
    // transient Discord 5xx auto-recover without re-linking.
    // Call without passing the token so verifyPatronRole reads it from the store and can
    // proactively refresh a near-expired access token before the check (see discord.ts).
    const token = get(discordToken);
    if (token) verifyPatronRoleWithRetry().catch(() => {});
    else isPremium.set(false);

    pingTelemetry("open");

    // Scouting notes are held in memory for the whole app session. Loaded here — not lazily
    // when the Notes tab is first opened — because the live session panel has to be able to
    // render them the instant an opponent is detected, whether or not that tab was ever
    // visited. The table is tiny; this is one small query at launch.
    refreshNotes().catch(() => {});

    try {
      const update = await check();
      if (update?.available) {
        updateAvailable = true;
        updateVersion = update.version;
        updateNotes = update.body ? stripMarkdown(update.body) : "";
      }
    } catch {
      // Silently ignore — no network or no release yet
    }
  });

  // Reload all data whenever the effective code list or primary code changes
  $effect(() => {
    const codes = $effectiveCodes;
    const primary = $primaryCode;
    if (codes.length === 0) return;
    (async () => {
      try {
        // Union games from all codes in the profile
        const allGameArrays = await Promise.all(
          codes.map(async (c) => {
            const db = await getDb(c);
            const rows = await getGames(db);
            return rows.map((g) => ({ ...g, sourceCode: c }));
          })
        );
        const merged = allGameArrays
          .flat()
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        games.set(merged);

        // Snapshots and seasons only from the primary code
        const primaryDb = await getDb(primary);
        const loadedSnaps = await getSnapshots(primaryDb, primary);
        snapshots.set(loadedSnaps);
        const loadedSeasons = await getSeasons(primaryDb, primary);
        seasons.set(loadedSeasons);

        // Watcher on primary code only
        const dirs = get(replayDirs).filter(Boolean);
        if (dirs.length > 0) {
          await stopWatcher();
          startWatcher(dirs, primary, primaryDb).catch(() => {});

          // Ingest replays created while the app was CLOSED — the watcher only catches files
          // written while it's running, so sets played without the app open were never picked up
          // until a manual scan (user-reported bug). scanDirectory is incremental (skips
          // already-scanned files), so this is cheap on later launches and only handles the new
          // ones. Runs in the background so startup isn't blocked; reloads games when it finds any.
          const dbsByCode: Record<string, Awaited<ReturnType<typeof getDb>>> = {};
          for (const c of codes) dbsByCode[c] = await getDb(c);

          // One-time backfill when the parser learns a new match type. v1.8.12 started
          // accepting direct-connect replays, but every direct replay already on disk had
          // been marked scanned back when the parser threw it away, so the fix only ever
          // caught *new* games. Dropping the marks on files that produced no row lets the
          // scan below re-parse them. Runs once per capability bump, not every launch.
          if ($parserCapabilityVersion < PARSER_CAPABILITY_VERSION) {
            try {
              await pruneUnproductiveScannedFiles(dbsByCode);
              parserCapabilityVersion.set(PARSER_CAPABILITY_VERSION);
            } catch {
              // Leave the version unbumped so the backfill is retried next launch.
            }
          }

          scanDirectory(dirs, codes, dbsByCode)
            .then(async (res) => {
              if (res.filesScanned > 0) {
                const arrays = await Promise.all(
                  codes.map(async (c) => {
                    const rows = await getGames(dbsByCode[c]);
                    return rows.map((g) => ({ ...g, sourceCode: c }));
                  })
                );
                games.set(arrays.flat().sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
              }
            })
            .catch(() => {});
        }
      } catch {
        games.set([]);
        snapshots.set([]);
        seasons.set([]);
      }
    })();
  });

  async function installUpdate() {
    isUpdating = true;
    updateError = "";
    try {
      const update = await check();
      if (update?.available) {
        await update.downloadAndInstall();
        await relaunch();
      }
    } catch (e: any) {
      updateError = e?.message ?? String(e);
      isUpdating = false;
    }
  }

  // Zoom support: Ctrl+/Ctrl-/Ctrl+0.
  //
  // Uses Chromium's `zoom` property (the webview is Chromium) rather than `transform: scale()`.
  // The difference matters: `transform` scales the *rendered output* without reflowing, so text
  // went soft at fractional scales, the layout never adapted — zooming out gave you a shrunken
  // copy of the same page instead of more content — and it needed a `100/zoom vw/vh` counter-hack
  // to stop the scaled box overflowing the window. `zoom` re-runs layout, so text stays crisp,
  // the responsive grids actually re-flow at their breakpoints, and no size compensation is
  // needed. It also makes ResizeObserver fire, which is what lets charts re-fit on zoom (with
  // `transform` they were measured at their untransformed size and never resized at all).
  function setZoom(z: number) {
    uiZoom.set(Math.min(2.0, Math.max(0.5, Math.round(z * 10) / 10)));
  }
  function applyZoom(delta: number) {
    setZoom(get(uiZoom) + delta);
  }
  $effect(() => {
    const app = document.getElementById("app");
    if (app) app.style.zoom = String($uiZoom);
  });
  function handleKeydown(e: KeyboardEvent) {
    if (!e.ctrlKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); applyZoom(+0.1); }
    else if (e.key === "-") { e.preventDefault(); applyZoom(-0.1); }
    else if (e.key === "0") { e.preventDefault(); setZoom(1.0); }
  }

  const TABS = [
    { label: "⚡ Ranked Sessions" },
    { label: "🎮 Matchup Stats" },
    { label: "📊 All-Time" },
    { label: "📈 Rating History" },
    { label: "📝 Grading" },
    { label: "🎯 Live Session" },
    // Appended rather than slotted next to Live Session on purpose: activeTab is persisted as
    // an index, so inserting in the middle would silently move everyone to a different tab.
    { label: "🕹️ Unranked & Direct Stats" },
    { label: "🗒️ Notes" },
  ];
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Set result flash overlay — rendered globally so it shows on any tab -->
{#if $isPremium && $setResultFlash}
  {@const flash = $setResultFlash}
  {@const isWin = flash.result === "win"}
  <div
    transition:fade={{ duration: 250 }}
    style="
      position: fixed; bottom: 24px; right: 24px; z-index: 1000;
      background: #1e1e1e;
      border: 2px solid {isWin ? '#2ecc71' : '#e74c3c'};
      border-radius: 12px;
      padding: 16px 22px;
      min-width: 220px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: space-between; gap: 20px;
    "
  >
    <div>
      <div style="font-size: 18px; font-weight: 800; color: {isWin ? '#2ecc71' : '#e74c3c'}; letter-spacing: 0.05em">
        SET {isWin ? "WIN" : "LOSS"}
      </div>
      <div style="font-size: 12px; color: #888; margin-top: 2px">vs {flash.opponent_code}</div>
      <div style="font-size: 11px; color: #555; margin-top: 1px">Rating updating…</div>
    </div>
    <div style="text-align: center">
      <div style="font-size: 30px; font-weight: 700; letter-spacing: 4px; line-height: 1">
        <span style="color: #2ecc71">{flash.wins}</span><span style="color: #555">–</span><span style="color: #e74c3c">{flash.losses}</span>
      </div>
    </div>
  </div>
{/if}

<div class="layout">
  {#if $sidebarOpen}
    <Sidebar />
  {/if}

  <div class="main" style="position:relative">
    {#if updateAvailable}
      <div style="background:#f39c12; color:#000; font-size:13px; font-weight:600">
        <div style="padding:8px 16px; display:flex; align-items:center; gap:12px">
          <span>Update available: v{updateVersion}</span>
          <button
            onclick={installUpdate}
            disabled={isUpdating}
            style="background:#000; color:#f39c12; border:none; padding:4px 12px; border-radius:4px; cursor:pointer; font-weight:700; font-size:12px; font-family:inherit"
          >{isUpdating ? "Installing…" : "Install & Restart"}</button>
          {#if updateNotes}
            <button
              onclick={() => showUpdateNotes = !showUpdateNotes}
              style="background:none; border:none; padding:0; cursor:pointer; font-size:12px; font-weight:600; color:#000; opacity:0.6; font-family:inherit; margin-left:auto"
            >What's new {showUpdateNotes ? "▴" : "▾"}</button>
          {/if}
          {#if updateError}
            <span style="color:#c0392b">{updateError}</span>
          {/if}
        </div>
        {#if showUpdateNotes && updateNotes}
          <div style="
            padding: 10px 16px 12px;
            border-top: 1px solid rgba(0,0,0,0.15);
            background: rgba(0,0,0,0.08);
            font-size: 12px; font-weight: 400;
            white-space: pre-line; line-height: 1.6;
            max-height: 200px; overflow-y: auto;
          ">{updateNotes}</div>
        {/if}
      </div>
    {/if}
    <Header />

    <div class="tabs">
      {#each TABS as tab, i}
        <button
          class="tab-btn"
          class:active={$activeTab === i}
          onclick={() => activeTab.set(i)}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    <div class="tab-content">
      {#if $games.length === 0}
        <OnboardingView />
      {:else if $activeTab === 0}
        <RankedSessions />
      {:else if $activeTab === 1}
        <MatchupStats />
      {:else if $activeTab === 2}
        <AllTimeStats />
      {:else if $activeTab === 3}
        <RatingProgression />
      {:else if $activeTab === 4}
        <GradeHistory />
      {:else if $activeTab === 5}
        <LiveRankedSession />
      {:else if $activeTab === 6}
        <UnrankedStats />
      {:else if $activeTab === 7}
        <Notes />
      {/if}
    </div>
  </div>
</div>
