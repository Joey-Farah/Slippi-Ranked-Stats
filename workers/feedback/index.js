export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    if (request.method !== "POST") {
      return corsResponse("Method not allowed", 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse("Invalid JSON", 400);
    }

    const name = (body.name ?? "").toString().trim().slice(0, 100);
    const message = (body.message ?? "").toString().trim().slice(0, 2000);
    const type = (body.type ?? "feedback").toString().trim();

    if (!message) {
      return corsResponse("Message is required", 400);
    }

    const color = type === "bug" ? 0xe74c3c : 0x7c3aed;
    const label = type === "bug" ? "Bug Report" : "Suggestion";

    const embed = {
      title: label,
      description: message,
      color,
      fields: name ? [{ name: "From", value: name, inline: true }] : [],
      timestamp: new Date().toISOString(),
      footer: { text: "Slippi Ranked Stats" },
    };

    const webhookUrl = type === "bug" ? env.DISCORD_BUG_WEBHOOK_URL : env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      return corsResponse(`Missing secret: ${type === "bug" ? "DISCORD_BUG_WEBHOOK_URL" : "DISCORD_WEBHOOK_URL"}`, 500);
    }
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      return corsResponse("Failed to send to Discord", 502);
    }

    return corsResponse("ok", 200);
  },
};

function corsResponse(body, status) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  return new Response(body ? JSON.stringify(body) : null, { status, headers });
}
