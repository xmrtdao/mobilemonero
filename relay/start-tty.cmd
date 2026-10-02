@echo off
cd /d C:\Users\PureTrek\Desktop\xmrtdao\relay
start "RelayTTY" /B cmd /C "node server.js > C:\Users\PureTrek\Desktop\xmrtdao\relay-data\relay.log 2>&1"
