# CaminoTrack

Import your CaminoWays bookings and see each walking day with its distance, climb, difficulty, lunch stops and a short route summary.

## How it works

- **Sync** logs in to CaminoWays with your email and password, reads your bookings and turns each trip into one stage per walking day (dates, distances, hotels, day descriptions).
- **Route data** (ascent, descent, difficulty, villages passed, lunch stops) comes from public sources: OpenStreetMap route lines and food places, and open elevation data. See `route_data.py`.
- **Nothing is stored on the server.** Your login is used for that one request and never stored or logged. The stages are saved in your browser (`localStorage`) and the server returns them as JSON. "Clear data" removes them.

## Run locally

On Windows, double-click `setup.bat` once, then `run.bat`, and open http://localhost:8000.

Elsewhere:

```bash
python -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python main.py
```

## Route data

Route profiles live in `route_data.json` (committed, so the app needs no network access to known towns). Routes covered: **Camino Francés** and **Via Francigena (Tuscany, Lucca to Siena)**. A trip on another route syncs fine but has no climb or difficulty data.

```bash
python route_data.py status           # what's built and what's left
python route_data.py build            # build whatever is missing (needs internet)
python route_data.py build via-francigena-tuscany
python route_data.py rebuild camino-frances    # start one route again from scratch
python route_data.py pois             # refresh only food places and villages
python route_data.py check "Najera" "Burgos"   # where towns land on each route
```

The build works in small steps (one stretch between two towns at a time) and keeps its progress in `leg_cache/`, `overpass_cache/` and `elevation_cache.json` (all gitignored). If it's stopped, just run `build` again and it carries on where it left off.

How the numbers are worked out:
- **Ascent / descent**: elevation sampled every 150 m along the route (EU-DEM 25 m via OpenTopoData, Open-Meteo as fallback), lightly smoothed, ignoring wiggles under 8 m. Treat as approximate; it tends to read a little low.
- **Effort**: distance + 1 km per 100 m climbed + 1 km per 300 m descended (flat-km equivalents).
- **Difficulty**: where a stage's effort ranks among every same-length stretch of the whole route (Easy / Moderate / Hard / Very hard), plus how it compares with the trip's average day.
- **Lunch stops**: named restaurants, cafés, bars, bakeries and shops within about 350 m of the route, nearest the middle of the stage first. OpenStreetMap data is patchy, so check opening times.

## Hosting

The app is stateless, so any host that runs a Python web service works (Render, Cloud Run, ...):

- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Build command: `pip install -r requirements.txt`
- No environment variables or database needed. `/healthz` is available for uptime checks.
- Sync is limited to 5 attempts per 10 minutes per IP.

## Project layout

```
main.py         FastAPI app: serves the page, POST /api/sync
scraper.py      CaminoWays login + booking page parsing (httpx, BeautifulSoup)
route_data.py   Route profiles, difficulty, lunch stops (build + lookup)
models.py       Stage model
frontend/       Vanilla JS + Leaflet
```
