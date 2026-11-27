# Publishes the self-update manifests the website's /api/update routes read
# (apps/website/src/lib/updates.ts): releases/channels/<channel>.json. Then
# asks the API to tell every open app (POST /api/releases/notify), which shows
# a discreet "update available" button; nothing is forced.
#
# A release goes to its own channel and to the less stable ones: a stable
# release reaches stable, beta and alpha; a beta (or rc) beta and alpha; an
# alpha only alpha. A channel that already offers a newer version keeps it.
#
# Env: TAG, PUB_DATE, RELEASES_BUCKET, INSTALLER_SIG, APPIMAGE_SIG, GH_TOKEN,
# GITHUB_REPOSITORY, RUNNER_TEMP, the AWS credentials, and API_URL plus
# RELEASE_NOTIFY_TOKEN for the announcement (skipped without the token).
$ErrorActionPreference = 'Stop'

$semver = '^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$'
# Same order as the "latest" decision in desktop.yml: a stable sorts after its
# prereleases, numbers are padded so alpha.10 > alpha.9.
function Get-VersionKey([string]$Version) {
  if ($Version -notmatch $semver) { return '' }
  $pre = if ($Matches[4]) { $Matches[4] -replace '\d+', { '{0:D6}' -f [int]$_.Value } } else { 'zzzzzz' }
  '{0:D6}.{1:D6}.{2:D6}-{3}' -f [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $pre
}

$version = $env:TAG -replace '^v', ''
if ($version -notmatch $semver) { throw "Release tag '$env:TAG' is not a semver version." }
$prerelease = $Matches[4]
$channels = if (-not $prerelease) { @('stable', 'beta', 'alpha') } elseif ($prerelease -match '^alpha') { @('alpha') } else { @('beta', 'alpha') }

# Release notes without the "Qual arquivo baixar?" section the workflow adds.
$body = gh release view $env:TAG --repo $env:GITHUB_REPOSITORY --json body -q .body
if ($LASTEXITCODE -ne 0) { throw 'Could not read the release.' }
$notes = ((($body -join "`n") -split [regex]::Escape('<!-- downloads -->'))[0]).Trim()

$platforms = [ordered]@{
  'windows-x86_64' = [ordered]@{ key = "releases/$env:TAG/DiscVoice-Setup.exe"; signature = (Get-Content $env:INSTALLER_SIG -Raw).Trim() }
  'linux-x86_64' = [ordered]@{ key = "releases/$env:TAG/DiscVoice_x86_64.AppImage"; signature = (Get-Content $env:APPIMAGE_SIG -Raw).Trim() }
}

$published = @()
foreach ($channel in $channels) {
  $object = "s3://$env:RELEASES_BUCKET/releases/channels/$channel.json"
  $previous = Join-Path $env:RUNNER_TEMP "$channel-previous.json"
  $existing = $null
  aws s3 cp $object $previous --only-show-errors 2>$null
  if ($LASTEXITCODE -eq 0) { $existing = Get-Content $previous -Raw | ConvertFrom-Json }

  if ($existing -and [string]::CompareOrdinal((Get-VersionKey $existing.version), (Get-VersionKey $version)) -gt 0) {
    "Channel ${channel}: keeps $($existing.version), newer than $version." >> $env:GITHUB_STEP_SUMMARY
    continue
  }

  $manifest = [ordered]@{ version = $version; notes = $notes; pub_date = $env:PUB_DATE; platforms = $platforms }
  $file = Join-Path $env:RUNNER_TEMP "$channel.json"
  [IO.File]::WriteAllText($file, ($manifest | ConvertTo-Json -Depth 8))
  aws s3 cp $file $object --content-type application/json --cache-control no-cache --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw "Upload of the $channel manifest failed." }
  "Channel ${channel}: now offers $version." >> $env:GITHUB_STEP_SUMMARY
  $published += $channel
}

if (-not $published) { return }
if (-not $env:RELEASE_NOTIFY_TOKEN) {
  Write-Host '::warning::RELEASE_NOTIFY_TOKEN is not set; open apps find the update at their next check.'
  return
}
# The website caches /api/update/latest for a minute; the apps wait a little
# after the announcement anyway. A failed announcement does not fail the
# release: the apps still find it at their next check.
try {
  $payload = @{ version = $version; channels = $published } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$env:API_URL/releases/notify" -ContentType 'application/json' -Body $payload `
    -Headers @{ Authorization = "Bearer $env:RELEASE_NOTIFY_TOKEN" } -TimeoutSec 30 | Out-Null
  "Open apps on $($published -join ', ') were told about $version." >> $env:GITHUB_STEP_SUMMARY
} catch {
  Write-Host "::warning::Could not announce the release to open apps: $($_.Exception.Message)"
}
