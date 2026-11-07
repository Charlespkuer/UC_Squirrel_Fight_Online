@echo off
node "%~dp0..\tools\build-online-apk.cjs" %*
if errorlevel 1 pause
