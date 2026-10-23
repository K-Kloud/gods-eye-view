@echo off
setlocal
set "GEV_ROOT=%~dp0"
set "GEV_TOOLS=%GEV_ROOT%..\.tools"
if exist "%GEV_TOOLS%\node-v24.14.0-win-x64\node.exe" (
  set "PATH=%GEV_TOOLS%\node-v24.14.0-win-x64;%PATH%"
)
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24.14 or later in the 24.x series, or Node.js 26.x.
  exit /b 1
)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit((major === 24 && minor >= 14) || major === 26 ? 0 : 1)"
if errorlevel 1 (
  echo This project requires Node.js 24.14 or later in the 24.x series, or Node.js 26.x.
  echo Install a supported Node.js version and reopen your terminal.
  exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm.cmd was not found. Install the full Node.js distribution with npm.
  exit /b 1
)
if not exist "%GEV_ROOT%node_modules\vite\package.json" (
  echo Dependencies are missing. Run npm ci from the repository root.
  exit /b 1
)
if not defined PUPPETEER_CACHE_DIR (
  if exist "%GEV_TOOLS%\puppeteer" set "PUPPETEER_CACHE_DIR=%GEV_TOOLS%\puppeteer"
)
cd /d "%GEV_ROOT%"
if "%~1"=="" (
  call npm.cmd run dev -- --host localhost --port 4173 --strictPort
) else (
  call npm.cmd run %*
)
endlocal & exit /b %errorlevel%
