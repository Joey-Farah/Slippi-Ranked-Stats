<script lang="ts">
  import { CATEGORY_DEFS, type SetGrade, type GradeLetter, type CategoryKey } from "../lib/grading";

  let { grade }: { grade: SetGrade } = $props();

  const GRADE_COLORS: Record<GradeLetter, string> = {
    S: "#f0c040",
    A: "#2ecc71",
    B: "#3498db",
    C: "#e0e0a0",
    D: "#e67e22",
    F: "#e74c3c",
  };

  function gc(g: GradeLetter | null): string {
    return g ? (GRADE_COLORS[g] ?? "var(--muted)") : "var(--muted)";
  }

  const CATEGORY_ORDER: CategoryKey[] = ["neutral", "punish", "defense", "execution"];
</script>

<div class="card" style="margin-bottom: 16px">

  <!-- Header: overall badge + set context -->
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px">
    <div>
      <div class="section-title" style="margin-bottom: 3px">Set Grade</div>
      <div style="font-size: 11px; color: var(--muted)">
        {grade.playerChar} vs {grade.opponentChar} ·
        <span style="color: {grade.setResult === 'win' ? '#2ecc71' : '#e74c3c'}">
          {grade.setResult === "win" ? "Win" : "Loss"}
        </span>
        {grade.wins}–{grade.losses}
        {#if grade.baselineSource === "overall"}
          <span style="opacity: 0.6"> · overall baseline</span>
        {/if}
      </div>
    </div>

    <div style="
      width: 60px; height: 60px; border-radius: 12px; flex-shrink: 0;
      background: {gc(grade.letter)}1a;
      border: 2px solid {gc(grade.letter)};
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
    ">
      <div style="font-size: 28px; font-weight: 800; line-height: 1; color: {gc(grade.letter)}">{grade.letter}</div>
      <div style="font-size: 9px; color: var(--muted)">{grade.score.toFixed(0)}</div>
    </div>
  </div>

  <!-- Category rows -->
  <div style="display: flex; flex-direction: column; gap: 10px">
    {#each CATEGORY_ORDER as catKey}
      {@const cat = grade.categories[catKey]}
      {@const catStats = grade.breakdown}

      <!-- Category header -->
      <div>
        <div style="
          display: flex; align-items: center; gap: 8px; margin-bottom: 5px;
          padding-bottom: 4px; border-bottom: 1px solid var(--border);
        ">
          <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.05em; color: var(--text)">
            {cat.label.toUpperCase()}
          </div>
          {#if cat.letter !== null}
            <div style="
              font-size: 11px; font-weight: 700; color: {gc(cat.letter)};
              background: {gc(cat.letter)}1a; border-radius: 4px; padding: 1px 6px;
            ">{cat.letter}</div>
            <div style="font-size: 10px; color: var(--muted)">{cat.score?.toFixed(0)}</div>
          {:else}
            <div style="font-size: 10px; color: var(--muted)">—</div>
          {/if}
        </div>

        <!-- Stat rows within category — driven by CATEGORY_DEFS so display
             stays in sync with grading logic when categories are rearranged. -->
        {#each CATEGORY_DEFS[catKey].stats as statKey}
          {@const stat = catStats[statKey as keyof typeof catStats]}
          <div style="
            display: grid; grid-template-columns: 1fr 72px 52px 26px;
            align-items: center; gap: 8px;
            background: var(--bg); border-radius: 6px; padding: 6px 10px;
            margin-bottom: 3px;
          ">
            <!-- Label + value -->
            <div>
              <div style="font-size: 11px; font-weight: 500">{stat.label}</div>
              <div style="font-size: 10px; color: var(--muted)">{stat.formatted}</div>
            </div>

            <!-- Score bar -->
            <div style="height: 3px; background: var(--border); border-radius: 2px; overflow: hidden">
              {#if stat.score !== null}
                <div style="
                  height: 100%; border-radius: 2px; width: {stat.score}%;
                  background: {gc(stat.grade)};
                "></div>
              {/if}
            </div>

            <!-- Score number -->
            <div style="font-size: 10px; color: var(--muted); text-align: right">
              {stat.score !== null ? stat.score.toFixed(0) : "—"}
            </div>

            <!-- Grade letter -->
            <div style="
              font-size: 12px; font-weight: 700; text-align: center;
              color: {gc(stat.grade)};
            ">{stat.grade ?? "—"}</div>
          </div>
        {/each}
      </div>
    {/each}
  </div>

</div>
