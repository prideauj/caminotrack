"""Prescan: exact Google Maps links for the food places on each route, found once, ahead of time.

    python prescan.py status                  # how many places have been checked
    python prescan.py links [route] [--limit N]

Why: a search link often lands on the wrong page or none, so each place is looked up through the Google Places API
and the link is kept only if the match is the right place:
  - its name matches (ignoring accents, case and punctuation), and
  - it is within MAX_MATCH_M of where OpenStreetMap puts the place, which is itself within a few hundred
    metres of the route (route_data.py only keeps food places that close).
Matches go into route_data.json beside each place (`gm` = its Google Maps page), so the app
needs no network access to show them. A place with no confident match keeps no link, rather than a wrong one.

Key (in the environment, a .env file, or secrets.txt):
  GOOGLE_PLACES_API_KEY    Places API (New): text search, "googleMapsUri"
Without it nothing is looked up, and the app's Google Maps link opens a pin at the place's exact coordinates.
Progress is saved as it goes, and `checked` records what has been tried, so a stopped run carries on where it was."""
import difflib
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv

from secrets_file import load_secrets
from route_data import haversine_km, load_data, normalise, save_data

logger = logging.getLogger(__name__)

MAX_MATCH_M = 120          # a matched place further than this from the OpenStreetMap position is rejected
NAME_MATCH_RATIO = 0.82
SAVE_EVERY = 25


def names_match(a: str, b: str) -> bool:
    a, b = normalise(a), normalise(b)
    if not a or not b:
        return False
    if a == b:
        return True
    shorter, longer = sorted((a, b), key=len)
    if len(shorter) >= 5 and shorter in longer:  # "Bar Peregrino" vs "Peregrino"
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= NAME_MATCH_RATIO


def close_enough(poi: dict, lat, lon) -> bool:
    if lat is None or lon is None:
        return False
    return haversine_km((poi["lat"], poi["lon"]), (lat, lon)) * 1000 <= MAX_MATCH_M


def google_link(client: httpx.Client, key: str, poi: dict) -> Optional[str]:
    response = client.post(
        "https://places.googleapis.com/v1/places:searchText",
        headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.displayName,places.location,places.googleMapsUri"},
        json={"textQuery": poi["name"], "maxResultCount": 5,
              "locationBias": {"circle": {"center": {"latitude": poi["lat"], "longitude": poi["lon"]},
                                          "radius": float(MAX_MATCH_M)}}},
        timeout=15)
    response.raise_for_status()
    for place in response.json().get("places", []):
        location = place.get("location", {})
        if names_match(poi["name"], place.get("displayName", {}).get("text", "")) \
                and close_enough(poi, location.get("latitude"), location.get("longitude")):
            return place.get("googleMapsUri")
    return None


def scan_links(route_keys: list, limit: Optional[int] = None):
    load_dotenv()
    load_secrets()  # secrets.txt (git-ignored)
    google_key = os.getenv("GOOGLE_PLACES_API_KEY")
    if not google_key:
        print("Set GOOGLE_PLACES_API_KEY (environment or .env) to look up exact Google Maps links.")
        return
    data = load_data()
    done = 0
    with httpx.Client() as client:
        for route_key in route_keys:
            for poi in data["routes"][route_key]["pois"]:
                if poi["kind"] == "place":
                    continue
                if "g" in poi.get("checked", ""):
                    continue
                try:
                    link = google_link(client, google_key, poi)
                except Exception as e:
                    logger.warning(f"{poi['name']}: {e}")
                    time.sleep(2)
                    continue  # not marked as checked, so the next run retries it
                if link:
                    poi["gm"] = link
                poi["checked"] = "g"
                time.sleep(0.2)
                done += 1
                if done % SAVE_EVERY == 0:
                    save_data(data)
                    print(f"{done} places checked")
                if limit and done >= limit:
                    save_data(data)
                    return
    save_data(data)
    print(f"{done} places checked")


def status(data: dict):
    for route_key, route in data["routes"].items():
        food = [p for p in route.get("pois", []) if p["kind"] != "place"]
        print(f"{route_key}: {len(food)} food places; "
              f"{sum('g' in p.get('checked', '') for p in food)} checked on Google ({sum('gm' in p for p in food)} linked)")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = [a for a in sys.argv[1:]]
    command = args.pop(0) if args else ""
    limit = None
    if "--limit" in args:
        at = args.index("--limit")
        limit = int(args[at + 1])
        del args[at:at + 2]
    if command == "links":
        scan_links(args or list(load_data()["routes"]), limit)
    elif command == "status":
        status(load_data())
    else:
        print(__doc__)
