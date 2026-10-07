<script lang="ts">
  /**
   * Per-matchup averages table, shared by the Ranked and Unranked & Direct views.
   *
   * The two differ only in what a row counts — ranked averages SETS, unranked averages GAMES —
   * so the unit is a prop and the markup is not duplicated. The summary maths lives in
   * src/lib/matchup-summary.ts, which is pure and unit-tested.
   */
  import { gradeColor, formatStatValue, CATEGORY_DEFS, type CategoryKey } from "../lib/grading";
  import type { MatchupSummary } from "../lib/matchup-summary";

  let {
    summaries = [] as MatchupSummary[],
    /** Column header for the count: "SETS" for ranked, "GAMES" for unranked/direct. */
    unit = "SETS",
    emptyText = "Grade some sets first to see matchup averages.",
  }: {
    summaries?: MatchupSummary[];
    unit?: string;
    emptyText?: string;
  } = $props();

  const CATEGORY_ORDER: CategoryKey[] = ["neutral", "punish", "defense"];

  /** Which matchup is expanded. Local to the table, so the two views keep separate selections. */
  let openKey = $state<string | null>(null);

  function gc(letter: string | null): string {
    return gradeColor(letter as any);
  }
</script>

    {#if summaries.length === 0}
      <div style="text-align: center; padding: 48px 24px; color: var(--muted); font-size: 13px">
        {emptyText}
      </div>
    {:else}
      <div style="font-size: 11px; color: var(--muted); margin-bottom: 8px; display: flex; align-items: center; gap: 6px"><span style="color:#a78bfa; font-weight:700">▾</span>Click any matchup for its full stat breakdown</div>
      <div class="card" style="padding: 0; overflow: hidden">

        <!-- Column headers -->
        <div style="
          display: grid; grid-template-columns: 1fr 54px 72px 80px 48px 48px 48px 30px;
          gap: 8px; padding: 10px 16px;
          font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.06em;
          border-bottom: 1px solid var(--border);
        ">
          <div>MATCHUP</div>
          <div style="text-align: center">{unit}</div>
          <div>RECORD</div>
          <div style="text-align: center">GRADE</div>
          <div style="text-align: center">NEU</div>
          <div style="text-align: center">PUN</div>
          <div style="text-align: center">DEF</div>
          <div></div>
        </div>

        {#each summaries as m (m.key)}
          {@const isOpen = openKey === m.key}
          <div style="border-bottom: 1px solid var(--border)">
            <button
              type="button"
              onclick={() => { openKey = isOpen ? null : m.key; }}
              style="
                width: 100%; text-align: left; background: none; border: none;
                display: grid; grid-template-columns: 1fr 54px 72px 80px 48px 48px 48px 30px;
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
              <div style="
              display: flex; align-items: center; justify-content: center;
              width: 26px; height: 26px; margin-left: auto; border-radius: 50%;
              font-size: 15px; font-weight: 800; line-height: 1;
              background: {isOpen ? '#7c3aed' : '#7c3aed22'};
              color: {isOpen ? '#fff' : '#a78bfa'};
              transition: transform 0.15s, background 0.15s;
              transform: rotate({isOpen ? 180 : 0}deg);
            ">▾</div>
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
