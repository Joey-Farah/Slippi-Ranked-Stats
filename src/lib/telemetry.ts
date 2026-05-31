// Fire-and-forget telemetry pings to the Cloudflare Worker. Failures are swallowed —
// telemetry never blocks the user. Each event carries install_id + app version + a
// coarse OS label so the dashboard can break things down by platform.

import { get } from "svelte/store";
import { getVersion } from "@tauri-apps/api/app";
import { fetch } from "@tauri-apps/plugin-http";
import { installId } from "./store";

const ENDPOINT = "https://srs-telemetry.joeyfarah.workers.dev/ping";

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
