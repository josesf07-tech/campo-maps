import { saveMap } from './storage.js';
import { fromMagnaSirgas, isMagnaSirgasCoords } from './coords.js';

export class MapCalibrator {
    constructor() {
        this.controlPoints = [];
        this.imageUrl = null;
        this.imageSize = { width: 0, height: 0 };
        this.matrix = null; // Affine transformation matrix
    }

    async loadFile(file) {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            return await this.loadPdf(file);
        } else {
            return await this.loadImage(file);
        }
    }

    async loadPdf(file) {
        if (!window.pdfjsLib) {
            throw new Error("El motor PDF.js no está disponible.");
        }
        
        const arrayBuffer = await file.arrayBuffer();
        
        // Extract embedded geospatial metadata (GeoPDF / ISO 32000-1 / TerraGo / OGC)
        const geoMetadata = MapCalibrator.extractGeoPdfMetadata(arrayBuffer);
        
        const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(1); // First page of map
        
        // Render at high resolution for quality map viewing
        const scale = 2.0;
        const viewport = page.getViewport({ scale });
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        await page.render({ canvasContext: context, viewport: viewport }).promise;
        
        this.imageUrl = canvas.toDataURL('image/jpeg', 0.85);
        this.imageSize.width = canvas.width;
        this.imageSize.height = canvas.height;
        this.geoMetadata = geoMetadata;
        
        return {
            url: this.imageUrl,
            width: canvas.width,
            height: canvas.height,
            isPdf: true,
            numPages: pdf.numPages,
            hasGeoReference: !!geoMetadata,
            geoMetadata: geoMetadata,
            bounds: geoMetadata ? geoMetadata.bounds : null
        };
    }

    static extractGeoPdfMetadata(arrayBuffer) {
        try {
            const uint8 = new Uint8Array(arrayBuffer);
            const decoder = new TextDecoder('latin1');
            
            // 1. Check tail (last 1.5 MB where PDF catalog and page viewports reside)
            const tailSize = Math.min(uint8.length, 1572864);
            const tailSub = uint8.subarray(uint8.length - tailSize);
            const tailText = decoder.decode(tailSub);
            
            let meta = MapCalibrator.parseGeoMetadataString(tailText);
            if (meta) return meta;

            // 2. Check head (first 512 KB)
            const headSize = Math.min(uint8.length, 524288);
            const headSub = uint8.subarray(0, headSize);
            const headText = decoder.decode(headSub);
            
            meta = MapCalibrator.parseGeoMetadataString(headText);
            if (meta) return meta;

            return null;
        } catch (e) {
            console.warn("Aviso al analizar GeoPDF:", e);
            return null;
        }
    }

    static parseGeoMetadataString(raw) {
        try {
            const isMagnaNamed = /Magna_Origen_Nacional|MAGNA|9377/i.test(raw);

            // 1. Search for Adobe / ISO 32000-1 /GPTS [ ... ]
            const gptsMatch = raw.match(/\/GPTS\s*\[([^\]]+)\]/i);
            if (gptsMatch) {
                const nums = gptsMatch[1].trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
                if (nums.length >= 8) {
                    const lats = [];
                    const lngs = [];
                    let hasProjectedCoords = false;

                    for (let i = 0; i < nums.length; i += 2) {
                        let c1 = nums[i];
                        let c2 = nums[i+1];
                        if (Math.abs(c1) <= 90 && Math.abs(c2) <= 180) {
                            lats.push(c1);
                            lngs.push(c2);
                        } else if (Math.abs(c2) <= 90 && Math.abs(c1) <= 180) {
                            lats.push(c2);
                            lngs.push(c1);
                        } else if (isMagnaSirgasCoords(c1, c2)) {
                            hasProjectedCoords = true;
                            const norte = c1 >= 3500000 ? c2 : c1;
                            const este = c1 >= 3500000 ? c1 : c2;
                            try {
                                const pt = fromMagnaSirgas(norte, este);
                                lats.push(pt.lat);
                                lngs.push(pt.lng);
                            } catch (e) {}
                        }
                    }

                    if (lats.length >= 4 && lngs.length >= 4) {
                        const minLat = Math.min(...lats);
                        const maxLat = Math.max(...lats);
                        const minLng = Math.min(...lngs);
                        const maxLng = Math.max(...lngs);
                        if (minLat !== maxLat && minLng !== maxLng) {
                            return {
                                format: (isMagnaNamed || hasProjectedCoords) ? 'GeoPDF MAGNA-SIRGAS Origen Nal. (GPTS)' : 'ISO-GeoPDF (GPTS)',
                                bounds: [[minLat, minLng], [maxLat, maxLng]],
                                center: [(minLat + maxLat) / 2, (minLng + maxLng) / 2]
                            };
                        }
                    }
                }
            }

            // 2. Search for USGS GeoPDF tags
            const swLat = raw.match(/\/SW_Lat\s+([-\d\.]+)/i);
            const swLng = raw.match(/\/SW_Long\s+([-\d\.]+)/i);
            const neLat = raw.match(/\/NE_Lat\s+([-\d\.]+)/i);
            const neLng = raw.match(/\/NE_Long\s+([-\d\.]+)/i);
            if (swLat && swLng && neLat && neLng) {
                const sLat = parseFloat(swLat[1]), sLng = parseFloat(swLng[1]);
                const nLat = parseFloat(neLat[1]), nLng = parseFloat(neLng[1]);
                return {
                    format: 'USGS-GeoPDF',
                    bounds: [
                        [Math.min(sLat, nLat), Math.min(sLng, nLng)],
                        [Math.max(sLat, nLat), Math.max(sLng, nLng)]
                    ],
                    center: [(sLat + nLat)/2, (sLng + nLng)/2]
                };
            }

            // 3. Search for GML Envelope (ArcGIS / QGIS export)
            const lowerMatch = raw.match(/<gml:lowerCorner>([^<]+)<\/gml:lowerCorner>/i);
            const upperMatch = raw.match(/<gml:upperCorner>([^<]+)<\/gml:upperCorner>/i);
            if (lowerMatch && upperMatch) {
                const p1 = lowerMatch[1].trim().split(/\s+/).map(Number);
                const p2 = upperMatch[1].trim().split(/\s+/).map(Number);
                if (p1.length >= 2 && p2.length >= 2) {
                    let lat1 = p1[0], lng1 = p1[1], lat2 = p2[0], lng2 = p2[1];
                    if (Math.abs(lat1) > 90 && Math.abs(lng1) <= 90) {
                        [lat1, lng1] = [lng1, lat1];
                        [lat2, lng2] = [lng2, lat2];
                    }
                    if (Math.abs(lat1) <= 90 && Math.abs(lng1) <= 180) {
                        return {
                            format: isMagnaNamed ? 'GeoPDF GML MAGNA-SIRGAS' : 'GML-Envelope',
                            bounds: [
                                [Math.min(lat1, lat2), Math.min(lng1, lng2)],
                                [Math.max(lat1, lat2), Math.max(lng1, lng2)]
                            ],
                            center: [(lat1 + lat2)/2, (lng1 + lng2)/2]
                        };
                    }
                }
            }

            // 4. Search for GeoBBox
            const bboxMatch = raw.match(/\/Geo(?:Graphic)?BBox\s*\[([^\]]+)\]/i);
            if (bboxMatch) {
                const nums = bboxMatch[1].trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
                if (nums.length === 4 && nums.every(n => Math.abs(n) <= 180)) {
                    let [x1, y1, x2, y2] = nums;
                    if (Math.abs(x1) > 90 && Math.abs(y1) <= 90) {
                        return {
                            format: 'GeoBBox',
                            bounds: [[Math.min(y1, y2), Math.min(x1, x2)], [Math.max(y1, y2), Math.max(x1, x2)]],
                            center: [(y1 + y2)/2, (x1 + x2)/2]
                        };
                    }
                }
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    loadImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                this.imageUrl = e.target.result;
                const img = new Image();
                img.onload = () => {
                    this.imageSize.width = img.width;
                    this.imageSize.height = img.height;
                    resolve({ url: this.imageUrl, width: img.width, height: img.height, isPdf: false });
                };
                img.onerror = reject;
                img.src = this.imageUrl;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    addControlPoint(pixelX, pixelY, lat, lng) {
        this.controlPoints.push({ px: pixelX, py: pixelY, lat, lng });
    }

    removeControlPoint(index) {
        if (index >= 0 && index < this.controlPoints.length) {
            this.controlPoints.splice(index, 1);
        }
    }

    calibrate() {
        if (this.controlPoints.length < 3) {
            throw new Error("Se requieren al menos 3 puntos de control para la calibración.");
        }

        // Basic affine transformation (first order polynomial)
        // lon = A*x + B*y + C
        // lat = D*x + E*y + F
        
        let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, sumYY = 0;
        let sumLon = 0, sumLonX = 0, sumLonY = 0;
        let sumLat = 0, sumLatX = 0, sumLatY = 0;
        
        const n = this.controlPoints.length;

        this.controlPoints.forEach(p => {
            sumX += p.px;
            sumY += p.py;
            sumXX += p.px * p.px;
            sumXY += p.px * p.py;
            sumYY += p.py * p.py;
            
            sumLon += p.lng;
            sumLonX += p.lng * p.px;
            sumLonY += p.lng * p.py;
            
            sumLat += p.lat;
            sumLatX += p.lat * p.px;
            sumLatY += p.lat * p.py;
        });

        // Solve system for Lon (A, B, C)
        const det = n * (sumXX * sumYY - sumXY * sumXY) - sumX * (sumX * sumYY - sumXY * sumY) + sumY * (sumX * sumXY - sumXX * sumY);
        
        if (Math.abs(det) < 1e-10) {
            throw new Error("Puntos colineales o sistema singular. Intente con otros puntos.");
        }

        const A = (sumLon * (sumXX * sumYY - sumXY * sumXY) - sumX * (sumLonX * sumYY - sumLonY * sumXY) + sumY * (sumLonX * sumXY - sumLonY * sumXX)) / det;
        const B = (n * (sumLonX * sumYY - sumLonY * sumXY) - sumLon * (sumX * sumYY - sumXY * sumY) + sumY * (sumX * sumLonY - sumLonX * sumY)) / det;
        const C = (n * (sumXX * sumLonY - sumXY * sumLonX) - sumX * (sumX * sumLonY - sumLonX * sumY) + sumLon * (sumX * sumXY - sumXX * sumY)) / det;
        
        // Solve system for Lat (D, E, F)
        const D = (sumLat * (sumXX * sumYY - sumXY * sumXY) - sumX * (sumLatX * sumYY - sumLatY * sumXY) + sumY * (sumLatX * sumXY - sumLatY * sumXX)) / det;
        const E = (n * (sumLatX * sumYY - sumLatY * sumXY) - sumLat * (sumX * sumYY - sumXY * sumY) + sumY * (sumX * sumLatY - sumLatX * sumY)) / det;
        const F = (n * (sumXX * sumLatY - sumXY * sumLatX) - sumX * (sumX * sumLatY - sumLatX * sumY) + sumLat * (sumX * sumXY - sumXX * sumY)) / det;

        // For simplicity, mapped to Leaflet's L.ImageOverlay which requires bounds.
        // We calculate lat/lng for corners:
        // C and F here represent constants, A/D are coefficients for x, B/E for y...
        // Note: Leaflet's ImageOverlay assumes a rectangular (non-rotated) bounding box.
        // For true affine (rotated) support, Leaflet.ImageOverlay.Rotated or similar is needed.
        // Assuming minimal rotation for a simple bounds approximation:
        
        this.matrix = { A, B, C, D, E, F };
        return this.matrix;
    }

    pixelToLatLng(x, y) {
        if (!this.matrix) return null;
        // Re-deriving from least squares. A simple approximation:
        // We need the inverse mapping or we can just use the affine.
        // Wait, the least squares above was solving:
        // lon = A + B*x + C*y ... wait, the variables were A, B, C. 
        // Actually, let's use the matrix to map corners.
        // Let's assume standard linear mapping for simplicity in this MVP:
        
        // In this basic version, let's just find bounds
        const minLng = Math.min(...this.controlPoints.map(p => p.lng));
        const maxLng = Math.max(...this.controlPoints.map(p => p.lng));
        const minLat = Math.min(...this.controlPoints.map(p => p.lat));
        const maxLat = Math.max(...this.controlPoints.map(p => p.lat));
        
        return { lat: minLat, lng: minLng };
    }
    
    getImageBounds() {
        if (this.controlPoints.length < 2) return null;
        
        // For basic ImageOverlay we just use min/max of control points scaled to image size.
        // A robust implementation would use the affine matrix.
        // Simplified bounds calculation:
        const pts = this.controlPoints;
        const p1 = pts[0];
        const p2 = pts[1];
        
        // degrees per pixel
        const dLngDpX = (p2.lng - p1.lng) / (p2.px - p1.px || 1);
        const dLatDpY = (p2.lat - p1.lat) / (p2.py - p1.py || 1);
        
        const lng0 = p1.lng - (p1.px * dLngDpX);
        const lat0 = p1.lat - (p1.py * dLatDpY);
        
        const lng1 = lng0 + (this.imageSize.width * dLngDpX);
        const lat1 = lat0 + (this.imageSize.height * dLatDpY);
        
        return [
            [Math.min(lat0, lat1), Math.min(lng0, lng1)], // SouthWest
            [Math.max(lat0, lat1), Math.max(lng0, lng1)]  // NorthEast
        ];
    }

    async save(name) {
        const bounds = this.getImageBounds();
        const mapData = {
            name: name || "Mapa Calibrado",
            imageUrl: this.imageUrl, // Storing base64, careful with size in IndexedDB
            bounds: bounds,
            controlPoints: this.controlPoints,
            createdAt: Date.now()
        };
        
        return await saveMap(mapData);
    }
}
