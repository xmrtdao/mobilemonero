@echo off
cd /d C:\Users\PureTrek\Desktop\xmrtdao\relay
start /B node server.js > relay-stdout.log 2> relay-stderr.log
echo Relay launched via start /B
