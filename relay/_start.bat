@echo off
cd /d C:\Users\PureTrek\Desktop\xmrtdao\relay
start /MIN cmd /c "node.exe server.js ^> C:\Users\PureTrek\Desktop\xmrtdao\relay-data\relay.log 2^>^&1"
echo RELAY_LAUNCHED
