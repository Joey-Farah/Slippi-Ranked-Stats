<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import {
    connectCode, replayDir, dateRange,
    games, snapshots, seasons,
    isScanning, isFetchingSnapshot, scanProgress, statusMessage, watcherActive, sidebarOpen,
  } from "../lib/store";
  import { getDb } from "../lib/db";
  import { getRankTier } from "../lib/parser";
  import { scanDirectory, cancelScan } from "../lib/parser";
  import { fetchRatingSnapshot } from "../lib/api";
  import { insertSnapshot, insertSeason, getGames, getSnapshots, getSeasons, clearScannedFiles } from "../lib/db";
  import { startWatcher, stopWatcher } from "../lib/watcher";

  let codeInput = $state($connectCode);
  let dirInput = $state($replayDir);

  async function browseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      dirInput = selected;
      replayDir.set(selected);
    }
  }

  async function handleScan() {
    const code = codeInput.trim().toUpperCase();
    if (!code || !dirInput) {
      statusMessage.set("Enter a connect code and folder first.");
      return;
    }
    connectCode.set(code);
    replayDir.set(dirInput);
    isScanning.set(true);
    scanProgress.set(null);
    statusMessage.set("");

    try {
      const db = await getDb(code);
      const { filesScanned, gamesInserted } = await scanDirectory(dirInput, code, db, (p) => scanProgress.set(p));
      // Reload games from DB
      const loaded = await getGames(db);
      games.set(loaded);
      statusMessage.set(`Scan complete — ${filesScanned} files, ${gamesInserted} ranked replays found (${loaded.length} total in DB).`);
    } catch (e: any) {
      statusMessage.set("Scan error: " + (e?.message ?? JSON.stringify(e) ?? String(e)));
    } finally {
      isScanning.set(false);
      scanProgress.set(null);
    }
  }

  async function handleForceRescan() {
    const code = codeInput.trim().toUpperCase();
    if (!code || !dirInput) {
      statusMessage.set("Enter a connect code and folder first.");
      return;
    }
    connectCode.set(code);
    replayDir.set(dirInput);
    isScanning.set(true);
    scanProgress.set(null);
    statusMessage.set("Clearing scan history…");
    try {
      await clearScannedFiles();
      const db = await getDb(code);
      const { filesScanned, gamesInserted, totalSlpFound, debugPath, firstError } = await scanDirectory(dirInput, code, db, (p) => scanProgress.set(p));
      const loaded = await getGames(db);
      games.set(loaded);
      statusMessage.set(`path:"${debugPath}" | ${totalSlpFound} .slp | ${filesScanned} new | ${gamesInserted} ranked | ${loaded.length} in DB${firstError ? ` | err: ${firstError}` : ""}`);
    } catch (e: any) {
      statusMessage.set("Rescan error: " + (e?.message ?? JSON.stringify(e) ?? String(e)));
    } finally {
      isScanning.set(false);
      scanProgress.set(null);
    }
  }

  async function handleStartWatcher() {
    const code = codeInput.trim().toUpperCase();
    if (!code || !dirInput) {
      statusMessage.set("Enter a connect code and folder first.");
      return;
    }
    connectCode.set(code);
    replayDir.set(dirInput);
    try {
      const db = await getDb(code);
      await startWatcher(dirInput, code, db);
      statusMessage.set("Watcher started — monitoring for new replays.");
    } catch (e: any) {
      statusMessage.set("Watcher error: " + e.message);
    }
  }

  async function handleStopWatcher() {
    await stopWatcher();
    statusMessage.set("Watcher stopped.");
  }

  async function handleFetchSnapshot() {
    const code = codeInput.trim().toUpperCase();
    if (!code) {
      statusMessage.set("Enter a connect code first.");
      return;
    }
    connectCode.set(code);
    isFetchingSnapshot.set(true);
    statusMessage.set("");

    try {
      const db = await getDb(code);
      const { snapshot, seasons: fetchedSeasons } = await fetchRatingSnapshot(code);
      await insertSnapshot(db, { ...snapshot, connect_code: code });

      for (const s of fetchedSeasons) {
        await insertSeason(db, { ...s, connect_code: code });
      }

      const loaded = await getSnapshots(db, code);
      snapshots.set(loaded);
      const loadedSeasons = await getSeasons(db, code);
      seasons.set(loadedSeasons);

      statusMessage.set("");
    } catch (e: any) {
      statusMessage.set("API error: " + e.message);
    } finally {
      isFetchingSnapshot.set(false);
    }
  }
</script>

<aside class="sidebar">
  <div class="sidebar-scroll">
  <div class="logo">
    <img src="/srs-logo.svg" alt="SRS" class="logo-img" />
    Slippi Ranked Stats
    <button
      onclick={() => sidebarOpen.set(false)}
      title="Collapse sidebar"
      style="margin-left:auto; background:none; border:none; color:var(--muted); cursor:pointer; font-size:16px; padding:0 2px; line-height:1"
    >‹</button>
  </div>

  <!-- Connect Code -->
  <div class="sidebar-section">
    <span class="sidebar-label">Connect Code</span>
    <input
      type="text"
      placeholder="ABCD#123"
      bind:value={codeInput}
      onchange={() => connectCode.set(codeInput.trim().toUpperCase())}
    />
  </div>

  <!-- Replay Folder -->
  <div class="sidebar-section">
    <span class="sidebar-label">Replay Folder</span>
    <input type="text" placeholder="C:/Users/.../Slippi" bind:value={dirInput} />
    <button class="btn btn-secondary" onclick={browseFolder}>Browse…</button>
  </div>

  <!-- Date Range -->
  <div class="sidebar-section">
    <span class="sidebar-label">Date Range</span>
    <select bind:value={$dateRange}>
      <option value="all">All Time</option>
      <option value="90d">Last 90 Days</option>
      <option value="30d">Last 30 Days</option>
    </select>
  </div>

  <!-- Actions -->
  <div class="sidebar-section">
    <button class="btn btn-primary" onclick={handleScan} disabled={$isScanning}>
      {$isScanning ? "Scanning…" : "Scan Replays"}
    </button>
    {#if $isScanning}
      <button class="btn btn-danger" onclick={cancelScan} style="font-size:12px">
        Stop Scan
      </button>
    {:else}
      <button class="btn btn-secondary" onclick={handleForceRescan} style="font-size:12px">
        Force Rescan All
      </button>
    {/if}
    <button class="btn btn-secondary" onclick={handleFetchSnapshot} disabled={$isFetchingSnapshot}>
      {$isFetchingSnapshot ? "Fetching…" : "Get Current Rating"}
    </button>
    {#if $snapshots.length === 0}
      <span style="font-size:11px; color: #f39c12;">
        ⚠ Rating not fetched yet — click above to load your current rating.
      </span>
    {:else}
      {@const snap = $snapshots.at(-1)!}
      {@const tier = getRankTier(snap.rating)}
      <div style="background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; text-align:center;">
        <div style="font-size:18px; font-weight:700">{snap.rating.toFixed(1)}</div>
        <div style="font-size:11px; font-weight:600; color:{tier.color}">{tier.name}</div>
        {#if snap.global_rank > 0}
          <div style="font-size:12px; color:var(--muted); margin-top:4px">Rank #{snap.global_rank.toLocaleString()}</div>
        {/if}
        <div style="font-size:10px; color:var(--muted); margin-top:2px">
          Updated {new Date(snap.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })} at {new Date(snap.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
    {/if}
  </div>

  <!-- Progress bar -->
  {#if $scanProgress}
    <div class="sidebar-section">
      <div class="progress-bar-wrap">
        <div
          class="progress-bar-fill"
          style="width: {Math.round(($scanProgress.scanned / Math.max($scanProgress.total, 1)) * 100)}%"
        ></div>
      </div>
      <span class="muted" style="font-size:11px">
        {$scanProgress.scanned}/{$scanProgress.total}
        ({$scanProgress.alreadyProcessed} already processed)
      </span>
    </div>
  {/if}

  <!-- Status -->
  {#if $statusMessage}
    <span style="font-size:12px; color: var(--muted)">{$statusMessage}</span>
  {/if}

  <!-- Watcher — hidden until feature is ready -->
  <!-- <div style="margin-top: auto; padding-top: 8px; border-top: 1px solid var(--border)">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px">
      <span style="font-size:11px; color: var(--muted)">
        {$watcherActive ? "🟢 Live Monitor active" : "⚪ Live Ranked Games Monitor"}
      </span>
      {#if $watcherActive}
        <button class="btn btn-secondary" style="font-size:11px; padding:2px 8px" onclick={handleStopWatcher}>
          Stop
        </button>
      {:else}
        <button
          class="btn btn-secondary"
          style="font-size:11px; padding:2px 8px"
          onclick={handleStartWatcher}
          disabled={!dirInput || !codeInput}
        >
          Start
        </button>
      {/if}
    </div>
  </div> -->

  </div><!-- end sidebar-scroll -->

  <!-- Patreon -->
  <button
    onclick={() => openUrl("https://www.patreon.com")}
    style="
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 10px;
      background: #FF424D; color: #fff;
      border: none; border-radius: 6px;
      font-size: 13px; font-weight: 700; cursor: pointer;
      letter-spacing: 0.02em;
      transition: background 0.15s;
    "
    onmouseenter={(e) => (e.currentTarget as HTMLButtonElement).style.background = '#e03040'}
    onmouseleave={(e) => (e.currentTarget as HTMLButtonElement).style.background = '#FF424D'}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
      <path d="M14.82 2.41C11.25 2.41 8.35 5.31 8.35 8.88c0 3.56 2.9 6.46 6.47 6.46 3.56 0 6.46-2.9 6.46-6.46 0-3.57-2.9-6.47-6.46-6.47zM3.19 21.59h2.52V2.41H3.19v19.18z"/>
    </svg>
    Support on Patreon
  </button>
</aside>
