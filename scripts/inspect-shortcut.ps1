$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Bun Launcher.lnk"))
Write-Host "Target : $($s.TargetPath)"
Write-Host "Args   : $($s.Arguments)"
Write-Host "WorkDir: $($s.WorkingDirectory)"
Write-Host "Icon   : $($s.IconLocation)"
