@echo off
node "%~dp0..\tools\build-online-app.cjs" %*
if errorlevel 1 pause
