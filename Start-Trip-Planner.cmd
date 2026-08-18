@echo off
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is required.
  pause
  exit /b 1
)
if not exist node_modules call npm install
echo.
echo Open this on your iPhone (same Wi-Fi^):
node -e "const os=require('os');for (const a of Object.values(os.networkInterfaces()).flat()) { if (a.family==='IPv4'&&!a.internal) console.log('  http://'+a.address+':3860') }"
echo.
npm start
