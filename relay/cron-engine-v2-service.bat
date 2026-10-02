@echo off
REM cron-engine-v2-service.bat
REM Windows service-style runner for cron-engine-v2.mjs
REM Redirects stdout/stderr to log files, avoids TTY issues

cd /d C:\Users\PureTrek\Desktop\xmrtdao\relay

if not exist "relay-data\cron-logs" mkdir "relay-data\cron-logs"

:loop
  echo [%date% %time%] Starting cron-engine-v2...
  
  node cron-engine-v2.mjs --daemon > "relay-data\cron-logs\cron-stdout.log" 2> "relay-data\cron-logs\cron-stderr.log"
  
  echo [%date% %time%] cron-engine-v2 exited with code %errorlevel%, restarting in 10 seconds...
  timeout /t 10 /nobreak > nul
goto loop
