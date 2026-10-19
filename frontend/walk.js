// Walking mode: the Map tab as the screen to have open on the trail.
// A sheet over the map says how far you've come and what's next, follows you as you walk, warns you when you stray from
// the route, and keeps the screen awake while it is following. Shares the page's globals (state, RouteView, ...).

let walkWakeLock = null;
let walkSwiped = false;

function initWalkSheet() {
    const sheet = $('walkSheet');
    sheet.innerHTML = `
        <div class="walk-alert hidden" id="walkAlert" role="alert"></div>
        <button type="button" class="walk-grab" id="walkGrab" aria-expanded="false" aria-controls="walkBody"
                aria-label="Show or hide walking details">
            <div class="walk-summary" id="walkSummary"></div>
        </button>
        <div class="walk-body" id="walkBody">
            <div id="walkProgress"></div>
            <div id="walkNext"></div>
            <div id="walkActions" class="walk-actions"></div>
        </div>`;

    const grab = $('walkGrab');
    let startY = null;
    grab.addEventListener('pointerdown', e => { startY = e.clientY; walkSwiped = false; });
    grab.addEventListener('pointerup', e => {
        if (startY == null) return;
        const dy = startY - e.clientY;
        startY = null;
        if (Math.abs(dy) > 30) { walkSwiped = true; setWalkSheet(dy > 0); }   // swipe up opens, swipe down closes
    });
    grab.addEventListener('pointercancel', () => { startY = null; });
    grab.addEventListener('click', () => {
        if (walkSwiped) { walkSwiped = false; return; }
        setWalkSheet(sheet.classList.contains('collapsed'));
    });

    sheet.addEventListener('click', e => {
        const action = e.target.closest('[data-walk]');
        if (!action) return;
        const what = action.dataset.walk;
        if (what === 'start') startWalking();
        else if (what === 'end') endWalking();
        else if (what === 'height') setMapMode(state.mapMode === 'height' ? 'route' : 'height');
    });

    document.addEventListener('visibilitychange', syncWakeLock);
}

function setWalkSheet(open) {
    const sheet = $('walkSheet');
    sheet.classList.toggle('collapsed', !open);
    $('walkGrab').setAttribute('aria-expanded', String(open));
}

// ---- Where the walker is along the stage ----

function stageKmAt(stage, index) {
    const point = (stage.elevation_profile || [])[index];
    if (point) return point[0];
    return (index / (stage.route_path.length - 1)) * (stage.standard_distance || 0);
}

// The closest point of the stage's route to the walker: how far along it is (km) and how far off it (km)
function nearestOnStage(stage, user) {
    let best = null;
    (stage.route_path || []).forEach((point, index) => {
        const off = kmBetween(user, { lat: point[0], lon: point[1] });
        if (!best || off < best.offKm) best = { offKm: off, km: stageKmAt(stage, index) };
    });
    return best;
}

// The stage the walker is on: the closest to them (today's, when two meet at a town), else today's stage, else the next
function walkingStage() {
    const stages = mapTabView ? mapTabView.stages : [];
    if (!stages.length) return null;
    const today = todayIso();
    if (state.user) {
        const near = stages.map(stage => ({ stage, near: nearestOnStage(stage, state.user) })).filter(item => item.near);
        const closest = Math.min(...near.map(item => item.near.offKm));
        if (closest <= 3) {
            const candidates = near.filter(item => item.near.offKm <= closest + 0.15);
            return (candidates.find(item => item.stage.date_walked === today) || candidates[0]).stage;
        }
    }
    return stages.find(s => s.date_walked === today) || stages.find(s => !s.is_completed) || stages[0];
}

// Climbing left between a point on the stage and its end, from the height profile (metres)
function climbAfter(stage, km) {
    const profile = (stage.elevation_profile || []).filter(point => point[0] >= km);
    let climb = 0;
    for (let i = 1; i < profile.length; i++) climb += Math.max(0, profile[i][1] - profile[i - 1][1]);
    return climb;
}

// A steady walking pace: 5 km/h, plus 10 minutes for every 100 m climbed (Naismith's rule)
function minutesLeft(stage, km, total) {
    return Math.round(((total - km) / 5) * 60 + (climbAfter(stage, km) / 100) * 10);
}

function formatMinutes(minutes) {
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return hours ? `${hours} h ${String(rest).padStart(2, '0')} min` : `${rest} min`;
}

function walkProgress(stage) {
    if (!state.user) return null;
    const near = nearestOnStage(stage, state.user);
    if (!near || near.offKm > 3) return { far: near ? near.offKm : null };
    const total = routeKmOf(stage);
    const done = Math.min(near.km, total);
    const ahead = item => item.km > done + 0.05;
    const places = (stage.places_passed || []).filter(ahead);
    const nextPlace = places.find(p => p.type !== 'hamlet') || places[0] || null;
    const nextFood = (stage.lunch_stops || []).filter(ahead).sort((a, b) => a.km - b.km)[0] || null;
    const hotelLat = stage.end_hotel_lat, hotelLon = stage.end_hotel_lon;
    const nearHotel = hotelLat != null && kmBetween(state.user, { lat: hotelLat, lon: hotelLon }) < 1;
    return { stage, total, done, left: Math.max(0, total - done), offKm: near.offKm, nextPlace, nextFood, nearHotel,
             minutes: minutesLeft(stage, done, total) };
}

// ---- The sheet ----

function walkRender() {
    const sheet = $('walkSheet');
    if (!sheet || !$('walkSummary')) return;
    sheet.classList.toggle('hidden', !mapTabView);
    if (!mapTabView) return;

    const stage = walkingStage();
    const progress = stage ? walkProgress(stage) : null;
    const located = state.watchId != null;
    const [from, to] = stage ? pathEnds(stage) : [];

    // Headline
    let summary;
    if (state.locateError) summary = `📍 ${escapeHtml(state.locateError)}`;
    else if (located && !state.user) summary = '📍 Finding your location…';
    else if (progress && progress.far != null) summary = `📍 ${fmtDist(progress.far)} from this route`;
    else if (progress) summary = `<span>${fmtDist(progress.done)} done</span><span>${fmtDist(progress.left)} to go</span>`
        + (progress.nextPlace ? `<span class="muted">next: ${escapeHtml(progress.nextPlace.name)} ${fmtDist(Math.max(0, progress.nextPlace.km - progress.done))}</span>` : '');
    else if (stage) summary = `<span>${escapeHtml(stage.start_location)} → ${escapeHtml(stage.end_location)}</span><span>${fmtDist(stage.actual_distance || stage.standard_distance || 0)}</span>`;
    else summary = 'No route data for this trip yet';
    $('walkSummary').innerHTML = summary;

    // Off the route
    const alert = $('walkAlert');
    const off = progress && progress.offKm != null && progress.offKm * 1000 > 150 && !progress.nearHotel ? progress.offKm : null;
    alert.classList.toggle('hidden', off == null);
    if (off != null) alert.textContent = `⚠ You are ${off < 1 ? fmtElev(off * 1000) : fmtDist(off)} off the route`;

    // Detail
    let html = '';
    if (progress && progress.stage) {
        const share = progress.total ? Math.min(100, Math.round(100 * progress.done / progress.total)) : 0;
        html += `
            <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${share}" aria-label="Progress along the stage"><div style="width: ${share}%"></div></div>
            <div class="walk-grid">
                ${metric('Done', fmtDist(progress.done), `${share}% of the stage`)}
                ${metric('To go', fmtDist(progress.left), `about ${formatMinutes(progress.minutes)} at a steady pace`)}
            </div>`;
    } else if (stage) {
        html += `<p class="small" style="margin: 0.4rem 0;">${located ? 'Waiting for your position…' : 'Press <strong>Start walking</strong> and the map follows you, shows how far you have come, and warns you if you leave the route.'}</p>`;
    }
    $('walkProgress').innerHTML = html;

    // What's coming up, nearest first
    const here = progress && progress.stage ? progress.done : 0;
    let next = '';
    if (stage) {
        const items = [];
        (stage.places_passed || []).filter(p => p.type !== 'hamlet' && p.km > here + 0.05)
            .forEach(p => items.push({ km: p.km, html: `🏘 ${townLink(p.name, p.lat != null ? [p.lat, p.lon] : null)}` }));
        (stage.lunch_stops || []).filter(s => s.km > here + 0.05)
            .forEach(s => items.push({ km: s.km, html: `${FOOD_ICONS[s.kind] || '🍴'} ${s.lat != null ? `<button type="button" class="tl-stop" data-stop="${stopKey(s)}">${escapeHtml(s.name)}</button>` : escapeHtml(s.name)}` }));
        items.sort((a, b) => a.km - b.km);
        const gap = stage.food_gap;
        const gapAhead = gap && gap.km >= 5 && gap.to > here ? gap : null;
        if (items.length || gapAhead) {
            next = `<h4 style="margin-top: 0.6rem;">Coming up</h4><ul class="walk-next">
                ${gapAhead ? `<li style="color: var(--danger)"><span>⚠ ${fmtDist(gapAhead.km, 0)} without food or drink</span><span class="nowrap">${gapAhead.from > here ? `in ${fmtDist(gapAhead.from - here)}` : `${fmtDist(gapAhead.to - here)} left`}</span></li>` : ''}
                ${items.slice(0, 6).map(item => `<li><span>${item.html}</span><span class="nowrap muted">${progress && progress.stage ? `in ${fmtDist(item.km - here)}` : `km ${distNumber(item.km)}`}</span></li>`).join('')}
            </ul>`;
        }
    }
    $('walkNext').innerHTML = next;

    // Buttons
    const hotelLat = stage && stage.end_hotel_lat, hotelLon = stage && stage.end_hotel_lon;
    $('walkActions').innerHTML = `
        ${located ? '<button type="button" class="walk-start" data-walk="end">■ Stop walking</button>'
                  : '<button type="button" class="walk-start" data-walk="start">▶ Start walking</button>'}
        <button type="button" class="btn-link" data-walk="height">${state.mapMode === 'height' ? '🗺 Map' : '⛰ Height profile'}</button>
        ${hotelLat != null ? `<a class="btn-link" href="https://www.google.com/maps/dir/?api=1&destination=${hotelLat},${hotelLon}" target="_blank" rel="noopener noreferrer">🧭 Navigate to ${escapeHtml(stage.end_hotel || 'tonight\'s hotel')}</a>` : ''}
        ${located && state.follow && 'wakeLock' in navigator ? '<span class="small">The screen stays on while following.</span>' : ''}`;
}

// ---- Start and stop ----

function startWalking() {
    const stage = walkingStage();
    if (stage && !state.user) {
        // Show the stage being walked on its own, so the map frames it
        state.mapScope = 'stage';
        state.stageId = stageIdOf(stage);
        state.view = 'stage';
    }
    state.follow = true;
    startLocate();
    refreshAll();
    syncWakeLock();
}

function endWalking() {
    stopLocate();
    syncWakeLock();
}

// Called whenever the position, the following switch or the error changes
function walkRefresh() {
    walkRender();
    syncWakeLock();
}

// Keep the screen on while following on the Map tab (and let it go the moment that stops being true)
async function syncWakeLock() {
    const wanted = state.tab === 'map' && state.watchId != null && state.follow && document.visibilityState === 'visible';
    try {
        if (wanted && !walkWakeLock && 'wakeLock' in navigator) {
            walkWakeLock = await navigator.wakeLock.request('screen');
            walkWakeLock.addEventListener('release', () => { walkWakeLock = null; });
        } else if (!wanted && walkWakeLock) {
            const lock = walkWakeLock;
            walkWakeLock = null;
            await lock.release();
        }
    } catch (error) {
        console.warn('Could not change the screen wake lock:', error);
    }
}
