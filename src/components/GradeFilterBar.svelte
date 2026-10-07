<script lang="ts">
  /**
   * Grade / result / character / opponent-code filters plus the sort selector.
   *
   * Extracted from the Grading tab's Ranked view so the Unranked & Direct view gets exactly the
   * same controls rather than a second, slowly-diverging copy. Every filter is a bindable prop,
   * so each view keeps its own independent selection — switching sub-tabs must not carry a
   * "Fox only" filter across into a list where it means something different.
   */
  import { gradeColor } from "../lib/grading";

  export type ResultFilter = "all" | "win" | "loss" | "none";
  export type SortMode = "date-desc" | "date-asc" | "score-desc" | "score-asc";

  let {
    filterLetter = $bindable<string | null>(null),
    filterResult = $bindable<ResultFilter>("all"),
    filterPlayerChar = $bindable<string | null>(null),
    filterOppChar = $bindable<string | null>(null),
    filterOppCode = $bindable(""),
    sortMode = $bindable<SortMode>("date-desc"),
    uniquePlayerChars = [] as string[],
    uniqueOppChars = [] as string[],
    uniqueOppCodes = [] as string[],
    /** Show a "no result" option. Only unranked/direct need it: a quit-out there counts as
     *  neither a win nor a loss (see outcome.ts), so without this those games are unreachable
     *  by any result filter. Ranked has no such state. */
    allowNoResult = false,
    /** The <datalist> id. A prop because a hardcoded DOM id would collide if two bars ever
     *  render at once, and a colliding datalist silently stops suggesting. */
    codeListId = "opp-code-list",
  }: {
    filterLetter?: string | null;
    filterResult?: ResultFilter;
    filterPlayerChar?: string | null;
    filterOppChar?: string | null;
    filterOppCode?: string;
    sortMode?: SortMode;
    uniquePlayerChars?: string[];
    uniqueOppChars?: string[];
    uniqueOppCodes?: string[];
    allowNoResult?: boolean;
    codeListId?: string;
  } = $props();

  function gc(letter: string | null): string {
    return gradeColor(letter as any);
  }

  let resultOptions = $derived<[ResultFilter, string][]>(
    allowNoResult
      ? [["all", "All"], ["win", "W"], ["loss", "L"], ["none", "—"]]
      : [["all", "All"], ["win", "W"], ["loss", "L"]]
  );

  let anyFilterActive = $derived(
    filterLetter !== null ||
    filterResult !== "all" ||
    filterPlayerChar !== null ||
    filterOppChar !== null ||
    filterOppCode.trim() !== ""
  );

  function clearAll() {
    filterLetter = null;
    filterResult = "all";
    filterPlayerChar = null;
    filterOppChar = null;
    filterOppCode = "";
  }

  function resultBg(val: ResultFilter): string {
    if (filterResult !== val) return "transparent";
    if (val === "win") return "#2ecc7133";
    if (val === "loss") return "#e74c3c33";
    return "#7c3aed22";
  }

  function resultFg(val: ResultFilter): string {
    if (filterResult !== val) return "var(--muted)";
    if (val === "win") return "#2ecc71";
    if (val === "loss") return "#e74c3c";
    return "#7c3aed";
  }
</script>

<div class="card" style="padding: 12px 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap">

  <!-- Grade filter group -->
  <div>
    <div style="font-size: 10px; font-weight: 700; color: var(--muted); letter-spacing: 0.07em; margin-bottom: 6px">GRADE</div>
    <div style="display: flex; gap: 3px">
      <button
        type="button"
        onclick={() => (filterLetter = null)}
        style="
          padding: 4px 10px; font-size: 12px; font-weight: 700; border-radius: 4px;
          border: 1px solid {filterLetter === null ? '#7c3aed' : 'var(--border)'};
          background: {filterLetter === null ? '#7c3aed22' : 'transparent'};
          color: {filterLetter === null ? '#7c3aed' : 'var(--muted)'};
          cursor: pointer;
        "
      >ALL</button>
      {#each ["S", "A", "B", "C", "D", "F"] as letter}
        <button
          type="button"
          onclick={() => (filterLetter = filterLetter === letter ? null : letter)}
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
      {#each resultOptions as [val, label]}
        <button
          type="button"
          title={val === "none" ? "No result (quit-out)" : undefined}
          onclick={() => (filterResult = val)}
          style="
            padding: 4px 12px; font-size: 12px; font-weight: 700; border: none;
            background: {resultBg(val)};
            color: {resultFg(val)};
            cursor: pointer; font-family: inherit;
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

  <!-- Opponent connect-code search -->
  <div style="width: 1px; height: 36px; background: var(--border); flex-shrink: 0"></div>
  <div>
    <div style="font-size: 10px; font-weight: 700; color: var(--muted); letter-spacing: 0.07em; margin-bottom: 6px">OPPONENT CODE</div>
    <input
      type="text"
      list={codeListId}
      bind:value={filterOppCode}
      placeholder="e.g. JOEY#870"
      spellcheck="false"
      autocomplete="off"
      style="
        font-size: 12px; font-weight: 600; width: 130px; box-sizing: border-box;
        background: var(--bg); color: {filterOppCode ? 'var(--text)' : 'var(--muted)'};
        border: 1px solid {filterOppCode ? '#7c3aed' : 'var(--border)'}; border-radius: 4px;
        padding: 4px 8px; font-family: inherit;
      "
    />
    <datalist id={codeListId}>
      {#each uniqueOppCodes as code}<option value={code}></option>{/each}
    </datalist>
  </div>

  <!-- Sort + clear — pushed right -->
  <div style="margin-left: auto; display: flex; align-items: flex-end; gap: 10px">
    {#if anyFilterActive}
      <button
        type="button"
        onclick={clearAll}
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
