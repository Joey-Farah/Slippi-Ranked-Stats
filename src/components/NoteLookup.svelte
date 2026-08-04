<script lang="ts">
  // Look your notes up by name during stage striking.
  //
  // Slippi hands out no way to know who you matched with before game 1 starts: the .slp doesn't
  // exist until the game does (its Game Start block carries the stage, so it can't be written
  // until striking is over), Dolphin's matchmaking never logs *who* was found, and the spectator
  // protocol's first message is start_game. But their tag is on your screen for the whole
  // striking period — so the app doesn't need to detect them, it needs to make looking them up
  // take two seconds.
  //
  // Deliberately searches subject identity only — tags, connect codes, character names — and NOT
  // note bodies. This answers "who am I about to play"; typing "fox" should find the player
  // called Fox and your Fox matchups, not every note that happens to mention a shine.
  import { notes, groupNotes } from "../lib/notes";
  import NoteList from "./NoteList.svelte";

  // Two characters before anything shows: one letter matches most of the list and turns a
  // lookup into a dump.
  const MIN_QUERY = 2;
  const MAX_RESULTS = 8;

  let query = $state("");

  let results = $derived((() => {
    const q = query.trim().toLowerCase();
    if (q.length < MIN_QUERY) return [];
    return groupNotes($notes)
      .filter(
        (g) => g.title.toLowerCase().includes(q) || g.subtitle.toLowerCase().includes(q)
      )
      .slice(0, MAX_RESULTS);
  })());

  let searching = $derived(query.trim().length >= MIN_QUERY);
</script>

<div class="card lookup">
  <div class="head">
    <label class="title" for="srs-note-lookup">
      <span aria-hidden="true">🔎</span> Look up a player
    </label>
  </div>

  <!-- Says plainly why this box exists, so it doesn't look like a feature that should have been
       automatic. Verified empirically: Dolphin's live spectator stream sends nothing at all —
       not even a "match found" — between matchmaking and the first frame of game 1. -->
  <p class="why">
    Your opponent's notes come up <strong>automatically once game 1 starts</strong> — Slippi
    doesn't reveal who you're playing until the replay file exists. During stage striking, look
    them up here by connect code.
  </p>

  <div class="row">
    <input
      id="srs-note-lookup"
      bind:value={query}
      placeholder="Connect code (e.g. FOX#123), name, or character…"
      spellcheck="false"
      autocomplete="off"
    />
    {#if query}
      <button type="button" class="clear" onclick={() => (query = "")} title="Clear">✕</button>
    {/if}
  </div>

  {#if searching}
    {#if results.length === 0}
      <div class="none">No notes on anyone matching “{query.trim()}”.</div>
    {:else}
      <div class="results">
        {#each results as g (g.key)}
          <section class="group" class:matchup={g.kind === "matchup"}>
            <div class="group-head">
              <span class="group-title">{g.title}</span>
              {#if g.subtitle}<span class="group-sub">{g.subtitle}</span>{/if}
            </div>
            <NoteList notes={g.notes} />
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .lookup {
    margin-bottom: 16px;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    cursor: pointer;
  }

  .why {
    margin: 0 0 9px;
    font-size: 11px;
    line-height: 1.55;
    color: var(--muted);
  }

  .why strong {
    color: var(--text);
    font-weight: 600;
  }

  .row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  input {
    flex: 1;
    min-width: 0;
    font-family: inherit;
    font-size: 12.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
  }

  input:focus {
    outline: none;
    border-color: var(--accent);
  }

  input::placeholder {
    color: var(--muted);
  }

  .clear {
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    color: var(--muted);
  }

  .clear:hover {
    color: var(--text);
  }

  .none {
    font-size: 12px;
    color: var(--muted);
    margin-top: 9px;
  }

  /* Capped: a lookup shouldn't be able to push the live session off the screen. */
  .results {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 10px;
    max-height: clamp(140px, 40vh, 460px);
    overflow-y: auto;
  }

  .group {
    border: 1px solid var(--border);
    border-left: 3px solid #f39c12;
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--bg);
  }

  .group.matchup {
    border-left-color: var(--highlight);
  }

  .group-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }

  .group-title {
    font-size: 13px;
    font-weight: 700;
  }

  .group-sub {
    font-size: 11px;
    color: var(--muted);
  }
</style>
