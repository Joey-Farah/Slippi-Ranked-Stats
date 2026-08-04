<script lang="ts">
  // Scouting notes for whoever is in front of you right now, on the Live Session tab.
  //
  // This is the whole point of the feature: the opponent is detected at game *start* (the .slp
  // header peek — see watcher.ts), so by the time the match loads, everything you've previously
  // written about this person and about this matchup is already on screen.
  //
  // ⚠ Deliberately NOT mirrored onto the OBS overlay. This is a scouting report on the person
  // you're playing; putting it on stream hands it to them.
  import { liveNotes, addOpponentNote, addMatchupNote, matchupTitle } from "../lib/notes";
  import NoteList from "./NoteList.svelte";
  import NoteComposer from "./NoteComposer.svelte";

  // Which subject the composer writes to. Defaults to the player: a note you jot mid-set is
  // almost always about the person ("he always techs in place"), and matchup notes tend to be
  // written deliberately afterwards.
  let target = $state<"opponent" | "matchup">("opponent");

  let ctx = $derived($liveNotes.context);
  let oppNotes = $derived($liveNotes.opponent);
  let muNotes = $derived($liveNotes.matchup);
  let total = $derived(oppNotes.length + muNotes.length);

  // Characters come from the replay header, but a game can start before that read lands (and a
  // recovered session has no header at all), so the matchup half has to tolerate not knowing.
  let matchupKnown = $derived(!!ctx && !!ctx.opponentChar && !!ctx.playerChar);
  let who = $derived(ctx ? ctx.tag || ctx.opponentCode : "this player");

  // Fall back to the player when the matchup isn't identifiable, rather than leaving the
  // composer pointed at a target it can't write.
  let effectiveTarget = $derived(target === "matchup" && matchupKnown ? "matchup" : "opponent");

  async function add(body: string) {
    if (!ctx) return;
    if (effectiveTarget === "matchup") {
      await addMatchupNote(ctx.playerChar, ctx.opponentChar, body);
    } else {
      await addOpponentNote(ctx.opponentCode, ctx.tag, body);
    }
  }
</script>

{#if ctx}
  <div class="card notes-card">
    <div class="head">
      <div class="title">
        <span aria-hidden="true">🗒️</span>
        Scouting Notes
        {#if !ctx.live}
          <!-- The set is over and NOW PLAYING is gone, so say whose notes these still are. -->
          <span class="past">last opponent</span>
        {/if}
        {#if total > 0}
          <span class="count">{total}</span>
        {/if}
      </div>
      <!-- Where the composer writes. Shown even with no notes yet, so the choice is visible
           before you start typing rather than after. -->
      <div class="targets" role="group" aria-label="Note subject">
        <button
          type="button"
          class="target"
          class:on={effectiveTarget === "opponent"}
          onclick={() => (target = "opponent")}
        >This player</button>
        <button
          type="button"
          class="target"
          class:on={effectiveTarget === "matchup"}
          disabled={!matchupKnown}
          title={matchupKnown ? "" : "Waiting on both characters"}
          onclick={() => (target = "matchup")}
        >This matchup</button>
      </div>
    </div>

    <div class="lists">
      <section>
        <div class="subject">
          {#if ctx.tag}
            {ctx.tag}<span class="sub-code">{ctx.opponentCode}</span>
          {:else}
            {ctx.opponentCode}
          {/if}
        </div>
        <NoteList notes={oppNotes} emptyText="Nothing written about them yet." />
      </section>

      {#if matchupKnown}
        <section>
          <div class="subject">{matchupTitle(ctx.playerChar, ctx.opponentChar)}</div>
          <NoteList notes={muNotes} emptyText="No notes on this matchup yet." />
        </section>
      {/if}
    </div>

    <div class="compose">
      <NoteComposer
        placeholder={effectiveTarget === "matchup"
          ? `Add a note on ${matchupTitle(ctx.playerChar, ctx.opponentChar)}…`
          : `Add a note on ${who}…`}
        onsubmit={add}
      />
    </div>
  </div>
{/if}

<style>
  .notes-card {
    margin-bottom: 16px;
    border-left: 3px solid #f39c12;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #f39c12;
  }

  .past {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
  }

  .count {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 6px;
  }

  .targets {
    display: flex;
    gap: 4px;
  }

  .target {
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    font-weight: 700;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--muted);
  }

  .target.on {
    border-color: #f39c1255;
    background: #f39c1222;
    color: #f39c12;
  }

  .target:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Capped so a long history of notes on a regular opponent can't push the live game stats
     off the bottom of the tab. Same viewport-relative approach as the per-game list. */
  .lists {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: clamp(120px, 34vh, 420px);
    overflow-y: auto;
  }

  .subject {
    display: flex;
    align-items: baseline;
    gap: 7px;
    font-size: 11px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 3px;
    padding: 0 6px;
  }

  .sub-code {
    font-size: 10px;
    font-weight: 400;
    color: var(--muted);
  }

  .compose {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
</style>
