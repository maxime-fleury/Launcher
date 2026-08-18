# Creates a "Bun Launcher" shortcut on the desktop that launches the app
# directly with the bundled Electron binary (no terminal window).
# Re-run this if you move the folder.
$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $PSScriptRoot          # D:\Launcher
$electron = Join-Path $appDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) {
    Write-Error "Electron binary not found at $electron - run 'npm install' in $appDir first."
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Bun Launcher.lnk"

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($shortcutPath)
$s.TargetPath = $electron
$s.Arguments = '"' + $appDir + '"'
$s.WorkingDirectory = $appDir
$s.IconLocation = "$electron,0"
$s.Description = "Bun Launcher - scan and start bun projects with one click"
$s.Save()

Write-Host "Created $shortcutPath"
