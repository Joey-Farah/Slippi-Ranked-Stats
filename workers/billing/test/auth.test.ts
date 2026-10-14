import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// Every email the worker hands to Resend, captured instead of sent.
let sent: { to: string; text: string }[] = [];

beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body));
    sent.push({ to: [body.to].flat()[0], text: body.text });
    return Response.json({ id: "email_1" });
  });
});

const EMAIL = "player@example.com";
const DEVICE = "device-a";
const IP = "203.0.113.7";
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;

async function post(path: string, body: unknown, ip = IP) {
  const res = await exports.default.fetch(
    new Request(`https://billing.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** The 6-digit code in the newest email sent to `email`. */
function codeSentTo(email: string): string {
  const mail = sent.filter((m) => m.to === email).at(-1);
  const code = mail?.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

/** Ask for a code; returns the challenge it's bound to and the code that was emailed. */
async function start(email = EMAIL, ip = IP): Promise<{ challenge: string; code: string }> {
  const res = await post("/auth/start", { email }, ip);
  expect(res.status).toBe(200);
  return { challenge: res.body.challenge, code: codeSentTo(email.trim().toLowerCase()) };
}

function verify(challenge: string, code: string, deviceId = DEVICE) {
  return post("/auth/verify", { challenge, code, deviceId });
}

function wrongFor(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

const CODE_EXPIRED = { status: 400, body: { error: "code_expired" } };
const WRONG_CODE = { status: 400, body: { error: "wrong_code" } };
const RATE_LIMITED = { status: 429, body: { error: "rate_limited" } };

describe("sign-in round trip", () => {
  it("emails a 6-digit code that verifies, with its challenge, into a session", async () => {
    const res = await post("/auth/start", { email: EMAIL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, challenge: expect.stringMatching(/^[\w-]{40,}$/) });

    const signedIn = await verify(res.body.challenge, codeSentTo(EMAIL));
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual({
      session: expect.stringMatching(/^[\w-]{40,}$/),
      email: EMAIL,
    });
  });

  it("answers the same whether or not the email already has an account", async () => {
    const first = await start();
    await verify(first.challenge, first.code);

    const existing = await post("/auth/start", { email: EMAIL });
    const fresh = await post("/auth/start", { email: "new@example.com" });
    expect(existing.status).toBe(fresh.status);
    expect(Object.keys(existing.body)).toEqual(Object.keys(fresh.body));
  });
});

describe("the email address", () => {
  it("is matched regardless of case and surrounding spaces", async () => {
    const { challenge, code } = await start("  Player@Example.COM ");
    expect((await verify(challenge, code)).body.email).toBe(EMAIL);
  });

  it("is rejected when it isn't a plain address, and nothing is sent", async () => {
    const junk = [
      "", "player", "player@", "@example.com", "a b@example.com", "player@example",
      "a<player@example.com>", "player@example.com,other@example.com", '"a"@example.com',
      `${"a".repeat(250)}@example.com`, 42, null,
    ];
    for (const email of junk) {
      expect(await post("/auth/start", { email }), String(email)).toEqual({
        status: 400,
        body: { error: "bad_request" },
      });
    }
    expect(sent).toHaveLength(0);
  });
});

describe("when the email can't be sent", () => {
  it("says so, and the failed try doesn't count against the rate limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce(new Response("upstream down", { status: 500 }));
    expect(await post("/auth/start", { email: EMAIL })).toEqual({
      status: 502,
      body: { error: "email_failed" },
    });

    for (let i = 0; i < 5; i++) await start();
  });
});

describe("with no Resend key", () => {
  async function startWith(vars: Partial<Env>) {
    const res = await worker.fetch(
      new Request("https://billing.test/auth/start", {
        method: "POST",
        body: JSON.stringify({ email: EMAIL }),
      }),
      { ...env, RESEND_API_KEY: undefined, ...vars },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("staging writes the code to its log instead", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await startWith({ ALLOW_LOGGED_CODES: "1" })).status).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/player@example\.com: \d{6}$/));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("production fails rather than logging codes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await startWith({ ALLOW_LOGGED_CODES: undefined })).toEqual({
      status: 502,
      body: { error: "email_failed" },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("production's config doesn't allow logging codes", () => {
    // `env` here is wrangler.toml's top-level (production) config.
    expect(env.ALLOW_LOGGED_CODES).toBeUndefined();
  });
});

describe("a code", () => {
  it("still works 9 minutes 59 seconds after it was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const { challenge, code } = await start();
    vi.setSystemTime(T0 + 10 * MIN - 1000);
    expect((await verify(challenge, code)).status).toBe(200);
  });

  it("stops working 10 minutes after it was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const { challenge, code } = await start();
    vi.setSystemTime(T0 + 10 * MIN + 1000);
    expect(await verify(challenge, code)).toEqual(CODE_EXPIRED);
  });

  it("works once", async () => {
    const { challenge, code } = await start();
    expect((await verify(challenge, code)).status).toBe(200);
    expect(await verify(challenge, code)).toEqual(CODE_EXPIRED);
  });

  it("stops working after 5 wrong tries, even with the right code", async () => {
    const { challenge, code } = await start();
    for (let i = 0; i < 4; i++) expect(await verify(challenge, wrongFor(code))).toEqual(WRONG_CODE);
    // The 5th miss says the code is gone, so the app can send the player to ask for a new one.
    expect(await verify(challenge, wrongFor(code))).toEqual(CODE_EXPIRED);
    expect(await verify(challenge, code)).toEqual(CODE_EXPIRED);
  });

  it("holds its 5-try cap against parallel guesses", async () => {
    const { challenge, code } = await start();
    const guesses = await Promise.all(
      Array.from({ length: 40 }, () => verify(challenge, wrongFor(code))),
    );
    expect(guesses.filter((g) => g.body.error === "wrong_code")).toHaveLength(4);
    expect(await verify(challenge, code)).toEqual(CODE_EXPIRED);
  });

  it("can only be claimed by one of several parallel requests", async () => {
    const { challenge, code } = await start();
    const tries = await Promise.all(Array.from({ length: 5 }, () => verify(challenge, code)));
    expect(tries.filter((t) => t.status === 200)).toHaveLength(1);
  });
});

describe("someone who only knows the player's email", () => {
  it("can't use the code with a challenge of their own", async () => {
    const attacker = await start(EMAIL, "198.51.100.66");
    const player = await start();
    if (attacker.code !== player.code) {
      expect(await verify(attacker.challenge, player.code)).toEqual(WRONG_CODE);
    }
  });

  it("can't burn the player's tries", async () => {
    const player = await start();
    for (let i = 0; i < 20; i++) {
      expect(await verify(`forged-challenge-${i}`, wrongFor(player.code))).toEqual(CODE_EXPIRED);
    }
    expect((await verify(player.challenge, player.code)).status).toBe(200);
  });

  it("can't retire the player's code by asking for another", async () => {
    const player = await start();
    await start(EMAIL, "198.51.100.66");
    expect((await verify(player.challenge, player.code)).status).toBe(200);
  });
});

describe("asking for codes is rate-limited", () => {
  it("to 5 an hour per email, without sending the 6th", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    for (let i = 0; i < 5; i++) await start(EMAIL, `198.51.100.${i}`);
    expect(await post("/auth/start", { email: EMAIL }, "198.51.100.99")).toEqual(RATE_LIMITED);
    expect(sent).toHaveLength(5);

    vi.setSystemTime(T0 + 60 * MIN - 1000);
    expect(await post("/auth/start", { email: EMAIL })).toEqual(RATE_LIMITED);
    vi.setSystemTime(T0 + 60 * MIN + 1000);
    await start();
  });

  it("to 10 a day per email", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    for (let i = 0; i < 5; i++) await start();
    vi.setSystemTime(T0 + 61 * MIN);
    for (let i = 0; i < 5; i++) await start();
    vi.setSystemTime(T0 + 122 * MIN);
    expect(await post("/auth/start", { email: EMAIL })).toEqual(RATE_LIMITED);

    vi.setSystemTime(T0 + 24 * 60 * MIN + 1000);
    await start();
  });

  it("to 20 an hour per IP address", async () => {
    for (let i = 0; i < 20; i++) await start(`p${i}@example.com`);
    expect(await post("/auth/start", { email: "p20@example.com" })).toEqual(RATE_LIMITED);
    await start("p20@example.com", "192.0.2.1");
  });

  it("per /64 for IPv6, which hands each user a whole block", async () => {
    for (let i = 0; i < 20; i++) await start(`p${i}@example.com`, `2001:db8:a:b::${i + 1}`);
    expect(
      await post("/auth/start", { email: "p20@example.com" }, "2001:db8:a:b:ffff:1:2:3"),
    ).toEqual(RATE_LIMITED);
    await start("p20@example.com", "2001:db8:a:c::1");
  });

  it("even when the requests arrive all at once", async () => {
    const burst = await Promise.all(
      Array.from({ length: 30 }, (_, i) => post("/auth/start", { email: EMAIL }, `198.51.100.${i}`)),
    );
    expect(burst.filter((r) => r.status === 200)).toHaveLength(5);
    expect(sent).toHaveLength(5);
  });
});

describe("signing in again", () => {
  async function signIn(deviceId: string) {
    const { challenge, code } = await start();
    return (await verify(challenge, code, deviceId)).body.session as string;
  }

  it("issues a fresh session and keeps the old one on record as replaced", async () => {
    const first = await signIn("device-a");
    const second = await signIn("device-b");
    expect(second).not.toBe(first);

    // Slice 4 answers "device_replaced" for a replaced session and "signed_out" for one it has
    // never seen, so a replacement must not erase the old session.
    const { results } = await env.DB.prepare(
      "SELECT device_id, replaced_at FROM sessions ORDER BY created_at, rowid",
    ).all<{ device_id: string; replaced_at: number | null }>();
    expect(results).toEqual([
      { device_id: "device-a", replaced_at: expect.any(Number) },
      { device_id: "device-b", replaced_at: null },
    ]);
  });
});
