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
    const today = new Date().toISOString().slice(0, 10);
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

    updateStats();
    renderViewOptions(trips);
    renderItinerary(trips);
    renderMapTab();
}

function updateStats() {
    // Quotes aren't walked or booked, so they stay out of the totals
    const confirmed = state.stages.filter(s => !isQuote(s));
    const completed = confirmed.filter(s => s.is_completed);
    const remaining = confirmed.filter(s => !s.is_completed);
    const sum = (list, field) => list.reduce((total, s) => total + (s[field] || 0), 0);
    $('totalStages').textContent = confirmed.length;
    $('completedStages').textContent = completed.length;
    // Actual (hotel to hotel) is the main figure, the published distance sits under it
    $('totalDistance').textContent = sum(completed, 'actual_distance').toFixed(1) + ' km';
    $('totalDistanceOfficial').textContent = `official ${sum(completed, 'standard_distance').toFixed(1)} km`;
    $('remainingDistance').textContent = sum(remaining, 'actual_distance').toFixed(1) + ' km';
    $('remainingDistanceOfficial').textContent = `official ${sum(remaining, 'standard_distance').toFixed(1)} km`;
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

    if (!state.stages.length) {
        $('stagesPane').innerHTML = '';
        $('detailPane').innerHTML = '';
        destroyMiniView();
        mail.classList.add('hidden');
        $('emptyState').classList.remove('hidden');
        return;
    }
    mail.classList.remove('hidden');
    $('emptyState').classList.add('hidden');

    renderStages(trips);
    renderDetail();
}

function activate(el, handler) {
    el.addEventListener('click', handler);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
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
            item.className = 'list-item' + (isQuote(stage) ? ' quote' : '') + (state.view === 'stage' && stageIdOf(stage) === state.stageId ? ' selected' : '');
            item.tabIndex = 0;
            item.innerHTML = `
                <div class="item-row">
                    <div class="item-title">${escapeHtml(stage.start_location)} → ${escapeHtml(stage.end_location)}</div>
                    <span class="status" title="${isQuote(stage) ? 'Quote' : stage.is_completed ? 'Walked' : 'Upcoming'}">${isQuote(stage) ? '📝' : stage.is_completed ? '✅' : '⏳'}</span>
                </div>
                <div class="item-sub">Day ${index + 1} · ${formatDate(stage.date_walked)}</div>
                <div class="item-meta">
                    <span>${(stage.actual_distance || 0).toFixed(1)} km <span class="muted" title="Distance published by CaminoWays">(official ${(stage.standard_distance || 0).toFixed(0)})</span></span>
                    ${stage.ascent_m != null ? `<span>⬆ ${Math.round(stage.ascent_m)} m ⬇ ${Math.round(stage.descent_m)} m</span>` : ''}
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
}

// What the selected trips add up to: distances (hotel to hotel and official), nights, average stage
function overviewHtml(trips) {
    const chosen = selectedTrips(trips);
    if (!chosen.length) {
        return '<div class="note-box">Choose one or more trips from the <strong>Trips</strong> drop-down to see an overview.</div>';
    }
    const total = combineStats(chosen.map(t => t.stats));
    const first = chosen.map(t => t.start).sort()[0], last = chosen.map(t => t.end).sort().pop();
    const title = chosen.length === 1 ? chosen[0].name : `${chosen.length} trips selected`;
    const sub = chosen.length === 1 && chosen[0].routeName ? `${escapeHtml(chosen[0].routeName)} · ` : '';
    const official = value => `official ${value.toFixed(1)} km`;

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
            <td>${escapeHtml(stage.start_location)} → ${escapeHtml(stage.end_location)}${isQuote(stage) ? ' 📝' : ''}</td>
            <td class="num">${(stage.actual_distance || 0).toFixed(1)}</td>
            <td class="num muted">${(stage.standard_distance || 0).toFixed(0)}</td>
            <td class="num">${stage.ascent_m != null ? Math.round(stage.ascent_m) : '–'}</td>
        </tr>`).join('')).join('');

    return `
        <h2>${escapeHtml(title)}</h2>
        <div class="detail-sub">${sub}${formatDate(first)} – ${formatDate(last)}</div>

        <div class="metrics">
            ${metric('Distance, hotel to hotel', `${total.actual.toFixed(1)} km`, official(total.official))}
            ${metric('Stages', total.count)}
            ${metric('Nights', total.nights)}
            ${metric('Average per stage', `${total.avgActual.toFixed(1)} km`, official(total.avgOfficial))}
            ${total.hasClimb ? metric('Ascent', `⬆ ${Math.round(total.ascent)} m`) : ''}
            ${total.hasClimb ? metric('Descent', `⬇ ${Math.round(total.descent)} m`) : ''}
        </div>
        <p class="small">${basis}Official is the distance CaminoWays publishes.</p>

        <div id="overviewRoute"></div>

        ${chosen.length > 1 ? `
            <section><h4>🧭 Trips</h4>
                <div class="table-wrap">
                <table class="days">
                    <thead><tr><th>Trip</th><th>Dates</th><th class="num">Stages</th><th class="num">Nights</th><th class="num">Hotel to hotel (km)</th><th class="num">Official (km)</th><th class="num">Avg / stage</th></tr></thead>
                    <tbody>${chosen.map(trip => `
                        <tr><td>${escapeHtml(trip.name)}${trip.isQuote ? ' 📝' : ''}</td><td>${formatDate(trip.start)} – ${formatDate(trip.end)}</td>
                            <td class="num">${trip.stats.count}</td><td class="num">${trip.stats.nights}</td>
                            <td class="num">${trip.stats.actual.toFixed(1)}</td><td class="num muted">${trip.stats.official.toFixed(0)}</td>
                            <td class="num">${trip.stats.avgActual.toFixed(1)}</td></tr>`).join('')}
                    </tbody>
                </table>
                </div>
            </section>` : ''}

        <section><h4>📅 Day by day</h4>
            <div class="table-wrap">
                <table class="days">
                    <thead><tr><th>Day</th><th>Date</th><th>Stage</th><th class="num">Hotel to hotel (km)</th><th class="num">Official (km)</th><th class="num">Ascent (m)</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </section>`;
}

function renderDetail() {
    const pane = $('detailPane');
    destroyMiniView();
    const trips = buildTrips();
    const stage = state.view === 'stage' ? currentStage() : null;

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

    pane.innerHTML = `
        <div class="pane-head"><button class="back-btn" data-back="stages">‹ Stages</button>
            <span>${escapeHtml(stage.name)}</span></div>
        <div class="detail-body">
            <h2>${escapeHtml(stage.start_location)} → ${escapeHtml(stage.end_location)}</h2>
            <div class="detail-sub">${formatDate(stage.date_walked, true)} ·
                ${isQuote(stage) ? '📝 Quote, not booked' : stage.is_completed ? '✅ Walked' : '⏳ Upcoming'}</div>
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

    pane.querySelectorAll('[data-service]').forEach(button => {
        button.addEventListener('click', () => {
            state.serviceKind = state.serviceKind === button.dataset.service ? null : button.dataset.service;
            renderDetail();
        });
    });

    if (state.detailTab === 'general') {
        const host = $('miniRoute');
        if (host) {
            miniView = new RouteView(host, { height: 280 });
            miniView.setData([stage], stageIdOf(stage));
        }
        ensureStopDetails();
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

// General: what we know about the stage from public route data
function generalHtml(stage) {
    const hasRoute = stage.route_path && stage.route_path.length > 1;
    const hasClimb = stage.ascent_m != null;
    const lunches = stage.lunch_stops || [];
    const places = stage.places_passed || [];
    const official = stage.standard_distance || 0;
    const actual = stage.actual_distance || official;
    const distanceLabel = stage.actual_basis === 'hotels' ? 'Distance, hotel to hotel'
        : stage.actual_basis === 'route' ? 'Distance along the route' : 'Distance';

    return `
        <div class="metrics">
            ${metric(distanceLabel, `${actual.toFixed(1)} km`, `official ${official.toFixed(1)} km`)}
            ${hasClimb ? metric('Ascent', `⬆ ${Math.round(stage.ascent_m)} m`) : ''}
            ${hasClimb ? metric('Descent', `⬇ ${Math.round(stage.descent_m)} m`) : ''}
            ${stage.difficulty ? metric('Difficulty', difficultyBadge(stage)) : ''}
        </div>

        ${detourNote(stage)}

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
                <div class="lunch-list" id="lunchList">${lunchListHtml(stage)}</div>
                <p class="small">Click a stop, or its dot on the map or height profile, for details. From OpenStreetMap, so opening times and closures aren't guaranteed. Check ahead, and carry water and a snack.</p>
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

const stopDetails = new Map();   // stop key -> details from /api/place, 'loading' or 'error'

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
    const hours = (loaded && loaded.hours) || stop.hours;
    const links = (loaded && loaded.links) || {
        google_maps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${stop.name} ${stop.lat},${stop.lon}`)}`,
        tripadvisor: `https://www.tripadvisor.com/Search?q=${encodeURIComponent(stop.name)}`
    };
    const link = (url, label) => safeUrl(url) ? `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : '';
    const row = (icon, html) => html ? `<div>${icon} ${html}</div>` : '';

    let status = '';
    if (details === 'loading' || !details) status = '<div class="muted small">Loading more details…</div>';
    else if (details === 'error') status = `<div class="muted small">Couldn't load more details just now. <button type="button" class="linkish" data-retry="${key}">Try again</button></div>`;
    else if (loaded.lookup_failed) status = `<div class="muted small">The map data service is busy, so this is what we already had. <button type="button" class="linkish" data-retry="${key}">Try again</button></div>`;
    else if (!loaded.found_in_osm) status = '<div class="muted small">OpenStreetMap has no more details for this place.</div>';

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
        reviews = `<div class="small muted">Reviews: none are stored here. Read them on the links below.</div>`;
    }

    return `
        <div class="stop-head">
            <span>${FOOD_ICONS[stop.kind] || '🍴'} <strong>${escapeHtml(stop.name)}</strong> <span class="muted">${escapeHtml(stop.kind)}</span></span>
            <button type="button" class="linkish" data-stop-close aria-label="Close details">✕</button>
        </div>
        <div class="muted small">km ${stop.km.toFixed(1)}${total ? ` of ${total.toFixed(0)}` : ''}${stop.off_m > 50 ? ` · ${stop.off_m} m off the route` : ' · on the route'}</div>
        ${row('📍', loaded && loaded.address ? escapeHtml(loaded.address) : '')}
        ${row('🕒', hours ? escapeHtml(hours) : '')}
        ${row('🍽️', loaded && loaded.cuisine ? escapeHtml(loaded.cuisine) : '')}
        ${row('📞', loaded ? phoneLink(loaded.phone) : '')}
        ${row('🌐', loaded ? link(loaded.website, 'Website') : '')}
        ${loaded && loaded.wheelchair ? row('♿', `Wheelchair access: ${escapeHtml(loaded.wheelchair)}`) : ''}
        ${status}
        ${reviews}
        <div class="stop-links">${link(links.google_maps, 'Google Maps')} ${link(links.tripadvisor, 'TripAdvisor')} ${loaded ? link(loaded.osm_url, 'OpenStreetMap') : ''}</div>
        <div class="small muted">Opening times and closures aren't guaranteed. Check ahead.</div>`;
}

function lunchListHtml(stage) {
    const total = stage.actual_distance || stage.standard_distance || 0;
    return (stage.lunch_stops || []).map(stop => {
        const clickable = stop.lat != null;
        const key = clickable ? stopKey(stop) : null;
        const open = clickable && state.stopKey === key;
        const label = `${FOOD_ICONS[stop.kind] || '🍴'} <strong>${escapeHtml(stop.name)}</strong>
            <span class="muted">(${escapeHtml(stop.kind)}${stop.off_m > 50 ? `, ${stop.off_m} m off route` : ''})</span>
            ${stop.hours ? `<br><small class="muted">🕒 ${escapeHtml(stop.hours)}</small>` : ''}`;
        if (!clickable) return `<div class="lunch-item"><div class="lunch"><span>${label}</span><span class="muted nowrap">km ${stop.km.toFixed(1)} of ${total.toFixed(0)}</span></div></div>`;
        return `
            <div class="lunch-item ${open ? 'open' : ''}" data-lunch="${key}">
                <button type="button" class="lunch" data-stop="${key}" aria-expanded="${open}">
                    <span>${label}</span>
                    <span class="muted nowrap">km ${stop.km.toFixed(1)} of ${total.toFixed(0)} ${open ? '▾' : '▸'}</span>
                </button>
                ${open ? `<div class="stop-card" data-stop-body="${key}">${stopCardHtml(stop, stage)}</div>` : ''}
            </div>`;
    }).join('');
}

// Fetch details for the selected stop (once), then update every place that shows them
async function ensureStopDetails(force) {
    const key = state.stopKey;
    const found = key && findStop(key);
    if (!found) return;
    const current = stopDetails.get(key);
    if (!force && (current === 'loading' || (current && current !== 'error'))) return;

    stopDetails.set(key, 'loading');
    renderStopBodies();
    try {
        const params = new URLSearchParams({ name: found.stop.name, kind: found.stop.kind || '', lat: found.stop.lat, lon: found.stop.lon });
        const response = await fetch(`/api/place?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const details = await response.json();
        // A busy map service is worth another try later, so don't keep that result
        stopDetails.set(key, details);
        if (details.lookup_failed) setTimeout(() => { if (stopDetails.get(key) === details) stopDetails.delete(key); }, 30000);
    } catch (error) {
        console.error('Could not load stop details:', error);
        stopDetails.set(key, 'error');
    }
    renderStopBodies();
}

function renderStopBodies() {
    document.querySelectorAll('[data-stop-body]').forEach(el => {
        const found = findStop(el.dataset.stopBody);
        if (found) el.innerHTML = stopCardHtml(found.stop, found.stage);
    });
    views.forEach(view => view.renderStopPanel());
}

// Select a stop (or clear it). `toggle` closes it when it's already open, as the list rows do.
function selectStop(key, { toggle = false, reveal = false } = {}) {
    state.stopKey = toggle && state.stopKey === key ? null : key;

    const stage = currentStage();
    const list = $('lunchList');
    if (list && stage) list.innerHTML = lunchListHtml(stage);
    views.forEach(view => view.markStop());
    ensureStopDetails();

    if (reveal && state.stopKey) {
        const item = document.querySelector(`[data-lunch="${state.stopKey}"]`);
        if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
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
            const quote = isQuote(stage);
            const color = quote ? '#8e24aa' : stage.is_completed ? '#2e7d32' : '#e65100';
            const line = L.polyline(stage.route_path, {
                color,
                dashArray: quote ? '8 8' : null,
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
            }, {
                // Lunch stops: clickable dots on the profile
                type: 'line',
                data: this.stopPoints,
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
                    x: { type: 'linear', title: { display: true, text: 'Distance (km)' }, min: 0, max: this.points.length ? this.points[this.points.length - 1].x : 1 },
                    y: { title: { display: true, text: 'Height (m)' } }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: {
                        title: items => `km ${items[0].parsed.x.toFixed(1)}`,
                        label: item => {
                            const stop = item.datasetIndex === 1 ? view.stopPoints[item.dataIndex] : null;
                            return stop ? `${FOOD_ICONS[stop.kind] || '🍴'} ${stop.name} · ${Math.round(item.parsed.y)} m` : `${Math.round(item.parsed.y)} m`;
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

    renderStopPanel() {
        const item = state.stopKey && this.stops.find(s => s.key === state.stopKey);
        this.stopEl.classList.toggle('hidden', !item);
        if (item) this.stopEl.innerHTML = stopCardHtml(item.stop, item.stage);
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

    const trips = buildTrips();
    const chosen = selectedTrips(trips);
    const stage = state.view === 'stage' ? currentStage() : null;
    const onlyStage = state.mapScope === 'stage' && stage;
    $('mapScope').value = state.mapScope;
    $('mapTitle').textContent = onlyStage ? stage.name
        : chosen.length === 1 ? chosen[0].name : chosen.length ? `${chosen.length} trips` : 'No trips selected';
    mapTabView.setData(onlyStage ? [stage] : selectedStages(trips), stage ? stageIdOf(stage) : null);
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
        if (e.key === 'Escape' && state.tripMenuOpen) { state.tripMenuOpen = false; renderTripPicker(buildTrips()); }
        const row = e.target.closest && e.target.closest('tr[data-goto]');
        if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectStageById(row.dataset.goto, 'detail'); }
    });

    // Clicks on lunch stops, retry links and overview rows. Delegated, because the panels are redrawn often.
    document.addEventListener('click', e => {
        if (state.tripMenuOpen && !e.composedPath().includes(picker)) {
            state.tripMenuOpen = false;
            renderTripPicker(buildTrips());
        }
        const stop = e.target.closest('[data-stop]');
        if (stop) { selectStop(stop.dataset.stop, { toggle: true }); return; }
        if (e.target.closest('[data-stop-close]')) { selectStop(null); return; }
        const retry = e.target.closest('[data-retry]');
        if (retry) { state.stopKey = retry.dataset.retry; ensureStopDetails(true); return; }
        const row = e.target.closest('tr[data-goto]');
        if (row) selectStageById(row.dataset.goto, 'detail');
    });

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
            <label style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; margin-bottom: 0.7rem;">
                <input type="checkbox" id="syncQuotes" ${readPref(IMPORT_QUOTES_KEY, true) ? 'checked' : ''}>
                Also import quotes (trips not yet booked)
            </label>
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
