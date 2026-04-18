<script lang="ts">
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { CATEGORY_DEFS, DISPLAY_ONLY_STATS, type SetGrade, type GradeLetter, type CategoryKey } from "../lib/grading";

  let { grade, detailed = true }: { grade: SetGrade; detailed?: boolean } = $props();

  const GRADE_COLORS: Record<GradeLetter, string> = {
    S: "#FFD700",   // gold
    A: "#00C853",   // rich green
    B: "#00B0FF",   // sky blue
    C: "#FFB300",   // amber
    D: "#FF6D00",   // deep orange
    F: "#FF1744",   // red
  };

  function gc(g: GradeLetter | null): string {
    return g ? (GRADE_COLORS[g] ?? "var(--muted)") : "var(--muted)";
  }

  const CATEGORY_ORDER: CategoryKey[] = ["neutral", "punish", "defense"];

  const NULL_CONTEXT: Partial<Record<keyof SetGrade["breakdown"], string>> = {
    comeback_rate:         "never behind in stocks",
    lead_maintenance_rate: "never had stock lead",
  };
</script>

<div class="card" style="margin-bottom: 16px">

  <!-- Header: overall badge + set context -->
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px">
    <div>
      <div class="section-title" style="margin-bottom: 5px">Set Grade</div>
      <div style="font-size: 13px; color: var(--muted)">
        {grade.playerChar} vs {grade.opponentChar} ·
        <span style="color: {grade.setResult === 'win' ? '#2ecc71' : '#e74c3c'}">
          {grade.setResult === "win" ? "Win" : "Loss"}
        </span>
        {grade.wins}–{grade.losses}
        {#if grade.baselineSource === "matchup"}
          <span style="opacity: 0.6"> · matchup baseline</span>
        {:else if grade.baselineSource === "overall"}
          <span style="opacity: 0.6"> · overall baseline</span>
        {/if}
      </div>
    </div>

    <div style="
      width: 80px; height: 80px; border-radius: 14px; flex-shrink: 0;
      background: {gc(grade.letter)}{grade.letter === 'S' ? '30' : grade.letter === 'A' ? '22' : '18'};
      border: 2px solid {gc(grade.letter)};
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      {grade.letter === 'S' ? `box-shadow: 0 0 16px 4px ${gc(grade.letter)}66, 0 0 4px 1px ${gc(grade.letter)}aa;` : ''}
    ">
      <div style="
        font-size: 38px; font-weight: 800; line-height: 1; color: {gc(grade.letter)};
        {grade.letter === 'S' ? `text-shadow: 0 0 12px ${gc(grade.letter)}cc;` : ''}
      ">{grade.letter}</div>
      <div style="font-size: 12px; color: var(--muted)">{grade.score.toFixed(0)}</div>
    </div>
  </div>

  {#if !detailed}
    {@const scoredCats = CATEGORY_ORDER
      .map((k) => ({ key: k, ...grade.categories[k] }))
      .filter((c) => c.score !== null)}
    {@const sorted = [...scoredCats].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))}
    {@const weakest = sorted[sorted.length - 1]}

    {#if weakest}
      <div style="
        background: var(--bg); border-radius: 8px; padding: 12px 14px;
      ">
        <div style="font-size: 10px; color: var(--muted); letter-spacing: 0.05em; margin-bottom: 3px">NEEDS WORK</div>
        <div style="display: flex; align-items: baseline; gap: 6px">
          <div style="font-size: 13px; font-weight: 600">{weakest.label}</div>
          <div style="font-size: 13px; font-weight: 800; color: {gc(weakest.letter)}">{weakest.letter}</div>
        </div>
      </div>
    {/if}

    <button
      type="button"
      onclick={() => openUrl("https://ko-fi.com/joeydonuts")}
      style="
        width: 100%; margin-top: 12px; padding: 10px 14px;
        background: linear-gradient(135deg, #29ABE022, #7c3aed22);
        border: 1px solid #29ABE055; border-radius: 8px;
        color: var(--text); font-family: inherit; cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        font-size: 12px; font-weight: 600;
      "
    >
      <span style="font-size: 14px">🔒</span>
      Unlock category breakdown + per-stat scores
    </button>
  {:else}
  <!-- Category rows -->
  <div style="display: flex; flex-direction: column; gap: 16px">
    {#each CATEGORY_ORDER as catKey}
      {@const cat = grade.categories[catKey]}
      {@const catStats = grade.breakdown}

      <!-- Category header -->
      <div>
        <div style="
          display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
          padding-bottom: 6px; border-bottom: 1px solid var(--border);
        ">
          <div style="font-size: 14px; font-weight: 700; letter-spacing: 0.05em; color: var(--text)">
            {cat.label.toUpperCase()}
          </div>
          {#if cat.letter !== null}
            <div style="
              font-size: 13px; font-weight: 700; color: {gc(cat.letter)};
              background: {gc(cat.letter)}1a; border-radius: 4px; padding: 2px 8px;
            ">{cat.letter}</div>
            <div style="font-size: 13px; color: var(--muted)">{cat.score?.toFixed(0)}</div>
          {:else}
            <div style="font-size: 13px; color: var(--muted)">—</div>
          {/if}
        </div>

        <!-- Stat rows within category -->
        {#each CATEGORY_DEFS[catKey].stats as statKey}
          {@const stat = catStats[statKey as keyof typeof catStats]}
          {@const displayOnly = DISPLAY_ONLY_STATS.has(statKey)}
          <div style="
            display: grid; grid-template-columns: 1fr 160px 48px 28px;
            align-items: center; gap: 10px;
            background: var(--bg); border-radius: 6px; padding: 10px 14px;
            margin-bottom: 4px;
            opacity: {displayOnly ? 0.55 : 1};
          ">
            <!-- Label + value -->
            <div>
              <div style="font-size: 15px; font-weight: 600">{stat.label}</div>
              <div style="font-size: 13px; color: var(--muted)">
                {#if stat.value === null && NULL_CONTEXT[statKey as keyof SetGrade["breakdown"]]}
                  <span style="opacity: 0.6; font-style: italic">{NULL_CONTEXT[statKey as keyof SetGrade["breakdown"]]}</span>
                {:else}
                  {stat.formatted}
                {/if}
                {#if displayOnly}<span style="font-size: 10px; margin-left: 4px; opacity: 0.7">info only</span>{/if}
              </div>
            </div>

            <!-- Score bar -->
            <div style="height: 6px; background: var(--border); border-radius: 3px; overflow: hidden">
              {#if stat.score !== null && !displayOnly}
                <div style="
                  height: 100%; border-radius: 3px; width: {stat.score}%;
                  background: {gc(stat.grade)};
                "></div>
              {/if}
            </div>

            <!-- Score number -->
            <div style="font-size: 13px; color: var(--muted); text-align: right">
              {!displayOnly && stat.score !== null ? stat.score.toFixed(0) : "—"}
            </div>

            <!-- Grade letter -->
            <div style="
              font-size: 15px; font-weight: 700; text-align: center;
              color: {gc(stat.grade)};
            ">{displayOnly ? "~" : (stat.grade ?? "—")}</div>
          </div>
        {/each}
      </div>
    {/each}
  </div>
  {/if}

</div>
