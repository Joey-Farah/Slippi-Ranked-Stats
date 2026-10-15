import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

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
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    h.requests.push({ path, body });
    return h.server(path, body, init.signal ?? undefined);
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

/** A worker that hands out CHALLENGE and accepts code 123456 with it. */
function happyServer(path: string, body: any): Response {
  if (path === "/auth/start") return Response.json({ ok: true, challenge: CHALLENGE });
  if (path === "/auth/verify") {
    if (body.challenge !== CHALLENGE) return Response.json({ error: "code_expired" }, { status: 400 });
    return body.code === "123456"
      ? Response.json({ session: SESSION, email: "player@example.com" })
      : Response.json({ error: "wrong_code" }, { status: 400 });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

beforeEach(() => {
  h.disk = null;
  h.loadFailures = 0;
  h.saveFailures = 0;
  h.requests = [];
  h.server = happyServer;
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
    expect(h.requests.at(-1)).toEqual({
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
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => !s.aborted)).toBe(true);
  });
});

describe("when account.db misbehaves", () => {
  it("retries a load that failed at launch instead of signing in without a device id", async () => {
    h.loadFailures = 1;
    const m = await launch();
    await m.startSignIn("player@example.com");
    await m.confirmCode("123456");
    expect(h.requests.at(-1)!.body.deviceId).toMatch(/^\S{16,}$/);
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
