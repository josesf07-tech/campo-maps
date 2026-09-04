import { savePlacemark, getPlacemarks, deletePlacemark, generateUUID } from './storage.js';
import { toMagnaSirgas } from './coords.js';
import { GPSTracker } from './gps-tracker.js';

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Abre una foto en el visor de la app (window.open con data: URL está bloqueado en Chrome) */
function openPhoto(url, caption) {
    if (window.__campoMapsOpenPhoto) {
        window.__campoMapsOpenPhoto(url, caption);
    } else {
        try { window.open(url, '_blank'); } catch (e) {}
    }
}

function getDestinationPoint(lat, lng, distanceMeters, bearingDegrees) {
    const R = 6371000;
    const d = distanceMeters / R;
    const brng = bearingDegrees * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lng * Math.PI / 180;

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

    return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
}

function buildVisionConeCoords(lat, lng, headingDeg, distanceMeters = 32, apertureDeg = 40) {
    const coords = [[lat, lng]];
    const half = apertureDeg / 2;
    const step = 5;
    for (let a = -half; a <= half; a += step) {
        coords.push(getDestinationPoint(lat, lng, distanceMeters, (headingDeg + a + 360) % 360));
    }
    coords.push([lat, lng]);
    return coords;
}

export class PlacemarkManager {
    constructor(mapEngine) {
        this.mapEngine = mapEngine;
        this.placemarks = [];
        this.markers = new Map(); // id -> Leaflet Marker
        this.coneLayers = new Map(); // id -> array of Leaflet layers (cones & rays)

        this.icons = [
            'pin', 'flag', 'camp', 'water', 'danger', 'house',
            'tree', 'mountain', 'car', 'star', 'heart', 'info',
            'photo', 'food', 'parking', 'medical'
        ];
    }

    async loadPlacemarks() {
        try {
            this.placemarks = await getPlacemarks();
            this.renderAll();
        } catch (e) {
            console.error("Error cargando marcadores:", e);
        }
    }

    renderAll() {
        this.markers.forEach(marker => this.mapEngine.map.removeLayer(marker));
        this.markers.clear();
        this.coneLayers.forEach(group => group.forEach(layer => this.mapEngine?.map?.removeLayer(layer)));
        this.coneLayers.clear();

        this.placemarks.forEach(p => this.renderPlacemark(p));
    }

    renderPlacemark(data) {
        if (!this.mapEngine || !this.mapEngine.map) return;

        const iconMap = { default: '📍', tree: '🌳', water: '💧', warning: '⚠️', camera: '📷' };
        const iconEmoji = iconMap[data.icon] || '📍';

        const iconHtml = `
            <div style="
                background: ${data.color || '#10b981'};
                width: 32px;
                height: 32px;
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                display: flex;
                align-items: center;
                justify-content: center;
                border: 2px solid white;
                box-shadow: 0 3px 8px rgba(0,0,0,0.4);
            ">
                <span style="transform: rotate(45deg); font-size: 16px;">${iconEmoji}</span>
            </div>
        `;

        const L = window.L;
        if(!L) return;

        const customIcon = L.divIcon({
            html: iconHtml,
            className: 'custom-placemark',
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32]
        });

        const marker = L.marker([data.lat, data.lng], { icon: customIcon })
            .addTo(this.mapEngine.map);

        const magna = toMagnaSirgas(data.lat, data.lng);
        const safeName = escapeHtml(data.name);
        let popupContent = `
            <div class="pm-popup">
                <h4>${safeName}</h4>
                ${data.description ? `<div class="pm-popup-desc">${escapeHtml(data.description)}</div>` : ''}
                <div class="pm-popup-coords">${magna.formatted}</div>
                <div class="pm-popup-wgs">WGS84: ${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}</div>
        `;

        const photos = Array.isArray(data.photos) ? data.photos : [];
        if (photos.length > 0) {
            const items = photos.map((photo, idx) => {
                const pUrl = typeof photo === 'string' ? photo : (photo.url || photo.dataUrl);
                const hasHeading = typeof photo === 'object' && photo.heading !== undefined && photo.heading !== null && !isNaN(photo.heading);
                const pLabel = (typeof photo === 'object' && photo.headingLabel)
                    ? photo.headingLabel
                    : (hasHeading ? `${Math.round(photo.heading)}° ${GPSTracker.headingToCardinal(photo.heading)}` : `#${idx + 1}`);
                const single = photos.length === 1 ? ' single' : '';
                return `
                    <div class="pm-popup-photo${single}" data-idx="${idx}">
                        <img src="${escapeHtml(pUrl)}" alt="Foto ${idx + 1}">
                        <span class="pm-popup-heading">🧭 ${escapeHtml(pLabel)}</span>
                    </div>`;
            }).join('');

            popupContent += `
                <div class="pm-popup-photos">
                    <div class="pm-popup-photos-label">📷 ${photos.length} foto${photos.length > 1 ? 's' : ''} de campo</div>
                    <div class="pm-popup-strip">${items}</div>
                    <div class="pm-popup-hint">Toca una foto para ampliarla</div>
                </div>`;
        }

        popupContent += `</div>`;

        marker.bindPopup(popupContent, { maxWidth: 280 });
        marker.on('popupopen', (ev) => {
            const el = ev.popup && ev.popup.getElement ? ev.popup.getElement() : null;
            if (!el) return;
            el.querySelectorAll('.pm-popup-photo').forEach(node => {
                node.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const idx = parseInt(node.dataset.idx, 10);
                    const photo = photos[idx];
                    const pUrl = typeof photo === 'string' ? photo : (photo.url || photo.dataUrl);
                    const label = (typeof photo === 'object' && photo.headingLabel) ? ` · 🧭 ${photo.headingLabel}` : '';
                    openPhoto(pUrl, `${data.name || 'Foto'} · Foto ${idx + 1}${label}`);
                });
            });
        });
        this.markers.set(data.id, marker);

        // Render photo vision cones
        this.removeCones(data.id);
        const placemarkCones = [];

        if (data.photos && data.photos.length > 0 && this.mapEngine?.map) {
            const L = window.L;
            data.photos.forEach((photo, idx) => {
                const heading = typeof photo === 'object' ? photo.heading : null;
                const pUrl = typeof photo === 'string' ? photo : (photo.url || photo.dataUrl);
                const pLabel = typeof photo === 'object' && photo.headingLabel
                    ? photo.headingLabel
                    : (heading !== null && heading !== undefined ? `${Math.round(heading)}° ${GPSTracker.headingToCardinal(heading)}` : null);

                if (heading !== null && heading !== undefined && !isNaN(heading)) {
                    // Vision cone polygon (40° aperture, 32m distance)
                    const coneCoords = buildVisionConeCoords(data.lat, data.lng, heading, 32, 40);
                    const cone = L.polygon(coneCoords, {
                        color: '#059669',
                        weight: 1.5,
                        fillColor: '#10b981',
                        fillOpacity: 0.3
                    }).addTo(this.mapEngine.map);

                    // Directional ray line
                    const tip = getDestinationPoint(data.lat, data.lng, 35, heading);
                    const ray = L.polyline([[data.lat, data.lng], tip], {
                        color: '#ffffff',
                        weight: 1.5,
                        dashArray: '3, 4'
                    }).addTo(this.mapEngine.map);

                    cone.bindTooltip(`📷 Foto #${idx+1} (${escapeHtml(pLabel || Math.round(heading) + '°')})<br/><small>Toca para ampliar</small>`, { sticky: true });
                    cone.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        if (pUrl) openPhoto(pUrl, `${data.name || 'Foto'} · Foto ${idx + 1} · 🧭 ${pLabel || Math.round(heading) + '°'}`);
                    });

                    placemarkCones.push(cone, ray);
                }
            });
        }

        if (placemarkCones.length > 0) {
            this.coneLayers.set(data.id, placemarkCones);
        }
    }

    removeCones(id) {
        const cones = this.coneLayers.get(id);
        if (cones && this.mapEngine?.map) {
            cones.forEach(layer => this.mapEngine.map.removeLayer(layer));
            this.coneLayers.delete(id);
        }
    }

    clearAll() {
        this.markers.forEach(m => this.mapEngine?.map?.removeLayer(m));
        this.markers.clear();
        this.coneLayers.forEach(coneGroup => {
            coneGroup.forEach(layer => this.mapEngine?.map?.removeLayer(layer));
        });
        this.coneLayers.clear();
        this.placemarks = [];
    }

    async addPlacemark(latlng, data) {
        const placemark = {
            ...data,
            id: generateUUID(),
            name: data.name || "Nuevo Marcador",
            description: data.description || "",
            lat: latlng.lat,
            lng: latlng.lng,
            altitude: data.altitude || null,
            icon: data.icon || 'default',
            color: data.color || '#10b981',
            photos: data.photos || [],
            censoAgua: data.censoAgua || null,
            projectId: data.projectId || 'default_proj',
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: Date.now(),
            mapId: data.mapId || null
        };

        try {
            await savePlacemark(placemark);
            this.placemarks.push(placemark);
            this.renderPlacemark(placemark);
            return placemark;
        } catch (e) {
            console.error("Error guardando marcador:", e);
            throw e;
        }
    }

    async editPlacemark(id, data) {
        const index = this.placemarks.findIndex(p => p.id === id);
        if (index === -1) throw new Error("Marcador no encontrado");

        const updated = { ...this.placemarks[index], ...data, updatedAt: Date.now() };

        try {
            await savePlacemark(updated);
            this.placemarks[index] = updated;

            // Re-render
            const marker = this.markers.get(id);
            if (marker) {
                this.mapEngine.map.removeLayer(marker);
                this.markers.delete(id);
            }
            this.removeCones(id);
            this.renderPlacemark(updated);

            return updated;
        } catch (e) {
            console.error("Error actualizando marcador:", e);
            throw e;
        }
    }

    async deletePlacemark(id) {
        try {
            await deletePlacemark(id);
            this.placemarks = this.placemarks.filter(p => p.id !== id);

            const marker = this.markers.get(id);
            if (marker) {
                this.mapEngine.map.removeLayer(marker);
                this.markers.delete(id);
            }
            this.removeCones(id);
        } catch (e) {
            console.error("Error eliminando marcador:", e);
            throw e;
        }
    }

    getPlacemark(id) {
        return this.placemarks.find(p => p.id === id);
    }

    // Helper to read, compress and optionally stamp technical metadata onto photo
    static async readPhoto(file, stampOptions = null) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const maxDim = 1280;
                    let w = img.width;
                    let h = img.height;
                    if (w > maxDim || h > maxDim) {
                        if (w > h) {
                            h = Math.round((h * maxDim) / w);
                            w = maxDim;
                        } else {
                            w = Math.round((w * maxDim) / h);
                            h = maxDim;
                        }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);

                    // If technical stamping is requested, overlay metadata banner
                    if (stampOptions && stampOptions.enabled && stampOptions.lat && stampOptions.lng) {
                        try {
                            const magna = toMagnaSirgas(stampOptions.lat, stampOptions.lng);
                            const dateStr = (stampOptions.timestamp || new Date()).toLocaleString('es-CO');
                            const projName = stampOptions.projectName || 'JoseMaps';

                            const fontSize = Math.max(13, Math.round(w * 0.021));
                            const lineHeight = Math.round(fontSize * 1.35);
                            const bannerHeight = (lineHeight * 3) + Math.round(fontSize * 1.2);

                            // Dark translucent background banner
                            ctx.fillStyle = 'rgba(10, 20, 32, 0.78)';
                            ctx.fillRect(0, h - bannerHeight, w, bannerHeight);

                            // Accent left vertical bar
                            ctx.fillStyle = '#10b981';
                            ctx.fillRect(0, h - bannerHeight, Math.max(6, Math.round(w * 0.007)), bannerHeight);

                            // Top subtle divider line
                            ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
                            ctx.fillRect(0, h - bannerHeight, w, 1);

                            // Text styling
                            ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                            ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
                            ctx.shadowBlur = 3;
                            ctx.shadowOffsetX = 1;
                            ctx.shadowOffsetY = 1;

                            const padX = Math.round(fontSize * 1.3);
                            const startY = h - bannerHeight + Math.round(fontSize * 1.15);

                            // Line 1: Proyecto, Fecha y Sentido
                            let headingStr = '';
                            if (stampOptions.headingLabel) {
                                headingStr = `   |   🧭 ${stampOptions.headingLabel}`;
                            } else if (stampOptions.heading !== null && stampOptions.heading !== undefined && !isNaN(stampOptions.heading)) {
                                const card = GPSTracker.headingToCardinal(stampOptions.heading);
                                headingStr = `   |   🧭 ${Math.round(stampOptions.heading).toString().padStart(3, '0')}° ${card}`;
                            }

                            ctx.fillStyle = '#34d399';
                            ctx.fillText('PROYECTO: ', padX, startY);
                            const pW = ctx.measureText('PROYECTO: ').width;
                            ctx.fillStyle = '#ffffff';
                            ctx.fillText(`${projName}   |   📅 ${dateStr}${headingStr}`, padX + pW, startY);

                            // Line 2: MAGNA-SIRGAS Origen Nacional
                            ctx.fillStyle = '#34d399';
                            ctx.fillText('MAGNA Origen Nal. (EPSG:9377): ', padX, startY + lineHeight);
                            const mW = ctx.measureText('MAGNA Origen Nal. (EPSG:9377): ').width;
                            ctx.fillStyle = '#ffffff';
                            ctx.fillText(`${magna.formatted}`, padX + mW, startY + lineHeight);

                            // Line 3: WGS84, Altitud, Precisión
                            ctx.fillStyle = '#bdc3c7';
                            let l3 = `WGS84: ${stampOptions.lat.toFixed(6)}°, ${stampOptions.lng.toFixed(6)}°`;
                            if (stampOptions.altitude !== null && stampOptions.altitude !== undefined) {
                                l3 += `   |   ⛰️ Alt: ${Math.round(stampOptions.altitude)}m`;
                            }
                            if (stampOptions.accuracy !== null && stampOptions.accuracy !== undefined) {
                                l3 += `   |   🎯 Prec: ±${Math.round(stampOptions.accuracy)}m`;
                            }
                            ctx.fillText(l3, padX, startY + (lineHeight * 2));
                        } catch (stampErr) {
                            console.warn('Error al estampar metadatos en foto:', stampErr);
                        }
                    }

                    const compressed = canvas.toDataURL('image/jpeg', 0.82);
                    resolve(compressed);
                };
                img.onerror = () => resolve(e.target.result);
                img.src = e.target.result;
            };
            reader.onerror = (e) => reject(e);
            reader.readAsDataURL(file);
        });
    }
}
