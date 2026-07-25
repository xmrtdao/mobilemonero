@echo off
REM start-everything.bat — Canonical boot script for XMRT DAO Stack v8.0.0
REM Place in shell:startup folder to auto-start on boot.
REM
REM Canonical workspace: C:\Users\PureTrek\Desktop\xmrtdao (per memory)
REM Boot order managed by supervisor (relay/supervisor.mjs):
REM   pg -> local-sb -> vite -> relay -> MCPs -> tunnel -> alice -> cron -> schedulers
REM
REM This script ONLY launches the supervisor; the supervisor starts everything else.

cd /d C:\Users\PureTrek\Desktop\xmrtdao

echo ========================================
echo   XMRT DAO Stack v8.0.0
echo   Canonical Boot (supervisor-managed)
echo ========================================
echo.

REM Clean any stale PG lock file
if exist pg\data\postmaster.pid (
    for /f "tokens=1" %%a in (pg\data\postmaster.pid) do set OLD_PID=%%a
    tasklist /FI "PID eq %OLD_PID%" 2>nul | find "postgres" >nul
    if errorlevel 1 (
        del /q pg\data\postmaster.pid 2>nul
        echo  Removed stale postmaster.pid (PID %OLD_PID% not running)
    ) else (
        echo  PG already running (PID %OLD_PID%)
    )
)

REM Launch supervisor (manages all 12 services: pg, local-sb, vite, relay, MCPs, tunnel, alice, cron, schedulers)
echo [1/1] Starting supervisor (node supervisor.mjs --daemon)...
echo   Supervisor will start: pg, local-sb, vite, relay, cuttlefishclaws-mcp,
echo   xmrtdao-suite-mcp, cuttlefish-mcp, tunnel, alice, cron-engine-v2,
echo   campaign-scheduler, 31harbor-scheduler
echo.
echo   Relay health:   http://localhost:8080/health
echo   Public tunnel:  https://relay.mobilemonero.com
echo   Status API:     http://localhost:8080/api/supervisor/status
echo.
echo   Logs: relay-data\supervisor-daemon.log
echo   State: relay-data\supervisor-state.json
echo ========================================

REM Start supervisor detached (daemon mode)
start "XMRT-Supervisor" /B cmd /c "node supervisor.mjs --daemon"

REM Optional: trigger scheduled task for health monitoring
timeout /t 3 /nobreak > nul
schtasks /Run /TN "XMRT-LocalSupervisor" 2>nul
