<script lang="ts">
  import {
    isPremium, connectCode, effectiveCodes, sets,
    gradeHistory, gradeHistoryBusy, gradeHistoryProgress,
    discordToken, discordUsername,
    type GradeHistoryEntry, type LiveGameStats,
  } from "../../lib/store";
  import { startDiscordAuth, verifyPatronRole } from "../../lib/discord";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { invoke } from "@tauri-apps/api/core";
  import { CHARACTERS, parseSlpFile } from "../../lib/parser";
  import { gradeSet, scoreToGrade, formatStatValue, CATEGORY_DEFS, type GradeLetter, type CategoryKey, type SetGrade } from "../../lib/grading";
  import { getDb, saveSetGrade, getAllSetGrades, deleteSetGrade, type SetGradeRow } from "../../lib/db";
  import { BENCHMARKS_VERSION } from "../../lib/grade-benchmarks";
  import SetGradeDisplay from "../SetGradeDisplay.svelte";

  function rowToEntry(row: SetGradeRow): GradeHistoryEntry {
    const d = new Date(row.set_timestamp);
    const grade: SetGrade = {
      letter:     row.overall_letter as GradeLetter,
      score:      row.overall_score,
      categories: {
        neutral: { label: "Neutral", letter: row.neutral_letter as GradeLetter | null, score: row.neutral_score },
        punish:  { label: "Punish",  letter: row.punish_letter as GradeLetter | null,  score: row.punish_score },
        defense: { label: "Defense", letter: row.defense_letter as GradeLetter | null, score: row.defense_score },
      },
      breakdown:      JSON.parse(row.breakdown_json),
      playerChar:     row.player_char,
      opponentChar:   row.opponent_char,
      baselineSource: row.baseline_source as "matchup" | "character" | "overall",
      setResult:      row.set_result as "win" | "loss",
      wins:           row.wins,
      losses:         row.losses,
    };
    return {
      matchId:         row.match_id,
      timestamp:       row.set_timestamp,
      date:            `${d.getMonth() + 1}/${d.getDate()}`,
      opponentCode:    row.opponent_code,
      opponentChar:    row.opponent_char,
      playerChar:      row.player_char,
      result:          row.set_result as "win" | "loss",
      wins:            row.wins,
      losses:          row.losses,
      grade,
      error:           null,
      baselineVersion: row.baseline_version,
    };
  }

  let _loadGen = 0;
  $effect(() => {
    const codes = $effectiveCodes;
    const gen = ++_loadGen;
    if (codes.length === 0) { gradeHistory.set([]); return; }
    (async () => {
      try {
        const seen = new Map<string, SetGradeRow>();
        for (const c of codes) {
          const db = await getDb(c);
          const rows = await getAllSetGrades(db);
          for (const row of rows) {
            const existing = seen.get(row.match_id);
            if (!existing || row.generated_at > existing.generated_at) seen.set(row.match_id, row);
          }
        }
        if (gen !== _loadGen) return; // stale run — a newer load is in flight
        gradeHistory.set([...seen.values()].map(rowToEntry));
      } catch { /* DB not ready yet — will populate on first grade */ }
    })();
  });

  const KOFI_URL    = "https://ko-fi.com/joeydonuts";
  const PATREON_URL = "https://www.patreon.com/joeydonuts";

  let isConnecting  = $state(false);
  let isRechecking  = $state(false);

  async function handleConnect() {
    isConnecting = true;
    try { await startDiscordAuth(); } finally { isConnecting = false; }
  }

  async function handleRecheck() {
    isRechecking = true;
    await verifyPatronRole();
    isRechecking = false;
  }

  const GRADE_COLORS: Record<string, string> = {
    S: "#FFD700",
    A: "#00C853",
    B: "#00B0FF",
    C: "#FFB300",
    D: "#FF6D00",
    F: "#FF1744",
  };

  function gc(letter: string | null): string {
    return letter ? (GRADE_COLORS[letter] ?? "var(--muted)") : "var(--muted)";
  }

  let completedSets = $derived(
    [...$sets]
      .filter((s) => Math.max(s.wins, s.losses) >= 2)
      .reverse()
  );

  // Grade history restricted to sets that exist in the current code's completedSets.
  // Without this, double-saved grades from other linked codes inflate counts.
  let completedSetIds = $derived(new Set(completedSets.map((s) => s.match_id)));
  let activeHistory = $derived($gradeHistory.filter((r) => completedSetIds.has(r.matchId)));

  // Set IDs that already have a grade result (successful or errored)
  let gradedIds = $derived(new Set(activeHistory.map((r) => r.matchId)));

  // Only sets not yet graded — shown in button label
  let ungradedSets = $derived(completedSets.filter((s) => !gradedIds.has(s.match_id)));

  let selectedMatchId  = $state<string | null>(null);
  let filterLetter     = $state<string | null>(null);
  let filterResult     = $state<"all" | "win" | "loss">("all");
  let filterPlayerChar = $state<string | null>(null);
  let filterOppChar    = $state<string | null>(null);
  let sortMode = $state<"date-desc" | "date-asc" | "score-desc" | "score-asc">("date-desc");

  let uniquePlayerChars = $derived([...new Set(activeHistory.map((r) => r.playerChar))].sort());
  let uniqueOppChars    = $derived([...new Set(activeHistory.map((r) => r.opponentChar))].sort());

  let staleCount = $derived(
    activeHistory.filter((r) => r.baselineVersion !== null && r.baselineVersion !== BENCHMARKS_VERSION).length
  );

  let sortedHistory = $derived((() => {
    let h = [...activeHistory];
    if (filterLetter     !== null)  h = h.filter((r) => r.grade?.letter === filterLetter);
    if (filterResult     !== "all") h = h.filter((r) => r.result === filterResult);
    if (filterPlayerChar !== null)  h = h.filter((r) => r.playerChar === filterPlayerChar);
    if (filterOppChar    !== null)  h = h.filter((r) => r.opponentChar === filterOppChar);
    switch (sortMode) {
      case "date-desc":  h.sort((a, b) => b.timestamp.localeCompare(a.timestamp)); break;
      case "date-asc":   h.sort((a, b) => a.timestamp.localeCompare(b.timestamp)); break;
      case "score-desc": h.sort((a, b) => (b.grade?.score ?? -1)  - (a.grade?.score ?? -1));  break;
      case "score-asc":  h.sort((a, b) => (a.grade?.score ?? 101) - (b.grade?.score ?? 101)); break;
    }
    return h;
  })());

  // ── By Matchup view ────────────────────────────────────────────────────────

  let viewMode = $state<"history" | "matchups">("history");
  let selectedMatchupKey = $state<string | null>(null);

  const CATEGORY_ORDER: CategoryKey[] = ["neutral", "punish", "defense"];

  function avgCategoryScores(
    entries: GradeHistoryEntry[],
    key: CategoryKey
  ): { avgScore: number | null; letter: GradeLetter | null } {
    const scores = entries
      .map((r) => r.grade!.categories[key].score)
      .filter((s): s is number => s !== null);
    if (scores.length === 0) return { avgScore: null, letter: null };
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { avgScore: avg, letter: scoreToGrade(avg) };
  }

  let matchupSummaries = $derived((() => {
    const graded = activeHistory.filter((r) => r.grade !== null);
    const groups = new Map<string, GradeHistoryEntry[]>();
    for (const r of graded) {
      const k = `${r.playerChar}::${r.opponentChar}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }

    return [...groups.entries()].map(([key, entries]) => {
      const [playerChar, opponentChar] = key.split("::");
      const wins = entries.filter((r) => r.result === "win").length;
      const rawAvg = entries.reduce((s, r) => s + r.grade!.score, 0) / entries.length;

      const categories = {
        neutral: avgCategoryScores(entries, "neutral"),
        punish:  avgCategoryScores(entries, "punish"),
        defense: avgCategoryScores(entries, "defense"),
      };

      const allStatKeys = CATEGORY_ORDER.flatMap((c) => CATEGORY_DEFS[c].stats) as (keyof SetGrade["breakdown"])[];

      const statAvgs = new Map<
        keyof SetGrade["breakdown"],
        { avgValue: number | null; avgScore: number | null; letter: GradeLetter | null; label: string }
      >();
      for (const k of allStatKeys) {
        const first = entries[0]?.grade?.breakdown[k];
        if (!first) continue;
        const scores = entries.map((r) => r.grade!.breakdown[k].score).filter((s): s is number => s !== null);
        const values = entries.map((r) => r.grade!.breakdown[k].value).filter((v): v is number => v !== null);
        const avgSc = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const avgVl = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
        statAvgs.set(k, {
          avgValue: avgVl,
          avgScore: avgSc,
          letter: avgSc !== null ? scoreToGrade(avgSc) : null,
          label: first.label,
        });
      }

      return {
        key,
        playerChar,
        opponentChar,
        setCount: entries.length,
        wins,
        losses: entries.length - wins,
        avgScore: Math.round(rawAvg * 10) / 10,
        avgLetter: scoreToGrade(rawAvg),
        categories,
        statAvgs,
      };
    }).sort((a, b) => b.setCount - a.setCount);
  })());

  async function gradeAllSets(force = false) {
    const code = $connectCode;
    const codes = $effectiveCodes;
    const toGrade = force ? completedSets : ungradedSets;
    if (!code || toGrade.length === 0) return;

    if (force) gradeHistory.set([]);

    gradeHistoryBusy.set(true);
    gradeHistoryProgress.set({ current: 0, total: toGrade.length });

    const dbMap = new Map<string, Awaited<ReturnType<typeof getDb>>>();
    for (const c of codes) {
      try { dbMap.set(c, await getDb(c)); } catch {}
    }

    for (const target of toGrade) {
      const date = new Date(target.timestamp);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
      const opponentChar = CHARACTERS[target.opponent_char_ids[0]] ?? `Char ${target.opponent_char_ids[0]}`;
      const playerChar   = CHARACTERS[target.player_char_ids[0]]   ?? "Unknown";

      let entry: GradeHistoryEntry = {
        matchId:         target.match_id,
        timestamp:       target.timestamp,
        date:            dateStr,
        opponentCode:    target.opponent_code,
        opponentChar,
        playerChar,
        result:          target.result,
        wins:            target.wins,
        losses:          target.losses,
        grade:           null,
        error:           null,
        baselineVersion: null,
      };

      try {
        const liveGames: LiveGameStats[] = [];
        for (const g of target.games) {
          if (!g.filepath) continue;
          try {
            const parsed = await parseSlpFile(g.filepath, target.sourceCode ?? code);
            for (const p of parsed) {
              liveGames.push({
                match_id:                p.match_id,
                result:                  p.result,
                kills:                   p.kills,
                deaths:                  p.deaths,
                openings_per_kill:       p.openings_per_kill,
                damage_per_opening:      p.damage_per_opening,
                neutral_win_ratio:       p.neutral_win_ratio,
                counter_hit_rate:        p.counter_hit_rate,
                inputs_per_minute:       p.inputs_per_minute,
                l_cancel_ratio:          p.l_cancel_ratio,
                avg_kill_percent:        p.avg_kill_percent,
                avg_death_percent:       p.avg_death_percent,
                defensive_option_rate:   p.defensive_option_rate,
                opening_conversion_rate: p.opening_conversion_rate,
                stage_control_ratio:     p.stage_control_ratio,
                lead_maintenance_rate:   p.lead_maintenance_rate,
                tech_chase_rate:         p.tech_chase_rate,
                edgeguard_success_rate:  p.edgeguard_success_rate,
                hit_advantage_rate:      p.hit_advantage_rate,
                recovery_success_rate:   p.recovery_success_rate,
                avg_stock_duration:      p.avg_stock_duration,
                respawn_defense_rate:    p.respawn_defense_rate,
                comeback_rate:           p.comeback_rate,
                wavedash_miss_rate:      p.wavedash_miss_rate,
                duration_frames:         p.duration_frames,
                stage_id:                p.stage_id,
                player_char_id:          p.player_char_id,
                opponent_char_id:        p.opponent_char_id,
                opponent_code:           p.opponent_code,
                timestamp:               p.timestamp,
              });
            }
          } catch { /* skip unparseable file */ }
        }

        if (liveGames.length > 0) {
          entry.grade = gradeSet(liveGames, playerChar, opponentChar, target.result, target.wins, target.losses);
          entry.baselineVersion = BENCHMARKS_VERSION;

          const targetCode = target.sourceCode ?? code;
          const targetDb = dbMap.get(targetCode) ?? null;
          const primaryDb = dbMap.get(code) ?? null;
          if (entry.grade) {
            const g = entry.grade;
            const gradeRow = {
              match_id:         target.match_id,
              generated_at:     new Date().toISOString(),
              set_timestamp:    target.timestamp,
              baseline_version: BENCHMARKS_VERSION,
              player_char:      playerChar,
              opponent_char:    opponentChar,
              opponent_code:    target.opponent_code,
              baseline_source:  g.baselineSource,
              set_result:       g.setResult,
              wins:             g.wins,
              losses:           g.losses,
              overall_letter:   g.letter,
              overall_score:    g.score,
              neutral_score:    g.categories.neutral.score,
              neutral_letter:   g.categories.neutral.letter,
              punish_score:     g.categories.punish.score,
              punish_letter:    g.categories.punish.letter,
              defense_score:    g.categories.defense.score,
              defense_letter:   g.categories.defense.letter,
              execution_score:  null,
              execution_letter: null,
              breakdown_json:   JSON.stringify(g.breakdown),
            };
            // Save to source DB
            if (targetDb) { try { await saveSetGrade(targetDb, gradeRow); } catch {} }
            // Also save to primary DB so grades persist across code config changes
            if (targetCode !== code && primaryDb) { try { await saveSetGrade(primaryDb, gradeRow); } catch {} }
          }
        } else {
          entry.error = "No parseable files";
        }
      } catch (e: any) {
        entry.error = e?.message ?? String(e);
      }

      gradeHistory.update((prev) => {
        const idx = prev.findIndex((r) => r.matchId === entry.matchId);
        if (idx >= 0) { const copy = [...prev]; copy[idx] = entry; return copy; }
        return [...prev, entry];
      });
      gradeHistoryProgress.update((p) => ({ ...p, current: p.current + 1 }));
    }

    gradeHistoryBusy.set(false);
  }

  async function regradeStale() {
    const code = $connectCode;
    const codes = $effectiveCodes;
    if (!code) return;
    const staleIds = new Set(
      activeHistory
        .filter((r) => r.baselineVersion !== null && r.baselineVersion !== BENCHMARKS_VERSION)
        .map((r) => r.matchId)
    );
    if (staleIds.size === 0) return;

    for (const c of codes) {
      try {
        const db = await getDb(c);
        for (const id of staleIds) {
          try { await deleteSetGrade(db, id); } catch {}
        }
      } catch {}
    }

    gradeHistory.update((prev) => prev.filter((r) => !staleIds.has(r.matchId)));
    gradeAllSets(false);
  }
</script>

{#if !$isPremium}
  <div class="card" style="margin-bottom: 16px; border-color: #7c3aed44">
    <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap">

      <!-- Col 1: text -->
      <div style="flex: 1; min-width: 180px">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
          <span style="font-size: 20px; line-height: 1">🔒</span>
          <div style="font-size: 14px; font-weight: 700">Unlock the full grade breakdown</div>
        </div>
        <div style="font-size: 12px; color: var(--muted); line-height: 1.6">
          {#if $discordToken}
            <span style="color: #e74c3c; font-weight: 600">{$discordUsername ?? "Your account"}</span>
            {" "}isn't showing a supporter role. Just subscribed? Roles can take a few minutes to sync.
          {:else}
            Premium adds per-category scores, the full 14-stat breakdown, matchup grade averages, matchup-specific baselines, and unlocks the Live Session tab.
          {/if}
        </div>
      </div>

      <!-- Col 2: support buttons -->
      <div style="display: flex; flex-direction: column; gap: 6px; flex: 0 0 190px">
        <button
          type="button"
          onclick={() => openUrl(PATREON_URL)}
          style="
            display: flex; align-items: center; justify-content: center; gap: 7px;
            width: 100%; padding: 8px 14px;
            background: #FF424D; color: #fff;
            border: none; border-radius: 6px;
            font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit;
          "
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M14.82 2.41C11.25 2.41 8.35 5.31 8.35 8.88c0 3.56 2.9 6.46 6.47 6.46 3.56 0 6.46-2.9 6.46-6.46 0-3.57-2.9-6.47-6.46-6.47zM3.19 21.59h2.52V2.41H3.19v19.18z"/></svg>
          {$discordToken ? "Patreon" : "Support on Patreon"}
        </button>
        <button
          type="button"
          onclick={() => openUrl(KOFI_URL)}
          style="
            display: flex; align-items: center; justify-content: center; gap: 7px;
            width: 100%; padding: 8px 14px;
            background: #29ABE0; color: #fff;
            border: none; border-radius: 6px;
            font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit;
          "
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/></svg>
          {$discordToken ? "Ko-fi" : "Support on Ko-fi"}
        </button>
      </div>

      <!-- Col 3: discord + help -->
      <div style="display: flex; flex-direction: column; gap: 6px; flex: 0 0 190px">
        {#if !$discordToken}
          <div style="font-size: 11px; color: var(--muted); text-align: center">
            Already a supporter? Connect Discord to verify:
          </div>
          <button
            type="button"
            onclick={handleConnect}
            disabled={isConnecting}
            style="
              display: flex; align-items: center; justify-content: center; gap: 7px;
              width: 100%; padding: 8px 14px;
              background: var(--card); color: var(--fg);
              border: 1px solid var(--border); border-radius: 6px;
              font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
            "
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
            {isConnecting ? "Opening Discord…" : "Connect Discord"}
          </button>
        {:else}
          <button
            type="button"
            onclick={handleRecheck}
            disabled={isRechecking}
            style="
              width: 100%; padding: 8px 14px; background: var(--card); color: var(--muted);
              border: 1px solid var(--border); border-radius: 6px;
              font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit;
            "
          >{isRechecking ? "Checking…" : "Re-check Discord role"}</button>
        {/if}
        <div style="font-size: 10px; color: var(--muted); text-align: center; line-height: 1.6">
          Having trouble connecting with Discord? Check out these support articles:<br/>
          <button onclick={() => openUrl("https://support.patreon.com/hc/en-us/articles/212052266")} style="background:none;border:none;padding:0;color:var(--muted);font-size:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:inherit">Patreon → Discord</button>
          &nbsp;·&nbsp;
          <button onclick={() => openUrl("https://help.ko-fi.com/hc/en-us/articles/8664701197073-How-do-supporters-join-my-Discord-server#how-do-supporters-join-my-discord-server--0-0")} style="background:none;border:none;padding:0;color:var(--muted);font-size:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:inherit">Ko-fi → Discord</button>
        </div>
      </div>

    </div>
  </div>
{/if}

  <!-- Header -->
  <div class="card" style="margin-bottom: 16px">
    <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap">
      <div>
        <div class="section-title" style="margin-bottom: 4px">Grading</div>
        <div style="font-size: 12px; color: var(--muted); margin-bottom: 8px">
          Each set scored across Neutral, Punish, and Defense against community baselines.
          {#if activeHistory.length > 0 && !$gradeHistoryBusy}
            <span style="color: var(--text)">{activeHistory.filter((r) => r.grade !== null).length} of {completedSets.length} sets graded.</span>
            {#if ungradedSets.length === 0}
              <span style="color: #2ecc71"> Up to date.</span>
            {/if}
          {/if}
        </div>
        <button
          type="button"
          onclick={() => openUrl("https://github.com/Joey-Farah/Slippi-Ranked-Stats/blob/main/docs/grading_methodology.md")}
          style="
            display: inline-flex; align-items: center; gap: 5px;
            background: #7c3aed18; border: 1px solid #7c3aed55; border-radius: 6px;
            padding: 5px 10px; font-size: 11px; font-weight: 600;
            color: #a78bfa; font-family: inherit; cursor: pointer;
          "
        >
          <span style="font-size: 13px">📖</span> Grading Methodology
        </button>
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0">
        <button
          type="button"
          disabled={$gradeHistoryBusy || ungradedSets.length === 0}
          onclick={() => gradeAllSets(false)}
          style="
            padding: 10px 20px; font-size: 13px; font-weight: 700;
            background: #7c3aed; color: #fff; border: none; border-radius: 6px;
            cursor: {$gradeHistoryBusy || ungradedSets.length === 0 ? 'default' : 'pointer'};
            opacity: {$gradeHistoryBusy || ungradedSets.length === 0 ? 0.5 : 1};
            white-space: nowrap;
          "
        >
          {#if $gradeHistoryBusy}
            Grading… {$gradeHistoryProgress.current} / {$gradeHistoryProgress.total}
          {:else if activeHistory.length === 0}
            Grade All Sets
          {:else if ungradedSets.length > 0}
            Grade New Sets ({ungradedSets.length})
          {:else}
            Up to Date
          {/if}
        </button>
        {#if activeHistory.length > 0 && !$gradeHistoryBusy}
          <div style="display: flex; gap: 8px; align-items: center">
            {#if staleCount > 0}
              <button
                type="button"
                onclick={regradeStale}
                style="
                  background: none; border: none; padding: 0;
                  font-size: 11px; color: #ff9800; cursor: pointer;
                  text-decoration: underline; text-underline-offset: 2px;
                "
              >Regrade stale ({staleCount})</button>
            {/if}
            <button
              type="button"
              onclick={() => gradeAllSets(true)}
              style="
                background: none; border: none; padding: 0;
                font-size: 11px; color: var(--muted); cursor: pointer;
                text-decoration: underline; text-underline-offset: 2px;
              "
            >Regrade all</button>
          </div>
        {/if}
      </div>
    </div>

    {#if $gradeHistoryBusy}
      <div style="margin-top: 12px; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden">
        <div style="
          height: 100%; border-radius: 2px; background: #7c3aed;
          width: {$gradeHistoryProgress.total > 0
            ? ($gradeHistoryProgress.current / $gradeHistoryProgress.total) * 100
            : 0}%;
          transition: width 0.15s ease;
        "></div>
      </div>
    {/if}
  </div>

  <!-- View toggle (premium + has graded data + not busy) -->
  {#if $isPremium && activeHistory.filter((r) => r.grade !== null).length > 0 && !$gradeHistoryBusy}
    <div style="display: flex; gap: 4px; margin-bottom: 12px">
      {#each [["history", "History"], ["matchups", "By Matchup"]] as [mode, label]}
        <button
          type="button"
          onclick={() => { viewMode = mode as "history" | "matchups"; selectedMatchupKey = null; }}
          style="
            padding: 6px 16px; font-size: 12px; font-weight: 700; border-radius: 6px;
            border: 1px solid {viewMode === mode ? '#7c3aed' : 'var(--border)'};
            background: {viewMode === mode ? '#7c3aed22' : 'transparent'};
            color: {viewMode === mode ? '#7c3aed' : 'var(--muted)'};
            cursor: pointer; font-family: inherit;
          "
        >{label}</button>
      {/each}
    </div>
  {/if}

  <!-- By Matchup view -->
  {#if viewMode === "matchups" && $isPremium}
    {#if matchupSummaries.length === 0}
      <div style="text-align: center; padding: 48px 24px; color: var(--muted); font-size: 13px">
        Grade some sets first to see matchup averages.
      </div>
    {:else}
      <div class="card" style="padding: 0; overflow: hidden">

        <!-- Column headers -->
        <div style="
          display: grid; grid-template-columns: 1fr 54px 72px 80px 48px 48px 48px 20px;
          gap: 8px; padding: 10px 16px;
          font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.06em;
          border-bottom: 1px solid var(--border);
        ">
          <div>MATCHUP</div>
          <div style="text-align: center">SETS</div>
          <div>RECORD</div>
          <div style="text-align: center">GRADE</div>
          <div style="text-align: center">NEU</div>
          <div style="text-align: center">PUN</div>
          <div style="text-align: center">DEF</div>
          <div></div>
        </div>

        {#each matchupSummaries as m (m.key)}
          {@const isOpen = selectedMatchupKey === m.key}
          <div style="border-bottom: 1px solid var(--border)">
            <button
              type="button"
              onclick={() => { selectedMatchupKey = isOpen ? null : m.key; }}
              style="
                width: 100%; text-align: left; background: none; border: none;
                display: grid; grid-template-columns: 1fr 54px 72px 80px 48px 48px 48px 20px;
                align-items: center; gap: 8px; padding: 12px 16px;
                border-left: 3px solid {isOpen ? gc(m.avgLetter) : 'transparent'};
                background: {isOpen ? `${gc(m.avgLetter)}0d` : 'transparent'};
                cursor: pointer; font-family: inherit; color: var(--text);
              "
            >
              <div style="font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                {m.playerChar} <span style="color: var(--muted); font-weight: 400">vs</span> {m.opponentChar}
              </div>
              <div style="font-size: 13px; color: var(--muted); text-align: center">{m.setCount}</div>
              <div style="font-size: 13px; font-weight: 600">
                <span style="color: #2ecc71">{m.wins}W</span>
                <span style="color: var(--muted)">–</span>
                <span style="color: #e74c3c">{m.losses}L</span>
              </div>
              <div style="display: flex; flex-direction: column; align-items: center; gap: 1px">
                <div style="
                  font-size: 18px; font-weight: 800; line-height: 1; color: {gc(m.avgLetter)};
                  {m.avgLetter === 'S' ? `text-shadow: 0 0 8px ${gc(m.avgLetter)}aa;` : ''}
                ">{m.avgLetter}</div>
                <div style="font-size: 10px; color: var(--muted)">{m.avgScore.toFixed(0)}</div>
              </div>
              {#each CATEGORY_ORDER as cat}
                {@const c = m.categories[cat]}
                <div style="
                  font-size: 14px; font-weight: 800; text-align: center;
                  color: {c.letter ? gc(c.letter) : 'var(--muted)'};
                ">{c.letter ?? "—"}</div>
              {/each}
              <div style="font-size: 11px; color: var(--muted); text-align: right; transition: transform 0.15s; transform: rotate({isOpen ? 180 : 0}deg)">▾</div>
            </button>

            <!-- Expanded per-stat breakdown -->
            {#if isOpen}
              <div style="padding: 4px 16px 16px">
                {#each CATEGORY_ORDER as catKey}
                  {@const catDef = CATEGORY_DEFS[catKey]}
                  {@const catAvg = m.categories[catKey]}
                  <div style="margin-bottom: 12px">
                    <!-- Category header -->
                    <div style="
                      display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
                      padding: 6px 0; border-bottom: 1px solid var(--border);
                    ">
                      <div style="font-size: 12px; font-weight: 700; letter-spacing: 0.05em; color: var(--text)">{catDef.label.toUpperCase()}</div>
                      {#if catAvg.letter !== null}
                        <div style="
                          font-size: 12px; font-weight: 700; color: {gc(catAvg.letter)};
                          background: {gc(catAvg.letter)}1a; border-radius: 4px; padding: 1px 7px;
                        ">{catAvg.letter}</div>
                        <div style="font-size: 12px; color: var(--muted)">{catAvg.avgScore?.toFixed(0)}</div>
                      {/if}
                    </div>
                    <!-- Stat rows -->
                    {#each catDef.stats as statKey}
                      {@const stat = m.statAvgs.get(statKey)}
                      {#if stat}
                        <div style="
                          display: grid; grid-template-columns: 1fr 80px 48px 28px;
                          align-items: center; gap: 10px;
                          background: var(--bg); border-radius: 6px; padding: 8px 12px; margin-bottom: 3px;
                        ">
                          <div>
                            <div style="font-size: 13px; font-weight: 600">{stat.label}</div>
                            <div style="font-size: 12px; color: var(--muted)">{formatStatValue(statKey, stat.avgValue)}</div>
                          </div>
                          <div style="height: 5px; background: var(--border); border-radius: 3px; overflow: hidden">
                            {#if stat.avgScore !== null}
                              <div style="height: 100%; border-radius: 3px; width: {stat.avgScore}%; background: {stat.letter ? gc(stat.letter) : 'var(--muted)'}"></div>
                            {/if}
                          </div>
                          <div style="font-size: 12px; color: var(--muted); text-align: right">{stat.avgScore !== null ? stat.avgScore.toFixed(0) : "—"}</div>
                          <div style="font-size: 14px; font-weight: 700; text-align: center; color: {stat.letter ? gc(stat.letter) : 'var(--muted)'}">{stat.letter ?? "—"}</div>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/each}

              </div>
            {/if}

          </div>
        {/each}
      </div>
    {/if}

  {:else}

  {#if activeHistory.length > 0}
    <!-- Distribution summary -->
    {#if !$gradeHistoryBusy}
      {@const graded = sortedHistory.filter((r) => r.grade !== null)}
      {@const avgScore = graded.length > 0 ? graded.reduce((a, r) => a + r.grade!.score, 0) / graded.length : null}
      <div class="card" style="margin-bottom: 16px">
        <div style="display: flex; gap: 24px; flex-wrap: wrap; align-items: center">
          {#each ["S","A","B","C","D","F"] as letter}
            {@const count = graded.filter((r) => r.grade?.letter === letter).length}
            <div style="text-align: center; min-width: 40px">
              <div style="
                font-size: 24px; font-weight: 800; color: {gc(letter)};
                {letter === 'S' ? `text-shadow: 0 0 8px ${gc(letter)}aa;` : ''}
              ">{letter}</div>
              <div style="font-size: 18px; font-weight: 600">{count}</div>
              <div style="font-size: 12px; color: var(--muted)">
                {graded.length > 0 ? Math.round((count / graded.length) * 100) + "%" : "—"}
              </div>
            </div>
          {/each}
          {#if graded.length > 0}
            {@const gradeCounts = ["S","A","B","C","D","F"].map((l) => graded.filter((r) => r.grade?.letter === l).length)}
            {@const maxCount = Math.max(...gradeCounts, 1)}
            <div style="flex: 1; display: flex; align-items: flex-end; gap: 6px; height: 72px; padding: 0 16px; min-width: 120px">
              {#each ["S","A","B","C","D","F"] as letter, i}
                <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%">
                  <div style="
                    width: 100%; max-width: 28px;
                    height: {gradeCounts[i] > 0 ? Math.max(Math.round((gradeCounts[i] / maxCount) * 52), 3) : 0}px;
                    background: {gc(letter)};
                    border-radius: 3px 3px 0 0;
                    margin-bottom: 5px;
                    {letter === 'S' ? `box-shadow: 0 0 6px ${gc('S')}55;` : ''}
                  "></div>
                  <div style="font-size: 11px; font-weight: 700; color: {gc(letter)}">{letter}</div>
                </div>
              {/each}
            </div>
          {/if}
          {#if avgScore !== null}
            {@const avgLetter = scoreToGrade(avgScore)}
            <div style="margin-left: auto; text-align: right">
              <div style="font-size: 12px; color: var(--muted); margin-bottom: 4px">Overall average</div>
              <div style="display: flex; align-items: baseline; gap: 8px; justify-content: flex-end">
                <div style="
                  font-size: 32px; font-weight: 800; line-height: 1;
                  color: {gc(avgLetter)};
                  {avgLetter === 'S' ? `text-shadow: 0 0 10px ${gc(avgLetter)}aa;` : ''}
                ">{avgLetter}</div>
                <div style="font-size: 24px; font-weight: 700; color: var(--muted)">{avgScore.toFixed(1)}</div>
              </div>
              <div style="font-size: 12px; color: var(--muted); margin-top: 3px">{graded.length} sets graded</div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Filter + sort controls -->
    {#if !$gradeHistoryBusy}
      {@const anyFilterActive = filterLetter !== null || filterResult !== "all" || filterPlayerChar !== null || filterOppChar !== null}
      <div class="card" style="padding: 12px 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap">

        <!-- Grade filter group -->
        <div>
          <div style="font-size: 10px; font-weight: 700; color: var(--muted); letter-spacing: 0.07em; margin-bottom: 6px">GRADE</div>
          <div style="display: flex; gap: 3px">
            <button
              type="button"
              onclick={() => filterLetter = null}
              style="
                padding: 4px 10px; font-size: 12px; font-weight: 700; border-radius: 4px;
                border: 1px solid {filterLetter === null ? '#7c3aed' : 'var(--border)'};
                background: {filterLetter === null ? '#7c3aed22' : 'transparent'};
                color: {filterLetter === null ? '#7c3aed' : 'var(--muted)'};
                cursor: pointer;
              "
            >ALL</button>
            {#each ["S","A","B","C","D","F"] as letter}
              <button
                type="button"
                onclick={() => filterLetter = filterLetter === letter ? null : letter}
                style="
                  padding: 4px 10px; font-size: 12px; font-weight: 800; border-radius: 4px;
                  border: 1px solid {filterLetter === letter ? gc(letter) : 'var(--border)'};
                  background: {filterLetter === letter ? gc(letter) + '22' : 'transparent'};
                  color: {filterLetter === letter ? gc(letter) : 'var(--muted)'};
                  cursor: pointer;
                "
              >{letter}</button>
            {/each}
          </div>
        </div>

        <div style="width: 1px; height: 36px; background: var(--border); flex-shrink: 0"></div>

        <!-- Result filter group -->
        <div>
          <div style="font-size: 10px; font-weight: 700; color: var(--muted); letter-spacing: 0.07em; margin-bottom: 6px">RESULT</div>
          <div style="display: flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden">
            {#each [["all","All"],["win","W"],["loss","L"]] as [val, label]}
              <button
                type="button"
                onclick={() => filterResult = val as "all" | "win" | "loss"}
                style="
                  padding: 4px 12px; font-size: 12px; font-weight: 700; border: none;
                  background: {filterResult === val ? (val === 'win' ? '#2ecc7133' : val === 'loss' ? '#e74c3c33' : '#7c3aed22') : 'transparent'};
                  color: {filterResult === val ? (val === 'win' ? '#2ecc71' : val === 'loss' ? '#e74c3c' : '#7c3aed') : 'var(--muted)'};
                  cursor: pointer;
                "
              >{label}</button>
            {/each}
          </div>
        </div>

        <!-- Character filters (only shown when relevant) -->
        {#if uniquePlayerChars.length > 1 || uniqueOppChars.length > 0}
          <div style="width: 1px; height: 36px; background: var(--border); flex-shrink: 0"></div>
          <div>
            <div style="font-size: 10px; font-weight: 700; color: var(--muted); letter-spacing: 0.07em; margin-bottom: 6px">CHARACTER</div>
            <div style="display: flex; gap: 6px">
              {#if uniquePlayerChars.length > 1}
                <select
                  bind:value={filterPlayerChar}
                  style="
                    font-size: 12px; font-weight: 600; max-width: 140px;
                    background: var(--bg); color: {filterPlayerChar ? 'var(--text)' : 'var(--muted)'};
                    border: 1px solid {filterPlayerChar ? '#7c3aed' : 'var(--border)'}; border-radius: 4px;
                    padding: 4px 8px; cursor: pointer;
                  "
                >
                  <option value={null}>My Char</option>
                  {#each uniquePlayerChars as char}
                    <option value={char}>{char}</option>
                  {/each}
                </select>
              {/if}
              {#if uniqueOppChars.length > 0}
                <select
                  bind:value={filterOppChar}
                  style="
                    font-size: 12px; font-weight: 600; max-width: 140px;
                    background: var(--bg); color: {filterOppChar ? 'var(--text)' : 'var(--muted)'};
                    border: 1px solid {filterOppChar ? '#7c3aed' : 'var(--border)'}; border-radius: 4px;
                    padding: 4px 8px; cursor: pointer;
                  "
                >
                  <option value={null}>Opp Char</option>
                  {#each uniqueOppChars as char}
                    <option value={char}>{char}</option>
                  {/each}
                </select>
              {/if}
            </div>
          </div>
        {/if}

        <!-- Sort + clear — pushed right -->
        <div style="margin-left: auto; display: flex; align-items: flex-end; gap: 10px">
          {#if anyFilterActive}
            <button
              type="button"
              onclick={() => { filterLetter = null; filterResult = "all"; filterPlayerChar = null; filterOppChar = null; }}
              style="
                background: none; border: none; padding: 4px 0; margin-bottom: 1px;
                font-size: 11px; color: var(--muted); cursor: pointer;
                text-decoration: underline; text-underline-offset: 2px;
                font-family: inherit;
              "
            >Clear filters</button>
          {/if}
          <div>
            <div style="font-size: 10px; font-weight: 700; color: var(--muted); letter-spacing: 0.07em; margin-bottom: 6px">SORT</div>
            <select
              bind:value={sortMode}
              style="
                font-size: 12px; font-weight: 600;
                background: var(--bg); color: var(--muted);
                border: 1px solid var(--border); border-radius: 4px;
                padding: 4px 8px; cursor: pointer;
              "
            >
              <option value="date-desc">Date ↓</option>
              <option value="date-asc">Date ↑</option>
              <option value="score-desc">Score ↓</option>
              <option value="score-asc">Score ↑</option>
            </select>
          </div>
        </div>
      </div>
    {/if}

    <!-- Results list with inline expansion -->
    <div class="card" style="padding: 0; overflow: hidden">

      <!-- Column headers -->
      <div style="
        display: grid; grid-template-columns: 55px 140px 1fr 80px 56px 48px 20px;
        gap: 8px; padding: 10px 16px;
        font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.06em;
        border-bottom: 1px solid var(--border);
      ">
        <div>DATE</div>
        <div>OPPONENT</div>
        <div>VS CHAR</div>
        <div>RESULT</div>
        <div style="text-align: right">SCORE</div>
        <div style="text-align: center">GR</div>
        <div></div>
      </div>

      {#each sortedHistory as r (r.matchId)}
        {@const isWin = r.result === "win"}
        {@const isSelected = selectedMatchId === r.matchId}
        {@const letter = r.grade?.letter ?? null}
        {@const isStale = r.baselineVersion !== null && r.baselineVersion !== BENCHMARKS_VERSION}

        <!-- Row -->
        <div style="border-bottom: 1px solid var(--border)">
          <button
            type="button"
            onclick={() => { selectedMatchId = selectedMatchId === r.matchId ? null : r.matchId; }}
            style="
              width: 100%; text-align: left; background: none; border: none;
              display: grid; grid-template-columns: 55px 140px 1fr 80px 56px 48px 20px;
              align-items: center; gap: 8px;
              padding: 12px 16px;
              border-left: 3px solid {isSelected ? gc(letter) : 'transparent'};
              background: {isSelected ? `${gc(letter)}0d` : 'transparent'};
              cursor: pointer;
              font-family: inherit; color: var(--text);
            "
          >
            <div style="font-size: 12px; color: var(--muted)">{r.date}</div>
            <div style="font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {r.opponentCode}
            </div>
            <div style="font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {r.opponentChar}
            </div>
            <div style="font-size: 13px; color: {isWin ? '#2ecc71' : '#e74c3c'}; font-weight: 600">
              {isWin ? "W" : "L"} {r.wins}–{r.losses}
            </div>
            <div style="font-size: 13px; color: {isStale ? '#ff9800' : 'var(--muted)'}; text-align: right" title={isStale ? "Stale — baselines updated" : ""}>
              {r.grade ? r.grade.score.toFixed(0) : "—"}{isStale ? " ⟳" : ""}
            </div>
            <div style="
              font-size: 18px; font-weight: 800; text-align: center;
              color: {gc(letter)};
              {letter === 'S' ? `text-shadow: 0 0 8px ${gc('S')}aa;` : ''}
            ">
              {letter ?? (r.error ? "?" : "…")}
            </div>
            <div style="font-size: 11px; color: var(--muted); text-align: right; transition: transform 0.15s; transform: rotate({isSelected ? 180 : 0}deg)">
              ▾
            </div>
          </button>

          <!-- Inline expanded breakdown -->
          {#if isSelected && r.grade}
            {@const setGames = $sets.find((s) => s.match_id === r.matchId)?.games ?? []}
            <div style="padding: 0 14px 14px">
              {#if setGames.some((g) => g.filepath)}
                <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px">
                  {#each setGames.filter((g) => g.filepath) as g, i}
                    <button
                      onclick={() => invoke("show_in_folder", { path: g.filepath! })}
                      style="
                        background: var(--card); border: 1px solid var(--border);
                        border-radius: 5px; padding: 4px 10px;
                        font-size: 11px; color: var(--muted); cursor: pointer;
                        font-family: inherit;
                      "
                      onmouseenter={(e) => (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'}
                      onmouseleave={(e) => (e.currentTarget as HTMLButtonElement).style.color = 'var(--muted)'}
                    >
                      📂 Game {i + 1}
                    </button>
                  {/each}
                </div>
              {/if}
              <SetGradeDisplay grade={r.grade} detailed={$isPremium} />
            </div>
          {/if}
        </div>
      {/each}

      {#if $gradeHistoryBusy}
        <div style="padding: 10px 14px; font-size: 11px; color: var(--muted)">
          Parsing remaining sets…
        </div>
      {/if}
    </div>

  {:else if !$gradeHistoryBusy}
    <div style="text-align: center; padding: 48px 24px; color: var(--muted); font-size: 13px">
      Press "Grade All Sets" to score all {completedSets.length} completed sets.
    </div>
  {/if}

  {/if}<!-- end {:else} history view -->
