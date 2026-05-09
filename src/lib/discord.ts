import { fetch } from "@tauri-apps/plugin-http";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { isPremium, discordToken, discordUsername, installId } from "./store";

const CLIENT_ID = "1489690383171719188";
const REDIRECT_URI = "http://localhost:14523";

// Worker that performs the role check using a bot token (server-side).
// Avoids Discord's flaky user-context /users/@me/guilds/{id}/member endpoint.
const PREMIUM_CHECK_URL = "https://srs-discord-check.joeyfarah.workers.dev/check-premium";

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

// Outcome of a single verify attempt. Callers use this to decide whether to retry.
//   premium       — confirmed: Discord returned a matching role
//   no_role       — confirmed: Discord returned no matching role (user is not a patron)
//   no_token      — no token stored
//   auth_invalid  — 401/403/404: token bad or user not in guild
//   transient     — 5xx/429/network: try again later, premium left untouched
export type VerifyResult = "premium" | "no_role" | "no_token" | "auth_invalid" | "transient";

/**
 * Checks the stored (or provided) token against the SRS Discord-check worker,
 * which uses a bot token (server-side) to look up the user's roles in the SRS
 * guild. Also refreshes the stored username.
 *
 * Only flips `isPremium` on a definitive response. Transient failures
 * (5xx/429/network) leave the prior value alone so a Discord hiccup can't
 * silently downgrade an existing patron.
 */
export async function verifyPatronRole(token?: string): Promise<VerifyResult> {
  const t = token ?? get(discordToken);
  if (!t) return "no_token";

  let res: Response;
  try {
    res = await fetch(PREMIUM_CHECK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t }),
    });
  } catch {
    return "transient";
  }

  // 5xx from the worker (which it returns when Discord itself is transient)
  // means: leave premium untouched, retry later.
  if (res.status >= 500) return "transient";

  let data: { premium: boolean | null; reason: string; username?: string | null };
  try {
    data = await res.json();
  } catch {
    return "transient";
  }

  if (data.username !== undefined) discordUsername.set(data.username);

  switch (data.reason) {
    case "premium":
      isPremium.set(true);
      fetch("https://srs-telemetry.joeyfarah.workers.dev/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ install_id: get(installId), event: "premium" }),
      }).catch(() => {});
      return "premium";

    case "no_role":
      isPremium.set(false);
      return "no_role";

    case "not_in_guild":
      isPremium.set(false);
      return "auth_invalid";

    case "auth_invalid":
      // Token was rejected by Discord — clear it so the user re-links.
      discordToken.set(null);
      discordUsername.set(null);
      isPremium.set(false);
      return "auth_invalid";

    default:
      return "transient";
  }
}

/**
 * Calls verifyPatronRole with exponential backoff on transient failures.
 * Returns as soon as a definitive answer (premium / no_role / auth_invalid /
 * no_token) is received. If every attempt is transient, returns "transient".
 *
 * Used on app launch so a downgraded patron auto-recovers when Discord
 * stops returning 5xx — no action required from the user.
 */
export async function verifyPatronRoleWithRetry(
  token?: string,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {}
): Promise<VerifyResult> {
  const { maxAttempts = 8, baseDelayMs = 2000 } = opts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await verifyPatronRole(token);
    if (result !== "transient") return result;
    if (attempt < maxAttempts - 1) {
      const delay = Math.min(baseDelayMs * Math.pow(1.6, attempt), 60_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return "transient";
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
