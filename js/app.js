/**
 * JoseMaps — orquestador de la aplicación.
 *
 * Este archivo solo arranca la app: crea los motores (mapa, GPS, grabador de
 * rutas, marcadores, calibrador, medición y descarga de teselas) sobre el
 * `state` compartido, llama a los `setupX()` de los módulos de interfaz EN ESTE
 * ORDEN (importa: el resto del cableado lo da por hecho) y recarga de IndexedDB
 * lo guardado en la sesión anterior. Toda la lógica de interfaz vive en los
 * módulos `js/ui-*.js`.
 */

import { initDB, getTracks, getSetting, getMaps, requestPersistentStorage } from './storage.js';
import { MapEngine } from './map-engine.js';
import { GPSTracker } from './gps-tracker.js';
import { TrackRecorder } from './track-recorder.js';
import { PlacemarkManager } from './placemarks.js';
import { MapCalibrator } from './calibration.js';
import { MeasurementTool } from './measurement.js';
import { TileDownloader } from './tile-downloader.js';

import { state, APP_VERSION } from './state.js';

import { setupLightbox, showToast } from './ui-utils.js';
import { setupNavigation, setupPanels, setupModals } from './ui-panels.js';
import { setupGPS } from './ui-gps.js';
import { setupTracks, updateTracksList } from './ui-tracks.js';
import { setupCalibration, updateMapsList } from './ui-maps.js';
import { setupSettings, applyThemeColor, setupDataReset, setupBackup } from './ui-settings.js';
import { setupPlacemarks, updatePlacemarksList } from './ui-placemarks.js';
import { setupProjects, switchProject } from './ui-projects.js';
import { setupMapControls } from './ui-map-controls.js';

// ========== INITIALIZATION ==========
async function initApp() {
    try {
        await initDB();
        requestPersistentStorage().catch(() => {});

        // Initialize map engine (default center on Colombia)
        state.mapEngine = new MapEngine('map');
        state.mapEngine.init(4.570868, -74.297333, 6);

        // Initialize GPS
        state.gps = new GPSTracker();

        // Initialize track recorder
        state.trackRecorder = new TrackRecorder(state.gps, state.mapEngine);

        // Initialize placemark manager
        state.placemarkManager = new PlacemarkManager(state.mapEngine);

        // Initialize calibrator
        state.calibrator = new MapCalibrator();

        // Initialize measurement and tile download tools
        state.measurementTool = new MeasurementTool(state.mapEngine);
        state.tileDownloader = new TileDownloader(state.mapEngine);

        // Wire up all UI events
        setupProjects();
        setupNavigation();
        setupPanels();
        setupGPS();
        setupTracks();
        setupPlacemarks();
        setupCalibration();
        setupMapControls();
        setupSettings();
        setupModals();
        setupLightbox();
        setupDataReset();
        setupBackup();

        const versionLabel = document.getElementById('app-version-label');
        if (versionLabel) versionLabel.textContent = APP_VERSION;

        // La lista de mapas refleja la capa base activa
        state.mapEngine.onBaseLayerChange = () => { updateMapsList().catch(() => {}); };

        // Load saved data & projects
        await loadSavedData();

        showToast(`✅ JoseMaps listo · ${state.currentProjectName}`);
    } catch (e) {
        console.error('Error al iniciar la app:', e);
        showToast('❌ Error al iniciar la aplicación: ' + e.message);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// ========== LOAD SAVED DATA ==========
async function loadSavedData() {
    try {
        // Initialize Project System
        const savedActiveProjId = await getSetting('activeProjectId');
        await switchProject(savedActiveProjId?.value || 'default_proj', { silent: true });

        // Load saved tracks and render them on map
        const tracks = await getTracks();
        tracks.forEach(track => {
            if (track.points && track.points.length > 1) {
                state.mapEngine.addTrackLine(track.points, track.color || '#FF4444', track.id);
            }
        });

        // Planos GeoPDF / calibrados guardados: volver a dibujarlos al reiniciar la app
        const savedMaps = await getMaps();
        savedMaps.forEach(m => {
            const img = m.imageData || m.dataUrl || m.imageUrl;
            if (img && m.bounds && !state.mapEngine.hasImageOverlay(m.id)) {
                try {
                    state.mapEngine.addImageOverlay(m.id, img, m.bounds, { opacity: (m.opacity !== undefined ? m.opacity : 1) });
                } catch (e) {
                    console.warn('No se pudo restaurar el plano', m.name, e);
                }
            }
        });
        if (savedMaps.length > 0) {
            const last = savedMaps[savedMaps.length - 1];
            if (last.bounds) {
                state.lastLoadedGeoPdfBounds = last.bounds;
                state.lastLoadedGeoPdfName = last.name || 'Plano';
                if (state.tileDownloader) {
                    state.tileDownloader.activeGeoPdfBounds = last.bounds;
                    state.tileDownloader.activeGeoPdfName = state.lastLoadedGeoPdfName;
                }
            }
        }

        // Frecuencia GPS
        const gpsFreq = await getSetting('gpsFrequency');
        if (gpsFreq && gpsFreq.value) {
            state.gps.setMinInterval(gpsFreq.value);
            const sel = document.getElementById('select-gps-freq');
            if (sel) sel.value = String(gpsFreq.value);
        }

        // Load settings
        const coordFmt = await getSetting('coordFormat');
        if (coordFmt) state.coordFormat = coordFmt.value;

        const unitsSetting = await getSetting('units');
        if (unitsSetting) state.units = unitsSetting.value;

        const lightMode = await getSetting('lightMode');
        if (lightMode && lightMode.value) {
            document.body.classList.add('light-mode');
            const toggle = document.getElementById('toggle-light-mode');
            if (toggle) toggle.checked = true;
            applyThemeColor();
        }

        // Update lists
        await updateTracksList();
        await updatePlacemarksList();
        await updateMapsList();
    } catch (e) {
        console.error('Error loading saved data:', e);
    }
}
