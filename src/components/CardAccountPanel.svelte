<script lang="ts">
  // The sidebar's card-subscription block (slice 7 of docs/plans/direct-billing.md), next to the
  // Discord one. A subscriber sees who they're signed in as, Manage (Stripe's portal: cancel,
  // change card) and Sign out. Someone without Premium gets the same inline "Get Premium" flow as
  // the locked screens; a Discord patron who never used a card sees nothing here.
  import { cardAccount, manageSubscription, signOut, SignInError } from "../lib/card-premium";
  import { isPremium } from "../lib/store";
  import CardSignIn from "./CardSignIn.svelte";

  let busy = $state(false);
  let error = $state("");

  async function run(step: () => Promise<void>) {
    busy = true;
    error = "";
    try {
      await step();
    } catch (e) {
      error = e instanceof SignInError && e.reason !== "unreachable"
        ? "Something went wrong. Try again."
        : "Couldn't reach the server. Check your connection and try again.";
    } finally {
      busy = false;
    }
  }

  const subscriber = $derived(
    $cardAccount.kind === "premium" || ($cardAccount.kind === "sign_in_again" && $cardAccount.premium)
  );
</script>

{#if $cardAccount.kind === "loading"}
  <!-- reading account.db -->
{:else if subscriber}
  <div style="margin-top:10px">
    <div style="display:flex; align-items:center; gap:6px; font-size:12px; color:#2ecc71; font-weight:600; margin-bottom:2px">
      <span>✓</span><span>Premium · card</span>
    </div>
    <div style="font-size:11px; color:var(--muted); margin-bottom:8px; overflow-wrap:anywhere">
      {"email" in $cardAccount ? $cardAccount.email : ""}
    </div>
    {#if $cardAccount.kind === "sign_in_again"}
      <CardSignIn compact />
    {:else}
      <div style="display:flex; gap:6px">
        <button class="btn btn-secondary" style="flex:1; font-size:11px" disabled={busy}
          onclick={() => run(manageSubscription)}>Manage</button>
        <button class="btn btn-secondary" style="flex:1; font-size:11px" disabled={busy}
          onclick={() => run(signOut)}>Sign out</button>
      </div>
    {/if}
    {#if error}
      <div style="font-size:11px; color:#e74c3c; margin-top:6px; line-height:1.4">{error}</div>
    {/if}
  </div>
{:else if !$isPremium}
  <div style="margin-top:10px">
    <CardSignIn compact />
  </div>
{:else if $cardAccount.kind === "signed_in"}
  <!-- Premium through Discord, and also signed in to a card account that isn't paying. -->
  <div style="margin-top:10px; font-size:11px; color:var(--muted); overflow-wrap:anywhere">
    Card account: {$cardAccount.email} ·
    <button disabled={busy} onclick={() => run(signOut)}
      style="background:none;border:none;padding:0;color:var(--muted);font-size:inherit;cursor:pointer;text-decoration:underline;font-family:inherit">Sign out</button>
  </div>
{/if}
