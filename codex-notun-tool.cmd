@echo off
setlocal
set "ROOT=%~dp0"
set "NODE_BIN="
for %%I in (node.exe) do set "NODE_BIN=%%~$PATH:I"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_BIN (
  echo [Codex No-TUN] Node.js 18+ not found. Please install Node.js or add it to PATH.
  exit /b 1
)
"%NODE_BIN%" "%ROOT%src\cli.js" %*
exit /b %ERRORLEVEL%
