@echo off
setlocal
title Website bearbeiten - Christine Guttmann
cd /d "%~dp0"

echo.
echo   Website-Editor wird gestartet...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   FEHLER: Node.js ist nicht installiert.
  echo.
  echo   Bitte einmalig von https://nodejs.org herunterladen und
  echo   installieren ^(die empfohlene "LTS"-Version^), dann diese
  echo   Datei erneut doppelklicken.
  echo.
  pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo   HINWEIS: Git ist nicht installiert.
  echo   Bearbeiten funktioniert, aber "Veroeffentlichen" nicht.
  echo   Git gibt es hier: https://git-scm.com/download/win
  echo.
)

node "cms\server.js"

echo.
echo   Der Editor wurde beendet.
pause
