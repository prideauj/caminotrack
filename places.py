"""Details for a food stop, looked up when someone clicks it.

Always: what OpenStreetMap knows (address, phone, website, opening hours, cuisine). If GOOGLE_PLACES_API_KEY is set,
also the place's Google rating and a few recent reviews. Without a key there is no free source of reviews, so the
page gets links to read them instead. Nothing here needs a user's login, and nothing is stored beyond a small cache."""
import asyncio
import logging
import os
import re
import unicodedata
from collections import OrderedDict
from typing import Optional
from urllib.parse import quote_plus

import httpx

logger = logging.getLogger(__name__)

OVERPASS_URLS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter",
                 "https://overpass.private.coffee/api/interpreter"]
USER_AGENT = "CaminoTrack/1.0 (https://github.com/prideauj/caminotrack)"
CACHE_SIZE = 500
_cache: "OrderedDict[tuple, dict]" = OrderedDict()


def _normalise(name: str) -> str:
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


async def _osm_tags(client: httpx.AsyncClient, name: str, lat: float, lon: float) -> tuple:
    """(tags or None, whether OpenStreetMap could be asked at all). The public mirrors are often busy, so ask
    them all at once and take the first answer."""
    query = f'[out:json][timeout:8];nwr(around:80,{lat},{lon})["name"];out tags center 20;'

    async def ask(url: str) -> list:
        response = await client.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=9)
        response.raise_for_status()
        return response.json().get("elements", [])

    tasks = [asyncio.ensure_future(ask(url)) for url in OVERPASS_URLS]
    elements = None
    try:
        for finished in asyncio.as_completed(tasks, timeout=10):
            try:
                elements = await finished
                break
            except Exception as e:
                logger.warning(f"Overpass place lookup failed: {e}")
    except asyncio.TimeoutError:
        logger.warning("Overpass place lookup timed out")
    finally:
        for task in tasks:
            task.cancel()
    if elements is None:
        return None, False

    wanted = _normalise(name)
    for element in elements:
        tags = element.get("tags", {})
        if _normalise(tags.get("name", "")) == wanted:
            return {**tags, "_type": element["type"], "_id": element["id"]}, True
    return None, True


def _address(tags: dict) -> Optional[str]:
    street = " ".join(p for p in (tags.get("addr:street"), tags.get("addr:housenumber")) if p)
    town = " ".join(p for p in (tags.get("addr:postcode"), tags.get("addr:city")) if p)
    return ", ".join(p for p in (street, town) if p) or None


def _safe_web(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    url = url if re.match(r"^https?://", url, re.I) else "http://" + url
    return url[:300]


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
    key = (_normalise(name), round(lat, 4), round(lon, 4))
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    async with httpx.AsyncClient() as client:
        tags, asked = await _osm_tags(client, name, lat, lon)
        google = await _google(client, name, lat, lon)

    tags = tags or {}
    details = {
        "name": name,
        "kind": kind,
        "address": (google or {}).get("address") or _address(tags),
        "phone": tags.get("contact:phone") or tags.get("phone") or (google or {}).get("phone"),
        "website": _safe_web(tags.get("contact:website") or tags.get("website") or (google or {}).get("website")),
        "hours": tags.get("opening_hours"),
        "cuisine": (tags.get("cuisine") or "").replace(";", ", ").replace("_", " ") or None,
        "wheelchair": tags.get("wheelchair"),
        "outdoor_seating": tags.get("outdoor_seating"),
        "found_in_osm": bool(tags),
        "lookup_failed": not asked,  # the map service was down: worth trying again
        "osm_url": f"https://www.openstreetmap.org/{tags['_type']}/{tags['_id']}" if tags else None,
        "google_rating": google,
        "links": {
            "google_maps": (google or {}).get("maps_url")
            or f"https://www.google.com/maps/search/?api=1&query={quote_plus(f'{name} {lat},{lon}')}",
            "tripadvisor": f"https://www.tripadvisor.com/Search?q={quote_plus(name)}",
        },
    }
    if asked:  # don't remember a lookup that failed
        _cache[key] = details
        if len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return details
