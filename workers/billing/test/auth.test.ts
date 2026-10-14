import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
