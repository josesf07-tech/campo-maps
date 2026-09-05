/**
 * Planos: calibración y lista de mapas.
 *
 * Cablea el modal de calibración (carga de PDF/imagen, detección de GeoPDF,
 * puntos de control en MAGNA-SIRGAS o WGS84, encaje sobre el GPS) y mantiene la
 * lista del panel de mapas, con la capa base activa, la opacidad y el borrado.
 */

import { state } from './state.js';
import { ICONS, escapeHtml, showLoading, hideLoading, showToast } from './ui-utils.js';
import { closeAllPanels } from './ui-panels.js';
import { toMagnaSirgas, fromMagnaSirgas } from './coords.js';
import { saveMap, getMaps, deleteMap, getSetting, generateUUID } from './storage.js';

// ========== CALIBRATION ==========
export function setupCalibration() {
    const fileInput = document.getElementById('map-image-upload');
    const preview = document.getElementById('calibration-preview');
    const btnFinish = document.getElementById('btn-finish-calibration');
    const calPoints = document.getElementById('calibration-points');

    const pdfStatus = document.getElementById('pdf-status');
    const geopdfCard = document.getElementById('geopdf-detected-card');
    const geopdfInfo = document.getElementById('geopdf-info');
    const btnLoadGeoPdfDirect = document.getElementById('btn-load-geopdf-direct');

    let controlPoints = [];
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
                    const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
                    showLoading(isPdf ? 'Procesando plano PDF (puede tardar unos segundos)...' : 'Procesando imagen...');
                    if (pdfStatus) {
                        pdfStatus.classList.remove('hidden');
                        pdfStatus.textContent = isPdf ? 'Procesando plano PDF georreferenciado...' : 'Procesando imagen...';
                    }

                    const result = await state.calibrator.loadFile(file);
                    currentLoadedResult = result;
                    hideLoading();

                    if (preview) {
                        preview.src = result.url;
                        preview.classList.remove('hidden');
                        const cont = document.getElementById('calibration-preview-container');
                        if (cont) cont.classList.remove('empty');
                    }

                    if (result.hasGeoReference && result.bounds) {
                        if (geopdfCard) geopdfCard.classList.remove('hidden');
                        if (geopdfInfo) {
                            const b = result.bounds;
                            const magnaSW = toMagnaSirgas(b[0][0], b[0][1]);
                            const magnaNE = toMagnaSirgas(b[1][0], b[1][1]);
                            geopdfInfo.innerHTML = `
                                <div><strong>Formato:</strong> ${escapeHtml(result.geoMetadata?.format || 'GeoPDF')}</div>
                                <div class="mt-8"><strong>MAGNA-SIRGAS Origen Nacional</strong></div>
                                <div class="mono text-accent">SO: ${magnaSW.formatted}</div>
                                <div class="mono text-accent">NE: ${magnaNE.formatted}</div>
                                <div class="mt-8">El plano ya tiene georreferenciación oficial. Puedes cargarlo con un toque.</div>
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
                    hideLoading();
                    console.error("Error al cargar mapa:", err);
                    showToast('❌ Error al cargar archivo: ' + err.message);
                    if (pdfStatus) {
                        pdfStatus.textContent = '❌ Error al procesar archivo: ' + err.message;
                    }
                }
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
                showLoading('Cargando plano en el visor...');
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
                hideLoading();

                const modal = document.getElementById('modal-calibrate');
                if (modal) modal.classList.add('hidden');

                showToast('🗺️ Plano GeoPDF cargado y guardado');

                state.lastLoadedGeoPdfBounds = currentLoadedResult.bounds;
                state.lastLoadedGeoPdfName = imageFile ? imageFile.name : 'Mapa GeoPDF';
                if (state.tileDownloader) {
                    state.tileDownloader.activeGeoPdfBounds = currentLoadedResult.bounds;
                    state.tileDownloader.activeGeoPdfName = state.lastLoadedGeoPdfName;
                }

                // Descarga (o pregunta) del buffer satelital de 2 km
                setTimeout(() => maybeDownloadGeoPdfBuffer(currentLoadedResult.bounds, state.lastLoadedGeoPdfName), 600);
            } catch (err) {
                hideLoading();
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
            btnModeGeo.classList.remove('active');
            inputsMagna?.classList.remove('hidden');
            inputsGeo?.classList.add('hidden');
        });

        btnModeGeo.addEventListener('click', () => {
            btnModeGeo.classList.add('active');
            btnModeMagna.classList.remove('active');
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
            // Nota: <img src=""> devuelve la URL del documento, por eso se valida el resultado cargado
            if (!currentLoadedResult || !currentLoadedResult.url) {
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
            state.mapEngine.addImageOverlay(mapId, currentLoadedResult.url, bounds);
            state.mapEngine.fitBounds(bounds);

            await saveMap({
                id: mapId,
                name: (imageFile ? imageFile.name : 'Plano') + ' (Ubicación GPS)',
                imageData: currentLoadedResult.url,
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
            if (!currentLoadedResult || !currentLoadedResult.url) {
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
                img.src = currentLoadedResult.url;
                await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('No se pudo leer la imagen del plano')); });

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
                state.mapEngine.addImageOverlay(mapId, currentLoadedResult.url, bounds);
                state.mapEngine.fitBounds(bounds);

                await saveMap({
                    id: mapId,
                    name: imageFile ? imageFile.name : 'Mapa calibrado',
                    imageData: currentLoadedResult.url,
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

                state.lastLoadedGeoPdfBounds = bounds;
                state.lastLoadedGeoPdfName = imageFile ? imageFile.name : 'Plano Calibrado';
                if (state.tileDownloader) {
                    state.tileDownloader.activeGeoPdfBounds = bounds;
                    state.tileDownloader.activeGeoPdfName = state.lastLoadedGeoPdfName;
                }

                // Descarga (o pregunta) del buffer satelital de 2 km
                setTimeout(() => maybeDownloadGeoPdfBuffer(bounds, state.lastLoadedGeoPdfName), 600);
            } catch (e) {
                console.error('Calibration error:', e);
                showToast('❌ Error al calibrar: ' + e.message);
            }
        });
    }
}

/** Descarga el buffer de 2 km sin preguntar si el ajuste está activo; si no, pregunta. */
export async function maybeDownloadGeoPdfBuffer(bounds, name) {
    if (!state.tileDownloader || !bounds) return;
    let auto = false;
    try {
        const saved = await getSetting('autoDownloadSatelliteBuffer');
        auto = !!(saved && saved.value);
    } catch (e) {}
    state.tileDownloader.promptAndDownloadGeoPdfBuffer(bounds, name, { auto });
}

export async function updateMapsList() {
    const list = document.getElementById('list-maps');
    if (!list) return;

    const maps = await getMaps();
    const baseDef = state.mapEngine ? state.mapEngine.getBaseLayerDef() : null;

    // Capa base activa (se cambia con el botón de capas del mapa)
    let html = `
    <li class="list-item static" id="base-layer-item">
        <div class="item-icon">${ICONS.globe}</div>
        <div class="item-details">
            <h3 class="item-title">${escapeHtml(baseDef ? baseDef.label : 'Mapa base')}</h3>
            <p class="item-meta">${escapeHtml(baseDef ? baseDef.description : 'Online')} · toca el botón de capas para cambiar</p>
        </div>
        <span class="badge badge-accent">Base</span>
    </li>`;

    maps.forEach(m => {
        const opacity = Math.round(((m.opacity !== undefined ? m.opacity : 1) * 100));
        const dateStr = m.createdAt ? new Date(m.createdAt).toLocaleDateString('es-CO') : '';
        html += `
        <li class="list-item map-list-item" data-id="${m.id}">
            <div class="item-icon">${ICONS.map}</div>
            <div class="item-details">
                <div class="row-between">
                    <h3 class="item-title">${escapeHtml(m.name || 'Plano')}</h3>
                    <span class="badge ${m.isGeoPdf ? 'badge-accent' : 'badge-sky'}">${m.isGeoPdf ? 'GeoPDF' : 'Calibrado'}</span>
                </div>
                <p class="item-meta">${dateStr}</p>
                <div class="opacity-row" data-stop>
                    <span>Opacidad</span>
                    <input type="range" min="10" max="100" value="${opacity}" class="map-opacity-slider" data-id="${m.id}" aria-label="Opacidad del plano">
                    <span class="opacity-val" id="op-val-${m.id}">${opacity}%</span>
                </div>
            </div>
            <button class="btn-icon btn-delete-map" data-id="${m.id}" aria-label="Eliminar plano">${ICONS.trash}</button>
        </li>`;
    });

    list.innerHTML = html;
    list.querySelectorAll('[data-stop]').forEach(el => el.addEventListener('click', (e) => e.stopPropagation()));

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

    // Opacity sliders (se guarda al soltar)
    list.querySelectorAll('.map-opacity-slider').forEach(slider => {
        slider.addEventListener('input', (e) => {
            e.stopPropagation();
            const id = slider.dataset.id;
            const val = parseInt(slider.value, 10);
            const label = document.getElementById(`op-val-${id}`);
            if (label) label.textContent = `${val}%`;
            state.mapEngine.setOverlayOpacity(id, val / 100);
        });
        slider.addEventListener('change', async () => {
            const id = slider.dataset.id;
            const target = maps.find(m => m.id === id);
            if (target) {
                target.opacity = parseInt(slider.value, 10) / 100;
                try { await saveMap(target); } catch (e) {}
            }
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
