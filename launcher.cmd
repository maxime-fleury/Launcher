@echo off
rem Run the Rust launcher from this folder so it can find config.json.
cd /d "%~dp0"
if not exist "%~dp0target\release\rust-launcher.exe" (
  echo Build the launcher first with: cargo build --release
  pause
  exit /b 1
)
start "" /d "%~dp0" "%~dp0target\release\rust-launcher.exe"
