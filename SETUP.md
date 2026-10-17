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
1. **Sync Your Data**: Click "Sync Data" and enter your CaminoWays email and password
2. **Browse Your Trips** in two views:
   - **Map**: Interactive map with color-coded stages (green=completed, yellow=upcoming)
   - **Timeline**: Trips and their stages, with distance, climb, difficulty, hotels, lunch stops and a route summary (click a stage)

## Key Features

✅ **Route Data**: Ascent, descent and difficulty for each stage (Camino Francés and Via Francigena in Tuscany), from OpenStreetMap and open elevation data

✅ **Mobile Responsive**: Works on desktop and mobile devices

✅ **Local Data**: Nothing is stored on the server. Your trips are saved in your browser only

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

## Hosting

See `README.md`.
