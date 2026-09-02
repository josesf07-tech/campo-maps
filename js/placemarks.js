import { savePlacemark, getPlacemarks, deletePlacemark, generateUUID } from './storage.js';
import { toMagnaSirgas } from './coords.js';
import { GPSTracker } from './gps-tracker.js';

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
        
        this.placemarks.forEach(p => this.renderPlacemark(p));
    }
    
    renderPlacemark(data) {
        if (!this.mapEngine || !this.mapEngine.map) return;
        
        const iconMap = { default: '📍', tree: '🌳', water: '💧', warning: '⚠️', camera: '📷' };
        const iconEmoji = iconMap[data.icon] || '📍';
        
        const iconHtml = `
            <div style="
                background: ${data.color || '#2ecc71'};
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
        let popupContent = `
            <div style="min-width: 170px; max-width: 250px; font-family: sans-serif;">
                <h4 style="margin: 0 0 6px 0; color: #1a1a2e; font-size: 14px;">${data.name}</h4>
                ${data.description ? `<p style="margin: 0 0 8px 0; font-size: 12px; color: #555;">${data.description}</p>` : ''}
                <div style="background: #eaf2f8; padding: 6px; border-radius: 4px; margin-bottom: 6px; font-size: 11px; color: #1a5276; border-left: 3px solid #2980b9;">
                    <strong>MAGNA Origen Nal:</strong><br/>
                    ${magna.formatted}
                </div>
                <div style="font-size: 10px; color: #888; margin-bottom: 4px;">WGS84: ${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}</div>
        `;
        
        if (data.photos && data.photos.length > 0) {
            if (data.photos.length === 1) {
                popupContent += `
                    <div style="margin-top: 8px;">
                        <img src="${data.photos[0]}" alt="${data.name}" style="width: 100%; max-height: 150px; object-fit: cover; border-radius: 6px; cursor: pointer; border: 1px solid #ddd;" onclick="window.open('${data.photos[0]}', '_blank')">
                        <div style="font-size: 10px; color: #999; text-align: right; margin-top: 2px;">Toca para ampliar</div>
                    </div>
                `;
            } else {
                popupContent += `
                    <div style="margin-top: 8px;">
                        <div style="font-size: 11px; font-weight: bold; color: #16a085; margin-bottom: 4px;">
                            📷 ${data.photos.length} Fotos de campo:
                        </div>
                        <div style="display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch;">
                            ${data.photos.map((photo, idx) => {
                                const pUrl = typeof photo === 'string' ? photo : (photo.url || photo.dataUrl);
                                const pLabel = (typeof photo === 'object' && (photo.headingLabel || photo.heading !== undefined && photo.heading !== null))
                                    ? (photo.headingLabel || `${Math.round(photo.heading)}° ${GPSTracker.headingToCardinal(photo.heading)}`)
                                    : `#${idx+1}`;
                                return `
                                <div style="flex: 0 0 82px; height: 80px; border-radius: 6px; overflow: hidden; border: 1px solid #ccc; position: relative;">
                                    <img src="${pUrl}" alt="Foto ${idx+1}" style="width: 100%; height: 100%; object-fit: cover; cursor: pointer;" onclick="window.open('${pUrl}', '_blank')">
                                    <span style="position: absolute; bottom: 2px; right: 2px; background: rgba(0,0,0,0.72); color: white; font-size: 9px; padding: 1px 4px; border-radius: 3px; max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">🧭 ${pLabel}</span>
                                </div>
                                `;
                            }).join('')}
                        </div>
                        <div style="font-size: 9px; color: #888; text-align: right; margin-top: 2px;">Toca para ampliar cualquier foto</div>
                    </div>
                `;
            }
        }
        
        popupContent += `</div>`;
        
        marker.bindPopup(popupContent);
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
                        color: '#27ae60',
                        weight: 1.5,
                        fillColor: '#2ecc71',
                        fillOpacity: 0.32
                    }).addTo(this.mapEngine.map);

                    // Directional ray line
                    const tip = getDestinationPoint(data.lat, data.lng, 35, heading);
                    const ray = L.polyline([[data.lat, data.lng], tip], {
                        color: '#ffffff',
                        weight: 1.5,
                        dashArray: '3, 4'
                    }).addTo(this.mapEngine.map);

                    cone.bindTooltip(`📷 Foto #${idx+1} (${pLabel || Math.round(heading) + '°'})<br/><small style="color:#2ecc71;">Toca para ampliar foto</small>`, { sticky: true });
                    cone.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        if (pUrl) window.open(pUrl, '_blank');
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
            id: generateUUID(),
            name: data.name || "Nuevo Marcador",
            description: data.description || "",
            lat: latlng.lat,
            lng: latlng.lng,
            altitude: data.altitude || null,
            icon: data.icon || 'pin',
            color: data.color || '#3388ff',
            photos: data.photos || [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            mapId: data.mapId || null // If linked to a specific map
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
                            const projName = stampOptions.projectName || 'CampoMaps';

                            const fontSize = Math.max(13, Math.round(w * 0.021));
                            const lineHeight = Math.round(fontSize * 1.35);
                            const bannerHeight = (lineHeight * 3) + Math.round(fontSize * 1.2);

                            // Dark translucent background banner
                            ctx.fillStyle = 'rgba(10, 20, 32, 0.78)';
                            ctx.fillRect(0, h - bannerHeight, w, bannerHeight);

                            // Accent left vertical bar
                            ctx.fillStyle = '#2ecc71';
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

                            ctx.fillStyle = '#2ecc71';
                            ctx.fillText('PROYECTO: ', padX, startY);
                            const pW = ctx.measureText('PROYECTO: ').width;
                            ctx.fillStyle = '#ffffff';
                            ctx.fillText(`${projName}   |   📅 ${dateStr}${headingStr}`, padX + pW, startY);

                            // Line 2: MAGNA-SIRGAS Origen Nacional
                            ctx.fillStyle = '#58d68d';
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
