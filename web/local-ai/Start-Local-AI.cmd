@echo off
rem Video Editor - Local AI (helper of the web edition). Double-click to start; close this window to stop.
rem Runs local-ai.ps1 (next to this file) with Windows PowerShell for this one run only; no administrator rights.
setlocal
title Video Editor - Local AI
rem a PowerShell 7 terminal that started this file hands over module folders that Windows PowerShell cannot use
set "PSModulePath="
rem the Windows PowerShell of this computer by its full path (not whatever "powershell.exe" a folder or the PATH would offer first)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-ai.ps1" %*
set "code=%errorlevel%"
if not "%code%"=="0" (
  echo.
  echo The Local AI stopped with an error ^(code %code%^). Read the message above; README.txt has hints.
  pause
)
endlocal & exit /b %code%
