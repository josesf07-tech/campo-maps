/**
 * Controles sobre el mapa.
 *
 * Zoom, brújula, mira de precisión con coordenadas MAGNA-SIRGAS en vivo,
 * herramienta de medición, cambio de capa base y descarga de teselas para uso
 * sin conexión. También desactiva el auto-centrado cuando el usuario arrastra.
 */

import { state } from './state.js';
import { showToast } from './ui-utils.js';
import { closeAllPanels } from './ui-panels.js';
import { toMagnaSirgas } from './coords.js';

// ========== MAP CONTROLS ==========
export function setupMapControls() {
    const btnZoomIn = document.getElementById('btn-zoom-in');
    const btnZoomOut = document.getElementById('btn-zoom-out');
    const btnCompass = document.getElementById('btn-compass');
    const btnLayers = document.getElementById('btn-layers');
    const btnCrosshair = document.getElementById('btn-crosshair-toggle');
    const crosshairEl = document.getElementById('map-crosshair');
    const crosshairCoordsEl = document.getElementById('crosshair-coords');

    let crosshairVisible = true;

    // Crosshair live coordinates in MAGNA-SIRGAS Origen Nacional (EPSG:9377)
    const updateCrosshairCoords = () => {
        if (!state.mapEngine || !state.mapEngine.map) return;
        const center = state.mapEngine.getCenter();
        if (crosshairCoordsEl && center) {
            const magna = toMagnaSirgas(center.lat, center.lng);
            crosshairCoordsEl.textContent = `N: ${Math.round(magna.norte).toLocaleString('es-CO')} | E: ${Math.round(magna.este).toLocaleString('es-CO')}`;
        }
    };

    if (state.mapEngine?.map) {
        state.mapEngine.map.on('move', updateCrosshairCoords);
        state.mapEngine.map.on('zoom', updateCrosshairCoords);
        updateCrosshairCoords();
    }

    if (btnCrosshair && crosshairEl) {
        btnCrosshair.addEventListener('click', () => {
            crosshairVisible = !crosshairVisible;
            crosshairEl.classList.toggle('hidden', !crosshairVisible);
            btnCrosshair.classList.toggle('active', crosshairVisible);
            showToast(crosshairVisible ? '🎯 Mira de precisión activada' : 'Mira de precisión oculta');
        });
    }

    if (btnZoomIn) btnZoomIn.addEventListener('click', () => state.mapEngine.map.zoomIn());
    if (btnZoomOut) btnZoomOut.addEventListener('click', () => state.mapEngine.map.zoomOut());

    if (btnCompass) {
        btnCompass.addEventListener('click', () => {
            state.mapEngine.map.setBearing && state.mapEngine.map.setBearing(0);
            state.mapEngine.setView(state.mapEngine.getCenter().lat, state.mapEngine.getCenter().lng);
            showToast('🧭 Norte arriba');
        });
    }

    // Toggle measurement tool (Distancia, Azimut y Áreas en Hectáreas)
    const btnMeasure = document.getElementById('btn-measure-toggle');
    if (btnMeasure) {
        btnMeasure.addEventListener('click', () => {
            if (state.measurementTool) {
                state.measurementTool.toggle();
                btnMeasure.classList.toggle('active', state.measurementTool.active);
                if (state.measurementTool.active) {
                    showToast('📏 Modo medición activo: toca puntos en el mapa');
                }
            }
        });
    }

    // Layer switcher toggle (Satélite Híbrido vs Esri Satélite vs Callejero OSM vs Topográfico)
    if (btnLayers) {
        btnLayers.addEventListener('click', () => {
            const next = state.mapEngine.nextBaseLayerType();
            state.mapEngine.setBaseLayer(next);
            const def = state.mapEngine.getBaseLayerDef(next);
            showToast(`🗺️ ${def.label} · ${def.description}`);
        });
    }

    // Offline Tile Downloader
    const btnOpenOfflineDl = document.getElementById('btn-open-offline-dl');
    if (btnOpenOfflineDl) {
        btnOpenOfflineDl.addEventListener('click', () => {
            closeAllPanels();
            if (state.tileDownloader) {
                state.tileDownloader.showDownloadDialog(
                    state.mapEngine.baseLayerType || 'satellite',
                    state.lastLoadedGeoPdfBounds,
                    state.lastLoadedGeoPdfName
                );
            }
        });
    }

    // Disable auto-center when user manually pans
    state.mapEngine.map?.on('dragstart', () => {
        state.autoCenter = false;
    });
}
