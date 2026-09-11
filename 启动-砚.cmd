@echo off
rem ============================================================
rem  Yan launcher - double-click this file to start.
rem
rem  IMPORTANT: keep this file PURE ASCII.
rem  cmd.exe reads .cmd files using the system OEM code page (GBK on
rem  Chinese Windows). Non-ASCII bytes here break line parsing before
rem  `chcp` even runs (verified: the whole file failed to execute).
rem  So: ASCII body + `chcp 65001` + all Chinese text printed by node.
rem ============================================================
chcp 65001 >nul
title Yan
cd /d "%~dp0"

node "scripts\launch.mjs"
if errorlevel 1 (
  echo.
  echo   Startup failed. Press any key to close.
  pause >nul
)
exit
