// The server keeps no user data: a sync returns the stages and this page stores them in the browser.
const STORAGE_KEY = 'caminotrack.stages.v1';

function readPref(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value === 'true';
    } catch (error) {
        return fallback;
    }
}

function writePref(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch (error) {
        console.error('Could not save preference:', error);
    }
}

function readText(key, fallback) {
    try {
        return localStorage.getItem(key) || fallback;
    } catch (error) {
        return fallback;
    }
}

function writeText(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (error) {
        console.error('Could not save preference:', error);
    }
}

const UNITS_KEY = 'caminotrack.units';
const SHOW_QUOTES_KEY = 'caminotrack.showQuotes';
const IMPORT_QUOTES_KEY = 'caminotrack.importQuotes';
const TRIPS_KEY = 'caminotrack.tripKeys';

function readTripKeys() {
    try {
        const saved = JSON.parse(localStorage.getItem(TRIPS_KEY) || 'null');
        return Array.isArray(saved) ? saved : null;
    } catch (error) {
        return null;
    }
}

const state = {
    stages: [],
    showQuotes: readPref(SHOW_QUOTES_KEY, true),  // show quotes alongside confirmed bookings
    tripKeys: readTripKeys(), // trips picked in the drop-down (null until chosen: then the next trip to walk)
    tripMenuOpen: false,
    view: 'overview',     // what column 2 shows: 'overview' of the selected trips, or one 'stage'
    stageId: null,        // selected stage
    units: readText(UNITS_KEY, 'km'),  // 'km' | 'mi'
    tab: 'itinerary',     // 'itinerary' | 'map'
    follow: true,         // the map tab keeps the walker centred
    stopKey: null,        // selected lunch stop (a dot on the maps / height profile, a row in the stage)
    detailTab: 'general', // 'general' | 'caminoways' (stage details)
    serviceKind: null,    // which lozenge is open on the CaminoWays view: 'luggage' | 'passenger' | ...
    mapMode: 'route',     // 'route' | 'height', shared by every route view
    mapScope: 'trip',     // 'trip' | 'stage', for the Map tab
    pane: 'stages',       // which column shows on narrow screens: 'stages' | 'detail'
    user: null,           // { lat, lon, acc } from the browser's location
    watchId: null,
    locateError: null
};

const views = new Set();   // live RouteViews, so a location update reaches all of them
let miniView = null;       // route view inside the stage detail
let mapTabView = null;     // route view on the Map tab
let sideView = null;       // route view beside the detail on wide screens

// Map tiles: the free OpenStreetMap server (no key) unless the server sets another provider. One fixed host, not {s}
// subdomains, so a tile saved for offline use has the same address Leaflet asks for.
const TILE = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' };
let appConfig = { data_updated: null };

const wideQuery = window.matchMedia('(min-width: 1100px)');
const phoneQuery = window.matchMedia('(max-width: 599px)');
const isWide = () => wideQuery.matches;
const isPhone = () => phoneQuery.matches;

const $ = id => document.getElementById(id);

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

// [background, text]: dark enough to read at arm's length in sunshine
const DIFFICULTY_COLORS = { 'Easy': ['#2e7d32', '#fff'], 'Moderate': ['#FFC107', '#3a2a00'], 'Hard': ['#BF4A00', '#fff'], 'Very hard': ['#C62828', '#fff'] };
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

// Quotes are proposed trips that haven't been booked. Saved data from before quotes existed has no status.
function isQuote(stage) {
    return stage.status === 'quote';
}

function visibleStages() {
    return state.stages.filter(stage => state.showQuotes || !isQuote(stage));
}

function stageIdOf(stage) {
    return `${stage.booking_id || stage.trip_name}_${stage.date_walked}`;
}

function tripKeyOf(stage) {
    return stage.booking_id || stage.trip_name || 'trip';
}

// Distances and heights in the chosen units. Data is always kept in km and metres.
const KM_TO_MI = 0.621371, M_TO_FT = 3.28084;
const unitName = () => state.units === 'mi' ? 'mi' : 'km';
const distNumber = (km, digits = 1) => (state.units === 'mi' ? km * KM_TO_MI : km).toFixed(digits);
const fmtDist = (km, digits = 1) => `${distNumber(km, digits)} ${unitName()}`;
const fmtElev = metres => state.units === 'mi' ? `${Math.round(metres * M_TO_FT)} ft` : `${Math.round(metres)} m`;

// Today's date where the walker is (not UTC, which can be a day out late in the evening)
function todayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatDate(iso, long) {
    const date = new Date(iso + 'T00:00:00');
    return date.toLocaleDateString(undefined, long
        ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
        : { weekday: 'short', day: 'numeric', month: 'short' });
}

function difficultyBadge(stage) {
    if (!stage.difficulty) return '';
    const [background, color] = DIFFICULTY_COLORS[stage.difficulty] || ['#757575', '#fff'];
    return `<span class="badge" style="background: ${background}; color: ${color};">${escapeHtml(stage.difficulty)}</span>`;
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
    [...visibleStages()]
        .sort((a, b) => a.date_walked.localeCompare(b.date_walked))
        .forEach(stage => {
            const key = tripKeyOf(stage);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(stage);
        });

    return [...groups.entries()].map(([key, stages]) => ({
        key,
        name: stages[0].trip_name || 'Trip',
        routeName: (stages.find(s => s.route_name) || {}).route_name,
        stages,
        stats: tripStats(stages),
        isQuote: isQuote(stages[0]),
        start: stages[0].date_walked,
        end: stages[stages.length - 1].date_walked,
        done: stages.filter(s => s.is_completed).length
    })).sort((a, b) => a.start.localeCompare(b.start));
}

// Nights of a trip: first check-in to last check-out where the hotels are known, else the nights the itinerary lists
function nightsFor(stages) {
    const dates = [];
    stages.forEach(stage => {
        const cw = stage.caminoways || {};
        [cw.start_hotel, cw.end_hotel].forEach(hotel => {
            if (hotel && hotel.check_in) dates.push(hotel.check_in);
            if (hotel && hotel.check_out) dates.push(hotel.check_out);
        });
    });
    if (dates.length) {
        dates.sort();
        const nights = Math.round((new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000);
        if (nights > 0) return nights;
    }
    return stages.reduce((total, s) => total + ((s.caminoways || {}).nights || 0), 0);
}

// Official distance is what CaminoWays publishes; actual is hotel to hotel where we could work it out
function tripStats(stages) {
    const sum = field => stages.reduce((total, s) => total + (s[field] || 0), 0);
    const count = stages.length;
    const official = sum('standard_distance'), actual = sum('actual_distance');
    return {
        count, official, actual,
        avgOfficial: count ? official / count : 0,
        avgActual: count ? actual / count : 0,
        nights: nightsFor(stages),
        ascent: sum('ascent_m'),
        descent: sum('descent_m'),
        hasClimb: stages.some(s => s.ascent_m != null),
        byHotels: stages.filter(s => s.actual_basis === 'hotels').length,
        byRoute: stages.filter(s => s.actual_basis === 'route').length
    };
}

function combineStats(list) {
    const total = list.reduce((all, s) => ({
        count: all.count + s.count, official: all.official + s.official, actual: all.actual + s.actual,
        nights: all.nights + s.nights, ascent: all.ascent + s.ascent, descent: all.descent + s.descent,
        hasClimb: all.hasClimb || s.hasClimb, byHotels: all.byHotels + s.byHotels, byRoute: all.byRoute + s.byRoute
    }), { count: 0, official: 0, actual: 0, nights: 0, ascent: 0, descent: 0, hasClimb: false, byHotels: 0, byRoute: 0 });
    total.avgOfficial = total.count ? total.official / total.count : 0;
    total.avgActual = total.count ? total.actual / total.count : 0;
    return total;
}

function selectedTrips(trips) {
    return trips.filter(t => (state.tripKeys || []).includes(t.key));
}

function selectedStages(trips) {
    return selectedTrips(trips).flatMap(t => t.stages);
}

function currentStage() {
    return state.stages.find(s => stageIdOf(s) === state.stageId) || null;
}

function setTripKeys(keys) {
    state.tripKeys = keys;
    try {
        localStorage.setItem(TRIPS_KEY, JSON.stringify(keys));
    } catch (error) {
        console.error('Could not save the trip selection:', error);
    }
    state.stageId = null;
    state.view = 'overview';
    state.pane = 'stages';
    refreshAll();
}

function refreshAll() {
    const today = todayIso();
    // Completion depends on today's date, so work it out now rather than trusting the value saved at sync time
    state.stages.forEach(stage => { stage.is_completed = !isQuote(stage) && stage.date_walked < today; });

    const trips = buildTrips();
    if (Array.isArray(state.tripKeys)) {
        const valid = state.tripKeys.filter(key => trips.some(t => t.key === key));
        // A saved selection that no longer exists (new sync, quotes hidden) starts over from the default
        state.tripKeys = valid.length || !state.tripKeys.length ? valid : null;
    }
    if (state.tripKeys === null) {
        // Open on the next confirmed trip still to walk, or the latest one (quotes only if there's nothing else)
        const confirmed = trips.filter(t => !t.isQuote);
        const next = confirmed.find(t => t.done < t.stages.length) || confirmed[confirmed.length - 1] || trips[0];
        state.tripKeys = next ? [next.key] : [];
    }

    const stages = selectedStages(trips);
    if (state.stageId && !stages.some(s => stageIdOf(s) === state.stageId)) {
        state.stageId = null;
        state.view = 'overview';
    }
    if (state.stopKey && !findStop(state.stopKey)) state.stopKey = null;

    renderTodayStrip(trips);
    renderViewOptions(trips);
    renderItinerary(trips);
    renderMapTab();
    renderStopBodies();
    fitLayout();
}

// Totals across every confirmed trip (quotes aren't walked or booked, so they stay out)
function lifetimeTotals() {
    const confirmed = state.stages.filter(s => !isQuote(s));
    const sum = (list, field) => list.reduce((total, s) => total + (s[field] || 0), 0);
    const completed = confirmed.filter(s => s.is_completed), remaining = confirmed.filter(s => !s.is_completed);
    return {
        stages: confirmed.length, completed: completed.length,
        walked: sum(completed, 'actual_distance'), walkedOfficial: sum(completed, 'standard_distance'),
        remaining: sum(remaining, 'actual_distance'), remainingOfficial: sum(remaining, 'standard_distance')
    };
}

// ---- Today strip: where you are in the trip ----

// The trip the strip is about: the one in progress, else the next to start, else the latest
function focusTrip(trips) {
    const today = todayIso();
    const chosen = selectedTrips(trips);
    const pool = chosen.length ? chosen : trips;
    const list = pool.some(t => !t.isQuote) ? pool.filter(t => !t.isQuote) : pool;
    return list.find(t => t.start <= today && today <= t.end) || list.find(t => t.start > today) || list[list.length - 1] || null;
}

function renderTodayStrip(trips) {
    const host = $('todayStrip');
    const trip = focusTrip(trips);
    if (!trip) { host.innerHTML = ''; return; }
    const today = todayIso(), count = trip.stages.length, quote = trip.isQuote ? 'Quote · ' : '';
    let kicker, title, stage = null, finished = false;
    if (today < trip.start) {
        const days = Math.round((new Date(trip.start + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
        kicker = `${quote}${trip.name} · ${days === 1 ? 'starts tomorrow' : `starts in ${days} days`}`;
        stage = trip.stages[0];
        title = `${stage.start_location} → ${stage.end_location}`;
    } else if (today > trip.end) {
        finished = true;
        kicker = `${quote}${trip.name} · completed`;
        title = `${count} stage${count === 1 ? '' : 's'} walked`;
    } else {
        const index = trip.stages.findIndex(s => s.date_walked >= today);
        stage = trip.stages[index];
        kicker = `${quote}${trip.name} · Day ${index + 1} of ${count} · ${stage.date_walked === today ? 'today' : formatDate(stage.date_walked)}`;
        title = `${stage.start_location} → ${stage.end_location}`;
    }
    const doneShare = finished ? 100 : Math.round(100 * trip.stages.filter(s => s.date_walked < today).length / count);
    const facts = finished
        ? [fmtDist(trip.stats.actual), trip.stats.hasClimb ? `⬆ ${fmtElev(trip.stats.ascent)}` : '']
        : [fmtDist(stage.actual_distance || stage.standard_distance || 0), stage.ascent_m != null ? `⬆ ${fmtElev(stage.ascent_m)}` : '', difficultyBadge(stage)];
    host.innerHTML = `
        <button type="button" class="today ${finished ? 'done' : ''}" data-today-trip="${escapeHtml(trip.key)}" data-today-stage="${stage ? escapeHtml(stageIdOf(stage)) : ''}"
                aria-label="${escapeHtml(`${kicker}. ${title}. Open`)}">
            <div><div class="today-kicker">${escapeHtml(kicker)}</div><div class="today-title">${escapeHtml(title)}</div></div>
            <span class="today-go" aria-hidden="true">›</span>
            <div class="today-facts">${facts.filter(Boolean).map(f => `<span>${f}</span>`).join('')}</div>
            <div class="today-progress" aria-hidden="true"><div style="width: ${doneShare}%"></div></div>
        </button>`;
}

function goToToday(tripKey, stageId) {
    if (!selectedTrips(buildTrips()).some(t => t.key === tripKey)) setTripKeys([tripKey]);
    switchTab('itinerary');
    if (stageId) {
        selectStageById(stageId, 'detail');
    } else {
        state.view = 'overview';
        state.stageId = null;
        state.pane = 'detail';
        refreshAll();
    }
}

// Trip picker and "Show quotes" toggle, shown above both tabs
function renderViewOptions(trips) {
    const bar = $('viewOptions');
    const quoteTrips = new Set(state.stages.filter(isQuote).map(tripKeyOf)).size;
    bar.classList.toggle('hidden', !state.stages.length);
    $('quoteToggle').classList.toggle('hidden', quoteTrips === 0);
    $('quoteHint').classList.toggle('hidden', quoteTrips !== 0);
    $('showQuotes').checked = state.showQuotes;
    $('quoteCount').textContent = quoteTrips ? `(${quoteTrips})` : '';
    renderTripPicker(trips);
}

function renderTripPicker(trips) {
    const chosen = selectedTrips(trips);
    const label = !chosen.length ? 'Select trips' : chosen.length === 1 ? chosen[0].name : `${chosen.length} trips selected`;
    $('tripPicker').innerHTML = `
        <button type="button" class="picker-btn" id="tripPickerBtn" aria-haspopup="true" aria-expanded="${state.tripMenuOpen}">
            🧭 <span class="picker-label">${escapeHtml(label)}</span> <small>▾</small></button>
        <div class="picker-menu ${state.tripMenuOpen ? '' : 'hidden'}" role="group" aria-label="Trips">
            <div class="picker-actions">
                <button type="button" data-picker="all">Select all</button>
                <button type="button" data-picker="none">Clear</button>
            </div>
            ${trips.map((trip, index) => `
                <label class="picker-row">
                    <input type="checkbox" data-trip="${index}" ${chosen.includes(trip) ? 'checked' : ''}>
                    <span>
                        <span class="picker-name">${escapeHtml(trip.name)} ${trip.isQuote ? '<span class="badge quote-badge">Quote</span>' : ''}</span>
                        <span class="picker-sub">${formatDate(trip.start)} – ${formatDate(trip.end)} · ${trip.stages.length} stages</span>
                    </span>
                </label>`).join('')}
        </div>`;
}

// ----------------------------------------------------------------------
// Itinerary: stages | details (the trips are picked from the drop-down above)
// ----------------------------------------------------------------------

function renderItinerary(trips) {
    const mail = $('mail');
    mail.dataset.pane = state.pane;
    mail.classList.toggle('with-map', isWide());

    if (!state.stages.length) {
        $('stagesPane').innerHTML = '';
        $('detailPane').innerHTML = '';
        destroyMiniView();
        if (sideView) { sideView.destroy(); sideView = null; }
        mail.classList.add('hidden');
        $('emptyState').classList.remove('hidden');
        return;
    }
    mail.classList.remove('hidden');
    $('emptyState').classList.add('hidden');

    renderStages(trips);
    renderDetail();
}

// Makes a div behave as a button. A town name inside it opens the town sheet instead.
function activate(el, handler) {
    el.addEventListener('click', e => { if (!e.target.closest('[data-town]')) handler(); });
    el.addEventListener('keydown', e => {
        if (e.target.closest('[data-town]')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
}

function pathEnds(stage) {
    const path = stage.route_path || [];
    return [path[0], path[path.length - 1]];
}

// "Sarria → Portomarín", each name tappable for a description of the town
function stageTitleHtml(stage) {
    const [from, to] = pathEnds(stage);
    return `${townLink(stage.start_location, from)} → ${townLink(stage.end_location, to)}`;
}

function renderStages(trips) {
    const chosen = selectedTrips(trips);
    const pane = $('stagesPane');
    if (!chosen.length) {
        pane.innerHTML = `<div class="pane-head">Stages</div>
            <div class="pane-empty">Choose one or more trips from the <strong>Trips</strong> drop-down above.</div>`;
        return;
    }

    const total = combineStats(chosen.map(t => t.stats));
    pane.innerHTML = '<div class="pane-head">Stages</div>';

    const overview = document.createElement('div');
    overview.className = 'list-item overview' + (state.view === 'overview' ? ' selected' : '');
    overview.tabIndex = 0;
    overview.innerHTML = `
        <div class="item-title">📊 Overview</div>
        <div class="item-sub">${chosen.length === 1 ? escapeHtml(chosen[0].name) : `${chosen.length} trips`}</div>
        <div class="item-meta">${total.count} stages · ${total.actual.toFixed(0)} km · ${total.nights} nights</div>`;
    activate(overview, () => {
        state.view = 'overview';
        state.stageId = null;
        state.pane = 'detail';
        refreshAll();
    });
    pane.appendChild(overview);

    chosen.forEach(trip => {
        if (chosen.length > 1) {
            const head = document.createElement('div');
            head.className = 'trip-head' + (trip.isQuote ? ' quote' : '');
            head.innerHTML = `${escapeHtml(trip.name)} ${trip.isQuote ? '<span class="badge quote-badge">Quote</span>' : ''}
                <span class="item-sub">${formatDate(trip.start)} – ${formatDate(trip.end)}</span>`;
            pane.appendChild(head);
        }
        trip.stages.forEach((stage, index) => {
            const item = document.createElement('div');
            item.className = 'list-item' + (isQuote(stage) ? ' quote' : '') + (stage.date_walked === todayIso() && !isQuote(stage) ? ' today-item' : '')
                + (state.view === 'stage' && stageIdOf(stage) === state.stageId ? ' selected' : '');
            item.tabIndex = 0;
            item.innerHTML = `
                <div class="item-row">
                    <div class="item-title">${stageTitleHtml(stage)}</div>
                    <span class="status" role="img" aria-label="${isQuote(stage) ? 'Quote' : stage.is_completed ? 'Walked' : 'Upcoming'}">${isQuote(stage) ? '📝' : stage.is_completed ? '✅' : '⏳'}</span>
                </div>
                <div class="item-sub">Day ${index + 1} · ${formatDate(stage.date_walked)}${stage.date_walked === todayIso() && !isQuote(stage) ? ' · today' : ''}</div>
                <div class="item-meta">
                    <span>${fmtDist(stage.actual_distance || 0)} <span class="muted">(official ${distNumber(stage.standard_distance || 0, 0)})</span></span>
                    ${stage.ascent_m != null ? `<span>⬆ ${fmtElev(stage.ascent_m)} ⬇ ${fmtElev(stage.descent_m)}</span>` : ''}
                    ${difficultyBadge(stage)}
                </div>`;
            activate(item, () => selectStageById(stageIdOf(stage), 'detail'));
            pane.appendChild(item);
        });
    });
}

function selectStageById(id, pane) {
    state.stageId = id;
    state.view = 'stage';
    state.serviceKind = null;
    if (pane) state.pane = pane;
    refreshAll();
    scrollDetailToTop();
}

function scrollDetailToTop() {
    $('detailPane').scrollTop = 0;
    if (isPhone() && state.tab === 'itinerary') window.scrollTo(0, 0);
}

// What the selected trips add up to: distances (hotel to hotel and official), nights, average stage
function overviewHtml(trips) {
    const chosen = selectedTrips(trips);
    const lifetime = lifetimeTotals();
    if (!chosen.length) {
        return '<div class="note-box">Choose one or more trips from the <strong>Trips</strong> drop-down to see an overview.</div>';
    }
    const total = combineStats(chosen.map(t => t.stats));
    const first = chosen.map(t => t.start).sort()[0], last = chosen.map(t => t.end).sort().pop();
    const title = chosen.length === 1 ? chosen[0].name : `${chosen.length} trips selected`;
    const sub = chosen.length === 1 && chosen[0].routeName ? `${escapeHtml(chosen[0].routeName)} · ` : '';
    const official = value => `official ${fmtDist(value)}`;
    const unit = unitName();

    let basis;
    if (total.byHotels || total.byRoute) {
        const unmapped = total.count - total.byHotels - total.byRoute;
        basis = `Hotel to hotel is measured along the mapped route between your hotels, plus the walk to and from any hotel off the
            route, estimated at 1.3 times the straight line (${total.byHotels} of ${total.count} stages). `
            + (total.byRoute ? `The other ${total.byRoute} use the mapped route between the towns, because a hotel's position wasn't available. ` : '')
            + (unmapped ? `${unmapped} stages have no route data, so they show the official distance. ` : '');
    } else {
        basis = 'No route data for this selection, so only the official distances are available. ';
    }

    const rows = chosen.map(trip => trip.stages.map((stage, index) => `
        <tr class="clickable" data-goto="${escapeHtml(stageIdOf(stage))}" tabindex="0">
            <td>${index + 1}</td>
            <td>${formatDate(stage.date_walked)}</td>
            <td>${stageTitleHtml(stage)}${isQuote(stage) ? ' 📝' : ''}</td>
            <td class="num">${distNumber(stage.actual_distance || 0)}</td>
            <td class="num muted">${distNumber(stage.standard_distance || 0, 0)}</td>
            <td class="num">${stage.ascent_m != null ? fmtElev(stage.ascent_m).replace(/ \w+$/, '') : '–'}</td>
        </tr>`).join('')).join('');

    return `
        <h2>${escapeHtml(title)}</h2>
        <div class="detail-sub">${sub}${formatDate(first)} – ${formatDate(last)}</div>

        <div class="metrics">
            ${metric('Distance, hotel to hotel', fmtDist(total.actual), official(total.official))}
            ${metric('Stages', total.count)}
            ${metric('Nights', total.nights)}
            ${metric('Average per stage', fmtDist(total.avgActual), official(total.avgOfficial))}
            ${total.hasClimb ? metric('Ascent', `⬆ ${fmtElev(total.ascent)}`) : ''}
            ${total.hasClimb ? metric('Descent', `⬇ ${fmtElev(total.descent)}`) : ''}
        </div>
        <p class="small">${basis}Official is the distance CaminoWays publishes.</p>

        ${isWide() ? '' : '<div id="overviewRoute"></div>'}

        ${chosen.length > 1 ? `
            <section><h4>🧭 Trips</h4>
                <div class="table-wrap">
                <table class="days">
                    <thead><tr><th>Trip</th><th>Dates</th><th class="num">Stages</th><th class="num">Nights</th><th class="num">Hotel to hotel (${unit})</th><th class="num">Official (${unit})</th><th class="num">Avg / stage</th></tr></thead>
                    <tbody>${chosen.map(trip => `
                        <tr><td>${escapeHtml(trip.name)}${trip.isQuote ? ' 📝' : ''}</td><td>${formatDate(trip.start)} – ${formatDate(trip.end)}</td>
                            <td class="num">${trip.stats.count}</td><td class="num">${trip.stats.nights}</td>
                            <td class="num">${distNumber(trip.stats.actual)}</td><td class="num muted">${distNumber(trip.stats.official, 0)}</td>
                            <td class="num">${distNumber(trip.stats.avgActual)}</td></tr>`).join('')}
                    </tbody>
                </table>
                </div>
            </section>` : ''}

        <section><h4>📅 Day by day</h4>
            <div class="table-wrap">
                <table class="days">
                    <thead><tr><th>Day</th><th>Date</th><th>Stage</th><th class="num">Hotel to hotel (${unit})</th><th class="num">Official (${unit})</th><th class="num">Ascent (${state.units === 'mi' ? 'ft' : 'm'})</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </section>

        <section><h4>🌍 Across all trips</h4>
            <div class="metrics">
                ${metric('Stages booked', lifetime.stages)}
                ${metric('Stages walked', lifetime.completed)}
                ${metric('Distance walked', fmtDist(lifetime.walked), `official ${fmtDist(lifetime.walkedOfficial)}`)}
                ${metric('Still to walk', fmtDist(lifetime.remaining), `official ${fmtDist(lifetime.remainingOfficial)}`)}
            </div>
            <p class="small">Quotes are left out: they aren't booked or walked.</p>
        </section>`;
}

// Beside the detail on wide screens: the map of the selected stage (or trips)
function updateSideView(stage, trips) {
    if (!isWide()) {
        if (sideView) { sideView.destroy(); sideView = null; }
        return;
    }
    if (!sideView) sideView = new RouteView($('sidePane'), { fill: true });
    sideView.setData(stage ? [stage] : selectedStages(trips), stage ? stageIdOf(stage) : null);
}

function dayNavHtml(stages, position, extra = '') {
    const prev = stages[position - 1], next = stages[position + 1];
    const button = (stage, label, which) => stage
        ? `<button type="button" data-day="${escapeHtml(stageIdOf(stage))}" aria-label="${which} day: ${escapeHtml(stage.start_location)} to ${escapeHtml(stage.end_location)}">${label}</button>`
        : `<button type="button" disabled>${label}</button>`;
    return `<div class="day-nav ${extra}">${button(prev, '‹ Previous day', 'Previous')}${button(next, 'Next day ›', 'Next')}</div>`;
}

function renderDetail() {
    const pane = $('detailPane');
    destroyMiniView();
    const trips = buildTrips();
    const stage = state.view === 'stage' ? currentStage() : null;
    updateSideView(stage, trips);

    if (!stage) {
        pane.innerHTML = `
            <div class="pane-head"><button class="back-btn" data-back="stages">‹ Stages</button><span>Overview</span></div>
            <div class="detail-body" id="detailContent">${overviewHtml(trips)}</div>`;
        const host = $('overviewRoute');
        if (host) {
            miniView = new RouteView(host, { height: 300 });
            miniView.setData(selectedStages(trips), null);
        }
        return;
    }

    const stages = selectedStages(trips);
    const position = stages.findIndex(s => stageIdOf(s) === state.stageId);
    const trip = trips.find(t => t.stages.includes(stage));
    const dayNumber = trip ? trip.stages.indexOf(stage) + 1 : null;
    pane.innerHTML = `
        <div class="pane-head"><button class="back-btn" data-back="stages">‹ Stages</button>
            <span>${escapeHtml(stage.name)}</span></div>
        <div class="detail-body">
            ${dayNavHtml(stages, position)}
            <h2>${stageTitleHtml(stage)}</h2>
            <div class="detail-sub">${formatDate(stage.date_walked, true)} ·
                ${isQuote(stage) ? '📝 Quote, not booked' : stage.is_completed ? '✅ Walked' : '⏳ Upcoming'}${dayNumber ? ` · Day ${dayNumber} of ${trip.stages.length}` : ''}</div>
            <div class="segmented" role="group" aria-label="Stage information">
                <button data-seg="general" class="${state.detailTab === 'general' ? 'active' : ''}" aria-pressed="${state.detailTab === 'general'}">General</button>
                <button data-seg="caminoways" class="${state.detailTab === 'caminoways' ? 'active' : ''}" aria-pressed="${state.detailTab === 'caminoways'}">CaminoWays</button>
            </div>
            <div id="detailContent">${state.detailTab === 'general' ? generalHtml(stage) : caminowaysHtml(stage)}</div>
            ${dayNavHtml(stages, position, 'bottom')}
        </div>`;

    pane.querySelectorAll('[data-seg]').forEach(button => {
        button.addEventListener('click', () => {
            state.detailTab = button.dataset.seg;
            renderDetail();
        });
    });

    pane.querySelectorAll('[data-service]').forEach(button => {
        button.addEventListener('click', () => {
            state.serviceKind = state.serviceKind === button.dataset.service ? null : button.dataset.service;
            renderDetail();
        });
    });

    if (state.detailTab === 'general') {
        const host = $('miniRoute');
        if (host) {
            miniView = new RouteView(host, { height: isPhone() ? 260 : 300 });
            miniView.setData([stage], stageIdOf(stage));
        }
        ensureStopDetails();
        if (typeof fillWeather === 'function') fillWeather(stage);
        if (typeof renderOfflineBox === 'function') renderOfflineBox(stage);
    }
}

const SERVICE_ICONS = { luggage: '🧳', passenger: '🚐', dinner: '🍽️', other: '🛎️' };

// Which kind of service a lozenge (the little inclusion badges) stands for
function badgeKind(title) {
    if (/luggage/i.test(title)) return 'luggage';
    if (/people|passenger|transfer/i.test(title)) return 'passenger';
    if (/dinner/i.test(title)) return 'dinner';
    return null;
}

function serviceDetailHtml(stage, kind) {
    const services = ((stage.caminoways || {}).services || []).filter(service => service.kind === kind);
    if (!services.length) {
        // Stages saved before service details were imported have none: say so rather than do nothing
        return `<div class="service-card"><div class="muted">No details were saved for this yet. Use <strong>Sync Data</strong> to import them from CaminoWays.</div></div>`;
    }
    return services.map(service => {
        const phone = (service.phone || '').replace(/[^\d+]/g, '');
        const sameDay = service.from === service.to;
        const row = (label, value) => value ? `<div class="service-row"><span class="muted">${label}</span><span>${escapeHtml(value)}</span></div>` : '';
        return `
            <div class="service-card">
                <div class="service-head">${SERVICE_ICONS[kind] || SERVICE_ICONS.other} ${escapeHtml(service.title)}
                    <span class="muted">· ${sameDay ? formatDate(service.from) : `${formatDate(service.from)} – ${formatDate(service.to)}`}</span></div>
                ${service.provider ? `<div class="hotel-name">${escapeHtml(service.provider)}</div>` : ''}
                ${service.address ? `<div>📍 ${escapeHtml(service.address.replace(/\b(\d{4,5}),\s*\1\b/g, '$1'))}</div>` : ''}
                ${phone ? `<div>📞 <a href="tel:${phone}">${escapeHtml(service.phone)}</a></div>` : ''}
                <div class="service-rows">
                    ${row('Bags', service.bags)}
                    ${row('Passengers', service.pax)}
                    ${row('Pickup', service.pickup)}
                    ${row('Drop-off', service.dropoff)}
                </div>
                ${(service.notes || []).map(note => `<p class="small"><strong>${escapeHtml(note.label)}:</strong> ${escapeHtml(note.text)}</p>`).join('')}
            </div>`;
    }).join('');
}

function metric(label, value, sub) {
    return `<div class="metric"><div class="metric-value">${value}</div>${sub ? `<div class="metric-sub">${sub}</div>` : ''}<div class="metric-label">${label}</div></div>`;
}

// A hotel well off the route makes the day longer than the published distance
function detourNote(stage) {
    const parts = [];
    if (stage.start_hotel_detour_km >= 0.5) parts.push(`${escapeHtml(stage.start_hotel || 'your starting hotel')} is about ${stage.start_hotel_detour_km.toFixed(1)} km off the route`);
    if (stage.end_hotel_detour_km >= 0.5) parts.push(`${escapeHtml(stage.end_hotel || 'your hotel tonight')} is about ${stage.end_hotel_detour_km.toFixed(1)} km off the route`);
    return parts.length ? `<div class="note-box">🏨 ${parts.join(', and ')}, which is included in the hotel-to-hotel distance (estimated).</div>` : '';
}

// How far the route runs for this stage (km), from its height profile where there is one
function routeKmOf(stage) {
    const profile = stage.elevation_profile || [];
    return profile.length ? profile[profile.length - 1][0] : (stage.standard_distance || 0);
}

const normaliseName = name => (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A report link that opens a prefilled GitHub issue, for a place or town that looks wrong
function reportUrl(title, body) {
    return `https://github.com/prideauj/caminotrack/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// Town names in a piece of text become tappable
function linkifyTowns(text, stage) {
    const [from, to] = pathEnds(stage);
    const known = new Map();
    (stage.places_passed || []).filter(p => p.info !== false).forEach(p => known.set(escapeHtml(p.name), [p.name, p.lat != null ? [p.lat, p.lon] : null]));
    known.set(escapeHtml(stage.start_location), [stage.start_location, from]);
    known.set(escapeHtml(stage.end_location), [stage.end_location, to]);
    const names = [...known.keys()].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const html = escapeHtml(text);
    if (!names.length) return html;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
    return html.replace(pattern, match => {
        const [name, point] = known.get(match);
        return townLink(name, point);
    });
}

// The day in order: where you start, the villages, the places to eat, the long stretch without food, where you end
function timelineHtml(stage) {
    const total = routeKmOf(stage);
    const [from, to] = pathEnds(stage);
    const rows = [{ km: 0, order: 0, cls: 'start', name: townLink(stage.start_location, from), sub: stage.start_hotel ? `🏨 ${escapeHtml(stage.start_hotel)}` : '' }];

    (stage.places_passed || []).forEach(place => {
        if (place.km < 0.4 || place.km > total - 0.4) return;
        rows.push({ km: place.km, order: 1, cls: '', name: `🏘 ${place.info === false ? escapeHtml(place.name) : townLink(place.name, place.lat != null ? [place.lat, place.lon] : null)}`,
                    sub: place.type === 'hamlet' ? 'Hamlet' : '' });
    });

    (stage.lunch_stops || []).forEach(stop => {
        const label = `${FOOD_ICONS[stop.kind] || '🍴'} ${escapeHtml(stop.name)}`;
        const details = [escapeHtml(stop.kind), stop.off_m > 50 ? `${fmtElev(stop.off_m)} off the route` : '', stop.hours ? `🕒 ${escapeHtml(stop.hours)}` : ''].filter(Boolean).join(' · ');
        rows.push({ km: stop.km, order: 1, cls: 'food', sub: details,
                    name: stop.lat != null ? `<button type="button" class="tl-stop" data-stop="${stopKey(stop)}">${label}</button>` : label });
    });

    const gap = stage.food_gap;
    if (gap && gap.km >= 5) {
        rows.push({ km: gap.from + 0.001, order: 2, cls: 'gap', range: `${distNumber(gap.from)}–${distNumber(gap.to)}`,
                    name: `⚠ ${fmtDist(gap.km, 0)} with no food or drink`,
                    sub: 'Fill your bottle and carry a snack before this stretch.' });
    }
    rows.push({ km: total, order: 3, cls: 'end', name: townLink(stage.end_location, to), sub: stage.end_hotel ? `🏨 ${escapeHtml(stage.end_hotel)}` : '' });

    rows.sort((a, b) => a.km - b.km || a.order - b.order);
    let previous = 0;
    return `<ol class="tl">${rows.map(row => {
        const delta = row.cls === 'gap' ? null : row.km - previous;
        if (row.cls !== 'gap') previous = row.km;
        return `<li class="${row.cls}">
            <span class="tl-name">${row.name}</span>
            <span class="tl-km">${row.range || distNumber(row.km)} <small class="muted">${unitName()}</small></span>
            ${row.sub || (delta > 0.05 && row.cls !== 'start') ? `<span class="tl-sub">${row.sub || ''}${!row.sub && delta > 0.05 ? `+${distNumber(delta)} ${unitName()} from the last stop` : ''}</span>` : ''}
        </li>`;
    }).join('')}</ol>`;
}

// Tonight's hotel, with the things you'd want to do about it: navigate, call, check the luggage transfer
function tonightHtml(stage) {
    const cw = stage.caminoways || {};
    const hotel = cw.end_hotel || null;
    const name = (hotel && hotel.name) || stage.end_hotel;
    if (!name) return '';
    const lat = stage.end_hotel_lat, lon = stage.end_hotel_lon;
    const directions = lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}` : safeUrl(hotel && hotel.map_url);
    const phone = ((hotel && hotel.phone) || '').replace(/[^\d+]/g, '');
    const address = ((hotel && hotel.address) || '').replace(/\b(\d{4,5}),\s*\1\b/g, '$1');
    return `
        <section><h4>🏨 Tonight</h4>
            <div class="hotel">
                <div class="hotel-name">${escapeHtml(name)}</div>
                ${hotel && hotel.board ? `<div class="muted">${escapeHtml(hotel.board)}</div>` : ''}
                ${address ? `<div>📍 ${escapeHtml(address)}</div>` : ''}
                ${stage.end_hotel_detour_km >= 0.5 ? `<div class="muted">About ${fmtDist(stage.end_hotel_detour_km)} off the route</div>` : ''}
                <div class="action-row">
                    ${directions ? `<a class="btn-link primary" href="${escapeHtml(directions)}" target="_blank" rel="noopener noreferrer">🧭 Navigate</a>` : ''}
                    ${phone ? `<a class="btn-link" href="tel:${phone}">📞 Call</a>` : ''}
                    ${hasService(stage, 'luggage') ? '<button type="button" class="btn-link" data-open-service="luggage">🧳 Luggage transfer</button>' : ''}
                    ${cw.end_hotel || cw.included ? '<button type="button" class="btn-link" data-open-service="">📋 Booking details</button>' : ''}
                </div>
            </div>
        </section>`;
}

// General: what we know about the stage, in the order you'd want it the evening before
function generalHtml(stage) {
    const hasRoute = stage.route_path && stage.route_path.length > 1;
    const hasClimb = stage.ascent_m != null;
    const lunches = stage.lunch_stops || [];
    const official = stage.standard_distance || 0;
    const actual = stage.actual_distance || official;
    const distanceLabel = stage.actual_basis === 'hotels' ? 'Distance, hotel to hotel'
        : stage.actual_basis === 'route' ? 'Distance along the route' : 'Distance';
    const updated = appConfig.data_updated ? `, updated ${formatDate(appConfig.data_updated)}` : '';

    return `
        <div class="metrics">
            ${metric(distanceLabel, fmtDist(actual), `official ${fmtDist(official)}`)}
            ${hasClimb ? metric('Ascent', `⬆ ${fmtElev(stage.ascent_m)}`) : ''}
            ${hasClimb ? metric('Descent', `⬇ ${fmtElev(stage.descent_m)}`) : ''}
            ${stage.difficulty ? metric('Difficulty', difficultyBadge(stage)) : ''}
        </div>

        ${detourNote(stage)}

        ${hasRoute ? `
            <section><h4>🧭 The day</h4>${timelineHtml(stage)}
                ${stage.food_gap ? '' : '<p class="small">Re-sync to see the longest stretch without food on this stage.</p>'}</section>
            <section><h4>☀️ Weather and daylight</h4><div id="weatherBox" class="weather"><span class="muted small">Loading the forecast…</span></div></section>`
        : `<div class="note-box">No route data for this trip yet. Maps, height profiles, climb and lunch stops are available for the
            Camino Francés and the Via Francigena in Tuscany.</div>`}

        ${tonightHtml(stage)}

        ${hasRoute && !isWide() ? '<div id="miniRoute" style="margin-top: 1.25rem"></div>' : ''}

        ${stage.route_summary ? `
            <section><h4>🗺 Route summary</h4><p>${linkifyTowns(stage.route_summary, stage)}</p></section>` : ''}

        ${lunches.length ? `
            <section><h4>🍴 Lunch stops</h4>
                <div class="lunch-list" id="lunchList">${lunchListHtml(stage)}</div>
                <p class="small">Tap a stop, or its dot on the map or height profile, for details. From OpenStreetMap, so opening times and closures aren't guaranteed. Check ahead, and carry water and a snack.</p>
            </section>` : ''}

        ${hasRoute ? '<section><h4>📥 Offline</h4><div id="offlineBox" class="small muted"></div></section>' : ''}

        ${hasClimb ? `
            <details class="fold"><summary>⛰ How hard is it?</summary><div>
                <p>${describeVsRoute(stage)}.<br>${describeVsTrip(stage)}.</p>
                <p class="small">Effort ${distNumber(stage.effort_km || 0)} flat-${unitName()} equivalent (distance plus a penalty for climbing).
                Estimated from OpenStreetMap routes and open elevation data, so treat as approximate.</p>
            </div></details>` : ''}

        <p class="data-note">Route and place data from OpenStreetMap${updated}; town descriptions from Wikipedia.</p>`;
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

function hasService(stage, kind) {
    return ((stage.caminoways || {}).services || []).some(service => service.kind === kind);
}

// A lozenge opens its service's details when the booking has them, otherwise it's a plain label
function lozenge(stage, title) {
    const kind = badgeKind(title);
    if (!kind || kind === 'dinner' && !hasService(stage, kind)) return `<span class="chip">✔ ${escapeHtml(title)}</span>`;
    return `<button type="button" class="chip chip-action ${state.serviceKind === kind ? 'active' : ''}" data-service="${kind}"
        aria-expanded="${state.serviceKind === kind}">✔ ${escapeHtml(title)} <small>${state.serviceKind === kind ? '▾' : '▸'}</small></button>`;
}

// Services the booking lists that none of the day's lozenges stand for (an extra dinner, say)
function extraServiceLozenges(stage, included) {
    const shown = new Set(included.map(badgeKind).filter(Boolean));
    const extras = new Map();
    ((stage.caminoways || {}).services || []).forEach(service => {
        if (!shown.has(service.kind) && !extras.has(service.kind)) extras.set(service.kind, service.title);
    });
    return [...extras].map(([kind, title]) => `
        <button type="button" class="chip chip-action ${state.serviceKind === kind ? 'active' : ''}" data-service="${kind}"
            aria-expanded="${state.serviceKind === kind}">${SERVICE_ICONS[kind] || SERVICE_ICONS.other} ${escapeHtml(title)}
            <small>${state.serviceKind === kind ? '▾' : '▸'}</small></button>`).join('');
}

// CaminoWays: what the booking itself says
function caminowaysHtml(stage) {
    const cw = stage.caminoways || {};
    const included = cw.included || [];
    return `
        <section>
            <h4>📋 Your ${isQuote(stage) ? 'quote' : 'booking'}</h4>
            <div class="chips">
                ${cw.service_level ? `<span class="chip" title="${escapeHtml(cw.service_level.name)}">${escapeHtml(cw.service_level.name)} service</span>` : ''}
                ${cw.nights ? `<span class="chip">🌙 ${cw.nights} night${cw.nights > 1 ? 's' : ''}</span>` : ''}
                ${included.map(item => lozenge(stage, item)).join('')}
                ${extraServiceLozenges(stage, included)}
            </div>
            <div id="serviceDetail">${state.serviceKind ? serviceDetailHtml(stage, state.serviceKind) : ''}</div>
            ${stage.booking_id ? `<p class="small">CaminoWays ${isQuote(stage) ? 'quote' : 'booking'} ${escapeHtml(stage.booking_id)}</p>` : ''}
        </section>

        <section>
            <h4>🏨 Accommodation</h4>
            ${cw.start_hotel || cw.end_hotel || stage.start_hotel || stage.end_hotel ? `<div class="hotels">
                ${hotelCard('Night before', cw.start_hotel, stage.start_hotel)}
                ${hotelCard('Tonight', cw.end_hotel, stage.end_hotel)}
            </div>` : `<p class="muted">${isQuote(stage) ? 'A quote has no hotel details yet.' : 'No hotel details found.'}</p>`}
        </section>

        ${stage.description ? `
            <section><h4>📖 Today's walk, from CaminoWays</h4><p>${escapeHtml(stage.description)}</p></section>` : ''}`;
}

// ----------------------------------------------------------------------
// Lunch stops: a dot on the maps and height profile, and a row in the stage. Click either for details.
// ----------------------------------------------------------------------

const stopDetails = new Map();   // stop key -> Google ratings from /api/place, when the server has a key

function stopKey(stop) {
    return `${stop.lat},${stop.lon}`;
}

function findStop(key) {
    for (const stage of state.stages) {
        const stop = (stage.lunch_stops || []).find(s => s.lat != null && stopKey(s) === key);
        if (stop) return { stop, stage };
    }
    return null;
}

// Height along a stage's profile ([km, metres] points) at a distance from its start
function heightAt(profile, km) {
    if (!profile || !profile.length) return null;
    if (km <= profile[0][0]) return profile[0][1];
    for (let i = 1; i < profile.length; i++) {
        if (km <= profile[i][0]) {
            const [x0, y0] = profile[i - 1], [x1, y1] = profile[i];
            return x1 === x0 ? y1 : y0 + (y1 - y0) * (km - x0) / (x1 - x0);
        }
    }
    return profile[profile.length - 1][1];
}

function stopStyle(selected) {
    return selected
        ? { radius: 10, color: '#fff', weight: 3, fillColor: '#d81b60', fillOpacity: 1, bubblingMouseEvents: false }
        : { radius: 7, color: '#5d4037', weight: 2, fillColor: '#ffb300', fillOpacity: 1, bubblingMouseEvents: false };
}

function phoneLink(phone) {
    const digits = (phone || '').replace(/[^\d+]/g, '');
    return digits ? `<a href="tel:${digits}">${escapeHtml(phone)}</a>` : '';
}

// Everything we can say about one stop, as far as it has loaded
function stopCardHtml(stop, stage) {
    const key = stopKey(stop);
    const details = stopDetails.get(key);
    const loaded = details && typeof details === 'object' ? details : null;
    const total = stage ? (stage.actual_distance || stage.standard_distance || 0) : 0;
    // Exact links were found ahead of time (prescan.py) and checked against the place's position. Google Maps
    // falls back to a pin at the place's exact coordinates.
    const osmKinds = { n: 'node', w: 'way', r: 'relation' };
    const link = (url, label) => safeUrl(url) ? `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : '';
    const mapsUrl = stop.gm || `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;
    const osmUrl = stop.osm && osmKinds[stop.osm[0]] ? `https://www.openstreetmap.org/${osmKinds[stop.osm[0]]}/${stop.osm.slice(1)}` : null;
    const row = (icon, html) => html ? `<div>${icon} ${html}</div>` : '';

    let reviews;
    const g = loaded && loaded.google_rating;
    if (g && g.rating != null) {
        reviews = `
            <div class="stop-reviews">
                <div><strong>★ ${Number(g.rating).toFixed(1)}</strong> <span class="muted">${g.count ? `(${g.count} reviews on Google)` : 'on Google'}</span></div>
                ${(g.reviews || []).filter(r => r.text).map(r => `
                    <blockquote>
                        <span class="muted">${'★'.repeat(Math.round(r.rating || 0))}</span> ${escapeHtml(r.text)}
                        <footer class="small">${escapeHtml(r.author || 'A visitor')}${r.when ? `, ${escapeHtml(r.when)}` : ''}</footer>
                    </blockquote>`).join('')}
                <div class="small">Ratings and reviews from Google.</div>
            </div>`;
    } else {
        reviews = '';
    }

    return `
        <div class="muted small">${distNumber(stop.km)}${total ? ` of ${distNumber(total, 0)}` : ''} ${unitName()} along${stop.off_m > 50 ? ` · ${fmtElev(stop.off_m)} off the route` : ' · on the route'}</div>
        ${row('📍', stop.addr ? escapeHtml(stop.addr) : '')}
        ${row('🕒', stop.hours ? escapeHtml(stop.hours) : '')}
        ${row('🍽️', stop.cuisine ? escapeHtml(stop.cuisine) : '')}
        ${row('📞', phoneLink(stop.phone))}
        ${row('🌐', link(stop.web, 'Website'))}
        ${reviews}
        <div class="stop-links">${link(mapsUrl, stop.gm ? 'Google Maps' : 'Open in Google Maps')} ${link(osmUrl, 'OpenStreetMap')}</div>
        <div class="small muted">Opening times and closures aren't guaranteed. Check ahead.
            ${link(reportUrl(`Wrong place: ${stop.name}`, `${stop.name} (${stop.kind}) at ${stop.lat},${stop.lon}${stop.osm ? `, OpenStreetMap ${stop.osm}` : ''}\n\nWhat's wrong:`), 'Report a wrong place')}</div>`;
}

function lunchListHtml(stage) {
    const total = stage.actual_distance || stage.standard_distance || 0;
    return (stage.lunch_stops || []).map(stop => {
        const clickable = stop.lat != null;
        const label = `${FOOD_ICONS[stop.kind] || '🍴'} <strong>${escapeHtml(stop.name)}</strong>
            <span class="muted">(${escapeHtml(stop.kind)}${stop.off_m > 50 ? `, ${fmtElev(stop.off_m)} off route` : ''})</span>
            ${stop.hours ? `<br><small class="muted">🕒 ${escapeHtml(stop.hours)}</small>` : ''}`;
        const where = `<span class="muted nowrap">${distNumber(stop.km)} of ${distNumber(total, 0)} ${unitName()}${clickable ? ' ›' : ''}</span>`;
        if (!clickable) return `<div class="lunch-item"><div class="lunch"><span>${label}</span>${where}</div></div>`;
        return `
            <div class="lunch-item">
                <button type="button" class="lunch" data-stop="${stopKey(stop)}" aria-haspopup="dialog">
                    <span>${label}</span>${where}
                </button>
            </div>`;
    }).join('');
}

// Ratings and reviews need a Google key on the server; everything else on a stop's card is already in its data.
// Asked for once per stop, and a failure just means no reviews are shown.
async function ensureStopDetails() {
    const key = state.stopKey;
    const found = key && findStop(key);
    if (!found || stopDetails.has(key) || reviewsUnavailable) return;

    stopDetails.set(key, 'loading');
    try {
        const params = new URLSearchParams({ name: found.stop.name, kind: found.stop.kind || '', lat: found.stop.lat, lon: found.stop.lon });
        const response = await fetch(`/api/place?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const details = await response.json();
        if (details.reviews_enabled === false) reviewsUnavailable = true;
        stopDetails.set(key, details);
    } catch (error) {
        console.error('Could not load reviews:', error);
        stopDetails.delete(key);
        return;
    }
    renderStopBodies();
}
let reviewsUnavailable = false;   // the server has no Google key, so don't ask again

// ---- Town descriptions -------------------------------------------------------------------------------
// Any town name in the interface can be tapped for a short description and highlights (prescanned from Wikipedia).
function townLink(name, point) {
    const where = point && point.length >= 2 ? ` data-lat="${point[0]}" data-lon="${point[1]}"` : '';
    return `<button type="button" class="town-link" data-town="${escapeHtml(name)}"${where}>${escapeHtml(name)}</button>`;
}

const townCache = new Map();   // "name|lat|lon" -> info from /api/town

function townSheetHtml(name, info, state_) {
    const maps = info && info.lat != null ? `https://www.google.com/maps/search/?api=1&query=${info.lat},${info.lon}` : null;
    let body;
    if (state_ === 'loading') {
        body = '<p class="muted"><span class="spinner dark"></span> Loading…</p>';
    } else if (state_ === 'error' || (info && info.retry)) {
        body = `<p class="muted">Couldn't load the description just now.</p><button type="button" class="linkish" data-town-retry>Try again</button>`;
    } else if (!info || !info.found) {
        body = `<p class="muted">We don't have a description for this place. It may be too small to have an article.</p>`;
    } else {
        const language = info.lang && info.lang !== 'en' ? `<div class="muted small">Description is in ${escapeHtml(({ es: 'Spanish', fr: 'French', it: 'Italian' })[info.lang] || info.lang)}.</div>` : '';
        body = `
            ${info.image && safeUrl(info.image) ? `<img class="town-photo" src="${escapeHtml(safeUrl(info.image))}" alt="" loading="lazy">` : ''}
            ${info.what ? `<div class="muted small">${escapeHtml(info.what)}</div>` : ''}
            <p>${escapeHtml(info.summary)}</p>
            ${language}
            ${(info.highlights || []).length ? `
                <h4>Highlights nearby</h4>
                <ul class="town-highlights">${info.highlights.map(h => `
                    <li><a href="${escapeHtml(safeUrl(h.url) || '#')}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(h.title)}</strong></a>
                        <span class="muted small">${escapeHtml(h.what)}${h.away_m ? ` · ${h.away_m >= 1000 ? (h.away_m / 1000).toFixed(1) + ' km' : Math.round(h.away_m) + ' m'} away` : ''}</span>
                        ${h.text ? `<div class="small">${escapeHtml(h.text)}</div>` : ''}</li>`).join('')}</ul>` : ''}
            <div class="stop-links">${info.url && safeUrl(info.url) ? `<a href="${escapeHtml(safeUrl(info.url))}" target="_blank" rel="noopener noreferrer">Read more on Wikipedia ↗</a>` : ''}
                ${maps ? `<a href="${maps}" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>` : ''}</div>`;
    }
    return `
        <div class="sheet-head"><h3>🏘 ${escapeHtml(name)}</h3>
            <button type="button" class="sheet-close" data-town-close aria-label="Close">✕</button></div>
        <div class="sheet-body">${body}</div>`;
}

async function openTown(name, lat, lon) {
    const sheet = $('townSheet');
    const key = `${name}|${lat ?? ''}|${lon ?? ''}`;
    sheet.dataset.key = key;
    sheet.classList.remove('hidden');
    document.body.classList.add('sheet-open');
    const show = (info, status) => { if (sheet.dataset.key === key) $('townCard').innerHTML = townSheetHtml(name, info, status); };
    sheet.dataset.retry = JSON.stringify([name, lat ?? null, lon ?? null]);

    const cached = townCache.get(key);
    if (cached) { show(cached); $('townCard').querySelector('[data-town-close]').focus(); return; }
    show(null, 'loading');
    $('townCard').querySelector('[data-town-close]').focus();
    try {
        const params = new URLSearchParams({ name });
        if (lat != null && lon != null) { params.set('lat', lat); params.set('lon', lon); }
        const response = await fetch(`/api/town?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const info = await response.json();
        if (!info.retry) townCache.set(key, info);
        show(info);
    } catch (error) {
        console.error('Could not load town info:', error);
        show(null, 'error');
    }
}

function closeTown() {
    $('townSheet').classList.add('hidden');
    document.body.classList.toggle('sheet-open', !$('stopSheet').classList.contains('hidden'));
}

// The details of a bar, café or restaurant open in a popup, like a town's
function stopSheetHtml(stop, stage) {
    return `
        <div class="sheet-head"><h3>${FOOD_ICONS[stop.kind] || '🍴'} ${escapeHtml(stop.name)} <span class="muted small">${escapeHtml(stop.kind)}</span></h3>
            <button type="button" class="sheet-close" data-stop-close aria-label="Close">✕</button></div>
        <div class="sheet-body"><div class="stop-card">${stopCardHtml(stop, stage)}</div></div>`;
}

// Show (or refresh, or hide) the popup for the selected stop
function renderStopBodies() {
    const sheet = $('stopSheet');
    const found = state.stopKey && findStop(state.stopKey);
    const opening = found && sheet.classList.contains('hidden');
    sheet.classList.toggle('hidden', !found);
    if (found) $('stopCard').innerHTML = stopSheetHtml(found.stop, found.stage);
    if (opening) $('stopCard').querySelector('[data-stop-close]').focus();
    document.body.classList.toggle('sheet-open', !!found || !$('townSheet').classList.contains('hidden'));
    views.forEach(view => view.renderStopPanel());
}

// Select a stop (opens its popup) or clear it (null closes the popup)
function selectStop(key) {
    state.stopKey = key;
    views.forEach(view => view.markStop());
    renderStopBodies();
    ensureStopDetails();
}

// ----------------------------------------------------------------------
// Route view: map or height profile, with the user's location overlaid
// ----------------------------------------------------------------------

function destroyMiniView() {
    if (miniView) { miniView.destroy(); miniView = null; }
}

class RouteView {
    // options: height (px) or fill (take the host's height); follow (a "keep me centred" button); noNote (the walking sheet
    // says where you are instead)
    constructor(host, options = {}) {
        this.opts = options;
        this.host = host;
        host.classList.add('rv');
        host.classList.toggle('fill', !!options.fill);
        host.innerHTML = `
            <div class="rv-toolbar">
                <div class="segmented small">
                    <button data-mode="route">🗺 Route</button>
                    <button data-mode="height">⛰ Height</button>
                </div>
                <button class="rv-locate"></button>
            </div>
            <div class="rv-note"></div>
            <div class="rv-body" ${options.height ? `style="height: ${options.height}px;"` : ''}>
                <div class="rv-map"></div>
                <div class="rv-chart hidden"><canvas></canvas></div>
                <div class="rv-empty hidden"></div>
                ${options.follow ? '<button type="button" class="rv-follow hidden" aria-label="Keep the map centred on me" title="Keep the map centred on me">🎯</button>' : ''}
            </div>
            <div class="rv-stop stop-card hidden"></div>`;
        this.mapEl = host.querySelector('.rv-map');
        this.chartEl = host.querySelector('.rv-chart');
        this.emptyEl = host.querySelector('.rv-empty');
        this.noteEl = host.querySelector('.rv-note');
        this.stopEl = host.querySelector('.rv-stop');
        this.stops = [];
        this.stages = [];
        this.map = null;
        this.chart = null;

        host.querySelectorAll('[data-mode]').forEach(button => {
            button.addEventListener('click', () => setMapMode(button.dataset.mode));
        });
        host.querySelector('.rv-locate').addEventListener('click', toggleLocate);
        const follow = host.querySelector('.rv-follow');
        if (follow) follow.addEventListener('click', () => setFollow(!state.follow));
        this.followEl = follow;
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
        this.stops = [];       // lunch stops, placed along the same x axis

        let offset = 0;
        this.stages.forEach(stage => {
            const profile = stage.elevation_profile || [];
            const boundary = { id: stageIdOf(stage), start: offset, end: offset };
            (stage.lunch_stops || []).forEach(stop => {
                if (stop.lat == null) return;
                this.stops.push({ key: stopKey(stop), stop, stage, x: offset + stop.km, y: heightAt(profile, stop.km) });
            });
            stage.route_path.forEach((point, k) => {
                const km = profile[k] ? profile[k][0] : (k / (stage.route_path.length - 1)) * (stage.standard_distance || 0);
                this.track.push({ lat: point[0], lon: point[1], x: offset + km, y: profile[k] ? profile[k][1] : null });
                if (profile[k]) this.points.push({ x: offset + km, y: profile[k][1] });
            });
            offset = this.track[this.track.length - 1].x;
            boundary.end = offset;
            this.boundaries.push(boundary);
        });
        this.stopPoints = this.stops.filter(item => item.y != null)
            .map(item => ({ x: item.x, y: item.y, key: item.key, name: item.stop.name, kind: item.stop.kind }));
        this.render(true);
    }

    updateButtons() {
        this.host.querySelectorAll('[data-mode]').forEach(button => {
            button.classList.toggle('active', button.dataset.mode === state.mapMode);
        });
        this.host.querySelector('.rv-locate').textContent = state.watchId != null ? '📍 Stop locating' : '📍 My location';
        if (this.followEl) {
            this.followEl.classList.toggle('hidden', state.watchId == null || state.mapMode !== 'route');
            this.followEl.classList.toggle('on', state.follow);
            this.followEl.setAttribute('aria-pressed', String(state.follow));
        }
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
        this.renderStopPanel();
    }

    renderMap(fit) {
        if (!this.map) {
            this.map = L.map(this.mapEl);
            L.tileLayer(TILE.url, { attribution: TILE.attribution, maxZoom: 19 }).addTo(this.map);
            // Dragging the map by hand means "stop following me"
            if (this.opts.follow) this.map.on('dragstart', () => { if (state.follow) setFollow(false); });
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
            const quote = isQuote(stage);
            const color = quote ? '#8e24aa' : stage.is_completed ? '#2e7d32' : '#e65100';
            const line = L.polyline(stage.route_path, {
                color,
                dashArray: quote ? '8 8' : null,
                weight: focused && several ? 7 : 5,
                opacity: focused || !several ? 0.95 : 0.55
            }).addTo(this.routeLayer);
            line.bindTooltip(`${escapeHtml(stage.start_location)} → ${escapeHtml(stage.end_location)} · ${fmtDist(stage.actual_distance || 0, 0)}`, { sticky: true });
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

        // Hotels (where known), then the lunch dots on top
        this.markers = new Map();
        const hotelsShown = new Set();
        this.stages.forEach(stage => {
            const cw = stage.caminoways || {};
            [['start', cw.start_hotel], ['end', cw.end_hotel]].forEach(([which, hotel]) => {
                const lat = stage[`${which}_hotel_lat`], lon = stage[`${which}_hotel_lon`];
                if (lat == null || hotelsShown.has(`${lat},${lon}`)) return;
                hotelsShown.add(`${lat},${lon}`);
                L.marker([lat, lon], { icon: L.divIcon({ className: 'hotel-dot', html: '🏨', iconSize: [22, 22] }), keyboard: false })
                    .bindTooltip(escapeHtml((hotel && hotel.name) || stage[`${which}_hotel`] || 'Hotel'), { direction: 'top', offset: [0, -8] })
                    .addTo(this.routeLayer);
            });
        });
        this.stops.forEach(item => {
            const marker = L.circleMarker([item.stop.lat, item.stop.lon], stopStyle(item.key === state.stopKey))
                .bindTooltip(`${FOOD_ICONS[item.stop.kind] || '🍴'} ${escapeHtml(item.stop.name)}`, { direction: 'top', offset: [0, -8] })
                .on('click', () => selectStop(item.key, { reveal: true }))
                .addTo(this.routeLayer);
            this.markers.set(item.key, marker);
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
        const heading = Number.isFinite(state.user.heading) ? state.user.heading : null;
        const icon = L.divIcon({
            className: '', iconSize: [26, 26], iconAnchor: [13, 13],
            html: `<div class="user-dot"><div class="user-wrap" style="transform: rotate(${heading || 0}deg)">${heading != null ? '<div class="arrow"></div>' : ''}</div></div>`
        });
        L.marker(here, { icon, keyboard: false, zIndexOffset: 1000 })
            .bindTooltip('You are here', { direction: 'top', offset: [0, -10] })
            .addTo(this.userLayer);
    }

    renderChart() {
        if (this.chart) { this.chart.destroy(); this.chart = null; }
        const view = this;
        const kx = state.units === 'mi' ? KM_TO_MI : 1, ky = state.units === 'mi' ? M_TO_FT : 1;
        const heightUnit = state.units === 'mi' ? 'ft' : 'm';
        const shownPoints = this.points.map(p => ({ x: p.x * kx, y: p.y * ky }));
        const shownStops = this.stopPoints.map(p => ({ ...p, x: p.x * kx, y: p.y * ky }));
        const overlay = {
            id: 'routeOverlay',
            beforeDatasetsDraw(chart) {
                // Shade the focused stage when several are shown
                if (view.boundaries.length < 2) return;
                const focus = view.boundaries.find(b => b.id === view.focusId);
                if (!focus) return;
                const { ctx, chartArea, scales } = chart;
                const x0 = scales.x.getPixelForValue(focus.start * kx), x1 = scales.x.getPixelForValue(focus.end * kx);
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
                    const x = scales.x.getPixelForValue(boundary.start * kx);
                    ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
                });
                // The user
                const here = view.userOnRoute;
                if (here && here.offKm <= 3) {
                    const x = scales.x.getPixelForValue(here.x * kx);
                    ctx.setLineDash([]);
                    ctx.strokeStyle = '#1976d2'; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
                    if (here.y != null) {
                        const y = scales.y.getPixelForValue(here.y * ky);
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
                data: shownPoints,
                parsing: false,
                borderColor: '#8B4513',
                backgroundColor: 'rgba(210, 105, 30, 0.25)',
                fill: true,
                pointRadius: 0,
                borderWidth: 2,
                tension: 0.15
            }, {
                // Lunch stops: clickable dots on the profile
                type: 'line',
                data: shownStops,
                parsing: false,
                showLine: false,
                borderWidth: 2,
                borderColor: '#5d4037',
                backgroundColor: ctx => ctx.raw && ctx.raw.key === state.stopKey ? '#d81b60' : '#ffb300',
                pointRadius: ctx => ctx.raw && ctx.raw.key === state.stopKey ? 10 : 7,
                pointHoverRadius: 10,
                pointHitRadius: 10
            }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                onClick: (event, active, chart) => {
                    const hit = chart.getElementsAtEventForMode(event, 'nearest', { intersect: true }, true).find(e => e.datasetIndex === 1);
                    if (hit && this.stopPoints[hit.index]) selectStop(this.stopPoints[hit.index].key, { reveal: true });
                },
                onHover: (event, active, chart) => {
                    const hit = chart.getElementsAtEventForMode(event, 'nearest', { intersect: true }, true).some(e => e.datasetIndex === 1);
                    chart.canvas.style.cursor = hit ? 'pointer' : 'default';
                },
                scales: {
                    x: { type: 'linear', title: { display: true, text: `Distance (${unitName()})` }, min: 0, max: shownPoints.length ? shownPoints[shownPoints.length - 1].x : 1 },
                    y: { title: { display: true, text: `Height (${heightUnit})` } }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: {
                        title: items => `${items[0].parsed.x.toFixed(1)} ${unitName()}`,
                        label: item => {
                            const stop = item.datasetIndex === 1 ? view.stopPoints[item.dataIndex] : null;
                            return stop ? `${FOOD_ICONS[stop.kind] || '🍴'} ${stop.name} · ${Math.round(item.parsed.y)} ${heightUnit}` : `${Math.round(item.parsed.y)} ${heightUnit}`;
                        }
                    } }
                }
            },
            plugins: [overlay]
        });
    }

    // The selected lunch stop changed: restyle the dots and show its details under the map / profile
    markStop() {
        if (this.markers) {
            this.markers.forEach((marker, key) => {
                const selected = key === state.stopKey;
                marker.setStyle(stopStyle(selected));
                marker.setRadius(stopStyle(selected).radius);
                if (selected) marker.bringToFront();
            });
        }
        if (this.chart) this.chart.update('none');
        this.renderStopPanel();
    }

    // The stop's details open in a popup (see renderStopBodies), so there is nothing to show under the map any more
    renderStopPanel() {
        this.stopEl.classList.add('hidden');
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
            const away = offKm < 0.1 ? 'on the route' : offKm < 1 ? `${fmtElev(offKm * 1000)} from the route` : `${fmtDist(offKm)} from the route`;
            text = offKm > 3
                ? `📍 You are ${away}, too far to place on this route.`
                : `📍 You are ${away}, ${fmtDist(x)} along.`;
        }
        this.noteEl.textContent = text;
        this.noteEl.classList.toggle('hidden', !text || !!this.opts.noNote);
    }

    setUser() {
        this.updateNote();
        if (state.mapMode === 'route') this.drawUser();
        else if (this.chart) this.chart.draw();
        this.followUser();
    }

    // Keep the walker in the middle of the map, when that's switched on and the Map tab is showing
    followUser() {
        if (!this.opts.follow || !state.follow || !state.user || !this.map || state.mapMode !== 'route' || state.tab !== 'map') return;
        this.map.setView([state.user.lat, state.user.lon], Math.max(this.map.getZoom(), 16), { animate: true });
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

function setFollow(on) {
    state.follow = on;
    views.forEach(view => { view.updateButtons(); if (on) view.followUser(); });
    if (typeof walkRefresh === 'function') walkRefresh();
}

let lastFix = null;

// Takes a position from the browser. A fix that arrives soon after the last and has barely moved is ignored,
// which saves redrawing (and battery) while someone stands still.
function acceptFix(coords) {
    const here = { lat: coords.latitude, lon: coords.longitude, acc: coords.accuracy,
                   heading: Number.isFinite(coords.heading) ? coords.heading : null };
    const now = Date.now();
    if (lastFix && now - lastFix.at < 4000 && kmBetween(lastFix, here) < 0.01) return false;
    lastFix = { ...here, at: now };
    state.user = here;
    return true;
}

function stopLocate() {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    state.user = null;
    lastFix = null;
    state.locateError = null;
    views.forEach(view => { view.updateButtons(); view.setUser(); });
    if (typeof walkRefresh === 'function') walkRefresh();
}

function startLocate() {
    if (state.watchId != null) return;
    if (!navigator.geolocation) {
        state.locateError = "Your browser can't share its location.";
        views.forEach(view => view.updateNote());
        if (typeof walkRefresh === 'function') walkRefresh();
        return;
    }
    state.locateError = null;
    state.watchId = navigator.geolocation.watchPosition(
        position => {
            if (!acceptFix(position.coords)) return;
            state.locateError = null;
            views.forEach(view => view.setUser());
            if (typeof walkRefresh === 'function') walkRefresh();
        },
        error => {
            if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
            state.user = null;
            lastFix = null;
            state.locateError = error.code === 1
                ? 'Location permission was denied. Allow it in your browser settings to see where you are.'
                : "Couldn't get your location.";
            views.forEach(view => { view.updateButtons(); view.setUser(); });
            if (typeof walkRefresh === 'function') walkRefresh();
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );
    views.forEach(view => { view.updateButtons(); view.updateNote(); });
    if (typeof walkRefresh === 'function') walkRefresh();
}

function toggleLocate() {
    if (state.watchId != null) stopLocate();
    else startLocate();
}

// ----------------------------------------------------------------------
// Map tab
// ----------------------------------------------------------------------

function renderMapTab() {
    const host = $('mapRoute');
    if (!state.stages.length) {
        if (mapTabView) { mapTabView.destroy(); mapTabView = null; }
        if (typeof walkRender === 'function') walkRender();
        return;
    }
    if (!mapTabView) {
        mapTabView = new RouteView(host, { fill: true, follow: true, noNote: true });
    }

    const trips = buildTrips();
    const chosen = selectedTrips(trips);
    const stage = state.view === 'stage' ? currentStage() : null;
    const onlyStage = state.mapScope === 'stage' && stage;
    $('mapScope').value = state.mapScope;
    $('mapTitle').textContent = onlyStage ? stage.name
        : chosen.length === 1 ? chosen[0].name : chosen.length ? `${chosen.length} trips` : 'No trips selected';
    mapTabView.setData(onlyStage ? [stage] : selectedStages(trips), stage ? stageIdOf(stage) : null);
    if (typeof walkRender === 'function') walkRender();
}

// ----------------------------------------------------------------------
// Tabs, events, sync
// ----------------------------------------------------------------------

function switchTab(tabName) {
    state.tab = tabName;
    document.body.classList.toggle('on-map', tabName === 'map');
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tabName);
        el.setAttribute('aria-selected', String(el.dataset.tab === tabName));
    });
    $(tabName + 'Tab').classList.remove('hidden');
    window.scrollTo(0, 0);
    fitLayout();
    // Maps and charts drawn while hidden have no size, so redraw them now they're visible
    setTimeout(() => {
        fitLayout();
        views.forEach(view => { view.resize(); if (view === mapTabView || view === miniView || view === sideView) view.render(true); });
        if (tabName === 'map' && mapTabView) mapTabView.followUser();
    }, 50);
    if (typeof syncWakeLock === 'function') syncWakeLock();
}

// Sizes that depend on the screen: the stage panes on tablets and desktops, and the walking map. Phones let the page scroll.
function fitLayout() {
    const root = document.documentElement;
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const mail = $('mail');
    if (state.tab === 'itinerary' && !mail.classList.contains('hidden') && !isPhone()) {
        const top = mail.getBoundingClientRect().top + window.scrollY;
        root.style.setProperty('--mail-height', `${Math.max(480, Math.round(vh - top - 16))}px`);
    }
    if (state.tab === 'map') {
        const top = $('walk').getBoundingClientRect().top + window.scrollY;
        const bar = isPhone() ? document.querySelector('.tabs').offsetHeight : 0;
        root.style.setProperty('--walk-height', `${Math.max(320, Math.round(vh - top - bar - 12))}px`);
    }
    views.forEach(view => view.resize());
}

let layoutQueued = false;
function queueFitLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; fitLayout(); });
}

function setUnits(units) {
    state.units = units;
    writeText(UNITS_KEY, units);
    $('unitsBtn').textContent = unitName();
    refreshAll();
}

async function loadConfig() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
        const response = await fetch('/api/config', { signal: controller.signal });
        if (response.ok) {
            appConfig = await response.json();
            if (appConfig.tile_url) TILE.url = appConfig.tile_url;
            if (appConfig.tile_attribution) TILE.attribution = appConfig.tile_attribution;
        }
    } catch (error) {
        console.warn('No server configuration, using the defaults:', error);
    } finally {
        clearTimeout(timer);
    }
}

function setupEventListeners() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    $('logoutBtn').addEventListener('click', clearData);
    $('syncBtn').addEventListener('click', openSyncDialog);
    $('unitsBtn').textContent = unitName();
    $('unitsBtn').addEventListener('click', () => setUnits(state.units === 'km' ? 'mi' : 'km'));
    $('showQuotes').addEventListener('change', e => {
        state.showQuotes = e.target.checked;
        writePref(SHOW_QUOTES_KEY, state.showQuotes);
        refreshAll();
    });
    $('mapScope').addEventListener('change', e => { state.mapScope = e.target.value; renderMapTab(); });

    // Trip drop-down: several trips can be ticked at once
    const picker = $('tripPicker');
    picker.addEventListener('click', e => {
        if (e.target.closest('#tripPickerBtn')) {
            state.tripMenuOpen = !state.tripMenuOpen;
            renderTripPicker(buildTrips());
            return;
        }
        const action = e.target.closest('[data-picker]');
        if (action) setTripKeys(action.dataset.picker === 'all' ? buildTrips().map(t => t.key) : []);
    });
    picker.addEventListener('change', e => {
        if (!e.target.matches('[data-trip]')) return;
        const trips = buildTrips();
        setTripKeys([...picker.querySelectorAll('[data-trip]')].filter(box => box.checked).map(box => trips[Number(box.dataset.trip)].key));
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (state.tripMenuOpen) { state.tripMenuOpen = false; renderTripPicker(buildTrips()); }
            if (!$('stopSheet').classList.contains('hidden')) selectStop(null);
            else if (!$('townSheet').classList.contains('hidden')) closeTown();
            const sync = document.getElementById('syncSheet');
            if (sync) sync.remove();
        }
        if (e.target.closest && e.target.closest('[data-town]')) return;
        const row = e.target.closest && e.target.closest('tr[data-goto]');
        if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectStageById(row.dataset.goto, 'detail'); }
    });

    // Clicks on lunch stops, retry links and overview rows. Delegated, because the panels are redrawn often.
    document.addEventListener('click', e => {
        if (state.tripMenuOpen && !e.composedPath().includes(picker)) {
            state.tripMenuOpen = false;
            renderTripPicker(buildTrips());
        }
        const townButton = e.target.closest('[data-town]');
        if (townButton) {
            const { town, lat, lon } = townButton.dataset;
            openTown(town, lat != null ? Number(lat) : null, lon != null ? Number(lon) : null);
            return;
        }
        if (e.target.closest('[data-town-close]') || e.target === $('townSheet')) { closeTown(); return; }
        if (e.target.closest('[data-town-retry]')) {
            const [name, lat, lon] = JSON.parse($('townSheet').dataset.retry);
            townCache.delete(`${name}|${lat ?? ''}|${lon ?? ''}`);
            openTown(name, lat, lon);
            return;
        }
        const today = e.target.closest('[data-today-trip]');
        if (today) { goToToday(today.dataset.todayTrip, today.dataset.todayStage); return; }
        const day = e.target.closest('[data-day]');
        if (day) { selectStageById(day.dataset.day, 'detail'); return; }
        const service = e.target.closest('[data-open-service]');
        if (service) {
            state.detailTab = 'caminoways';
            state.serviceKind = service.dataset.openService || null;
            renderDetail();
            scrollDetailToTop();
            return;
        }
        const stop = e.target.closest('[data-stop]');
        if (stop) { selectStop(stop.dataset.stop); return; }
        if (e.target.closest('[data-stop-close]') || e.target === $('stopSheet')) { selectStop(null); return; }
        const row = e.target.closest('tr[data-goto]');
        if (row) selectStageById(row.dataset.goto, 'detail');
    });

    // "‹ Trips" / "‹ Stages" buttons for narrow screens, where one column shows at a time
    $('mail').addEventListener('click', e => {
        const back = e.target.closest('[data-back]');
        if (back) { state.pane = back.dataset.back; $('mail').dataset.pane = state.pane; window.scrollTo(0, 0); }
    });
    window.addEventListener('resize', queueFitLayout);
    window.addEventListener('orientationchange', () => setTimeout(queueFitLayout, 250));
    if (window.visualViewport) window.visualViewport.addEventListener('resize', queueFitLayout);
    // Crossing a breakpoint changes the layout (a map beside the detail, a bar at the bottom), so draw it again
    wideQuery.addEventListener('change', () => refreshAll());
    phoneQuery.addEventListener('change', () => refreshAll());
}

document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    if (typeof initWalkSheet === 'function') initWalkSheet();
    await loadConfig();   // the map's tile server comes from here, so wait (briefly) before drawing a map
    loadSavedStages();
});

function openSyncDialog() {
    if (document.getElementById('syncSheet')) return;
    const modal = document.createElement('div');
    modal.id = 'syncSheet';
    modal.className = 'sheet';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Sync from CaminoWays');
    modal.innerHTML = `
        <form id="syncForm" class="sheet-card" autocomplete="off">
            <div class="sheet-head"><h3>Sync from CaminoWays</h3>
                <button type="button" class="sheet-close" id="syncClose" aria-label="Close">✕</button></div>
            <div class="sheet-body">
                <p class="small" style="margin-bottom: 1rem;">
                    Your login is sent once, over HTTPS, to read your bookings. It is never stored or logged.
                    The trips are saved in this browser only.
                </p>
                <div class="form-group">
                    <label for="syncEmail">CaminoWays email</label>
                    <input type="email" id="syncEmail" required autocomplete="off" inputmode="email" autocapitalize="off">
                </div>
                <div class="form-group">
                    <label for="syncPassword">CaminoWays password</label>
                    <input type="password" id="syncPassword" required autocomplete="off">
                </div>
                <label class="check-row">
                    <input type="checkbox" id="syncQuotes" ${readPref(IMPORT_QUOTES_KEY, true) ? 'checked' : ''}>
                    Also import quotes (trips not yet booked)
                </label>
                <div id="syncError" role="alert" style="color: var(--danger); font-size: 0.9rem; margin-bottom: 0.7rem; min-height: 1.2em;"></div>
                <div class="sync-actions">
                    <button type="button" id="syncCancel" class="cancel">Cancel</button>
                    <button type="submit" id="syncSubmit">Sync</button>
                </div>
            </div>
        </form>`;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#syncCancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#syncClose').addEventListener('click', () => modal.remove());
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
    const includeQuotes = modal.querySelector('#syncQuotes').checked;
    writePref(IMPORT_QUOTES_KEY, includeQuotes);

    submit.innerHTML = '<span class="spinner"></span> Syncing...';
    submit.disabled = true;
    errorBox.textContent = '';

    try {
        const response = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: passwordInput.value, include_quotes: includeQuotes })
        });
        passwordInput.value = '';

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || 'Sync failed. Please try again.');
        }

        const data = await response.json();
        state.stages = data.stages;
        if (includeQuotes && data.stages.some(isQuote)) {
            state.showQuotes = true;  // they asked for quotes, so show what came back
            writePref(SHOW_QUOTES_KEY, true);
        }
        state.tripKeys = null;   // start from the next trip to walk
        state.stageId = null;
        state.view = 'overview';
        state.stopKey = null;
        state.pane = 'stages';
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
        state.tripKeys = null;
        state.stageId = null;
        state.view = 'overview';
        refreshAll();
    }
}
