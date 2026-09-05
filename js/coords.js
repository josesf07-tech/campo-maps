/**
 * Coords Module - MAGNA-SIRGAS Origen Nacional (EPSG:9377)
 * Definición oficial de Colombia (IGAC Res. 471 de 2020 / 529 de 2020 / 370 de 2021)
 * 
 * Proyección: Transverse Mercator
 * Latitud de Origen: 4.0° N
 * Meridiano Central: -73.0° W
 * Falso Este: 5,000,000.0 m
 * Falso Norte: 2,000,000.0 m
 * Factor de Escala: 0.9992
 * Elipsoide: GRS80 / WGS84
 */

export const MAGNA_SIRGAS_ORIGEN_NACIONAL_DEF = "+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";

// Initialize proj4 if available
export function initCoords() {
    if (typeof window !== 'undefined' && window.proj4) {
        window.proj4.defs("EPSG:9377", MAGNA_SIRGAS_ORIGEN_NACIONAL_DEF);
        window.proj4.defs("MAGNA_ORIGEN_NACIONAL", MAGNA_SIRGAS_ORIGEN_NACIONAL_DEF);
        return true;
    }
    return false;
}

/**
 * Convierte WGS84 (Lat, Lng) a MAGNA-SIRGAS Origen Nacional (Norte, Este en metros)
 * @param {number} lat - Latitud decimal
 * @param {number} lng - Longitud decimal
 * @returns {{ norte: number, este: number, formatted: string }}
 */
export function toMagnaSirgas(lat, lng) {
    initCoords();
    // Guarda con `typeof`: en Node / Web Worker no existe `window` y un acceso
    // directo lanzaría ReferenceError en vez de usar la rama de respaldo.
    if (typeof window === 'undefined' || !window.proj4) {
        return {
            norte: 0,
            este: 0,
            formatted: `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`
        };
    }
    try {
        const [este, norte] = window.proj4("EPSG:4326", "EPSG:9377", [lng, lat]);
        return {
            este: Math.round(este * 100) / 100,
            norte: Math.round(norte * 100) / 100,
            formatted: `N: ${Math.round(norte).toLocaleString('es-CO')} m | E: ${Math.round(este).toLocaleString('es-CO')} m`
        };
    } catch (e) {
        console.error("Error al convertir a MAGNA-SIRGAS:", e);
        return {
            norte: 0,
            este: 0,
            formatted: `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`
        };
    }
}

/**
 * Convierte coordenadas MAGNA-SIRGAS Origen Nacional (Norte, Este) a WGS84 (Lat, Lng)
 * @param {number} norte - Coordenada Norte en metros (ej: 2066190)
 * @param {number} este - Coordenada Este en metros (ej: 4991660)
 * @returns {{ lat: number, lng: number }}
 */
export function fromMagnaSirgas(norte, este) {
    initCoords();
    // Misma guarda que en toMagnaSirgas: sin `window` no hay motor de proyección.
    if (typeof window === 'undefined' || !window.proj4) {
        throw new Error("Motor de proyecciones Proj4 no disponible.");
    }
    try {
        const [lng, lat] = window.proj4("EPSG:9377", "EPSG:4326", [este, norte]);
        return { lat, lng };
    } catch (e) {
        console.error("Error al convertir desde MAGNA-SIRGAS:", e);
        throw e;
    }
}

/**
 * Detecta si un par de números corresponden a MAGNA-SIRGAS Origen Nacional
 */
export function isMagnaSirgasCoords(v1, v2) {
    const c1 = Math.abs(v1);
    const c2 = Math.abs(v2);
    return (
        (c1 >= 800000 && c1 <= 3500000 && c2 >= 3500000 && c2 <= 6500000) ||
        (c2 >= 800000 && c2 <= 3500000 && c1 >= 3500000 && c1 <= 6500000)
    );
}
