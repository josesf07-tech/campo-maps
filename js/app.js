import { 
    initDB, savePlacemark, getPlacemarks, deletePlacemark, 
    saveTrack, getTracks, deleteTrack, 
    saveSetting, getSetting, 
    saveMap, getMaps, deleteMap, 
    saveProject, getProjects, getProject, deleteProject,
    generateUUID, requestPersistentStorage 
} from './storage.js';
import { MapEngine } from './map-engine.js';
import { GPSTracker } from './gps-tracker.js';
import { TrackRecorder } from './track-recorder.js';
import { PlacemarkManager } from './placemarks.js';
import { MapCalibrator } from './calibration.js';
import { toMagnaSirgas, fromMagnaSirgas } from './coords.js';
import { exportPlacemarksToKMZ } from './kmz-export.js';
import { exportPlacemarksToDocx } from './docx-export.js';
import { exportUsoUsuariosToExcel, FUENTES_AGUA, RESIDUOS_LIQUIDOS, RESIDUOS_SOLIDOS } from './excel-export.js';
import { MeasurementTool } from './measurement.js';
import { TileDownloader } from './tile-downloader.js';

// ========== APP STATE ==========
const state = {
    gpsActive: false,
    autoCenter: true,
    trackRecording: false,
    trackPaused: false,
    coordFormat: 'DD', // DD, DMS, DDM
    units: 'metric', // metric, imperial
    currentPanel: null,
    currentProjectId: null,
    currentProjectName: 'Proyecto General',
    placemarkEditId: null,
    selectedIcon: 'default',
    mapEngine: null,
    gps: null,
    trackRecorder: null,
    placemarkManager: null,
    calibrator: null,
    measurementTool: null,
    tileDownloader: null,
    trackTimer: null,
    trackStartTime: null,
};

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

        // Load saved data & projects
        await loadSavedData();

        showToast('✅ CampoMaps listo');
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
        await switchProject(savedActiveProjId?.value || 'default_proj');
        
        // Load saved tracks and render them on map
        const tracks = await getTracks();
        tracks.forEach(track => {
            if (track.points && track.points.length > 1) {
                state.mapEngine.addTrackLine(track.points, track.color || '#FF4444', track.id);
            }
        });
        
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
        }

        // Update lists
        await updateTracksList();
        await updatePlacemarksList();
        await updateMapsList();
    } catch (e) {
        console.error('Error loading saved data:', e);
    }
}

// ========== NAVIGATION ==========
function setupNavigation() {
    // Bottom nav buttons
    document.querySelectorAll('#bottom-nav .nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            if (target) {
                togglePanel(target);
            }
        });
    });
}

// ========== PANELS ==========
function setupPanels() {
    // Close panel buttons
    document.querySelectorAll('.btn-close-panel').forEach(btn => {
        btn.addEventListener('click', () => {
            closeAllPanels();
        });
    });

    // Overlay click closes panel
    const overlay = document.getElementById('panel-overlay');
    if (overlay) {
        overlay.addEventListener('click', closeAllPanels);
    }
}

function togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    const overlay = document.getElementById('panel-overlay');
    
    if (state.currentPanel === panelId) {
        closeAllPanels();
        return;
    }
    
    // Close any open panel first
    closeAllPanels();
    
    if (panel) {
        panel.classList.add('open');
        if (overlay) overlay.classList.remove('hidden');
        state.currentPanel = panelId;
        
        // Update active nav
        document.querySelectorAll('#bottom-nav .nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.target === panelId);
        });
    }
}

function closeAllPanels() {
    document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
    const overlay = document.getElementById('panel-overlay');
    if (overlay) overlay.classList.add('hidden');
    state.currentPanel = null;
    document.querySelectorAll('#bottom-nav .nav-item').forEach(btn => btn.classList.remove('active'));
}

// ========== GPS ==========
function setupGPS() {
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

function startGPS() {
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
    
    state.gps.onError = (err) => {
        showToast('⚠️ ' + err.message);
    };
    
    state.gps.start();
    state.gpsActive = true;
    
    // Show info bar
    const topInfoBar = document.getElementById('top-info-bar');
    if (topInfoBar) topInfoBar.classList.remove('hidden');
    
    showToast('📡 GPS Activado');
}

function stopGPS() {
    state.gps.stop();
    state.mapEngine.removeGPSMarker();
    state.gpsActive = false;
    
    // Hide info bar
    const topInfoBar = document.getElementById('top-info-bar');
    if (topInfoBar) topInfoBar.classList.add('hidden');
    
    showToast('GPS Desactivado');
}

function updateInfoBar(pos) {
    const setTextById = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    const magna = toMagnaSirgas(pos.lat, pos.lng);
    setTextById('info-magna-n', `N: ${Math.round(magna.norte).toLocaleString('es-CO')} m`);
    setTextById('info-magna-e', `E: ${Math.round(magna.este).toLocaleString('es-CO')} m`);
    setTextById('info-coords-geo', `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`);
    setTextById('info-alt', pos.altitude !== null ? `${pos.altitude.toFixed(0)} m` : '-- m');

    const accEl = document.getElementById('info-acc');
    if (accEl) {
        const acc = pos.accuracy ? Math.round(pos.accuracy) : null;
        if (acc !== null) {
            accEl.textContent = `±${acc} m`;
            if (acc <= 5) {
                accEl.style.color = '#2ecc71'; // Green: Óptimo (cielo abierto)
                accEl.title = 'Señal GNSS óptima';
            } else if (acc <= 15) {
                accEl.style.color = '#f39c12'; // Yellow: Aceptable
                accEl.title = 'Señal GNSS media';
            } else {
                accEl.style.color = '#e74c3c'; // Red: Baja (interiores/edificio)
                accEl.title = 'Señal débil (posible rebote en edificio)';
            }
        } else {
            accEl.textContent = '-- m';
            accEl.style.color = 'inherit';
        }
    }
}

// ========== TRACKS ==========
function setupTracks() {
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

function startTrackRecording() {
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
        btnRecord.textContent = '⏹ Detener Grabación';
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

function resumeTrackRecording() {
    state.trackRecorder.resumeRecording();
    state.trackPaused = false;
    
    const btnRecord = document.getElementById('btn-record-track');
    if (btnRecord) {
        btnRecord.textContent = '⏹ Detener Grabación';
    }
    
    showToast('▶️ Grabación reanudada');
}

async function stopTrackRecording() {
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
        btnRecord.textContent = 'Iniciar Grabación';
        btnRecord.classList.remove('btn-danger');
        btnRecord.classList.add('btn-success');
    }
    
    // Hide recording indicator
    const indicator = document.getElementById('recording-indicator');
    if (indicator) indicator.classList.add('hidden');
    
    if (track && track.points && track.points.length > 1) {
        // Name the track
        const now = new Date();
        track.name = `Ruta ${now.toLocaleDateString('es')} ${now.toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'})}`;
        track.date = now.toISOString();
        track.id = track.id || generateUUID();
        track.color = track.color || '#FF4444';
        
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

function updateTrackDisplay() {
    // This could update a real-time display if we add one
}

function showTrackStats(track) {
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

async function updateTracksList() {
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
            <div class="item-icon" style="color: ${track.color || '#FF4444'}">
                <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
            </div>
            <div class="item-details">
                <h3 class="item-title">${track.name || 'Sin nombre'}</h3>
                <p class="item-meta">${distStr} • ${date} • ${track.points?.length || 0} puntos</p>
            </div>
            <button class="btn-icon btn-delete-track" data-id="${track.id}" aria-label="Eliminar">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </li>`;
    });
    
    list.innerHTML = html;
    
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

// ========== PLACEMARKS ==========
function setupPlacemarks() {
    // FAB button - add placemark exactly at the crosshair pointer (Avenza style)
    const fab = document.getElementById('fab-add-placemark');
    if (fab) {
        fab.addEventListener('click', () => {
            const center = state.mapEngine.getCenter();
            openPlacemarkModal({ lat: center.lat, lng: center.lng });
        });
    }
    
    // Long press on map to add placemark
    state.mapEngine.onMapLongPress((e) => {
        openPlacemarkModal(e.latlng);
    });
    
    // Icon selector
    document.querySelectorAll('.icon-option').forEach(opt => {
        opt.addEventListener('click', () => {
            document.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            state.selectedIcon = opt.dataset.icon;
        });
    });
    
    // Save placemark button
    const btnSave = document.getElementById('btn-save-placemark');
    if (btnSave) {
        btnSave.addEventListener('click', savePlacemarkFromModal);
    }
    
    // Multi-photo capture with Camera (iPhone camera / native picker)
    const btnPhoto = document.getElementById('btn-take-photo');
    const photoInput = document.getElementById('placemark-photo-input');
    const btnClearPhotos = document.getElementById('btn-clear-all-photos');
    
    let currentPhotos = [];

    function renderPhotosGrid() {
        const grid = document.getElementById('pm-photos-grid');
        const container = document.getElementById('placemark-photos-container');
        const countLabel = document.getElementById('photos-count-label');
        const btnText = document.getElementById('btn-photo-text');
        
        if (!grid || !container) return;
        
        if (currentPhotos.length === 0) {
            container.classList.add('hidden');
            if (btnText) btnText.textContent = 'Tomar Foto con Cámara';
            grid.innerHTML = '';
            return;
        }
        
        container.classList.remove('hidden');
        if (countLabel) countLabel.textContent = `Fotos adjuntas (${currentPhotos.length})`;
        if (btnText) btnText.textContent = `➕ Tomar Otra Foto (${currentPhotos.length} listas)`;
        
        grid.innerHTML = currentPhotos.map((photo, index) => {
            const pUrl = typeof photo === 'string' ? photo : (photo.url || photo.dataUrl);
            const pHeading = (typeof photo === 'object' && (photo.headingLabel || (photo.heading !== null && photo.heading !== undefined)))
                ? (photo.headingLabel || `${Math.round(photo.heading)}°`)
                : `#${index + 1}`;
            return `
            <div style="position: relative; width: 78px; height: 82px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border-color); background: #111;">
                <img src="${pUrl}" alt="Foto ${index + 1}" style="width: 100%; height: 100%; object-fit: cover; cursor: pointer;" onclick="window.open('${pUrl}', '_blank')">
                <button type="button" class="btn-del-photo" data-index="${index}" title="Eliminar esta foto" style="position: absolute; top: 2px; right: 2px; background: rgba(231,76,60,0.9); color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; font-weight: bold;">✕</button>
                <button type="button" class="btn-edit-heading" data-index="${index}" title="Toca para cambiar sentido de la foto" style="position: absolute; bottom: 2px; left: 2px; right: 2px; background: rgba(0,0,0,0.78); color: #2ecc71; border: none; font-size: 9px; padding: 2px 3px; border-radius: 3px; cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;">
                    🧭 ${pHeading}
                </button>
            </div>
            `;
        }).join('');
        
        grid.querySelectorAll('.btn-del-photo').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index, 10);
                currentPhotos.splice(idx, 1);
                renderPhotosGrid();
                showToast(`Foto eliminada (${currentPhotos.length} restantes)`);
            });
        });

        grid.querySelectorAll('.btn-edit-heading').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index, 10);
                const currentObj = currentPhotos[idx];
                const prevLabel = typeof currentObj === 'object' ? (currentObj.headingLabel || '') : '';
                const newLabel = prompt('Sentido / Orientación de la foto (ej: 045° NE, Norte, Sur, Aguas arriba, Hacia talud):', prevLabel);
                if (newLabel !== null) {
                    if (typeof currentPhotos[idx] === 'string') {
                        currentPhotos[idx] = { url: currentPhotos[idx], heading: null, headingLabel: newLabel.trim() };
                    } else {
                        currentPhotos[idx].headingLabel = newLabel.trim();
                    }
                    renderPhotosGrid();
                    showToast(`Sentido actualizado: ${newLabel.trim() || 'Sin etiqueta'}`);
                }
            });
        });
    }

    // In-App Continuous Burst Camera & Gallery Selector
    const btnOpenCamera = document.getElementById('btn-open-camera');
    const btnPickGallery = document.getElementById('btn-pick-gallery');
    const modalCamera = document.getElementById('modal-camera');
    const cameraVideo = document.getElementById('camera-video');
    const btnShutter = document.getElementById('btn-shutter');
    const btnCameraDone = document.getElementById('btn-camera-done');
    const btnCloseCamera = document.getElementById('btn-close-camera');
    const cameraFlash = document.getElementById('camera-flash');
    const cameraCountNum = document.getElementById('camera-count-num');
    const cameraHeadingVal = document.getElementById('camera-heading-val');
    let cameraStream = null;
    let cameraCompassInterval = null;

    async function startInAppCamera() {
        if (!modalCamera || !cameraVideo) return;
        try {
            const constraints = {
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                },
                audio: false
            };

            cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
            cameraVideo.srcObject = cameraStream;
            await cameraVideo.play();

            modalCamera.classList.remove('hidden');
            if (cameraCountNum) cameraCountNum.textContent = currentPhotos.length;

            if (cameraCompassInterval) clearInterval(cameraCompassInterval);
            cameraCompassInterval = setInterval(() => {
                const h = (state.gps && state.gps.getHeading) ? state.gps.getHeading() : null;
                if (cameraHeadingVal) {
                    if (h !== null && !isNaN(h)) {
                        cameraHeadingVal.textContent = `${Math.round(h).toString().padStart(3, '0')}° ${GPSTracker.headingToCardinal(h)}`;
                    } else {
                        cameraHeadingVal.textContent = '000° N';
                    }
                }
            }, 200);

        } catch (err) {
            console.warn('Cámara interna no disponible, usando selector de archivos:', err);
            showToast('Abriendo selector de fotos...');
            if (photoInput) photoInput.click();
        }
    }

    function stopInAppCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(t => t.stop());
            cameraStream = null;
        }
        if (cameraCompassInterval) {
            clearInterval(cameraCompassInterval);
            cameraCompassInterval = null;
        }
        if (modalCamera) modalCamera.classList.add('hidden');
        renderPhotosGrid();
    }

    async function captureCameraFrame() {
        if (!cameraVideo || !cameraStream) return;

        // Visual flash
        if (cameraFlash) {
            cameraFlash.style.opacity = '0.9';
            setTimeout(() => { cameraFlash.style.opacity = '0'; }, 100);
        }

        if (navigator.vibrate) {
            try { navigator.vibrate(50); } catch(e) {}
        }

        const videoW = cameraVideo.videoWidth || 1280;
        const videoH = cameraVideo.videoHeight || 720;

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = videoW;
        offscreenCanvas.height = videoH;
        const ctx = offscreenCanvas.getContext('2d');
        ctx.drawImage(cameraVideo, 0, 0, videoW, videoH);

        // Technical Watermark Stamping
        const stampToggle = document.getElementById('pm-stamp-toggle');
        const isStampEnabled = stampToggle ? stampToggle.checked : true;
        const projectName = state.currentProjectName || 'CampoMaps';

        let targetLat = null, targetLng = null, targetAlt = null, targetAcc = null;
        if (state.gps && state.gps.currentPosition) {
            targetLat = state.gps.currentPosition.lat;
            targetLng = state.gps.currentPosition.lng;
            targetAlt = state.gps.currentPosition.altitude;
            targetAcc = state.gps.currentPosition.accuracy;
        } else if (state.mapEngine) {
            const center = state.mapEngine.getCenter();
            targetLat = center.lat;
            targetLng = center.lng;
        }

        const currentHeading = (state.gps && state.gps.getHeading) ? state.gps.getHeading() : null;
        const cardinal = currentHeading !== null ? GPSTracker.headingToCardinal(currentHeading) : '';
        const defaultHeadingLabel = currentHeading !== null 
            ? `${Math.round(currentHeading).toString().padStart(3, '0')}° ${cardinal}`
            : '';

        if (isStampEnabled && targetLat && targetLng) {
            const bannerH = Math.max(70, Math.round(videoH * 0.11));
            const bannerY = videoH - bannerH;

            // Draw dark background banner
            ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            ctx.fillRect(0, bannerY, videoW, bannerH);

            // Accent border
            ctx.fillStyle = '#2ecc71';
            ctx.fillRect(0, bannerY, videoW, Math.max(3, Math.round(bannerH * 0.04)));

            const fontSize = Math.max(12, Math.round(bannerH * 0.22));
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.textBaseline = 'middle';

            const d = new Date();
            const dateStr = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;

            // Line 1: Project, Date, Heading
            ctx.fillStyle = '#ffffff';
            let line1 = `PROYECTO: ${projectName.toUpperCase()} | 📅 ${dateStr}`;
            if (currentHeading !== null) {
                line1 += ` | 🧭 Sentido: ${defaultHeadingLabel}`;
            }
            ctx.fillText(line1, 15, bannerY + bannerH * 0.28);

            // Line 2: MAGNA-SIRGAS Coordinates
            const magna = toMagnaSirgas(targetLat, targetLng);
            ctx.fillStyle = '#2ecc71';
            const line2 = `MAGNA Origen Nal. (EPSG:9377): N: ${magna.northing.toLocaleString('es-CO', {maximumFractionDigits:2})} m | E: ${magna.easting.toLocaleString('es-CO', {maximumFractionDigits:2})} m`;
            ctx.fillText(line2, 15, bannerY + bannerH * 0.58);

            // Line 3: WGS84 + Precision
            ctx.fillStyle = '#e0e0e0';
            let line3 = `WGS84: ${targetLat.toFixed(6)}°, ${targetLng.toFixed(6)}°`;
            if (targetAlt) line3 += ` | ⛰️ Alt: ${Math.round(targetAlt)}m`;
            if (targetAcc) line3 += ` | 🎯 Prec: ±${Math.round(targetAcc)}m`;
            ctx.fillText(line3, 15, bannerY + bannerH * 0.85);
        }

        const dataUrl = offscreenCanvas.toDataURL('image/jpeg', 0.82);
        currentPhotos.push({
            url: dataUrl,
            heading: currentHeading,
            headingLabel: defaultHeadingLabel
        });

        if (cameraCountNum) {
            cameraCountNum.textContent = currentPhotos.length;
        }
        showToast(`📸 Foto #${currentPhotos.length} capturada (${defaultHeadingLabel || 'orientada'})`);
    }

    if (btnOpenCamera) {
        btnOpenCamera.addEventListener('click', startInAppCamera);
    }
    if (btnShutter) {
        btnShutter.addEventListener('click', captureCameraFrame);
    }
    if (btnCameraDone) {
        btnCameraDone.addEventListener('click', () => {
            stopInAppCamera();
            showToast(`✅ ${currentPhotos.length} foto(s) adjuntadas`);
        });
    }
    if (btnCloseCamera) {
        btnCloseCamera.addEventListener('click', stopInAppCamera);
    }

    // Gallery Picker button (Multiple photos at once)
    if (btnPickGallery && photoInput) {
        btnPickGallery.addEventListener('click', () => {
            photoInput.click();
        });
    }
    
    if (photoInput) {
        photoInput.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) {
                try {
                    showToast(`Procesando ${files.length} foto(s)...`);

                    const stampToggle = document.getElementById('pm-stamp-toggle');
                    const isStampEnabled = stampToggle ? stampToggle.checked : true;
                    const projectName = state.currentProjectName || 'CampoMaps';

                    let targetLat = null, targetLng = null, targetAlt = null, targetAcc = null;
                    if (state.gps && state.gps.currentPosition) {
                        targetLat = state.gps.currentPosition.lat;
                        targetLng = state.gps.currentPosition.lng;
                        targetAlt = state.gps.currentPosition.altitude;
                        targetAcc = state.gps.currentPosition.accuracy;
                    } else if (state.mapEngine) {
                        const center = state.mapEngine.getCenter();
                        targetLat = center.lat;
                        targetLng = center.lng;
                    }

                    const currentHeading = (state.gps && state.gps.getHeading) ? state.gps.getHeading() : null;
                    const cardinal = currentHeading !== null ? GPSTracker.headingToCardinal(currentHeading) : '';
                    const defaultHeadingLabel = currentHeading !== null 
                        ? `${Math.round(currentHeading).toString().padStart(3, '0')}° ${cardinal}`
                        : '';

                    const stampOptions = {
                        enabled: isStampEnabled,
                        projectName: projectName || 'CampoMaps',
                        lat: targetLat,
                        lng: targetLng,
                        altitude: targetAlt,
                        accuracy: targetAcc,
                        heading: currentHeading,
                        headingLabel: defaultHeadingLabel,
                        timestamp: new Date()
                    };

                    for (const file of files) {
                        const base64 = await PlacemarkManager.readPhoto(file, stampOptions);
                        currentPhotos.push({
                            url: base64,
                            heading: currentHeading,
                            headingLabel: defaultHeadingLabel
                        });
                    }
                    renderPhotosGrid();
                    showToast(`📷 ${currentPhotos.length} foto(s) adjunta(s)`);
                } catch (err) {
                    console.error("Error al leer fotos:", err);
                    showToast("⚠️ Error al procesar fotos");
                }
                photoInput.value = '';
            }
        });
    }
    
    if (btnClearPhotos) {
        btnClearPhotos.addEventListener('click', () => {
            currentPhotos = [];
            if (photoInput) photoInput.value = '';
            renderPhotosGrid();
            showToast('Fotos removidas');
        });
    }

    // Update badge helper for Censo accordions
    const updateBadge = (containerId) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        const count = container.querySelectorAll('.censo-chip.selected').length;
        const details = container.closest('details');
        if (details) {
            const badge = details.querySelector('.censo-badge');
            if (badge) {
                badge.textContent = count === 1 ? '1 sel.' : `${count} sel.`;
                badge.style.background = count > 0 ? '#27ae60' : 'rgba(255, 255, 255, 0.1)';
                badge.style.color = count > 0 ? '#ffffff' : 'var(--text-secondary)';
            }
        }
    };
    window.__campoMapsUpdateBadges = () => {
        ['chips-fuente-primaria', 'chips-fuente-secundaria', 'chips-fuente-pecuario', 'chips-fuente-agricola', 'chips-residuo-liquido', 'chips-residuo-solido'].forEach(id => updateBadge(id));
    };

    // Render multi-select chips for Uso y Usuarios
    const renderChips = (containerId, items) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        items.forEach(item => {
            const chip = document.createElement('div');
            chip.className = 'censo-chip';
            chip.dataset.val = item;
            chip.textContent = item;
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                chip.classList.toggle('selected');
                chip.textContent = chip.classList.contains('selected') ? `✓ ${item}` : item;
                updateBadge(containerId);
            });
            container.appendChild(chip);
        });
        updateBadge(containerId);
    };

    renderChips('chips-fuente-primaria', FUENTES_AGUA);
    renderChips('chips-fuente-secundaria', FUENTES_AGUA);
    renderChips('chips-fuente-pecuario', FUENTES_AGUA);
    renderChips('chips-fuente-agricola', FUENTES_AGUA);
    renderChips('chips-residuo-liquido', RESIDUOS_LIQUIDOS);
    renderChips('chips-residuo-solido', RESIDUOS_SOLIDOS);

    // Toggle Censo Accordion (Robust handler without double-event trap)
    const toggleCensoHeader = document.getElementById('toggle-censo-header');
    const checkEnableCenso = document.getElementById('check-enable-censo');
    const censoFormBody = document.getElementById('censo-form-body');
    const censoArrow = document.getElementById('censo-arrow');

    if (toggleCensoHeader && censoFormBody) {
        toggleCensoHeader.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const willOpen = censoFormBody.classList.contains('hidden');
            if (checkEnableCenso) checkEnableCenso.checked = willOpen;
            if (willOpen) {
                censoFormBody.classList.remove('hidden');
                if (censoArrow) {
                    censoArrow.textContent = '▲ Ocultar';
                    censoArrow.style.background = '#27ae60';
                }
                setTimeout(() => {
                    censoFormBody.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 100);
            } else {
                censoFormBody.classList.add('hidden');
                if (censoArrow) {
                    censoArrow.textContent = '▼ Activar';
                    censoArrow.style.background = '#2980b9';
                }
            }
        });
    }

    // Export Helpers
    async function getActivePlacemarks() {
        const allPms = await getPlacemarks();
        const filtered = allPms.filter(pm => {
            if (!state.currentProjectId || state.currentProjectId === 'default_proj') {
                return !pm.projectId || pm.projectId === 'default_proj';
            }
            return pm.projectId === state.currentProjectId;
        });
        return filtered.length > 0 ? filtered : allPms;
    }

    async function handleExportKmz() {
        const pms = await getActivePlacemarks();
        if (!pms || pms.length === 0) return;
        const projName = (state.currentProjectName || 'CampoMaps').replace(/[\s\/\\:*?"<>|]/g, '_');
        const dateStr = new Date().toISOString().slice(0, 10);
        await exportPlacemarksToKMZ(pms, `${projName}_Puntos_MAGNA_${dateStr}.kmz`);
    }

    async function handleExportDocx() {
        const pms = await getActivePlacemarks();
        if (!pms || pms.length === 0) return;
        const projName = (state.currentProjectName || 'CampoMaps').replace(/[\s\/\\:*?"<>|]/g, '_');
        const dateStr = new Date().toISOString().slice(0, 10);
        await exportPlacemarksToDocx(pms, {
            filename: `Registro_Fotografico_${projName}_${dateStr}.docx`,
            etiquetaCoords: 'Coordenadas Magna Sirgas Origen Nacional '
        });
    }

    async function handleExportExcelUso() {
        const pms = await getActivePlacemarks();
        if (!pms || pms.length === 0) return;
        const projName = (state.currentProjectName || 'CampoMaps').replace(/[\s\/\\:*?"<>|]/g, '_');
        const dateStr = new Date().toISOString().slice(0, 10);
        await exportUsoUsuariosToExcel(pms, `Censo_Uso_y_Usuarios_${projName}_${dateStr}.xlsx`);
    }

    // Unified Export Handler (KMZ + Word + Excel simultaneously)
    async function handleExportAll() {
        try {
            const pms = await getActivePlacemarks();
            if (!pms || pms.length === 0) {
                showToast('⚠️ No hay marcadores para exportar');
                return;
            }
            showToast('⚡ Generando paquete completo (KMZ, Word y Excel)...');
            await handleExportKmz();
            await new Promise(r => setTimeout(r, 600));
            await handleExportDocx();
            await new Promise(r => setTimeout(r, 600));
            await handleExportExcelUso();
            showToast('🎉 ¡Paquete completo (KMZ + Word + Excel) descargado!');
        } catch (err) {
            console.error('Error en exportación completa:', err);
            showToast('❌ Error en exportación: ' + (err.message || err));
        }
    }

    // Attach to UI buttons
    const btnExportAllMain = document.getElementById('btn-export-all-main');
    if (btnExportAllMain) btnExportAllMain.addEventListener('click', handleExportAll);
    const btnSettingsAll = document.getElementById('btn-settings-export-all');
    if (btnSettingsAll) btnSettingsAll.addEventListener('click', handleExportAll);

    // Make renderPhotosGrid accessible to modal open/close
    window.__campoMapsRenderPhotos = renderPhotosGrid;
    window.__campoMapsClearPhotos = () => { currentPhotos = []; renderPhotosGrid(); };
    window.__campoMapsGetPhotos = () => [...currentPhotos];
}

let pendingPlacemarkLatLng = null;

function openPlacemarkModal(latlng) {
    pendingPlacemarkLatLng = latlng;
    
    // Reset form
    const nameInput = document.getElementById('pm-name');
    const descInput = document.getElementById('pm-desc');
    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    
    // Reset icon selection
    document.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
    const defaultIcon = document.querySelector('.icon-option[data-icon="default"]');
    if (defaultIcon) defaultIcon.classList.add('selected');
    state.selectedIcon = 'default';
    
    // Reset photos
    if (window.__campoMapsClearPhotos) window.__campoMapsClearPhotos();
    
    // Reset Censo form
    const checkCenso = document.getElementById('check-enable-censo');
    const censoBody = document.getElementById('censo-form-body');
    const censoArrow = document.getElementById('censo-arrow');
    if (checkCenso) checkCenso.checked = false;
    if (censoBody) censoBody.classList.add('hidden');
    if (censoArrow) {
        censoArrow.textContent = '▼ Activar';
        censoArrow.style.background = '#2980b9';
    }

    const censoIdCampo = document.getElementById('censo-id-campo');
    if (censoIdCampo) censoIdCampo.value = '';
    const censoMun = document.getElementById('censo-municipio');
    if (censoMun) censoMun.value = '';
    const censoVer = document.getElementById('censo-vereda');
    if (censoVer) censoVer.value = '';
    const censoPredio = document.getElementById('censo-predio');
    if (censoPredio) censoPredio.value = '';
    const censoHab = document.getElementById('censo-habitantes');
    if (censoHab) censoHab.value = '';
    const censoOtros = document.getElementById('censo-otros-usos');
    if (censoOtros) censoOtros.value = '';

    // Clear all chips selection and reset text
    document.querySelectorAll('.censo-chip').forEach(c => {
        c.classList.remove('selected');
        c.textContent = c.dataset.val;
    });
    if (window.__campoMapsUpdateBadges) window.__campoMapsUpdateBadges();

    const censoCota = document.getElementById('censo-cota');
    if (censoCota) {
        if (state.gps && state.gps.lastPosition && state.gps.lastPosition.altitude !== null) {
            censoCota.value = Math.round(state.gps.lastPosition.altitude);
        } else {
            censoCota.value = '';
        }
    }

    // Update live coordinates and precision display
    const statusMagna = document.getElementById('pm-status-magna');
    const statusAcc = document.getElementById('pm-status-acc');
    const btnAverage = document.getElementById('btn-average-gps');

    if (latlng) {
        const magna = toMagnaSirgas(latlng.lat, latlng.lng);
        if (statusMagna) statusMagna.textContent = `MAGNA: N: ${Math.round(magna.norte).toLocaleString('es-CO')} | E: ${Math.round(magna.este).toLocaleString('es-CO')}`;
    }

    const currentAcc = (state.gps && state.gps.lastPosition) ? state.gps.lastPosition.accuracy : null;
    if (statusAcc) {
        if (currentAcc) {
            const accVal = Math.round(currentAcc);
            const qual = accVal <= 5 ? '🟢 Alta' : (accVal <= 15 ? '🟡 Media' : '🔴 Baja (Interiores)');
            statusAcc.textContent = `Precisión actual: ±${accVal} m (${qual})`;
        } else {
            statusAcc.textContent = 'Precisión: Punto fijado en pantalla';
        }
    }

    if (btnAverage) {
        btnAverage.textContent = '🎯 Promediar GPS';
        btnAverage.disabled = false;
        btnAverage.onclick = async () => {
            if (!state.gps || !state.gps.getAveragedPosition) {
                showToast('GPS no activo');
                return;
            }
            btnAverage.disabled = true;
            try {
                showToast('📡 Tomando lecturas para estabilizar...');
                const avgPos = await state.gps.getAveragedPosition(8, (curr, total, acc) => {
                    btnAverage.textContent = `⏳ ${curr}/${total} (±${Math.round(acc)}m)`;
                });

                pendingPlacemarkLatLng = { lat: avgPos.lat, lng: avgPos.lng };
                const m = toMagnaSirgas(avgPos.lat, avgPos.lng);
                if (statusMagna) statusMagna.textContent = `MAGNA: N: ${Math.round(m.norte).toLocaleString('es-CO')} | E: ${Math.round(m.este).toLocaleString('es-CO')}`;
                if (statusAcc) statusAcc.textContent = `🎯 Promediado con éxito (±${avgPos.accuracy} m - 8 lecturas)`;
                btnAverage.textContent = `✔ ±${avgPos.accuracy}m`;
                showToast(`🎯 Coordenadas estabilizadas a ±${avgPos.accuracy} m`);
            } catch (err) {
                btnAverage.textContent = '🎯 Reintentar';
                btnAverage.disabled = false;
                showToast('⚠️ No se pudo promediar: ' + err.message);
            }
        };
    }

    // Show modal
    const modal = document.getElementById('modal-placemark');
    if (modal) modal.classList.remove('hidden');
}

async function savePlacemarkFromModal() {
    if (!pendingPlacemarkLatLng) return;
    
    const name = document.getElementById('pm-name')?.value || 'Marcador';
    const desc = document.getElementById('pm-desc')?.value || '';
    const photos = window.__campoMapsGetPhotos ? window.__campoMapsGetPhotos() : [];
    
    // Helper to get selected chip values
    const getSelectedChips = (containerId) => {
        const container = document.getElementById(containerId);
        if (!container) return [];
        return Array.from(container.querySelectorAll('.censo-chip.selected')).map(c => c.dataset.val);
    };

    // Check if Censo is enabled
    const isCensoEnabled = document.getElementById('check-enable-censo')?.checked;
    let censoData = null;
    if (isCensoEnabled) {
        censoData = {
            idCampo: document.getElementById('censo-id-campo')?.value.trim() || '',
            municipio: document.getElementById('censo-municipio')?.value.trim() || '',
            vereda: document.getElementById('censo-vereda')?.value.trim() || '',
            predio: document.getElementById('censo-predio')?.value.trim() || '',
            habitantes: document.getElementById('censo-habitantes')?.value.trim() || '',
            cota: document.getElementById('censo-cota')?.value.trim() || '',
            fuentePrimaria: getSelectedChips('chips-fuente-primaria'),
            fuenteSecundaria: getSelectedChips('chips-fuente-secundaria'),
            fuentePecuario: getSelectedChips('chips-fuente-pecuario'),
            fuenteAgricola: getSelectedChips('chips-fuente-agricola'),
            otrosUsos: document.getElementById('censo-otros-usos')?.value.trim() || '',
            residuoLiquido: getSelectedChips('chips-residuo-liquido'),
            residuoSolido: getSelectedChips('chips-residuo-solido')
        };
    }

    const data = {
        name,
        description: desc,
        icon: state.selectedIcon,
        color: '#2ecc71',
        photos: photos,
        censoAgua: censoData,
        projectId: state.currentProjectId || 'default_proj',
        createdAt: new Date().toISOString()
    };
    
    await state.placemarkManager.addPlacemark(pendingPlacemarkLatLng, data);
    
    // Close modal
    const modal = document.getElementById('modal-placemark');
    if (modal) modal.classList.add('hidden');
    
    pendingPlacemarkLatLng = null;
    if (window.__campoMapsClearPhotos) window.__campoMapsClearPhotos();
    
    await updatePlacemarksList();
    showToast(photos.length > 0 ? `📌 Marcador con ${photos.length} foto(s) guardado` : '📌 Marcador guardado');
}

async function updatePlacemarksList() {
    const list = document.getElementById('list-placemarks');
    if (!list) return;
    
    const allPms = await getPlacemarks();
    const placemarks = allPms.filter(pm => {
        if (!state.currentProjectId || state.currentProjectId === 'default_proj') {
            return !pm.projectId || pm.projectId === 'default_proj';
        }
        return pm.projectId === state.currentProjectId;
    });
    let html = '';
    
    placemarks.forEach(pm => {
        const iconMap = { default: '📍', tree: '🌳', water: '💧', warning: '⚠️', camera: '📷' };
        const icon = iconMap[pm.icon] || '📍';
        const magna = toMagnaSirgas(pm.lat, pm.lng);
        const hasPhoto = pm.photos && pm.photos.length > 0;
        
        html += `
        <li class="list-item" data-id="${pm.id}">
            <div class="item-icon">${icon}</div>
            <div class="item-details">
                <h3 class="item-title">${pm.name || 'Sin nombre'} ${hasPhoto ? '📷' : ''}</h3>
                <p class="item-meta" style="font-size:11px; color:#2ecc71;">${magna.formatted}</p>
            </div>
            <button class="btn-icon btn-delete-pm" data-id="${pm.id}" aria-label="Eliminar">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </li>`;
    });
    
    list.innerHTML = html;
    
    // Delete handlers
    list.querySelectorAll('.btn-delete-pm').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (confirm('¿Eliminar este marcador?')) {
                await state.placemarkManager.deletePlacemark(id);
                await updatePlacemarksList();
                showToast('Marcador eliminado');
            }
        });
    });
    
    // Click to zoom
    list.querySelectorAll('.list-item').forEach(item => {
        item.addEventListener('click', () => {
            const pm = placemarks.find(p => p.id === item.dataset.id);
            if (pm) {
                state.mapEngine.setView(pm.lat, pm.lng, 16);
                closeAllPanels();
            }
        });
    });
}

// ========== CALIBRATION ==========
function setupCalibration() {
    const fileInput = document.getElementById('map-image-upload');
    const preview = document.getElementById('calibration-preview');
    const btnFinish = document.getElementById('btn-finish-calibration');
    const calPoints = document.getElementById('calibration-points');
    
    const pdfStatus = document.getElementById('pdf-status');
    const geopdfCard = document.getElementById('geopdf-detected-card');
    const geopdfInfo = document.getElementById('geopdf-info');
    const btnLoadGeoPdfDirect = document.getElementById('btn-load-geopdf-direct');
    
    let currentLoadedResult = null;
    let imageFile = null;
    
    // Open calibration modal button
    const btnOpenCal = document.getElementById('btn-open-calibrate');
    if (btnOpenCal) {
        btnOpenCal.addEventListener('click', () => {
            const modal = document.getElementById('modal-calibrate');
            if (modal) modal.classList.remove('hidden');
            closeAllPanels();
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                imageFile = file;
                try {
                    showToast('Cargando mapa...');
                    if (pdfStatus) {
                        pdfStatus.style.display = 'block';
                        pdfStatus.textContent = file.name.endsWith('.pdf') ? '📄 Procesando mapa PDF georreferenciado...' : '🖼️ Procesando imagen...';
                    }
                    
                    const result = await state.calibrator.loadFile(file);
                    currentLoadedResult = result;
                    
                    if (preview) {
                        preview.src = result.url;
                        preview.style.display = 'block';
                    }
                    
                    if (result.hasGeoReference && result.bounds) {
                        if (geopdfCard) geopdfCard.classList.remove('hidden');
                        if (geopdfInfo) {
                            const b = result.bounds;
                            const magnaSW = toMagnaSirgas(b[0][0], b[0][1]);
                            const magnaNE = toMagnaSirgas(b[1][0], b[1][1]);
                            geopdfInfo.innerHTML = `
                                <strong>Formato:</strong> ${result.geoMetadata?.format || 'GeoPDF'}<br>
                                <strong>Coordenadas MAGNA-SIRGAS Origen Nacional:</strong><br>
                                SO: ${magnaSW.formatted}<br>
                                NE: ${magnaNE.formatted}<br>
                                <em>¡El mapa ya tiene georreferenciación oficial! Puedes cargarlo con 1 toque.</em>
                            `;
                        }
                        if (pdfStatus) {
                            pdfStatus.textContent = `✅ Mapa GeoPDF detectado (${result.width}x${result.height} px) con georreferencia oficial`;
                        }
                        showToast('🎉 ¡GeoPDF válido detectado! Pulsa "Cargar Directamente".');
                    } else {
                        if (geopdfCard) geopdfCard.classList.add('hidden');
                        if (pdfStatus) {
                            pdfStatus.textContent = result.isPdf 
                                ? `📄 Mapa PDF cargado (${result.width}x${result.height} px). Listo para calibrar en MAGNA-SIRGAS o posicionar con GPS.` 
                                : `🖼️ Imagen cargada (${result.width}x${result.height} px).`;
                        }
                        showToast('Mapa cargado. Toca la imagen o usa "Posicionar plano en GPS".');
                    }
                    
                    controlPoints = [];
                    if (calPoints) calPoints.innerHTML = '';
                } catch (err) {
                    console.error("Error al cargar mapa:", err);
                    showToast('❌ Error al cargar archivo: ' + err.message);
                    if (pdfStatus) {
                        pdfStatus.textContent = '❌ Error al procesar archivo: ' + err.message;
                    }
                }
            }
        });
    }

    // Quick-test user's GeoPDF sample (Infraestructura_conImagen.pdf)
    const btnLoadSample = document.getElementById('btn-load-sample-geopdf');
    if (btnLoadSample) {
        btnLoadSample.addEventListener('click', async () => {
            try {
                showToast('📄 Procesando Infraestructura_conImagen.pdf de prueba...');
                if (pdfStatus) {
                    pdfStatus.style.display = 'block';
                    pdfStatus.textContent = '📄 Procesando Infraestructura_conImagen.pdf (29 MB)...';
                }
                const response = await fetch('/Infraestructura_conImagen.pdf');
                if (!response.ok) throw new Error('No se pudo acceder al archivo local');
                const blob = await response.blob();
                const file = new File([blob], 'Infraestructura_conImagen.pdf', { type: 'application/pdf' });
                imageFile = file;

                const result = await state.calibrator.loadFile(file);
                currentLoadedResult = result;

                if (preview) {
                    preview.src = result.url;
                    preview.style.display = 'block';
                }

                if (result.hasGeoReference && result.bounds) {
                    if (geopdfCard) geopdfCard.classList.remove('hidden');
                    if (geopdfInfo) {
                        const b = result.bounds;
                        const magnaSW = toMagnaSirgas(b[0][0], b[0][1]);
                        const magnaNE = toMagnaSirgas(b[1][0], b[1][1]);
                        geopdfInfo.innerHTML = `
                            <strong>Formato:</strong> ${result.geoMetadata?.format || 'GeoPDF'}<br>
                            <strong>Coordenadas MAGNA-SIRGAS Origen Nacional:</strong><br>
                            SO: ${magnaSW.formatted}<br>
                            NE: ${magnaNE.formatted}<br>
                            <em>¡El mapa ya tiene georreferenciación oficial! Puedes cargarlo con 1 toque.</em>
                        `;
                    }
                    if (pdfStatus) {
                        pdfStatus.textContent = `✅ Mapa GeoPDF detectado (${result.width}x${result.height} px) con georreferencia oficial`;
                    }
                    showToast('🎉 ¡GeoPDF válido detectado! Pulsa "Cargar Directamente".');
                }
            } catch (err) {
                console.error("Error al cargar mapa de prueba:", err);
                showToast('❌ Error: ' + err.message);
                if (pdfStatus) pdfStatus.textContent = '❌ Error: ' + err.message;
            }
        });
    }
    
    // Direct 1-click loading for GeoPDF
    if (btnLoadGeoPdfDirect) {
        btnLoadGeoPdfDirect.addEventListener('click', async () => {
            if (!currentLoadedResult || !currentLoadedResult.bounds) {
                showToast('⚠️ No se detectaron coordenadas automáticas.');
                return;
            }
            try {
                showToast('Cargando mapa GeoPDF en el visor...');
                const mapId = generateUUID();
                state.mapEngine.addImageOverlay(mapId, currentLoadedResult.url, currentLoadedResult.bounds);
                state.mapEngine.fitBounds(currentLoadedResult.bounds);
                
                await saveMap({
                    id: mapId,
                    name: imageFile ? imageFile.name : 'Mapa GeoPDF',
                    imageData: currentLoadedResult.url,
                    bounds: currentLoadedResult.bounds,
                    isGeoPdf: true,
                    format: currentLoadedResult.geoMetadata?.format || 'GeoPDF',
                    createdAt: new Date().toISOString()
                });
                
                await updateMapsList();
                
                const modal = document.getElementById('modal-calibrate');
                if (modal) modal.classList.add('hidden');
                
                showToast('🗺️ ¡Mapa GeoPDF georreferenciado cargado con éxito!');
            } catch (err) {
                console.error('Error al guardar GeoPDF:', err);
                showToast('❌ Error al guardar mapa: ' + err.message);
            }
        });
    }
    
    // Mode toggles: MAGNA vs WGS84
    const btnModeMagna = document.getElementById('btn-cal-mode-magna');
    const btnModeGeo = document.getElementById('btn-cal-mode-geo');
    const inputsMagna = document.getElementById('inputs-magna');
    const inputsGeo = document.getElementById('inputs-geo');

    if (btnModeMagna && btnModeGeo) {
        btnModeMagna.addEventListener('click', () => {
            btnModeMagna.classList.add('active');
            btnModeMagna.style.borderColor = 'var(--accent-primary)';
            btnModeGeo.classList.remove('active');
            btnModeGeo.style.borderColor = '';
            inputsMagna?.classList.remove('hidden');
            inputsGeo?.classList.add('hidden');
        });

        btnModeGeo.addEventListener('click', () => {
            btnModeGeo.classList.add('active');
            btnModeGeo.style.borderColor = 'var(--accent-primary)';
            btnModeMagna.classList.remove('active');
            btnModeMagna.style.borderColor = '';
            inputsGeo?.classList.remove('hidden');
            inputsMagna?.classList.add('hidden');
        });
    }

    // Click on preview image to place control point
    if (preview) {
        preview.addEventListener('click', (e) => {
            const rect = preview.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            
            const marker = document.createElement('div');
            marker.className = 'cal-point';
            marker.style.left = x + '%';
            marker.style.top = y + '%';
            marker.textContent = controlPoints.length + 1;
            if (calPoints) calPoints.appendChild(marker);
            
            controlPoints.push({ pixelX: x, pixelY: y, lat: null, lng: null });
            showToast(`Punto ${controlPoints.length}: ingresa Norte y Este abajo`);
        });
    }

    function registerControlPoint(lat, lng, label) {
        const lastPoint = controlPoints.find(p => p.lat === null);
        if (lastPoint) {
            lastPoint.lat = lat;
            lastPoint.lng = lng;
            showToast(`✅ Punto ${controlPoints.indexOf(lastPoint) + 1} fijado (${label})`);
        } else {
            controlPoints.push({
                pixelX: 50,
                pixelY: 50,
                lat: lat,
                lng: lng
            });
            showToast(`✅ Punto fijado: ${label}`);
        }
    }
    
    // MAGNA Origen Nacional point fixation
    const btnAddPoint = document.getElementById('btn-add-cal-point');
    if (btnAddPoint) {
        btnAddPoint.addEventListener('click', () => {
            const nInput = document.getElementById('cal-norte');
            const eInput = document.getElementById('cal-este');
            const norte = parseFloat(nInput?.value);
            const este = parseFloat(eInput?.value);

            if (isNaN(norte) || isNaN(este)) {
                showToast('⚠️ Ingresa Norte y Este válidos (en metros)');
                return;
            }

            try {
                const geo = fromMagnaSirgas(norte, este);
                registerControlPoint(geo.lat, geo.lng, `N: ${Math.round(norte)}, E: ${Math.round(este)}`);
                if (nInput) nInput.value = '';
                if (eInput) eInput.value = '';
            } catch (err) {
                showToast('❌ Error en coordenadas MAGNA: ' + err.message);
            }
        });
    }

    // WGS84 point fixation
    const btnAddPointGeo = document.getElementById('btn-add-cal-point-geo');
    if (btnAddPointGeo) {
        btnAddPointGeo.addEventListener('click', () => {
            const latInput = document.getElementById('cal-lat');
            const lngInput = document.getElementById('cal-lng');
            const lat = parseFloat(latInput?.value);
            const lng = parseFloat(lngInput?.value);

            if (isNaN(lat) || isNaN(lng)) {
                showToast('⚠️ Ingresa Latitud y Longitud válidas');
                return;
            }

            registerControlPoint(lat, lng, `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
            if (latInput) latInput.value = '';
            if (lngInput) lngInput.value = '';
        });
    }

    // Fit directly over user's GPS
    const btnFitGps = document.getElementById('btn-cal-fit-gps');
    if (btnFitGps) {
        btnFitGps.addEventListener('click', async () => {
            if (!preview || !preview.src) {
                showToast('⚠️ Primero selecciona un archivo PDF o imagen');
                return;
            }

            showToast('📍 Posicionando mapa sobre tu ubicación GPS actual...');
            let centerLat = 4.5981, centerLng = -74.0758; // Colombia fallback
            const pos = state.gps.getPosition();
            if (pos) {
                centerLat = pos.lat;
                centerLng = pos.lng;
            } else {
                const c = state.mapEngine.getCenter();
                if (c) {
                    centerLat = c.lat;
                    centerLng = c.lng;
                }
            }

            const dLat = 0.005;
            const dLng = 0.005 / Math.max(0.1, Math.cos(centerLat * Math.PI / 180));
            const bounds = [
                [centerLat - dLat, centerLng - dLng],
                [centerLat + dLat, centerLng + dLng]
            ];

            const mapId = generateUUID();
            state.mapEngine.addImageOverlay(mapId, preview.src, bounds);
            state.mapEngine.fitBounds(bounds);

            await saveMap({
                id: mapId,
                name: (imageFile ? imageFile.name : 'Plano') + ' (Ubicación GPS)',
                imageData: preview.src,
                bounds: bounds,
                createdAt: new Date().toISOString()
            });

            await updateMapsList();
            const modal = document.getElementById('modal-calibrate');
            if (modal) modal.classList.add('hidden');

            showToast('🗺️ ¡Mapa posicionado sobre tu ubicación actual!');
        });
    }
    
    if (btnFinish) {
        btnFinish.addEventListener('click', async () => {
            if (!preview || !preview.src) {
                showToast('⚠️ Primero selecciona un archivo de mapa');
                return;
            }
            
            // If it's a detected GeoPDF with bounds, load directly
            if (currentLoadedResult && currentLoadedResult.bounds) {
                btnLoadGeoPdfDirect?.click();
                return;
            }
            
            const calibrated = controlPoints.filter(p => p.lat !== null);
            if (calibrated.length === 0) {
                // No control points: offer GPS centering immediately
                showToast('📍 Posicionando mapa sobre tu ubicación GPS...');
                btnFitGps?.click();
                return;
            }
            
            try {
                const img = new Image();
                img.src = preview.src;
                await new Promise(resolve => img.onload = resolve);
                
                let bounds;
                if (calibrated.length >= 3) {
                    state.calibrator.controlPoints = [];
                    calibrated.forEach(p => {
                        const pixelX = (p.pixelX / 100) * img.naturalWidth;
                        const pixelY = (p.pixelY / 100) * img.naturalHeight;
                        state.calibrator.addControlPoint(pixelX, pixelY, p.lat, p.lng);
                    });
                    state.calibrator.calibrate();
                    bounds = state.calibrator.getImageBounds(img.naturalWidth, img.naturalHeight);
                } else if (calibrated.length >= 2) {
                    const lats = calibrated.map(p => p.lat);
                    const lngs = calibrated.map(p => p.lng);
                    bounds = [
                        [Math.min(...lats), Math.min(...lngs)],
                        [Math.max(...lats), Math.max(...lngs)]
                    ];
                } else {
                    // 1 point
                    const p = calibrated[0];
                    bounds = [
                        [p.lat - 0.005, p.lng - 0.005],
                        [p.lat + 0.005, p.lng + 0.005]
                    ];
                }
                
                const mapId = generateUUID();
                state.mapEngine.addImageOverlay(mapId, preview.src, bounds);
                state.mapEngine.fitBounds(bounds);
                
                await saveMap({
                    id: mapId,
                    name: imageFile ? imageFile.name : 'Mapa calibrado',
                    imageData: preview.src,
                    bounds: [[bounds[0][0], bounds[0][1]], [bounds[1][0], bounds[1][1]]],
                    controlPoints: calibrated,
                    createdAt: new Date().toISOString()
                });
                
                await updateMapsList();
                
                const modal = document.getElementById('modal-calibrate');
                if (modal) modal.classList.add('hidden');
                
                controlPoints = [];
                if (calPoints) calPoints.innerHTML = '';
                
                showToast('🗺️ Mapa calibrado y cargado con éxito');
            } catch (e) {
                console.error('Calibration error:', e);
                showToast('❌ Error al calibrar: ' + e.message);
            }
        });
    }
}

async function updateMapsList() {
    const list = document.getElementById('list-maps');
    if (!list) return;
    
    const maps = await getMaps();
    
    // Always show OSM base first
    let html = `
    <li class="list-item">
        <div class="item-icon map-icon">🌍</div>
        <div class="item-details">
            <h3 class="item-title">Mapa Base (Online)</h3>
            <p class="item-meta">OpenStreetMap</p>
        </div>
    </li>`;
    
    maps.forEach(m => {
        html += `
        <li class="list-item map-list-item" data-id="${m.id}" style="cursor: pointer;">
            <div class="item-icon map-icon">🗺️</div>
            <div class="item-details" style="flex: 1;">
                <div style="display: flex; justify-content: space-between; align-items: baseline;">
                    <h3 class="item-title" style="margin: 0;">${m.name || 'Mapa'}</h3>
                    <small style="font-size: 10px; color: var(--accent-primary); font-weight: 600;">${m.isGeoPdf ? 'GeoPDF' : 'Calibrado'}</small>
                </div>
                <p class="item-meta" style="font-size: 10px; margin: 2px 0 6px 0;">${new Date(m.createdAt).toLocaleDateString('es-CO')}</p>
                <div style="display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.2); padding: 4px 6px; border-radius: 4px;" onclick="event.stopPropagation();">
                    <span style="font-size: 10px; color: var(--text-secondary);">Opacidad:</span>
                    <input type="range" min="10" max="100" value="100" class="map-opacity-slider" data-id="${m.id}" style="flex:1; height: 4px; accent-color: var(--accent-primary); cursor: pointer;">
                    <span class="opacity-val" id="op-val-${m.id}" style="font-size: 10px; color: var(--text-secondary); min-width: 28px;">100%</span>
                </div>
            </div>
            <button class="btn-icon btn-delete-map" data-id="${m.id}" aria-label="Eliminar">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </li>`;
    });
    
    list.innerHTML = html;
    
    // Tap on map item to center view
    list.querySelectorAll('.map-list-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            const targetMap = maps.find(m => m.id === id);
            if (targetMap && targetMap.bounds) {
                state.mapEngine.fitBounds(targetMap.bounds);
                showToast(`Centrado en ${targetMap.name || 'Mapa'}`);
                // Close panel
                const panel = document.getElementById('panel-maps');
                if (panel) panel.classList.remove('open');
            }
        });
    });

    // Opacity sliders
    list.querySelectorAll('.map-opacity-slider').forEach(slider => {
        slider.addEventListener('input', (e) => {
            e.stopPropagation();
            const id = slider.dataset.id;
            const val = parseInt(slider.value, 10);
            const label = document.getElementById(`op-val-${id}`);
            if (label) label.textContent = `${val}%`;
            state.mapEngine.setOverlayOpacity(id, val / 100);
        });
    });

    // Delete map handlers
    list.querySelectorAll('.btn-delete-map').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (confirm('¿Eliminar este mapa?')) {
                state.mapEngine.removeImageOverlay(id);
                await deleteMap(id);
                await updateMapsList();
                showToast('Mapa eliminado');
            }
        });
    });
}

// ========== MAP CONTROLS ==========
function setupMapControls() {
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
            const current = state.mapEngine.baseLayerType || 'satellite';
            if (current === 'satellite' || current === 'hybrid') {
                state.mapEngine.setBaseLayer('esri');
                showToast('🌍 Satélite Esri (Fotografía satelital pura)');
            } else if (current === 'esri') {
                state.mapEngine.setBaseLayer('osm');
                showToast('🗺️ Mapa Callejero (OpenStreetMap)');
            } else if (current === 'osm') {
                state.mapEngine.setBaseLayer('topo');
                showToast('⛰️ Mapa Topográfico (Curvas de nivel)');
            } else {
                state.mapEngine.setBaseLayer('satellite');
                showToast('🛰️ Google Híbrido (Satélite + Vías y Nombres)');
            }
        });
    }

    // Offline Tile Downloader
    const btnOpenOfflineDl = document.getElementById('btn-open-offline-dl');
    if (btnOpenOfflineDl) {
        btnOpenOfflineDl.addEventListener('click', () => {
            closeAllPanels();
            if (state.tileDownloader) {
                state.tileDownloader.showDownloadDialog(state.mapEngine.baseLayerType || 'satellite');
            }
        });
    }
    
    // Disable auto-center when user manually pans
    state.mapEngine.map?.on('dragstart', () => {
        state.autoCenter = false;
    });
}

// ========== SETTINGS ==========
function setupSettings() {
    // Light mode toggle
    const toggleLight = document.getElementById('toggle-light-mode');
    if (toggleLight) {
        toggleLight.addEventListener('change', async () => {
            document.body.classList.toggle('light-mode', toggleLight.checked);
            await saveSetting('lightMode', toggleLight.checked);
        });
    }

    // Photo stamping toggle & Project Name
    const toggleStamp = document.getElementById('toggle-stamp-photos');
    const pmStampToggle = document.getElementById('pm-stamp-toggle');
    const inputProjectName = document.getElementById('input-project-name');

    if (toggleStamp) {
        toggleStamp.addEventListener('change', async () => {
            if (pmStampToggle) pmStampToggle.checked = toggleStamp.checked;
            await saveSetting('stampPhotos', toggleStamp.checked);
        });
    }

    if (inputProjectName) {
        inputProjectName.addEventListener('change', async () => {
            await saveSetting('projectName', inputProjectName.value.trim());
        });
    }

    // Load saved settings
    (async () => {
        try {
            const savedStamp = await getSetting('stampPhotos');
            if (savedStamp && savedStamp.value !== undefined) {
                if (toggleStamp) toggleStamp.checked = savedStamp.value;
                if (pmStampToggle) pmStampToggle.checked = savedStamp.value;
            }
            const savedProject = await getSetting('projectName');
            if (savedProject && savedProject.value && inputProjectName) {
                inputProjectName.value = savedProject.value;
            }
        } catch (e) {
            console.warn('Error cargando ajustes:', e);
        }
    })();
}

// ========== MODALS ==========
function setupModals() {
    // Close modal buttons
    document.querySelectorAll('.btn-close-modal, .btn-cancel-modal').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = btn.closest('.modal');
            if (modal) modal.classList.add('hidden');
        });
    });
    
    // Click outside modal to close
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
            }
        });
    });
}

// ========== TOAST NOTIFICATIONS ==========
function showToast(message, duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    
    container.appendChild(toast);
    
    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
    }, duration);
}

// ========== PROJECTS MANAGEMENT ==========
async function setupProjects() {
    const btnOpenProjects = document.getElementById('btn-open-projects');
    const modalProjects = document.getElementById('modal-projects');
    const btnShowForm = document.getElementById('btn-show-project-form');
    const formBox = document.getElementById('project-form-box');
    const btnCancelForm = document.getElementById('btn-cancel-project-form');
    const btnSaveProject = document.getElementById('btn-save-new-project');
    const inputName = document.getElementById('new-project-name');
    const inputDesc = document.getElementById('new-project-desc');

    if (btnOpenProjects) {
        btnOpenProjects.addEventListener('click', async () => {
            if (modalProjects) modalProjects.classList.remove('hidden');
            await updateProjectsList();
        });
    }

    if (btnShowForm && formBox) {
        btnShowForm.addEventListener('click', () => {
            formBox.classList.toggle('hidden');
            if (!formBox.classList.contains('hidden') && inputName) {
                inputName.focus();
            }
        });
    }

    if (btnCancelForm && formBox) {
        btnCancelForm.addEventListener('click', () => {
            formBox.classList.add('hidden');
            if (inputName) inputName.value = '';
            if (inputDesc) inputDesc.value = '';
        });
    }

    if (btnSaveProject) {
        btnSaveProject.addEventListener('click', async () => {
            const name = inputName?.value?.trim();
            const desc = inputDesc?.value?.trim() || '';

            if (!name) {
                showToast('⚠️ Ingresa un nombre para el proyecto');
                return;
            }

            const newProj = {
                id: generateUUID(),
                name,
                description: desc,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            await saveProject(newProj);
            if (formBox) formBox.classList.add('hidden');
            if (inputName) inputName.value = '';
            if (inputDesc) inputDesc.value = '';

            await switchProject(newProj.id);
            await updateProjectsList();
            showToast(`✅ Proyecto "${name}" creado y activado`);
        });
    }
}

async function switchProject(projectId) {
    let proj = await getProject(projectId);
    if (!proj) {
        const projects = await getProjects();
        if (projects.length > 0) {
            proj = projects[0];
        } else {
            proj = {
                id: 'default_proj',
                name: 'Proyecto General',
                description: 'Proyecto inicial de campo',
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            await saveProject(proj);
        }
    }

    state.currentProjectId = proj.id;
    state.currentProjectName = proj.name;

    // Update top bar label
    const labelEl = document.getElementById('active-project-label');
    if (labelEl) labelEl.textContent = proj.name;

    // Update Project Name in Settings for photo watermark
    const inputProjectName = document.getElementById('input-project-name');
    if (inputProjectName) inputProjectName.value = proj.name;

    // Save active project id in settings
    await saveSetting('activeProjectId', proj.id);

    // Filter and reload placemarks for this project
    await loadPlacemarksForProject(proj.id);

    // If project has an associated map (GeoPDF), activate and load it
    if (proj.mapId) {
        const mapData = await getMap(proj.mapId);
        if (mapData && state.mapEngine) {
            state.mapEngine.addImageOverlay(mapData.id, mapData.dataUrl, mapData.bounds, { opacity: mapData.opacity || 0.85 });
            state.mapEngine.fitBounds(mapData.bounds);
        }
    }

    // Close modal
    const modalProjects = document.getElementById('modal-projects');
    if (modalProjects) modalProjects.classList.add('hidden');

    showToast(`📁 Proyecto activo: ${proj.name}`);
}

async function loadPlacemarksForProject(projectId = null) {
    const targetProjId = projectId || state.currentProjectId;
    
    // Clear existing map markers and vision cones
    if (state.placemarkManager) {
        state.placemarkManager.clearAll();
    }

    const allPms = await getPlacemarks();
    // Filter placemarks that belong to this project (or no projectId for default)
    const projectPms = allPms.filter(pm => {
        if (!targetProjId || targetProjId === 'default_proj') {
            return !pm.projectId || pm.projectId === 'default_proj';
        }
        return pm.projectId === targetProjId;
    });

    if (state.placemarkManager) {
        state.placemarkManager.placemarks = projectPms;
        state.placemarkManager.renderAll();
    }

    await updatePlacemarksList();
}

async function updateProjectsList() {
    const listEl = document.getElementById('list-projects');
    if (!listEl) return;

    let projects = await getProjects();
    if (!projects || projects.length === 0) {
        const defProj = {
            id: 'default_proj',
            name: 'Proyecto General',
            description: 'Proyecto inicial de campo',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await saveProject(defProj);
        projects = [defProj];
    }

    const allPms = await getPlacemarks();

    listEl.innerHTML = projects.map(p => {
        const isActive = p.id === state.currentProjectId;
        const pmsCount = allPms.filter(pm => {
            if (p.id === 'default_proj') return !pm.projectId || pm.projectId === 'default_proj';
            return pm.projectId === p.id;
        }).length;

        const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleDateString('es-CO') : '';

        return `
            <li class="list-item" style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: ${isActive ? 'rgba(46, 204, 113, 0.12)' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-color)'}; border-radius: 8px; margin-bottom: 8px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <strong style="color: ${isActive ? 'var(--accent-primary)' : '#fff'}; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            📁 ${p.name}
                        </strong>
                        ${isActive ? '<span style="background: var(--accent-primary); color: #111; font-size: 9px; font-weight: bold; padding: 1px 5px; border-radius: 10px;">ACTIVO</span>' : ''}
                    </div>
                    ${p.description ? `<p style="font-size: 11px; color: var(--text-secondary); margin: 2px 0 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.description}</p>` : ''}
                    <div style="font-size: 10px; color: #888; margin-top: 4px;">
                        📍 ${pmsCount} punto(s) · 📅 ${dateStr}
                    </div>
                </div>
                <div style="display: flex; gap: 6px; align-items: center; margin-left: 8px;">
                    ${!isActive ? `<button type="button" class="btn-activate-project btn-secondary" data-id="${p.id}" style="font-size: 10px; padding: 4px 8px;">Activar</button>` : ''}
                    <button type="button" class="btn-export-project-kmz btn-outline" data-id="${p.id}" title="Exportar este proyecto a KMZ" style="font-size: 10px; padding: 4px 6px;">KMZ</button>
                    ${!isActive && projects.length > 1 ? `<button type="button" class="btn-delete-project" data-id="${p.id}" title="Eliminar proyecto" style="background: none; border: none; color: #e74c3c; font-size: 14px; cursor: pointer; padding: 2px;">🗑️</button>` : ''}
                </div>
            </li>
        `;
    }).join('');

    // Wire buttons
    listEl.querySelectorAll('.btn-activate-project').forEach(btn => {
        btn.addEventListener('click', async () => {
            await switchProject(btn.dataset.id);
            await updateProjectsList();
        });
    });

    listEl.querySelectorAll('.btn-export-project-kmz').forEach(btn => {
        btn.addEventListener('click', async () => {
            const pId = btn.dataset.id;
            const targetProj = projects.find(p => p.id === pId);
            const pms = allPms.filter(pm => {
                if (pId === 'default_proj') return !pm.projectId || pm.projectId === 'default_proj';
                return pm.projectId === pId;
            });

            if (pms.length === 0) {
                showToast(`⚠️ "${targetProj?.name}" no tiene marcadores aún`);
                return;
            }

            showToast(`📦 Exportando proyecto "${targetProj?.name}" a KMZ...`);
            const safeName = (targetProj?.name || 'Proyecto').replace(/[^a-zA-Z0-9_-]/g, '_');
            await exportPlacemarksToKMZ(pms, `${safeName}_MAGNA.kmz`);
            showToast('✅ KMZ exportado con éxito');
        });
    });

    listEl.querySelectorAll('.btn-delete-project').forEach(btn => {
        btn.addEventListener('click', async () => {
            const pId = btn.dataset.id;
            const targetProj = projects.find(p => p.id === pId);
            if (confirm(`¿Estás seguro de eliminar el proyecto "${targetProj?.name}" y desasociar sus datos?`)) {
                await deleteProject(pId);
                await updateProjectsList();
                showToast(`Proyecto "${targetProj?.name}" eliminado`);
            }
        });
    });
}
