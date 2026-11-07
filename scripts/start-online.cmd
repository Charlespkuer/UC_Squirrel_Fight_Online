@echo off
if exist "%~dp0..\squirrel_fight_online.exe" (
  start "" "%~dp0..\squirrel_fight_online.exe"
) else (
  echo Build the Online app first: scripts\build-online.cmd
  pause
)
