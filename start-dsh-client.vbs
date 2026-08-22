' start-dsh-client.vbs — double-click entry point for the DSH client.
'
' Runs the Electron app with NO console window (VBS started via wscript is
' inherently windowless). This satisfies requirement 1 (double-click launch)
' and 2 (no terminal). Quitting the Electron app (via tray "退出" or closing
' the window) tears down the supervised dsh server (requirements 5 & 6).
'
' The Electron binary is launched directly from node_modules so no global
' electron install is needed; only the dsh global npm package is required.

Set sh = CreateObject("WScript.Shell")
appDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
electronExe = appDir & "\node_modules\electron\dist\electron.exe"

If Not CreateObject("Scripting.FileSystemObject").FileExists(electronExe) Then
    MsgBox "未找到 Electron 运行时：" & vbCrLf & electronExe & vbCrLf & vbCrLf & _
           "请在 dsh-client 目录中运行：npm install", vbCritical, "DSH Client"
    WScript.Quit 1
End If

' 0 = hidden window (we launch electron.exe directly; it has no console anyway,
' but setting window style 0 is belt-and-suspenders). Run the app detached so
' this wscript process can exit immediately without holding a parent handle.
sh.Run """" & electronExe & """ """ & appDir & """", 0, False
