<script lang="ts">
  // Getting Premium with a card, inline: "Get Premium" → email → 6-digit code → Stripe Checkout.
  // "Already subscribed? Sign in" is the same without the Checkout at the end. Used on the
  // locked Premium screens and in the sidebar; the sidebar's account block (CardAccountPanel)
  // covers a subscriber who's already in. Plan: docs/plans/direct-billing.md (slice 7).
  import {
    cardAccount,
    startSignIn,
    confirmCode,
    subscribe,
    manageSubscription,
    signOut,
    SignInError,
    type SignInFailure,
  } from "../lib/card-premium";

  let { compact = false }: { compact?: boolean } = $props();

  const MESSAGES: Record<SignInFailure, string> = {
    bad_email: "That doesn't look like an email address.",
    wrong_code: "That code isn't right.",
    code_expired: "That code has expired. Send a new one.",
    rate_limited: "Too many codes sent. Try again in an hour.",
    email_failed: "Couldn't send the email. Try again in a minute.",
    storage: "Couldn't save your sign-in on this computer. Restarting the app may fix it.",
    unreachable: "Couldn't reach the server. Check your connection and try again.",
  };

  /** What the person set out to do: subscribe (Checkout follows the code) or just sign in. */
  let intent = $state<"subscribe" | "signin" | null>(null);
  let email = $state("");
  let code = $state("");
  let busy = $state(false);
  let error = $state("");

  // Someone the server asked to sign in again starts at the email step, address filled in.
  $effect(() => {
    if ($cardAccount.kind === "sign_in_again" && !intent) {
      intent = "signin";
      email = $cardAccount.email;
    }
  });

  async function run(step: () => Promise<void>) {
    busy = true;
    error = "";
    try {
      await step();
    } catch (e) {
      error = MESSAGES[e instanceof SignInError ? e.reason : "unreachable"];
    } finally {
      busy = false;
    }
  }

  const begin = (what: "subscribe" | "signin") => {
    intent = what;
    error = "";
    // Signed out by another computer: they're a subscriber, so start with the address they used.
    if (what === "signin" && $cardAccount.kind === "replaced" && $cardAccount.email && !email) {
      email = $cardAccount.email;
    }
  };
  const sendCode = () => email.trim() && run(() => startSignIn(email));
  const submitCode = () =>
    code.trim() &&
    run(async () => {
      await confirmCode(code);
      code = "";
      // Signed in. Someone who came to subscribe goes straight on to Checkout, unless the
      // account turns out to be paid up already (Premium switched on) or has a declined card
      // (the panel then offers "Update card" instead).
      const acct = $cardAccount;
      if (intent === "subscribe" && acct.kind === "signed_in" && !acct.paymentFailed) await subscribe();
      intent = null;
    });
  const startOver = () => run(signOut);

  const size = compact ? "font-size:12px" : "font-size:14px";
</script>

{#if $cardAccount.kind === "loading" || $cardAccount.kind === "premium"}
  <!-- nothing: still reading account.db, or already Premium (the sidebar block shows that) -->
{:else if $cardAccount.kind === "code_sent"}
  <div class="card-flow">
    <div class="note">Enter the code we sent to <b>{$cardAccount.email}</b></div>
    <input
      type="text"
      inputmode="numeric"
      autocomplete="one-time-code"
      maxlength={6}
      placeholder="123456"
      bind:value={code}
      onkeydown={(e) => { if (e.key === "Enter") submitCode(); }}
      class="code"
    />
    <button class="btn btn-primary wide" style={size} disabled={busy} onclick={submitCode}>
      {busy ? "Checking…" : "Continue"}
    </button>
    <button class="link" disabled={busy} onclick={startOver}>Use a different email</button>
  </div>
{:else if $cardAccount.kind === "signed_in"}
  <div class="card-flow">
    {#if $cardAccount.awaitingPayment}
      <div class="note">Finish up in your browser. Premium turns on here by itself.</div>
    {:else if $cardAccount.paymentFailed}
      <div class="note warn">Your last payment didn't go through.</div>
      <button class="btn btn-primary wide" style={size} disabled={busy} onclick={() => run(manageSubscription)}>
        Update card
      </button>
    {:else}
      <button class="btn btn-primary wide" style={size} disabled={busy} onclick={() => run(subscribe)}>
        {busy ? "Opening checkout…" : "Get Premium · $5/month"}
      </button>
    {/if}
    <div class="note small">Signed in as {$cardAccount.email} · <button class="link inline" disabled={busy} onclick={startOver}>Sign out</button></div>
  </div>
{:else if intent}
  <div class="card-flow">
    {#if $cardAccount.kind === "sign_in_again"}
      <div class="note">
        Please sign in again.{#if $cardAccount.premium} Premium stays on in the meantime.{/if}
      </div>
    {:else}
      <div class="note">
        {intent === "subscribe" ? "Enter your email. We'll send a code to sign in, then you'll pay on Stripe." : "Enter the email you subscribed with. We'll send you a code."}
      </div>
    {/if}
    <input
      type="email"
      placeholder="you@example.com"
      bind:value={email}
      onkeydown={(e) => { if (e.key === "Enter") sendCode(); }}
      class="email"
    />
    <button class="btn btn-primary wide" style={size} disabled={busy} onclick={sendCode}>
      {busy ? "Sending…" : "Email me a code"}
    </button>
    {#if $cardAccount.kind !== "sign_in_again"}
      <button class="link" disabled={busy} onclick={() => (intent = null)}>Cancel</button>
    {/if}
  </div>
{:else}
  <div class="card-flow">
    {#if $cardAccount.kind === "replaced"}
      <!-- Already a subscriber, signed out by a sign-in elsewhere: signing back in is the action. -->
      <div class="note">Signed in on another computer. Sign in again to use Premium here.</div>
      <button class="btn btn-primary wide" style={size} onclick={() => begin("signin")}>Sign in again</button>
    {:else}
      <button class="btn btn-primary wide" style={size} onclick={() => begin("subscribe")}>Get Premium · $5/month</button>
      <button class="link" onclick={() => begin("signin")}>Already subscribed? Sign in</button>
    {/if}
  </div>
{/if}

{#if error}
  <div class="err">{error}</div>
{/if}

<style>
  .card-flow { display: flex; flex-direction: column; align-items: stretch; gap: 8px; width: 100%; }
  .wide { width: 100%; padding: 9px 14px; font-weight: 700; }
  .note { font-size: 12px; color: var(--muted); line-height: 1.45; overflow-wrap: anywhere; text-align: center; }
  .note.small { font-size: 11px; }
  .note.warn { color: #e74c3c; font-weight: 600; }
  .email, .code { width: 100%; font-size: 13px; }
  .code { letter-spacing: 0.25em; text-align: center; }
  .link {
    background: none; border: none; padding: 0; color: var(--muted); cursor: pointer;
    font-size: 11px; text-decoration: underline; text-underline-offset: 2px; font-family: inherit;
  }
  .link.inline { font-size: inherit; }
  .err { font-size: 11px; color: #e74c3c; margin-top: 6px; line-height: 1.4; text-align: center; }
</style>
