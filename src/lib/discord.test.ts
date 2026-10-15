import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

// discord.ts feeds store.ts, which reads localStorage at module load; vitest runs in node,
// which has none. Same in-memory stub as card-premium.test.ts, installed before the imports
// below rather than in beforeAll, because they run at module load.
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  };
}

// discord.ts is tested through its public surface, against a fake Discord token endpoint and a
// fake premium-check worker. Every request takes a few ms, so two checks started together
// interleave the way they do in the app (both send before either hears back).
const h = vi.hoisted(() => {
  const discord = {
    /** The one refresh token Discord accepts right now. Discord rotates it on every use. */
    refreshToken: "rt-1",
    /** Access tokens Discord accepts. Empty = the stored one has expired. */
    accessTokens: new Set<string>(),
    serial: 1,
    refreshRequests: 0,
    /** Replaces the token endpoint's answer (rate limit, outage, …). May throw = network error. */
    tokenAnswer: null as null | (() => Response),
    /** Runs while a refresh is in flight, before Discord answers it. */
    duringRefresh: null as null | (() => void),
  };

  function tokenEndpoint(form: URLSearchParams): Response {
    discord.refreshRequests++;
    discord.duringRefresh?.();
    if (discord.tokenAnswer) return discord.tokenAnswer();
    if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== discord.refreshToken) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    discord.serial++;
    discord.refreshToken = `rt-${discord.serial}`;
    const access = `at-${discord.serial}`;
    discord.accessTokens.add(access);
    return Response.json({
      access_token: access,
      refresh_token: discord.refreshToken,
      expires_in: 604800,
      token_type: "Bearer",
    });
  }

  function worker(token: string): Response {
    if (!discord.accessTokens.has(token)) return Response.json({ premium: false, reason: "auth_invalid" });
    return Response.json({ premium: true, reason: "premium", username: "patron", userId: "42" });
  }

  return { discord, tokenEndpoint, worker };
});

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 5));
    if (url === "https://discord.com/api/oauth2/token") {
      return h.tokenEndpoint(new URLSearchParams(String(init.body)));
    }
    if (url.endsWith("/check-premium")) return h.worker(JSON.parse(String(init.body)).token);
    throw new Error(`unexpected request to ${url}`);
  },
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: async () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => "" }));
vi.mock("./telemetry", () => ({ pingTelemetry: async () => {} }));

const { verifyPatronRole, verifyPatronRoleWithRetry } = await import("./discord");
const { discordPremium, discordToken, discordRefreshToken, discordTokenExpiresAt, discordUsername } =
  await import("./store");

/** A patron whose stored access token Discord no longer accepts; the refresh token is good. */
function expiredLogin(opts: { expiryKnown: boolean }) {
  Object.assign(h.discord, {
    refreshToken: "rt-1",
    accessTokens: new Set<string>(),
    serial: 1,
    refreshRequests: 0,
    tokenAnswer: null,
    duringRefresh: null,
  });
  discordToken.set("at-1");
  discordRefreshToken.set("rt-1");
  discordTokenExpiresAt.set(opts.expiryKnown ? Date.now() - 1000 : null);
  discordUsername.set("patron");
  discordPremium.set(true);
}

/** Still signed in with a login Discord accepts, and still Premium. */
function expectStillSignedIn() {
  expect(get(discordPremium)).toBe(true);
  expect(h.discord.accessTokens.has(get(discordToken) ?? "")).toBe(true);
  expect(get(discordRefreshToken)).toBe(h.discord.refreshToken);
}

describe("renewing an expired login", () => {
  beforeEach(() => expiredLogin({ expiryKnown: false }));

  it("renews once and stays signed in when the launch check and a Re-check race", async () => {
    await Promise.all([verifyPatronRoleWithRetry(), verifyPatronRole()]);
    expect(h.discord.refreshRequests).toBe(1);
    expectStillSignedIn();
  });

  it("renews once when both see the recorded expiry before checking", async () => {
    expiredLogin({ expiryKnown: true });
    await Promise.all([verifyPatronRoleWithRetry(), verifyPatronRole()]);
    expect(h.discord.refreshRequests).toBe(1);
    expectStillSignedIn();
  });
});

// Only Discord saying the refresh token itself is no good (OAuth's `invalid_grant`) ends a
// login. Anything else is "try again later": the login is kept and Premium stays as it was.
describe("a renewal Discord doesn't answer properly", () => {
  beforeEach(() => expiredLogin({ expiryKnown: false }));

  it.each([
    ["rate limited", () => Response.json({ message: "You are being rate limited.", retry_after: 1.5, global: false }, { status: 429 })],
    ["down", () => new Response("upstream connect error", { status: 503 })],
    ["unreachable", () => { throw new TypeError("error sending request"); }],
    ["rejecting our app's own setup", () => Response.json({ error: "invalid_client" }, { status: 401 })],
    ["answering with garbage", () => new Response("<html>oops</html>", { status: 200 })],
  ])("keeps the login and Premium when Discord is %s", async (_, answer) => {
    h.discord.tokenAnswer = answer;
    expect(await verifyPatronRole()).toBe("transient");
    expect(get(discordPremium)).toBe(true);
    expect(get(discordToken)).toBe("at-1");
    expect(get(discordRefreshToken)).toBe("rt-1");
  });

  it("renews on a later attempt once Discord answers again", async () => {
    let failures = 2;
    h.discord.tokenAnswer = () => {
      if (failures-- > 0) return new Response(null, { status: 429 });
      h.discord.tokenAnswer = null;
      return h.tokenEndpoint(new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt-1" }));
    };
    expect(await verifyPatronRoleWithRetry(undefined, { baseDelayMs: 1 })).toBe("premium");
    expectStillSignedIn();
  });

  it("signs out when Discord says the refresh token is no good", async () => {
    h.discord.refreshToken = "rt-revoked";
    expect(await verifyPatronRole()).toBe("auth_invalid");
    expect(get(discordPremium)).toBe(false);
    expect(get(discordToken)).toBeNull();
    expect(get(discordRefreshToken)).toBeNull();
  });
});

describe("Connect Discord finishing while the old login is being renewed", () => {
  beforeEach(() => expiredLogin({ expiryKnown: false }));

  it("keeps the new login when Discord refuses the old refresh token", async () => {
    h.discord.duringRefresh = () => {
      // The new link lands: Discord knows only the new pair, and the app has stored it.
      h.discord.refreshToken = "rt-new";
      h.discord.accessTokens.add("at-new");
      discordToken.set("at-new");
      discordRefreshToken.set("rt-new");
    };
    await verifyPatronRole();
    expect(get(discordToken)).toBe("at-new");
    expect(get(discordRefreshToken)).toBe("rt-new");
    expect(get(discordPremium)).toBe(true);
  });
});
