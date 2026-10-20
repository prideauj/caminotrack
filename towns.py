"""Short descriptions and highlights for the towns and villages on the routes, from Wikipedia.

    python towns.py build [route]     # look up every town and village on the built routes (resumable)
    python towns.py english           # make the stored file English only (drops places with no English article)
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


def _get(client: httpx.Client, url: str, **kwargs) -> httpx.Response:
    """A GET that waits and tries again when Wikipedia asks us to slow down"""
    for attempt in range(6):
        response = client.get(url, headers={"User-Agent": USER_AGENT}, timeout=20, **kwargs)
        if response.status_code != 429:
            return response
        time.sleep(min(float(response.headers.get("Retry-After", 0) or 0) or 2 ** attempt, 30))
    return response


def _api(client: httpx.Client, lang: str, params: dict) -> dict:
    response = _get(client, f"https://{lang}.wikipedia.org/w/api.php",
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
    response = _get(client, f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title.replace(' ', '_')}")
    if response.status_code != 200:
        return None
    return response.json()


def english_version(client: httpx.Client, lang: str, title: str) -> Optional[dict]:
    """The English summary of an article found in another language, when English Wikipedia has one. Its page often has
    no map position, so the geographic search above misses it, but the local article links to it."""
    if lang == "en":
        return None
    links = _api(client, lang, {"prop": "langlinks", "titles": title, "lllang": "en", "redirects": 1})
    pages = links.get("query", {}).get("pages", [])
    english = next((l["title"] for page in pages for l in page.get("langlinks", [])), None)
    summary = _summary(client, "en", english) if english else None
    if not summary or not summary.get("extract"):
        return None
    return {
        "title": summary.get("title", english),
        "lang": "en",
        "summary": _first_sentences(summary["extract"]),
        "what": summary.get("description"),
        "image": (summary.get("thumbnail") or {}).get("source"),
        "url": (summary.get("content_urls", {}).get("desktop", {}) or {}).get("page"),
    }


def lookup_town(client: httpx.Client, name: str, lat: float, lon: float, country: str = "") -> Optional[dict]:
    """The English Wikipedia article for this town, or None if there isn't a confident match nearby. The app is English
    only, so an article in another language counts only if English Wikipedia has a version of it."""
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
        if lang == "en":
            summary = _summary(client, lang, best["title"])
            if not summary or not summary.get("extract"):
                continue
            entry = {
                "title": summary.get("title", best["title"]),
                "lang": "en",
                "summary": _first_sentences(summary["extract"]),
                "what": summary.get("description"),
                "image": (summary.get("thumbnail") or {}).get("source"),
                "url": (summary.get("content_urls", {}).get("desktop", {}) or {}).get("page"),
            }
        else:
            entry = english_version(client, lang, best["title"])
            if not entry:
                continue
        entry["away_km"] = round(best["dist"] / 1000, 1)
        entry["highlights"] = all_highlights(client, languages, best["title"], lat, lon)
        return entry
    return None


def english_highlights(client: httpx.Client, lang: str, found: List[dict]) -> List[dict]:
    """The highlights that English Wikipedia also has an article for, with the English title, text and link.
    Other languages' articles are dropped: the app is English only."""
    if lang == "en" or not found:
        return found
    english = {}
    for start in range(0, len(found), 50):
        batch = [h["title"] for h in found[start:start + 50]]
        data = _api(client, lang, {"prop": "langlinks", "titles": "|".join(batch), "lllang": "en", "redirects": 1,
                                   "lllimit": "max"}).get("query", {})
        redirected = {r["from"]: r["to"] for r in data.get("redirects", [])}
        links = {p["title"]: l["title"] for p in data.get("pages", []) for l in p.get("langlinks", [])}
        for title in batch:
            if links.get(redirected.get(title, title)):
                english[title] = links[redirected.get(title, title)]
    if not english:
        return []
    pages = {}
    wanted = sorted(set(english.values()))
    for start in range(0, len(wanted), 20):
        data = _api(client, "en", {"prop": "description|extracts|info", "titles": "|".join(wanted[start:start + 20]),
                                   "redirects": 1, "exintro": 1, "explaintext": 1, "exsentences": 1, "exlimit": "max",
                                   "inprop": "url"}).get("query", {})
        redirected = {r["from"]: r["to"] for r in data.get("redirects", [])}
        for page in data.get("pages", []):
            pages[page["title"]] = page
        for source, target in redirected.items():
            if target in pages:
                pages[source] = pages[target]
    result = []
    for h in found:
        page = pages.get(english.get(h["title"]))
        if not page or not page.get("description") or SKIP_HIGHLIGHT.search(page["description"]):
            continue
        result.append({**h, "title": page["title"], "what": page["description"][:80],
                       "text": _first_sentences(page.get("extract", ""), 200), "url": page.get("fullurl") or h["url"]})
    return result


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
    return english_highlights(client, lang, sorted(found, key=lambda h: h["away_m"]))[:MAX_HIGHLIGHTS]


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


def upgrade_to_english():
    """Make every stored entry English only: a town with no English article loses its entry (it stops being a link),
    and highlights without an English article are dropped"""
    info = json.loads(INFO_FILE.read_text(encoding="utf-8"))
    dropped_towns = dropped_highlights = 0
    with httpx.Client() as client:
        for entries in info.values():
            for index, entry in enumerate(entries):
                if entry.get("none"):
                    continue
                try:
                    if entry.get("lang") != "en":
                        english = english_version(client, entry["lang"], entry["title"])
                        if not english:
                            entries[index] = {"lat": entry["lat"], "lon": entry["lon"], "name": entry["name"], "none": True}
                            dropped_towns += 1
                            logger.info(f"  {entry['name']}: no English article")
                            continue
                        entry.update(english)
                    by_lang = {}
                    for h in entry.get("highlights", []):
                        by_lang.setdefault(h["url"].split("//")[1].split(".")[0], []).append(h)
                    kept = []
                    for lang, items in by_lang.items():
                        converted = english_highlights(client, lang, items)
                        dropped_highlights += len(items) - len(converted)
                        kept += converted
                    seen = set()
                    entry["highlights"] = [h for h in sorted(kept, key=lambda h: h["away_m"])
                                           if not (normalise(h["title"]) in seen or seen.add(normalise(h["title"])))
                                           and normalise(h["title"]) != normalise(entry["title"])]
                except Exception as e:
                    logger.warning(f"{entry['name']}: {e}")
                time.sleep(0.3)
    write_atomic(INFO_FILE, json.dumps(info, ensure_ascii=False, separators=(",", ":")))
    logger.info(f"{dropped_towns} towns and {dropped_highlights} highlights had no English article and were dropped")


def build(route_keys: List[str]):
    data = load_data()
    info = json.loads(INFO_FILE.read_text(encoding="utf-8")) if INFO_FILE.exists() else {}
    with httpx.Client() as client:
        for route_key in route_keys:
            route = data["routes"][route_key]
            towns = [p for p in route["pois"] if p["kind"] == "place" and p.get("place") in ("city", "town", "village", "hamlet")]
            logger.info(f"{route_key}: {len(towns)} towns, villages and hamlets")
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
    elif command == "english":
        upgrade_to_english()
    elif command == "status":
        entries = [e for group in _load().values() for e in group]
        print(f"{len(entries)} towns; {sum(1 for e in entries if not e.get('none'))} with a Wikipedia article")
    else:
        print(__doc__)
