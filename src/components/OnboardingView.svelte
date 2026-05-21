<script lang="ts">
  import { connectCode, replayDirs, games } from "../lib/store";

  const steps = [
    {
      num: 1,
      title: "Add your connect code",
      desc: "Open the sidebar and enter your Slippi connect code (e.g. NAME#123) under Connect Codes.",
      done: () => !!$connectCode,
    },
    {
      num: 2,
      title: "Add your replay folder",
      desc: "Point the app at the folder where Slippi saves your replays. On most systems this is ~/Documents/Slippi.",
      done: () => $replayDirs.length > 0,
    },
    {
      num: 3,
      title: "Scan replays",
      desc: "Click Scan Replays in the sidebar. The app will parse your .slp files and populate all the stats tabs.",
      done: () => $games.length > 0,
    },
  ];

  const nextStep = $derived(steps.findIndex(s => !s.done()) + 1);
</script>

<div style="
  max-width: 560px; margin: 48px auto; padding: 0 16px;
  display: flex; flex-direction: column; gap: 32px;
">

  <!-- Header -->
  <div style="text-align: center">
    <div style="font-size: 26px; font-weight: 800; letter-spacing: -0.01em; margin-bottom: 8px">
      Welcome to Slippi Ranked Stats
    </div>
    <div style="font-size: 14px; color: var(--muted); line-height: 1.6; max-width: 420px; margin: 0 auto">
      Track your ranked performance, review session history, analyze matchup stats,
      and get per-set grades powered by real-game baselines.
    </div>
  </div>

  <!-- Setup steps -->
  <div class="card" style="padding: 24px; display: flex; flex-direction: column; gap: 0">
    <div style="font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 16px">
      Get Started — 3 Steps
    </div>

    {#each steps as step, i}
      {@const done = step.done()}
      {@const active = !done && step.num === nextStep}
      <div style="
        display: flex; align-items: flex-start; gap: 14px;
        padding: {i === 0 ? '0 0 18px' : i === steps.length - 1 ? '18px 0 0' : '18px 0'};
        {i < steps.length - 1 ? 'border-bottom: 1px solid var(--border);' : ''}
        opacity: {done ? 0.5 : 1};
      ">
        <!-- Step badge -->
        <div style="
          min-width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
          font-size: {done ? '15px' : '12px'}; font-weight: 700;
          background: {done ? '#2ecc7122' : active ? 'var(--card)' : 'var(--bg)'};
          border: 2px solid {done ? '#2ecc71' : active ? 'var(--text)' : 'var(--border)'};
          color: {done ? '#2ecc71' : active ? 'var(--text)' : 'var(--muted)'};
          margin-top: 1px;
        ">
          {done ? '✓' : step.num}
        </div>

        <!-- Text -->
        <div>
          <div style="font-size: 14px; font-weight: {active ? 700 : 600}; margin-bottom: 3px">
            {step.title}
          </div>
          <div style="font-size: 12px; color: var(--muted); line-height: 1.5">
            {step.desc}
          </div>
        </div>
      </div>
    {/each}
  </div>

  <!-- Feature highlights -->
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
    {#each [
      { icon: "⚡", title: "Live Session Tracking", desc: "Enable the watcher in the sidebar to track your rating delta and set results in real time as you play." },
      { icon: "📝", title: "Set Grades (Premium)", desc: "After each set, get an overall letter grade plus per-category scores across Neutral, Punish, and Defense." },
      { icon: "🎮", title: "Matchup Stats", desc: "Win rates, opponent history, and per-character breakdowns across all your ranked sets." },
      { icon: "📊", title: "All-Time Stats", desc: "Lifetime record, peak rating, stage win rates, and character usage at a glance." },
    ] as f}
      <div class="card" style="padding: 14px 16px">
        <div style="font-size: 18px; margin-bottom: 6px">{f.icon}</div>
        <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px">{f.title}</div>
        <div style="font-size: 11px; color: var(--muted); line-height: 1.5">{f.desc}</div>
      </div>
    {/each}
  </div>

</div>
