/**
 * CampoMaps - Herramienta de Medición (Distancia, Azimut y Áreas en Hectáreas)
 */

export class MeasurementTool {
    constructor(mapEngine) {
        this.mapEngine = mapEngine;
        this.active = false;
        this.mode = 'distance'; // 'distance' | 'area'
        this.points = [];
        
        // Leaflet layer elements
        this.markers = [];
        this.line = null;
        this.polygon = null;
        
        this.uiContainer = null;
        this.mapClickHandler = this.onMapClick.bind(this);
    }

    initUI() {
        if (this.uiContainer) return;

        const div = document.createElement('div');
        div.id = 'measurement-toolbar';
        div.className = 'measure-toolbar hidden';

        div.innerHTML = `
            <div class="row-between">
                <div class="measure-modes">
                    <button type="button" id="btn-measure-dist" class="btn-secondary btn-sm active">📏 Distancia</button>
                    <button type="button" id="btn-measure-area" class="btn-secondary btn-sm">📐 Área</button>
                </div>
                <button type="button" id="btn-measure-close" class="icon-btn" aria-label="Cerrar medición">
                    <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            <div id="measure-result" class="measure-result">Toca puntos en el mapa para medir</div>
            <div class="measure-footer">
                <span id="measure-points-count">Puntos: 0</span>
                <button type="button" id="btn-measure-clear" class="btn-ghost btn-xs">Limpiar</button>
            </div>
        `;

        document.getElementById('app-container').appendChild(div);
        this.uiContainer = div;

        // Wire buttons
        const btnDist = div.querySelector('#btn-measure-dist');
        const btnArea = div.querySelector('#btn-measure-area');
        const btnClose = div.querySelector('#btn-measure-close');
        const btnClear = div.querySelector('#btn-measure-clear');

        btnDist.addEventListener('click', () => {
            this.setMode('distance');
            btnDist.classList.add('active');
            btnArea.classList.remove('active');
        });

        btnArea.addEventListener('click', () => {
            this.setMode('area');
            btnArea.classList.add('active');
            btnDist.classList.remove('active');
        });

        btnClose.addEventListener('click', () => this.stop());
        btnClear.addEventListener('click', () => this.clear());
    }

    start() {
        this.initUI();
        this.active = true;
        this.uiContainer.classList.remove('hidden');
        if (this.mapEngine?.map) {
            this.mapEngine.map.on('click', this.mapClickHandler);
        }
        this.updateResultDisplay();
    }

    stop() {
        this.active = false;
        if (this.uiContainer) {
            this.uiContainer.classList.add('hidden');
        }
        if (this.mapEngine?.map) {
            this.mapEngine.map.off('click', this.mapClickHandler);
        }
        this.clear();
    }

    toggle() {
        if (this.active) {
            this.stop();
        } else {
            this.start();
        }
    }

    setMode(mode) {
        this.mode = mode;
        this.redraw();
        this.updateResultDisplay();
    }

    onMapClick(e) {
        if (!this.active) return;
        this.addPoint(e.latlng);
    }

    addPoint(latlng) {
        this.points.push(latlng);
        this.redraw();
        this.updateResultDisplay();
    }

    clear() {
        const L = window.L;
        const map = this.mapEngine?.map;

        this.points = [];
        this.markers.forEach(m => map?.removeLayer(m));
        this.markers = [];

        if (this.line) {
            map?.removeLayer(this.line);
            this.line = null;
        }
        if (this.polygon) {
            map?.removeLayer(this.polygon);
            this.polygon = null;
        }

        this.updateResultDisplay();
    }

    redraw() {
        const L = window.L;
        const map = this.mapEngine?.map;
        if (!L || !map) return;

        // Clean previous layers
        this.markers.forEach(m => map.removeLayer(m));
        this.markers = [];
        if (this.line) map.removeLayer(this.line);
        if (this.polygon) map.removeLayer(this.polygon);

        // Draw points
        this.points.forEach((pt, idx) => {
            const marker = L.circleMarker([pt.lat, pt.lng], {
                radius: 6,
                fillColor: idx === 0 ? '#10b981' : (idx === this.points.length - 1 ? '#ef4444' : '#38bdf8'),
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.9
            }).addTo(map);
            this.markers.push(marker);
        });

        const latlngs = this.points.map(p => [p.lat, p.lng]);

        if (this.mode === 'distance' && latlngs.length >= 2) {
            this.line = L.polyline(latlngs, {
                color: '#34d399',
                weight: 3,
                dashArray: '6, 6'
            }).addTo(map);
        } else if (this.mode === 'area' && latlngs.length >= 3) {
            this.polygon = L.polygon(latlngs, {
                color: '#38bdf8',
                weight: 2.5,
                fillColor: '#38bdf8',
                fillOpacity: 0.22
            }).addTo(map);
        } else if (this.mode === 'area' && latlngs.length === 2) {
            this.line = L.polyline(latlngs, {
                color: '#38bdf8',
                weight: 2,
                dashArray: '4, 4'
            }).addTo(map);
        }
    }

    updateResultDisplay() {
        const resEl = this.uiContainer?.querySelector('#measure-result');
        const countEl = this.uiContainer?.querySelector('#measure-points-count');
        if (!resEl || !countEl) return;

        countEl.textContent = `Puntos marcados: ${this.points.length}`;

        if (this.points.length === 0) {
            resEl.innerHTML = `Toca el mapa para fijar el primer punto`;
            return;
        }

        if (this.mode === 'distance') {
            if (this.points.length === 1) {
                resEl.innerHTML = `Punto 1 fijado. Toca otro punto para medir distancia y rumbo.`;
                return;
            }

            let totalDist = 0;
            for (let i = 0; i < this.points.length - 1; i++) {
                totalDist += this.calculateDistance(this.points[i], this.points[i+1]);
            }

            // Calculate azimuth of the last segment (or first segment)
            const p1 = this.points[this.points.length - 2];
            const p2 = this.points[this.points.length - 1];
            const azimuth = this.calculateBearing(p1, p2);
            const quadrant = this.azimuthToQuadrant(azimuth);

            const distStr = totalDist >= 1000 
                ? `${(totalDist / 1000).toFixed(3)} km` 
                : `${totalDist.toFixed(1)} m`;

            resEl.innerHTML = `
                <div class="big">${distStr}</div>
                <div class="sub">🧭 Azimut: <strong>${azimuth.toFixed(1)}°</strong> (${quadrant})</div>
            `;
        } else {
            // Area mode
            if (this.points.length < 3) {
                resEl.innerHTML = `Marca al menos 3 vértices para calcular área en hectáreas (${this.points.length}/3)`;
                return;
            }

            const areaM2 = this.calculatePolygonArea(this.points);
            const hectares = areaM2 / 10000;
            
            // Perimeter
            let perimeter = 0;
            for (let i = 0; i < this.points.length; i++) {
                const next = (i + 1) % this.points.length;
                perimeter += this.calculateDistance(this.points[i], this.points[next]);
            }

            const perimStr = perimeter >= 1000 
                ? `${(perimeter / 1000).toFixed(2)} km` 
                : `${Math.round(perimeter)} m`;

            resEl.innerHTML = `
                <div class="big sky">${hectares.toFixed(4)} ha</div>
                <div class="sub">${Math.round(areaM2).toLocaleString('es-CO')} m² · Perímetro: <strong>${perimStr}</strong></div>
            `;
        }
    }

    // Haversine distance in meters
    calculateDistance(p1, p2) {
        const R = 6371000; // Radio terrestre en metros
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLng = (p2.lng - p1.lng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
                  Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    // Geodesic bearing / azimuth in degrees [0, 360)
    calculateBearing(p1, p2) {
        const lat1 = p1.lat * Math.PI / 180;
        const lat2 = p2.lat * Math.PI / 180;
        const dLng = (p2.lng - p1.lng) * Math.PI / 180;

        const y = Math.sin(dLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
                  Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

        let brng = Math.atan2(y, x) * 180 / Math.PI;
        return (brng + 360) % 360;
    }

    azimuthToQuadrant(deg) {
        const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const val = Math.round(deg / 22.5) % 16;
        return directions[val];
    }

    // Spherical polygon area on earth in m2
    calculatePolygonArea(points) {
        const R = 6378137; // Earth WGS84 radius
        if (points.length < 3) return 0;
        
        let total = 0;
        for (let i = 0; i < points.length; i++) {
            const p1 = points[i];
            const p2 = points[(i + 1) % points.length];
            const lat1 = p1.lat * Math.PI / 180;
            const lat2 = p2.lat * Math.PI / 180;
            const dLng = (p2.lng - p1.lng) * Math.PI / 180;
            total += dLng * (2 + Math.sin(lat1) + Math.sin(lat2));
        }
        return Math.abs(total * R * R / 2);
    }
}
