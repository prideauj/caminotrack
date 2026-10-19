# CaminoTrack

Import your CaminoWays bookings and see each walking day with its distance, climb, difficulty, lunch stops and a short route summary.

## How it works

- **Sync** logs in to CaminoWays with your email and password, reads your bookings and turns each trip into one stage per walking day (dates, distances, hotels, day descriptions).
- **Route data** (ascent, descent, difficulty, villages passed, lunch stops) comes from public sources: OpenStreetMap route lines and food places, and open elevation data. See `route_data.py`.
- **Nothing is stored on the server.** Your login is used for that one request and never stored or logged. The stages are saved in your browser (`localStorage`) and the server returns them as JSON. "Clear data" removes them.

## Using it

- **Itinerary** (the evening before): the Today strip at the top shows where you are in the trip and opens today's stage. A stage shows the day as a timeline (villages, places to eat, the longest stretch without food), the weather and daylight (Open-Meteo), tonight's hotel with Navigate and Call, lunch stops, and a Previous / Next day control. Tap any town name for a short description and highlights.
- **Map** (on the trail): press **Start walking** and the map follows you, shows how far you have come and what is next, warns you if you leave the route, and keeps the screen on while following. Swipe the sheet up for more.
- **Offline**: the app can be added to the home screen. On a stage, **Save for offline** keeps the town descriptions (and, if the server has a tile provider that allows it, the map along the route), and the map keeps the areas you have already looked at, so it still works with no signal. The stages themselves are already stored in the browser.
- **km / mi** toggle in the header. Works on phones, iPads and desktops (a bottom tab bar on phones, a map beside the detail on wide screens).

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
- **Distance**: *official* is what CaminoWays publishes. *Hotel to hotel* is measured along the mapped route between your hotels' map positions (read from the "Hotel On Map" links), plus the walk to and from any hotel off the route (estimated at 1.3 times the straight line). A hotel's position comes from its map link, or failing that from its address; if neither gives one, the mapped route between the towns is used.
- **Effort**: distance + 1 km per 100 m climbed + 1 km per 300 m descended (flat-km equivalents).
- **Difficulty**: where a stage's effort ranks among every same-length stretch of the whole route (Easy / Moderate / Hard / Very hard), plus how it compares with the trip's average day.
- **Lunch stops**: named restaurants, cafés, bars, bakeries and shops within about 350 m of the route, nearest the middle of the stage first. OpenStreetMap data is patchy, so check opening times.

## Lunch stop details and exact links

Clicking a lunch stop shows its address, phone, website, hours and cuisine. These come from OpenStreetMap and are
stored in `route_data.json` (refresh them with `python route_data.py pois`), so the card never waits on a public
map service. Links are found ahead of time by `prescan.py`:

```bash
python prescan.py links --limit 20    # try a few first; needs GOOGLE_PLACES_API_KEY
python prescan.py status
```

A link is kept only if the place's name matches and it is within 120 m of the OpenStreetMap position (which is
itself within 350 m of the route). With no match there is no link. Without keys the Google Maps link opens a pin at
the place's exact coordinates. Ratings and reviews need `GOOGLE_PLACES_API_KEY`
on the server and appear in the same card.

## Town descriptions

Tapping a town name shows a short description and highlights from Wikipedia. They are prescanned into
`town_info.json` (`python towns.py build`) and checked for being the right place; towns that aren't in the file are
looked up live.

## Map tiles

The map uses the free OpenStreetMap tile server (no key). Its policy forbids bulk downloading, so by default a stage can't be saved as a whole map for offline use; the app keeps only the tiles you have looked at (and its town descriptions). To allow saving whole stages, or to serve many people, set `TILE_URL` to a provider that permits it (for example MapTiler or Stadia, with your key) and `TILE_ATTRIBUTION`. A provider's free key must be set on the server, not in the page.

## Keys

Optional keys go in the environment, a `.env` file or `secrets.txt` (all git-ignored): `GOOGLE_PLACES_API_KEY` (see above).

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

### Google Cloud Run

`Dockerfile` is ready for Cloud Run. With the `gcloud` CLI installed and logged in (`gcloud auth login`), from this folder:

```bash
gcloud run deploy caminotrack --source . --region europe-southwest1 --allow-unauthenticated \
    --memory 512Mi --max-instances 3
```

It scales to zero when idle, so the first request after a quiet spell takes a few seconds. Add `--min-instances 1` to keep one warm (a few dollars a month). `secrets.txt` and `.env` are never uploaded; to turn on Google reviews, add `--set-env-vars GOOGLE_PLACES_API_KEY=...`.
