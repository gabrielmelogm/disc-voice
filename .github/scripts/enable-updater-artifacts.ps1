# Release builds also output the self-update signature (.exe.sig,
# .AppImage.sig), made with the TAURI_SIGNING_PRIVATE_KEY secret. Local builds
# leave it off, so they do not need the private key.
# Usage (CI): ./.github/scripts/enable-updater-artifacts.ps1
$path = 'apps/desktop/src-tauri/tauri.conf.json'
$conf = Get-Content $path -Raw | ConvertFrom-Json
$conf.bundle | Add-Member -NotePropertyName createUpdaterArtifacts -NotePropertyValue $true -Force
$conf | ConvertTo-Json -Depth 32 | Set-Content $path -Encoding utf8
