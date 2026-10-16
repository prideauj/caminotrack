// Global state
let state = {
    sessionId: localStorage.getItem('sessionId'),
    stages: [],
    stats: {},
    selectedStage: null,
    map: null
};

const API_BASE = '/api';

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    if (state.sessionId) {
        showMainApp();
        loadStats();
        loadStages();
    }

    setupEventListeners();
});

function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Login form
    document.getElementById('loginForm').addEventListener('submit', handleLogin);

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', logout);

    // Sync
    document.getElementById('syncBtn').addEventListener('click', syncData);
}

function showLoginScreen() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
}

function showMainApp() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    initMap();
}

function handleLogin(e) {
    e.preventDefault();
    const sessionId = document.getElementById('sessionId').value.trim();

    if (!sessionId) {
        alert('Please enter a session ID');
        return;
    }

    state.sessionId = sessionId;
    localStorage.setItem('sessionId', sessionId);

    showMainApp();
    loadStats();
    loadStages();
}

async function loadStats() {
    try {
        const response = await fetch(`${API_BASE}/stages/${state.sessionId}/stats`);
        state.stats = await response.json();
        updateStatsDisplay();
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

async function loadStages() {
    try {
        const response = await fetch(`${API_BASE}/stages/${state.sessionId}`);
        state.stages = await response.json();
        renderTimeline();
        renderMap();
    } catch (error) {
        console.error('Error loading stages:', error);
    }
}

function updateStatsDisplay() {
    document.getElementById('totalStages').textContent = state.stats.total_stages || 0;
    document.getElementById('completedStages').textContent = state.stats.completed_stages || 0;
    document.getElementById('totalDistance').textContent = (state.stats.total_distance || 0).toFixed(1) + ' km';
    document.getElementById('remainingDistance').textContent = (state.stats.remaining_distance || 0).toFixed(1) + ' km';
}

function renderTimeline() {
    const container = document.getElementById('timelineContainer');
    container.innerHTML = '';

    // Sort stages by date
    const sortedStages = [...state.stages].sort((a, b) =>
        new Date(a.date_walked) - new Date(b.date_walked)
    );

    // Group stages by trip
    const tripGroups = {};
    sortedStages.forEach(stage => {
        const tripName = stage.trip_name || 'Unassigned Trip';
        if (!tripGroups[tripName]) {
            tripGroups[tripName] = [];
        }
        tripGroups[tripName].push(stage);
    });

    // Render each trip as a collapsible section
    Object.keys(tripGroups).forEach((tripName, tripIdx) => {
        const tripStages = tripGroups[tripName];
        const tripId = `trip-${tripIdx}`;
        const tripAllCompleted = tripStages.every(s => s.is_completed);

        // Trip header (collapsible)
        const tripHeader = document.createElement('div');
        tripHeader.style.cssText = `
            background: white;
            padding: 1.2rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            cursor: pointer;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            border-left: 4px solid ${tripAllCompleted ? '#4CAF50' : '#FFC107'};
            user-select: none;
        `;

        const tripTotalDistance = tripStages.reduce((sum, s) => sum + (s.actual_distance || 0), 0);

        tripHeader.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-size: 0.9rem; color: #999; margin-bottom: 0.3rem;">🎫 Trip ${tripIdx + 1}</div>
                    <div style="font-size: 1.2rem; font-weight: bold; color: var(--primary);">${tripName}</div>
                    <div style="font-size: 0.9rem; color: #666; margin-top: 0.3rem;">
                        ${tripStages.length} stages · ${tripTotalDistance.toFixed(1)} km ·
                        <span style="color: ${tripAllCompleted ? '#4CAF50' : '#FFC107'}; font-weight: bold;">
                            ${tripAllCompleted ? '✅ Completed' : '⏳ In Progress'}
                        </span>
                    </div>
                </div>
                <div style="font-size: 1.5rem; color: #999; transition: transform 0.3s;" class="trip-arrow">▼</div>
            </div>
        `;

        container.appendChild(tripHeader);

        // Trip stages container (collapsible)
        const stagesContainer = document.createElement('div');
        stagesContainer.id = tripId;
        stagesContainer.style.cssText = `
            max-height: 2000px;
            overflow: hidden;
            transition: max-height 0.3s ease;
            padding-left: 20px;
        `;

        // Add stages to trip
        tripStages.forEach((stage, stageIdx) => {
            const item = document.createElement('div');
            item.className = `timeline-item ${stage.is_completed ? 'completed' : ''}`;

            const distanceDiff = Math.abs((stage.actual_distance || 0) - (stage.standard_distance || 0));
            const distanceNote = distanceDiff > 0.5 ? `<br><small style="color: #D2691E;">⚠ Actual: ${(stage.actual_distance || 0).toFixed(1)}km (standard: ${(stage.standard_distance || 0).toFixed(1)}km)</small>` : '';

            const status = stage.is_completed ? '✅ Completed' : '⏳ Upcoming';

            item.innerHTML = `
                <div class="timeline-item-content" style="cursor: pointer; padding: 1.2rem;">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div>
                            <div style="font-size: 0.8rem; color: #999; margin-bottom: 0.3rem;">Stage ${stageIdx + 1}</div>
                            <div class="stage-name" style="font-size: 1.1rem; margin-bottom: 0.5rem;">${stage.name}</div>
                            <div style="font-size: 0.9rem; color: #666; margin-bottom: 0.5rem;">
                                📏 <strong>${(stage.actual_distance || 0).toFixed(1)} km</strong>
                                ${distanceNote}
                            </div>
                        </div>
                        <div style="text-align: right; font-size: 0.85rem; color: #999;">
                            ${new Date(stage.date_walked).toLocaleDateString()}<br>
                            <span style="color: ${stage.is_completed ? '#4CAF50' : '#FFC107'}; font-weight: bold;">${status}</span>
                        </div>
                    </div>
                    ${stage.start_hotel || stage.end_hotel ? `
                        <div style="margin-top: 0.7rem; padding-top: 0.7rem; border-top: 1px solid #eee; font-size: 0.85rem;">
                            🏨 <strong>${stage.start_hotel || 'N/A'}</strong> → <strong>${stage.end_hotel || 'N/A'}</strong>
                        </div>
                    ` : ''}
                </div>
            `;
            item.addEventListener('click', () => selectStage(stage));
            stagesContainer.appendChild(item);
        });

        container.appendChild(stagesContainer);

        // Trip header click handler
        tripHeader.addEventListener('click', () => {
            const isCollapsed = stagesContainer.style.maxHeight === '0px';
            if (isCollapsed) {
                stagesContainer.style.maxHeight = '2000px';
                tripHeader.querySelector('.trip-arrow').style.transform = 'rotate(0deg)';
            } else {
                stagesContainer.style.maxHeight = '0px';
                tripHeader.querySelector('.trip-arrow').style.transform = 'rotate(-90deg)';
            }
        });
    });
}

function initMap() {
    if (state.map) return;

    // Center on Camino de Santiago (roughly)
    state.map = L.map('map').setView([42.5, -2.0], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(state.map);
}

function renderMap() {
    if (!state.map) initMap();

    // Clear existing markers and layers
    state.map.eachLayer(layer => {
        if (layer instanceof L.Polyline || layer instanceof L.Marker || layer instanceof L.CircleMarker) {
            state.map.removeLayer(layer);
        }
    });

    // Sort stages by date for consistent numbering
    const sortedStages = [...state.stages].sort((a, b) =>
        new Date(a.date_walked) - new Date(b.date_walked)
    );

    // Approximate coordinates for major Camino de Santiago locations
    const caminoLocations = {
        'Saint Jean Pied de Port': [43.1608, -1.2384],
        'Logrono': [42.4627, -2.4449],
        'Burgos': [42.3439, -3.7034],
        'Leon': [42.5987, -5.5711],
        'Sarria': [42.7719, -8.2433],
        'Santiago': [42.8782, -8.5467],
        'Najera': [42.4149, -2.7345],
        'Santo Domingo': [42.4373, -2.9466],
        'Belorado': [42.3447, -3.2049],
        'Atapuerca': [42.2921, -3.4644],
        'Hornillos': [42.3644, -3.6823],
        'Castrojeriz': [42.3253, -3.8467],
        'Fromista': [42.3483, -4.0783],
        'Carrion': [42.3045, -4.2850],
        'Sahagun': [42.2865, -4.9765]
    };

    let stageNum = 0;
    const markers = [];

    sortedStages.forEach((stage) => {
        stageNum++;
        const color = stage.is_completed ? '#4CAF50' : '#FFC107';

        // Try to find coordinates from location name, else use approximate
        let lat = 42.5, lon = -3.5;

        // Search for location match
        for (let location in caminoLocations) {
            if (stage.end_location && stage.end_location.toLowerCase().includes(location.toLowerCase())) {
                [lat, lon] = caminoLocations[location];
                break;
            }
        }

        const marker = L.circleMarker([lat, lon], {
            radius: 12,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.9
        }).addTo(state.map);

        // Add stage number as text in the marker
        const numberDiv = L.divIcon({
            className: 'stage-number-marker',
            html: `<div style="
                background: ${color};
                color: white;
                border-radius: 50%;
                width: 30px;
                height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                font-size: 12px;
                border: 2px solid white;
            ">${stageNum}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });

        const numberMarker = L.marker([lat, lon], { icon: numberDiv }).addTo(state.map);

        const popupText = `
            <div style="font-size: 0.9rem; min-width: 200px;">
                <strong style="font-size: 1.1rem;">Stage ${stageNum}: ${stage.name}</strong><br><br>
                <strong>Distance:</strong> ${(stage.actual_distance || 0).toFixed(1)} km<br>
                <strong>Date:</strong> ${new Date(stage.date_walked).toLocaleDateString()}<br>
                <strong>Status:</strong> ${stage.is_completed ? '✅ Completed' : '⏳ Upcoming'}<br>
                ${stage.start_hotel ? `<br><strong>🏨 Start:</strong> ${stage.start_hotel}<br>` : ''}
                ${stage.end_hotel ? `<strong>🏨 End:</strong> ${stage.end_hotel}` : ''}
            </div>
        `;

        marker.bindPopup(popupText);
        numberMarker.bindPopup(popupText);
        marker.on('click', () => selectStage(stage));
        numberMarker.on('click', () => selectStage(stage));

        markers.push(marker);
    });

    // Fit map to markers
    if (markers.length > 0) {
        const group = new L.featureGroup(markers);
        state.map.fitBounds(group.getBounds().pad(0.1));
    }
}

function selectStage(stage) {
    state.selectedStage = stage;

    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    `;

    const distanceDiff = Math.abs((stage.actual_distance || 0) - (stage.standard_distance || 0));
    const distanceNote = distanceDiff > 0.5 ?
        `<p style="color: #D2691E; margin: 0.5rem 0;">⚠ Hotels are ${distanceDiff.toFixed(1)}km off the standard route</p>` : '';

    modal.innerHTML = `
        <div style="background: white; padding: 2rem; border-radius: 8px; max-width: 500px; max-height: 80vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,0.3);">
            <h2 style="margin: 0 0 1rem 0; color: var(--primary);">${stage.name}</h2>

            <div style="margin-bottom: 1.5rem;">
                <div style="display: grid; gap: 0.7rem;">
                    <div>
                        <strong>Date:</strong> ${new Date(stage.date_walked).toLocaleDateString()}
                        ${stage.is_completed ? '<span style="color: #4CAF50; margin-left: 1rem;">✅ Completed</span>' : '<span style="color: #FFC107; margin-left: 1rem;">⏳ Upcoming</span>'}
                    </div>

                    <div>
                        <strong>Distance:</strong> <span style="color: var(--primary); font-size: 1.1rem; font-weight: bold;">${(stage.actual_distance || 0).toFixed(1)} km</span>
                        <span style="color: #999;"> (standard: ${(stage.standard_distance || 0).toFixed(1)} km)</span>
                        ${distanceNote}
                    </div>
                </div>
            </div>

            <div style="background: #f9f9f9; padding: 1rem; border-radius: 4px; margin-bottom: 1.5rem;">
                <h4 style="margin: 0 0 0.7rem 0;">Locations</h4>
                <div style="display: grid; gap: 0.5rem; font-size: 0.9rem;">
                    <div><strong>From:</strong> ${stage.start_location || 'N/A'}</div>
                    <div><strong>To:</strong> ${stage.end_location || 'N/A'}</div>
                </div>
            </div>

            <div style="background: #f9f9f9; padding: 1rem; border-radius: 4px; margin-bottom: 1.5rem;">
                <h4 style="margin: 0 0 0.7rem 0;">🏨 Accommodation</h4>
                <div style="display: grid; gap: 0.5rem; font-size: 0.9rem;">
                    <div><strong>Start Hotel:</strong> ${stage.start_hotel || 'N/A'}</div>
                    <div><strong>End Hotel:</strong> ${stage.end_hotel || 'N/A'}</div>
                </div>
            </div>

            <button onclick="this.closest('div').parentElement.remove();" style="width: 100%; padding: 0.7rem; background: var(--primary); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 1rem;">
                Close
            </button>
        </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

function switchTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));

    // Show selected tab
    document.getElementById(tabName + 'Tab').classList.remove('hidden');
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Reinitialize map on switch
    if (tabName === 'map') {
        setTimeout(() => {
            if (state.map) state.map.invalidateSize();
        }, 100);
    }
}

async function syncData() {
    const btn = document.getElementById('syncBtn');
    const originalText = btn.textContent;

    // Prompt for CaminoWays credentials
    const email = prompt('Enter your CaminoWays email:');
    if (!email) return;

    const password = prompt('Enter your CaminoWays password:');
    if (!password) return;

    btn.innerHTML = '<span class="spinner"></span> Syncing...';
    btn.disabled = true;

    try {
        const response = await fetch(`/scrape/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: email,
                password: password
            })
        });

        if (response.ok) {
            const data = await response.json();
            await loadStats();
            await loadStages();
            alert(`✅ Sync complete! Imported ${data.stages_imported} stages.`);
        } else {
            const error = await response.json();
            alert(`❌ Sync failed: ${error.detail || 'Please check your credentials and try again.'}`);
        }
    } catch (error) {
        console.error('Sync error:', error);
        alert('Sync error. Please try again.');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

function logout() {
    if (confirm('Are you sure you want to logout? Your local data will be cleared.')) {
        localStorage.removeItem('sessionId');

        state = {
            sessionId: null,
            stages: [],
            stats: {},
            selectedStage: null,
            map: null
        };

        showLoginScreen();
        document.getElementById('sessionId').value = '';
    }
}
