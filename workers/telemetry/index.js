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
      const previous = readSnapshotCookie(request.headers.get("Cookie"));
      const { html, snapshot } = await buildDashboard(env.DB, previous);

      // Only refresh the cookie when total events has changed — otherwise rapid
      // refreshes clobber the "last meaningful view" baseline.
      const changed = !previous?.totals
        || previous.totals.events !== snapshot.totals.events;

      const headers = { "Content-Type": "text/html; charset=utf-8" };
      if (changed) {
        headers["Set-Cookie"] = `srs_snapshot=${encodeURIComponent(JSON.stringify(snapshot))}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
      }
      return new Response(html, { status: 200, headers });
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

function readSnapshotCookie(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== "srs_snapshot") continue;
    try {
      return JSON.parse(decodeURIComponent(part.slice(idx + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}

async function buildDashboard(db, previous) {
  const [totalInstalls, totalEvents, dailyActive, premiumUsers, versionBreakdown, eventBreakdown, recentActivity] =
    await Promise.all([
      db.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM events").first(),
      db.prepare("SELECT COUNT(*) AS n FROM events").first(),
      db.prepare(`
        SELECT COUNT(DISTINCT install_id) AS n FROM events
        WHERE ts > ?
      `).bind(Date.now() - 86400000).first(),
      db.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE event = 'premium'").first(),
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
        SELECT date(ts/1000, 'unixepoch', '-6 hours') AS day, COUNT(DISTINCT install_id) AS dau
        FROM events WHERE ts > ?
        GROUP BY day ORDER BY day DESC LIMIT 30
      `).bind(Date.now() - 30 * 86400000).all(),
    ]);

  const snapshot = {
    ts: Date.now(),
    totals: {
      installs: totalInstalls?.n ?? 0,
      events: totalEvents?.n ?? 0,
      dau: dailyActive?.n ?? 0,
      premium: premiumUsers?.n ?? 0,
    },
    versions: Object.fromEntries((versionBreakdown.results ?? []).map(r => [r.version, r.installs])),
    events: Object.fromEntries((eventBreakdown.results ?? []).map(r => [r.event, r.n])),
  };

  const sinceLine = previous?.ts
    ? `<div class="since">Since your last visit <strong>${timeAgo(previous.ts)}</strong></div>`
    : `<div class="since">First visit — deltas will appear next time</div>`;

  const vRows = (versionBreakdown.results ?? [])
    .map(r => `<tr><td>${escapeHtml(r.version)}</td><td>${r.installs}</td><td>${rowDelta(r.installs, previous?.versions?.[r.version])}</td></tr>`)
    .join("");

  const eRows = (eventBreakdown.results ?? [])
    .map(r => `<tr><td>${escapeHtml(r.event)}</td><td>${r.n}</td><td>${rowDelta(r.n, previous?.events?.[r.event])}</td></tr>`)
    .join("");

  const dRows = (recentActivity.results ?? [])
    .map(r => `<tr><td>${r.day}</td><td>${r.dau}</td></tr>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SRS Stats</title>
<style>
  body { font-family: monospace; background: #0d0d0d; color: #ccc; padding: 24px; max-width: 900px; margin: 0 auto; font-size: 16px; line-height: 1.4; }
  h1 { color: #fff; font-size: 28px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 14px; margin-bottom: 16px; }
  .since { color: #aaa; font-size: 15px; margin-bottom: 28px; padding: 10px 14px; background: #1a1a1a; border-radius: 6px; border-left: 3px solid #555; }
  .since strong { color: #fff; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 32px; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 18px 24px; min-width: 180px; flex: 1; }
  .card-val { font-size: 36px; font-weight: 700; color: #fff; line-height: 1.1; }
  .card-label { font-size: 14px; color: #888; margin-top: 6px; }
  .card-delta { font-size: 14px; margin-top: 10px; }
  .delta-num { font-size: 20px; font-weight: 700; }
  h2 { font-size: 16px; color: #888; letter-spacing: 0.05em; text-transform: uppercase; margin: 28px 0 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 15px; }
  th { text-align: left; color: #666; padding: 6px 14px 6px 0; border-bottom: 1px solid #222; font-size: 14px; }
  td { padding: 6px 14px 6px 0; color: #bbb; }
  tr:hover td { color: #fff; }
  .d-up { color: #6ce064; }
  .d-down { color: #e06464; }
  .d-zero { color: #555; }
  .d-new { color: #6cb8e0; font-style: italic; }
  @media (max-width: 500px) {
    body { padding: 16px; font-size: 17px; }
    h1 { font-size: 26px; }
    .since { font-size: 17px; }
    .card { min-width: 100%; padding: 14px 18px; }
    .card-val { font-size: 38px; }
    .card-label { font-size: 16px; }
    .card-delta { font-size: 16px; }
    .delta-num { font-size: 22px; }
    table { font-size: 16px; }
    th { font-size: 15px; }
  }
</style>
</head>
<body>
<h1>Slippi Ranked Stats — Telemetry</h1>
<div class="sub">Generated ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })} CST</div>
${sinceLine}
<div class="cards">
  <div class="card">
    <div class="card-val">${snapshot.totals.installs}</div>
    <div class="card-label">Unique users (all time)</div>
    ${cardDelta(snapshot.totals.installs, previous?.totals?.installs)}
  </div>
  <div class="card">
    <div class="card-val">${snapshot.totals.dau}</div>
    <div class="card-label">Opened app today</div>
    ${cardDelta(snapshot.totals.dau, previous?.totals?.dau)}
  </div>
  <div class="card">
    <div class="card-val">${snapshot.totals.events}</div>
    <div class="card-label">Total app launches</div>
    ${cardDelta(snapshot.totals.events, previous?.totals?.events)}
  </div>
  <div class="card">
    <div class="card-val">${snapshot.totals.premium}</div>
    <div class="card-label">Premium users</div>
    ${cardDelta(snapshot.totals.premium, previous?.totals?.premium)}
  </div>
</div>

<h2>Daily Active Users (last 30 days)</h2>
<table><thead><tr><th>Date</th><th>DAU</th></tr></thead><tbody>${dRows}</tbody></table>

<h2>Version breakdown</h2>
<table><thead><tr><th>Version</th><th>Installs</th><th>Δ</th></tr></thead><tbody>${vRows}</tbody></table>

<h2>Events</h2>
<table><thead><tr><th>Event</th><th>Count</th><th>Δ</th></tr></thead><tbody>${eRows}</tbody></table>
</body></html>`;

  return { html, snapshot };
}

function cardDelta(curr, prev) {
  if (prev === undefined || prev === null) return "";
  const d = curr - prev;
  if (d === 0) return `<div class="card-delta d-zero"><span class="delta-num">±0</span> since last visit</div>`;
  const sign = d > 0 ? "+" : "";
  const cls = d > 0 ? "d-up" : "d-down";
  return `<div class="card-delta ${cls}"><span class="delta-num">${sign}${d}</span> since last visit</div>`;
}

function rowDelta(curr, prev) {
  if (prev === undefined) return `<span class="d-new">new</span>`;
  const d = curr - prev;
  if (d === 0) return `<span class="d-zero">±0</span>`;
  const sign = d > 0 ? "+" : "";
  const cls = d > 0 ? "d-up" : "d-down";
  return `<span class="${cls}">${sign}${d}</span>`;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
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
