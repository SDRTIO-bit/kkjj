@echo off
title RP Engine

echo ========================================
echo   RP Engine
echo ========================================
echo.

:: Start pi in background
start /b pi

:: Wait for server to start
echo Waiting for server...
timeout /t 5 /nobreak >nul

:: Open browser
echo Opening browser...
start http://localhost:3012

echo.
echo pi is running in background
echo Browser: http://localhost:3012
echo Close this window to stop pi
echo.
pause
