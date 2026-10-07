@echo off
rem ---------------------------------------------------------------------------
rem dsh-agent-clean -- Windows wrapper
rem Needs Node.js >= 22 (built-in zlib zstd). Set DSH_NODE to a node.exe path.
rem Usage: clean.cmd list  /  dismiss --session <id> [--apply]  /  purge ...
rem        clean.cmd orphans  /  restore --backup <dir>  /  help
rem NOTE: keep this file ASCII-only -- cmd.exe decodes batch files using the
rem       current code page, and merging that with "chcp 65001" corrupts
rem       non-ASCII lines further down the file.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal enabledelayedexpansion
set "DIR=%~dp0"
set "NODE=%DSH_NODE%"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE if exist "%APPDATA%\dsh-tauri\runtime\node.exe" set "NODE=%APPDATA%\dsh-tauri\runtime\node.exe"
if not defined NODE (
  echo [clean] Node.js not found ^(need ^>= 22^). Install Node, or set DSH_NODE to node.exe.
  pause
  exit /b 1
)
"%NODE%" "%DIR%clean.mjs" %*
set "CODE=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %CODE%
