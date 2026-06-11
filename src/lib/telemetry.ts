// Fire-and-forget telemetry pings to the Cloudflare Worker. Failures are swallowed —
// telemetry never blocks the user. Each event carries install_id + app version + a
// coarse OS label so the dashboard can break things down by platform.

import { get } from "svelte/store";
import { getVersion } from "@tauri-apps/api/app";
import { fetch } from "@tauri-apps/plugin-http";
import { installId, isOwner } from "./store";

const ENDPOINT = "https://srs-telemetry.joeyfarah.workers.dev/ping";

// Don't report from the owner's own machines — otherwise every dev/test install shows up as a
// premium user + an install + DAU/MAU on the dashboard. Suppressed for: dev builds (`tauri dev`),
// installs linked to the owner's Discord account (isOwner), or a manual `srs_telemetryOff` flag.
function telemetryDisabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (get(isOwner)) return true;
  try {
    if (localStorage.getItem("srs_telemetryOff") === "1") return true;
  } catch {
    // ignore — localStorage should always exist in the webview
  }
  return false;
}

function detectOs(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "other";
}

let cachedVersion: string | null = null;
async function appVersion(): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;
  try { cachedVersion = await getVersion(); } catch { cachedVersion = ""; }
  return cachedVersion;
}

export async function pingTelemetry(event: string): Promise<void> {
  if (telemetryDisabled()) return;
  try {
    const version = await appVersion();
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: get(installId),
        event,
        version,
        os: detectOs(),
      }),
    }).catch(() => {});
  } catch {
    // never let telemetry surface a failure
  }
}
