"""Short descriptions and highlights for the towns and villages on the routes, from Wikipedia.

    python towns.py build [route]     # look up every town and village on the built routes (resumable)
    python towns.py status

The results are kept in town_info.json (committed), so the app shows them without any lookup. A town that isn't in
the file (a trip on a route we haven't built) is looked up live from Wikipedia, which is a reliable service, and
remembered in memory.

Each lookup is checked for being the right place: the article's title must match the town's name, and its
coordinates must be within MAX_TOWN_KM of where the town is on the map. Highlights are other Wikipedia articles
about things within HIGHLIGHT_RADIUS_M of the town (churches, bridges, monuments), nearest first."""
import json
import logging
import sys
import time
import unicodedata
import re
from pathlib import Path
from typing import List, Optional

import httpx

from route_data import haversine_km, load_data, write_atomic

logger = logging.getLogger(__name__)

INFO_FILE = Path(__file__).parent / "town_info.json"
USER_AGENT = "CaminoTrack/1.0 (https://github.com/prideauj/caminotrack)"
MAX_TOWN_KM = 8.0           # Wikipedia often puts a municipality's point at its centre, not the village
HIGHLIGHT_RADIUS_M = 2000
MAX_HIGHLIGHTS = 5
MAX_EXTRACT_CHARS = 520
SKIP_HIGHLIGHT = re.compile(r"\b(municipality|comune|commune|province|autonomous|district|county|frazione|"
                            r"parish|civil parish|village in|town in|hamlet|human settlement)\b", re.I)

# Languages to try, in order: English first, then the local language of the country the route is in
LANGUAGES = {"es": ["en", "es"], "fr": ["en", "fr"], "it": ["en", "it"]}


def normalise(name: str) -> str:
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def name_variants(name: str) -> List[str]:
    """OpenStreetMap names in bilingual regions look like 'Roncesvalles/Orreaga' or 'Pamplona - Iruña'"""
    parts = re.split(r"\s*[/;]\s*|\s+-\s+", name)
    return [normalise(p) for p in parts if normalise(p)]


def title_matches(title: str, variants: List[str]) -> bool:
    base = normalise(re.sub(r"\s*\(.*?\)\s*", " ", title.split(",")[0]))  # "Sarria, Lugo" / "Nájera (town)"
    return any(base == v for v in variants)


def _api(client: httpx.Client, lang: str, params: dict) -> dict:
    response = client.get(f"https://{lang}.wikipedia.org/w/api.php", headers={"User-Agent": USER_AGENT}, timeout=20,
                          params={"action": "query", "format": "json", "formatversion": 2, **params})
    response.raise_for_status()
    return response.json()


def _first_sentences(text: str, limit: int = MAX_EXTRACT_CHARS) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("! "))
    return cut[:end + 1] if end > 120 else cut.rsplit(" ", 1)[0] + "…"


def _summary(client: httpx.Client, lang: str, title: str) -> Optional[dict]:
    response = client.get(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title.replace(' ', '_')}",
                          headers={"User-Agent": USER_AGENT}, timeout=20)
    if response.status_code != 200:
        return None
    return response.json()


def lookup_town(client: httpx.Client, name: str, lat: float, lon: float, country: str = "") -> Optional[dict]:
    """The Wikipedia article for this town, or None if there isn't a confident match nearby"""
    variants = name_variants(name)
    languages = ["en"] + [l for code in country.split(",") for l in LANGUAGES.get(code, [])[1:] if l]
    languages = list(dict.fromkeys(languages))
    for lang in languages:
        found = _api(client, lang, {"list": "geosearch", "gscoord": f"{lat}|{lon}", "gsradius": 10000,
                                    "gslimit": 100}).get("query", {}).get("geosearch", [])
        matches = [g for g in found if title_matches(g["title"], variants) and g["dist"] / 1000 <= MAX_TOWN_KM]
        if not matches:
            continue
        best = min(matches, key=lambda g: g["dist"])
        summary = _summary(client, lang, best["title"])
        if not summary or not summary.get("extract"):
            continue
        return {
            "title": summary.get("title", best["title"]),
            "lang": lang,
            "summary": _first_sentences(summary["extract"]),
            "what": summary.get("description"),
            "image": (summary.get("thumbnail") or {}).get("source"),
            "url": (summary.get("content_urls", {}).get("desktop", {}) or {}).get("page"),
            "away_km": round(best["dist"] / 1000, 1),
            "highlights": all_highlights(client, [lang] + [l for l in languages if l != lang], best["title"], lat, lon),
        }
    return None


def highlights(client: httpx.Client, lang: str, own_title: str, lat: float, lon: float) -> List[dict]:
    data = _api(client, lang, {
        "generator": "geosearch", "ggscoord": f"{lat}|{lon}", "ggsradius": HIGHLIGHT_RADIUS_M, "ggslimit": 25,
        "prop": "description|extracts|coordinates", "exintro": 1, "explaintext": 1, "exsentences": 1,
        "exlimit": "max", "colimit": "max"})
    found = []
    for page in data.get("query", {}).get("pages", []):
        if page["title"] == own_title or not page.get("description") or SKIP_HIGHLIGHT.search(page["description"]):
            continue
        coords = (page.get("coordinates") or [{}])[0]
        if "lat" not in coords:
            continue
        away = haversine_km((lat, lon), (coords["lat"], coords["lon"])) * 1000
        found.append({"title": page["title"], "what": page["description"][:80], "away_m": round(away, -1),
                      "text": _first_sentences(page.get("extract", ""), 200),
                      "url": f"https://{lang}.wikipedia.org/wiki/{page['title'].replace(' ', '_')}"})
    return sorted(found, key=lambda h: h["away_m"])[:MAX_HIGHLIGHTS]


def all_highlights(client: httpx.Client, languages: List[str], own_title: str, lat: float, lon: float) -> List[dict]:
    """English articles are thin for small villages, so fill up from the local-language Wikipedia too"""
    found, seen = [], set()
    for lang in languages:
        for h in highlights(client, lang, own_title, lat, lon):
            if normalise(h["title"]) not in seen and normalise(h["title"]) != normalise(own_title):
                seen.add(normalise(h["title"]))
                found.append(h)
        if len(found) >= MAX_HIGHLIGHTS:
            break
    return sorted(found, key=lambda h: h["away_m"])[:MAX_HIGHLIGHTS]


# ----------------------------------------------------------------------
# The stored file, and lookups for the app
# ----------------------------------------------------------------------

_info: Optional[dict] = None          # normalised name -> [entry with lat/lon, ...]
_live_cache: dict = {}


def _load() -> dict:
    global _info
    if _info is None:
        _info = json.loads(INFO_FILE.read_text(encoding="utf-8")) if INFO_FILE.exists() else {}
    return _info


def stored_town(name: str, lat: Optional[float], lon: Optional[float]) -> Optional[dict]:
    """A prescanned entry for this name that is near the given position (a name can repeat in Spain and Italy).
    Without a position (stages saved before positions were included) the first entry with that name is used."""
    best = None
    for variant in name_variants(name):
        for entry in _load().get(variant, []):
            km = haversine_km((lat, lon), (entry["lat"], entry["lon"])) if lat is not None else 0.0
            if km <= 3 and (best is None or km < best[0]):
                best = (km, entry)
    return best[1] if best else None


def town_info(name: str, lat: Optional[float], lon: Optional[float], country: str = "") -> dict:
    """Prescanned description if we have one, else a live Wikipedia lookup (cached). Blocking: call from a thread."""
    entry = stored_town(name, lat, lon)
    if entry is None and lat is None:
        return {"name": name, "found": False}
    if entry is None:
        key = (normalise(name), round(lat, 2), round(lon, 2))
        if key not in _live_cache:
            try:
                with httpx.Client() as client:
                    _live_cache[key] = lookup_town(client, name, lat, lon, country)
            except Exception as e:
                logger.warning(f"Live town lookup failed for {name}: {e}")
                return {"name": name, "found": False, "retry": True}  # not remembered, so it can be tried again
        entry = _live_cache[key]
    if not entry or entry.get("none"):
        return {"name": name, "found": False}
    return {"name": name, "found": True, "lat": lat, "lon": lon, **entry}


def build(route_keys: List[str]):
    data = load_data()
    info = json.loads(INFO_FILE.read_text(encoding="utf-8")) if INFO_FILE.exists() else {}
    with httpx.Client() as client:
        for route_key in route_keys:
            route = data["routes"][route_key]
            towns = [p for p in route["pois"] if p["kind"] == "place" and p.get("place") in ("city", "town", "village")]
            logger.info(f"{route_key}: {len(towns)} towns and villages")
            for number, town in enumerate(towns, 1):
                variants = name_variants(town["name"])
                have = info.get(variants[0], []) if variants else []
                if any(haversine_km((town["lat"], town["lon"]), (e["lat"], e["lon"])) <= 3 for e in have):
                    continue  # already done (including "nothing found": those are stored without a summary)
                try:
                    result = lookup_town(client, town["name"], town["lat"], town["lon"], route["country"])
                except Exception as e:
                    logger.warning(f"{town['name']}: {e}")
                    time.sleep(3)
                    continue
                entry = {"lat": town["lat"], "lon": town["lon"], "name": town["name"], **(result or {"none": True})}
                info.setdefault(variants[0], []).append(entry)
                logger.info(f"  {number}/{len(towns)} {town['name']}: {'found ' + result['title'] if result else 'no article'}")
                if number % 20 == 0:
                    write_atomic(INFO_FILE, json.dumps(info, ensure_ascii=False, separators=(",", ":")))
                time.sleep(0.15)
    write_atomic(INFO_FILE, json.dumps(info, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "build":
        build(sys.argv[2:] or list(load_data()["routes"]))
    elif command == "status":
        entries = [e for group in _load().values() for e in group]
        print(f"{len(entries)} towns; {sum(1 for e in entries if not e.get('none'))} with a Wikipedia article")
    else:
        print(__doc__)
