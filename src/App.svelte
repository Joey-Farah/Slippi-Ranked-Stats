<script lang="ts">
  import Sidebar from "./components/Sidebar.svelte";
  import Header from "./components/Header.svelte";
  import RecentSession from "./components/tabs/RecentSession.svelte";
  import MatchupStats from "./components/tabs/MatchupStats.svelte";
  import RatingProgression from "./components/tabs/RatingProgression.svelte";
  import AllTimeStats from "./components/tabs/AllTimeStats.svelte";
  import { activeTab, connectCode, games, snapshots, seasons, sidebarOpen } from "./lib/store";
  import { getDb, getGames, getSnapshots, getSeasons } from "./lib/db";
  import { onMount } from "svelte";
  import { check } from "@tauri-apps/plugin-updater";
  import { relaunch } from "@tauri-apps/plugin-process";

  let updateAvailable = $state(false);
  let updateVersion = $state("");
  let isUpdating = $state(false);
  let updateError = $state("");

  onMount(async () => {
    try {
      const update = await check();
      if (update?.available) {
        updateAvailable = true;
        updateVersion = update.version;
      }
    } catch {
      // Silently ignore — no network or no release yet
    }
  });

  // Reload all data whenever the connect code changes
  $effect(() => {
    const code = $connectCode;
    if (!code) return;
    (async () => {
      try {
        const db = await getDb(code);
        const loadedGames = await getGames(db);
        games.set(loadedGames);
        const loadedSnaps = await getSnapshots(db, code);
        snapshots.set(loadedSnaps);
        const loadedSeasons = await getSeasons(db, code);
        seasons.set(loadedSeasons);
      } catch {
        // DB not ready yet — user hasn't scanned for this code
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

  // Zoom support: Ctrl+/Ctrl-/Ctrl+0
  let zoom = $state(1.0);
  function setZoom(z: number) {
    zoom = z;
    const app = document.getElementById("app")!;
    if (zoom === 1.0) {
      app.style.transform = "";
      app.style.transformOrigin = "";
      app.style.width = "";
      app.style.height = "";
    } else {
      app.style.transform = `scale(${zoom})`;
      app.style.transformOrigin = "top left";
      app.style.width = `${100 / zoom}vw`;
      app.style.height = `${100 / zoom}vh`;
    }
  }
  function applyZoom(delta: number) {
    setZoom(Math.min(2.0, Math.max(0.5, Math.round((zoom + delta) * 10) / 10)));
  }
  function handleKeydown(e: KeyboardEvent) {
    if (!e.ctrlKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); applyZoom(+0.1); }
    else if (e.key === "-") { e.preventDefault(); applyZoom(-0.1); }
    else if (e.key === "0") { e.preventDefault(); setZoom(1.0); }
  }

  const TABS = [
    { label: "⚡ Last Session" },
    { label: "🎮 Matchup Stats" },
    { label: "📊 All-Time" },
    { label: "📈 Rating Progression" },
  ];
</script>

<svelte:window onkeydown={handleKeydown} />
<div class="layout">
  {#if $sidebarOpen}
    <Sidebar />
  {/if}

  <div class="main" style="position:relative">
    {#if !$sidebarOpen}
      <button
        onclick={() => sidebarOpen.set(true)}
        title="Open sidebar"
        style="position:absolute; top:6px; left:6px; z-index:10; background:none; border:none; color:var(--muted); cursor:pointer; font-size:28px; padding:4px 8px; line-height:1"
      >›</button>
    {/if}
    {#if updateAvailable}
      <div style="background:#f39c12; color:#000; padding:8px 16px; display:flex; align-items:center; gap:12px; font-size:13px; font-weight:600">
        <span>Update available: v{updateVersion}</span>
        <button
          onclick={installUpdate}
          disabled={isUpdating}
          style="background:#000; color:#f39c12; border:none; padding:4px 12px; border-radius:4px; cursor:pointer; font-weight:700; font-size:12px"
        >
          {isUpdating ? "Installing…" : "Install & Restart"}
        </button>
        {#if updateError}
          <span style="color:#c0392b">{updateError}</span>
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
      {#if $activeTab === 0}
        <RecentSession />
      {:else if $activeTab === 1}
        <MatchupStats />
      {:else if $activeTab === 2}
        <AllTimeStats />
      {:else if $activeTab === 3}
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:300px; gap:12px">
          <div style="font-size:48px">📈</div>
          <div style="font-size:22px; font-weight:700; color:var(--text)">Rating Progression</div>
          <div style="font-size:14px; color:var(--muted)">Coming Soon!</div>
        </div>
      {/if}
    </div>
  </div>
</div>
