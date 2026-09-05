/**
 * Interfaz de recorridos (rutas grabadas).
 *
 * Cablea el botón de grabación, controla el ciclo grabar/reanudar/detener sobre
 * `state.trackRecorder`, guarda la ruta en IndexedDB, muestra las estadísticas
 * y mantiene la lista del panel de rutas.
 */

import { state } from './state.js';
import { ICONS, escapeHtml, emptyState, showToast } from './ui-utils.js';
import { closeAllPanels } from './ui-panels.js';
import { startGPS } from './ui-gps.js';
import { saveTrack, getTracks, deleteTrack, generateUUID } from './storage.js';

// ========== TRACKS ==========
export function setupTracks() {
    const btnRecord = document.getElementById('btn-record-track');

    if (btnRecord) {
        btnRecord.addEventListener('click', () => {
            if (!state.trackRecording) {
                startTrackRecording();
            } else if (state.trackPaused) {
                resumeTrackRecording();
            } else {
                stopTrackRecording();
            }
        });
    }
}

export function startTrackRecording() {
    // Make sure GPS is on
    if (!state.gpsActive) {
        startGPS();
        const btnGps = document.getElementById('btn-nav-gps');
        if (btnGps) btnGps.classList.add('active');
    }

    state.trackRecorder.startRecording();
    state.trackRecording = true;
    state.trackPaused = false;
    state.trackStartTime = Date.now();

    // Update UI
    const btnRecord = document.getElementById('btn-record-track');
    if (btnRecord) {
        btnRecord.innerHTML = `${ICONS.stop}<span>Detener grabación</span>`;
        btnRecord.classList.remove('btn-success');
        btnRecord.classList.add('btn-danger');
    }

    // Show recording indicator
    const indicator = document.getElementById('recording-indicator');
    if (indicator) indicator.classList.remove('hidden');

    // Start track timer
    state.trackTimer = setInterval(() => updateTrackDisplay(), 1000);

    closeAllPanels();
    showToast('🔴 Grabando ruta...');
}

export function resumeTrackRecording() {
    state.trackRecorder.resumeRecording();
    state.trackPaused = false;

    const btnRecord = document.getElementById('btn-record-track');
    if (btnRecord) {
        btnRecord.innerHTML = `${ICONS.stop}<span>Detener grabación</span>`;
    }

    showToast('▶️ Grabación reanudada');
}

export async function stopTrackRecording() {
    const track = state.trackRecorder.stopRecording();
    state.trackRecording = false;
    state.trackPaused = false;

    if (state.trackTimer) {
        clearInterval(state.trackTimer);
        state.trackTimer = null;
    }

    // Update UI
    const btnRecord = document.getElementById('btn-record-track');
    if (btnRecord) {
        btnRecord.innerHTML = `${ICONS.record}<span>Iniciar grabación</span>`;
        btnRecord.classList.remove('btn-danger');
        btnRecord.classList.add('btn-success');
    }

    // Hide recording indicator
    const indicator = document.getElementById('recording-indicator');
    if (indicator) indicator.classList.add('hidden');

    // La línea temporal 'current' se reemplaza por la ruta definitiva (con su id)
    state.mapEngine.removeTrackLine('current');

    if (track && track.points && track.points.length > 1) {
        // Name the track
        const now = new Date();
        track.name = `Ruta ${now.toLocaleDateString('es')} ${now.toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'})}`;
        track.date = now.toISOString();
        track.id = track.id || generateUUID();
        track.color = track.color || '#FF4444';
        state.mapEngine.addTrackLine(track.points, track.color, track.id);

        // Save to IndexedDB
        await saveTrack(track);

        // Show stats
        showTrackStats(track);

        // Update tracks list
        await updateTracksList();

        showToast(`✅ Ruta guardada: ${track.points.length} puntos`);
    } else {
        showToast('Ruta muy corta, no se guardó');
    }
}

export function updateTrackDisplay() {
    // This could update a real-time display if we add one
}

export function showTrackStats(track) {
    const stats = track.stats || {};
    const setTextById = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    const dist = stats.distance || 0;
    setTextById('stat-dist', dist >= 1000 ? `${(dist/1000).toFixed(2)} km` : `${dist.toFixed(0)} m`);

    const dur = stats.duration || 0;
    const h = Math.floor(dur / 3600000);
    const m = Math.floor((dur % 3600000) / 60000);
    const s = Math.floor((dur % 60000) / 1000);
    setTextById('stat-time', `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`);

    setTextById('stat-avg-speed', `${((stats.avgSpeed || 0) * 3.6).toFixed(1)} km/h`);
    setTextById('stat-max-speed', `${((stats.maxSpeed || 0) * 3.6).toFixed(1)} km/h`);
    setTextById('stat-elevation', `↑${(stats.elevGain || 0).toFixed(0)} m / ↓${(stats.elevLoss || 0).toFixed(0)} m`);

    // Show modal
    const modal = document.getElementById('modal-track-stats');
    if (modal) modal.classList.remove('hidden');
}

export async function updateTracksList() {
    const list = document.getElementById('list-tracks');
    if (!list) return;

    const tracks = await getTracks();

    // Keep the record button, clear the rest
    let html = '';
    tracks.sort((a, b) => new Date(b.date) - new Date(a.date));

    tracks.forEach(track => {
        const dist = track.stats?.distance || 0;
        const distStr = dist >= 1000 ? `${(dist/1000).toFixed(1)} km` : `${dist.toFixed(0)} m`;
        const date = track.date ? new Date(track.date).toLocaleDateString('es') : '';

        html += `
        <li class="list-item" data-id="${track.id}">
            <div class="item-icon" style="color: ${escapeHtml(track.color || '#FF4444')}">${ICONS.route}</div>
            <div class="item-details">
                <h3 class="item-title">${escapeHtml(track.name || 'Sin nombre')}</h3>
                <p class="item-meta">${distStr} · ${date} · ${track.points?.length || 0} puntos</p>
            </div>
            <button class="btn-icon btn-delete-track" data-id="${track.id}" aria-label="Eliminar ruta">${ICONS.trash}</button>
        </li>`;
    });

    list.innerHTML = html || emptyState('🥾', 'Aún no hay rutas grabadas');

    // Attach delete handlers
    list.querySelectorAll('.btn-delete-track').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (confirm('¿Eliminar esta ruta?')) {
                await deleteTrack(id);
                state.mapEngine.removeTrackLine(id);
                await updateTracksList();
                showToast('Ruta eliminada');
            }
        });
    });

    // Attach click to zoom handlers
    list.querySelectorAll('.list-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            const track = tracks.find(t => t.id === id);
            if (track && track.points && track.points.length > 0) {
                const bounds = track.points.map(p => [p.lat, p.lng]);
                state.mapEngine.fitBounds(bounds);
                closeAllPanels();
            }
        });
    });
}
