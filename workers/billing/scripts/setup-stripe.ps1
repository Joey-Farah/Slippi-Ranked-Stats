# Connects a billing worker to Stripe in one step, without any secret being printed or saved
# to disk:
#   1. reads the Stripe secret key from the clipboard,
#   2. creates the webhook endpoint in Stripe (customer.subscription.* -> the worker),
#   3. stores the key and the endpoint's signing secret as the worker's secrets.
#
# Run it, then copy the secret key in the Stripe dashboard (Developers -> API keys); it waits
# for the key to appear on the clipboard:
#   powershell -NoProfile -File workers\billing\scripts\setup-stripe.ps1             # staging, test key
#   powershell -NoProfile -File workers\billing\scripts\setup-stripe.ps1 -Production # slice 8, live key
#
# Stripe only reveals a signing secret when the endpoint is created, so if an endpoint for the
# worker already exists, pass -Replace to delete it and make a new one.

param(
  [switch]$Production,
  [switch]$Replace
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
# ⚠ Windows PowerShell prepends a byte-order mark to text piped into a program, so the secret
# wrangler stored started with U+FEFF. Stripe rejected that key, and the Workers runtime then
# logged the whole Authorization header, key included. BOTH settings are needed: with only
# $OutputEncoding the BOM still appears (it comes from the console input encoding). Verified by
# piping into a program that prints the first bytes. The worker also strips a BOM
# (secret() in src/http.ts) in case a secret arrives some other way.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

if ($Production) {
  $workerUrl = "https://srs-billing.joeyfarah.workers.dev"
  $envArgs = @()
  $keyPrefix = "sk_live_"
} else {
  $workerUrl = "https://srs-billing-staging.joeyfarah.workers.dev"
  $envArgs = @("--env", "staging")
  $keyPrefix = "sk_test_"
}
$webhookUrl = "$workerUrl/stripe/webhook"

# Copying the command to run this would overwrite a key already on the clipboard, so it's fine
# to start this first and copy the key afterwards: it waits up to 3 minutes for one to appear.
$key = $null
$deadline = (Get-Date).AddMinutes(3)
$asked = $false
while ((Get-Date) -lt $deadline) {
  $clip = Get-Clipboard -Raw
  if ($clip -and $clip.Trim().StartsWith($keyPrefix)) { $key = $clip.Trim(); break }
  if (-not $asked) {
    Write-Host "Waiting for you to copy the $keyPrefix... secret key in Stripe (Developers -> API keys)..."
    $asked = $true
  }
  Start-Sleep -Milliseconds 500
}
if (-not $key) {
  Write-Host "No $keyPrefix... key showed up on the clipboard within 3 minutes. Nothing was changed." -ForegroundColor Red
  exit 1
}
Write-Host "Got the $keyPrefix key from the clipboard (not shown)."

$headers = @{ Authorization = "Bearer $key"; "Stripe-Version" = "2025-03-31.basil" }
$api = "https://api.stripe.com/v1/webhook_endpoints"

$existing = (Invoke-RestMethod -Uri "$($api)?limit=100" -Headers $headers).data | Where-Object { $_.url -eq $webhookUrl }
if ($existing) {
  if (-not $Replace) {
    Write-Host "Stripe already has a webhook for $webhookUrl ($($existing[0].id)). Its signing secret can't be read back; run again with -Replace to delete it and create a new one." -ForegroundColor Yellow
    exit 1
  }
  foreach ($e in $existing) {
    Invoke-RestMethod -Method Delete -Uri "$api/$($e.id)" -Headers $headers | Out-Null
    Write-Host "Deleted the old webhook $($e.id)."
  }
}

$events = @(
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed"
)
$body = "url=" + [uri]::EscapeDataString($webhookUrl) + "&api_version=2025-03-31.basil" +
  "&description=" + [uri]::EscapeDataString("Slippi Ranked Stats billing worker")
for ($i = 0; $i -lt $events.Count; $i++) { $body += "&enabled_events[$i]=" + $events[$i] }
$endpoint = Invoke-RestMethod -Method Post -Uri $api -Headers $headers -Body $body -ContentType "application/x-www-form-urlencoded"
Write-Host "Created webhook $($endpoint.id) -> $webhookUrl"

$endpoint.secret | npx wrangler secret put STRIPE_WEBHOOK_SECRET @envArgs
if ($LASTEXITCODE -ne 0) { throw "Saving STRIPE_WEBHOOK_SECRET failed." }
$key | npx wrangler secret put STRIPE_SECRET_KEY @envArgs
if ($LASTEXITCODE -ne 0) { throw "Saving STRIPE_SECRET_KEY failed." }

Set-Clipboard -Value " "
Write-Host "Done. Both secrets are on the worker, and the clipboard has been cleared." -ForegroundColor Green
