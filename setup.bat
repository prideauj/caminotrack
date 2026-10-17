@echo off
REM CaminoTrack Setup Script
REM Creates virtual environment and installs dependencies

echo.
echo ========================================
echo  CaminoTrack - Local Setup
echo ========================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo Error: Python is not installed or not in PATH
    echo Please install Python 3.9+ from https://www.python.org/
    pause
    exit /b 1
)

REM Show Python version
echo Python found:
python --version
echo.

REM Check if venv already exists
if exist "venv" (
    echo Virtual environment already exists. Removing it...
    rmdir /s /q venv
)

echo [1/3] Creating virtual environment (this may take a moment)...
python -m venv venv --without-pip
if errorlevel 1 (
    echo Error: Failed to create virtual environment
    echo Try: pip install --upgrade pip setuptools
    pause
    exit /b 1
)

echo [2/3] Activating virtual environment and upgrading pip...
call venv\Scripts\activate.bat

REM Use get-pip.py as fallback if ensurepip fails
python -m pip install --upgrade pip setuptools wheel 2>nul
if errorlevel 1 (
    echo Installing pip using alternative method...
    curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py
    python get-pip.py
    del get-pip.py
)

echo [3/3] Installing dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo Error: Failed to install dependencies
    echo Try running: pip install -r requirements.txt
    pause
    exit /b 1
)

echo.
echo ========================================
echo  Setup Complete!
echo ========================================
echo.
echo Next steps:
echo   1. Run: run.bat
echo.
pause
