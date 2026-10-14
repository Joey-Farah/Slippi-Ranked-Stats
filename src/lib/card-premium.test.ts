import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

// card-premium.ts is tested through its public surface. Its two edges are faked: the network
// (Tauri's fetch, answered by `h.server`) and the disk (account.db, held in `h.disk`). A
// "restart" is a fresh import of the module against the same disk.
const h = vi.hoisted(() => ({
  disk: null as string | null,
  requests: [] as { path: string; body: any }[],
  server: (_path: string, _body: any): Response | Promise<Response> =>
    Response.json({ error: "not_found" }, { status: 404 }),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    h.requests.push({ path, body });
    return h.server(path, body);
  },
}));

vi.mock("./db", () => ({
  loadCardState: async () => h.disk,
  saveCardState: async (state: string) => void (h.disk = state),
}));

type CardModule = typeof import("./card-premium");

/** Launch the app: a fresh module instance against whatever is on the fake disk. */
async function launch(): Promise<CardModule> {
  vi.resetModules();
  const m = await import("./card-premium");
  await m.initCardPremium();
  return m;
}

const SESSION = "s".repeat(43);

/** A worker that accepts code 123456 for any email. */
function happyServer(path: string, body: any): Response {
  if (path === "/auth/start") return Response.json({ ok: true });
  if (path === "/auth/verify") {
    return body.code === "123456"
      ? Response.json({ session: SESSION, email: body.email.trim().toLowerCase() })
      : Response.json({ error: "wrong_code" }, { status: 400 });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

beforeEach(() => {
  h.disk = null;
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
