// The server keeps no user data: a sync returns the stages and this page stores them in the browser.
const STORAGE_KEY = 'caminotrack.stages.v1';

const state = {
    stages: [],
    tripKey: null,        // selected trip (column 1)
    stageId: null,        // selected stage (column 2)
    detailTab: 'general', // 'general' | 'caminoways' (column 3)
    mapMode: 'route',     // 'route' | 'height', shared by every route view
    mapScope: 'trip',     // 'trip' | 'stage', for the Map tab
    pane: 'trips',        // which column shows on narrow screens
    user: null,           // { lat, lon, acc } from the browser's location
    watchId: null,
    locateError: null
};

const views = new Set();   // live RouteViews, so a location update reaches all of them
let miniView = null;       // route view inside the stage detail
let mapTabView = null;     // route view on the Map tab

const $ = id => document.getElementById(id);

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

const DIFFICULTY_COLORS = { 'Easy': '#4CAF50', 'Moderate': '#FFC107', 'Hard': '#FF9800', 'Very hard': '#E53935' };
const FOOD_ICONS = { 'restaurant': '🍽️', 'cafe': '☕', 'bar': '🍺', 'bakery': '🥖', 'shop': '🛒', 'fast food': '🍔' };

function escapeHtml(text) {
    const el = document.createElement('div');
    el.textContent = text == null ? '' : text;
    return el.innerHTML;
}

// Links come from scraped pages, so only ever follow plain web links
function safeUrl(url) {
    return /^https?:\/\//i.test(url || '') ? url : null;
}

function stageIdOf(stage) {
    return `${stage.booking_id || stage.trip_name}_${stage.date_walked}`;
}

function tripKeyOf(stage) {
    return stage.booking_id || stage.trip_name || 'trip';
}

function formatDate(iso, long) {
    const date = new Date(iso + 'T00:00:00');
    return date.toLocaleDateString(undefined, long
        ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
        : { weekday: 'short', day: 'numeric', month: 'short' });
}

function difficultyBadge(stage) {
    if (!stage.difficulty) return '';
    const color = DIFFICULTY_COLORS[stage.difficulty] || '#999';
    return `<span class="badge" style="background: ${color};">${escapeHtml(stage.difficulty)}</span>`;
}

function describeVsRoute(stage) {
    if (stage.difficulty_percentile == null) return '';
    const p = Math.round(stage.difficulty_percentile);
    return p >= 50 ? `Harder than ${p}% of similar-length stretches of the ${escapeHtml(stage.route_name)}`
                   : `Easier than ${100 - p}% of similar-length stretches of the ${escapeHtml(stage.route_name)}`;
}

function describeVsTrip(stage) {
    if (stage.difficulty_vs_trip == null) return '';
    const pct = Math.round((stage.difficulty_vs_trip - 1) * 100);
    if (Math.abs(pct) < 5) return "About average for this trip";
    return pct > 0 ? `${pct}% harder than this trip's average day` : `${-pct}% easier than this trip's average day`;
}

function kmBetween(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// ----------------------------------------------------------------------
// Data
// ----------------------------------------------------------------------

function loadSavedStages() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved && Array.isArray(saved.stages)) {
            state.stages = saved.stages;
        }
    } catch (error) {
        console.error('Could not read saved stages:', error);
    }
    refreshAll();
}

function saveStages() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), stages: state.stages }));
    } catch (error) {
        // Route lines make the data bigger than before; say so rather than silently losing it
        console.error('Could not save stages:', error);
    }
}

// Group stages into trips (by booking), each with totals
function buildTrips() {
    const groups = new Map();
    [...state.stages]
        .sort((a, b) => a.date_walked.localeCompare(b.date_walked))
        .forEach(stage => {
            const key = tripKeyOf(stage);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(stage);
        });

    const sum = (list, field) => list.reduce((total, s) => total + (s[field] || 0), 0);
    return [...groups.entries()].map(([key, stages]) => ({
        key,
        name: stages[0].trip_name || 'Trip',
        routeName: (stages.find(s => s.route_name) || {}).route_name,
        stages,
        km: sum(stages, 'actual_distance'),
        ascent: sum(stages, 'ascent_m'),
        descent: sum(stages, 'descent_m'),
        hasClimb: stages.some(s => s.ascent_m != null),
        start: stages[0].date_walked,
        end: stages[stages.length - 1].date_walked,
        done: stages.filter(s => s.is_completed).length
    })).sort((a, b) => a.start.localeCompare(b.start));
}

function currentTrip(trips) {
    return trips.find(t => t.key === state.tripKey) || null;
}

function currentStage() {
    return state.stages.find(s => stageIdOf(s) === state.stageId) || null;
}

function refreshAll() {
    const today = new Date().toISOString().slice(0, 10);
    // Completion depends on today's date, so work it out now rather than trusting the value saved at sync time
    state.stages.forEach(stage => { stage.is_completed = stage.date_walked < today; });

    const trips = buildTrips();
    if (!currentTrip(trips)) {
        // Open on the next trip still to walk, or the latest one
        const next = trips.find(t => t.done < t.stages.length) || trips[trips.length - 1];
        state.tripKey = next ? next.key : null;
        state.stageId = null;
    }
    const trip = currentTrip(trips);
    if (trip && !trip.stages.some(s => stageIdOf(s) === state.stageId)) {
        const nextStage = trip.stages.find(s => !s.is_completed) || trip.stages[0];
        state.stageId = stageIdOf(nextStage);
    }

    updateStats();
    renderItinerary(trips);
    renderMapTab();
}

function updateStats() {
    const completed = state.stages.filter(s => s.is_completed);
    const sum = list => list.reduce((total, s) => total + (s.actual_distance || 0), 0);
    $('totalStages').textContent = state.stages.length;
    $('completedStages').textContent = completed.length;
    $('totalDistance').textContent = sum(completed).toFixed(1) + ' km';
    $('remainingDistance').textContent = sum(state.stages.filter(s => !s.is_completed)).toFixed(1) + ' km';
}

// ----------------------------------------------------------------------
// Itinerary: trips | stages | details
// ----------------------------------------------------------------------

function renderItinerary(trips) {
    const mail = $('mail');
    mail.dataset.pane = state.pane;

    if (!state.stages.length) {
        $('tripsPane').innerHTML = '';
        $('stagesPane').innerHTML = '';
        $('detailPane').innerHTML = '';
        destroyMiniView();
        mail.classList.add('hidden');
        $('emptyState').classList.remove('hidden');
        return;
    }
    mail.classList.remove('hidden');
    $('emptyState').classList.add('hidden');

    renderTrips(trips);
    renderStages(trips);
    renderDetail();
}

function activate(el, handler) {
    el.addEventListener('click', handler);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
}

function renderTrips(trips) {
    const pane = $('tripsPane');
    pane.innerHTML = '<div class="pane-head">Trips</div>';
    trips.forEach(trip => {
        const item = document.createElement('div');
        item.className = 'list-item' + (trip.key === state.tripKey ? ' selected' : '');
        item.tabIndex = 0;
        const allDone = trip.done === trip.stages.length;
        item.innerHTML = `
            <div class="item-title">${escapeHtml(trip.name)}</div>
            ${trip.routeName ? `<div class="item-sub">${escapeHtml(trip.routeName)}</div>` : ''}
            <div class="item-sub">${formatDate(trip.start)} – ${formatDate(trip.end)}</div>
            <div class="item-meta">
                ${trip.stages.length} stages · ${trip.km.toFixed(0)} km${trip.hasClimb ? ` · ⬆ ${Math.round(trip.ascent)} m` : ''}
            </div>
            <div class="progress" title="${trip.done} of ${trip.stages.length} stages walked">
                <div style="width: ${100 * trip.done / trip.stages.length}%; background: ${allDone ? 'var(--success)' : 'var(--warning)'};"></div>
            </div>`;
        activate(item, () => {
            if (state.tripKey !== trip.key) {
                state.tripKey = trip.key;
                state.stageId = null;
            }
            state.pane = 'stages';
            refreshAll();
        });
        pane.appendChild(item);
    });
}

function renderStages(trips) {
    const trip = currentTrip(trips);
    const pane = $('stagesPane');
    if (!trip) { pane.innerHTML = ''; return; }

    pane.innerHTML = `
        <div class="pane-head"><button class="back-btn" data-back="trips">‹ Trips</button>
            <span>${escapeHtml(trip.name)}</span></div>`;
    trip.stages.forEach((stage, index) => {
        const item = document.createElement('div');
        item.className = 'list-item' + (stageIdOf(stage) === state.stageId ? ' selected' : '');
        item.tabIndex = 0;
        item.innerHTML = `
            <div class="item-row">
                <div class="item-title">${escapeHtml(stage.start_location)} → ${escapeHtml(stage.end_location)}</div>
                <span class="status" title="${stage.is_completed ? 'Walked' : 'Upcoming'}">${stage.is_completed ? '✅' : '⏳'}</span>
            </div>
            <div class="item-sub">Day ${index + 1} · ${formatDate(stage.date_walked)}</div>
            <div class="item-meta">
                ${(stage.actual_distance || 0).toFixed(0)} km
                ${stage.ascent_m != null ? ` · ⬆ ${Math.round(stage.ascent_m)} m ⬇ ${Math.round(stage.descent_m)} m` : ''}
                ${difficultyBadge(stage)}
            </div>`;
        activate(item, () => selectStageById(stageIdOf(stage), 'detail'));
        pane.appendChild(item);
    });
}

function selectStageById(id, pane) {
    state.stageId = id;
    if (pane) state.pane = pane;
    refreshAll();
}

function renderDetail() {
    const pane = $('detailPane');
    destroyMiniView();
    const stage = currentStage();
    if (!stage) { pane.innerHTML = ''; return; }

    pane.innerHTML = `
        <div class="pane-head"><button class="back-btn" data-back="stages">‹ Stages</button>
            <span>${escapeHtml(stage.name)}</span></div>
        <div class="detail-body">
            <h2>${escapeHtml(stage.start_location)} → ${escapeHtml(stage.end_location)}</h2>
            <div class="detail-sub">${formatDate(stage.date_walked, true)} ·
                ${stage.is_completed ? '✅ Walked' : '⏳ Upcoming'}</div>
            <div class="segmented">
                <button data-seg="general" class="${state.detailTab === 'general' ? 'active' : ''}">General</button>
                <button data-seg="caminoways" class="${state.detailTab === 'caminoways' ? 'active' : ''}">CaminoWays</button>
            </div>
            <div id="detailContent">${state.detailTab === 'general' ? generalHtml(stage) : caminowaysHtml(stage)}</div>
        </div>`;

    pane.querySelectorAll('[data-seg]').forEach(button => {
        button.addEventListener('click', () => {
            state.detailTab = button.dataset.seg;
            renderDetail();
        });
    });

    if (state.detailTab === 'general') {
        const host = $('miniRoute');
        if (host) {
            miniView = new RouteView(host, { height: 280 });
            miniView.setData([stage], stageIdOf(stage));
        }
    }
}

function metric(label, value) {
    return `<div class="metric"><div class="metric-value">${value}</div><div class="metric-label">${label}</div></div>`;
}

// General: what we know about the stage from public route data
function generalHtml(stage) {
    const hasRoute = stage.route_path && stage.route_path.length > 1;
    const hasClimb = stage.ascent_m != null;
    const lunches = stage.lunch_stops || [];
    const places = stage.places_passed || [];
    const total = stage.standard_distance || stage.actual_distance || 0;

    return `
        <div class="metrics">
            ${metric('Distance', `${total.toFixed(1)} km`)}
            ${hasClimb ? metric('Ascent', `⬆ ${Math.round(stage.ascent_m)} m`) : ''}
            ${hasClimb ? metric('Descent', `⬇ ${Math.round(stage.descent_m)} m`) : ''}
            ${stage.difficulty ? metric('Difficulty', difficultyBadge(stage)) : ''}
        </div>

        ${hasRoute ? '<div id="miniRoute"></div>' : `
            <div class="note-box">No route data for this trip yet. Maps, height profiles, climb and lunch stops are available for the
            Camino Francés and the Via Francigena in Tuscany.</div>`}

        ${stage.route_summary ? `
            <section><h4>🗺 Route summary</h4><p>${escapeHtml(stage.route_summary)}</p></section>` : ''}

        ${hasClimb ? `
            <section><h4>⛰ How hard is it?</h4>
                <p>${describeVsRoute(stage)}.<br>${describeVsTrip(stage)}.</p>
                <p class="small">Effort ${(stage.effort_km || 0).toFixed(1)} flat-km equivalent (distance plus a penalty for climbing).
                Estimated from OpenStreetMap routes and open elevation data, so treat as approximate.</p>
            </section>` : ''}

        ${places.length ? `
            <section><h4>🏘 Places you pass</h4>
                <div class="chips">${places.map(p => `<span class="chip">${escapeHtml(p.name)} <small>km ${p.km.toFixed(1)}</small></span>`).join('')}</div>
            </section>` : ''}

        ${lunches.length ? `
            <section><h4>🍴 Lunch stops</h4>
                <div class="lunch-list">
                    ${lunches.map(stop => `
                        <div class="lunch">
                            <span>${FOOD_ICONS[stop.kind] || '🍴'} <strong>${escapeHtml(stop.name)}</strong>
                                <span class="muted">(${escapeHtml(stop.kind)}${stop.off_m > 50 ? `, ${stop.off_m} m off route` : ''})</span>
                                ${stop.hours ? `<br><small class="muted">🕒 ${escapeHtml(stop.hours)}</small>` : ''}
                            </span>
                            <span class="muted nowrap">km ${stop.km.toFixed(1)} of ${total.toFixed(0)}</span>
                        </div>`).join('')}
                </div>
                <p class="small">From OpenStreetMap, so opening times and closures aren't guaranteed. Check ahead, and carry water and a snack.</p>
            </section>` : ''}`;
}

function hotelCard(label, hotel, fallbackName) {
    if (!hotel && !fallbackName) return '';
    const h = hotel || { name: fallbackName };
    const mapUrl = safeUrl(h.map_url);
    const phone = (h.phone || '').replace(/[^\d+]/g, '');
    const address = (h.address || '').replace(/\b(\d{4,5}),\s*\1\b/g, '$1');
    return `
        <div class="hotel">
            <div class="hotel-label">${label}</div>
            <div class="hotel-name">🏨 ${escapeHtml(h.name)}</div>
            ${h.board ? `<div class="muted">${escapeHtml(h.board)}</div>` : ''}
            ${address ? `<div>📍 ${escapeHtml(address)}</div>` : ''}
            ${phone ? `<div>📞 <a href="tel:${phone}">${escapeHtml(h.phone)}</a></div>` : ''}
            ${h.reservation ? `<div>🔖 Reservation ${escapeHtml(h.reservation)}</div>` : ''}
            ${h.check_in ? `<div class="muted">Stay ${formatDate(h.check_in)} – ${formatDate(h.check_out)}</div>` : ''}
            ${mapUrl ? `<div><a href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">Open in maps ↗</a></div>` : ''}
        </div>`;
}

// CaminoWays: what the booking itself says
function caminowaysHtml(stage) {
    const cw = stage.caminoways || {};
    const included = cw.included || [];
    return `
        <section>
            <h4>📋 Your booking</h4>
            <div class="chips">
                ${cw.service_level ? `<span class="chip" title="${escapeHtml(cw.service_level.name)}">${escapeHtml(cw.service_level.name)} service</span>` : ''}
                ${cw.nights ? `<span class="chip">🌙 ${cw.nights} night${cw.nights > 1 ? 's' : ''}</span>` : ''}
                ${included.map(item => `<span class="chip">✔ ${escapeHtml(item)}</span>`).join('')}
            </div>
            ${stage.booking_id ? `<p class="small">CaminoWays booking ${escapeHtml(stage.booking_id)}</p>` : ''}
        </section>

        <section>
            <h4>🏨 Accommodation</h4>
            <div class="hotels">
                ${hotelCard('Night before', cw.start_hotel, stage.start_hotel)}
                ${hotelCard('Tonight', cw.end_hotel, stage.end_hotel)}
            </div>
        </section>

        ${stage.description ? `
            <section><h4>📖 Today's walk, from CaminoWays</h4><p>${escapeHtml(stage.description)}</p></section>` : ''}`;
}

// ----------------------------------------------------------------------
// Route view: map or height profile, with the user's location overlaid
// ----------------------------------------------------------------------

function destroyMiniView() {
    if (miniView) { miniView.destroy(); miniView = null; }
}

class RouteView {
    constructor(host, { height }) {
        this.host = host;
        host.classList.add('rv');
        host.innerHTML = `
            <div class="rv-toolbar">
                <div class="segmented small">
                    <button data-mode="route">🗺 Route</button>
                    <button data-mode="height">⛰ Height</button>
                </div>
                <button class="rv-locate"></button>
            </div>
            <div class="rv-note"></div>
            <div class="rv-body" style="height: ${height}px;">
                <div class="rv-map"></div>
                <div class="rv-chart hidden"><canvas></canvas></div>
                <div class="rv-empty hidden"></div>
            </div>`;
        this.mapEl = host.querySelector('.rv-map');
        this.chartEl = host.querySelector('.rv-chart');
        this.emptyEl = host.querySelector('.rv-empty');
        this.noteEl = host.querySelector('.rv-note');
        this.stages = [];
        this.map = null;
        this.chart = null;

        host.querySelectorAll('[data-mode]').forEach(button => {
            button.addEventListener('click', () => setMapMode(button.dataset.mode));
        });
        host.querySelector('.rv-locate').addEventListener('click', toggleLocate);
        views.add(this);
        this.updateButtons();
    }

    // stages: stages to show, in order. focusId: the stage to emphasise.
    setData(stages, focusId) {
        this.focusId = focusId;
        this.stages = stages.filter(s => s.route_path && s.route_path.length > 1);
        this.track = [];       // every point along the route with its distance from the start
        this.points = [];      // height profile {x: km, y: metres}
        this.boundaries = [];  // where each stage starts and ends along the x axis

        let offset = 0;
        this.stages.forEach(stage => {
            const profile = stage.elevation_profile || [];
            const boundary = { id: stageIdOf(stage), start: offset, end: offset };
            stage.route_path.forEach((point, k) => {
                const km = profile[k] ? profile[k][0] : (k / (stage.route_path.length - 1)) * (stage.standard_distance || 0);
                this.track.push({ lat: point[0], lon: point[1], x: offset + km, y: profile[k] ? profile[k][1] : null });
                if (profile[k]) this.points.push({ x: offset + km, y: profile[k][1] });
            });
            offset = this.track[this.track.length - 1].x;
            boundary.end = offset;
            this.boundaries.push(boundary);
        });
        this.render(true);
    }

    updateButtons() {
        this.host.querySelectorAll('[data-mode]').forEach(button => {
            button.classList.toggle('active', button.dataset.mode === state.mapMode);
        });
        this.host.querySelector('.rv-locate').textContent = state.watchId != null ? '📍 Stop locating' : '📍 My location';
    }

    render(fit) {
        this.updateButtons();
        const hasData = this.stages.length > 0;
        const showMap = hasData && state.mapMode === 'route';
        const showChart = hasData && state.mapMode === 'height';
        this.mapEl.classList.toggle('hidden', !showMap);
        this.chartEl.classList.toggle('hidden', !showChart);
        this.emptyEl.classList.toggle('hidden', hasData);
        if (!hasData) {
            this.emptyEl.textContent = 'No route data for this trip yet.';
        } else if (showMap) {
            this.renderMap(fit);
        } else {
            this.renderChart();
        }
        this.updateNote();
    }

    renderMap(fit) {
        if (!this.map) {
            this.map = L.map(this.mapEl);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19
            }).addTo(this.map);
            this.routeLayer = L.layerGroup().addTo(this.map);
            this.userLayer = L.layerGroup().addTo(this.map);
            fit = true;
        }
        this.routeLayer.clearLayers();

        const bounds = [];
        const several = this.stages.length > 1;
        this.stages.forEach((stage, index) => {
            const id = stageIdOf(stage);
            const focused = id === this.focusId;
            const color = stage.is_completed ? '#2e7d32' : '#e65100';
            const line = L.polyline(stage.route_path, {
                color,
                weight: focused && several ? 7 : 5,
                opacity: focused || !several ? 0.95 : 0.55
            }).addTo(this.routeLayer);
            line.bindTooltip(`${escapeHtml(stage.start_location)} → ${escapeHtml(stage.end_location)} · ${(stage.actual_distance || 0).toFixed(0)} km`, { sticky: true });
            if (several) line.on('click', () => selectStageById(id));
            bounds.push(...stage.route_path);

            const end = stage.route_path[stage.route_path.length - 1];
            L.circleMarker(end, { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
                .bindTooltip(escapeHtml(stage.end_location), { permanent: !several || focused, direction: 'top', offset: [0, -6] })
                .addTo(this.routeLayer);
            if (index === 0) {
                L.circleMarker(stage.route_path[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#1565c0', fillOpacity: 1 })
                    .bindTooltip(escapeHtml(stage.start_location), { permanent: !several, direction: 'top', offset: [0, -6] })
                    .addTo(this.routeLayer);
            }
        });

        this.drawUser();
        requestAnimationFrame(() => {
            this.map.invalidateSize();
            if (fit) this.map.fitBounds(bounds, { padding: [24, 24] });
        });
    }

    drawUser() {
        if (!this.map) return;
        this.userLayer.clearLayers();
        if (!state.user) return;
        const here = [state.user.lat, state.user.lon];
        if (state.user.acc) {
            L.circle(here, { radius: state.user.acc, color: '#1976d2', weight: 1, fillColor: '#1976d2', fillOpacity: 0.12 }).addTo(this.userLayer);
        }
        L.circleMarker(here, { radius: 8, color: '#fff', weight: 3, fillColor: '#1976d2', fillOpacity: 1 })
            .bindTooltip('You are here', { direction: 'top', offset: [0, -8] })
            .addTo(this.userLayer);
    }

    renderChart() {
        if (this.chart) { this.chart.destroy(); this.chart = null; }
        const view = this;
        const overlay = {
            id: 'routeOverlay',
            beforeDatasetsDraw(chart) {
                // Shade the focused stage when several are shown
                if (view.boundaries.length < 2) return;
                const focus = view.boundaries.find(b => b.id === view.focusId);
                if (!focus) return;
                const { ctx, chartArea, scales } = chart;
                const x0 = scales.x.getPixelForValue(focus.start), x1 = scales.x.getPixelForValue(focus.end);
                ctx.save();
                ctx.fillStyle = 'rgba(255, 193, 7, 0.2)';
                ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
                ctx.restore();
            },
            afterDatasetsDraw(chart) {
                const { ctx, chartArea, scales } = chart;
                ctx.save();
                // Stage boundaries
                ctx.strokeStyle = 'rgba(0,0,0,0.25)';
                ctx.setLineDash([4, 4]);
                view.boundaries.slice(1).forEach(boundary => {
                    const x = scales.x.getPixelForValue(boundary.start);
                    ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
                });
                // The user
                const here = view.userOnRoute;
                if (here && here.offKm <= 3) {
                    const x = scales.x.getPixelForValue(here.x);
                    ctx.setLineDash([]);
                    ctx.strokeStyle = '#1976d2'; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
                    if (here.y != null) {
                        const y = scales.y.getPixelForValue(here.y);
                        ctx.fillStyle = '#1976d2'; ctx.strokeStyle = '#fff';
                        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                    }
                    ctx.fillStyle = '#1976d2';
                    ctx.font = '12px sans-serif';
                    ctx.textAlign = x > chartArea.right - 70 ? 'right' : 'left';
                    ctx.fillText('You are here', x + (ctx.textAlign === 'left' ? 6 : -6), chartArea.top + 14);
                }
                ctx.restore();
            }
        };

        this.chart = new Chart(this.chartEl.querySelector('canvas'), {
            type: 'line',
            data: { datasets: [{
                data: this.points,
                parsing: false,
                borderColor: '#8B4513',
                backgroundColor: 'rgba(210, 105, 30, 0.25)',
                fill: true,
                pointRadius: 0,
                borderWidth: 2,
                tension: 0.15
            }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                scales: {
                    x: { type: 'linear', title: { display: true, text: 'Distance (km)' }, min: 0, max: this.points.length ? this.points[this.points.length - 1].x : 1 },
                    y: { title: { display: true, text: 'Height (m)' } }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: {
                        title: items => `km ${items[0].parsed.x.toFixed(1)}`,
                        label: item => `${Math.round(item.parsed.y)} m`
                    } }
                }
            },
            plugins: [overlay]
        });
    }

    // Where the user is along this route (nearest route point), and how far off it
    locateUser() {
        this.userOnRoute = null;
        if (!state.user || !this.track || !this.track.length) return;
        const here = { lat: state.user.lat, lon: state.user.lon };
        let best = null;
        this.track.forEach(point => {
            const d = kmBetween(here, point);
            if (!best || d < best.offKm) best = { offKm: d, x: point.x, y: point.y };
        });
        this.userOnRoute = best;
    }

    updateNote() {
        this.locateUser();
        let text = '';
        if (state.locateError) {
            text = `📍 ${state.locateError}`;
        } else if (state.watchId != null && !state.user) {
            text = '📍 Finding your location…';
        } else if (this.userOnRoute) {
            const { offKm, x } = this.userOnRoute;
            const away = offKm < 0.1 ? 'on the route' : offKm < 1 ? `${Math.round(offKm * 1000)} m from the route` : `${offKm.toFixed(1)} km from the route`;
            text = offKm > 3
                ? `📍 You are ${away}, too far to place on this route.`
                : `📍 You are ${away}, ${x.toFixed(1)} km along.`;
        }
        this.noteEl.textContent = text;
        this.noteEl.classList.toggle('hidden', !text);
    }

    setUser() {
        this.updateNote();
        if (state.mapMode === 'route') this.drawUser();
        else if (this.chart) this.chart.draw();
    }

    resize() {
        if (this.map && state.mapMode === 'route') this.map.invalidateSize();
        if (this.chart) this.chart.resize();
    }

    destroy() {
        views.delete(this);
        if (this.chart) this.chart.destroy();
        if (this.map) this.map.remove();
        this.host.innerHTML = '';
    }
}

function setMapMode(mode) {
    state.mapMode = mode;
    views.forEach(view => view.render(true));
}

function toggleLocate() {
    if (state.watchId != null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
        state.user = null;
        state.locateError = null;
        views.forEach(view => { view.updateButtons(); view.setUser(); });
        return;
    }
    if (!navigator.geolocation) {
        state.locateError = "Your browser can't share its location.";
        views.forEach(view => view.updateNote());
        return;
    }
    state.locateError = null;
    state.watchId = navigator.geolocation.watchPosition(
        position => {
            state.user = { lat: position.coords.latitude, lon: position.coords.longitude, acc: position.coords.accuracy };
            state.locateError = null;
            views.forEach(view => view.setUser());
        },
        error => {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
            state.user = null;
            state.locateError = error.code === 1
                ? 'Location permission was denied. Allow it in your browser settings to see where you are.'
                : "Couldn't get your location.";
            views.forEach(view => { view.updateButtons(); view.setUser(); });
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );
    views.forEach(view => { view.updateButtons(); view.updateNote(); });
}

// ----------------------------------------------------------------------
// Map tab
// ----------------------------------------------------------------------

function renderMapTab() {
    const host = $('mapRoute');
    if (!state.stages.length) {
        if (mapTabView) { mapTabView.destroy(); mapTabView = null; }
        return;
    }
    if (!mapTabView) {
        mapTabView = new RouteView(host, { height: Math.max(420, window.innerHeight - 360) });
    }

    const trip = currentTrip(buildTrips());
    const stage = currentStage();
    const stages = state.mapScope === 'stage' && stage ? [stage] : (trip ? trip.stages : []);
    $('mapScope').value = state.mapScope;
    $('mapTitle').textContent = state.mapScope === 'stage' && stage ? stage.name : (trip ? trip.name : '');
    mapTabView.setData(stages, stage ? stageIdOf(stage) : null);
}

// ----------------------------------------------------------------------
// Tabs, events, sync
// ----------------------------------------------------------------------

function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
    $(tabName + 'Tab').classList.remove('hidden');
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    // Maps and charts drawn while hidden have no size, so redraw them now they're visible
    setTimeout(() => views.forEach(view => { view.resize(); if (view === mapTabView || view === miniView) view.render(true); }), 50);
}

function setupEventListeners() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    $('logoutBtn').addEventListener('click', clearData);
    $('syncBtn').addEventListener('click', openSyncDialog);
    $('mapScope').addEventListener('change', e => { state.mapScope = e.target.value; renderMapTab(); });

    // "‹ Trips" / "‹ Stages" buttons for narrow screens, where one column shows at a time
    $('mail').addEventListener('click', e => {
        const back = e.target.closest('[data-back]');
        if (back) { state.pane = back.dataset.back; $('mail').dataset.pane = state.pane; }
    });
    window.addEventListener('resize', () => views.forEach(view => view.resize()));
}

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadSavedStages();
});

function openSyncDialog() {
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 2000;
    `;
    modal.innerHTML = `
        <form id="syncForm" autocomplete="off" style="background: white; padding: 2rem; border-radius: 8px; width: 90%; max-width: 420px; box-shadow: 0 10px 40px rgba(0,0,0,0.3);">
            <h2 style="margin: 0 0 0.5rem 0; color: var(--primary);">Sync from CaminoWays</h2>
            <p style="margin: 0 0 1rem 0; font-size: 0.85rem; color: #666;">
                Your login is sent once, over HTTPS, to read your bookings. It is never stored or logged.
                The trips are saved in this browser only.
            </p>
            <div class="form-group">
                <label for="syncEmail">CaminoWays email</label>
                <input type="email" id="syncEmail" required autocomplete="off">
            </div>
            <div class="form-group">
                <label for="syncPassword">CaminoWays password</label>
                <input type="password" id="syncPassword" required autocomplete="off">
            </div>
            <div id="syncError" style="color: #E53935; font-size: 0.9rem; margin-bottom: 0.7rem; min-height: 1.2em;"></div>
            <div style="display: flex; gap: 0.7rem;">
                <button type="button" id="syncCancel" style="flex: 1; background: #999;">Cancel</button>
                <button type="submit" id="syncSubmit" style="flex: 1;">Sync</button>
            </div>
        </form>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#syncCancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#syncForm').addEventListener('submit', (e) => {
        e.preventDefault();
        runSync(modal);
    });
    modal.querySelector('#syncEmail').focus();
}

async function runSync(modal) {
    const submit = modal.querySelector('#syncSubmit');
    const errorBox = modal.querySelector('#syncError');
    const email = modal.querySelector('#syncEmail').value.trim();
    const passwordInput = modal.querySelector('#syncPassword');

    submit.innerHTML = '<span class="spinner"></span> Syncing...';
    submit.disabled = true;
    errorBox.textContent = '';

    try {
        const response = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: passwordInput.value })
        });
        passwordInput.value = '';

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || 'Sync failed. Please try again.');
        }

        const data = await response.json();
        state.stages = data.stages;
        state.tripKey = null;
        state.stageId = null;
        state.pane = 'trips';
        saveStages();
        refreshAll();
        modal.remove();
    } catch (error) {
        console.error('Sync error:', error);
        errorBox.textContent = error.message;
        submit.textContent = 'Sync';
        submit.disabled = false;
    }
}

function clearData() {
    if (confirm('Clear your saved trips from this browser? You can sync them again at any time.')) {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (error) {
            console.error('Could not clear saved stages:', error);
        }
        state.stages = [];
        state.tripKey = null;
        state.stageId = null;
        refreshAll();
    }
}
