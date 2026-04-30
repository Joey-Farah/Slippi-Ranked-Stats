const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id TEXT NOT NULL,
  event     TEXT NOT NULL,
  version   TEXT,
  os        TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_install ON events(install_id);
`;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    const url = new URL(request.url);

    // POST /ping — record an event
    if (request.method === "POST" && url.pathname === "/ping") {
      let body;
      try { body = await request.json(); } catch { return corsResponse("Invalid JSON", 400); }

      const install_id = (body.install_id ?? "").toString().trim().slice(0, 64);
      const event      = (body.event ?? "open").toString().trim().slice(0, 32);
      const version    = (body.version ?? "").toString().trim().slice(0, 20);
      const os         = (body.os ?? "").toString().trim().slice(0, 20);

      if (!install_id) return corsResponse("install_id required", 400);

      await env.DB.prepare(
        "INSERT INTO events (install_id, event, version, os, ts) VALUES (?, ?, ?, ?, ?)"
      ).bind(install_id, event, version, os, Date.now()).run();

      return corsResponse("ok", 200);
    }

    // GET /stats — HTML dashboard
    if (request.method === "GET" && url.pathname === "/stats") {
      const html = await buildDashboard(env.DB);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // POST /init — ensure schema exists (call once after creating DB)
    if (request.method === "POST" && url.pathname === "/init") {
      for (const stmt of SCHEMA.trim().split(";").map(s => s.trim()).filter(Boolean)) {
        await env.DB.prepare(stmt).run();
      }
      return corsResponse("schema created", 200);
    }

    return corsResponse("Not found", 404);
  },
};

async function buildDashboard(db) {
  const [totalInstalls, totalEvents, dailyActive, versionBreakdown, eventBreakdown, recentActivity] =
    await Promise.all([
      db.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM events").first(),
      db.prepare("SELECT COUNT(*) AS n FROM events").first(),
      db.prepare(`
        SELECT COUNT(DISTINCT install_id) AS n FROM events
        WHERE ts > ?
      `).bind(Date.now() - 86400000).first(),
      db.prepare(`
        SELECT version, COUNT(DISTINCT install_id) AS installs
        FROM events WHERE version != ''
        GROUP BY version ORDER BY installs DESC LIMIT 10
      `).all(),
      db.prepare(`
        SELECT event, COUNT(*) AS n FROM events
        GROUP BY event ORDER BY n DESC
      `).all(),
      db.prepare(`
        SELECT date(ts/1000, 'unixepoch') AS day, COUNT(DISTINCT install_id) AS dau
        FROM events WHERE ts > ?
        GROUP BY day ORDER BY day DESC LIMIT 30
      `).bind(Date.now() - 30 * 86400000).all(),
    ]);

  const vRows = (versionBreakdown.results ?? [])
    .map(r => `<tr><td>${r.version}</td><td>${r.installs}</td></tr>`)
    .join("");

  const eRows = (eventBreakdown.results ?? [])
    .map(r => `<tr><td>${r.event}</td><td>${r.n}</td></tr>`)
    .join("");

  const dRows = (recentActivity.results ?? [])
    .map(r => `<tr><td>${r.day}</td><td>${r.dau}</td></tr>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>SRS Stats</title>
<style>
  body { font-family: monospace; background: #0d0d0d; color: #ccc; padding: 32px; max-width: 900px; margin: 0 auto; }
  h1 { color: #fff; font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 32px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 32px; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px 24px; min-width: 150px; }
  .card-val { font-size: 28px; font-weight: 700; color: #fff; }
  .card-label { font-size: 11px; color: #666; margin-top: 4px; }
  h2 { font-size: 13px; color: #888; letter-spacing: 0.05em; text-transform: uppercase; margin: 24px 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th { text-align: left; color: #555; padding: 4px 12px 4px 0; border-bottom: 1px solid #222; }
  td { padding: 4px 12px 4px 0; color: #aaa; }
  tr:hover td { color: #fff; }
</style>
</head>
<body>
<h1>Slippi Ranked Stats — Telemetry</h1>
<div class="sub">Generated ${new Date().toUTCString()}</div>
<div class="cards">
  <div class="card"><div class="card-val">${totalInstalls?.n ?? 0}</div><div class="card-label">Total installs</div></div>
  <div class="card"><div class="card-val">${dailyActive?.n ?? 0}</div><div class="card-label">Active last 24h</div></div>
  <div class="card"><div class="card-val">${totalEvents?.n ?? 0}</div><div class="card-label">Total events</div></div>
</div>

<h2>Daily Active Users (last 30 days)</h2>
<table><thead><tr><th>Date</th><th>DAU</th></tr></thead><tbody>${dRows}</tbody></table>

<h2>Version breakdown</h2>
<table><thead><tr><th>Version</th><th>Installs</th></tr></thead><tbody>${vRows}</tbody></table>

<h2>Events</h2>
<table><thead><tr><th>Event</th><th>Count</th></tr></thead><tbody>${eRows}</tbody></table>
</body></html>`;
}

function corsResponse(body, status) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  return new Response(body ? JSON.stringify(body) : null, { status, headers });
}
