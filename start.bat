@echo off
title Master Study Hub
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm install || (echo npm install failed & pause & exit /b 1)
)
node server.js --open
pause
