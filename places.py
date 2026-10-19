"""Google ratings and reviews for a food stop, looked up when someone clicks it (only if GOOGLE_PLACES_API_KEY is set).

Everything else a stop's card shows (address, phone, website, hours, cuisine, exact map links) is prescanned into
route_data.json, see route_data.py and prescan.py, so showing a stop never waits on a public map service.
There is no free source of reviews, so without a key no lookup is made and the card just links out."""
import logging
import os
import re
import unicodedata
from collections import OrderedDict
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

USER_AGENT = "CaminoTrack/1.0 (https://github.com/prideauj/caminotrack)"
CACHE_SIZE = 500
_cache: "OrderedDict[tuple, dict]" = OrderedDict()


def _normalise(name: str) -> str:
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


async def _google(client: httpx.AsyncClient, name: str, lat: float, lon: float) -> Optional[dict]:
    key = os.getenv("GOOGLE_PLACES_API_KEY")
    if not key:
        return None
    fields = ("places.displayName,places.rating,places.userRatingCount,places.reviews,places.googleMapsUri,"
              "places.websiteUri,places.nationalPhoneNumber,places.formattedAddress")
    try:
        response = await client.post(
            "https://places.googleapis.com/v1/places:searchText",
            headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": fields},
            json={"textQuery": name, "maxResultCount": 1,
                  "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lon}, "radius": 150.0}}},
            timeout=10)
        response.raise_for_status()
        places = response.json().get("places", [])
    except Exception as e:
        logger.warning(f"Google Places lookup failed: {e}")
        return None
    if not places or _normalise(places[0].get("displayName", {}).get("text", "")) != _normalise(name):
        return None  # don't show reviews for a different place
    place = places[0]
    return {
        "rating": place.get("rating"),
        "count": place.get("userRatingCount"),
        "maps_url": place.get("googleMapsUri"),
        "website": place.get("websiteUri"),
        "phone": place.get("nationalPhoneNumber"),
        "address": place.get("formattedAddress"),
        "reviews": [{
            "rating": r.get("rating"),
            "text": (r.get("text") or r.get("originalText") or {}).get("text", "")[:400],
            "author": r.get("authorAttribution", {}).get("displayName"),
            "when": r.get("relativePublishTimeDescription"),
        } for r in place.get("reviews", [])[:5]],
    }


async def place_details(name: str, kind: str, lat: float, lon: float) -> dict:
    if not os.getenv("GOOGLE_PLACES_API_KEY"):
        return {"name": name, "reviews_enabled": False}
    key = (_normalise(name), round(lat, 4), round(lon, 4))
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    async with httpx.AsyncClient() as client:
        google = await _google(client, name, lat, lon)
    details = {"name": name, "reviews_enabled": True, "google_rating": google}
    if google is not None:  # a failed lookup isn't remembered
        _cache[key] = details
        if len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return details
