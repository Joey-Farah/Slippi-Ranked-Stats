<script lang="ts">
  /**
   * Grade distribution summary: per-letter counts, a bar chart, and the overall average.
   *
   * Extracted from the Grading tab's Ranked view so the Unranked & Direct view gets the same
   * summary rather than a second copy that slowly drifts. The only thing that differs between
   * them is the noun — ranked counts SETS, unranked counts GAMES, and the two must never be
   * summed or described interchangeably.
   */
  import { gradeColor, scoreToGrade, type SetGrade } from "../lib/grading";

  let {
    /** Entries that actually have a grade. Callers filter; this component does not guess. */
    graded = [] as { grade: SetGrade | null }[],
    /** Plural noun for the count line: "sets" for ranked, "games" for unranked/direct. */
    unit = "sets",
  }: {
    graded?: { grade: SetGrade | null }[];
    unit?: string;
  } = $props();

  const LETTERS = ["S", "A", "B", "C", "D", "F"] as const;

  function gc(letter: string | null): string {
    return gradeColor(letter as any);
  }

  let counts = $derived(LETTERS.map((l) => graded.filter((r) => r.grade?.letter === l).length));
  let maxCount = $derived(Math.max(...counts, 1));
  let avgScore = $derived(
    graded.length > 0 ? graded.reduce((a, r) => a + (r.grade?.score ?? 0), 0) / graded.length : null
  );
</script>

<div class="card" style="margin-bottom: 16px">
  <div style="display: flex; gap: 24px; flex-wrap: wrap; align-items: center">
    {#each LETTERS as letter, i}
      <div style="text-align: center; min-width: 40px">
        <div style="
          font-size: 24px; font-weight: 800; color: {gc(letter)};
          {letter === 'S' ? `text-shadow: 0 0 8px ${gc(letter)}aa;` : ''}
        ">{letter}</div>
        <div style="font-size: 18px; font-weight: 600">{counts[i]}</div>
        <div style="font-size: 12px; color: var(--muted)">
          {graded.length > 0 ? Math.round((counts[i] / graded.length) * 100) + "%" : "—"}
        </div>
      </div>
    {/each}

    {#if graded.length > 0}
      <div style="flex: 1; display: flex; align-items: flex-end; gap: 6px; height: 72px; padding: 0 16px; min-width: 120px">
        {#each LETTERS as letter, i}
          <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%">
            <div style="
              width: 100%; max-width: 28px;
              height: {counts[i] > 0 ? Math.max(Math.round((counts[i] / maxCount) * 52), 3) : 0}px;
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
        <div style="font-size: 12px; color: var(--muted); margin-top: 3px">
          {graded.length.toLocaleString()} {unit} graded
        </div>
      </div>
    {/if}
  </div>
</div>
