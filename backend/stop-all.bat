@echo off
REM Stops the three windows opened by start-all.bat (and everything running in them).
setlocal
for %%T in ("Email API (uvicorn :8000)" "Tracker Celery worker" "Tracker Celery beat") do (
    taskkill /fi "windowtitle eq %%~T*" /t /f >nul 2>&1 && echo Stopped %%~T || echo Not running: %%~T
)
endlocal
