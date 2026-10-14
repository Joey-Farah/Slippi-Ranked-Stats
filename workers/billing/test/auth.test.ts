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

async function post(path: string, body: unknown, ip = "203.0.113.7") {
  const res = await exports.default.fetch(
    new Request(`https://billing.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The 6-digit code in the newest email sent to `email`. */
function codeSentTo(email: string): string {
  const mail = sent.filter((m) => m.to === email).at(-1);
  const code = mail?.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

const EMAIL = "player@example.com";
const DEVICE = "device-a";

describe("sign-in round trip", () => {
  it("emails a 6-digit code that verifies into a session", async () => {
    const start = await post("/auth/start", { email: EMAIL });
    expect(start).toEqual({ status: 200, body: { ok: true } });

    const verify = await post("/auth/verify", {
      email: EMAIL,
      code: codeSentTo(EMAIL),
      deviceId: DEVICE,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.email).toBe(EMAIL);
    expect(verify.body.session).toMatch(/^[\w-]{40,}$/);
  });
});

describe("the email address", () => {
  it("is matched regardless of case and surrounding spaces", async () => {
    await post("/auth/start", { email: "  Player@Example.COM " });
    const verify = await post("/auth/verify", {
      email: "player@example.com",
      code: codeSentTo(EMAIL),
      deviceId: DEVICE,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.email).toBe(EMAIL);
  });

  it("is rejected when it isn't one, and nothing is sent", async () => {
    for (const email of ["", "player", "player@", "@example.com", "a b@example.com", 42, null]) {
      expect(await post("/auth/start", { email })).toEqual({
        status: 400,
        body: { error: "bad_request" },
      });
    }
    expect(sent).toHaveLength(0);
  });
});

describe("when the email can't be sent", () => {
  it("says so, and the failed try doesn't count against the rate limit", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("upstream down", { status: 500 }));
    expect(await post("/auth/start", { email: EMAIL })).toEqual({
      status: 502,
      body: { error: "email_failed" },
    });

    for (let i = 0; i < 5; i++) {
      expect((await post("/auth/start", { email: EMAIL })).status).toBe(200);
    }
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
    return { status: res.status, body: await res.json() };
  }

  it("staging writes the code to its log instead", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await startWith({ ALLOW_LOGGED_CODES: "1" })).toEqual({
      status: 200,
      body: { ok: true },
    });
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
});

describe("signing in again", () => {
  it("issues a fresh session for the same account", async () => {
    async function signIn(deviceId: string) {
      await post("/auth/start", { email: EMAIL });
      return post("/auth/verify", { email: EMAIL, code: codeSentTo(EMAIL), deviceId });
    }
    const first = await signIn("device-a");
    const second = await signIn("device-b");
    expect(second.status).toBe(200);
    expect(second.body.session).not.toBe(first.body.session);
  });
});

describe("a code stops working", () => {
  async function verify(code: string) {
    return post("/auth/verify", { email: EMAIL, code, deviceId: DEVICE });
  }

  it("10 minutes after it was sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 14, 12, 0, 0) });
    await post("/auth/start", { email: EMAIL });
    const code = codeSentTo(EMAIL);

    vi.setSystemTime(Date.UTC(2026, 9, 14, 12, 10, 1));
    expect(await verify(code)).toEqual({ status: 400, body: { error: "code_expired" } });
  });

  it("once it has been used", async () => {
    await post("/auth/start", { email: EMAIL });
    const code = codeSentTo(EMAIL);

    expect((await verify(code)).status).toBe(200);
    expect(await verify(code)).toEqual({ status: 400, body: { error: "code_expired" } });
  });

  it("when a newer code has been asked for", async () => {
    await post("/auth/start", { email: EMAIL });
    const first = codeSentTo(EMAIL);
    await post("/auth/start", { email: EMAIL });
    const second = codeSentTo(EMAIL);

    // A guess that happened to equal `second` would make this vacuous.
    if (first !== second) expect((await verify(first)).status).toBe(400);
    expect((await verify(second)).status).toBe(200);
  });

  it("after 5 wrong tries, even with the right code", async () => {
    await post("/auth/start", { email: EMAIL });
    const code = codeSentTo(EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 4; i++) {
      expect(await verify(wrong)).toEqual({ status: 400, body: { error: "wrong_code" } });
    }
    // The 5th miss says the code is gone, so the app can send the player to ask for a new one.
    expect(await verify(wrong)).toEqual({ status: 400, body: { error: "code_expired" } });
    expect(await verify(code)).toEqual({ status: 400, body: { error: "code_expired" } });
  });
});

describe("asking for codes is rate-limited", () => {
  const RATE_LIMITED = { status: 429, body: { error: "rate_limited" } };

  it("to 5 an hour per email, without sending the 6th", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 14, 12, 0, 0) });
    for (let i = 0; i < 5; i++) {
      expect((await post("/auth/start", { email: EMAIL }, `198.51.100.${i}`)).status).toBe(200);
    }
    expect(await post("/auth/start", { email: EMAIL }, "198.51.100.99")).toEqual(RATE_LIMITED);
    expect(sent).toHaveLength(5);

    vi.setSystemTime(Date.UTC(2026, 9, 14, 13, 0, 1));
    expect((await post("/auth/start", { email: EMAIL })).status).toBe(200);
  });

  it("to 20 an hour per IP address", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await post("/auth/start", { email: `p${i}@example.com` })).status).toBe(200);
    }
    expect(await post("/auth/start", { email: "p20@example.com" })).toEqual(RATE_LIMITED);
    expect((await post("/auth/start", { email: "p20@example.com" }, "192.0.2.1")).status).toBe(200);
  });
});
