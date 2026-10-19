import asyncio
import logging
import os
import time
from datetime import datetime
from collections import defaultdict, deque
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from scraper import CaminoScraper, LoginError
from route_data import enrich_stages
from places import place_details
from secrets_file import load_secrets
from towns import town_info

load_dotenv()
load_secrets()  # secrets.txt (git-ignored)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent

# The server keeps no user data: a sync scrapes CaminoWays, adds route data and returns everything to the
# browser, which stores it. Credentials are used for that one request and never stored or logged.

SYNCS_PER_WINDOW = 5          # per client IP
WINDOW_SECONDS = 600
MAX_CONCURRENT_SYNCS = 3      # keeps memory use bounded on small free-tier hosts

app = FastAPI()
app.mount("/static", StaticFiles(directory=BASE_DIR / "frontend"), name="static")

_recent_syncs = defaultdict(deque)
_sync_slots = asyncio.Semaphore(MAX_CONCURRENT_SYNCS)


class SyncRequest(BaseModel):
    email: str
    password: str
    include_quotes: bool = False  # also import quotes, not just confirmed bookings


def _client_ip(request: Request) -> str:
    # Hosts like Render and Cloud Run put the real client address in X-Forwarded-For
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def _check_rate_limit(ip: str):
    now = time.monotonic()
    attempts = _recent_syncs[ip]
    while attempts and now - attempts[0] > WINDOW_SECONDS:
        attempts.popleft()
    if len(attempts) >= SYNCS_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Too many sync attempts. Please wait a few minutes and try again.")
    attempts.append(now)


@app.get("/")
async def serve_root():
    return FileResponse(BASE_DIR / "frontend" / "index.html")


@app.get("/sw.js")
async def service_worker():
    # Served from the root so it can cover the whole app; never cached, so updates are picked up
    return FileResponse(BASE_DIR / "frontend" / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(BASE_DIR / "frontend" / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/api/config")
async def config():
    """What the page needs to know about this server: map tiles, and when the route data was last built"""
    data_file = BASE_DIR / "route_data.json"
    updated = datetime.fromtimestamp(data_file.stat().st_mtime).date().isoformat() if data_file.exists() else None
    return JSONResponse({
        "tile_url": os.getenv("TILE_URL") or None,
        "tile_attribution": os.getenv("TILE_ATTRIBUTION") or None,
        "data_updated": updated,
        "reviews": bool(os.getenv("GOOGLE_PLACES_API_KEY")),
    }, headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
async def health():
    return {"ok": True}


LOOKUPS_PER_WINDOW = 60  # per client IP, for place and town lookups each
_recent_lookups = defaultdict(deque)


def _check_lookup_limit(request: Request, kind: str):
    now = time.monotonic()
    attempts = _recent_lookups[(kind, _client_ip(request))]
    while attempts and now - attempts[0] > WINDOW_SECONDS:
        attempts.popleft()
    if len(attempts) >= LOOKUPS_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Too many lookups. Please wait a few minutes.")
    attempts.append(now)


@app.get("/api/town")
async def town(request: Request, name: str = Query(..., min_length=1, max_length=120),
               lat: Optional[float] = Query(None, ge=-90, le=90), lon: Optional[float] = Query(None, ge=-180, le=180),
               country: str = Query("", max_length=10)):
    """A short description and highlights for a town or village (prescanned from Wikipedia, else looked up live)"""
    _check_lookup_limit(request, "town")
    info = await asyncio.to_thread(town_info, name, lat, lon, country)
    return JSONResponse(info, headers={"Cache-Control": "private, max-age=3600" if not info.get("retry") else "no-store"})


@app.get("/api/place")
async def place(request: Request, name: str = Query(..., min_length=1, max_length=120),
                kind: str = Query("", max_length=30), lat: float = Query(..., ge=-90, le=90),
                lon: float = Query(..., ge=-180, le=180)):
    """Google ratings and reviews for a lunch stop, when a Google key is configured"""
    _check_lookup_limit(request, "place")
    return JSONResponse(await place_details(name, kind, lat, lon), headers={"Cache-Control": "private, max-age=3600"})


@app.post("/api/sync")
async def sync(body: SyncRequest, request: Request):
    """Scrape the user's CaminoWays bookings and return their stages, enriched with route data"""
    _check_rate_limit(_client_ip(request))

    async with _sync_slots:
        try:
            stages = await CaminoScraper().scrape_stages(body.email, body.password, body.include_quotes)
            # Route lookups can touch the network (geocoding unfamiliar towns), so keep them off the event loop
            await asyncio.to_thread(enrich_stages, stages)
        except LoginError as e:
            raise HTTPException(status_code=401, detail=str(e))
        except Exception:
            logger.exception("Sync failed")
            raise HTTPException(status_code=502, detail="Could not read your bookings from CaminoWays. Please try again later.")

    return JSONResponse(
        {"stages": [stage.model_dump(mode="json") for stage in stages]},
        headers={"Cache-Control": "no-store"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
