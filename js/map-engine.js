export class MapEngine {
    constructor(containerId) {
        this.containerId = containerId;
        this.map = null;
        this.gpsMarker = null;
        this.accuracyCircle = null;
        this.trackLines = new Map();
        this.imageOverlays = new Map();
        
        this.longPressTimeout = null;
    }

    init(defaultLat = 0, defaultLng = 0, defaultZoom = 2) {
        const L = window.L;
        if (!L) throw new Error("Leaflet no está cargado");

        this.map = L.map(this.containerId, {
            zoomControl: false // We can add custom zoom controls if needed
        }).setView([defaultLat, defaultLng], defaultZoom);

        this.baseLayerType = 'satellite';
        this.currentBaseLayer = null;
        this.setBaseLayer('satellite');
    }

    setBaseLayer(type) {
        const L = window.L;
        if (!L || !this.map) return;
        if (this.currentBaseLayer) {
            this.map.removeLayer(this.currentBaseLayer);
        }
        this.baseLayerType = type;
        if (type === 'satellite') {
            this.currentBaseLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
                attribution: '© Google Satélite',
                maxZoom: 20
            }).addTo(this.map);
        } else if (type === 'topo') {
            this.currentBaseLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenTopoMap',
                maxZoom: 17
            }).addTo(this.map);
        } else {
            this.currentBaseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19
            }).addTo(this.map);
        }

        if (this.currentBaseLayer.bringToBack) {
            this.currentBaseLayer.bringToBack();
        }
    }

    addImageOverlay(id, imageUrl, bounds, options = {}) {
        const L = window.L;
        const overlay = L.imageOverlay(imageUrl, bounds, {
            opacity: options.opacity || 1.0,
            interactive: true
        }).addTo(this.map);
        
        this.imageOverlays.set(id, overlay);
        return overlay;
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
        if (overlay) {
            overlay.setOpacity(opacity);
        }
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
    
    fitBounds(bounds) {
        this.map.fitBounds(bounds);
    }

    addGPSMarker(lat, lng, accuracy, heading = null) {
        const L = window.L;
        
        if (!this.gpsMarker) {
            // Create marker
            const iconHtml = `
                <div style="
                    background-color: #4285F4;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    border: 3px solid white;
                    box-shadow: 0 0 4px rgba(0,0,0,0.5);
                    position: relative;
                ">
                    ${heading !== null ? `<div style="position: absolute; top: -10px; left: 5px; width: 0; height: 0; border-left: 3px solid transparent; border-right: 3px solid transparent; border-bottom: 8px solid #4285F4; transform: rotate(${heading}deg); transform-origin: 3px 18px;"></div>` : ''}
                </div>
            `;
            
            const gpsIcon = L.divIcon({
                html: iconHtml,
                className: 'gps-marker-icon',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });
            
            this.gpsMarker = L.marker([lat, lng], { icon: gpsIcon, zIndexOffset: 1000 }).addTo(this.map);
            this.accuracyCircle = L.circle([lat, lng], {
                radius: accuracy,
                color: '#4285F4',
                fillColor: '#4285F4',
                fillOpacity: 0.15,
                weight: 1
            }).addTo(this.map);
        } else {
            // Update position
            this.gpsMarker.setLatLng([lat, lng]);
            this.accuracyCircle.setLatLng([lat, lng]);
            this.accuracyCircle.setRadius(accuracy);
            
            if (heading !== null) {
                // Update heading via icon recreation (simplified)
                const iconHtml = `
                    <div style="background-color: #4285F4; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.5); position: relative;">
                        <div style="position: absolute; top: -10px; left: 5px; width: 0; height: 0; border-left: 3px solid transparent; border-right: 3px solid transparent; border-bottom: 8px solid #4285F4; transform: rotate(${heading}deg); transform-origin: 3px 18px;"></div>
                    </div>
                `;
                this.gpsMarker.setIcon(L.divIcon({ html: iconHtml, className: 'gps-marker-icon', iconSize: [22, 22], iconAnchor: [11, 11] }));
            }
        }
    }

    removeGPSMarker() {
        if (this.gpsMarker) {
            this.map.removeLayer(this.gpsMarker);
            this.map.removeLayer(this.accuracyCircle);
            this.gpsMarker = null;
            this.accuracyCircle = null;
        }
    }

    addTrackLine(points, color = "#FF0000", id = 'current') {
        const L = window.L;
        const latlngs = points.map(p => [p.lat, p.lng]);
        
        let polyline = this.trackLines.get(id);
        if (polyline) {
            polyline.setLatLngs(latlngs);
        } else {
            polyline = L.polyline(latlngs, {
                color: color,
                weight: 4,
                opacity: 0.8
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

    onMapLongPress(callback) {
        this.map.on('mousedown touchstart', (e) => {
            this.longPressTimeout = setTimeout(() => {
                callback(e);
            }, 500);
        });

        this.map.on('mouseup touchend mousemove touchmove', () => {
            if (this.longPressTimeout) {
                clearTimeout(this.longPressTimeout);
                this.longPressTimeout = null;
            }
        });
    }
}
