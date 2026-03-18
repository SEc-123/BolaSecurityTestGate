@echo off
cd /d %~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1 %*
