@echo off
cd /d C:\Users\PureTrek\Desktop\xmrtdao\relay
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *relay*" 2>nul
taskkill /F /IM node.exe /FI "COMMANDLINE eq *server.js*" 2>nul
timeout /t 2 /nobreak >nul
node.exe server.js
