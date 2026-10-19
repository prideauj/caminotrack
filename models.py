from pydantic import BaseModel
from datetime import date
from typing import Optional, List

class Hotel(BaseModel):
    name: str
    location: str
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class Stage(BaseModel):
    name: str
    trip_name: Optional[str] = None  # Which trip/booking this stage belongs to
    booking_id: Optional[str] = None  # CaminoWays booking number
    status: str = "confirmed"  # "confirmed" booking or "quote" not yet booked
    description: Optional[str] = None  # Day description from the itinerary
    start_location: str
    end_location: str
    start_hotel: str
    end_hotel: str
    start_hotel_detour_km: Optional[float] = None  # walk from the route to the start hotel (estimated)
    end_hotel_detour_km: Optional[float] = None    # walk from the route to the end hotel (estimated)
    start_hotel_lat: Optional[float] = None
    start_hotel_lon: Optional[float] = None
    end_hotel_lat: Optional[float] = None
    end_hotel_lon: Optional[float] = None
    standard_distance: float  # Distance from the website
    actual_distance: float  # Distance hotel to hotel where we can work it out, else the published distance
    actual_basis: Optional[str] = None  # 'hotels' (from the hotels' positions), 'route' (between the towns on the mapped route) or None
    date_walked: date
    is_completed: bool
    route_geojson: Optional[str] = None  # GeoJSON of the walking route
    # Public route data (OpenStreetMap + open elevation data), see route_data.py
    route_name: Optional[str] = None  # e.g. "Camino Francés"
    ascent_m: Optional[float] = None
    descent_m: Optional[float] = None
    effort_km: Optional[float] = None  # distance + climb penalty, in flat-km equivalents
    difficulty_percentile: Optional[float] = None  # % of same-length stretches of the route that are easier
    difficulty: Optional[str] = None  # Easy / Moderate / Hard / Very hard
    difficulty_vs_trip: Optional[float] = None  # effort relative to the trip's average stage (1.0 = average)
    route_summary: Optional[str] = None  # Short written summary of the day
    lunch_stops: List[dict] = []  # Food places around mid-stage: name, kind, km from start, off-route metres
    food_gap: Optional[dict] = None  # Longest stretch with no food place: km, and where it runs from/to (km from the start)
    places_passed: List[dict] = []  # Villages / towns passed: name, km from start
    route_path: List[List[float]] = []  # [lat, lon] points along the stage, for the map
    elevation_profile: List[List[float]] = []  # [km from start, metres] points, for the height view
    caminoways: Optional[dict] = None  # What CaminoWays itself says about the day: hotels, inclusions, service level

class User(BaseModel):
    id: str
    email: str
    name: str
    access_token: str
    created_at: str
