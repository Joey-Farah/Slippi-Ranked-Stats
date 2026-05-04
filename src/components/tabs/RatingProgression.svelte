<script lang="ts">
  import { snapshots, seasons, sets, connectCode, linkedCodes } from "../../lib/store";
  import LineChart from "../charts/LineChart.svelte";

  // Convert an ISO timestamp string to a local-time display string "YYYY-MM-DD HH:MM"
  function fmtTs(ts: string): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Season filter: "current" shows only the active season, "all" shows everything
  let seasonFilter = $state<"current" | "all">("current");

  // Snapshots filtered to the selected season
  let filteredSnapshots = $derived((() => {
    if (seasonFilter === "all" || $seasons.length === 0) return $snapshots;
    // "current" = snapshots after the most recent season_end date
    const latestEnd = $seasons
      .map((s) => s.season_end)
      .filter(Boolean)
      .sort()
      .at(-1);
    if (!latestEnd) return $snapshots;
    return $snapshots.filter((s) => s.timestamp > latestEnd);
  })());

  // Rating line data — uses filteredSnapshots, with null gaps at season boundaries
  let ratingData = $derived((() => {
    const snaps = filteredSnapshots;
    if (seasonFilter === "all" && $seasons.length > 0) {
      // Insert null between snapshots that cross a season boundary to prevent chart drops
      const seasonEnds = $seasons.map((s) => s.season_end).filter(Boolean).sort();
      const data: { x: string; y: number | null }[] = [];
      for (let i = 0; i < snaps.length; i++) {
        data.push({ x: fmtTs(snaps[i].timestamp), y: snaps[i].rating });
        if (i < snaps.length - 1) {
          const crossesBoundary = seasonEnds.some(
            (end) => end > snaps[i].timestamp && end < snaps[i + 1].timestamp
          );
          if (crossesBoundary) data.push({ x: fmtTs(snaps[i].timestamp), y: null });
        }
      }
      return data;
    }
    return snaps.map((s) => ({ x: fmtTs(s.timestamp), y: s.rating }));
  })());

  // Season end markers — x must match an xData tick (snapshot timestamp).
  // Use the last snapshot at or before season_end so ECharts can place the diamond.
  let seasonMarkers = $derived((() => {
    return $seasons
      .filter((s) => s.rating > 0 && s.season_end)
      .map((s) => {
        const snap = [...$snapshots].filter((sn) => sn.timestamp <= s.season_end).at(-1);
        if (!snap) return null;
        return { x: fmtTs(snap.timestamp), y: s.rating, name: s.season_name };
      })
      .filter((m): m is { x: string; y: number; name: string } => m !== null);
  })());


  // Rolling 20-snapshot average on the rating line
  const RATING_WINDOW = 20;
  let rollingRatingAvg = $derived((() => {
    const snaps = filteredSnapshots;
    if (snaps.length < 2) return [];
    return snaps.map((_, i) => {
      const start = Math.max(0, i - RATING_WINDOW + 1);
      const window = snaps.slice(start, i + 1);
      const avg = window.reduce((s, v) => s + v.rating, 0) / window.length;
      return Math.round(avg * 10) / 10;
    });
  })());

  // Auto-scale y-axis (ignore nulls)
  let chartBounds = $derived((() => {
    const vals = ratingData.map((d) => d.y).filter((v): v is number => v !== null);
    if (vals.length < 2) return { min: undefined, max: undefined };
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = Math.max(50, (hi - lo) * 0.15);
    return { min: Math.floor(lo - pad), max: Math.ceil(hi + pad) };
  })());

  // Per-set annotations: pair snapshots with match_id to set results
  // One row per set — match directly by triggered_by_match_id, newest first
  let setSnapshots = $derived((() => {
    const snapByMatchId = new Map(
      $snapshots
        .filter((s) => s.triggered_by_match_id)
        .map((s) => [s.triggered_by_match_id!, s])
    );
    const rows = $sets.map((set) => {
      const snap = snapByMatchId.get(set.match_id);
      return {
        x: fmtTs(set.timestamp),
        ts: set.timestamp,
        y: snap?.rating ?? null,
        name: `${set.result === "win" ? "W" : "L"} vs ${set.opponent_code} (${set.wins}–${set.losses})`,
      };
    });
    return rows.reverse();
  })());
</script>

<p class="muted" style="font-size:11px; margin-bottom:12px">
    Rating history only includes sets played while this app was running. Matches played before you started using SRS will not appear here.
  </p>
  {#if $linkedCodes.length > 0}
    <p class="muted" style="font-size:11px; margin-bottom:12px">
      Rating history reflects <strong style="color:var(--text)">{$connectCode}</strong> only. When using multiple linked codes, only the code at the top of the list is tracked here.
    </p>
  {/if}

  <!-- Rating over time -->
  {#if ratingData.length > 1}
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="display:flex; align-items:center; justify-content:space-between">
        <span>Rating Over Time</span>
        <div style="display:flex; gap:4px">
          <button
            onclick={() => seasonFilter = "current"}
            style="font-size:11px; padding:2px 8px; border-radius:4px; border:1px solid var(--border); cursor:pointer;
              background:{seasonFilter === 'current' ? 'var(--accent)' : 'transparent'};
              color:{seasonFilter === 'current' ? '#fff' : 'var(--muted)'};"
          >Current Season</button>
          <button
            onclick={() => seasonFilter = "all"}
            style="font-size:11px; padding:2px 8px; border-radius:4px; border:1px solid var(--border); cursor:pointer;
              background:{seasonFilter === 'all' ? 'var(--accent)' : 'transparent'};
              color:{seasonFilter === 'all' ? '#fff' : 'var(--muted)'};"
          >All Time</button>
        </div>
      </div>
      <div style="display:flex; gap:16px; align-items:center; margin-bottom:8px; font-size:11px; color:var(--muted)">
        <span style="display:flex; align-items:center; gap:5px">
          <span style="display:inline-block; width:20px; height:2px; background:#2ecc71; border-radius:1px"></span>
          Rating
        </span>
        {#if rollingRatingAvg.length > 1}
          <span style="display:flex; align-items:center; gap:5px">
            <span style="display:inline-block; width:20px; height:0; border-top:2px dashed #f39c12"></span>
            20-snap avg
          </span>
        {/if}
        {#if seasonMarkers.length > 0}
          <span style="display:flex; align-items:center; gap:5px">
            <span style="display:inline-block; width:8px; height:8px; background:#f39c12; transform:rotate(45deg); border-radius:1px"></span>
            Season end
          </span>{/if}
      </div>
      <LineChart
        xData={ratingData.map((d) => d.x)}
        yData={ratingData.map((d) => d.y)}
        label="Rating"
        color="#2ecc71"
        fill={false}
        markers={seasonMarkers}
        height={280}
        yMin={chartBounds.min}
        yMax={chartBounds.max}
        y2Data={rollingRatingAvg.length > 1 ? rollingRatingAvg : undefined}
        label2="20-snap avg"
        color2="#f39c12"
      />
    </div>
  {:else}
    <p class="muted" style="margin-bottom:16px">Fetch a rating snapshot to see progression.</p>
  {/if}

  <!-- Per-set progression table -->
  {#if setSnapshots.length > 0}
    <div class="card" style="margin-bottom:16px; padding:0; overflow:hidden">
      <div class="section-title" style="padding:12px 16px 8px">Set-by-Set Rating</div>
      <div style="max-height:220px; overflow-y:auto">
      <table>
        <thead>
          <tr><th>Time</th><th>Result</th><th>Rating After</th><th>Change</th></tr>
        </thead>
        <tbody>
          {#each setSnapshots as ss, i}
            {@const prevSnap = setSnapshots[i + 1]}
            {@const prevRating = prevSnap?.y ?? null}
            {@const seasonEnds = $seasons.map((s) => s.season_end).filter(Boolean)}
            {@const crossesBoundary = prevSnap !== undefined && seasonEnds.some((end) => end > prevSnap.ts && end <= ss.ts)}
            {@const delta = ss.y !== null && prevRating !== null && !crossesBoundary ? ss.y - prevRating : null}
            <tr>
              <td class="muted" style="font-size:11px">{ss.x}</td>
              <td style="font-size:12px">
                <span class={ss.name.startsWith("W") ? "win-text" : "loss-text"}>{ss.name.slice(0, 1)}</span>{ss.name.slice(1)}
              </td>
              <td>{ss.y !== null ? ss.y.toFixed(1) : "—"}</td>
              <td class={delta !== null && delta > 0 ? "win-text" : delta !== null && delta < 0 ? "loss-text" : ""}>
                {delta !== null ? (delta > 0 ? "+" : "") + delta.toFixed(1) : "—"}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      </div>
    </div>
  {/if}
