/**
 * Interfaz del GPS.
 *
 * Cablea el botón de GPS y el de centrado rápido, arranca y detiene el
 * seguimiento sobre `state.gps` (GPSTracker) y mantiene la barra superior con
 * la posición en MAGNA-SIRGAS, altura y precisión.
 */

import { state } from './state.js';
import { showToast } from './ui-utils.js';
import { toMagnaSirgas } from './coords.js';

// ========== GPS ==========
export function setupGPS() {
    const btnGps = document.getElementById('btn-nav-gps');
    const btnGpsCenter = document.getElementById('btn-gps-center');
    const topInfoBar = document.getElementById('top-info-bar');

    if (btnGps) {
        btnGps.addEventListener('click', () => {
            if (!state.gpsActive) {
                startGPS();
                btnGps.classList.add('active');
            } else {
                stopGPS();
                btnGps.classList.remove('active');
            }
        });
    }

    if (btnGpsCenter) {
        btnGpsCenter.addEventListener('click', async () => {
            showToast('📡 Obteniendo posición GPS...');
            btnGpsCenter.classList.add('loading');

            // Auto start GPS if not active
            if (!state.gpsActive) {
                startGPS();
                if (btnGps) btnGps.classList.add('active');
            }

            try {
                const pos = await state.gps.getCurrentPosition();
                if (pos) {
                    state.autoCenter = true;
                    // Fly directly to user's location with level 16 detail
                    state.mapEngine.map.flyTo([pos.lat, pos.lng], 16, {
                        animate: true,
                        duration: 1.0
                    });
                    state.mapEngine.addGPSMarker(pos.lat, pos.lng, pos.accuracy, pos.heading);
                    updateInfoBar(pos);
                    showToast(`📍 Centrado: ±${Math.round(pos.accuracy || 0)}m`);
                }
            } catch (err) {
                console.warn('Centrado rápido falló, intentando última posición:', err);
                const last = state.gps.getPosition();
                if (last) {
                    state.mapEngine.map.flyTo([last.lat, last.lng], 16);
                    showToast(`📍 Centrado en última posición`);
                } else {
                    showToast('⚠️ No se pudo obtener ubicación GPS. Revisa permisos en Safari.');
                }
            } finally {
                btnGpsCenter.classList.remove('loading');
            }
        });
    }
}

export function startGPS() {
    state.gps.onPositionUpdate = (pos) => {
        // Update GPS marker on map
        state.mapEngine.addGPSMarker(pos.lat, pos.lng, pos.accuracy, pos.heading);

        // Auto-center if enabled with proper zoom
        if (state.autoCenter) {
            const currentZoom = state.mapEngine.getZoom();
            const targetZoom = currentZoom < 14 ? 16 : currentZoom;
            state.mapEngine.setView(pos.lat, pos.lng, targetZoom);
        }

        // Update info bar
        updateInfoBar(pos);
    };

    // Rumbo de brújula: solo rota la flecha del marcador (barato)
    state.gps.onHeadingUpdate = (heading) => {
        state.mapEngine.setGPSHeading(heading);
    };

    // Evita la lluvia de avisos: un mismo tipo de error se muestra máx. cada 30 s
    let lastGpsError = { kind: null, at: 0 };
    state.gps.onError = (err, kind) => {
        const now = Date.now();
        if (kind === lastGpsError.kind && (now - lastGpsError.at) < 30000) return;
        lastGpsError = { kind, at: now };
        showToast('⚠️ ' + err.message, kind === 'denied' ? 5000 : 3000);
    };

    state.gps.start();
    state.gpsActive = true;

    // Show info bar
    const topInfoBar = document.getElementById('top-info-bar');
    if (topInfoBar) topInfoBar.classList.remove('hidden');
    document.body.classList.add('has-top-bar');

    showToast('📡 GPS Activado');
}

export function stopGPS() {
    state.gps.stop();
    state.mapEngine.removeGPSMarker();
    state.gpsActive = false;

    // Hide info bar
    const topInfoBar = document.getElementById('top-info-bar');
    if (topInfoBar) topInfoBar.classList.add('hidden');
    document.body.classList.remove('has-top-bar');

    showToast('GPS Desactivado');
}

export function updateInfoBar(pos) {
    const setTextById = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    const magna = toMagnaSirgas(pos.lat, pos.lng);
    setTextById('info-magna-n', `${Math.round(magna.norte).toLocaleString('es-CO')} m`);
    setTextById('info-magna-e', `${Math.round(magna.este).toLocaleString('es-CO')} m`);
    setTextById('info-coords-geo', `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`);
    setTextById('info-alt', (pos.altitude !== null && pos.altitude !== undefined) ? `${pos.altitude.toFixed(0)} m` : '--');

    const accEl = document.getElementById('info-acc');
    if (accEl) {
        const acc = pos.accuracy ? Math.round(pos.accuracy) : null;
        accEl.classList.remove('q-good', 'q-mid', 'q-bad');
        if (acc !== null) {
            accEl.textContent = `±${acc} m`;
            if (acc <= 5) {
                accEl.classList.add('q-good');
                accEl.title = 'Señal GNSS óptima';
            } else if (acc <= 15) {
                accEl.classList.add('q-mid');
                accEl.title = 'Señal GNSS media';
            } else {
                accEl.classList.add('q-bad');
                accEl.title = 'Señal débil (interiores o rebote en edificios)';
            }
        } else {
            accEl.textContent = '--';
        }
    }
}
