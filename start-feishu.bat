@echo off
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Platform feishu %*
