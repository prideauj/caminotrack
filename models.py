from pydantic import BaseModel
from datetime import date
from typing import Optional

class Hotel(BaseModel):
    name: str
    location: str
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class Stage(BaseModel):
    name: str
    trip_name: Optional[str] = None  # Which trip/booking this stage belongs to
    start_location: str
    end_location: str
    start_hotel: str
    end_hotel: str
    start_hotel_lat: Optional[float] = None
    start_hotel_lon: Optional[float] = None
    end_hotel_lat: Optional[float] = None
    end_hotel_lon: Optional[float] = None
    standard_distance: float  # Distance from the website
    actual_distance: float  # Calculated distance between hotels (hotel to hotel)
    date_walked: date
    is_completed: bool
    route_geojson: Optional[str] = None  # GeoJSON of the walking route

class User(BaseModel):
    id: str
    email: str
    name: str
    access_token: str
    created_at: str
