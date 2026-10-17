import asyncio
import logging
import os
import time
from collections import defaultdict, deque
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from scraper import CaminoScraper, LoginError
from route_data import enrich_stages

load_dotenv()
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


@app.get("/healthz")
async def health():
    return {"ok": True}


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
