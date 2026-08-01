@echo off
REM Compile Xomail.exe (Windows) — resultat dans dist\Xomail.exe
cd /d "%~dp0"
python -m pip install --quiet pyinstaller pywebview
python -m PyInstaller --noconfirm --clean --onefile --windowed --name Xomail ^
  --add-data "web;web" --collect-all webview main.py
echo.
echo Termine : dist\Xomail.exe
