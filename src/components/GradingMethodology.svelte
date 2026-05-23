<script lang="ts">
  import {
    CATEGORY_DEFS, CATEGORY_WEIGHTS, STAT_WEIGHTS, STAT_DESCRIPTIONS,
    GRADE_COLORS, type CategoryKey, type SetGrade,
  } from "../lib/grading";

  const GRADE_THRESHOLDS = [
    { letter: "S", min: 75,  color: GRADE_COLORS.S },
    { letter: "A", min: 63,  color: GRADE_COLORS.A },
    { letter: "B", min: 52,  color: GRADE_COLORS.B },
    { letter: "C", min: 40,  color: GRADE_COLORS.C },
    { letter: "D", min: 28,  color: GRADE_COLORS.D },
    { letter: "F", min: 0,   color: GRADE_COLORS.F },
  ];

  const CATEGORY_ORDER: CategoryKey[] = ["neutral", "punish", "defense"];

  const STAT_LABELS: Record<string, string> = {
    neutral_win_ratio:       "Neutral Win Rate",
    opening_conversion_rate: "Opening Conv. %",
    stage_control_ratio:     "Stage Control %",
    lead_maintenance_rate:   "Lead Maintenance %",
    comeback_rate:           "Comeback Rate",
    damage_per_opening:      "Damage / Opening",
    openings_per_kill:       "Openings / Kill",
    avg_kill_percent:        "Avg Kill %",
    edgeguard_success_rate:  "Edgeguard %",
    tech_chase_rate:         "Tech Chase %",    avg_death_percent:       "Avg Death %",
    recovery_success_rate:   "Recovery %",
    avg_stock_duration:      "Avg Stock Duration",
    respawn_defense_rate:    "Respawn Defense %",
  };

  const INVERTED_LABELS: Set<string> = new Set(["openings_per_kill", "avg_kill_percent", "wavedash_miss_rate"]);
</script>

<div style="padding: 20px 0 4px">

  <!-- How scoring works -->
  <div style="margin-bottom: 20px">
    <div style="font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 10px">
      How Scores Are Calculated
    </div>
    <div class="card" style="padding: 14px 16px; font-size: 12px; color: var(--muted); line-height: 1.7">
      Each stat is compared against baselines derived from <strong style="color: var(--text)">200,000+ ranked Slippi replays</strong>.
      Your value is mapped to a percentile using p5–p95 thresholds, producing a score from 0–100.
      <br/>
      Category score = weighted average of its non-null scored stats.
      Overall score = <strong style="color: var(--text)">Neutral × 40% + Punish × 40% + Defense × 20%</strong>,
      plus a <strong style="color: var(--text)">+5 win bonus</strong> (capped at 100).
      <br/>
      When a matchup-specific baseline exists it is used; otherwise the character baseline, then an overall fallback.
    </div>
  </div>

  <!-- Grade thresholds -->
  <div style="margin-bottom: 20px">
    <div style="font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 10px">
      Grade Thresholds
    </div>
    <div style="display: flex; gap: 6px; flex-wrap: wrap">
      {#each GRADE_THRESHOLDS as t, i}
        {@const next = GRADE_THRESHOLDS[i + 1]}
        <div class="card" style="
          flex: 1; min-width: 72px; padding: 10px 12px; text-align: center;
          border-color: {t.color}44;
          background: {t.color}10;
        ">
          <div style="font-size: 22px; font-weight: 800; color: {t.color};
            {t.letter === 'S' ? `text-shadow: 0 0 8px ${t.color}aa;` : ''}
          ">{t.letter}</div>
          <div style="font-size: 11px; color: var(--muted); margin-top: 2px">
            {t.letter === "F" ? "< 28" : `≥ ${t.min}`}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Per-category stat breakdown -->
  {#each CATEGORY_ORDER as catKey}
    {@const def = CATEGORY_DEFS[catKey]}
    {@const catWeight = CATEGORY_WEIGHTS[catKey]}
    <div style="margin-bottom: 18px">
      <div style="
        font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.08em;
        text-transform: uppercase; margin-bottom: 10px;
        display: flex; align-items: center; gap: 8px;
      ">
        {def.label}
        <span style="
          font-size: 10px; font-weight: 700;
          background: #7c3aed22; border: 1px solid #7c3aed44;
          border-radius: 4px; padding: 1px 7px; color: #a78bfa;
          letter-spacing: 0;
        ">{(catWeight * 100).toFixed(0)}% of overall</span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 4px">
        {#each def.stats as statKey}
          {@const weight  = STAT_WEIGHTS[statKey as keyof SetGrade["breakdown"]] ?? null}
          {@const desc    = STAT_DESCRIPTIONS[statKey]}
          {@const label   = STAT_LABELS[statKey] ?? statKey}
          {@const inv     = INVERTED_LABELS.has(statKey)}
          <div class="card" style="padding: 10px 14px">
            <div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px">
              <div style="font-size: 13px; font-weight: 700">{label}</div>
              {#if weight !== null}
                <div style="font-size: 10px; color: var(--muted)">
                  {(weight * 100).toFixed(0)}% weight
                </div>
              {/if}
              {#if inv}
                <div style="font-size: 10px; color: var(--muted); margin-left: auto">lower = better</div>
              {/if}
            </div>
            {#if desc}
              <div style="font-size: 11px; color: var(--muted); line-height: 1.55">{desc}</div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/each}

</div>
