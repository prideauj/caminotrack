// Offline use: the app itself (service worker, sw.js), a "save this stage" button that keeps the map tiles along the
// route and the town descriptions, and a note in the header when the connection is lost.
// The stages are already stored in the browser, so with these a stage works without signal.

const OFFLINE_KEY = 'caminotrack.offline';       // { stageId: { at, tiles } }
const TILE_CACHE = 'tiles-v1';                    // tiles saved on purpose (the service worker never trims this one)
const MAX_TILES_PER_STAGE = 450;
const TILE_ZOOMS = [{ z: 12, r: 1 }, { z: 13, r: 1 }, { z: 14, r: 1 }, { z: 15, r: 1 }, { z: 16, r: 0 }];   // r: tiles either side of the route
const downloading = new Map();                    // stageId -> { done, total }

function readOffline() {
    try {
        return JSON.parse(localStorage.getItem(OFFLINE_KEY) || '{}');
    } catch (error) {
        return {};
    }
}

function writeOffline(store) {
    try {
        localStorage.setItem(OFFLINE_KEY, JSON.stringify(store));
    } catch (error) {
        console.warn('Could not remember which stages are saved:', error);
    }
}

// ---- Which tiles a stage needs ----

function tileNumber(lat, lon, z) {
    const n = 2 ** z, rad = lat * Math.PI / 180;
    return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n)];
}

function tileUrl(z, x, y) {
    return TILE.url.replace('{s}', 'a').replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', '');
}

// The tiles along the stage's route at walking zoom levels, as URLs. Only when the server names a tile provider that
// allows saving maps: the free OpenStreetMap server doesn't, so then only tiles you have looked at are kept (by sw.js).
function tilesForStage(stage) {
    const wanted = new Set();
    if (!appConfig.tile_url) return [];
    const zooms = TILE_ZOOMS.slice();
    for (;;) {
        wanted.clear();
        zooms.forEach(({ z, r }) => (stage.route_path || []).forEach(([lat, lon]) => {
            const [x, y] = tileNumber(lat, lon, z);
            for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) wanted.add(tileUrl(z, x + dx, y + dy));
        }));
        if (wanted.size <= MAX_TILES_PER_STAGE || zooms.length <= 2) break;
        zooms.pop();   // a very long stage: leave out the most detailed zoom
    }
    return [...wanted];
}

// ---- Saving and removing ----

async function fetchTile(cache, url) {
    if (await cache.match(url)) return;
    try {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (response.ok) await cache.put(url, response);
    } catch (error) {
        // A tile server without CORS headers can still be cached as an opaque response
        const response = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
        await cache.put(url, response);
    }
}

async function saveStageOffline(stage) {
    const id = stageIdOf(stage);
    if (downloading.has(id)) return;
    const urls = tilesForStage(stage);
    downloading.set(id, { done: 0, total: urls.length });
    renderOfflineBox(stage);
    try {
        const cache = await caches.open(TILE_CACHE);
        const queue = urls.slice();
        const worker = async () => {
            while (queue.length) {
                const url = queue.shift();
                try { await fetchTile(cache, url); } catch (error) { console.warn('Tile failed:', url, error); }
                downloading.get(id).done++;
                updateOfflineProgress(id);
            }
        };
        await Promise.all([worker(), worker(), worker()]);

        // Town descriptions along the stage, so the town sheet works too (the service worker keeps each answer)
        const [from, to] = pathEnds(stage);
        const towns = [[stage.start_location, from], [stage.end_location, to],
                       ...(stage.places_passed || []).filter(p => p.type !== 'hamlet' && p.info !== false).map(p => [p.name, p.lat != null ? [p.lat, p.lon] : null])];
        for (const [name, point] of towns.slice(0, 14)) {
            const params = new URLSearchParams({ name });
            if (point) { params.set('lat', point[0]); params.set('lon', point[1]); }
            try { await fetch(`/api/town?${params}`); } catch (error) { /* a missing description isn't worth failing for */ }
        }

        const store = readOffline();
        store[id] = { at: Date.now(), tiles: urls.length };
        writeOffline(store);
    } catch (error) {
        console.error('Could not save the stage offline:', error);
    } finally {
        downloading.delete(id);
        renderOfflineBox(stage);
    }
}

// Remove this stage's tiles, except any another saved stage also needs
async function removeStageOffline(stage) {
    const id = stageIdOf(stage);
    const store = readOffline();
    delete store[id];
    writeOffline(store);
    try {
        const stillNeeded = new Set();
        state.stages.filter(s => store[stageIdOf(s)]).forEach(s => tilesForStage(s).forEach(url => stillNeeded.add(url)));
        const cache = await caches.open(TILE_CACHE);
        await Promise.all(tilesForStage(stage).filter(url => !stillNeeded.has(url)).map(url => cache.delete(url)));
    } catch (error) {
        console.warn('Could not free the saved tiles:', error);
    }
    renderOfflineBox(stage);
}

// ---- The box on the stage page ----

function updateOfflineProgress(id) {
    const progress = downloading.get(id);
    const bar = document.querySelector('#offlineBox .progress-bar > div');
    const text = document.querySelector('#offlineBox [data-offline-count]');
    if (!progress || !bar) return;
    bar.style.width = `${Math.round(100 * progress.done / progress.total)}%`;
    if (text) text.textContent = `${progress.done} of ${progress.total} map tiles`;
}

function renderOfflineBox(stage) {
    const box = $('offlineBox');
    if (!box) return;
    const id = stageIdOf(stage);
    if (!('caches' in window) || !('serviceWorker' in navigator)) {
        box.textContent = "This browser can't save maps for offline use. Open the stage with a signal before you set off.";
        return;
    }
    const saved = readOffline()[id];
    const progress = downloading.get(id);
    const estimate = tilesForStage(stage).length;
    const withTiles = estimate > 0;

    if (progress) {
        box.innerHTML = `
            <div class="progress-bar" role="progressbar" aria-label="Saving for offline use"><div style="width: ${progress.total ? Math.round(100 * progress.done / progress.total) : 100}%"></div></div>
            <p class="small" data-offline-count>${progress.done} of ${progress.total} map tiles</p>`;
    } else if (saved) {
        box.innerHTML = `
            <p><strong style="color: var(--success)">✓ Offline ready</strong> · saved ${new Date(saved.at).toLocaleDateString()} · ${saved.tiles ? `${saved.tiles} map tiles and ` : ''}the town descriptions.</p>
            <div class="action-row"><button type="button" class="btn-link" data-offline="refresh">Save again</button>
                <button type="button" class="btn-link" data-offline="remove">Remove</button></div>`;
    } else {
        box.innerHTML = `
            <p>${withTiles
                ? `Save this stage's map (about ${estimate} tiles, roughly ${Math.max(1, Math.round(estimate * 0.02))} MB) and its town descriptions, so it works with no signal.`
                : "Save this stage's town descriptions so they open with no signal. The free map server doesn't allow saving whole maps, so the map works offline only for areas you have already looked at."}</p>
            <div class="action-row"><button type="button" class="btn-link primary" data-offline="save" ${navigator.onLine ? '' : 'disabled'}>📥 Save for offline</button></div>`;
    }
}

// ---- Connection note and service worker ----

function updateConnection() {
    const badge = $('conn');
    if (badge) badge.classList.toggle('hidden', navigator.onLine);
}

document.addEventListener('click', e => {
    const button = e.target.closest('[data-offline]');
    if (!button) return;
    const stage = currentStage();
    if (!stage) return;
    if (button.dataset.offline === 'remove') removeStageOffline(stage);
    else saveStageOffline(stage);
});

window.addEventListener('online', updateConnection);
window.addEventListener('offline', updateConnection);
updateConnection();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(error => console.warn('Offline support is unavailable:', error));
    });
}
