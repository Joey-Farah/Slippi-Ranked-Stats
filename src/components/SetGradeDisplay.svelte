<script lang="ts">
  import type { SetGrade, GradeLetter } from "../lib/grading";

  let { grade }: { grade: SetGrade } = $props();

  const GRADE_COLORS: Record<GradeLetter, string> = {
    S: "#f0c040",
    A: "#2ecc71",
    B: "#3498db",
    C: "#e0e0a0",
    D: "#e67e22",
    F: "#e74c3c",
  };

  function gradeColor(g: GradeLetter | null): string {
    return g ? (GRADE_COLORS[g] ?? "var(--muted)") : "var(--muted)";
  }

  const statKeys = [
    "neutral_win_ratio",
    "openings_per_kill",
    "damage_per_opening",
    "l_cancel_ratio",
  ] as const;
</script>

<div class="card" style="margin-bottom: 16px">
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px">
    <div>
      <div class="section-title" style="margin-bottom: 2px">Set Grade</div>
      <div style="font-size: 11px; color: var(--muted)">
        vs {grade.opponentChar} ·
        <span style="color: {grade.setResult === 'win' ? '#2ecc71' : '#e74c3c'}">
          {grade.setResult === "win" ? "Win" : "Loss"}
        </span>
        {grade.wins}–{grade.losses}
        {#if grade.baselineSource === "overall"}
          <span style="color: var(--muted)"> · overall baseline</span>
        {/if}
      </div>
    </div>

    <!-- Overall grade badge -->
    <div style="
      width: 56px; height: 56px; border-radius: 10px;
      background: {gradeColor(grade.letter)}22;
      border: 2px solid {gradeColor(grade.letter)};
      display: flex; flex-direction: column; align-items: center; justify-content: center;
    ">
      <div style="font-size: 26px; font-weight: 800; line-height: 1; color: {gradeColor(grade.letter)}">
        {grade.letter}
      </div>
      <div style="font-size: 9px; color: var(--muted); margin-top: 1px">{grade.score.toFixed(0)}</div>
    </div>
  </div>

  <!-- Per-stat breakdown -->
  <div style="display: flex; flex-direction: column; gap: 6px">
    {#each statKeys as key}
      {@const stat = grade.breakdown[key]}
      <div style="
        display: grid; grid-template-columns: 1fr 64px 80px 28px;
        align-items: center; gap: 8px;
        background: var(--bg); border-radius: 6px; padding: 7px 10px;
      ">
        <!-- Label + value -->
        <div>
          <div style="font-size: 11px; font-weight: 500">{stat.label}</div>
          <div style="font-size: 10px; color: var(--muted)">{stat.formatted}</div>
        </div>

        <!-- Score bar -->
        <div style="height: 4px; background: var(--border); border-radius: 2px; overflow: hidden">
          {#if stat.score !== null}
            <div style="
              height: 100%; border-radius: 2px;
              width: {stat.score}%;
              background: {gradeColor(stat.grade)};
            "></div>
          {/if}
        </div>

        <!-- Numeric score -->
        <div style="font-size: 10px; color: var(--muted); text-align: right">
          {stat.score !== null ? stat.score.toFixed(0) + " / 100" : "—"}
        </div>

        <!-- Grade letter -->
        <div style="
          font-size: 13px; font-weight: 700; text-align: center;
          color: {gradeColor(stat.grade)};
        ">
          {stat.grade ?? "—"}
        </div>
      </div>
    {/each}
  </div>
</div>
