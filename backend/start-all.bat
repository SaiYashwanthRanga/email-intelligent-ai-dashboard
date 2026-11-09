@echo off
REM ==========================================================================
REM  Starts everything the backend needs, each in its own window:
REM    1. Email API       (uvicorn --reload, http://127.0.0.1:8000)
REM    2. Celery worker   (runs the tracker tasks)
REM    3. Celery beat     (schedules the fetch every TRACKER_FETCH_INTERVAL_MINUTES)
REM
REM  Run:   double-click this file, or from any folder:  backend\start-all.bat
REM  Stop:  stop-all.bat  (or close the three windows)
REM ==========================================================================
setlocal
cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
    echo [ERROR] Python venv not found in %CD%\venv
    echo         Create it:  python -m venv venv ^&^& venv\Scripts\python -m pip install -r requirements.txt
    goto :fail
)

REM PostgreSQL holds the tracker data AND the Celery queue, so nothing works without it.
sc query postgresql-x64-18 | find "RUNNING" >nul
if errorlevel 1 (
    echo [ERROR] PostgreSQL service "postgresql-x64-18" is not running.
    echo         Start it from an admin prompt:  net start postgresql-x64-18
    goto :fail
)

REM Port 8000 already taken means an API is already running somewhere.
netstat -ano | find ":8000 " | find "LISTENING" >nul
if not errorlevel 1 (
    echo [ERROR] Port 8000 is already in use - an API is probably already running.
    echo         Stop it ^(Ctrl+C in its terminal, or stop-all.bat^) and run this again.
    goto :fail
)

REM Two beat processes would schedule every job twice, so never start a second one.
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='celery.exe'\" | Where-Object { $_.CommandLine -match '\sbeat(\s|$)' }) { exit 1 }"
if errorlevel 1 (
    echo [ERROR] Celery beat is already running - two beats would send every job twice.
    echo         Stop it ^(Ctrl+C in its terminal, or stop-all.bat^) and run this again.
    goto :fail
)

powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='celery.exe'\" | Where-Object { $_.CommandLine -match '\sworker(\s|$)' }) { exit 1 }"
if errorlevel 1 (
    echo [WARN] A Celery worker is already running; a second one will start too.
    echo        That is safe, but close the old one if you didn't mean to keep it.
    echo.
)

if not exist "logs" mkdir "logs"

start "Email API (uvicorn :8000)" cmd /k "venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000"
start "Tracker Celery worker" cmd /k "venv\Scripts\celery.exe -A tracker.worker.celery_app worker --pool=solo --loglevel=info"
start "Tracker Celery beat" cmd /k "venv\Scripts\celery.exe -A tracker.worker.celery_app beat --loglevel=info --schedule logs\celerybeat-schedule"

echo Started in three windows:
echo   - Email API (uvicorn :8000)   http://127.0.0.1:8000/docs
echo   - Tracker Celery worker
echo   - Tracker Celery beat         first fetch runs one interval after start
echo Stop everything with stop-all.bat
endlocal
exit /b 0

:fail
echo.
pause
endlocal
exit /b 1
