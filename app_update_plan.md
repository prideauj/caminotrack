# CaminoTrack: UI update plan

## 1. Where we are

The app has two tabs and a header row of four "lifetime" figures.

- **Itinerary tab**: trip picker, stage list, stage detail (metrics, route summary, places passed, lunch stops, CaminoWays details), overview.
- **Map tab**: all stages (or one) on a map, a height profile, lunch-stop dots, and a "My location" button.
- **Header figures** (total stages, completed, distance walked, distance remaining): totals across every trip. They are not clickable, they say nothing about *this* trip or *today*, and on a phone they stack into one column and push the real content a full screen down.

Your read of how people use it is right, and it is the basis of this plan:

| When | Tab | What the person needs |
|---|---|---|
| **Before setting out** (evening before, over breakfast) | Itinerary | Today's stage at a glance: how far, how hard, where the water/food is, where the hotel is, how to reach it, what the weather will do |
| **While walking** | Map | Where am I, how far to the next village or café, how much is left, am I on the route. One hand, bright sun, low battery, patchy signal |

Everything below is judged against those two moments.

## 2. What was changed first

- **Exact Google Maps links, found ahead of time.** `prescan.py` looks each food place up through the Google Places API and keeps the link only if the name matches *and* the place is within 120 m of where OpenStreetMap puts it. Food places are already kept only if within 350 m of the route, so a linked place is always near the route. No match means no link, never a wrong one. Stored in `route_data.json`. **TripAdvisor has been dropped completely**: nothing in the app or the scripts refers to it any more.
- **Why the old links failed.** They were searches (TripAdvisor's search page, and Google `query=name lat,lon`, which Google reads as one confusing text query).
- **Until a place has a verified link**, the Google Maps link opens a pin at the place's exact coordinates.
- **"The map data service is busy" was real, not a bug.** The public Overpass servers answered "at capacity" / HTTP 500 at the same moment when I tested. The mistake was design: every tap on a lunch stop made a live call to a free public service. The card now reads address, phone, website, hours and cuisine from the stored data, so it opens instantly and never waits.
- **Clickable towns**: a sheet with a short description, a photo and highlights from Wikipedia, prescanned into `town_info.json` and checked for being the right place (title match, within 8 km). Unknown towns are looked up live.

## 3. Recommended UI changes

### 3.1 Replace the lifetime header with a "Today" strip

Replace the four stat cards with one compact strip that depends on the date and the selected trip:

- **Before the trip**: "Camino Francés · starts in 12 days · 7 stages · 152 km".
- **During**: "Day 3 of 7 · Tue 22 Oct · Sarria → Portomarín · 22.5 km · Hard", with a progress bar for the trip.
- **After**: "Completed · 7 stages · 152 km · +1,148 m".

The whole strip is a tap target that jumps to the current stage. The lifetime totals move into **Overview** (where trip totals already are), as a "Across all trips" row.

### 3.2 Itinerary tab: build it for the evening before

Reorder the stage detail so the answers come first, in this order:

1. **Headline**: date, start → end (both tappable), distance, ascent/descent, difficulty badge.
2. **The day in a vertical timeline**: start hotel, villages in order with km marks, food/water stops, end hotel. Each row shows the distance from the previous one. Flag **"longest gap without food: 11 km"** (the data already exists; today it is only used in the summary text).
3. **Weather and daylight**: forecast for start and end (Open-Meteo, free, no key), sunrise and sunset.
4. **Hotels**: tonight's hotel with address, phone (tap to call), "Navigate" (opens Google/Apple Maps at the hotel's coordinates), and the luggage-transfer details that are already captured.
5. **Lunch stops**: as now, with the verified links.
6. **How hard is it, CaminoWays details**: collapsed by default; useful but secondary.

Also: a **Prev / Next day** control at the top and bottom of the detail, and a **"Pack for tomorrow"** checklist later if wanted.

### 3.3 Map tab: build it as the walking screen

Treat it as a separate mode, not a bigger copy of the itinerary map:

- **Full-bleed map** with minimal chrome (the title bar and toolbar collapse to one row).
- **Follow-me mode** (on by default when location is allowed): map recentres on the walker, with a heading arrow.
- **Progress card pinned to the bottom** (a draggable bottom sheet): "12.4 km done, 10.1 km to go", "Next village: Mercadoiro, 1.2 km", "Next food: Café Ponte, 3.4 km". Tap to expand to the height profile with a "you are here" marker.
- **Off-route warning** if the walker is more than ~150 m from the route.
- **Big tap targets** (at least 44 px), high-contrast route line, no hover-only interactions.
- **Battery and signal**: low-frequency location updates, Screen Wake Lock only while the map tab is open and following, and **offline use** (section 3.5), because rural coverage is unreliable.

### 3.4 Make the app navigable by thumb

- **Phone**: replace the top tab row with a **bottom tab bar** (Itinerary / Map), the stage list as a full screen, the detail as a full screen with a back button, and bottom sheets for towns and stops (already used for towns).
- **Stop nested scrolling on phones**: the itinerary uses a fixed-height pane (`calc(100vh - 220px)`) with its own scroll inside the page scroll, which fights the browser. On phones let the page scroll normally.

### 3.5 Offline and install (PWA)

- A web app manifest and a service worker so the app can be **added to the home screen** on iPhone/iPad and Android and opens full-screen.
- Cache the app shell, the stage data (already in the browser), and **map tiles for the selected stage's corridor** (about 1–2 MB per stage at walking zoom). A "Download for offline" button on each stage, with a visible "Offline ready" state.
- Be upfront in the UI about what needs a connection (sync, live town lookups).

## 4. Making it work on desktop, iPad and phone

One layout plan, three breakpoints, tested on all three each time:

| Width | Devices | Layout |
|---|---|---|
| under 600 px | phones | Single column, bottom tab bar, full-screen stage list and detail, bottom sheets, map as the walking screen |
| 600–1024 px | iPad portrait and landscape, small laptops | Two panes: stage list and detail side by side; the map as its own tab, or beside the detail in landscape |
| over 1024 px | desktop | Three areas: stage list, detail, and a persistent map beside them |

Specific fixes, from what I saw testing at 390 px and 820 px:

- Use `100dvh` rather than `100vh`, so iOS Safari's collapsing address bar doesn't hide the bottom of the screen.
- Respect safe areas (`env(safe-area-inset-*)`) for the notch and home bar. The town sheet already does.
- Keep every tap target at least 44 px (the chips and stage list are close; the town sheet's close button is already 44 px).
- Form inputs at 16 px or larger, otherwise iOS zooms the page when one is focused (the sync dialog).
- No functionality that only works on hover.
- Phone header: shrink the logo and buttons into one row; the stat strip from 3.1 replaces the four tall cards.
- The sync dialog is built with inline styles; move it to the shared sheet component so it behaves the same everywhere.
- Test matrix to run before each release: iPhone width (390 px), iPad portrait (820 px) and landscape (1180 px), desktop (1280 px+), each in portrait and landscape where it applies, with a real device check for GPS and the home-screen install.

## 5. Smaller improvements worth doing

- **"Places you pass"** includes hamlets (for example "O Carballal"), which have no article. Rank towns and villages first and show hamlets only when nothing else is nearby, as the town sheet's "no description" message is a poor outcome for a tap.
- **Town names elsewhere** (the stage list, the overview table, the route summary text, hotel names) are not tappable yet. The stage list and table rows are already tap targets for opening the stage, so a nested link needs care on touch screens. Option: make the summary text's town names tappable first, and add a small "ⓘ" in the stage list.
- **Data freshness**: show "Route data from OpenStreetMap, checked <date>" and a "Report a wrong place" link on each stop, since OpenStreetMap is patchy.
- **Unit toggle** (km / miles) and language later, if you share this with other walkers.
- **Accessibility**: focus states, labels on icon buttons, text contrast on the brown-and-orange theme, and reduced-motion support.

## 6. Decisions and things only you can do

1. **Google Maps place pages**: the key is in `secrets.txt` (git-ignored) and the prescan works: 5 test places checked, 4 linked. Running it for everything (`python prescan.py links`, about 3,300 places) makes one Places API text search per place. I believe the first 5,000 calls a month of that kind are free, but check your Google Cloud console for your plan before running it in full. It is safe to stop and restart.
2. **Map tiles**: the app uses the free OpenStreetMap tile server (no key; CARTO's free tiles turned out to need one). OpenStreetMap's policy forbids bulk downloading, so saving a whole stage's map for offline use is switched off unless `TILE_URL` names a provider that allows it; only the town descriptions are saved, plus the tiles you have looked at.
3. **Hosting**: installing to the home screen, location and offline all need HTTPS. Render already provides it.

## 7. Status

| Phase | What | Status |
|---|---|---|
| 1 | Today strip (3.1), responsive fixes (section 4), `dvh` and phone layout | Done |
| 2 | Itinerary reorder and timeline, weather, hotel actions (3.2) | Done |
| 3 | Walking mode on the map tab: progress sheet, follow-me, off-route warning, screen kept on (3.3) | Done |
| 4 | Home-screen install and offline (3.5) | Done |
| 5 | Polish: hamlets, nested town links, accessibility, report-a-place, km / miles (section 5) | Done, except language choice |

Notes on what was built, where it differs from the plan:

- **Longest stretch without food** and the new places-passed ranking come from the server, so a trip needs a **re-sync** to show them. Saved trips from before keep working without.
- **Height profile in walking mode**: the sheet's "Height profile" button swaps the map for the profile with a "you are here" marker, rather than showing both at once.
- **Time left** uses Naismith's rule (5 km/h plus 10 minutes per 100 m climbed), labelled as a steady pace.
- **Language choice** is not built: the interface is English only. Town descriptions use English where Wikipedia has them, otherwise the local language.
- **Not tested on real devices**: layout was checked at 390 px, 820 px and 1280 px, and offline use by stopping the server. GPS, the home-screen install and the screen wake lock need a phone.
