@echo off
REM cron-engine-v2-runner.bat
REM Runs cron-engine-v2.mjs with stdio properly configured for Windows background execution

cd /d C:\Users\PureTrek\Desktop\xmrtdao\relay

:loop
  echo [%date% %time%] Starting cron-engine-v2...
  node cron-engine-v2.mjs --daemon
  
  echo [%date% %time%] cron-engine-v2 exited with code %errorlevel%, restarting in 10 seconds...
  timeout /t 10 /nobreak >nul
goto loop
