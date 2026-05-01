import { fetch } from "@tauri-apps/plugin-http";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { isPremium, discordToken, discordUsername, installId } from "./store";

const CLIENT_ID = "1489690383171719188";
const GUILD_ID = "703857185570029628";
const PREMIUM_ROLE_IDS = new Set([
  "1195042084961386526",
  "1195042365849731142",
  "1195043524463312917",
  "1195043810263175302",
  "1495188057396219904", // Slippi Ranked Stats — auto-assigned to both Patreon and Ko-fi supporters
]);
const REDIRECT_URI = "http://localhost:14523";

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Full OAuth flow:
 * 1. Starts a one-shot local HTTP listener (via Rust command)
 * 2. Opens Discord's auth page in the browser
 * 3. Discord redirects to http://localhost:14523?code=XXX
 * 4. Rust captures the code, frontend exchanges it for a token via PKCE
 * 5. Verifies patron role and updates stores
 */
export async function startDiscordAuth(): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "identify guilds.members.read",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  // Start the local listener before opening the browser so we don't miss the callback
  const callbackPromise = invoke<string>("wait_for_oauth_callback");
  await openUrl(`https://discord.com/oauth2/authorize?${authParams}`);

  try {
    const path = await callbackPromise; // e.g. "/?code=XXX"
    const callbackParams = new URLSearchParams(path.split("?")[1] ?? "");
    const code = callbackParams.get("code");
    if (!code) {
      console.error("[discord] no code in callback path:", path);
      return;
    }

    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("[discord] token exchange failed:", res.status, err);
      return;
    }

    const data = await res.json();
    discordToken.set(data.access_token);
    await verifyPatronRole(data.access_token);
  } catch (e) {
    console.error("[discord] auth error:", e);
  }
}

/**
 * Checks the stored (or provided) token against Discord to see if the user
 * has a patron role. Also refreshes the stored username.
 */
export async function verifyPatronRole(token?: string): Promise<boolean> {
  const t = token ?? get(discordToken);
  if (!t) return false;

  try {
    // Fetch display name
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (userRes.ok) {
      const user = await userRes.json();
      discordUsername.set(user.global_name ?? user.username ?? null);
    }

    // Check guild membership and roles
    const memberRes = await fetch(
      `https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${t}` } }
    );

    if (!memberRes.ok) {
      if (memberRes.status === 401) {
        discordToken.set(null);
        discordUsername.set(null);
      }
      isPremium.set(false);
      return false;
    }

    const member = await memberRes.json();
    const roles: string[] = member.roles ?? [];
    const hasPremium = roles.some((r) => PREMIUM_ROLE_IDS.has(r));
    isPremium.set(hasPremium);
    if (hasPremium) {
      fetch("https://srs-telemetry.joeyfarah.workers.dev/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ install_id: get(installId), event: "premium" }),
      }).catch(() => {});
    }
    return hasPremium;
  } catch {
    isPremium.set(false);
    return false;
  }
}

/** Revokes the token and clears all Discord state. */
export async function disconnectDiscord(): Promise<void> {
  const token = get(discordToken);
  if (token) {
    fetch("https://discord.com/api/oauth2/token/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: CLIENT_ID }).toString(),
    }).catch(() => {});
  }
  discordToken.set(null);
  discordUsername.set(null);
  isPremium.set(false);
}
