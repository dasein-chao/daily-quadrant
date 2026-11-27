@echo off
setlocal
cd /d "%~dp0"
set "PY="
for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set "PY=%%i"
if not defined PY (
  echo [X] python not found in PATH
  exit /b 1
)
if not exist ".env" (
  echo [X] .env not found. Create it with DQ_USER and DQ_PASS first.
  exit /b 1
)
echo Using python: %PY%
schtasks /create /tn "DailyQuadrantDataSync" /tr "\"%PY%\" \"%CD%\daily-sync.py\"" /sc hourly /mo 2 /st 00:30 /f
if errorlevel 1 (
  echo [X] Failed. Right-click this file and Run as administrator.
  exit /b 1
)
echo [OK] Installed: sync every 2 hours.
echo To remove: schtasks /delete /tn "DailyQuadrantDataSync" /f
