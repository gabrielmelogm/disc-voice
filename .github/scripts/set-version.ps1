# The installers carry the release version: tag v1.2.3 -> 1.2.3.
# Usage (CI): TAG=v1.2.3 ./.github/scripts/set-version.ps1
$version = $env:TAG -replace '^v', ''
if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "Release tag '$env:TAG' is not a semver version (e.g. v1.2.3)."
}
$path = 'apps/desktop/src-tauri/tauri.conf.json'
$conf = Get-Content $path -Raw | ConvertFrom-Json
$conf.version = $version
$conf | ConvertTo-Json -Depth 32 | Set-Content $path -Encoding utf8
