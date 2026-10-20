"""
Route profiles (distance / ascent / descent) built from public data, used to enrich scraped stages.

Sources
  - Route geometry: OpenStreetMap hiking route relations, via the Overpass API
  - Elevation:      OpenTopoData (EU-DEM 25 m), falling back to Open-Meteo (Copernicus 90 m DEM)
  - Town positions: OpenStreetMap Nominatim

Run `python route_data.py build` to build route_data.json. It works in small steps and saves as it goes, so if it's
stopped, run it again and it carries on. `python route_data.py status` shows what's done; `rebuild <route>` starts a
route from scratch. That file is committed, so the running app
needs no network access for known towns (unknown towns are geocoded on demand).
`python route_data.py pois` refreshes just the food stops / villages.
`python route_data.py check <town> <town> ...` prints where towns land on each route.
"""
import gc
import hashlib
import heapq
import json
import logging
import math
import re
import sys
import time
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

DATA_FILE = Path(__file__).parent / "route_data.json"
USER_AGENT = "caminotrack/0.1 (personal hiking tracker)"
OVERPASS_URLS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

SAMPLE_STEP_KM = 0.15          # elevation sampled this often along the route
SMOOTHING_SAMPLES = 3          # moving average window, so DEM noise isn't counted as climbing
ASCENT_THRESHOLD_M = 8.0       # ignore climbs/descents smaller than this (hysteresis)
ALTERNATIVE_PENALTY = 1.3      # routing cost multiplier for variant/alternative relations
MAX_OFF_ROUTE_KM = 4.0         # a town further than this from a route isn't on it...
MAX_VARIANT_OFF_ROUTE_KM = 8.0  # ...but a trip may use a variant, so a few towns can sit this far off
MIN_TOWNS_ON_ROUTE = 0.8       # share of a trip's towns that must be within MAX_OFF_ROUTE_KM

# Effort in "flat km equivalents": Naismith's rule (+1 km per 100 m up), plus a smaller penalty for descent
ASCENT_M_PER_EFFORT_KM = 100.0
DESCENT_M_PER_EFFORT_KM = 300.0

ROUTES = {
    "camino-frances": {
        "name": "Camino Francés",
        "country": "es,fr",
        "relation_name": "Cami.o Franc.s",  # Galician sections are spelt "Camiño"
        # Ordered towns the path is routed through, so a variant can't shortcut past a main town. Each pair of
        # neighbours is one "leg": built (and saved) on its own, keeping memory low and the build resumable.
        "anchors": ["Saint-Jean-Pied-de-Port", "Roncesvalles", "Pamplona", "Puente la Reina", "Estella", "Logroño",
                    "Nájera", "Santo Domingo de la Calzada", "Belorado", "Burgos", "Castrojeriz", "Frómista",
                    "Carrión de los Condes", "Sahagún", "León", "Astorga", "Rabanal del Camino", "Ponferrada",
                    "Villafranca del Bierzo", "O Cebreiro", "Sarria", "Portomarín", "Palas de Rei", "Melide",
                    "Arzúa", "Santiago de Compostela"],
    },
    "via-francigena-tuscany": {
        "name": "Via Francigena (Tuscany)",
        "country": "it",
        "relation_name": "Via Francigena",
        "anchors": ["Lucca", "Altopascio", "San Miniato", "Gambassi Terme", "San Gimignano", "Colle di Val d'Elsa",
                    "Monteriggioni", "Siena"],
    },
}

MAX_ANCHOR_GAP_KM = 4.0        # an anchor town further than this from the route data means a bad geocode or gap
LEG_CACHE_DIR = Path(__file__).parent / "leg_cache"  # gitignored; one small file per finished leg


# ----------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------

def haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def normalise(name: str) -> str:
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"\W+", " ", name).strip().lower()


# Names as CaminoWays spells them -> something Nominatim resolves to the right town
GEOCODE_ALIASES = {
    "leon": "León",
    "puente de la reina": "Puente la Reina",
    "santiago": "Santiago de Compostela",
    "saint jean pied de port": "Saint-Jean-Pied-de-Port",
    "amenal": "O Amenal",
}


def load_data() -> dict:
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return {"geocode": {}, "routes": {}}


def write_atomic(path: Path, text: str):
    """Write via a temp file so a kill part-way through can't leave a half-written file behind"""
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8")
    temp.replace(path)


def save_data(data: dict):
    write_atomic(DATA_FILE, json.dumps(data, ensure_ascii=False, separators=(",", ":")))


_last_nominatim_call = 0.0


def place_on_routes(name: str, country: str, data: dict) -> Optional[Tuple[float, float]]:
    """A town's position from the named villages stored with the routes: instant, and no network needed.
    Only used when the name matches one place (or several close together), so a common name can't mislead."""
    wanted = normalise(name)
    found = []
    for route in data["routes"].values():
        if route.get("country") != country:
            continue
        for poi in route.get("pois", []):
            if poi["kind"] == "place" and normalise(poi["name"]) == wanted:
                found.append((poi["lat"], poi["lon"]))
    if found and all(haversine_km(found[0], other) <= 3 for other in found):
        return found[0]
    return None


def geocode(name: str, country: str, data: dict) -> Optional[Tuple[float, float]]:
    """Look a town up on Nominatim (max 1 request/second), caching results in `data`"""
    global _last_nominatim_call
    name = GEOCODE_ALIASES.get(normalise(name), name)
    key = f"{normalise(name)}|{country}"
    if key in data["geocode"]:
        cached = data["geocode"][key]
        return tuple(cached) if cached else None

    on_route = place_on_routes(name, country, data)
    if on_route:
        data["geocode"][key] = list(on_route)
        return on_route

    wait = 1.1 - (time.time() - _last_nominatim_call)
    if wait > 0:
        time.sleep(wait)
    # A structured city= search resolves the town itself; a free-text "Siena" often ranks the province first
    best = None
    for params in ({"city": name}, {"q": name}):
        response = httpx.get(
            "https://nominatim.openstreetmap.org/search",
            params={**params, "countrycodes": country, "format": "json", "limit": 8, "addressdetails": 1},
            headers={"User-Agent": USER_AGENT}, timeout=30,
        )
        _last_nominatim_call = time.time()
        response.raise_for_status()
        # Prefer the first-listed country: "León" is also the Spanish name for Lyon, which otherwise ranks first
        codes = country.split(",")
        results = sorted(response.json(), key=lambda r: codes.index(r.get("address", {}).get("country_code", ""))
                         if r.get("address", {}).get("country_code", "") in codes else len(codes))
        settlements = [r for r in results if r.get("class") == "place" and r.get("type") in ("city", "town", "village", "hamlet")]
        best = (settlements or results or [None])[0]
        if best:
            break
        time.sleep(1.1)
    data["geocode"][key] = [float(best["lat"]), float(best["lon"])] if best else None
    return tuple(data["geocode"][key]) if data["geocode"][key] else None


# ----------------------------------------------------------------------
# Building a route profile
# ----------------------------------------------------------------------

def fetch_route_ways(relation_name: str, bbox: Tuple[float, float, float, float]) -> List[Tuple[List[Tuple[float, float]], bool]]:
    """Ways of every hiking relation matching the name inside the bbox, as (points, is_alternative)"""
    south, west, north, east = bbox
    query = (f'[out:json][timeout:180];'
             f'rel["route"="hiking"]["name"~"{relation_name}"]({south},{west},{north},{east});'
             f'out geom({south},{west},{north},{east});')
    last_error = None
    elements = None
    for attempt in range(4):
        for url in OVERPASS_URLS:
            try:
                response = httpx.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=240)
                response.raise_for_status()
                elements = response.json()["elements"]
                break
            except Exception as e:  # try the next mirror, then back off and go round again
                last_error = e
        if elements is not None:
            break
        time.sleep(10 * (attempt + 1))
    if elements is None:
        raise RuntimeError(f"Overpass request failed: {last_error}")

    ways = []
    for relation in elements:
        tags = relation.get("tags", {})
        is_alternative = bool(re.search(r"altern|variant", tags.get("name", ""), re.I)) or tags.get("network") in ("lwn", "rwn")
        for member in relation.get("members", []):
            if member["type"] == "way" and member.get("geometry"):
                # Points outside the bbox come back as null: split the way there rather than joining across the gap
                points = []
                for p in member["geometry"] + [None]:
                    if p is not None:
                        points.append((p["lat"], p["lon"]))
                    else:
                        if len(points) > 1:
                            ways.append((points, is_alternative))
                        points = []
    logger.info(f"Fetched {len(ways)} ways from {len(elements)} relations")
    del elements
    return ways


class RouteGraph:
    def __init__(self, ways: List[Tuple[List[Tuple[float, float]], bool]]):
        self.adjacent: Dict[Tuple[float, float], list] = defaultdict(list)
        endpoints = set()
        for points, is_alternative in ways:
            points = [(round(lat, 6), round(lon, 6)) for lat, lon in points]
            endpoints.update((points[0], points[-1]))
            for a, b in zip(points, points[1:]):
                if a != b:
                    self._add_edge(a, b, is_alternative)
        self._bridge_gaps(endpoints)
        self.nodes = list(self.adjacent)

    def _add_edge(self, a, b, is_alternative=False):
        cost = haversine_km(a, b) * (ALTERNATIVE_PENALTY if is_alternative else 1.0)
        self.adjacent[a].append((b, cost))
        self.adjacent[b].append((a, cost))

    def _bridge_gaps(self, endpoints, max_gap_km=0.4):
        """OSM relations often have small gaps (e.g. through towns); join nearby way endpoints"""
        grid = defaultdict(list)
        for p in endpoints:
            grid[(round(p[0], 2), round(p[1], 2))].append(p)
        for p in endpoints:
            cx, cy = round(p[0], 2), round(p[1], 2)
            for dx in (-0.01, 0, 0.01):
                for dy in (-0.01, 0, 0.01):
                    for q in grid.get((round(cx + dx, 2), round(cy + dy, 2)), []):
                        if q > p and haversine_km(p, q) <= max_gap_km:
                            self._add_edge(p, q)

    def nearest_node(self, point: Tuple[float, float]) -> Tuple[Tuple[float, float], float]:
        best = min(self.nodes, key=lambda n: (n[0] - point[0]) ** 2 + ((n[1] - point[1]) * 0.75) ** 2)
        return best, haversine_km(best, point)

    def shortest_path(self, start, goal) -> List[Tuple[float, float]]:
        queue = [(0.0, start)]
        cost_to = {start: 0.0}
        came_from = {}
        while queue:
            cost, node = heapq.heappop(queue)
            if node == goal:
                break
            if cost > cost_to.get(node, math.inf):
                continue
            for neighbour, edge_cost in self.adjacent[node]:
                new_cost = cost + edge_cost
                if new_cost < cost_to.get(neighbour, math.inf):
                    cost_to[neighbour] = new_cost
                    came_from[neighbour] = node
                    heapq.heappush(queue, (new_cost, neighbour))
        if goal not in came_from and goal != start:
            raise RuntimeError("No connected path found between route anchors")
        path = [goal]
        while path[-1] != start:
            path.append(came_from[path[-1]])
        return path[::-1]


def resample(path: List[Tuple[float, float]], step_km: float) -> List[Tuple[float, float]]:
    """Points every `step_km` along the polyline"""
    points = [path[0]]
    carried = 0.0
    for a, b in zip(path, path[1:]):
        length = haversine_km(a, b)
        position = step_km - carried
        while position <= length:
            f = position / length
            points.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
            position += step_km
        carried = length - (position - step_km)
    if points[-1] != path[-1]:
        points.append(path[-1])
    return points


ELEVATION_CACHE_FILE = Path(__file__).parent / "elevation_cache.json"  # gitignored; makes rebuilds resumable


def _elevations_opentopodata(batch: List[Tuple[float, float]]) -> List[float]:
    """EU-DEM 25 m (Europe). Public API: 100 points per request, 1 request per second."""
    locations = "|".join(f"{p[0]:.5f},{p[1]:.5f}" for p in batch)
    for attempt in range(4):
        response = httpx.get("https://api.opentopodata.org/v1/eudem25m", params={"locations": locations},
                             headers={"User-Agent": USER_AGENT}, timeout=60)
        if response.status_code == 429:
            time.sleep(5 * (attempt + 1))
            continue
        response.raise_for_status()
        results = response.json()["results"]
        if any(r["elevation"] is None for r in results):
            raise RuntimeError("EU-DEM has no data for some points")
        time.sleep(1.1)
        return [r["elevation"] for r in results]
    raise RuntimeError("OpenTopoData kept rate-limiting us")


def _elevations_openmeteo(batch: List[Tuple[float, float]]) -> List[float]:
    """Copernicus 90 m DEM, worldwide. Used if OpenTopoData is unavailable."""
    params = {"latitude": ",".join(f"{p[0]:.5f}" for p in batch), "longitude": ",".join(f"{p[1]:.5f}" for p in batch)}
    response = httpx.get("https://api.open-meteo.com/v1/elevation", params=params,
                         headers={"User-Agent": USER_AGENT}, timeout=60)
    response.raise_for_status()
    time.sleep(1.0)
    return response.json()["elevation"]


def fetch_elevations(points: List[Tuple[float, float]]) -> List[float]:
    cache = json.loads(ELEVATION_CACHE_FILE.read_text()) if ELEVATION_CACHE_FILE.exists() else {}
    key = lambda p: f"{p[0]:.5f},{p[1]:.5f}"

    missing = [p for p in points if key(p) not in cache]
    try:
        for i in range(0, len(missing), 100):
            batch = missing[i:i + 100]
            try:
                elevations = _elevations_opentopodata(batch)
            except Exception as e:
                logger.info(f"  OpenTopoData failed ({e}); falling back to Open-Meteo")
                elevations = _elevations_openmeteo(batch)
            cache.update({key(p): e for p, e in zip(batch, elevations)})
            if (i // 100) % 5 == 4:
                write_atomic(ELEVATION_CACHE_FILE, json.dumps(cache))  # progress survives being killed
                logger.info(f"  elevations: {min(i + 100, len(missing))}/{len(missing)}")
    finally:
        write_atomic(ELEVATION_CACHE_FILE, json.dumps(cache))
    return [cache[key(p)] for p in points]


def smooth(values: List[float], window: int) -> List[float]:
    half = window // 2
    return [sum(values[max(0, i - half):i + half + 1]) / len(values[max(0, i - half):i + half + 1]) for i in range(len(values))]


def cumulative_ascent_descent(elevations: List[float]) -> Tuple[List[float], List[float]]:
    """Running totals of climb and descent, ignoring wiggles below ASCENT_THRESHOLD_M"""
    ascent, descent = [0.0], [0.0]
    anchor = elevations[0]
    total_up = total_down = 0.0
    for elevation in elevations[1:]:
        if elevation - anchor >= ASCENT_THRESHOLD_M:
            total_up += elevation - anchor
            anchor = elevation
        elif anchor - elevation >= ASCENT_THRESHOLD_M:
            total_down += anchor - elevation
            anchor = elevation
        ascent.append(total_up)
        descent.append(total_down)
    return ascent, descent


def _slug(name: str) -> str:
    return normalise(name).replace(" ", "-")


def route_leg(config: dict, key: str, index: int, names: Tuple[str, str], points: Tuple[tuple, tuple]) -> List[Tuple[float, float]]:
    """Path between two neighbouring anchor towns. Finished legs are kept in LEG_CACHE_DIR and reused."""
    leg_file = LEG_CACHE_DIR / f"{key}__{index:02d}_{_slug(names[0])}_{_slug(names[1])}.json"
    if leg_file.exists():
        logger.info(f"  leg {index + 1}: {names[0]} -> {names[1]} (already done)")
        return [tuple(p) for p in json.loads(leg_file.read_text())]

    a, b = points
    logger.info(f"  leg {index + 1}: {names[0]} -> {names[1]}")
    bbox = (min(a[0], b[0]) - 0.1, min(a[1], b[1]) - 0.1, max(a[0], b[0]) + 0.1, max(a[1], b[1]) + 0.1)
    graph = RouteGraph(fetch_route_ways(config["relation_name"], bbox))
    (start, start_gap), (end, end_gap) = graph.nearest_node(a), graph.nearest_node(b)
    for name, gap in ((names[0], start_gap), (names[1], end_gap)):
        if gap > MAX_ANCHOR_GAP_KM:
            raise RuntimeError(f"{name} is {gap:.1f} km from the route data; check its geocoding or the map data")
    path = graph.shortest_path(start, end)
    del graph
    gc.collect()

    LEG_CACHE_DIR.mkdir(exist_ok=True)
    write_atomic(leg_file, json.dumps([[round(lat, 6), round(lon, 6)] for lat, lon in path]))
    return path


def build_route(key: str, data: dict) -> dict:
    """Build a route profile one leg at a time. Safe to stop and rerun: finished legs and elevations are kept."""
    config = ROUTES[key]
    logger.info(f"Building {config['name']} ({len(config['anchors']) - 1} legs)")

    anchors = []
    for name in config["anchors"]:
        point = geocode(name, config["country"], data)
        if not point:
            raise RuntimeError(f"Could not geocode anchor town {name}")
        anchors.append(point)
    save_data(data)  # keep the geocoding done so far

    path: List[Tuple[float, float]] = []
    for index, (names, points) in enumerate(zip(zip(config["anchors"], config["anchors"][1:]), zip(anchors, anchors[1:]))):
        path.extend(route_leg(config, key, index, names, points))

    points = resample(path, SAMPLE_STEP_KM)
    logger.info(f"Route is {len(points) * SAMPLE_STEP_KM:.0f} km; fetching {len(points)} elevations")
    elevations = smooth(fetch_elevations(points), SMOOTHING_SAMPLES)
    ascent, descent = cumulative_ascent_descent(elevations)

    return {
        "name": config["name"],
        "country": config["country"],
        "step_km": SAMPLE_STEP_KM,
        "length_km": round((len(points) - 1) * SAMPLE_STEP_KM, 2),
        "lat": [round(p[0], 5) for p in points],
        "lon": [round(p[1], 5) for p in points],
        "elevation": [round(e, 1) for e in elevations],
        "cum_ascent": [round(a, 1) for a in ascent],
        "cum_descent": [round(d, 1) for d in descent],
    }


# ----------------------------------------------------------------------
# Food stops and villages along a route
# ----------------------------------------------------------------------

POI_WINDOW_KM = 25            # one Overpass request per this much route
POI_LINE_STEP_KM = 0.6        # spacing of the line points handed to Overpass
FOOD_MAX_OFF_ROUTE_KM = 0.35  # food places further than this from the route aren't worth the detour
PLACE_MAX_OFF_ROUTE_KM = 1.0
OVERPASS_CACHE_DIR = Path(__file__).parent / "overpass_cache"  # gitignored; one file per query, makes rebuilds resumable

FOOD_KINDS = {"restaurant": "restaurant", "cafe": "cafe", "bar": "bar", "pub": "bar", "fast_food": "fast food",
              "bakery": "bakery", "supermarket": "shop", "convenience": "shop"}


def overpass_query(query: str) -> list:
    cache_file = OVERPASS_CACHE_DIR / (hashlib.sha1(query.encode()).hexdigest() + ".json")
    if cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))
    last_error = None
    for attempt in range(5):
        for url in OVERPASS_URLS:
            try:
                response = httpx.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=240)
                response.raise_for_status()
                elements = response.json()["elements"]
                OVERPASS_CACHE_DIR.mkdir(exist_ok=True)
                cache_file.write_text(json.dumps(elements, ensure_ascii=False), encoding="utf-8")
                return elements
            except Exception as e:
                last_error = e
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass request failed: {last_error}")


def place_card_fields(tags: dict) -> dict:
    """The details of a food place worth keeping, from its OpenStreetMap tags (short keys keep the file small)"""
    street = " ".join(p for p in (tags.get("addr:street"), tags.get("addr:housenumber")) if p)
    town = " ".join(p for p in (tags.get("addr:postcode"), tags.get("addr:city")) if p)
    website = tags.get("contact:website") or tags.get("website")
    if website and not re.match(r"^https?://", website, re.I):
        website = "http://" + website
    fields = {
        "addr": ", ".join(p for p in (street, town) if p),
        "phone": tags.get("contact:phone") or tags.get("phone"),
        "web": website[:200] if website else None,
        "cuisine": (tags.get("cuisine") or "").replace(";", ", ").replace("_", " "),
    }
    return {k: v for k, v in fields.items() if v}


LINK_FIELDS = ("gm", "checked")  # added by prescan.py; kept when the food places are refreshed


def build_pois(route: dict) -> list:
    """Named food places and villages within walking distance of the route, with their position along it"""
    step = route["step_km"]
    window = round(POI_WINDOW_KM / step)
    line_every = max(1, round(POI_LINE_STEP_KM / step))
    count = len(route["lat"])
    found = {}

    for start in range(0, count, window):
        indices = list(range(start, min(count, start + window + 1), line_every))
        line = ",".join(f"{route['lat'][i]:.5f},{route['lon'][i]:.5f}" for i in indices)
        food = "|".join(k for k in FOOD_KINDS if k not in ("bakery", "supermarket", "convenience"))
        shops = "|".join(("bakery", "supermarket", "convenience"))
        query = (f'[out:json][timeout:120];('
                 f'nwr["amenity"~"^({food})$"]["name"](around:300,{line});'
                 f'nwr["shop"~"^({shops})$"]["name"](around:300,{line});'
                 f'node["place"~"^(city|town|village|hamlet)$"]["name"](around:800,{line});'
                 f');out center tags;')
        logger.info(f"  POIs {start * step:.0f}-{min(count, start + window) * step:.0f} km")
        for element in overpass_query(query):
            tags = element.get("tags", {})
            lat = element.get("lat") or element.get("center", {}).get("lat")
            lon = element.get("lon") or element.get("center", {}).get("lon")
            if lat is None:
                continue
            kind = FOOD_KINDS.get(tags.get("amenity")) or FOOD_KINDS.get(tags.get("shop")) or ("place" if "place" in tags else None)
            if not kind:
                continue
            km, off = locate(route, (lat, lon))
            if off > (PLACE_MAX_OFF_ROUTE_KM if kind == "place" else FOOD_MAX_OFF_ROUTE_KM):
                continue
            entry = {"km": round(km, 2), "kind": kind, "name": tags["name"], "off_m": round(off * 1000),
                     "lat": round(lat, 5), "lon": round(lon, 5), "osm": f"{element['type'][0]}{element['id']}"}
            if tags.get("opening_hours"):
                entry["hours"] = tags["opening_hours"][:80]
            if kind == "place":
                entry["place"] = tags["place"]
            else:
                # Everything a lunch stop's card shows is kept here, so clicking a stop never needs a live lookup
                for field, value in place_card_fields(tags).items():
                    entry[field] = value
            found[(element["type"], element["id"])] = entry

    previous = {p["osm"]: p for p in route.get("pois", []) if p.get("osm")}
    for entry in found.values():  # keep the links a prescan already verified
        for field in LINK_FIELDS:
            if field in previous.get(entry["osm"], {}):
                entry[field] = previous[entry["osm"]][field]

    pois = sorted(found.values(), key=lambda e: e["km"])
    logger.info(f"  {sum(e['kind'] != 'place' for e in pois)} food places, {sum(e['kind'] == 'place' for e in pois)} villages")
    return pois


# ----------------------------------------------------------------------
# Using route profiles
# ----------------------------------------------------------------------

def locate(route: dict, point: Tuple[float, float]) -> Tuple[float, float]:
    """(distance along the route in km, distance off the route in km) for the closest route sample"""
    lats, lons = route["lat"], route["lon"]
    scale = math.cos(math.radians(point[0]))
    i = min(range(len(lats)), key=lambda i: (lats[i] - point[0]) ** 2 + ((lons[i] - point[1]) * scale) ** 2)
    return i * route["step_km"], haversine_km((lats[i], lons[i]), point)


def candidate_positions(route: dict, point: Tuple[float, float], slack_km: float = 2.0) -> List[float]:
    """Every route position (km) within `slack_km` of the closest one. A town can sit near several parts of a
    route (it doubles back, or variants pass by), and the nearest sample isn't always the right one."""
    lats, lons = route["lat"], route["lon"]
    scale = math.cos(math.radians(point[0]))
    distances = [haversine_km((lats[i], lons[i]), point) if abs(lats[i] - point[0]) < 0.3 and abs((lons[i] - point[1]) * scale) < 0.3
                 else math.inf for i in range(len(lats))]
    nearest = min(distances)
    return [i * route["step_km"] for i, d in enumerate(distances) if d <= nearest + slack_km]


def snap_trip(route: dict, points: List[Tuple[float, float]], leg_km: List[float]) -> List[float]:
    """Positions (km along the route) of a trip's stops in walking order.

    `leg_km` are the distances between consecutive stops as published for the trip. Starting from the first
    stop, each next stop is placed at the candidate position closest to where that distance says it should be."""
    first = candidate_positions(route, points[0])
    last = candidate_positions(route, points[-1])
    # Direction of travel: pair the first/last candidates that best match the published total distance
    total = sum(leg_km)
    start, end = min(((a, b) for a in first for b in last), key=lambda ab: abs(abs(ab[1] - ab[0]) - total))
    direction = 1 if end >= start else -1

    positions = [start]
    expected = start
    for point, leg in zip(points[1:], leg_km):
        expected = positions[-1] + direction * leg
        positions.append(min(candidate_positions(route, point), key=lambda km: abs(km - expected)))
    return positions


MAX_HOTEL_OFF_ROUTE_KM = 20.0  # a hotel further than this from the route is more likely a bad position than a long walk
MAX_HOTEL_SHIFT_KM = 10.0      # ...as is one whose nearest route point is this far along from its town
DETOUR_FACTOR = 1.3            # roads to an off-route hotel are longer than the straight line


def hotel_on_route(route: dict, lat, lon, expected_km: float) -> Optional[Tuple[float, float]]:
    """(km along the route, km off it) for a hotel, taken at the route position nearest to where its town is.
    None if the hotel has no position or isn't near the route."""
    if lat is None or lon is None:
        return None
    point = (lat, lon)
    # Only route points about as close as the nearest: further ones would count a detour the hotel doesn't need
    km = min(candidate_positions(route, point, slack_km=0.25), key=lambda k: abs(k - expected_km))
    index = min(round(km / route["step_km"]), len(route["lat"]) - 1)
    off = haversine_km((route["lat"][index], route["lon"][index]), point)
    if off > MAX_HOTEL_OFF_ROUTE_KM or abs(km - expected_km) > MAX_HOTEL_SHIFT_KM:
        return None
    return km, off


def stage_geometry(route: dict, start_km: float, end_km: float, spacing_km: float = 0.3) -> Tuple[List[list], List[list]]:
    """Path ([lat, lon]) and height profile ([km from the stage start, metres]) for the part of the route walked,
    in walking order, thinned to roughly one point per `spacing_km`"""
    step = route["step_km"]
    i, j = round(start_km / step), round(end_km / step)
    direction = 1 if j >= i else -1
    every = max(1, round(spacing_km / step))
    indices = list(range(i, j, direction * every)) + [j]
    path = [[route["lat"][k], route["lon"][k]] for k in indices]
    profile = [[round(abs(k - i) * step, 2), route["elevation"][k]] for k in indices]
    return path, profile


def effort_km(distance_km: float, ascent_m: float, descent_m: float) -> float:
    return distance_km + ascent_m / ASCENT_M_PER_EFFORT_KM + descent_m / DESCENT_M_PER_EFFORT_KM


def climb_between(route: dict, start_km: float, end_km: float) -> Tuple[float, float]:
    """(ascent, descent) in metres between two points on the route, in the direction of travel"""
    step = route["step_km"]
    i, j = round(start_km / step), round(end_km / step)
    if i <= j:
        return (route["cum_ascent"][j] - route["cum_ascent"][i], route["cum_descent"][j] - route["cum_descent"][i])
    return (route["cum_descent"][i] - route["cum_descent"][j], route["cum_ascent"][i] - route["cum_ascent"][j])


def percentile_of_effort(route: dict, length_km: float, effort: float) -> float:
    """Share (0-100) of same-length stretches of the route that are easier than this one"""
    step = route["step_km"]
    n = max(1, round(length_km / step))
    count = len(route["lat"])
    efforts = []
    for i in range(0, count - n, max(1, round(0.5 / step))):
        up = route["cum_ascent"][i + n] - route["cum_ascent"][i]
        down = route["cum_descent"][i + n] - route["cum_descent"][i]
        efforts.append(effort_km(n * step, up, down))
    if not efforts:
        return 50.0
    return 100.0 * sum(1 for e in efforts if e < effort) / len(efforts)


def lunch_stops(route: dict, start_km: float, end_km: float, limit: int = 5) -> List[dict]:
    """Food places roughly mid-stage (a walker's lunchtime), best-placed first. km are from the stage start."""
    low, high = sorted((start_km, end_km))
    length = high - low
    direction = 1 if end_km >= start_km else -1
    candidates = []
    for poi in route.get("pois", []):
        if poi["kind"] == "place" or not (low + 0.5 <= poi["km"] <= high - 0.5):
            continue
        from_start = (poi["km"] - start_km) * direction
        fraction = from_start / length if length else 0.5
        candidates.append((abs(fraction - 0.55), {**poi, "km": round(from_start, 1)}))

    # Prefer stops mid-stage, drop duplicates (chains / several entries for one place)
    chosen, seen = [], set()
    for _, poi in sorted(candidates, key=lambda c: c[0]):
        if poi["name"].lower() in seen:
            continue
        seen.add(poi["name"].lower())
        chosen.append(poi)
        if len(chosen) == limit:
            break
    return sorted(chosen, key=lambda p: p["km"])


PLACE_RANK = {"city": 0, "town": 1, "village": 2, "hamlet": 3}


def _has_town_info(name: str, lat: float, lon: float) -> bool:
    """Whether a prescanned Wikipedia article exists for this place, so the app only links places with something to show"""
    from towns import stored_town  # towns imports this module
    entry = stored_town(name, lat, lon)
    return bool(entry and not entry.get("none"))


def places_passed(route: dict, start_km: float, end_km: float, limit: int = 10, max_off_m: int = 500) -> List[dict]:
    """The most significant villages / towns along the stage, in walking order (km from the stage start).
    OpenStreetMap lists every hamlet, so keep towns and villages first and cap the list."""
    low, high = sorted((start_km, end_km))
    direction = 1 if end_km >= start_km else -1
    places = {}
    for poi in route.get("pois", []):
        if poi["kind"] == "place" and low <= poi["km"] <= high and poi.get("off_m", 0) <= max_off_m:
            places.setdefault(poi["name"], {"name": poi["name"], "km": round((poi["km"] - start_km) * direction, 1),
                                            "type": poi.get("place", "village"), "lat": poi["lat"], "lon": poi["lon"],
                                            "info": _has_town_info(poi["name"], poi["lat"], poi["lon"])})
    ranked = sorted(places.values(), key=lambda p: PLACE_RANK.get(p["type"], 3))
    settlements = [p for p in ranked if p["type"] != "hamlet"]
    # Hamlets have little to say for themselves (no article, usually no services), so they only fill in a stage
    # that passes through hardly any towns or villages
    chosen = (settlements if len(settlements) >= 3 else ranked)[:limit]
    return sorted(chosen, key=lambda p: p["km"])


def longest_gap_without_food(route: dict, start_km: float, end_km: float) -> Tuple[float, float, float]:
    """(length, from, to) of the longest stretch with no food place, as km from the stage start"""
    low, high = sorted((start_km, end_km))
    direction = 1 if end_km >= start_km else -1
    stops = sorted(p["km"] for p in route.get("pois", []) if p["kind"] != "place" and low <= p["km"] <= high)
    points = [low] + stops + [high]
    a, b = max(zip(points, points[1:]), key=lambda pair: pair[1] - pair[0])
    ends = sorted(((a - start_km) * direction, (b - start_km) * direction))
    return b - a, ends[0], ends[1]


def stage_summary(stage, route: dict, start_km: float, end_km: float, ascent: float, descent: float,
                  places: List[dict], lunches: List[dict]) -> str:
    low, high = sorted((start_km, end_km))
    step = route["step_km"]
    profile = route["elevation"][round(low / step):round(high / step) + 1]
    distance = f"{stage.standard_distance:g} km"
    if stage.actual_basis == "hotels" and abs(stage.actual_distance - stage.standard_distance) >= 0.5:
        distance += f" ({stage.actual_distance:.1f} km hotel to hotel)"
    parts = [f"{stage.start_location} to {stage.end_location}: {distance} with about "
             f"{round(ascent)} m of climbing and {round(descent)} m of descent."]
    if stage.difficulty:
        parts.append(f"{stage.difficulty} for this route (harder than {round(stage.difficulty_percentile)}% of similar stretches).")
    if profile:
        parts.append(f"The route ranges from {round(min(profile))} m to {round(max(profile))} m above sea level.")
    named = [p for p in places if 1 <= p["km"] <= stage.standard_distance - 1]
    if named:
        parts.append("You pass through " + ", ".join(f"{p['name']} ({p['km']:g} km)" for p in named[:8]) + ".")
    if not route.get("pois"):
        return " ".join(parts)
    if not lunches:
        parts.append("No cafés, bars or shops were found in the map data along this stage, so carry food and water.")
    else:
        gap = longest_gap_without_food(route, start_km, end_km)[0]
        if gap >= 8:
            parts.append(f"There is a stretch of about {gap:.0f} km with no food or drink listed, so fill up beforehand.")
    return " ".join(parts)


def difficulty_label(percentile: float) -> str:
    if percentile >= 90:
        return "Very hard"
    if percentile >= 65:
        return "Hard"
    if percentile >= 35:
        return "Moderate"
    return "Easy"


def town_position(name: str, route_keys, data: dict) -> Dict[str, Tuple[float, float]]:
    """{route key: (km along, km off)} for a town"""
    positions = {}
    for key in route_keys:
        route = data["routes"][key]
        point = geocode(name, route["country"], data)
        if point:
            positions[key] = locate(route, point)
    return positions


def enrich_stages(stages: list) -> list:
    """Fill in route name, ascent/descent and difficulty on each Stage (in place). Never raises."""
    try:
        data = load_data()
        if not data["routes"]:
            logger.warning("route_data.json has no routes; run `python route_data.py build`")
            return stages
        before = len(data["geocode"])

        by_trip = defaultdict(list)
        for stage in stages:
            by_trip[stage.booking_id or stage.trip_name].append(stage)

        for trip_stages in by_trip.values():
            try:
                _enrich_trip(trip_stages, data)
            except Exception as e:  # one odd trip shouldn't cost the others their route data
                logger.error(f"Could not add route data to '{trip_stages[0].trip_name}': {e}", exc_info=True)

        if len(data["geocode"]) != before:
            save_data(data)
    except Exception as e:
        logger.error(f"Could not add route data: {e}", exc_info=True)
    return stages


def _enrich_trip(trip_stages: list, data: dict):
    towns = {s.start_location for s in trip_stages} | {s.end_location for s in trip_stages}
    positions = {t: town_position(t, data["routes"], data) for t in towns}

    # The route that every town in the trip sits on
    route_key = None
    for key in data["routes"]:
        offsets = [positions[t][key][1] for t in towns if key in positions[t]]
        if len(offsets) == len(towns) and max(offsets) <= MAX_VARIANT_OFF_ROUTE_KM \
                and sum(o <= MAX_OFF_ROUTE_KM for o in offsets) >= MIN_TOWNS_ON_ROUTE * len(towns):
            route_key = key
            break
    if route_key is None:
        logger.warning(f"Trip '{trip_stages[0].trip_name}' doesn't match a known route; no elevation data")
        return
    route = data["routes"][route_key]

    ordered = sorted(trip_stages, key=lambda st: st.date_walked)
    stops = [ordered[0].start_location] + [st.end_location for st in ordered]
    points = [geocode(name, route["country"], data) for name in stops]
    km_at = snap_trip(route, points, [st.standard_distance for st in ordered])

    for position, stage in enumerate(ordered):
        start_km, end_km = km_at[position], km_at[position + 1]
        # Hotel to hotel where we know where they are: the stage runs between the hotels, and each hotel's
        # distance off the route (there and back is counted by the neighbouring stage) is walked too
        start_hotel = hotel_on_route(route, stage.start_hotel_lat, stage.start_hotel_lon, start_km)
        end_hotel = hotel_on_route(route, stage.end_hotel_lat, stage.end_hotel_lon, end_km)
        if start_hotel:
            start_km = start_hotel[0]
        if end_hotel:
            end_km = end_hotel[0]
        route_distance = abs(end_km - start_km)
        # Leaving the route for a hotel, and rejoining it, is walked too (the stage before or after counts the other half)
        start_detour = DETOUR_FACTOR * start_hotel[1] if start_hotel else 0.0
        end_detour = DETOUR_FACTOR * end_hotel[1] if end_hotel else 0.0
        stage.actual_distance = round(route_distance + start_detour + end_detour, 1)
        stage.start_hotel_detour_km = round(start_detour, 1)
        stage.end_hotel_detour_km = round(end_detour, 1)
        stage.actual_basis = "hotels" if start_hotel and end_hotel else "route"
        ascent, descent = climb_between(route, start_km, end_km)
        stage.route_name = route["name"]
        stage.ascent_m = round(ascent)
        stage.descent_m = round(descent)
        stage.effort_km = round(effort_km(stage.standard_distance, ascent, descent), 1)
        stage.difficulty_percentile = round(percentile_of_effort(route, route_distance, effort_km(route_distance, ascent, descent)))
        stage.difficulty = difficulty_label(stage.difficulty_percentile)
        stage.places_passed = places_passed(route, start_km, end_km)
        stage.route_path, stage.elevation_profile = stage_geometry(route, start_km, end_km)
        stage.lunch_stops = lunch_stops(route, start_km, end_km)
        if route.get("pois"):
            gap, gap_from, gap_to = longest_gap_without_food(route, start_km, end_km)
            stage.food_gap = {"km": round(gap, 1), "from": round(gap_from, 1), "to": round(gap_to, 1)}
        stage.route_summary = stage_summary(stage, route, start_km, end_km, ascent, descent,
                                            stage.places_passed, stage.lunch_stops)

    mean_effort = sum(s.effort_km for s in trip_stages) / len(trip_stages)
    for stage in trip_stages:
        stage.difficulty_vs_trip = round(stage.effort_km / mean_effort, 2) if mean_effort else None


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    data = load_data()

    if command in ("build", "rebuild"):
        keys = [arg for arg in sys.argv[2:] if not arg.startswith("--")] or list(ROUTES)
        for key in keys:
            if command == "rebuild":
                data["routes"].pop(key, None)
                for leg_file in LEG_CACHE_DIR.glob(f"{key}__*.json"):
                    leg_file.unlink()
                save_data(data)
            if key not in data["routes"]:
                data["routes"][key] = build_route(key, data)
                save_data(data)  # a route only exists in the file once complete
            else:
                print(f"{key}: route already built")
            if "pois" not in data["routes"][key]:
                data["routes"][key]["pois"] = build_pois(data["routes"][key])
                save_data(data)
            route = data["routes"][key]
            print(f"{key}: {route['length_km']} km, +{route['cum_ascent'][-1]:.0f} m / -{route['cum_descent'][-1]:.0f} m, "
                  f"{sum(p['kind'] != 'place' for p in route['pois'])} food places, "
                  f"{sum(p['kind'] == 'place' for p in route['pois'])} villages")
    elif command == "status":
        for key, config in ROUTES.items():
            route = data["routes"].get(key)
            legs = len(list(LEG_CACHE_DIR.glob(f"{key}__*.json"))) if LEG_CACHE_DIR.exists() else 0
            total_legs = len(config["anchors"]) - 1
            if route:
                print(f"{key}: built ({route['length_km']} km), food/villages: {'done' if 'pois' in route else 'TODO'}")
            else:
                print(f"{key}: not built, {legs}/{total_legs} legs done")
    elif command == "pois":
        # Refresh only the food places / villages for already-built routes
        for key in (sys.argv[2:] or list(data["routes"])):
            data["routes"][key]["pois"] = build_pois(data["routes"][key])
            save_data(data)
    elif command == "check":
        for town in sys.argv[2:]:
            for key, (km, off) in town_position(town, data["routes"], data).items():
                print(f"{town:30} {key:25} km {km:7.1f}  off-route {off:5.1f} km")
        save_data(data)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
