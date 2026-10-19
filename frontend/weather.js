// Weather and daylight for a stage, from Open-Meteo (free, no key). Forecasts reach 16 days ahead.
// The last answer for each stage is kept in the browser so it can still be shown without a signal.

const WEATHER_KEY = 'caminotrack.weather';
const WEATHER_KEEP = 12;
const weatherMemory = new Map();

// WMO weather codes, in groups
function describeWeather(code) {
    if (code === 0) return ['Clear', '☀️'];
    if (code === 1) return ['Mostly clear', '🌤️'];
    if (code === 2) return ['Partly cloudy', '⛅'];
    if (code === 3) return ['Overcast', '☁️'];
    if (code === 45 || code === 48) return ['Fog', '🌫️'];
    if (code >= 51 && code <= 57) return ['Drizzle', '🌦️'];
    if (code >= 61 && code <= 67) return ['Rain', '🌧️'];
    if (code >= 71 && code <= 77 || code === 85 || code === 86) return ['Snow', '🌨️'];
    if (code >= 80 && code <= 82) return ['Showers', '🌦️'];
    if (code >= 95) return ['Thunderstorm', '⛈️'];
    return ['Mixed', '🌥️'];
}

function readWeatherStore() {
    try {
        return JSON.parse(localStorage.getItem(WEATHER_KEY) || '{}');
    } catch (error) {
        return {};
    }
}

function rememberWeather(key, data) {
    try {
        const store = readWeatherStore();
        store[key] = { at: Date.now(), data };
        const newest = Object.entries(store).sort((a, b) => b[1].at - a[1].at).slice(0, WEATHER_KEEP);
        localStorage.setItem(WEATHER_KEY, JSON.stringify(Object.fromEntries(newest)));
    } catch (error) {
        console.warn('Could not keep the forecast:', error);
    }
}

function clockTime(iso) {
    return iso ? iso.slice(11, 16) : '';
}

function daylightHours(sunrise, sunset) {
    if (!sunrise || !sunset) return '';
    const minutes = Math.round((new Date(sunset) - new Date(sunrise)) / 60000);
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min of daylight`;
}

function addDaysIso(iso, days) {
    const date = new Date(iso + 'T00:00:00');
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function weatherCard(label, place, day, imperial) {
    const [text, icon] = describeWeather(day.weather_code);
    const degrees = imperial ? '°F' : '°C';
    const wind = imperial ? 'mph' : 'km/h';
    return `
        <div class="wx">
            <div class="wx-head">${label} · ${escapeHtml(place)}</div>
            <div class="wx-main"><span aria-hidden="true">${icon}</span> ${text}</div>
            <div>${Math.round(day.temperature_2m_min)}${degrees} to ${Math.round(day.temperature_2m_max)}${degrees}</div>
            <div class="muted">Rain ${day.precipitation_probability_max != null ? `${day.precipitation_probability_max}% chance` : '–'}${day.precipitation_sum ? `, ${day.precipitation_sum.toFixed(1)} ${imperial ? 'in' : 'mm'}` : ''}</div>
            <div class="muted">Wind up to ${Math.round(day.wind_speed_10m_max)} ${wind}</div>
        </div>`;
}

function showWeather(box, stage, data, imperial, note) {
    const [startData, endData] = Array.isArray(data) ? data : [data, data];
    const start = {}, end = {};
    Object.keys(startData.daily).forEach(field => { start[field] = startData.daily[field][0]; end[field] = endData.daily[field][0]; });
    box.innerHTML = `
        ${weatherCard('Start', stage.start_location, start, imperial)}
        ${weatherCard('Finish', stage.end_location, end, imperial)}
        <div class="wx">
            <div class="wx-head">Daylight</div>
            <div class="wx-main">🌅 ${clockTime(start.sunrise)} · 🌇 ${clockTime(start.sunset)}</div>
            <div class="muted">${daylightHours(start.sunrise, start.sunset)}</div>
            ${note ? `<div class="small">${note}</div>` : ''}
        </div>`;
}

async function fillWeather(stage) {
    const box = $('weatherBox');
    if (!box) return;
    const [from, to] = pathEnds(stage);
    if (!from || !to) { box.innerHTML = '<span class="muted small">No position for this stage, so no forecast.</span>'; return; }

    const date = stage.date_walked, today = todayIso();
    const days = Math.round((new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
    if (days > 15) {
        box.innerHTML = `<span class="muted small">The forecast reaches 16 days ahead. Look again from ${formatDate(addDaysIso(date, -15))}.</span>`;
        return;
    }
    if (days < -7) {
        box.innerHTML = '<span class="muted small">Forecasts are only available for the last week and the next 16 days.</span>';
        return;
    }

    const imperial = state.units === 'mi';
    const key = `${date}|${from[0].toFixed(2)},${from[1].toFixed(2)}|${to[0].toFixed(2)},${to[1].toFixed(2)}|${imperial ? 'i' : 'm'}`;
    if (weatherMemory.has(key)) { showWeather(box, stage, weatherMemory.get(key), imperial); return; }

    const params = new URLSearchParams({
        latitude: `${from[0]},${to[0]}`, longitude: `${from[1]},${to[1]}`,
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset',
        timezone: 'auto', start_date: date, end_date: date,
        temperature_unit: imperial ? 'fahrenheit' : 'celsius', wind_speed_unit: imperial ? 'mph' : 'kmh',
        precipitation_unit: imperial ? 'inch' : 'mm'
    });
    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        weatherMemory.set(key, data);
        rememberWeather(key, data);
        if (box.isConnected) showWeather(box, stage, data, imperial);
    } catch (error) {
        console.warn('Could not load the forecast:', error);
        const kept = readWeatherStore()[key];
        if (!box.isConnected) return;
        if (kept) {
            showWeather(box, stage, kept.data, imperial, `Saved ${new Date(kept.at).toLocaleString()}: no connection now.`);
        } else {
            box.innerHTML = '<span class="muted small">The forecast needs a connection. Open this stage with a signal to keep it for later.</span>';
        }
    }
}
