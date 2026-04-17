<script lang="ts">
  import { onMount } from "svelte";
  import {
    isPremium, connectCode, sets,
    gradeHistory, gradeHistoryBusy, gradeHistoryProgress,
    type GradeHistoryEntry, type LiveGameStats,
  } from "../../lib/store";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { CHARACTERS, parseSlpFile } from "../../lib/parser";
  import { gradeSet, scoreToGrade, type GradeLetter } from "../../lib/grading";
  import { getDb, saveSetGrade, getAllSetGrades, deleteSetGrade, type SetGradeRow } from "../../lib/db";
  import { BENCHMARKS_VERSION } from "../../lib/grade-benchmarks";
  import type { SetGrade } from "../../lib/grading";
  import SetGradeDisplay from "../SetGradeDisplay.svelte";

  function rowToEntry(row: SetGradeRow): GradeHistoryEntry {
    const d = new Date(row.set_timestamp);
    const grade: SetGrade = {
      letter:     row.overall_letter as GradeLetter,
      score:      row.overall_score,
      categories: {
        neutral:   { label: "Neutral",   letter: row.neutral_letter as GradeLetter | null,   score: row.neutral_score },
        punish:    { label: "Punish",    letter: row.punish_letter as GradeLetter | null,     score: row.punish_score },
        defense:   { label: "Defense",   letter: row.defense_letter as GradeLetter | null,    score: row.defense_score },
        execution: { label: "Execution", letter: row.execution_letter as GradeLetter | null,  score: row.execution_score },
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

  onMount(async () => {
    const code = $connectCode;
    if (!code) return;
    try {
      const db = await getDb(code);
      const rows = await getAllSetGrades(db);
      if (rows.length > 0) {
        gradeHistory.set(rows.map(rowToEntry));
      }
    } catch { /* DB not ready yet — will populate on first grade */ }
  });

  const GRADE_COLORS: Record<string, string> = {
    S: "#FFD700",
    A: "#00e676",
    B: "#448aff",
    C: "#aaaaaa",
    D: "#ff9800",
    F: "#ff1744",
  };

  function gc(letter: string | null): string {
    return letter ? (GRADE_COLORS[letter] ?? "var(--muted)") : "var(--muted)";
  }

  let completedSets = $derived(
    [...$sets]
      .filter((s) => Math.max(s.wins, s.losses) >= 2)
      .reverse()
  );

  // Set IDs that already have a grade result (successful or errored)
  let gradedIds = $derived(new Set($gradeHistory.map((r) => r.matchId)));

  // Only sets not yet graded — shown in button label
  let ungradedSets = $derived(completedSets.filter((s) => !gradedIds.has(s.match_id)));

  let selectedMatchId  = $state<string | null>(null);
  let filterLetter     = $state<string | null>(null);
  let filterResult     = $state<"all" | "win" | "loss">("all");
  let filterPlayerChar = $state<string | null>(null);
  let filterOppChar    = $state<string | null>(null);
  let sortMode = $state<"date-desc" | "date-asc" | "score-desc" | "score-asc">("date-desc");

  let uniquePlayerChars = $derived([...new Set($gradeHistory.map((r) => r.playerChar))].sort());
  let uniqueOppChars    = $derived([...new Set($gradeHistory.map((r) => r.opponentChar))].sort());

  let staleCount = $derived(
    $gradeHistory.filter((r) => r.baselineVersion !== null && r.baselineVersion !== BENCHMARKS_VERSION).length
  );

  let sortedHistory = $derived((() => {
    let h = [...$gradeHistory];
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

  async function gradeAllSets(force = false) {
    const code = $connectCode;
    const toGrade = force ? completedSets : ungradedSets;
    if (!code || toGrade.length === 0) return;

    if (force) gradeHistory.set([]);

    gradeHistoryBusy.set(true);
    gradeHistoryProgress.set({ current: 0, total: toGrade.length });

    let db: Awaited<ReturnType<typeof getDb>> | null = null;
    try { db = await getDb(code); } catch { /* DB unavailable — still grade in memory */ }

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
            const parsed = await parseSlpFile(g.filepath, code);
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

          if (db && entry.grade) {
            const g = entry.grade;
            try {
              await saveSetGrade(db, {
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
                execution_score:  g.categories.execution.score,
                execution_letter: g.categories.execution.letter,
                breakdown_json:   JSON.stringify(g.breakdown),
              });
            } catch { /* don't fail the UI on a DB write error */ }
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
    if (!code) return;
    const staleIds = new Set(
      $gradeHistory
        .filter((r) => r.baselineVersion !== null && r.baselineVersion !== BENCHMARKS_VERSION)
        .map((r) => r.matchId)
    );
    if (staleIds.size === 0) return;

    let db: Awaited<ReturnType<typeof getDb>> | null = null;
    try { db = await getDb(code); } catch {}
    if (db) {
      for (const id of staleIds) {
        try { await deleteSetGrade(db, id); } catch {}
      }
    }

    gradeHistory.update((prev) => prev.filter((r) => !staleIds.has(r.matchId)));
    gradeAllSets(false);
  }
</script>

{#if !$isPremium}
  <!-- Free-tier upsell banner (non-blocking) -->
  <button
    type="button"
    onclick={() => openUrl("https://www.patreon.com/joeydonuts")}
    style="
      width: 100%; margin-bottom: 16px; padding: 10px 14px;
      background: linear-gradient(135deg, #7c3aed22, #FF424D22);
      border: 1px solid #7c3aed55; border-radius: 8px;
      color: var(--text); font-family: inherit; cursor: pointer; text-align: left;
      display: flex; align-items: center; gap: 10px;
    "
  >
    <span style="font-size: 18px">🔒</span>
    <div style="flex: 1">
      <div style="font-size: 12px; font-weight: 700; margin-bottom: 2px">
        Unlock the full breakdown
      </div>
      <div style="font-size: 11px; color: var(--muted); line-height: 1.4">
        Free: overall grade + strongest/weakest category. Patreon: per-category scores, every stat, matchup baselines.
      </div>
    </div>
    <div style="font-size: 11px; font-weight: 700; color: #7c3aed; white-space: nowrap">
      Upgrade →
    </div>
  </button>
{/if}

  <!-- Header -->
  <div class="card" style="margin-bottom: 16px">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap">
      <div>
        <div class="section-title" style="margin-bottom: 3px">Ranked Grades</div>
        <div style="font-size: 11px; color: var(--muted)">
          Scores each set across Neutral, Punish, Defense, and Execution against community baselines. A directional read, not a verdict.
          <button
            type="button"
            onclick={() => openUrl("https://github.com/Joey-Farah/Slippi-Ranked-Stats/blob/main/docs/grading_methodology.md")}
            style="
              background: none; border: none; padding: 0; margin-left: 2px;
              color: #7c3aed; font-family: inherit; font-size: inherit;
              cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
            "
          >How is this calculated?</button>
          {#if $gradeHistory.length > 0 && !$gradeHistoryBusy}
            <span style="color: var(--text)">{$gradeHistory.filter((r) => r.grade !== null).length} of {completedSets.length} sets graded.</span>
            {#if ungradedSets.length === 0}
              <span style="color: #2ecc71"> Up to date.</span>
            {/if}
          {/if}
        </div>
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0">
        <button
          type="button"
          disabled={$gradeHistoryBusy || ungradedSets.length === 0}
          onclick={() => gradeAllSets(false)}
          style="
            padding: 9px 18px; font-size: 12px; font-weight: 700;
            background: #7c3aed; color: #fff; border: none; border-radius: 6px;
            cursor: {$gradeHistoryBusy || ungradedSets.length === 0 ? 'default' : 'pointer'};
            opacity: {$gradeHistoryBusy || ungradedSets.length === 0 ? 0.5 : 1};
            white-space: nowrap;
          "
        >
          {#if $gradeHistoryBusy}
            Grading… {$gradeHistoryProgress.current} / {$gradeHistoryProgress.total}
          {:else if $gradeHistory.length === 0}
            Grade All Sets
          {:else if ungradedSets.length > 0}
            Grade New Sets ({ungradedSets.length})
          {:else}
            Up to Date
          {/if}
        </button>
        {#if $gradeHistory.length > 0 && !$gradeHistoryBusy}
          <div style="display: flex; gap: 8px; align-items: center">
            {#if staleCount > 0}
              <button
                type="button"
                onclick={regradeStale}
                style="
                  background: none; border: none; padding: 0;
                  font-size: 10px; color: #ff9800; cursor: pointer;
                  text-decoration: underline; text-underline-offset: 2px;
                "
              >Regrade stale ({staleCount})</button>
            {/if}
            <button
              type="button"
              onclick={() => gradeAllSets(true)}
              style="
                background: none; border: none; padding: 0;
                font-size: 10px; color: var(--muted); cursor: pointer;
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

  {#if $gradeHistory.length > 0}
    <!-- Distribution summary -->
    {#if !$gradeHistoryBusy}
      {@const graded = sortedHistory.filter((r) => r.grade !== null)}
      {@const avgScore = graded.length > 0 ? graded.reduce((a, r) => a + r.grade!.score, 0) / graded.length : null}
      <div class="card" style="margin-bottom: 16px">
        <div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: center">
          {#each ["S","A","B","C","D","F"] as letter}
            {@const count = graded.filter((r) => r.grade?.letter === letter).length}
            <div style="text-align: center; min-width: 32px">
              <div style="
                font-size: 18px; font-weight: 800; color: {gc(letter)};
                {letter === 'S' ? `text-shadow: 0 0 8px ${gc(letter)}aa;` : ''}
              ">{letter}</div>
              <div style="font-size: 14px; font-weight: 600">{count}</div>
              <div style="font-size: 10px; color: var(--muted)">
                {graded.length > 0 ? Math.round((count / graded.length) * 100) + "%" : "—"}
              </div>
            </div>
          {/each}
          {#if avgScore !== null}
            {@const avgLetter = scoreToGrade(avgScore)}
            <div style="margin-left: auto; text-align: right">
              <div style="font-size: 10px; color: var(--muted); margin-bottom: 4px">Overall average</div>
              <div style="display: flex; align-items: baseline; gap: 8px; justify-content: flex-end">
                <div style="
                  font-size: 26px; font-weight: 800; line-height: 1;
                  color: {gc(avgLetter)};
                  {avgLetter === 'S' ? `text-shadow: 0 0 10px ${gc(avgLetter)}aa;` : ''}
                ">{avgLetter}</div>
                <div style="font-size: 20px; font-weight: 700; color: var(--muted)">{avgScore.toFixed(1)}</div>
              </div>
              <div style="font-size: 10px; color: var(--muted); margin-top: 3px">{graded.length} sets graded</div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Filter + sort controls -->
    {#if !$gradeHistoryBusy}
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px">
        <!-- Grade letter filter pills -->
        <div style="display: flex; gap: 4px; align-items: center">
          <button
            type="button"
            onclick={() => filterLetter = null}
            style="
              padding: 3px 8px; font-size: 10px; font-weight: 700; border-radius: 4px;
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
                padding: 3px 8px; font-size: 10px; font-weight: 800; border-radius: 4px;
                border: 1px solid {filterLetter === letter ? gc(letter) : 'var(--border)'};
                background: {filterLetter === letter ? gc(letter) + '22' : 'transparent'};
                color: {filterLetter === letter ? gc(letter) : 'var(--muted)'};
                cursor: pointer;
              "
            >{letter}</button>
          {/each}
        </div>

        <!-- Result filter -->
        <div style="display: flex; gap: 2px; align-items: center; border: 1px solid var(--border); border-radius: 4px; overflow: hidden">
          {#each [["all","All"],["win","W"],["loss","L"]] as [val, label]}
            <button
              type="button"
              onclick={() => filterResult = val as "all" | "win" | "loss"}
              style="
                padding: 3px 7px; font-size: 10px; font-weight: 700; border: none;
                background: {filterResult === val ? (val === 'win' ? '#2ecc7133' : val === 'loss' ? '#e74c3c33' : '#7c3aed22') : 'transparent'};
                color: {filterResult === val ? (val === 'win' ? '#2ecc71' : val === 'loss' ? '#e74c3c' : '#7c3aed') : 'var(--muted)'};
                cursor: pointer;
              "
            >{label}</button>
          {/each}
        </div>

        <!-- Character filters -->
        {#if uniquePlayerChars.length > 1}
          <select
            bind:value={filterPlayerChar}
            style="
              font-size: 10px; font-weight: 600;
              background: var(--card); color: {filterPlayerChar ? 'var(--text)' : 'var(--muted)'};
              border: 1px solid {filterPlayerChar ? '#7c3aed' : 'var(--border)'}; border-radius: 4px;
              padding: 3px 6px; cursor: pointer;
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
              font-size: 10px; font-weight: 600;
              background: var(--card); color: {filterOppChar ? 'var(--text)' : 'var(--muted)'};
              border: 1px solid {filterOppChar ? '#7c3aed' : 'var(--border)'}; border-radius: 4px;
              padding: 3px 6px; cursor: pointer;
            "
          >
            <option value={null}>Opp Char</option>
            {#each uniqueOppChars as char}
              <option value={char}>{char}</option>
            {/each}
          </select>
        {/if}

        <!-- Sort selector -->
        <select
          bind:value={sortMode}
          style="
            margin-left: auto; font-size: 10px; font-weight: 600;
            background: var(--card); color: var(--muted);
            border: 1px solid var(--border); border-radius: 4px;
            padding: 3px 6px; cursor: pointer;
          "
        >
          <option value="date-desc">Date ↓</option>
          <option value="date-asc">Date ↑</option>
          <option value="score-desc">Score ↓</option>
          <option value="score-asc">Score ↑</option>
        </select>
      </div>
    {/if}

    <!-- Results list with inline expansion -->
    <div class="card" style="padding: 0; overflow: hidden">

      <!-- Column headers -->
      <div style="
        display: grid; grid-template-columns: 46px 1fr 80px 64px 48px 36px 16px;
        gap: 8px; padding: 8px 14px;
        font-size: 10px; font-weight: 700; color: var(--muted); letter-spacing: 0.06em;
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
              display: grid; grid-template-columns: 46px 1fr 80px 64px 48px 36px 16px;
              align-items: center; gap: 8px;
              padding: 9px 14px;
              border-left: 3px solid {isSelected ? gc(letter) : 'transparent'};
              background: {isSelected ? `${gc(letter)}0d` : 'transparent'};
              cursor: pointer;
              font-family: inherit; color: var(--text);
            "
          >
            <div style="font-size: 11px; color: var(--muted)">{r.date}</div>
            <div style="font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {r.opponentCode}
            </div>
            <div style="font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {r.opponentChar}
            </div>
            <div style="font-size: 11px; color: {isWin ? '#2ecc71' : '#e74c3c'}; font-weight: 600">
              {isWin ? "W" : "L"} {r.wins}–{r.losses}
            </div>
            <div style="font-size: 11px; color: {isStale ? '#ff9800' : 'var(--muted)'}; text-align: right" title={isStale ? "Stale — baselines updated" : ""}>
              {r.grade ? r.grade.score.toFixed(0) : "—"}{isStale ? " ⟳" : ""}
            </div>
            <div style="
              font-size: 15px; font-weight: 800; text-align: center;
              color: {gc(letter)};
              {letter === 'S' ? `text-shadow: 0 0 8px ${gc('S')}aa;` : ''}
            ">
              {letter ?? (r.error ? "?" : "…")}
            </div>
            <div style="font-size: 10px; color: var(--muted); text-align: right; transition: transform 0.15s; transform: rotate({isSelected ? 180 : 0}deg)">
              ▾
            </div>
          </button>

          <!-- Inline expanded breakdown -->
          {#if isSelected && r.grade}
            <div style="padding: 0 14px 14px">
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
