<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import {
    connectCode, replayDir, dateRange,
    games, snapshots, seasons,
    isScanning, isFetchingSnapshot, scanProgress, statusMessage, sidebarOpen, isPremium,
    discordToken, discordUsername,
  } from "../lib/store";
  import { startDiscordAuth, verifyPatronRole, disconnectDiscord } from "../lib/discord";

  const KOFI_URL    = "https://ko-fi.com/joeydonuts";
  const PATREON_URL = "https://www.patreon.com/joeydonuts";
  import { getDb } from "../lib/db";
  import { getRankTier } from "../lib/parser";
  import { scanDirectory, cancelScan } from "../lib/parser";
  import { fetchRatingSnapshot } from "../lib/api";
  import { insertSnapshot, insertSeason, getGames, getSnapshots, getSeasons, clearScannedFiles } from "../lib/db";

  let codeInput = $state($connectCode);
  let dirInput = $state($replayDir);
  let isVerifying = $state(false);

  async function handleRecheck() {
    isVerifying = true;
    await verifyPatronRole();
    isVerifying = false;
  }

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




<!-- Premium section -->
  <div style="padding-top: 8px; border-top: 1px solid var(--border)">

    {#if $isPremium}
      <!-- Patron confirmed -->
      <div style="display:flex; align-items:center; gap:6px; font-size:12px; color:#2ecc71; font-weight:600; margin-bottom:8px">
        <span>✓</span>
        <span>{$discordUsername ?? "Connected"} — Patron</span>
      </div>
      <div style="display:flex; gap:6px">
        {#if isVerifying}
          <div style="font-size:11px; color:var(--muted)">Verifying…</div>
        {:else}
          <button class="btn btn-secondary" style="flex:1; font-size:11px" onclick={handleRecheck}>Re-check</button>
          <button class="btn btn-secondary" style="flex:1; font-size:11px" onclick={disconnectDiscord}>Disconnect</button>
        {/if}
      </div>

    {:else if $discordToken}
      <!-- Connected but not a patron -->
      <div style="font-size:12px; color:#e74c3c; font-weight:600; margin-bottom:4px">
        {$discordUsername ?? "Connected"} — Not a patron
      </div>
      <div style="font-size:11px; color:var(--muted); margin-bottom:8px; line-height:1.4">
        Role sync can take a few minutes after subscribing.
      </div>
      <div style="display:flex; gap:6px; margin-bottom:8px">
        {#if isVerifying}
          <div style="font-size:11px; color:var(--muted)">Checking…</div>
        {:else}
          <button class="btn btn-secondary" style="flex:1; font-size:11px" onclick={handleRecheck}>Re-check</button>
          <button class="btn btn-secondary" style="flex:1; font-size:11px" onclick={disconnectDiscord}>Disconnect</button>
        {/if}
      </div>
      <button
        onclick={() => openUrl(PATREON_URL)}
        style="
          display:flex; align-items:center; justify-content:center; gap:7px;
          width:100%; padding:9px;
          background:#FF424D; color:#fff;
          border:none; border-radius:6px;
          font-size:12px; font-weight:700; cursor:pointer; margin-bottom:4px;
        "
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M14.82 2.41C11.25 2.41 8.35 5.31 8.35 8.88c0 3.56 2.9 6.46 6.47 6.46 3.56 0 6.46-2.9 6.46-6.46 0-3.57-2.9-6.47-6.46-6.47zM3.19 21.59h2.52V2.41H3.19v19.18z"/></svg>
        Patreon
      </button>
      <button
        onclick={() => openUrl(KOFI_URL)}
        style="
          display:flex; align-items:center; justify-content:center; gap:7px;
          width:100%; padding:9px;
          background:#29ABE0; color:#fff;
          border:none; border-radius:6px;
          font-size:12px; font-weight:700; cursor:pointer; margin-bottom:4px;
        "
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/></svg>
        Ko-fi
      </button>
      <div style="font-size:10px; color:var(--muted); margin-top:2px; line-height:1.5">
        Having trouble connecting with Discord? Check out these support articles:<br/>
        <button onclick={() => openUrl("https://support.patreon.com/hc/en-us/articles/212052266")} style="background:none;border:none;padding:0;color:var(--muted);font-size:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:inherit">Patreon → Discord</button>
        &nbsp;·&nbsp;
        <button onclick={() => openUrl("https://help.ko-fi.com/hc/en-us/articles/8664701197073-How-do-supporters-join-my-Discord-server#how-do-supporters-join-my-discord-server--0-0")} style="background:none;border:none;padding:0;color:var(--muted);font-size:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:inherit">Ko-fi → Discord</button>
      </div>

    {:else}
      <!-- Not connected — show the 2-step unlock flow -->
      <div style="font-size:11px; font-weight:700; color:var(--muted); letter-spacing:0.05em; margin-bottom:10px; text-transform:uppercase">
        Unlock Premium
      </div>
      <div style="display:flex; flex-direction:column; gap:7px">
        <!-- Step 1 -->
        <div style="display:flex; align-items:flex-start; gap:8px">
          <div style="
            min-width:18px; height:18px; border-radius:50%;
            background:#FF424D; color:#fff;
            font-size:10px; font-weight:700;
            display:flex; align-items:center; justify-content:center; margin-top:1px;
          ">1</div>
          <div style="flex:1">
            <button
              onclick={() => openUrl(PATREON_URL)}
              style="
                display:flex; align-items:center; justify-content:center; gap:6px;
                width:100%; padding:7px 10px;
                background:#FF424D; color:#fff;
                border:none; border-radius:6px;
                font-size:12px; font-weight:700; cursor:pointer; margin-bottom:4px;
              "
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="white"><path d="M14.82 2.41C11.25 2.41 8.35 5.31 8.35 8.88c0 3.56 2.9 6.46 6.47 6.46 3.56 0 6.46-2.9 6.46-6.46 0-3.57-2.9-6.47-6.46-6.47zM3.19 21.59h2.52V2.41H3.19v19.18z"/></svg>
              Patreon
            </button>
            <button
              onclick={() => openUrl(KOFI_URL)}
              style="
                display:flex; align-items:center; justify-content:center; gap:6px;
                width:100%; padding:7px 10px;
                background:#29ABE0; color:#fff;
                border:none; border-radius:6px;
                font-size:12px; font-weight:700; cursor:pointer;
              "
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/></svg>
              Ko-fi
            </button>
            <div style="font-size:10px; color:var(--muted); margin-top:3px; padding-left:2px; line-height:1.4">
              Any tier unlocks premium. Then connect your Discord to verify.
            </div>
          </div>
        </div>
        <!-- Step 2 -->
        <div style="display:flex; align-items:flex-start; gap:8px">
          <div style="
            min-width:18px; height:18px; border-radius:50%;
            background:var(--card); border:1px solid var(--border); color:var(--muted);
            font-size:10px; font-weight:700;
            display:flex; align-items:center; justify-content:center; margin-top:1px;
          ">2</div>
          <div style="flex:1">
            <button
              class="btn btn-secondary"
              style="width:100%; font-size:12px; padding:7px 10px"
              onclick={startDiscordAuth}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px; margin-right:4px"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              Connect Discord
            </button>
            <div style="font-size:10px; color:var(--muted); margin-top:3px; padding-left:2px; line-height:1.5">
              Having trouble connecting with Discord? Check out these support articles:<br/>
              <button onclick={() => openUrl("https://support.patreon.com/hc/en-us/articles/212052266")} style="background:none;border:none;padding:0;color:var(--muted);font-size:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:inherit">Patreon → Discord</button>
              &nbsp;·&nbsp;
              <button onclick={() => openUrl("https://help.ko-fi.com/hc/en-us/articles/8664701197073-How-do-supporters-join-my-Discord-server#how-do-supporters-join-my-discord-server--0-0")} style="background:none;border:none;padding:0;color:var(--muted);font-size:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:inherit">Ko-fi → Discord</button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>

  </div><!-- end sidebar-scroll -->
</aside>
