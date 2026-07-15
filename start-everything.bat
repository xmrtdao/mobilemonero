@echo off
REM start-everything.bat — Canonical boot script for XMRT DAO Fleet
REM Place in shell:startup folder to auto-start on boot.
REM Boot order: postgres -> local-sb -> relay -> MCPs -> agents -> tunnel
REM
REM ╔══════════════════════════════════════════════════════════════════╗
REM ║  CANONICAL WORKSPACE: DevGruGold                               ║
REM ║  All services run from DevGruGold (the patched development     ║
REM ║  copy). The xmrtdao workspace is a stable base that gets       ║
REM ║  patched from DevGruGold — do NOT start services from both.    ║
REM ║                                                                ║
REM ║  The supervisor (relay/supervisor.mjs) auto-deduplicates       ║
REM ║  runtimes on every health check cycle — it kills duplicate     ║
REM ║  instances of known service scripts and keeps the oldest PID.  ║
REM ║  But you should still only start from ONE workspace.           ║
REM ╚══════════════════════════════════════════════════════════════════╝
REM
REM All services run from DevGruGold (the patched development copy).
REM The supervisor (relay/supervisor.mjs) is the recommended entry point.

cd /d C:\Users\PureTrek\Desktop\DevGruGold

echo ========================================
echo   XMRT DAO Fleet — Starting All Services
echo   Canonical Boot (14 services)
echo ========================================
echo.

REM 1. Postgres
echo [1/14] Postgres (5432)...
start "Postgres" /B cmd /c "node relay\start-pg.mjs"
timeout /t 4 /nobreak > nul

REM 2. local-sb (PostgREST + Auth + Storage + Edge Functions)
echo [2/14] local-sb (54321)...
start "local-sb" /B cmd /c "node local-supabase\server.mjs"
timeout /t 4 /nobreak > nul

REM 3. Relay
echo [3/14] Relay (8080)...
start "Relay" /B node relay\server.js
timeout /t 5 /nobreak > nul

REM 4. cuttlefishclaws-mcp
echo [4/14] cuttlefishclaws-mcp (3120)...
start "cuttlefishclaws-mcp" /B node relay\cuttlefishclaws-mcp.mjs --http --port 3120
timeout /t 2 /nobreak > nul

REM 5. suite-mcp
echo [5/14] suite-mcp (3200)...
start "suite-mcp" /B node relay\xmrtdao-suite-mcp.mjs --http --port 3200
timeout /t 2 /nobreak > nul

REM 6. Vite (Suite SPA)
echo [6/14] Vite Suite (5173)...
start "Vite-Suite" /B cmd /c "node node_modules\.bin\vite --host 127.0.0.1 --port 5173 --root suite"
timeout /t 2 /nobreak > nul

REM 7. Vite (Zero-Claw)
echo [7/14] Vite Zero-Claw (5174)...
start "Vite-Zero" /B cmd /c "node node_modules\.bin\vite --host 127.0.0.1 --port 5174 --root zero-claw"
timeout /t 2 /nobreak > nul

REM 8. Alice
echo [8/14] Alice...
start "Alice" /B node relay\alice.mjs --daemon
timeout /t 2 /nobreak > nul

REM 9. Cron Engine
echo [9/14] Cron Engine...
start "CronEngine" /B node relay\cron-engine-v2.mjs
timeout /t 2 /nobreak > nul

REM 10. Campaign Scheduler
echo [10/14] Campaign Scheduler...
start "Campaign" /B node relay\campaign-scheduler.mjs --daemon
timeout /t 2 /nobreak > nul

REM 11. 31 Harbor Scheduler
echo [11/14] 31 Harbor Scheduler...
start "31Harbor" /B node relay\tools\31harbor-scheduler.mjs --daemon
timeout /t 2 /nobreak > nul

REM 12. Deno Edge Functions (via local-sb, already started in step 2)
echo [12/14] Deno Edge Functions (via local-sb)...
echo   (auto-started with local-sb)

REM 13. Supervisor
echo [13/14] Supervisor...
start "Supervisor" /B node relay\supervisor.mjs --daemon
timeout /t 2 /nobreak > nul

REM 14. Cloudflare Tunnel
echo [14/14] Cloudflare Tunnel (xmrtdao-relay)...
start "Tunnel" /B cmd /c "node relay\start-tunnel-detached.mjs"

echo.
echo ========================================
echo   Fleet startup initiated
echo   Check relay at http://localhost:8080
echo   Check Suite at https://suite.mobilemonero.com
echo   Check Cuttlefish at https://cuttlefish.mobilemonero.com
echo ========================================
