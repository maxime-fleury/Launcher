' Bun Launcher - hidden double-click launcher (no console window flash).
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("Wscript.Shell")
sh.Run """" & folder & "\launcher.cmd""", 0, False
