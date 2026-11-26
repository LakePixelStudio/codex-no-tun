@echo off
setlocal
chcp 65001 >nul 2>nul
set "ROOT=%~dp0"
call "%ROOT%codex-notun-tool.cmd" uninstall
echo.
pause
