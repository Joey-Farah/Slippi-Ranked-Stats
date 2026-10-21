import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

// card-premium.ts feeds store.ts, which reads localStorage at module load; vitest runs in node,
// which has none. Same in-memory stub as live-record.test.ts.
beforeAll(() => {
  if (typeof globalThis.localStorage === "undefined") {
    const mem = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    };
  }
});

// card-premium.ts is tested through its public surface. Its two edges are faked: the network
// (Tauri's fetch, answered by `h.server`) and the disk (account.db, held in `h.disk`). A
// "restart" is a fresh import of the module against the same disk.
const h = vi.hoisted(() => ({
  disk: null as string | null,
  /** How many upcoming reads / writes of account.db should throw. */
  loadFailures: 0,
  saveFailures: 0,
  requests: [] as { path: string; body: any }[],
  server: (_path: string, _body: any, _signal?: AbortSignal): Response | Promise<Response> =>
    Response.json({ error: "not_found" }, { status: 404 }),
  /** URLs handed to the browser. */
  opened: [] as string[],
}));

// The fake worker signs Passes with its own throwaway key pair; the app is given the public half.
const keys = await vi.hoisted(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
});

vi.mock("./pass-key", () => ({ PASS_PUBLIC_KEY: keys.publicJwk }));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    h.requests.push({ path, body });
    return h.server(path, body, init.signal ?? undefined);
  },
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: async (url: string) => {
    h.opened.push(url);
  },
}));

vi.mock("./db", () => ({
  loadCardState: async () => {
    if (h.loadFailures-- > 0) throw new Error("database is locked");
    return h.disk;
  },
  saveCardState: async (state: string) => {
    if (h.saveFailures-- > 0) throw new Error("disk full");
    h.disk = state;
  },
}));

type CardModule = typeof import("./card-premium");

/** Launch the app: a fresh module instance against whatever is on the fake disk. */
async function launch(): Promise<CardModule> {
  vi.resetModules();
  const m = await import("./card-premium");
  await m.initCardPremium().catch(() => {}); // App.svelte swallows a failed load the same way
  return m;
}

const SESSION = "s".repeat(43);

const CHALLENGE = "c".repeat(43);
const DAY = 24 * 60 * 60 * 1000;

/** The fake worker's view of the world. */
const world = {
  /** Whether the account's subscription is active. */
  paid: false,
  /** Unpaid because a renewal charge was declined (Stripe past_due), rather than never paid. */
  paymentFailed: false,
  /** The device the server currently has signed in. */
  deviceId: "",
  /** How far the server's clock is ahead of the (possibly faked) local one. */
  serverAheadMs: 0,
};

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A Pass signed exactly as the worker signs one. */
async function signPass(payload: object): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new TextEncoder().encode(body)
  );
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** A worker that hands out CHALLENGE, accepts code 123456 with it, and renews per `world`. */
async function happyServer(path: string, body: any): Promise<Response> {
  if (path === "/auth/start") return Response.json({ ok: true, challenge: CHALLENGE });
  if (path === "/auth/verify") {
    if (body.challenge !== CHALLENGE) return Response.json({ error: "code_expired" }, { status: 400 });
    if (body.code !== "123456") return Response.json({ error: "wrong_code" }, { status: 400 });
    world.deviceId = body.deviceId;
    return Response.json({ session: SESSION, email: "player@example.com" });
  }
  const serverNow = Date.now() + world.serverAheadMs;
  if (path === "/pass/renew") {
    if (!world.paid) {
      return Response.json({ reason: "not_paid", ...(world.paymentFailed ? { paymentFailed: true } : {}), serverNow });
    }
    const pass = await signPass({
      v: 1,
      email: "player@example.com",
      deviceId: world.deviceId,
      iat: serverNow,
      exp: serverNow + 3 * DAY,
    });
    return Response.json({ pass, serverNow });
  }
  if (path === "/checkout") {
    if (world.paymentFailed && !world.paid) return Response.json({ paymentFailed: true, serverNow });
    return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_1", serverNow });
  }
  if (path === "/portal") return Response.json({ url: "https://billing.stripe.com/p/session/test_1", serverNow });
  if (path === "/auth/signout") return Response.json({ ok: true });
  return Response.json({ error: "not_found" }, { status: 404 });
}

const verifyRequest = () => h.requests.filter((r) => r.path === "/auth/verify").at(-1);

beforeEach(() => {
  h.disk = null;
  h.loadFailures = 0;
  h.saveFailures = 0;
  h.requests = [];
  h.opened = [];
  h.server = happyServer;
  world.paid = false;
  world.paymentFailed = false;
  world.deviceId = "";
  world.serverAheadMs = 0;
});

describe("signing in", () => {
  it("starts signed out on a fresh install", async () => {
    const m = await launch();
    expect(get(m.cardAccount)).toEqual({ kind: "signed_out" });
  });

  it("emails a code, then signs in with it", async () => {
    const m = await launch();

    await m.startSignIn("Player@Example.com");
    expect(get(m.cardAccount)).toEqual({ kind: "code_sent", email: "Player@Example.com" });

    await m.confirmCode("123456");
    expect(get(m.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com" });
  });

  it("proves the code with the challenge /auth/start gave it, not the email", async () => {
    const m = await launch();
    await m.startSignIn("player@example.com");
    await m.confirmCode("123456");
    expect(verifyRequest()).toEqual({
      path: "/auth/verify",
      body: { challenge: CHALLENGE, code: "123456", deviceId: expect.any(String) },
    });
  });

  it("is still signed in after a restart", async () => {
    const first = await launch();
    await first.startSignIn("player@example.com");
    await first.confirmCode("123456");

    const second = await launch();
    expect(get(second.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com" });
  });

  it("identifies this install with the same device id on every launch", async () => {
    async function deviceIdSentBy(m: CardModule): Promise<string> {
      await m.startSignIn("player@example.com");
      await m.confirmCode("123456");
      return h.requests.filter((r) => r.path === "/auth/verify").at(-1)!.body.deviceId;
    }
    const first = await deviceIdSentBy(await launch());
    const second = await deviceIdSentBy(await launch());

    expect(first).toMatch(/^\S{16,}$/);
    expect(second).toBe(first);
  });
});

describe("when a step fails", () => {
  async function codeSent(): Promise<CardModule> {
    const m = await launch();
    await m.startSignIn("player@example.com");
    return m;
  }

  it("a wrong code says so and leaves the code screen up", async () => {
    const m = await codeSent();
    await expect(m.confirmCode("000000")).rejects.toMatchObject({ reason: "wrong_code" });
    expect(get(m.cardAccount)).toEqual({ kind: "code_sent", email: "player@example.com" });
  });

  it("passes the worker's definite answers to sending a code through", async () => {
    const answers = { bad_request: "bad_email", rate_limited: "rate_limited", email_failed: "email_failed" };
    const m = await launch();
    for (const [error, reason] of Object.entries(answers)) {
      h.server = () => Response.json({ error }, { status: 400 });
      await expect(m.startSignIn("player@example.com")).rejects.toMatchObject({ reason });
    }
    expect(get(m.cardAccount)).toEqual({ kind: "signed_out" });
  });

  it("passes the worker's definite answers to a code through", async () => {
    // bad_request here can only mean the challenge or device id was mangled: start over.
    const answers = { wrong_code: "wrong_code", code_expired: "code_expired", bad_request: "code_expired" };
    const m = await codeSent();
    for (const [error, reason] of Object.entries(answers)) {
      h.server = () => Response.json({ error }, { status: 400 });
      await expect(m.confirmCode("123456")).rejects.toMatchObject({ reason });
    }
  });

  it("treats anything that isn't a definite answer as unreachable", async () => {
    const replies: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError("network down")),
      () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      () => Response.json({ message: "upstream" }, { status: 503 }),
      () => Response.json({ error: "something_new" }, { status: 400 }),
      () => Response.json({ error: "constructor" }, { status: 400 }),
      () => Response.json(["not", "an", "object"]),
      // 200s missing what makes them a success: no challenge, no session.
      () => Response.json({ ok: true }),
    ];
    const m = await codeSent();
    for (const reply of replies) {
      h.server = reply;
      await expect(m.startSignIn("player@example.com")).rejects.toMatchObject({
        reason: "unreachable",
      });
      await expect(m.confirmCode("123456")).rejects.toMatchObject({ reason: "unreachable" });
    }
    expect(get(m.cardAccount)).toEqual({ kind: "code_sent", email: "player@example.com" });
    expect(h.disk).not.toContain("session\":\"");
  });

  it("gives up on a server that never answers", async () => {
    h.server = (_path, _body, signal) =>
      new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

    const m = await launch();
    vi.useFakeTimers();
    try {
      const pending = m.startSignIn("player@example.com");
      const settled = expect(pending).rejects.toMatchObject({ reason: "unreachable" });
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  // Tauri's fetch cancels the request on abort even after it has finished, and that cancel
  // rejects outside any await ("resource id is invalid"), which main.ts turns into a blank app.
  it("never aborts a request that has already been answered", async () => {
    const signals: AbortSignal[] = [];
    h.server = (path, body, signal) => {
      if (signal) signals.push(signal);
      return happyServer(path, body);
    };

    const m = await launch();
    vi.useFakeTimers();
    // Node's AbortSignal.timeout runs on internal timers fake time can't reach; put it on the
    // fake clock so a stray timeout would actually fire here.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    });
    try {
      await m.startSignIn("player@example.com");
      await m.confirmCode("123456");
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
    expect(signals).toHaveLength(3); // start, verify, and the renewal right after
    expect(signals.every((s) => !s.aborted)).toBe(true);
  });
});

describe("when account.db misbehaves", () => {
  it("retries a load that failed at launch instead of signing in without a device id", async () => {
    h.loadFailures = 1;
    const m = await launch();
    await m.startSignIn("player@example.com");
    await m.confirmCode("123456");
    expect(verifyRequest()!.body.deviceId).toMatch(/^\S{16,}$/);
  });

  it("says so when it can't be read at all", async () => {
    h.loadFailures = 99;
    const m = await launch();
    await expect(m.startSignIn("player@example.com")).rejects.toMatchObject({ reason: "storage" });
    expect(h.requests).toHaveLength(0);
  });

  it("keeps a sign-in the server accepted for this run when it can't be saved", async () => {
    const m = await launch();
    await m.startSignIn("player@example.com");
    h.saveFailures = 1;
    await expect(m.confirmCode("123456")).rejects.toMatchObject({ reason: "storage" });
    expect(get(m.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com" });
  });
});

describe("signing out", () => {
  it("sticks across a restart and keeps the device id", async () => {
    const m = await launch();
    await m.startSignIn("player@example.com");
    await m.confirmCode("123456");
    const deviceId = JSON.parse(h.disk!).deviceId;

    await m.signOut();
    expect(get(m.cardAccount)).toEqual({ kind: "signed_out" });
    expect(get((await launch()).cardAccount)).toEqual({ kind: "signed_out" });
    expect(JSON.parse(h.disk!).deviceId).toBe(deviceId);
  });

  it("from the code screen goes back to the email screen", async () => {
    const m = await launch();
    await m.startSignIn("player@example.com");
    await m.signOut();
    expect(get(m.cardAccount)).toEqual({ kind: "signed_out" });
  });
});

describe("a damaged account.db", () => {
  it("starts signed out with a new device id instead of failing to launch", async () => {
    for (const junk of ["{not json", "null", '{"deviceId":""}', '{"email":"x@y.z"}']) {
      h.disk = junk;
      const m = await launch();
      expect(get(m.cardAccount)).toEqual({ kind: "signed_out" });
      expect(JSON.parse(h.disk!).deviceId).toMatch(/^\S{16,}$/);
    }
  });
});

/** Signed in, with or without a paid subscription. */
async function signedIn(paid = false): Promise<CardModule> {
  world.paid = paid;
  const m = await launch();
  await m.startSignIn("player@example.com");
  await m.confirmCode("123456");
  return m;
}

async function premiumStores() {
  const store = await import("./store");
  return { isPremium: get(store.isPremium), cardPremium: get(store.cardPremium) };
}

const renewCount = () => h.requests.filter((r) => r.path === "/pass/renew").length;

describe("Premium by card", () => {
  it("switches on at sign-in for someone who already pays", async () => {
    const m = await signedIn(true);
    expect(get(m.cardAccount)).toEqual({ kind: "premium", email: "player@example.com" });
    expect(await premiumStores()).toEqual({ isPremium: true, cardPremium: true });
  });

  it("stays off for someone signed in who hasn't paid", async () => {
    const m = await signedIn(false);
    expect(get(m.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com" });
    expect(await premiumStores()).toEqual({ isPremium: false, cardPremium: false });
  });

  it("subscribing opens Checkout, then switches on by itself once the payment lands", async () => {
    const m = await signedIn(false);
    vi.useFakeTimers();
    try {
      await m.subscribe();
      expect(h.opened).toEqual(["https://checkout.stripe.com/c/pay/cs_test_1"]);
      expect(get(m.cardAccount)).toMatchObject({ kind: "signed_in", awaitingPayment: true });

      await vi.advanceTimersByTimeAsync(9_000); // still paying
      expect(get(m.cardAccount)).toMatchObject({ kind: "signed_in", awaitingPayment: true });

      world.paid = true;
      await vi.advanceTimersByTimeAsync(3_000);
      // Signing and checking the Pass is real WebCrypto, which settles on its own thread rather
      // than on the fake clock, so wait for the poll's renewal to land.
      await vi.waitFor(() =>
        expect(get(m.cardAccount)).toEqual({ kind: "premium", email: "player@example.com" })
      );
      expect(renewCount()).toBeLessThanOrEqual(6); // polled every 3s, not in a tight loop
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for a payment after 10 minutes", async () => {
    const m = await signedIn(false);
    vi.useFakeTimers();
    try {
      await m.subscribe();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 3_000);
      expect(get(m.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com" });
      const after = renewCount();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(renewCount()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't open Checkout for someone already paying", async () => {
    const m = await signedIn(false);
    world.paid = true;
    h.server = async (path, body) =>
      path === "/checkout"
        ? Response.json({ alreadyPremium: true, serverNow: Date.now() })
        : happyServer(path, body);
    await m.subscribe();
    expect(h.opened).toEqual([]);
    expect(get(m.cardAccount)).toMatchObject({ kind: "premium" });
  });

  it("is still on after a restart, even with the server down at launch", async () => {
    await signedIn(true);
    h.server = () => Promise.reject(new TypeError("network down"));
    const m = await launch();
    expect(get(m.cardAccount)).toEqual({ kind: "premium", email: "player@example.com" });
  });

  it("can't be granted by editing the stored Pass", async () => {
    await signedIn(true);
    const disk = JSON.parse(h.disk!);
    const sig = disk.pass.split(".")[1];
    const payload = { v: 1, email: "player@example.com", deviceId: disk.deviceId, iat: 0, exp: Date.now() + 365 * DAY };
    const forged = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    h.disk = JSON.stringify({ ...disk, pass: forged + "." + sig });
    h.server = () => Promise.reject(new TypeError("network down"));
    expect(get((await launch()).cardAccount)).toMatchObject({ kind: "signed_in" });
  });

  it("won't accept a Pass issued to another device", async () => {
    const m = await signedIn(false);
    world.paid = true;
    world.deviceId = "someone-elses-device";
    await m.initCardPremium();
    expect(get(m.cardAccount)).toMatchObject({ kind: "signed_in" });
  });

  it("switches off when the server says the subscription isn't paid", async () => {
    const m = await signedIn(true);
    world.paid = false;
    await m.initCardPremium();
    expect(get(m.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com" });
    expect(await premiumStores()).toEqual({ isPremium: false, cardPremium: false });
  });

  it("signs out, saying why, when another computer signs in to the account", async () => {
    const m = await signedIn(true);
    h.server = async () => Response.json({ reason: "device_replaced", serverNow: Date.now() });
    await m.initCardPremium();
    expect(get(m.cardAccount)).toEqual({ kind: "replaced", email: "player@example.com" });
    expect(await premiumStores()).toEqual({ isPremium: false, cardPremium: false });
    expect(get((await launch()).cardAccount)).toEqual({ kind: "replaced", email: "player@example.com" });
  });

  it("renews every 6 hours while the app is open", async () => {
    const m = await signedIn(true);
    vi.useFakeTimers();
    try {
      await m.initCardPremium();
      const before = renewCount();
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(renewCount()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("when the server can't be reached", () => {
  const T0 = Date.UTC(2026, 9, 14, 12);
  const unreachable: (() => Response | Promise<Response>)[] = [
    () => Promise.reject(new TypeError("network down")),
    () => Response.json({ error: "stripe_unreachable" }, { status: 503 }),
    () => new Response("<html>502</html>", { status: 502 }),
    () => Response.json({ serverNow: T0 }), // a 200 with no Pass in it
    () => Response.json({ pass: "not.a-pass", serverNow: T0 }),
    () => new Response("rate limited", { status: 429, headers: { "retry-after": "60" } }),
    () => Response.json({ error: "bad_request" }, { status: 400 }), // a 4xx is never a definite answer
  ];

  for (const [i, reply] of unreachable.entries()) {
    it("keeps Premium through 7 days of grace past the Pass's expiry, failure " + (i + 1), async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(T0);
        const m = await signedIn(true); // the Pass expires at T0 + 3 days
        h.server = reply;

        vi.setSystemTime(T0 + 3 * DAY + 6 * DAY);
        await m.initCardPremium();
        expect(get(m.cardAccount), "6 days into grace").toMatchObject({ kind: "premium" });

        vi.setSystemTime(T0 + 3 * DAY + 7 * DAY + 1);
        await m.initCardPremium();
        expect(get(m.cardAccount), "grace over").toMatchObject({ kind: "signed_in" });
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("gives no grace once the server has said the subscription ended", async () => {
    const m = await signedIn(true);
    world.paid = false;
    await m.initCardPremium(); // definite: not_paid
    h.server = () => Promise.reject(new TypeError("network down"));
    await m.initCardPremium();
    expect(get(m.cardAccount)).toMatchObject({ kind: "signed_in" });
  });
});

describe("a wrong PC clock", () => {
  it("can't expire a valid Pass early", async () => {
    const T0 = Date.UTC(2026, 9, 14, 12);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0 + 5 * DAY); // this PC thinks it's 5 days later than it is
      world.serverAheadMs = -5 * DAY;
      const m = await signedIn(true);
      h.server = () => Promise.reject(new TypeError("network down"));
      await m.initCardPremium();
      expect(get(m.cardAccount)).toMatchObject({ kind: "premium" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("alongside the Discord route", () => {
  it("leaves a Discord patron Premium whatever the card side says", async () => {
    await signedIn(false);
    const store = await import("./store");
    store.discordPremium.set(true);
    expect(get(store.isPremium)).toBe(true);
    store.discordPremium.set(false);
    expect(get(store.isPremium)).toBe(false);
  });

  it("keeps Discord Premium under its old storage key, so no patron loses it on update", async () => {
    localStorage.setItem("srs_isPremium", "true");
    try {
      vi.resetModules();
      const store = await import("./store");
      expect(get(store.discordPremium)).toBe(true);
      expect(get(store.isPremium)).toBe(true);
    } finally {
      localStorage.removeItem("srs_isPremium");
    }
  });
});

describe("managing the subscription", () => {
  it("opens the Customer Portal; for a Premium player there's nothing to wait for", async () => {
    const m = await signedIn(true);
    await m.manageSubscription();
    expect(h.opened).toEqual(["https://billing.stripe.com/p/session/test_1"]);
    expect(get(m.cardAccount)).toEqual({ kind: "premium", email: "player@example.com" });
  });

  it("stays signed in when there's no subscription to manage", async () => {
    const m = await signedIn(false);
    h.server = async (path, body) =>
      path === "/portal" ? Response.json({ reason: "no_subscription", serverNow: Date.now() }) : happyServer(path, body);
    await m.manageSubscription();
    expect(h.opened).toEqual([]);
    expect(get(m.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com" });
  });
});

describe("a declined renewal", () => {
  it("says the payment failed, offers the portal instead of a second subscription, and recovers", async () => {
    const m = await signedIn(true);
    world.paid = false;
    world.paymentFailed = true; // the renewal charge was declined
    await m.initCardPremium();
    expect(get(m.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com", paymentFailed: true });
    expect(await premiumStores()).toEqual({ isPremium: false, cardPremium: false });

    await m.subscribe(); // the worker refuses a second subscription
    expect(h.opened).toEqual([]);
    expect(get(m.cardAccount)).toMatchObject({ paymentFailed: true });

    vi.useFakeTimers();
    try {
      await m.manageSubscription();
      expect(h.opened).toEqual(["https://billing.stripe.com/p/session/test_1"]);
      expect(get(m.cardAccount)).toMatchObject({ kind: "signed_in", awaitingPayment: true });

      world.paid = true; // new card in the portal, Stripe's retry went through
      world.paymentFailed = false;
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() =>
        expect(get(m.cardAccount)).toEqual({ kind: "premium", email: "player@example.com" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the failed payment on sign-out", async () => {
    const m = await signedIn(false);
    world.paymentFailed = true;
    await m.initCardPremium();
    await m.signOut();
    world.paymentFailed = false;
    await m.startSignIn("player@example.com");
    await m.confirmCode("123456");
    expect(get(m.cardAccount)).toEqual({ kind: "signed_in", email: "player@example.com" });
  });
});

describe("signing out on the server", () => {
  it("ends the session there too, so it can't be renewed from a copy of account.db", async () => {
    const m = await signedIn(true);
    await m.signOut();
    await vi.waitFor(() =>
      expect(h.requests.at(-1)).toEqual({ path: "/auth/signout", body: { session: SESSION } })
    );
  });

  it("still signs this computer out when the server can't be reached", async () => {
    const m = await signedIn(true);
    h.server = () => Promise.reject(new TypeError("network down"));
    await m.signOut();
    expect(get(m.cardAccount)).toEqual({ kind: "signed_out" });
    expect(await premiumStores()).toEqual({ isPremium: false, cardPremium: false });
    expect(get((await launch()).cardAccount)).toEqual({ kind: "signed_out" });
  });

  it("doesn't call the server when nobody was signed in", async () => {
    const m = await launch();
    await m.signOut();
    expect(h.requests.filter((r) => r.path === "/auth/signout")).toEqual([]);
  });
});

describe("the server losing this computer's session (signed_out)", () => {
  const T0 = Date.UTC(2026, 9, 14, 12);
  const signedOutReply = async () => Response.json({ reason: "signed_out", serverNow: Date.now() });

  it("keeps Premium until the Pass expires, asks to sign in again, and gives no grace after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      const m = await signedIn(true); // the Pass expires at T0 + 3 days
      h.server = signedOutReply;
      vi.setSystemTime(T0 + 1 * DAY);
      await m.initCardPremium();
      expect(get(m.cardAccount)).toEqual({ kind: "sign_in_again", email: "player@example.com", premium: true });
      expect(await premiumStores()).toEqual({ isPremium: true, cardPremium: true });

      // Survives a restart (with the server unreachable, nothing changes either way).
      h.server = () => Promise.reject(new TypeError("network down"));
      const relaunched = await launch();
      expect(get(relaunched.cardAccount)).toMatchObject({ kind: "sign_in_again", premium: true });

      vi.setSystemTime(T0 + 3 * DAY + 1); // the Pass has expired: no 7-day grace in this state
      const later = await launch();
      expect(get(later.cardAccount)).toEqual({ kind: "sign_in_again", email: "player@example.com", premium: false });
      expect(await premiumStores()).toEqual({ isPremium: false, cardPremium: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is back to normal after signing in again", async () => {
    const m = await signedIn(true);
    h.server = signedOutReply;
    await m.initCardPremium();
    h.server = happyServer;
    await m.startSignIn("player@example.com");
    await m.confirmCode("123456");
    expect(get(m.cardAccount)).toEqual({ kind: "premium", email: "player@example.com" });
    expect(JSON.parse(h.disk!).needsSignIn).toBe(false);
  });

  it("stops renewing until then: there's no session to renew with", async () => {
    const m = await signedIn(true);
    h.server = signedOutReply;
    await m.initCardPremium();
    const before = h.requests.length;
    await m.initCardPremium();
    expect(h.requests.length).toBe(before);
  });

  it("is cleared by signing out on purpose", async () => {
    const m = await signedIn(true);
    h.server = signedOutReply;
    await m.initCardPremium();
    await m.signOut();
    expect(get(m.cardAccount)).toEqual({ kind: "signed_out" });
    expect(await premiumStores()).toEqual({ isPremium: false, cardPremium: false });
  });
});

describe("a renewal that never answers", () => {
  it("is abandoned after 15 s without touching Premium", async () => {
    const m = await signedIn(true);
    let aborted = false;
    h.server = (_path, _body, signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        })
      );
    vi.useFakeTimers();
    try {
      const renewal = m.initCardPremium();
      await vi.advanceTimersByTimeAsync(15_000);
      await renewal;
    } finally {
      vi.useRealTimers();
    }
    expect(aborted).toBe(true);
    expect(get(m.cardAccount)).toEqual({ kind: "premium", email: "player@example.com" });
  });
});

describe("a corrupted saved Pass", () => {
  it("counts for nothing, and the next renewal puts things right", async () => {
    await signedIn(true);
    h.disk = JSON.stringify({ ...JSON.parse(h.disk!), pass: " garbage%%%.not-base64" });
    h.server = () => Promise.reject(new TypeError("network down"));
    const offline = await launch();
    expect(get(offline.cardAccount)).toMatchObject({ kind: "signed_in" });

    h.server = happyServer;
    const online = await launch();
    expect(get(online.cardAccount)).toEqual({ kind: "premium", email: "player@example.com" });
  });
});
