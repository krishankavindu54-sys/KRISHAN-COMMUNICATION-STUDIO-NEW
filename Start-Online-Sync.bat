@echo off
title Krishan POS - Free 24/7 Online Multi-Device Sync
color 0b
echo ========================================================
echo   KRISHAN POS - FREE INTERNET & MULTI-DEVICE SYNC
echo   (No Credit Cards - 100%% Free Forever)
echo ========================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    pause
    exit /b
)

echo [1/2] Starting Krishan POS Local Server...
start "Krishan POS Server" cmd /k "node server.js"
timeout /t 3 >nul

echo [2/2] Creating Free 100%% Free Online HTTPS Internet Link...
echo.
echo ========================================================
echo  Your Free Public Internet Link will appear below:
echo  (Copy and open this link on your Mobile Phone or Laptop)
echo ========================================================
echo.

call npx.cmd -y localtunnel --port 3000 --subdomain krishan-pos-%RANDOM%
pause
