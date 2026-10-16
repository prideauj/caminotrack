# CaminoTrack - Track Your Camino de Santiago

A Python web app to track your Camino de Santiago journey with beautiful visualizations, maps, and timelines.

## Features

- 🗺️ **Interactive Map** - See your route with color-coded stages (completed vs. upcoming)
- 📅 **Timeline View** - All stages and hotels in chronological order
- 📊 **Date-based Stats** - Total distance by walking date
- 🏨 **Hotel Tracking** - See all accommodations along your journey
- 📱 **Mobile Responsive** - Works perfectly on desktop and mobile
- 🔐 **Secure Auth** - Google OAuth or email/password login
- 🔄 **Data Sync** - Automatically sync with your CaminoWays account

## Setup

### 1. Clone and Install Dependencies

```bash
cd caminotrack
pip install -r requirements.txt
```

### 2. Set Up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable OAuth 2.0
4. Create OAuth 2.0 credentials (Web application)
5. Add redirect URIs:
   - `http://localhost:8000/auth/callback` (local)
   - `https://your-app.render.com/auth/callback` (production)

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your Google OAuth credentials:
```
GOOGLE_CLIENT_ID=your_id
GOOGLE_CLIENT_SECRET=your_secret
REDIRECT_URI=http://localhost:8000/auth/callback
```

### 4. Run Locally

```bash
python main.py
```

Open http://localhost:8000 in your browser.

## Data Structure

The app scrapes the following data from your CaminoWays account:

- **Stage Name** - e.g., "Burgos to Hornillo de Camino"
- **Distance** - Standard distance and actual distance walked
- **Hotels** - Start and end accommodations
- **Date** - When you walked the stage
- **Route** - GeoJSON of the actual walking path (to be fetched from OpenRouteService)

## Deployment on Render

### 1. Create Render Account and Project

Visit [render.com](https://render.com) and create a new Web Service.

### 2. Connect GitHub Repository

- Connect your GitHub repo to Render
- Set build command: `pip install -r requirements.txt`
- Set start command: `python main.py`

### 3. Set Environment Variables

In Render dashboard, add:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `REDIRECT_URI=https://your-app.render.com/auth/callback`

### 4. Deploy

Push to your repository and Render will automatically deploy.

## Sharing with Your Wife

Simply share the URL of your deployed app. You can both log in with your own accounts or share credentials securely.

## Next Steps

1. **Refine the scraper** - Once we see the actual page structure, we'll update `scraper.py` with correct selectors
2. **Add route geometry** - Integrate OpenRouteService or similar to get actual walking routes
3. **Add photos** - Support stage photos from your journey
4. **Statistics** - Add elevation gain, pace calculations, etc.

## Architecture

```
FastAPI Backend
├── Google OAuth
├── Web Scraper (Playwright)
└── SQLite Database

Vanilla JS + Leaflet Frontend
├── Map View
├── Timeline
└── Date Stats
```

## Technologies

- **Backend**: FastAPI, Playwright, SQLite
- **Frontend**: HTML, CSS, JavaScript (Leaflet.js)
- **Hosting**: Render.com
- **Authentication**: Google OAuth 2.0

## Notes

- Password prompting for sync uses a simple `prompt()` - improve with secure credential storage in production
- Database is SQLite (works on Render but data persists only during active session - consider PostgreSQL for production)
- Route geometry currently uses placeholder markers - integrate actual GPS data

---

Happy trails! 🥾
