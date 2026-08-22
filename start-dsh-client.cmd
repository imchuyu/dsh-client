@echo off
REM start-dsh-client.cmd — convenience launcher that shows a brief console.
REM For the preferred no-terminal experience, use start-dsh-client.vbs instead.
setlocal
set "APPDIR=%~dp0"
set "ELECTRON=%APPDIR%node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [dsh-client] Electron runtime not found at: %ELECTRON%
  echo [dsh-client] Run: npm install  (in this folder)
  pause
  exit /b 1
)
start "" "%ELECTRON%" "%APPDIR%"
endlocal
