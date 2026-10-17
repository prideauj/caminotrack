@echo off
REM CaminoTrack Run Script
REM Activates venv and starts the app

echo.
echo ========================================
echo  CaminoTrack - Starting Local Server
echo ========================================
echo.

REM Check if venv exists
if not exist "venv\Scripts\activate.bat" (
    echo Error: Virtual environment not found
    echo Please run setup.bat first
    pause
    exit /b 1
)

REM Activate venv
call venv\Scripts\activate.bat

echo.
echo Starting FastAPI server...
echo.
echo Server will be available at: http://localhost:8000
echo.
echo To stop the server, press Ctrl+C
echo.

REM Run the app
python main.py

pause
