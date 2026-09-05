/**
 * lidar-geo.js — Georreferenciación de los escaneos LiDAR de JoseScan.
 *
 * Implementa el §3 y el §6 de docs/FORMATO-ESCANEO.md: conversión ARKit → ENU,
 * ENU ↔ WGS84 por aproximación local plana (radios de curvatura M y N del
 * elipsoide WGS84 en la latitud del origen), la huella GeoJSON que JoseMaps
 * superpone en Leaflet y las coordenadas MAGNA-SIRGAS Origen Nacional
 * (EPSG:9377) reutilizando `js/coords.js`.
 *
 * Módulo ES nativo, sin dependencias npm.
 *
 * @module lidar-geo
 */

import { toMagnaSirgas } from './coords.js';

/* ───────────────────────── Constantes del elipsoide WGS84 ───────────────────────── */

/** Semieje mayor del elipsoide WGS84, en metros. */
export const WGS84_A = 6378137.0;

/** Aplanamiento inverso del elipsoide WGS84. */
export const WGS84_INV_F = 298.257223563;

/** Primera excentricidad al cuadrado (e²) del elipsoide WGS84. */
export const WGS84_E2 = (2 / WGS84_INV_F) - (1 / (WGS84_INV_F * WGS84_INV_F));

const GRADOS_A_RAD = Math.PI / 180;
const RAD_A_GRADOS = 180 / Math.PI;

/* ───────────────────────── Utilidades internas ───────────────────────── */

/**
 * Radios de curvatura del elipsoide WGS84 en una latitud dada.
 * @param {number} latitudGrados
 * @returns {{M:number, N:number}} M = meridiano, N = primer vertical (metros)
 */
function _radiosCurvatura(latitudGrados) {
    const phi = latitudGrados * GRADOS_A_RAD;
    const sen = Math.sin(phi);
    const w2 = 1 - WGS84_E2 * sen * sen;
    const w = Math.sqrt(w2);
    return {
        M: (WGS84_A * (1 - WGS84_E2)) / (w2 * w),
        N: WGS84_A / w
    };
}

/**
 * Recorre posiciones planas (`Float32Array`) o tripletas `[[x,y,z], …]`.
 * @param {Float32Array|number[]|number[][]} posiciones
 * @returns {{obtener:(i:number, c:number)=>number, total:number, plano:boolean}}
 */
function _accesoPosiciones(posiciones) {
    if (!posiciones) return { obtener: () => 0, total: 0, plano: true };
    if (Array.isArray(posiciones) && posiciones.length > 0 && (Array.isArray(posiciones[0]) || ArrayBuffer.isView(posiciones[0]))) {
        return {
            obtener: (i, c) => Number(posiciones[i][c]) || 0,
            total: posiciones.length,
            plano: false
        };
    }
    const largo = posiciones.length || 0;
    return {
        obtener: (i, c) => Number(posiciones[i * 3 + c]) || 0,
        total: Math.floor(largo / 3),
        plano: true
    };
}

/**
 * Valida y normaliza el origen geodésico de un escaneo.
 * @param {{latitude:number, longitude:number, altitude?:number}} origen
 * @returns {{latitude:number, longitude:number, altitude:number}}
 */
function _origenValido(origen) {
    if (!origen || typeof origen !== 'object'
        || !Number.isFinite(origen.latitude) || !Number.isFinite(origen.longitude)) {
        throw new Error('El escaneo no tiene un origen geodésico válido (geo.latitude / geo.longitude).');
    }
    return {
        latitude: origen.latitude,
        longitude: origen.longitude,
        altitude: Number.isFinite(origen.altitude) ? origen.altitude : 0
    };
}

/** Formatea un número para el usuario con la configuración regional es-CO. */
function _fmt(valor, minDec = 0, maxDec = 2) {
    if (!Number.isFinite(valor)) return '—';
    return valor.toLocaleString('es-CO', { minimumFractionDigits: minDec, maximumFractionDigits: maxDec });
}

/**
 * Convierte grados decimales a grados-minutos-segundos con hemisferio.
 * @param {number} valor
 * @param {boolean} esLatitud
 * @returns {string} p. ej. `4°36'35"N`
 */
function _aGMS(valor, esLatitud) {
    const hemisferio = esLatitud ? (valor >= 0 ? 'N' : 'S') : (valor >= 0 ? 'E' : 'W');
    const absoluto = Math.abs(valor);
    let grados = Math.floor(absoluto);
    let minutosDec = (absoluto - grados) * 60;
    let minutos = Math.floor(minutosDec);
    let segundos = Math.round((minutosDec - minutos) * 60);
    if (segundos === 60) { segundos = 0; minutos += 1; }
    if (minutos === 60) { minutos = 0; grados += 1; }
    return `${grados}°${String(minutos).padStart(2, '0')}'${String(segundos).padStart(2, '0')}"${hemisferio}`;
}

/* ───────────────────────── Geometría básica ───────────────────────── */

/**
 * Calcula la caja envolvente alineada a los ejes de un conjunto de posiciones.
 *
 * @param {Float32Array|number[]|number[][]} positions
 * @returns {{min:number[], max:number[], centro:number[], tamano:number[], vacio:boolean}}
 */
export function boundsDe(positions) {
    const acceso = _accesoPosiciones(positions);
    if (acceso.total === 0) {
        return { min: [0, 0, 0], max: [0, 0, 0], centro: [0, 0, 0], tamano: [0, 0, 0], vacio: true };
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < acceso.total; i++) {
        for (let c = 0; c < 3; c++) {
            const v = acceso.obtener(i, c);
            if (!Number.isFinite(v)) continue;
            if (v < min[c]) min[c] = v;
            if (v > max[c]) max[c] = v;
        }
    }
    for (let c = 0; c < 3; c++) {
        if (!Number.isFinite(min[c])) { min[c] = 0; max[c] = 0; }
    }
    return {
        min,
        max,
        centro: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        tamano: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        vacio: false
    };
}

/**
 * Índice del eje vertical según el marco de coordenadas (§3).
 * En ARKit el eje vertical es +Y (índice 1); en ENU es +Z (índice 2).
 *
 * @param {string} frame `'arkit'` o `'enu'`
 * @returns {number} 1 o 2
 */
export function ejeVertical(frame) {
    return String(frame || '').toLowerCase() === 'arkit' ? 1 : 2;
}

/**
 * Convierte posiciones del marco ARKit al marco ENU (§3).
 *
 * Con `h` = rumbo verdadero (en radianes) del eje −Z de ARKit:
 * ```
 * este   = x·cos h + z·sen h
 * norte  = x·sen h − z·cos h
 * arriba = y
 * ```
 *
 * @param {Float32Array|number[]|number[][]} positions
 * @param {number} rumboGrados Rumbo verdadero en grados (geo.heading).
 * @returns {Float32Array} Nuevo arreglo plano `[e, n, u, …]`.
 */
export function arkitAEnu(positions, rumboGrados) {
    const acceso = _accesoPosiciones(positions);
    const h = (Number.isFinite(rumboGrados) ? rumboGrados : 0) * GRADOS_A_RAD;
    const cos = Math.cos(h);
    const sen = Math.sin(h);
    const salida = new Float32Array(acceso.total * 3);
    for (let i = 0; i < acceso.total; i++) {
        const x = acceso.obtener(i, 0);
        const y = acceso.obtener(i, 1);
        const z = acceso.obtener(i, 2);
        salida[i * 3] = x * cos + z * sen;      // este
        salida[i * 3 + 1] = x * sen - z * cos;  // norte
        salida[i * 3 + 2] = y;                  // arriba
    }
    return salida;
}

/* ───────────────────────── ENU ↔ WGS84 ───────────────────────── */

/**
 * Convierte coordenadas locales ENU (metros) a WGS84 usando la aproximación
 * local plana con los radios de curvatura M y N en la latitud del origen.
 *
 * @param {number} este
 * @param {number} norte
 * @param {number} arriba
 * @param {{latitude:number, longitude:number, altitude?:number}} origen
 * @returns {{lat:number, lng:number, alt:number}}
 */
export function enuAWgs84(este, norte, arriba, origen) {
    const o = _origenValido(origen);
    const { M, N } = _radiosCurvatura(o.latitude);
    const cosLat = Math.cos(o.latitude * GRADOS_A_RAD);
    const dLat = (Number(norte) || 0) / M;
    const dLng = (Number(este) || 0) / (N * (Math.abs(cosLat) < 1e-12 ? 1e-12 : cosLat));
    return {
        lat: o.latitude + dLat * RAD_A_GRADOS,
        lng: o.longitude + dLng * RAD_A_GRADOS,
        alt: o.altitude + (Number(arriba) || 0)
    };
}

/**
 * Inversa de {@link enuAWgs84}: WGS84 → ENU local en metros.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} alt
 * @param {{latitude:number, longitude:number, altitude?:number}} origen
 * @returns {{este:number, norte:number, arriba:number}}
 */
export function wgs84AEnu(lat, lng, alt, origen) {
    const o = _origenValido(origen);
    const { M, N } = _radiosCurvatura(o.latitude);
    const cosLat = Math.cos(o.latitude * GRADOS_A_RAD);
    const dLat = ((Number(lat) || 0) - o.latitude) * GRADOS_A_RAD;
    let dLng = ((Number(lng) || 0) - o.longitude);
    // Normaliza el salto del antimeridiano.
    if (dLng > 180) dLng -= 360;
    if (dLng < -180) dLng += 360;
    dLng *= GRADOS_A_RAD;
    return {
        este: dLng * N * cosLat,
        norte: dLat * M,
        arriba: (Number.isFinite(alt) ? alt : o.altitude) - o.altitude
    };
}

/* ───────────────────────── Huella GeoJSON (§6) ───────────────────────── */

/**
 * Proyecta las cuatro esquinas horizontales de una caja envolvente al plano ENU,
 * teniendo en cuenta el marco del escaneo.
 *
 * @param {{min:number[], max:number[]}} bbox
 * @param {string} marco
 * @param {number} rumboGrados
 * @returns {number[][]} Cuatro pares `[este, norte]` en sentido antihorario.
 */
function _esquinasEnu(bbox, marco, rumboGrados) {
    const min = bbox.min;
    const max = bbox.max;
    if (ejeVertical(marco) === 2) {
        // ENU: los ejes horizontales ya son X = Este e Y = Norte.
        return [
            [min[0], min[1]],
            [max[0], min[1]],
            [max[0], max[1]],
            [min[0], max[1]]
        ];
    }
    // ARKit: el plano horizontal es (X, Z); se rotan las cuatro esquinas.
    const esquinasArkit = [
        [min[0], 0, min[2]],
        [max[0], 0, min[2]],
        [max[0], 0, max[2]],
        [min[0], 0, max[2]]
    ];
    const enu = arkitAEnu(esquinasArkit, rumboGrados);
    const salida = [];
    for (let i = 0; i < 4; i++) salida.push([enu[i * 3], enu[i * 3 + 1]]);
    return salida;
}

/**
 * Asegura que un anillo de `[lng, lat]` esté en sentido antihorario
 * (regla de la mano derecha para el anillo exterior de un `Polygon`).
 *
 * @param {number[][]} anillo Anillo abierto (sin repetir el primer punto).
 * @returns {number[][]} Anillo cerrado y antihorario.
 */
function _anilloAntihorario(anillo) {
    let area = 0;
    for (let i = 0; i < anillo.length; i++) {
        const a = anillo[i];
        const b = anillo[(i + 1) % anillo.length];
        area += a[0] * b[1] - b[0] * a[1];
    }
    const ordenado = area < 0 ? anillo.slice().reverse() : anillo.slice();
    ordenado.push([ordenado[0][0], ordenado[0][1]]);
    return ordenado;
}

/**
 * Construye la huella georreferenciada del escaneo (docs §6): un
 * `FeatureCollection` WGS84 con un `Point` en el origen y un `Polygon` con la
 * proyección horizontal de la caja envolvente.
 *
 * Si el escaneo no tiene caja envolvente, se devuelve sólo el `Point`.
 *
 * @param {object} meta Metadatos `escaneo.json`.
 * @param {{bbox?:{min:number[], max:number[]}|null}} [opciones] Caja alternativa.
 * @returns {object} FeatureCollection GeoJSON válido.
 * @throws {Error} Si el escaneo no está georreferenciado.
 */
export function scanAGeoJSON(meta, { bbox = null } = {}) {
    if (!meta || typeof meta !== 'object') throw new Error('Metadatos del escaneo inválidos o ausentes.');
    const origen = _origenValido(meta.geo);
    const magna = scanAMagnaSirgas(meta);

    const propiedadesPunto = {
        id: meta.id || null,
        nombre: meta.nombre || 'Escaneo sin nombre',
        puntos: Number.isFinite(meta.puntos) ? meta.puntos : 0,
        triangulos: Number.isFinite(meta.triangulos) ? meta.triangulos : 0,
        norte: magna.norte,
        este: magna.este,
        // Campos adicionales útiles para la capa de JoseMaps.
        creado: meta.creado || null,
        proyecto: meta.proyecto || null,
        marco: meta.marco || 'arkit',
        altitud: origen.altitude,
        precisionHorizontal: Number.isFinite(meta.geo && meta.geo.horizontalAccuracy) ? meta.geo.horizontalAccuracy : null
    };

    const features = [{
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [origen.longitude, origen.latitude, origen.altitude]
        },
        properties: propiedadesPunto
    }];

    const caja = bbox || meta.bbox || null;
    if (caja && Array.isArray(caja.min) && Array.isArray(caja.max) && caja.min.length === 3 && caja.max.length === 3) {
        const rumbo = (meta.geo && Number.isFinite(meta.geo.heading)) ? meta.geo.heading : 0;
        const esquinas = _esquinasEnu(caja, meta.marco, rumbo);
        const anillo = esquinas.map(([e, n]) => {
            const p = enuAWgs84(e, n, 0, origen);
            return [p.lng, p.lat];
        });
        features.push({
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [_anilloAntihorario(anillo)]
            },
            properties: {
                id: meta.id || null,
                nombre: meta.nombre || 'Escaneo sin nombre',
                tipo: 'huella',
                anchoMetros: Math.abs(caja.max[0] - caja.min[0]),
                largoMetros: Math.abs(caja.max[ejeVertical(meta.marco) === 2 ? 1 : 2] - caja.min[ejeVertical(meta.marco) === 2 ? 1 : 2]),
                altoMetros: Math.abs(caja.max[ejeVertical(meta.marco)] - caja.min[ejeVertical(meta.marco)])
            }
        });
    }

    return { type: 'FeatureCollection', features };
}

/**
 * Coordenadas MAGNA-SIRGAS Origen Nacional (EPSG:9377) del **origen** del
 * escaneo. Usa `geo.norte` / `geo.este` cuando ya vienen en los metadatos y,
 * si no, las calcula con `toMagnaSirgas` de `js/coords.js`.
 *
 * @param {object} meta
 * @returns {{norte:number, este:number, formatted:string}}
 */
export function scanAMagnaSirgas(meta) {
    if (!meta || typeof meta !== 'object') throw new Error('Metadatos del escaneo inválidos o ausentes.');
    const g = meta.geo;
    if (g && Number.isFinite(g.norte) && Number.isFinite(g.este)) {
        return {
            norte: g.norte,
            este: g.este,
            formatted: `N: ${Math.round(g.norte).toLocaleString('es-CO')} m | E: ${Math.round(g.este).toLocaleString('es-CO')} m`
        };
    }
    const o = _origenValido(g);
    return toMagnaSirgas(o.latitude, o.longitude);
}

/* ───────────────────────── Mediciones ───────────────────────── */

/**
 * Distancia euclidiana 3D entre dos puntos `[x, y, z]`.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Distancia en metros.
 */
export function distancia3D(a, b) {
    if (!a || !b) return 0;
    const dx = (Number(b[0]) || 0) - (Number(a[0]) || 0);
    const dy = (Number(b[1]) || 0) - (Number(a[1]) || 0);
    const dz = (Number(b[2]) || 0) - (Number(a[2]) || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Área horizontal de un polígono por la fórmula del cordón (shoelace).
 * Se usan las dos primeras componentes de cada punto.
 *
 * @param {number[][]} puntos Al menos tres pares/tripletas.
 * @returns {number} Área en m² (siempre positiva).
 */
export function areaPoligono(puntos) {
    if (!Array.isArray(puntos) || puntos.length < 3) return 0;
    let suma = 0;
    for (let i = 0; i < puntos.length; i++) {
        const a = puntos[i];
        const b = puntos[(i + 1) % puntos.length];
        suma += (Number(a[0]) || 0) * (Number(b[1]) || 0) - (Number(b[0]) || 0) * (Number(a[1]) || 0);
    }
    return Math.abs(suma) / 2;
}

/**
 * Volumen encerrado entre una malla y un plano horizontal de referencia
 * (método de los prismas: cada triángulo aporta su área horizontal con signo
 * multiplicada por la altura media de sus vértices sobre la base).
 *
 * Con una malla cerrada y orientada el resultado es el volumen real; con una
 * superficie abierta (una cárcava, un talud) es el volumen sobre la base.
 *
 * @param {{positions?:Float32Array, vertices?:Float32Array, indices:Uint32Array|number[]}} malla
 * @param {number} base Cota de la base en el eje vertical del marco (metros).
 * @param {string} frame `'arkit'` o `'enu'`.
 * @returns {number} Volumen en m³ (positivo si la malla está sobre la base).
 */
export function volumenSobreBase(malla, base, frame) {
    if (!malla || typeof malla !== 'object') return 0;
    const posiciones = malla.positions || malla.vertices;
    const acceso = _accesoPosiciones(posiciones);
    const indices = malla.indices;
    if (!indices || indices.length < 3 || acceso.total === 0) return 0;

    const vert = ejeVertical(frame);
    // Ejes horizontales orientados a derechas vistos desde el eje vertical:
    // ENU → (X = Este, Y = Norte); ARKit (+Y arriba) → (X, −Z).
    const ejeU = 0;
    const ejeV = vert === 2 ? 1 : 2;
    const signoV = vert === 2 ? 1 : -1;
    const cota = Number.isFinite(base) ? base : 0;

    let volumen = 0;
    for (let t = 0; t + 2 < indices.length; t += 3) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        if (i0 >= acceso.total || i1 >= acceso.total || i2 >= acceso.total) continue;

        const u0 = acceso.obtener(i0, ejeU), v0 = signoV * acceso.obtener(i0, ejeV);
        const u1 = acceso.obtener(i1, ejeU), v1 = signoV * acceso.obtener(i1, ejeV);
        const u2 = acceso.obtener(i2, ejeU), v2 = signoV * acceso.obtener(i2, ejeV);

        const areaFirmada = ((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2;
        const alturaMedia = (acceso.obtener(i0, vert) + acceso.obtener(i1, vert) + acceso.obtener(i2, vert)) / 3 - cota;
        volumen += areaFirmada * alturaMedia;
    }
    return volumen;
}

/* ───────────────────────── Resumen para la interfaz ───────────────────────── */

/**
 * Resumen legible de la georreferenciación de un escaneo, en es-CO.
 *
 * Ejemplo: `4°36'35"N 74°04'54"W · ±3,2 m · N 2.067.412 E 4.898.231`
 *
 * @param {object} meta
 * @returns {string}
 */
export function resumenGeo(meta) {
    if (!meta || typeof meta !== 'object' || !meta.geo
        || !Number.isFinite(meta.geo.latitude) || !Number.isFinite(meta.geo.longitude)) {
        return 'Sin georreferencia';
    }
    const g = meta.geo;
    const partes = [`${_aGMS(g.latitude, true)} ${_aGMS(g.longitude, false)}`];

    if (Number.isFinite(g.horizontalAccuracy) && g.horizontalAccuracy >= 0) {
        partes.push(`±${_fmt(g.horizontalAccuracy, 1, 1)} m`);
    }

    let magna = null;
    try { magna = scanAMagnaSirgas(meta); } catch (e) { magna = null; }
    if (magna && Number.isFinite(magna.norte) && Number.isFinite(magna.este) && (magna.norte !== 0 || magna.este !== 0)) {
        partes.push(`N ${Math.round(magna.norte).toLocaleString('es-CO')} E ${Math.round(magna.este).toLocaleString('es-CO')}`);
    }

    return partes.join(' · ');
}
