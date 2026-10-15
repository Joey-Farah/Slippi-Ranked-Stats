// Premium-role check, server-side.
//
// The user-context endpoint /users/@me/guilds/{id}/member has been
// historically flaky. We avoid it entirely by using the bot-context
// endpoint /guilds/{id}/members/{user_id}, which is heavily exercised
// by every Discord bot and almost never breaks.
//
// Flow:
//   1. Receive { token } from the app (the user's OAuth Bearer token)
//   2. GET /users/@me with that token to confirm validity + get user_id
//   3. GET /guilds/{GUILD_ID}/members/{user_id} with the bot token
//   4. Return premium status based on whether any role matches

const GUILD_ID = "703857185570029628";
const PREMIUM_ROLE_IDS = new Set([
  "1195042084961386526",
  "1195042365849731142",
  "1195043524463312917",
  "1195043810263175302",
  "1495188057396219904", // Slippi Ranked Stats — auto-assigned to both Patreon and Ko-fi supporters
]);

// ── Temporary diagnostics (2026-10-15) ───────────────────────────────────────
// A patron's launch check fails for ~30 s (sometimes for good) almost every time they open the
// app. To see why without asking them, every check by the users below is recorded in full, and
// every FAILED check by anyone is recorded as bare status codes + time (no ids, no tokens) so it
// can be lined up with their launch times in telemetry. Writes go to `discord_debug` in the
// srs-telemetry D1. Switches itself off after DEBUG_UNTIL; remove this block once diagnosed.
const DEBUG_USER_IDS = new Set(["151834310326878208"]);
const DEBUG_UNTIL = Date.UTC(2026, 9, 29); // 14 days

function record(env, ctx, entry) {
  if (!env.DB || Date.now() > DEBUG_UNTIL) return;
  const debugUser = entry.userId && DEBUG_USER_IDS.has(entry.userId);
  if (!debugUser && entry.reason === "premium") return; // only failures for everyone else
  ctx.waitUntil(
    (async () => {
      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS discord_debug (
             id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT,
             reason TEXT, me_status INTEGER, member_status INTEGER, detail TEXT)`
        ).run();
        await env.DB.prepare(
          "INSERT INTO discord_debug (ts, user_id, reason, me_status, member_status, detail) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(Date.now(), debugUser ? entry.userId : null, entry.reason,
                entry.meStatus ?? null, entry.memberStatus ?? null, entry.detail ?? null)
          .run();
      } catch {
        // diagnostics must never affect the answer
      }
    })()
  );
}

/** Headers worth keeping from a Discord error: rate-limit info and Cloudflare's ray id. */
function errorDetail(res, body) {
  const keep = ["retry-after", "x-ratelimit-scope", "x-ratelimit-bucket", "x-ratelimit-global", "cf-ray"];
  const h = keep.filter((k) => res.headers.get(k)).map((k) => `${k}=${res.headers.get(k)}`);
  return [h.join(" "), (body || "").slice(0, 200)].filter(Boolean).join(" | ");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return cors(null, 204);
    if (request.method !== "POST") return cors({ reason: "method_not_allowed" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return cors({ reason: "bad_request" }, 400);
    }

    const token = body?.token;
    if (!token || typeof token !== "string") {
      return cors({ premium: null, reason: "no_token" }, 400);
    }

    // 1. Verify the user's OAuth token and get their user_id + display name.
    let userRes;
    try {
      userRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      record(env, ctx, { reason: "transient", detail: `users/@me fetch threw: ${e}` });
      return cors({ premium: null, reason: "transient" }, 502);
    }

    if (userRes.status === 401) {
      record(env, ctx, { reason: "auth_invalid", meStatus: 401, detail: errorDetail(userRes, await userRes.text().catch(() => "")) });
      return cors({ premium: false, reason: "auth_invalid" });
    }
    if (!userRes.ok) {
      record(env, ctx, { reason: "transient", meStatus: userRes.status, detail: errorDetail(userRes, await userRes.text().catch(() => "")) });
      return cors({ premium: null, reason: "transient" }, 502);
    }

    const user = await userRes.json();
    const userId = user.id;
    const username = user.global_name ?? user.username ?? null;

    // 2. Bot-context lookup of the member's roles in our guild.
    let memberRes;
    try {
      memberRes = await fetch(
        `https://discord.com/api/guilds/${GUILD_ID}/members/${userId}`,
        { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } }
      );
    } catch (e) {
      record(env, ctx, { userId, reason: "transient", meStatus: 200, detail: `member fetch threw: ${e}` });
      return cors({ premium: null, reason: "transient", username, userId }, 502);
    }

    if (memberRes.status === 404) {
      record(env, ctx, { userId, reason: "not_in_guild", meStatus: 200, memberStatus: 404, detail: errorDetail(memberRes, await memberRes.text().catch(() => "")) });
      return cors({ premium: false, reason: "not_in_guild", username, userId });
    }
    if (!memberRes.ok) {
      record(env, ctx, { userId, reason: "transient", meStatus: 200, memberStatus: memberRes.status, detail: errorDetail(memberRes, await memberRes.text().catch(() => "")) });
      return cors({ premium: null, reason: "transient", username, userId }, 502);
    }

    const member = await memberRes.json();
    const roles = Array.isArray(member.roles) ? member.roles : [];
    const hasPremium = roles.some((r) => PREMIUM_ROLE_IDS.has(r));
    const reason = hasPremium ? "premium" : "no_role";
    record(env, ctx, {
      userId, reason, meStatus: 200, memberStatus: 200,
      detail: DEBUG_USER_IDS.has(userId) ? `roles=${roles.join(",")}` : null,
    });

    return cors({
      premium: hasPremium,
      reason,
      username,
      userId,
    });
  },
};

function cors(payload, status = 200) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (payload === null) return new Response(null, { status, headers });
  return Response.json(payload, { status, headers });
}
