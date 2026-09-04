/**
 * CampoMaps - Motor de mapa (Leaflet).
 * Centraliza las capas base para que el visor y el descargador offline
 * usen EXACTAMENTE las mismas URLs de mosaicos (y por tanto la misma caché).
 */

export const BASE_LAYERS = {
    satellite: {
        label: 'Google Híbrido',
        description: 'Satélite + vías y nombres',
        url: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        subdomains: ['0', '1', '2', '3'],
        attribution: '© Google',
        maxZoom: 22,
        maxNativeZoom: 19
    },
    esri: {
        label: 'Esri World Imagery',
        description: 'Fotografía satelital pura',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        subdomains: [],
        attribution: '© Esri, Maxar, Earthstar Geographics',
        maxZoom: 20,
        maxNativeZoom: 18
    },
    osm: {
        label: 'OpenStreetMap',
        description: 'Mapa callejero',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c'],
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
        maxNativeZoom: 19
    },
    topo: {
        label: 'OpenTopoMap',
        description: 'Topográfico con curvas de nivel',
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c'],
        attribution: '© OpenTopoMap (CC-BY-SA)',
        maxZoom: 17,
        maxNativeZoom: 17
    }
};

export const BASE_LAYER_ORDER = ['satellite', 'esri', 'osm', 'topo'];

export class MapEngine {
    constructor(containerId) {
        this.containerId = containerId;
        this.map = null;
        this.gpsMarker = null;
        this.accuracyCircle = null;
        this.trackLines = new Map();
        this.imageOverlays = new Map();
        this.baseLayerType = 'satellite';
        this.currentBaseLayer = null;
        this.onBaseLayerChange = null;

        this._longPress = { timer: null, start: null };
    }

    init(defaultLat = 0, defaultLng = 0, defaultZoom = 2) {
        const L = window.L;
        if (!L) throw new Error('Leaflet no está cargado');

        this.map = L.map(this.containerId, {
            zoomControl: false,
            attributionControl: true,
            tap: false
        }).setView([defaultLat, defaultLng], defaultZoom);

        this.map.attributionControl.setPrefix('');
        this.map.attributionControl.setPosition('bottomleft');
        this.setBaseLayer('satellite');
    }

    /** Definición de la capa base activa */
    getBaseLayerDef(type = this.baseLayerType) {
        return BASE_LAYERS[type] || BASE_LAYERS.satellite;
    }

    getBaseLayerLabel(type = this.baseLayerType) {
        return this.getBaseLayerDef(type).label;
    }

    nextBaseLayerType() {
        const idx = BASE_LAYER_ORDER.indexOf(this.baseLayerType);
        return BASE_LAYER_ORDER[(idx + 1) % BASE_LAYER_ORDER.length];
    }

    setBaseLayer(type) {
        const L = window.L;
        if (!L || !this.map) return;
        const def = BASE_LAYERS[type] ? BASE_LAYERS[type] : BASE_LAYERS.satellite;
        type = BASE_LAYERS[type] ? type : 'satellite';

        if (this.currentBaseLayer) {
            this.map.removeLayer(this.currentBaseLayer);
        }
        this.baseLayerType = type;

        this.currentBaseLayer = L.tileLayer(def.url, {
            subdomains: def.subdomains && def.subdomains.length ? def.subdomains : 'abc',
            attribution: def.attribution,
            maxZoom: def.maxZoom,
            maxNativeZoom: def.maxNativeZoom,
            crossOrigin: false,
            keepBuffer: 4,
            updateWhenIdle: true
        }).addTo(this.map);

        if (this.currentBaseLayer.bringToBack) this.currentBaseLayer.bringToBack();
        if (this.onBaseLayerChange) {
            try { this.onBaseLayerChange(type, def); } catch (e) {}
        }
    }

    /**
     * Construye la URL de un mosaico igual que Leaflet (misma elección de subdominio),
     * para que las descargas offline coincidan con lo que pide el visor.
     */
    buildTileUrl(type, x, y, z) {
        const def = this.getBaseLayerDef(type);
        let s = '';
        if (def.subdomains && def.subdomains.length) {
            // Regla de Leaflet: índice = |x + y| mod número de subdominios
            s = def.subdomains[Math.abs(x + y) % def.subdomains.length];
        }
        return def.url
            .replace('{s}', s)
            .replace('{x}', x)
            .replace('{y}', y)
            .replace('{z}', z);
    }

    addImageOverlay(id, imageUrl, bounds, options = {}) {
        const L = window.L;
        if (this.imageOverlays.has(id)) this.removeImageOverlay(id);
        const overlay = L.imageOverlay(imageUrl, bounds, {
            opacity: options.opacity !== undefined ? options.opacity : 1.0,
            interactive: false
        }).addTo(this.map);
        this.imageOverlays.set(id, overlay);
        return overlay;
    }

    hasImageOverlay(id) {
        return this.imageOverlays.has(id);
    }

    removeImageOverlay(id) {
        const overlay = this.imageOverlays.get(id);
        if (overlay) {
            this.map.removeLayer(overlay);
            this.imageOverlays.delete(id);
        }
    }

    setOverlayOpacity(id, opacity) {
        const overlay = this.imageOverlays.get(id);
        if (overlay) overlay.setOpacity(opacity);
    }

    setView(lat, lng, zoom) {
        this.map.setView([lat, lng], zoom || this.map.getZoom());
    }

    getCenter() {
        return this.map.getCenter();
    }

    getZoom() {
        return this.map.getZoom();
    }

    fitBounds(bounds, options = {}) {
        this.map.fitBounds(bounds, Object.assign({ padding: [24, 24] }, options));
    }

    _gpsIconHtml() {
        return `
            <div class="gps-dot-wrap" style="position:relative;width:22px;height:22px;">
                <div class="gps-heading" style="position:absolute;left:50%;top:50%;width:0;height:0;
                    border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:16px solid rgba(66,133,244,0.9);
                    transform:translate(-50%,-100%) rotate(0deg);transform-origin:50% 100%;display:none;
                    filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));"></div>
                <div style="position:absolute;left:50%;top:50%;width:16px;height:16px;transform:translate(-50%,-50%);
                    background:#4285F4;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 2px rgba(66,133,244,0.35),0 1px 4px rgba(0,0,0,0.5);"></div>
            </div>`;
    }

    addGPSMarker(lat, lng, accuracy, heading = null) {
        const L = window.L;
        const radius = Math.max(0, Number(accuracy) || 0);

        if (!this.gpsMarker) {
            const gpsIcon = L.divIcon({
                html: this._gpsIconHtml(),
                className: 'gps-marker-icon',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });
            this.gpsMarker = L.marker([lat, lng], { icon: gpsIcon, zIndexOffset: 1000, interactive: false }).addTo(this.map);
            this.accuracyCircle = L.circle([lat, lng], {
                radius: radius,
                color: '#4285F4',
                fillColor: '#4285F4',
                fillOpacity: 0.12,
                weight: 1,
                interactive: false
            }).addTo(this.map);
        } else {
            this.gpsMarker.setLatLng([lat, lng]);
            this.accuracyCircle.setLatLng([lat, lng]);
            this.accuracyCircle.setRadius(radius);
        }

        if (heading !== null && heading !== undefined && !isNaN(heading)) {
            this.setGPSHeading(heading);
        }
    }

    /** Rota la flecha de rumbo sin recrear el icono (barato, apto para 4 Hz) */
    setGPSHeading(heading) {
        if (!this.gpsMarker) return;
        const el = this.gpsMarker.getElement && this.gpsMarker.getElement();
        if (!el) return;
        const arrow = el.querySelector('.gps-heading');
        if (!arrow) return;
        if (heading === null || heading === undefined || isNaN(heading)) {
            arrow.style.display = 'none';
            return;
        }
        arrow.style.display = 'block';
        arrow.style.transform = `translate(-50%,-100%) rotate(${Math.round(heading)}deg)`;
    }

    removeGPSMarker() {
        if (this.gpsMarker) {
            this.map.removeLayer(this.gpsMarker);
            this.gpsMarker = null;
        }
        if (this.accuracyCircle) {
            this.map.removeLayer(this.accuracyCircle);
            this.accuracyCircle = null;
        }
    }

    addTrackLine(points, color = '#FF4444', id = 'current') {
        const L = window.L;
        const latlngs = points.map(p => [p.lat, p.lng]);

        let polyline = this.trackLines.get(id);
        if (polyline) {
            polyline.setLatLngs(latlngs);
        } else {
            polyline = L.polyline(latlngs, {
                color: color,
                weight: 4,
                opacity: 0.85,
                lineJoin: 'round',
                lineCap: 'round'
            }).addTo(this.map);
            this.trackLines.set(id, polyline);
        }
    }

    removeTrackLine(id) {
        const polyline = this.trackLines.get(id);
        if (polyline) {
            this.map.removeLayer(polyline);
            this.trackLines.delete(id);
        }
    }

    onMapClick(callback) {
        this.map.on('click', callback);
    }

    /**
     * Pulsación larga (500 ms) sin desplazamiento. Se cancela si el dedo/puntero
     * se mueve más de 10 px o si hay más de un toque (pellizco).
     */
    onMapLongPress(callback) {
        const cancel = () => {
            if (this._longPress.timer) {
                clearTimeout(this._longPress.timer);
                this._longPress.timer = null;
            }
            this._longPress.start = null;
        };

        this.map.on('mousedown', (e) => {
            const oe = e.originalEvent;
            if (!oe) return;
            if (oe.touches && oe.touches.length > 1) return cancel();
            if (oe.button !== undefined && oe.button !== 0) return;

            cancel();
            this._longPress.start = { x: oe.clientX, y: oe.clientY, latlng: e.latlng };
            this._longPress.timer = setTimeout(() => {
                const start = this._longPress.start;
                cancel();
                if (start && this._fireLongPress) this._fireLongPress(start.latlng);
            }, 500);
        });

        this.map.on('mousemove', (e) => {
            const start = this._longPress.start;
            const oe = e.originalEvent;
            if (!start || !oe) return;
            const dx = (oe.clientX || 0) - start.x;
            const dy = (oe.clientY || 0) - start.y;
            if (Math.hypot(dx, dy) > 10) cancel();
        });

        this.map.on('mouseup dragstart zoomstart movestart', cancel);

        // En táctil (Android/iOS) la pulsación larga llega como 'contextmenu': también dispara el callback.
        let lastFire = 0;
        const fire = (latlng) => {
            const now = Date.now();
            if (now - lastFire < 700) return; // evita doble apertura (temporizador + contextmenu)
            lastFire = now;
            callback({ latlng });
        };
        this.map.on('contextmenu', (e) => {
            if (e.originalEvent) e.originalEvent.preventDefault();
            cancel();
            if (e.latlng) fire(e.latlng);
        });
        this._fireLongPress = fire;
    }
}
