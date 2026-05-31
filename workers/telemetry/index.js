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

// Feature events fired by the client app. Used by the Features section to
// compute % of monthly active users who actually used each feature.
const FEATURE_EVENTS = ["scan_run", "watcher_start", "set_graded", "overlay_enabled"];
const FEATURE_LABELS = {
  scan_run:        "Scanned replays",
  watcher_start:   "Started Live Session",
  set_graded:      "Got a set grade",
  overlay_enabled: "Turned on OBS overlay",
};

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

    // GET /stats — HTML dashboard (owner-only). Gated behind a secret token so install
    // counts / DAU / premium numbers aren't public. The token is a Worker secret, never
    // in the client app — set it with: wrangler secret put DASHBOARD_TOKEN
    // View at: https://<worker-url>/stats?key=<token>. 404 (not 401) so the endpoint
    // doesn't even advertise that it exists to someone probing without the key.
    if (request.method === "GET" && url.pathname === "/stats") {
      if (url.searchParams.get("key") !== env.DASHBOARD_TOKEN) {
        return new Response("Not found", { status: 404 });
      }
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

    // POST /init — ensure schema exists (call once after creating DB). Same owner-only
    // token gate as /stats so a stranger can't poke at the schema.
    if (request.method === "POST" && url.pathname === "/init") {
      if (url.searchParams.get("key") !== env.DASHBOARD_TOKEN) {
        return corsResponse("Not found", 404);
      }
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
  const now = Date.now();
  const DAY = 86400000;

  const [
    totals,
    dau, wau, mau,
    versionRows, osRows,
    dauHistory,
    eventBreakdown,
    featureUserRows,
    retention,
  ] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(DISTINCT install_id) AS installs,
        COUNT(*) AS events,
        COUNT(DISTINCT CASE WHEN event = 'premium' THEN install_id END) AS premium
      FROM events
    `).first(),
    db.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts > ?").bind(now - DAY).first(),
    db.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts > ?").bind(now - 7 * DAY).first(),
    db.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts > ?").bind(now - 30 * DAY).first(),
    db.prepare(`
      SELECT version, COUNT(DISTINCT install_id) AS installs
      FROM events WHERE version != ''
      GROUP BY version
    `).all(),
    db.prepare(`
      SELECT os, COUNT(DISTINCT install_id) AS installs
      FROM events WHERE os != ''
      GROUP BY os
    `).all(),
    db.prepare(`
      SELECT date(ts/1000, 'unixepoch', '-6 hours') AS day, COUNT(DISTINCT install_id) AS dau
      FROM events WHERE ts > ?
      GROUP BY day ORDER BY day ASC
    `).bind(now - 30 * DAY).all(),
    db.prepare(`
      SELECT event, COUNT(*) AS n FROM events
      GROUP BY event ORDER BY n DESC
    `).all(),
    // Distinct users who fired each feature event within the MAU window. Divided
    // client-side by MAU to produce feature-adoption %.
    db.prepare(`
      SELECT event, COUNT(DISTINCT install_id) AS users
      FROM events
      WHERE ts > ? AND event IN ('scan_run', 'watcher_start', 'set_graded', 'overlay_enabled')
      GROUP BY event
    `).bind(now - 30 * DAY).all(),
    computeRetention(db, now, DAY),
  ]);

  const installs = totals?.installs ?? 0;
  const eventsCount = totals?.events ?? 0;
  const premium = totals?.premium ?? 0;
  const dauN = dau?.n ?? 0;
  const wauN = wau?.n ?? 0;
  const mauN = mau?.n ?? 0;

  const versions = (versionRows.results ?? [])
    .slice()
    .sort((a, b) => compareVersionsDesc(a.version, b.version));

  const oses = (osRows.results ?? [])
    .slice()
    .sort((a, b) => b.installs - a.installs);

  const dauSeries = (dauHistory.results ?? []).map(r => ({ day: r.day, n: r.dau }));
  const eventRows = eventBreakdown.results ?? [];
  const featureUsers = Object.fromEntries((featureUserRows.results ?? []).map(r => [r.event, r.users]));

  const snapshot = {
    ts: now,
    totals: {
      installs,
      events: eventsCount,
      dau: dauN,
      wau: wauN,
      mau: mauN,
      premium,
    },
    versions: Object.fromEntries(versions.map(r => [r.version, r.installs])),
    events: Object.fromEntries(eventRows.map(r => [r.event, r.n])),
    featureUsers,
  };

  const sinceLine = previous?.ts
    ? `<div class="since">Since your last visit <strong>${timeAgo(previous.ts)}</strong></div>`
    : `<div class="since">First visit — deltas will appear next time</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SRS Stats</title>
<style>${STYLES}</style>
</head>
<body>
<h1>Slippi Ranked Stats — Telemetry</h1>
<div class="sub">Generated ${new Date(now).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })} CST</div>
${sinceLine}

<section>
  <h2>Overview</h2>
  <div class="cards">
    ${overviewCard("Unique users (all time)", installs, previous?.totals?.installs)}
    ${overviewCard("Monthly active (30d)", mauN, previous?.totals?.mau)}
    ${overviewCard("Opened today", dauN, previous?.totals?.dau)}
    ${overviewCard("Premium users", premium, previous?.totals?.premium)}
  </div>
</section>

<section>
  <h2>Engagement</h2>
  <div class="row-2">
    <div class="panel">
      <div class="panel-label">Active users — last 30 days</div>
      ${sparkline(dauSeries)}
      <div class="legend">
        <span><b>${mauN}</b> MAU (30d)</span>
        <span><b>${wauN}</b> WAU (7d)</span>
        <span><b>${dauN}</b> DAU (1d)</span>
      </div>
    </div>
    <div class="panel">
      <div class="panel-label">Returning rate by cohort age</div>
      <div class="retention">
        ${retentionCell("Day 1+",  retention.day1)}
        ${retentionCell("Day 7+",  retention.day7)}
        ${retentionCell("Day 30+", retention.day30)}
      </div>
      <div class="panel-foot">% of installs old enough to count that came back at least once after the window.</div>
    </div>
  </div>
</section>

<section>
  <h2>Features (share of monthly active users)</h2>
  <div class="bars">
    ${FEATURE_EVENTS.map(e => featureBar(e, featureUsers[e] ?? 0, mauN, previous?.featureUsers?.[e])).join("")}
  </div>
</section>

<section>
  <h2>Adoption</h2>
  <div class="row-2">
    <div class="panel">
      <div class="panel-label">Version</div>
      ${countBars(versions, "version", "installs", 8)}
    </div>
    <div class="panel">
      <div class="panel-label">Operating system</div>
      ${oses.length > 0
        ? countBars(oses, "os", "installs", 6)
        : `<div class="empty">No OS data yet — clients on the next release will populate this.</div>`}
    </div>
  </div>
</section>

<section>
  <h2>All events</h2>
  <table>
    <thead><tr><th>Event</th><th>Count</th><th>Δ since last visit</th></tr></thead>
    <tbody>
      ${eventRows.map(r => `<tr><td>${escapeHtml(r.event)}</td><td>${r.n}</td><td>${rowDelta(r.n, previous?.events?.[r.event])}</td></tr>`).join("")}
    </tbody>
  </table>
</section>
</body></html>`;

  return { html, snapshot };
}

// For each window N (1, 7, 30 days), compute the share of installs that:
//   - first showed up at least N days ago (denominator — they had a chance to return)
//   - had any event at least N days after their first one (numerator — they did return)
// Three parallel queries; D1 handles a CTE + LEFT JOIN cleanly.
async function computeRetention(db, now, DAY) {
  const windows = [1, 7, 30];
  const rows = await Promise.all(
    windows.map(w => {
      const cutoff = now - w * DAY;
      const winMs = w * DAY;
      return db.prepare(`
        WITH fs AS (
          SELECT install_id, MIN(ts) AS first_ts
          FROM events
          GROUP BY install_id
          HAVING MIN(ts) <= ?
        )
        SELECT
          COUNT(DISTINCT fs.install_id) AS denom,
          COUNT(DISTINCT CASE WHEN e.ts >= fs.first_ts + ? THEN fs.install_id END) AS num
        FROM fs
        LEFT JOIN events e ON e.install_id = fs.install_id
      `).bind(cutoff, winMs).first();
    })
  );
  const [r1, r7, r30] = rows;
  return {
    day1:  ratePct(r1?.num,  r1?.denom),
    day7:  ratePct(r7?.num,  r7?.denom),
    day30: ratePct(r30?.num, r30?.denom),
  };
}

function ratePct(num, denom) {
  if (!denom) return null;
  return Math.round((100 * num) / denom);
}

function overviewCard(label, curr, prev) {
  return `
    <div class="card">
      <div class="card-val">${curr}</div>
      <div class="card-label">${label}</div>
      ${cardDelta(curr, prev)}
    </div>`;
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

function retentionCell(label, pct) {
  if (pct === null) return `
    <div class="retn">
      <b class="retn-val d-zero">—</b>
      <span>${label}</span>
      <span class="retn-foot">not enough history</span>
    </div>`;
  return `
    <div class="retn">
      <b class="retn-val">${pct}%</b>
      <span>${label}</span>
    </div>`;
}

function featureBar(eventName, users, mau, prevUsers) {
  const pct = mau > 0 ? Math.round((100 * users) / mau) : 0;
  const width = Math.max(2, Math.min(100, pct));
  const delta = prevUsers === undefined
    ? `<span class="d-new">new</span>`
    : (() => {
        const d = users - prevUsers;
        if (d === 0) return `<span class="d-zero">±0</span>`;
        const sign = d > 0 ? "+" : "";
        const cls = d > 0 ? "d-up" : "d-down";
        return `<span class="${cls}">${sign}${d}</span>`;
      })();
  return `
    <div class="bar">
      <div class="bar-head">
        <span class="bar-label">${FEATURE_LABELS[eventName] ?? eventName}</span>
        <span class="bar-num"><b>${pct}%</b><span class="bar-sub">${users} of ${mau} users · ${delta}</span></span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
    </div>`;
}

function countBars(rows, labelKey, valKey, maxRows) {
  if (rows.length === 0) return `<div class="empty">No data.</div>`;
  const max = Math.max(1, ...rows.map(r => r[valKey]));
  const shown = rows.slice(0, maxRows);
  const extra = rows.length - shown.length;
  const bars = shown.map(r => {
    const width = Math.max(2, Math.round((100 * r[valKey]) / max));
    return `
      <div class="cbar">
        <span class="cbar-label">${escapeHtml(String(r[labelKey]))}</span>
        <div class="cbar-track"><div class="cbar-fill" style="width:${width}%"></div></div>
        <span class="cbar-val">${r[valKey]}</span>
      </div>`;
  }).join("");
  const more = extra > 0 ? `<div class="cbar-more">+${extra} more</div>` : "";
  return bars + more;
}

function sparkline(series) {
  if (series.length === 0) return `<div class="empty">No activity in the last 30 days.</div>`;
  // Always render a 30-day grid so a single point isn't ambiguous.
  const W = 600, H = 80, P = 6;
  const minVal = 0;
  const maxVal = Math.max(1, ...series.map(s => s.n));
  const n = Math.max(series.length, 2);
  const xAt = (i) => P + (W - 2 * P) * (i / (n - 1));
  const yAt = (v) => H - P - (H - 2 * P) * ((v - minVal) / (maxVal - minVal));
  const pts = series.map((s, i) => `${xAt(i).toFixed(1)},${yAt(s.n).toFixed(1)}`).join(" ");
  const last = series[series.length - 1];
  return `
    <svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts}" />
      <circle cx="${xAt(series.length - 1).toFixed(1)}" cy="${yAt(last.n).toFixed(1)}" r="3" />
    </svg>
    <div class="spark-axis"><span>${series[0].day}</span><span>${last.day}</span></div>`;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function compareVersionsDesc(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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

const STYLES = `
  body { font-family: monospace; background: #0d0d0d; color: #ccc; padding: 24px; max-width: 1000px; margin: 0 auto; font-size: 16px; line-height: 1.4; }
  h1 { color: #fff; font-size: 28px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 14px; margin-bottom: 16px; }
  .since { color: #aaa; font-size: 15px; margin-bottom: 28px; padding: 10px 14px; background: #1a1a1a; border-radius: 6px; border-left: 3px solid #555; }
  .since strong { color: #fff; }
  section { margin-bottom: 36px; }
  h2 { font-size: 13px; color: #888; letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 14px; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .card { background: #1a1a1a; border: 1px solid #262626; border-radius: 8px; padding: 16px 18px; }
  .card-val { font-size: 32px; font-weight: 700; color: #fff; line-height: 1.1; }
  .card-label { font-size: 13px; color: #888; margin-top: 4px; }
  .card-delta { font-size: 13px; margin-top: 10px; }
  .delta-num { font-size: 17px; font-weight: 700; }
  .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .panel { background: #1a1a1a; border: 1px solid #262626; border-radius: 8px; padding: 16px 18px; }
  .panel-label { font-size: 13px; color: #888; margin-bottom: 10px; }
  .panel-foot { font-size: 12px; color: #555; margin-top: 8px; line-height: 1.4; }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; color: #888; margin-top: 8px; }
  .legend b { color: #fff; font-weight: 700; }
  .sparkline { width: 100%; height: 80px; display: block; }
  .sparkline polyline { fill: none; stroke: #6ce064; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .sparkline circle { fill: #6ce064; }
  .spark-axis { display: flex; justify-content: space-between; font-size: 11px; color: #555; margin-top: 4px; }
  .retention { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .retn { background: #131313; border: 1px solid #232323; border-radius: 6px; padding: 10px; text-align: center; display: flex; flex-direction: column; gap: 4px; }
  .retn-val { font-size: 26px; color: #fff; line-height: 1.1; }
  .retn span { font-size: 12px; color: #888; }
  .retn-foot { font-size: 11px; color: #555; font-style: italic; }
  .bars { display: flex; flex-direction: column; gap: 14px; }
  .bar-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; gap: 12px; }
  .bar-label { color: #ccc; font-size: 14px; }
  .bar-num { color: #888; font-size: 12px; text-align: right; }
  .bar-num b { color: #fff; font-size: 16px; font-weight: 700; margin-right: 6px; }
  .bar-sub { color: #666; }
  .bar-track { width: 100%; height: 10px; background: #1a1a1a; border-radius: 5px; overflow: hidden; border: 1px solid #232323; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, #4a9bff, #6cb8e0); }
  .cbar { display: grid; grid-template-columns: 100px 1fr 48px; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 13px; }
  .cbar-label { color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cbar-track { height: 8px; background: #131313; border-radius: 4px; overflow: hidden; border: 1px solid #232323; }
  .cbar-fill { height: 100%; background: #5a5a5a; }
  .cbar-val { color: #fff; text-align: right; font-weight: 700; }
  .cbar-more { color: #555; font-size: 12px; margin-top: 6px; }
  .empty { color: #555; font-style: italic; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th { text-align: left; color: #666; padding: 6px 14px 6px 0; border-bottom: 1px solid #222; font-size: 13px; font-weight: 400; }
  td { padding: 6px 14px 6px 0; color: #bbb; }
  tr:hover td { color: #fff; }
  .d-up { color: #6ce064; }
  .d-down { color: #e06464; }
  .d-zero { color: #555; }
  .d-new { color: #6cb8e0; font-style: italic; }
  @media (max-width: 720px) {
    body { padding: 16px; font-size: 16px; }
    h1 { font-size: 24px; }
    .cards { grid-template-columns: 1fr 1fr; }
    .row-2 { grid-template-columns: 1fr; }
    .card-val { font-size: 28px; }
    .cbar { grid-template-columns: 80px 1fr 40px; font-size: 12px; }
    .bar-num b { font-size: 14px; }
  }
  @media (max-width: 420px) {
    .cards { grid-template-columns: 1fr; }
    .retention { grid-template-columns: 1fr; }
  }
`;
