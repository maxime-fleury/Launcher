# Creates a "Rust Launcher" shortcut on the desktop that launches the app
# directly with the Rust release binary (no terminal window).
# Re-run this if you move the folder.
$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $PSScriptRoot          # D:\Launcher
$launcher = Join-Path $appDir "target\release\rust-launcher.exe"
if (-not (Test-Path $launcher)) {
    Write-Error "Rust launcher not found at $launcher - run 'cargo build --release' in $appDir first."
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Rust Launcher.lnk"

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($shortcutPath)
$s.TargetPath = $launcher
$s.WorkingDirectory = $appDir
$s.IconLocation = "$launcher,0"
$s.Description = "Rust Launcher - scan and start bun projects with one click"
$s.Save()

Write-Host "Created $shortcutPath"
