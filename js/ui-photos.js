/**
 * Fotos del marcador: ráfaga en vivo, cámara nativa y galería.
 *
 * Mantiene el conjunto de fotos adjuntas al marcador que se está creando
 * (`currentPhotos`), la rejilla de miniaturas con su sentido/orientación, la
 * cámara interna de ráfaga con estampado técnico (proyecto, fecha, rumbo y
 * coordenadas MAGNA-SIRGAS) y el procesado de las fotos elegidas del carrete.
 *
 * Expone al resto de la app los puentes globales `window.__campoMapsRenderPhotos`,
 * `__campoMapsClearPhotos` y `__campoMapsGetPhotos`, que existen porque hay HTML
 * generado con `innerHTML` que los necesita.
 */

import { state } from './state.js';
import { escapeHtml, openLightbox, showToast } from './ui-utils.js';
import { GPSTracker } from './gps-tracker.js';
import { PlacemarkManager } from './placemarks.js';
import { toMagnaSirgas } from './coords.js';

export function setupPhotos() {
    // Multi-photo capture with Camera (iPhone camera / native picker)
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
            if (btnText) btnText.textContent = 'Ráfaga en vivo';
            grid.innerHTML = '';
            return;
        }

        container.classList.remove('hidden');
        if (countLabel) countLabel.textContent = `Fotos adjuntas (${currentPhotos.length})`;
        if (btnText) btnText.textContent = `Ráfaga (${currentPhotos.length})`;

        grid.innerHTML = currentPhotos.map((photo, index) => {
            const pUrl = typeof photo === 'string' ? photo : (photo.url || photo.dataUrl);
            const pHeading = (typeof photo === 'object' && (photo.headingLabel || (photo.heading !== null && photo.heading !== undefined)))
                ? (photo.headingLabel || `${Math.round(photo.heading)}°`)
                : `#${index + 1}`;
            return `
            <div class="photo-thumb">
                <img src="${escapeHtml(pUrl)}" alt="Foto ${index + 1}" class="photo-open" data-index="${index}">
                <button type="button" class="btn-del-photo" data-index="${index}" title="Eliminar esta foto" aria-label="Eliminar foto">✕</button>
                <button type="button" class="btn-edit-heading" data-index="${index}" title="Cambiar el sentido de la foto">🧭 ${escapeHtml(pHeading)}</button>
            </div>
            `;
        }).join('');

        grid.querySelectorAll('.photo-open').forEach(img => {
            img.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(img.dataset.index, 10);
                const photo = currentPhotos[idx];
                const pUrl = typeof photo === 'string' ? photo : (photo.url || photo.dataUrl);
                const label = (typeof photo === 'object' && photo.headingLabel) ? ` · 🧭 ${photo.headingLabel}` : '';
                openLightbox(pUrl, `Foto ${idx + 1} de ${currentPhotos.length}${label}`);
            });
        });

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

    // In-App Continuous Burst Camera, Native Camera & Gallery Selector
    const btnOpenCamera = document.getElementById('btn-open-camera');
    const btnNativeCamera = document.getElementById('btn-native-camera');
    const btnPickGallery = document.getElementById('btn-pick-gallery');
    const photoNativeInput = document.getElementById('placemark-photo-native');
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
                        const fiable = !state.gps.isHeadingAbsolute || state.gps.isHeadingAbsolute();
                        cameraHeadingVal.textContent = `${Math.round(h).toString().padStart(3, '0')}° ${GPSTracker.headingToCardinal(h)}${fiable ? '' : ' (sin calibrar)'}`;
                    } else {
                        cameraHeadingVal.textContent = 'Sin brújula';
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
        try {
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
            const projectName = state.currentProjectName || 'JoseMaps';

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
                try {
                    const bannerH = Math.max(70, Math.round(videoH * 0.11));
                    const bannerY = videoH - bannerH;

                    // Draw dark background banner
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
                    ctx.fillRect(0, bannerY, videoW, bannerH);

                    // Accent border
                    ctx.fillStyle = '#34d399';
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
                    ctx.fillStyle = '#34d399';
                    const esteFormatted = (magna && magna.este !== undefined) ? Math.round(magna.este).toLocaleString('es-CO') : '--';
                    const norteFormatted = (magna && magna.norte !== undefined) ? Math.round(magna.norte).toLocaleString('es-CO') : '--';
                    const line2 = `MAGNA Origen Nal. (EPSG:9377): N: ${norteFormatted} m | E: ${esteFormatted} m`;
                    ctx.fillText(line2, 15, bannerY + bannerH * 0.58);

                    // Line 3: WGS84 + Precision
                    ctx.fillStyle = '#e0e0e0';
                    let line3 = `WGS84: ${targetLat.toFixed(6)}°, ${targetLng.toFixed(6)}°`;
                    if (targetAlt) line3 += ` | ⛰️ Alt: ${Math.round(targetAlt)}m`;
                    if (targetAcc) line3 += ` | 🎯 Prec: ±${Math.round(targetAcc)}m`;
                    ctx.fillText(line3, 15, bannerY + bannerH * 0.85);
                } catch (stampErr) {
                    console.warn("Error estampando datos en foto de ráfaga:", stampErr);
                }
            }

            const dataUrl = offscreenCanvas.toDataURL('image/jpeg', 0.85);
            currentPhotos.push({
                url: dataUrl,
                heading: currentHeading,
                headingLabel: defaultHeadingLabel
            });

            if (cameraCountNum) {
                cameraCountNum.textContent = currentPhotos.length;
            }
            renderPhotosGrid();
            showToast(`📸 Foto #${currentPhotos.length} capturada (${defaultHeadingLabel || 'orientada'})`);
        } catch (err) {
            console.error("Error al capturar frame de cámara:", err);
            showToast("⚠️ Error al capturar foto");
        }
    }

    if (btnOpenCamera) {
        btnOpenCamera.addEventListener('click', startInAppCamera);
    }
    if (btnShutter) {
        btnShutter.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            captureCameraFrame();
        });
    }
    // Tocar el visor de video también captura la foto
    if (cameraVideo) {
        cameraVideo.addEventListener('click', (e) => {
            e.preventDefault();
            captureCameraFrame();
        });
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

    // Botón para activar directamente la cámara nativa del teléfono (iOS / Android)
    if (btnNativeCamera && photoNativeInput) {
        btnNativeCamera.addEventListener('click', () => {
            photoNativeInput.click();
        });
    }

    // Botón para abrir galería y seleccionar fotos existentes
    if (btnPickGallery && photoInput) {
        btnPickGallery.addEventListener('click', () => {
            photoInput.click();
        });
    }

    // Procesador unificado para estampar coordenadas y metadatos en fotos subidas
    async function processPhotoFiles(files) {
        if (!files || files.length === 0) return;
        try {
            showToast(`Procesando ${files.length} foto(s)...`);

            const stampToggle = document.getElementById('pm-stamp-toggle');
            const isStampEnabled = stampToggle ? stampToggle.checked : true;
            const projectName = state.currentProjectName || 'JoseMaps';

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
                projectName: projectName || 'JoseMaps',
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
            console.error("Error al procesar fotos:", err);
            showToast("⚠️ Error al procesar fotos");
        }
    }

    if (photoInput) {
        photoInput.addEventListener('change', async (e) => {
            await processPhotoFiles(Array.from(e.target.files || []));
            photoInput.value = '';
        });
    }

    if (photoNativeInput) {
        photoNativeInput.addEventListener('change', async (e) => {
            await processPhotoFiles(Array.from(e.target.files || []));
            photoNativeInput.value = '';
        });
    }

    if (btnClearPhotos) {
        btnClearPhotos.addEventListener('click', () => {
            currentPhotos = [];
            if (photoInput) photoInput.value = '';
            if (photoNativeInput) photoNativeInput.value = '';
            renderPhotosGrid();
            showToast('Fotos removidas');
        });
    }

    // Make renderPhotosGrid accessible to modal open/close
    window.__campoMapsRenderPhotos = renderPhotosGrid;
    window.__campoMapsClearPhotos = () => {
        currentPhotos = [];
        if (photoInput) photoInput.value = '';
        if (photoNativeInput) photoNativeInput.value = '';
        renderPhotosGrid();
    };
    window.__campoMapsGetPhotos = () => [...currentPhotos];
}
