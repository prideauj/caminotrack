from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import os
from dotenv import load_dotenv
import httpx
from datetime import datetime, date
import json
from pathlib import Path
import aiosqlite
from contextlib import asynccontextmanager

load_dotenv()

# Google OAuth config
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI", "http://localhost:8000/auth/callback")

from scraper import CaminoScraper
from models import Stage, Hotel

# Database setup
DB_PATH = "caminotrack.db"

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT,
                name TEXT,
                access_token TEXT,
                refresh_token TEXT,
                created_at TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS stages (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                trip_name TEXT,
                name TEXT,
                start_location TEXT,
                end_location TEXT,
                start_hotel TEXT,
                end_hotel TEXT,
                start_hotel_lat REAL,
                start_hotel_lon REAL,
                end_hotel_lat REAL,
                end_hotel_lon REAL,
                standard_distance REAL,
                actual_distance REAL,
                date_walked DATE,
                is_completed BOOLEAN,
                route_geojson TEXT,
                created_at TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """)
        await db.commit()

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
Path("frontend").mkdir(exist_ok=True)
if Path("frontend").exists():
    app.mount("/static", StaticFiles(directory="frontend"), name="static")

@app.get("/")
async def serve_root():
    return FileResponse("frontend/index.html")

@app.post("/scrape/{user_id}")
async def scrape_caminoways(user_id: str, request: Request):
    """Scrape stages from caminoways.com"""
    data = await request.json()
    email = data.get("email")
    password = data.get("password")

    scraper = CaminoScraper()
    try:
        stages = await scraper.scrape_stages(email, password)

        async with aiosqlite.connect(DB_PATH) as db:
            for stage in stages:
                await db.execute("""
                    INSERT OR REPLACE INTO stages
                    (id, user_id, trip_name, name, start_location, end_location,
                     start_hotel, end_hotel, start_hotel_lat, start_hotel_lon,
                     end_hotel_lat, end_hotel_lon, standard_distance, actual_distance,
                     date_walked, is_completed, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    f"{user_id}_{stage.name}",
                    user_id,
                    stage.trip_name,
                    stage.name,
                    stage.start_location,
                    stage.end_location,
                    stage.start_hotel,
                    stage.end_hotel,
                    stage.start_hotel_lat,
                    stage.start_hotel_lon,
                    stage.end_hotel_lat,
                    stage.end_hotel_lon,
                    stage.standard_distance,
                    stage.actual_distance,
                    stage.date_walked,
                    stage.is_completed,
                    datetime.now()
                ))
            await db.commit()

        return {"success": True, "stages_imported": len(stages)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/stages/{user_id}")
async def get_stages(user_id: str):
    """Get all stages for a user"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM stages WHERE user_id = ? ORDER BY date_walked",
            (user_id,)
        )
        rows = await cursor.fetchall()
        stages = [dict(row) for row in rows]
    return stages

@app.get("/api/stages/{user_id}/stats")
async def get_stats(user_id: str):
    """Get stats (total distance, completion, etc.)"""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("""
            SELECT
                COUNT(*) as total_stages,
                SUM(CASE WHEN is_completed THEN 1 ELSE 0 END) as completed_stages,
                SUM(CASE WHEN is_completed THEN actual_distance ELSE 0 END) as total_distance,
                SUM(CASE WHEN NOT is_completed THEN actual_distance ELSE 0 END) as remaining_distance
            FROM stages
            WHERE user_id = ?
        """, (user_id,))
        row = await cursor.fetchone()
        row = await cursor.fetchone()

    if row:
        return {
            "total_stages": row[0],
            "completed_stages": row[1],
            "total_distance": row[2] or 0,
            "remaining_distance": row[3] or 0
        }
    return {
        "total_stages": 0,
        "completed_stages": 0,
        "total_distance": 0,
        "remaining_distance": 0
    }

@app.get("/api/stages/{user_id}/by-date")
async def get_stages_by_date(user_id: str):
    """Get stages grouped by date with total distance"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                date_walked,
                COUNT(*) as stage_count,
                SUM(actual_distance) as total_distance
            FROM stages
            WHERE user_id = ?
            GROUP BY date_walked
            ORDER BY date_walked DESC
        """, (user_id,))
        rows = await cursor.fetchall()
        data = [dict(row) for row in rows]
    return data

@app.get("/api/stages/{user_id}/timeline")
async def get_timeline(user_id: str):
    """Get timeline view with hotels and services"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                id, trip_name, name, start_location, end_location,
                start_hotel, end_hotel, standard_distance, actual_distance,
                date_walked, is_completed
            FROM stages
            WHERE user_id = ?
            ORDER BY date_walked
        """, (user_id,))
        rows = await cursor.fetchall()
        timeline = [dict(row) for row in rows]
    return timeline

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
