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

export default {
  async fetch(request, env) {
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
    } catch {
      return cors({ premium: null, reason: "transient" }, 502);
    }

    if (userRes.status === 401) {
      return cors({ premium: false, reason: "auth_invalid" });
    }
    if (!userRes.ok) {
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
    } catch {
      return cors({ premium: null, reason: "transient", username, userId }, 502);
    }

    if (memberRes.status === 404) {
      return cors({ premium: false, reason: "not_in_guild", username, userId });
    }
    if (!memberRes.ok) {
      return cors({ premium: null, reason: "transient", username, userId }, 502);
    }

    const member = await memberRes.json();
    const roles = Array.isArray(member.roles) ? member.roles : [];
    const hasPremium = roles.some((r) => PREMIUM_ROLE_IDS.has(r));

    return cors({
      premium: hasPremium,
      reason: hasPremium ? "premium" : "no_role",
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
