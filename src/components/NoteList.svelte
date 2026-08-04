<script lang="ts">
  // One note = one bullet. Rendered the same everywhere (live session card, Notes tab) so a
  // note behaves identically wherever you happen to be looking at it.
  import type { NoteRow } from "../lib/db";
  import { editNote, toggleNotePin, removeNote } from "../lib/notes";

  let {
    notes = [],
    emptyText = "",
  }: { notes: NoteRow[]; emptyText?: string } = $props();

  let editingId = $state<number | null>(null);
  let draft = $state("");
  // Deleting is one click, so it gets a confirm step rather than a modal: the ✕ turns into
  // "Delete?" and only the second click commits. Mis-clicking away from a note you wrote
  // three weeks ago and losing it is not recoverable — there's no undo here.
  let confirmingId = $state<number | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  function startEdit(n: NoteRow) {
    editingId = n.id;
    draft = n.body;
    clearConfirm();
  }

  function cancelEdit() {
    editingId = null;
    draft = "";
  }

  async function commitEdit() {
    if (editingId === null) return;
    const id = editingId;
    const body = draft;
    cancelEdit();
    // An emptied note is a deleted note (see editNote) — clearing the box is the fastest way
    // to get rid of one you've stopped believing.
    await editNote(id, body);
  }

  function onEditKey(e: KeyboardEvent) {
    // Enter saves, Shift+Enter breaks a line. Notes are one-liners the overwhelming majority
    // of the time, and the whole point is being able to jot one between games.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }

  function clearConfirm() {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    confirmingId = null;
  }

  function askDelete(id: number) {
    if (confirmingId === id) {
      clearConfirm();
      removeNote(id);
      return;
    }
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmingId = id;
    // Auto-disarm, so a half-pressed delete doesn't sit there waiting to catch a later click.
    confirmTimer = setTimeout(() => (confirmingId = null), 4000);
  }
</script>

{#if notes.length === 0}
  {#if emptyText}
    <div class="empty">{emptyText}</div>
  {/if}
{:else}
  <ul class="notes">
    {#each notes as n (n.id)}
      <li class="note" class:pinned={n.pinned === 1}>
        {#if editingId === n.id}
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            class="edit"
            bind:value={draft}
            onkeydown={onEditKey}
            onblur={commitEdit}
            autofocus
            rows="2"
          ></textarea>
        {:else}
          <span class="bullet" aria-hidden="true">{n.pinned ? "★" : "•"}</span>
          <button class="body" type="button" onclick={() => startEdit(n)} title="Click to edit">
            {n.body}
          </button>
          <span class="tools">
            <button
              type="button"
              class="tool"
              onclick={() => toggleNotePin(n.id)}
              title={n.pinned ? "Unpin" : "Pin to the top"}
              aria-pressed={n.pinned === 1}
            >{n.pinned ? "★" : "☆"}</button>
            <button
              type="button"
              class="tool"
              class:danger={confirmingId === n.id}
              onclick={() => askDelete(n.id)}
              title={confirmingId === n.id ? "Click again to delete" : "Delete note"}
            >{confirmingId === n.id ? "Delete?" : "✕"}</button>
          </span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .notes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .note {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 3px 6px;
    border-radius: 5px;
    border-left: 2px solid transparent;
  }

  .note:hover {
    background: rgba(255, 255, 255, 0.035);
  }

  .note.pinned {
    border-left-color: #f39c12;
  }

  .bullet {
    flex-shrink: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
    width: 10px;
    text-align: center;
  }

  .note.pinned .bullet {
    color: #f39c12;
  }

  /* A button, not a div: clicking a note is what edits it, so it has to be reachable by
     keyboard and announced as an action. Styled back down to plain text. */
  .body {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text);
    cursor: text;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* The row's controls stay out of the way until you're actually on the row — a scouting
     list you're reading mid-set shouldn't be a wall of icons. Focus reveals them too, so
     they aren't keyboard-only-invisible. */
  .tools {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .note:hover .tools,
  .note:focus-within .tools {
    opacity: 1;
  }

  .tool {
    background: none;
    border: none;
    padding: 0 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
    border-radius: 4px;
  }

  .tool:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.07);
  }

  .tool.danger {
    color: var(--loss);
    opacity: 1;
    font-weight: 700;
  }

  .edit {
    flex: 1;
    min-width: 0;
    resize: vertical;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 5px;
    padding: 5px 7px;
  }

  .edit:focus {
    outline: none;
  }

  .empty {
    font-size: 12px;
    color: var(--muted);
    padding: 2px 6px;
  }
</style>
