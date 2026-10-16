# CaminoTrack - Local Setup Guide

## Prerequisites
- Python 3.9 or higher
- Windows (uses .bat files - for other OS, use the commands manually)

## Quick Start

### 1. Run Setup
Double-click `setup.bat` to:
- Create a virtual environment (`venv/`)
- Install all dependencies from `requirements.txt`

### 2. Run the App
Double-click `run.bat` to start the server at `http://localhost:8000`

## Testing the App

Once running:
1. **Create a Session**: Enter any session ID (e.g., your name) - this keeps your data local
2. **Sync Your Data**: Click "Sync Data" and enter your CaminoWays login credentials
3. **Browse Your Trips** in three views:
   - **Map**: Interactive map with color-coded stages (green=completed, yellow=upcoming)
   - **Timeline**: Chronological list of stages, hotels, and actual walking distances
   - **By Date**: Daily distance summaries

## Key Features

✅ **Actual Distance Calculation**: 
- Calculates real walking distance from hotel to hotel using GPS coordinates
- Compares to standard stage distances
- Shows warning if hotels are significantly off the route

✅ **Mobile Responsive**: Works on desktop and mobile devices

✅ **Local Data**: All data is stored locally in your browser (using browser storage)

## Troubleshooting

**"Python is not installed"**
- Install from https://www.python.org/
- Make sure to check "Add Python to PATH" during installation

**"Sync failed - Invalid credentials"**
- Double-check your CaminoWays email and password
- Make sure your account is confirmed on caminoways.com

**Virtual environment errors**
- Delete the `venv/` folder
- Run `setup.bat` again

**Port 8000 already in use**
- Change port in `main.py`: `uvicorn.run(app, host="0.0.0.0", port=8001)`

## Next: Deploy to Render

Once you've tested locally, see `README.md` for Render deployment instructions.
