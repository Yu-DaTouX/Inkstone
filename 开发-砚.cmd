@echo off
rem ============================================================
rem  Yan - development mode (HMR).
rem    src/renderer/**  -> live reload, no restart
rem    src/main/**      -> NOT watched in dev mode; restart to apply
rem  Keep this window open; closing it quits the app.
rem  ASCII-only on purpose - see the other .cmd for why.
rem ============================================================
chcp 65001 >nul
title Yan (dev)
cd /d "%~dp0"

echo.
echo   Yan . dev mode (HMR)
echo   ----------------------------------------
echo   renderer changes apply live; closing this window quits.
echo.
node "scripts\launch.mjs" --dev
exit
