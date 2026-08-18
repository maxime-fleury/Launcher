@echo off
rem Bun Launcher - starts the app without needing npm or a terminal.
rem Changes to this folder and passes "." as the app path so the argument
rem never ends in a backslash (which breaks Windows command-line parsing).
cd /d "%~dp0"
start "" /d "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "."
