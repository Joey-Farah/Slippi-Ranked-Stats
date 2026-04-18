<script lang="ts">
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { startDiscordAuth, verifyPatronRole } from "../lib/discord";
  import { isPremium, discordToken, discordUsername } from "../lib/store";

  let { featureName, description }: { featureName: string; description: string } = $props();

  const KOFI_URL    = "https://ko-fi.com/joeydonuts";
  const PATREON_URL = "https://www.patreon.com/joeydonuts";

  let isConnecting = $state(false);
  let isRechecking = $state(false);

  async function handleConnect() {
    isConnecting = true;
    try { await startDiscordAuth(); } finally { isConnecting = false; }
  }

  async function handleRecheck() {
    isRechecking = true;
    await verifyPatronRole();
    isRechecking = false;
  }
</script>

<div style="
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 60%; min-height: 340px; gap: 0; text-align: center; padding: 32px;
">
  <div style="font-size: 32px; margin-bottom: 12px">🔒</div>
  <div style="font-size: 17px; font-weight: 700; margin-bottom: 8px">{featureName}</div>
  <div style="font-size: 13px; color: var(--muted); max-width: 360px; line-height: 1.6; margin-bottom: 24px">
    {description}
  </div>

  {#if !$discordToken}
    <div style="display:flex; flex-direction:column; align-items:center; gap:10px; width:100%; max-width:280px">
      <!-- Ko-fi primary -->
      <button
        onclick={() => openUrl(KOFI_URL)}
        style="
          display:flex; align-items:center; justify-content:center; gap:8px;
          width:100%; padding:10px 20px;
          background:#29ABE0; color:#fff;
          border:none; border-radius:7px;
          font-size:14px; font-weight:700; cursor:pointer;
        "
      >☕ Support on Ko-fi</button>
      <!-- Patreon secondary -->
      <button
        onclick={() => openUrl(PATREON_URL)}
        style="
          display:flex; align-items:center; justify-content:center; gap:8px;
          width:100%; padding:9px 20px;
          background:var(--card); color:var(--muted);
          border:1px solid var(--border); border-radius:7px;
          font-size:13px; font-weight:600; cursor:pointer;
        "
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M14.82 2.41C11.25 2.41 8.35 5.31 8.35 8.88c0 3.56 2.9 6.46 6.47 6.46 3.56 0 6.46-2.9 6.46-6.46 0-3.57-2.9-6.47-6.46-6.47zM3.19 21.59h2.52V2.41H3.19v19.18z"/></svg>
        Support on Patreon
      </button>
      <div style="font-size:12px; color:var(--muted); margin: 2px 0">Already a supporter? Connect Discord to verify:</div>
      <button
        onclick={handleConnect}
        disabled={isConnecting}
        style="
          display:flex; align-items:center; justify-content:center; gap:7px;
          width:100%; padding:9px 20px;
          background:var(--card); color:var(--fg);
          border:1px solid var(--border); border-radius:7px;
          font-size:13px; font-weight:600; cursor:pointer;
        "
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
        {isConnecting ? "Opening Discord…" : "Connect Discord"}
      </button>
    </div>

  {:else if !$isPremium}
    <div style="
      background:var(--card); border:1px solid #e74c3c44;
      border-radius:8px; padding:12px 16px; margin-bottom:16px;
      max-width:300px; width:100%;
    ">
      <div style="font-size:12px; color:#e74c3c; font-weight:600; margin-bottom:4px">
        {$discordUsername ?? "Account"} — no supporter role
      </div>
      <div style="font-size:11px; color:var(--muted); line-height:1.5">
        Just subscribed? Roles can take a few minutes to sync.
      </div>
    </div>
    <div style="display:flex; flex-direction:column; align-items:center; gap:8px; width:100%; max-width:280px">
      <button
        onclick={() => openUrl(KOFI_URL)}
        style="
          display:flex; align-items:center; justify-content:center; gap:8px;
          width:100%; padding:10px 20px;
          background:#29ABE0; color:#fff;
          border:none; border-radius:7px;
          font-size:14px; font-weight:700; cursor:pointer;
        "
      >☕ Ko-fi</button>
      <button
        onclick={() => openUrl(PATREON_URL)}
        style="
          display:flex; align-items:center; justify-content:center; gap:8px;
          width:100%; padding:9px 20px;
          background:var(--card); color:var(--muted);
          border:1px solid var(--border); border-radius:7px;
          font-size:13px; font-weight:600; cursor:pointer;
        "
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M14.82 2.41C11.25 2.41 8.35 5.31 8.35 8.88c0 3.56 2.9 6.46 6.47 6.46 3.56 0 6.46-2.9 6.46-6.46 0-3.57-2.9-6.47-6.46-6.47zM3.19 21.59h2.52V2.41H3.19v19.18z"/></svg>
        Patreon
      </button>
      <button
        onclick={handleRecheck}
        disabled={isRechecking}
        style="
          width:100%; padding:8px 20px;
          background:var(--card); color:var(--muted);
          border:1px solid var(--border); border-radius:7px;
          font-size:12px; font-weight:600; cursor:pointer;
        "
      >{isRechecking ? "Checking…" : "Re-check Discord role"}</button>
    </div>
  {/if}
</div>
