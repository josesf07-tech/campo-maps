/**
 * CampoMaps / JoseMaps - JoseScan Web (`js/lidar-scanner.js`)
 *
 * Escáner 3D dentro del navegador basado en la **WebXR Depth Sensing API**.
 *
 * AVISO HONESTO SOBRE EL HARDWARE
 * -------------------------------
 * En iPhone/iPad **no existe** ninguna API web que dé acceso al sensor LiDAR:
 * Safari no implementa WebXR ni el sensor de profundidad. Por eso este módulo
 * NO escanea en iOS; allí el escaneo real lo hace la app nativa `JoseScan`.
 *
 * Este módulo cubre el otro caso: teléfonos **Android con ARCore** y Chrome
 * (o navegadores derivados) que sí exponen `depth-sensing`. En esos equipos la
 * profundidad proviene de la estimación de ARCore (a veces apoyada por un
 * sensor ToF), no de un LiDAR: la nube es más ruidosa que la de un iPhone Pro,
 * suficiente para volumetría aproximada y documentación de campo.
 *
 * El módulo no toca el DOM fuera del contenedor recibido, no registra nada en
 * `window`, no usa `alert` y no depende de ninguna librería externa: la
 * aritmética de matrices 4x4 está implementada aquí mismo.
 *
 * Formato de salida: `docs/FORMATO-ESCANEO.md` (`josescan/1.0`, sensor `webxr`).
 */

import { toMagnaSirgas } from './coords.js';

/* ------------------------------------------------------------------ *
 * Constantes del módulo
 * ------------------------------------------------------------------ */

/** Versión del contrato compartido con la app iOS. */
const FORMATO = 'josescan/1.0';

/** Funcionalidades opcionales que se piden a la sesión WebXR. */
const OPCIONALES_BASE = ['dom-overlay', 'light-estimation', 'anchors'];

/** Máximo de eventos 'puntos' por segundo (5 Hz según el encargo). */
const MS_ENTRE_EVENTOS_PUNTOS = 200;

/** Cada cuánto se vuelve a leer la imagen de cámara para colorear (ms). */
const MS_ENTRE_LECTURAS_CAMARA = 200;

/** Profundidades fuera de este rango se descartan (ruido / horizonte). */
const PROFUNDIDAD_MIN_M = 0.20;
const PROFUNDIDAD_MAX_M = 8.00;

/* ------------------------------------------------------------------ *
 * Aritmética de matrices 4x4
 *
 * WebXR entrega las matrices como Float32Array(16) en orden **column-major**:
 * el elemento de la fila `f` y la columna `c` está en `m[c * 4 + f]`.
 * Todas las funciones de abajo respetan esa convención.
 * ------------------------------------------------------------------ */

/**
 * Multiplica dos matrices 4x4 column-major: `salida = a · b`
 * (es decir, se aplica primero `b` y luego `a`).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {Float32Array} [salida] Buffer reutilizable opcional.
 * @returns {Float32Array}
 */
function multiplicarMat4(a, b, salida) {
    const m = salida || new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let f = 0; f < 4; f++) {
            let suma = 0;
            for (let k = 0; k < 4; k++) {
                // a[fila f, columna k] * b[fila k, columna c]
                suma += a[k * 4 + f] * b[c * 4 + k];
            }
            m[c * 4 + f] = suma;
        }
    }
    return m;
}

/**
 * Invierte una matriz 4x4 column-major por cofactores (método clásico de MESA).
 * Devuelve `null` si la matriz es singular (determinante ~ 0).
 * @param {ArrayLike<number>} m
 * @param {Float32Array} [salida]
 * @returns {Float32Array|null}
 */
function invertirMat4(m, salida) {
    const inv = salida || new Float32Array(16);

    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] +
             m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] -
             m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] +
             m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] -
              m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];

    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] -
             m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] +
             m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] -
             m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] +
              m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];

    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] +
             m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] -
             m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] +
              m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] -
              m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];

    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] -
             m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] +
             m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] -
              m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] +
              m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

    // El determinante se obtiene con la primera fila y su cofactor ya calculado
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;

    const invDet = 1.0 / det;
    for (let i = 0; i < 16; i++) inv[i] *= invDet;
    return inv;
}

/**
 * Transforma el punto homogéneo (x, y, z, 1) por una matriz column-major y
 * devuelve el resultado dividido por w (proyección en perspectiva incluida).
 * @param {ArrayLike<number>} m
 * @param {number} x @param {number} y @param {number} z
 * @param {number[]} [salida] Array de 3 posiciones reutilizable.
 * @returns {number[]|null} `null` si w es ~0 (punto en el infinito).
 */
function transformarPunto(m, x, y, z, salida) {
    const px = m[0] * x + m[4] * y + m[8] * z + m[12];
    const py = m[1] * x + m[5] * y + m[9] * z + m[13];
    const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const pw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!isFinite(pw) || Math.abs(pw) < 1e-9) return null;
    const r = salida || [0, 0, 0];
    r[0] = px / pw;
    r[1] = py / pw;
    r[2] = pz / pw;
    return r;
}

/* ------------------------------------------------------------------ *
 * Detección de plataforma y capacidades
 * ------------------------------------------------------------------ */

/**
 * Detecta iOS/iPadOS. iPadOS 13+ se anuncia como "Macintosh" en el user agent,
 * así que se comprueba además que el equipo tenga pantalla táctil múltiple.
 * @returns {boolean}
 */
function esIOS() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS haciéndose pasar por Mac de escritorio
    return (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

/** @returns {boolean} true en Android (excluyendo Android TV/WebView irrelevante). */
function esAndroid() {
    if (typeof navigator === 'undefined') return false;
    return /Android/.test(navigator.userAgent || '');
}

/**
 * Comprueba si el navegador expone la API de profundidad de WebXR.
 * Se miran tres señales independientes porque no todas las versiones de Chrome
 * exponen las mismas interfaces globales.
 * @returns {boolean}
 */
function hayApiProfundidad() {
    if (typeof window === 'undefined') return false;
    const conSesion = typeof window.XRSession !== 'undefined' &&
        window.XRSession.prototype && 'depthUsage' in window.XRSession.prototype;
    const conFrame = typeof window.XRFrame !== 'undefined' &&
        window.XRFrame.prototype && typeof window.XRFrame.prototype.getDepthInformation === 'function';
    const conCPU = typeof window.XRCPUDepthInformation !== 'undefined';
    return !!(conSesion || conFrame || conCPU);
}

/**
 * Informa, sin prometer de más, qué puede hacer este dispositivo.
 *
 * @returns {Promise<{
 *   soportado: boolean, webxr: boolean, profundidad: boolean, camara: boolean,
 *   ios: boolean, android: boolean, seguro: boolean,
 *   motivo: string, recomendacion: string
 * }>}
 */
export async function detectarCapacidades() {
    const ios = esIOS();
    const android = esAndroid();
    const seguro = (typeof window !== 'undefined') && window.isSecureContext === true;
    const camara = !!(typeof navigator !== 'undefined' && navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function');
    const webxr = !!(typeof navigator !== 'undefined' && navigator.xr &&
        typeof navigator.xr.isSessionSupported === 'function');

    let arInmersivo = false;
    if (webxr && seguro) {
        try {
            arInmersivo = await navigator.xr.isSessionSupported('immersive-ar') === true;
        } catch (e) {
            // Algunos navegadores lanzan SecurityError si la política de permisos
            // bloquea 'xr-spatial-tracking'; se trata como "no soportado".
            arInmersivo = false;
        }
    }

    const profundidad = arInmersivo && hayApiProfundidad();
    const soportado = !!(seguro && webxr && arInmersivo && profundidad && !ios);

    let motivo;
    let recomendacion;

    if (!seguro) {
        motivo = 'Se requiere HTTPS: el navegador bloquea la cámara y la realidad aumentada en conexiones no seguras.';
        recomendacion = 'Abre JoseMaps desde su dirección https:// (o desde localhost si estás probando) y vuelve a intentarlo.';
    } else if (ios) {
        motivo = 'Safari no permite acceder al LiDAR: iOS no expone WebXR ni el sensor de profundidad a las páginas web.';
        recomendacion = 'Usa la app JoseScan para iPhone/iPad para escanear con LiDAR; el archivo .josescan se importa después en JoseMaps.';
    } else if (!webxr) {
        motivo = 'Este navegador no implementa WebXR, así que no hay forma de leer profundidad ni de iniciar una sesión de realidad aumentada.';
        recomendacion = android
            ? 'Abre JoseMaps en Google Chrome 90 o superior y actualiza los "Servicios de Google Play para RA" (ARCore).'
            : 'El escaneo 3D funciona en teléfonos Android con ARCore o en iPhone/iPad con la app JoseScan.';
    } else if (!arInmersivo) {
        motivo = 'El navegador tiene WebXR pero el dispositivo no admite sesiones de realidad aumentada inmersiva (falta ARCore o no está soportado el equipo).';
        recomendacion = android
            ? 'Instala o actualiza "Servicios de Google Play para RA" (ARCore) desde Play Store y reinicia el navegador.'
            : 'Escanea desde un teléfono Android compatible con ARCore, o usa la app JoseScan en iPhone/iPad.';
    } else if (!profundidad) {
        motivo = 'Tu navegador no expone el sensor de profundidad (falta la API depth-sensing de WebXR).';
        recomendacion = 'Actualiza Chrome a una versión reciente; si el equipo no tiene ARCore Depth API, no es posible escanear desde el navegador.';
    } else {
        motivo = 'Dispositivo compatible: WebXR con sensor de profundidad disponible. La profundidad la calcula ARCore (no es un LiDAR), así que la nube es aproximada.';
        recomendacion = 'Sostén el teléfono con firmeza, muévete despacio alrededor del objeto y mantén la superficie entre 0,3 y 5 metros.';
    }

    return { soportado, webxr, profundidad, camara, ios, android, seguro, motivo, recomendacion };
}

/* ------------------------------------------------------------------ *
 * Color por profundidad
 * ------------------------------------------------------------------ */

/**
 * Rampa de color usada cuando NO se puede leer la imagen de la cámara
 * (lo habitual: el navegador no concede `camera-access`).
 * Cerca = ámbar cálido, lejos = azul frío. Queda documentado en los metadatos
 * mediante `colorOrigen: 'profundidad'`.
 * @param {number} metros
 * @returns {number[]} [r, g, b] en 0..255
 */
function rampaProfundidad(metros) {
    const t = Math.min(1, Math.max(0, (metros - PROFUNDIDAD_MIN_M) / (5.0 - PROFUNDIDAD_MIN_M)));
    // Ámbar (255,176,32) -> verde azulado (32,190,180) -> azul (40,80,220)
    let r, g, b;
    if (t < 0.5) {
        const k = t / 0.5;
        r = 255 + (32 - 255) * k;
        g = 176 + (190 - 176) * k;
        b = 32 + (180 - 32) * k;
    } else {
        const k = (t - 0.5) / 0.5;
        r = 32 + (40 - 32) * k;
        g = 190 + (80 - 190) * k;
        b = 180 + (220 - 180) * k;
    }
    return [r | 0, g | 0, b | 0];
}

/**
 * Confianza estimada (0 baja, 1 media, 2 alta) según el contrato PLY.
 * WebXR no entrega confianza por píxel, así que se deriva de la distancia:
 * ARCore es fiable de cerca y degrada rápido más allá de 4-5 m.
 * @param {number} metros
 * @returns {number}
 */
function confianzaPorDistancia(metros) {
    if (metros <= 2.5) return 2;
    if (metros <= 4.5) return 1;
    return 0;
}

/** UUID en mayúsculas, compatible con `Foundation.UUID` de la app iOS. */
function nuevoUUID() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID().toUpperCase();
        }
    } catch (e) { /* seguimos con el respaldo */ }
    const hex = '0123456789ABCDEF';
    let s = '';
    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) { s += '-'; continue; }
        if (i === 14) { s += '4'; continue; }
        s += hex[(Math.random() * 16) | 0];
    }
    return s;
}

/** Nombre legible del equipo a partir del user agent (mejor esfuerzo). */
function describirDispositivo() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const m = ua.match(/Android[^;]*;\s*([^;)]+)\s*(?:Build|\))/i);
    if (m && m[1]) return m[1].trim();
    if (esIOS()) return 'iPhone/iPad';
    return 'Navegador web';
}

/** Sistema operativo aproximado a partir del user agent. */
function describirSistema() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const and = ua.match(/Android\s+([\d.]+)/i);
    if (and) return 'Android ' + and[1];
    const ios = ua.match(/OS\s+(\d+[_\d]*)\s+like Mac OS X/i);
    if (ios) return 'iOS ' + ios[1].replace(/_/g, '.');
    return 'Web';
}

/* ------------------------------------------------------------------ *
 * Escáner
 * ------------------------------------------------------------------ */

export class LidarScanner {
    /**
     * @param {Object} [opciones]
     * @param {number} [opciones.maxPuntos=400000]   Tope de puntos acumulados.
     * @param {number} [opciones.tamanoVoxel=0.03]   Arista del vóxel en metros.
     * @param {number} [opciones.submuestreo=4]      Se toma 1 de cada N píxeles por eje.
     * @param {boolean} [opciones.capturarColor=true] Intentar color real de cámara.
     * @param {string} [opciones.nombre]             Nombre del escaneo (escaneo.json).
     * @param {string} [opciones.proyecto]           Proyecto al que pertenece.
     * @param {string} [opciones.notas]              Notas libres.
     * @param {Object} [opciones.geo]                Posición GPS del origen (ver fijarGeoreferencia).
     * @param {number} [opciones.rumbo]              Rumbo verdadero en grados del eje -Z.
     */
    constructor(opciones = {}) {
        const o = opciones || {};

        this.maxPuntos = Math.max(1000, parseInt(o.maxPuntos, 10) || 400000);
        this.tamanoVoxel = Math.max(0.005, Number(o.tamanoVoxel) || 0.03);
        this.submuestreo = Math.max(1, parseInt(o.submuestreo, 10) || 4);
        this.capturarColor = o.capturarColor !== false;

        this.nombre = typeof o.nombre === 'string' ? o.nombre : 'Escaneo JoseScan Web';
        this.proyecto = typeof o.proyecto === 'string' ? o.proyecto : 'Proyecto General';
        this.notas = typeof o.notas === 'string' ? o.notas : '';

        /** Tamaño de vóxel actual (crece si se llena el presupuesto de puntos). */
        this._voxelActual = this.tamanoVoxel;

        // --- Estado de la sesión --------------------------------------
        this._session = null;
        this._refSpace = null;
        this._gl = null;
        this._canvas = null;
        this._contenedor = null;
        this._rafId = null;
        this._binding = null;
        this._activo = false;
        this._pausado = false;
        this._deteniendo = false;
        this._resultado = null;
        this._id = nuevoUUID();
        this._inicio = 0;
        this._fin = 0;

        // --- Acumulador de nube ---------------------------------------
        this._capacidad = Math.min(this.maxPuntos, 65536);
        this._pos = new Float32Array(this._capacidad * 3);
        this._col = new Uint8Array(this._capacidad * 3);
        this._conf = new Uint8Array(this._capacidad);
        this._n = 0;
        this._voxeles = new Map();

        // --- Georreferenciación opcional -------------------------------
        this._geo = null;
        this._rumbo = null;
        if (o.geo) this.fijarGeoreferencia(o.geo, o.rumbo);

        // --- Métricas y eventos ---------------------------------------
        this._listeners = new Map();
        this._ultimoEventoPuntos = 0;
        this._ultimaLecturaCamara = 0;
        this._marcaFps = 0;
        this._framesFps = 0;
        this._fps = 0;
        this._colorDeCamara = false;   // true sólo si se logró leer la imagen
        this._origenColor = 'profundidad';

        // --- Recursos WebGL de dibujo ---------------------------------
        this._programa = null;
        this._bufPos = null;
        this._bufCol = null;
        this._locPos = -1;
        this._locCol = -1;
        this._locVP = null;
        this._subidos = 0;          // puntos ya enviados a la GPU
        this._reSubirTodo = false;
        this._fboLectura = null;
        this._pixelesCamara = null;
        this._camAncho = 0;
        this._camAlto = 0;

        // --- Buffers de trabajo reutilizables --------------------------
        this._invProy = new Float32Array(16);
        this._vp = new Float32Array(16);
        this._tmpA = [0, 0, 0];
        this._tmpB = [0, 0, 0];

        this._alFinalizarSesion = this._alFinalizarSesion.bind(this);
        this._bucle = this._bucle.bind(this);
    }

    /* -------------------- Propiedades públicas -------------------- */

    /** @returns {boolean} true mientras hay una sesión de escaneo viva. */
    get activo() {
        return this._activo === true;
    }

    /** @returns {number} puntos únicos acumulados. */
    get conteo() {
        return this._n;
    }

    /** @returns {boolean} true si el escaneo está en pausa. */
    get pausado() {
        return this._pausado === true;
    }

    /* -------------------- Eventos -------------------- */

    /**
     * Suscribe un callback. Eventos: 'estado' | 'puntos' | 'error' | 'fin'.
     * @param {string} evento
     * @param {Function} cb
     * @returns {Function} función para cancelar la suscripción.
     */
    on(evento, cb) {
        if (typeof evento !== 'string' || typeof cb !== 'function') return () => {};
        if (!this._listeners.has(evento)) this._listeners.set(evento, new Set());
        this._listeners.get(evento).add(cb);
        return () => this.off(evento, cb);
    }

    /**
     * Cancela una suscripción.
     * @param {string} evento
     * @param {Function} cb
     */
    off(evento, cb) {
        const conjunto = this._listeners.get(evento);
        if (conjunto) conjunto.delete(cb);
    }

    /** Emite un evento sin dejar que un suscriptor roto rompa el escaneo. */
    _emitir(evento, datos) {
        const conjunto = this._listeners.get(evento);
        if (!conjunto) return;
        conjunto.forEach((cb) => {
            try {
                cb(datos);
            } catch (e) {
                console.error('[JoseScan] Error en el suscriptor de "' + evento + '":', e);
            }
        });
    }

    /** Atajo para el evento 'estado'. */
    _estado(mensaje, codigo) {
        this._emitir('estado', { mensaje, codigo: codigo || 'info' });
    }

    /** Atajo para el evento 'error'; nunca lanza. */
    _error(mensaje, causa) {
        if (causa) console.warn('[JoseScan]', mensaje, causa);
        this._emitir('error', {
            mensaje,
            detalle: causa && causa.message ? causa.message : String(causa || '')
        });
    }

    /* -------------------- Georreferenciación -------------------- */

    /**
     * Fija el origen geográfico del escaneo. Si se aporta también el rumbo,
     * la nube se entrega en marco `enu` (Este/Norte/Arriba); si no, en `arkit`.
     *
     * @param {{lat?:number, latitude?:number, lng?:number, longitude?:number,
     *          altitude?:number|null, accuracy?:number, heading?:number|null}} geo
     * @param {number} [rumboGrados] Rumbo verdadero del eje -Z de la cámara.
     */
    fijarGeoreferencia(geo, rumboGrados) {
        if (!geo) { this._geo = null; this._rumbo = null; return; }
        const lat = Number(geo.latitude !== undefined ? geo.latitude : geo.lat);
        const lng = Number(geo.longitude !== undefined ? geo.longitude : geo.lng);
        if (!isFinite(lat) || !isFinite(lng)) { this._geo = null; this._rumbo = null; return; }

        this._geo = {
            latitude: lat,
            longitude: lng,
            altitude: (geo.altitude === null || geo.altitude === undefined) ? null : Number(geo.altitude),
            horizontalAccuracy: isFinite(Number(geo.accuracy)) ? Number(geo.accuracy) : null,
            verticalAccuracy: null,
            heading: (geo.heading === null || geo.heading === undefined) ? null : Number(geo.heading),
            headingAccuracy: null,
            timestamp: new Date().toISOString()
        };

        const rumbo = (rumboGrados === undefined || rumboGrados === null)
            ? this._geo.heading
            : Number(rumboGrados);
        this._rumbo = (rumbo === null || !isFinite(rumbo)) ? null : ((rumbo % 360) + 360) % 360;
    }

    /* -------------------- Ciclo de vida -------------------- */

    /**
     * Arranca la sesión de escaneo dentro del contenedor indicado.
     * @param {HTMLElement} contenedor Elemento que actúa de `dom-overlay`.
     * @returns {Promise<boolean>} true si la sesión quedó activa.
     */
    async iniciar(contenedor) {
        if (this._activo) return true;

        if (!contenedor || typeof contenedor.appendChild !== 'function') {
            this._error('No se recibió un contenedor válido para el escáner.');
            return false;
        }

        const cap = await detectarCapacidades();
        if (!cap.soportado) {
            this._error(cap.motivo + ' ' + cap.recomendacion);
            return false;
        }

        this._contenedor = contenedor;
        this._deteniendo = false;
        this._resultado = null;
        this._estado('Preparando la cámara…', 'preparando');

        // 1) Lienzo y contexto WebGL compatibles con XR
        try {
            this._crearLienzo(contenedor);
        } catch (e) {
            this._error('No se pudo crear el lienzo 3D en este dispositivo.', e);
            this._liberarRecursos();
            return false;
        }

        // 2) Sesión WebXR inmersiva con sensado de profundidad
        const opcionales = OPCIONALES_BASE.slice();
        // 'camera-access' es opcional: sólo se usa para tomar el color real.
        if (this.capturarColor) opcionales.push('camera-access');

        let sesion;
        try {
            sesion = await navigator.xr.requestSession('immersive-ar', {
                requiredFeatures: ['depth-sensing'],
                optionalFeatures: opcionales,
                depthSensing: {
                    usagePreference: ['cpu-optimized', 'gpu-optimized'],
                    dataFormatPreference: ['luminance-alpha', 'float32']
                },
                domOverlay: { root: contenedor }
            });
        } catch (e) {
            this._liberarRecursos();
            const nombre = e && e.name ? e.name : '';
            if (nombre === 'NotAllowedError') {
                this._error('Permiso denegado: hay que autorizar la cámara para poder escanear.', e);
            } else if (nombre === 'NotSupportedError') {
                this._error('Este dispositivo no admite el sensado de profundidad de WebXR; usa la app JoseScan en iPhone/iPad.', e);
            } else {
                this._error('No se pudo iniciar la sesión de realidad aumentada.', e);
            }
            return false;
        }

        this._session = sesion;

        try {
            sesion.addEventListener('end', this._alFinalizarSesion);

            // Algunos navegadores exigen marcar el contexto como compatible con XR
            if (typeof this._gl.makeXRCompatible === 'function') {
                await this._gl.makeXRCompatible();
            }
            const capa = new XRWebGLLayer(sesion, this._gl, { alpha: true, depth: true, antialias: false });
            sesion.updateRenderState({ baseLayer: capa });

            // Espacio de referencia: 'local' basta para un escaneo de decenas de metros.
            try {
                this._refSpace = await sesion.requestReferenceSpace('local');
            } catch (e) {
                this._refSpace = await sesion.requestReferenceSpace('viewer');
            }

            if (this.capturarColor && typeof window.XRWebGLBinding === 'function') {
                try {
                    this._binding = new XRWebGLBinding(sesion, this._gl);
                } catch (e) {
                    this._binding = null; // se seguirá coloreando por profundidad
                }
            }

            this._prepararPrograma();
        } catch (e) {
            this._error('Falló la configuración de la sesión de realidad aumentada.', e);
            try { await sesion.end(); } catch (e2) { /* la sesión ya podría estar muerta */ }
            this._liberarRecursos();
            return false;
        }

        this._activo = true;
        this._pausado = false;
        this._inicio = Date.now();
        this._fin = 0;
        this._marcaFps = 0;
        this._framesFps = 0;
        this._estado('Buscando superficies…', 'buscando');

        this._rafId = sesion.requestAnimationFrame(this._bucle);
        return true;
    }

    /**
     * Cierra la sesión y devuelve el resultado del escaneo. Es idempotente:
     * llamarla de nuevo devuelve el mismo resultado sin efectos secundarios.
     * @returns {Promise<{nube:Object, metadatos:Object, duracionSegundos:number}>}
     */
    async detener() {
        if (this._resultado && !this._activo) return this._resultado;

        this._deteniendo = true;

        const sesion = this._session;
        if (sesion) {
            if (this._rafId !== null) {
                try { sesion.cancelAnimationFrame(this._rafId); } catch (e) { /* sesión ya cerrada */ }
                this._rafId = null;
            }
            try {
                await sesion.end();
            } catch (e) {
                // Si la sesión ya terminó por su cuenta no es un error real.
            }
        }

        // `_alFinalizarSesion` puede haberse disparado ya y haber creado el resultado.
        if (!this._resultado) this._finalizar();
        return this._resultado;
    }

    /** Detiene la acumulación de puntos sin cerrar la sesión. */
    pausar() {
        if (!this._activo || this._pausado) return;
        this._pausado = true;
        this._estado('Escaneo en pausa.', 'pausa');
    }

    /** Reanuda la acumulación de puntos. */
    reanudar() {
        if (!this._activo || !this._pausado) return;
        this._pausado = false;
        this._estado('Escaneando…', 'escaneando');
    }

    /** Vacía la nube acumulada y vuelve a empezar sin cerrar la sesión. */
    reiniciar() {
        this._n = 0;
        this._voxeles.clear();
        this._voxelActual = this.tamanoVoxel;
        this._subidos = 0;
        this._reSubirTodo = true;
        this._id = nuevoUUID();
        this._inicio = Date.now();
        this._resultado = null;
        this._origenColor = this._colorDeCamara ? 'camara' : 'profundidad';
        this._estado('Escaneo reiniciado. Buscando superficies…', 'buscando');
        this._emitir('puntos', { count: 0, fps: this._fps });
    }

    /* -------------------- Salidas -------------------- */

    /**
     * Copia de la nube acumulada. Si hay georreferencia con rumbo se entrega en
     * marco `enu` (X=Este, Y=Norte, Z=Arriba); si no, en marco `arkit`.
     * @returns {{positions:Float32Array, colors:Uint8Array, confidences:Uint8Array,
     *            count:number, frame:'arkit'|'enu'}}
     */
    obtenerNube() {
        const n = this._n;
        const colors = this._col.slice(0, n * 3);
        const confidences = this._conf.slice(0, n);
        const enu = !!(this._geo && this._rumbo !== null);
        const positions = new Float32Array(n * 3);

        if (!enu) {
            positions.set(this._pos.subarray(0, n * 3));
            return { positions, colors, confidences, count: n, frame: 'arkit' };
        }

        // Conversión ARKit -> ENU documentada en docs/FORMATO-ESCANEO.md:
        //   este   =  x·cos h - z·sin h
        //   norte  = -x·sin h - z·cos h
        //   arriba = y
        const h = this._rumbo * Math.PI / 180;
        const cs = Math.cos(h);
        const sn = Math.sin(h);
        for (let i = 0; i < n; i++) {
            const x = this._pos[i * 3];
            const y = this._pos[i * 3 + 1];
            const z = this._pos[i * 3 + 2];
            positions[i * 3] = x * cs - z * sn;
            positions[i * 3 + 1] = -x * sn - z * cs;
            positions[i * 3 + 2] = y;
        }
        return { positions, colors, confidences, count: n, frame: 'enu' };
    }

    /**
     * Metadatos compatibles con `escaneo.json` (`josescan/1.0`, sensor `webxr`).
     * @returns {Object}
     */
    obtenerMetadatos() {
        const nube = this.obtenerNube();
        const bbox = this._calcularBbox(nube.positions, nube.count);
        const fin = this._fin || Date.now();
        const duracion = this._inicio ? Math.max(0, (fin - this._inicio) / 1000) : 0;

        const meta = {
            formato: FORMATO,
            id: this._id,
            nombre: this.nombre,
            creado: new Date(this._inicio || Date.now()).toISOString(),
            dispositivo: describirDispositivo(),
            sistema: describirSistema(),
            sensor: 'webxr',
            marco: nube.frame,
            geo: null,
            puntos: nube.count,
            vertices: 0,
            triangulos: 0,
            bbox,
            duracionSegundos: Math.round(duracion * 10) / 10,
            mediciones: [],
            proyecto: this.proyecto,
            notas: this.notas,
            archivoNube: 'nube.ply',
            archivoMalla: null,
            archivoMiniatura: null,
            // Extras informativos propios del origen web (los lectores los ignoran)
            origenColor: this._origenColor,
            tamanoVoxel: Math.round(this._voxelActual * 1000) / 1000,
            submuestreo: this.submuestreo
        };

        if (this._geo) {
            meta.geo = Object.assign({}, this._geo);
            try {
                const magna = toMagnaSirgas(this._geo.latitude, this._geo.longitude);
                meta.geo.norte = magna.norte;
                meta.geo.este = magna.este;
            } catch (e) {
                // Sin proj4 cargado no hay MAGNA-SIRGAS; el resto del JSON sigue siendo válido.
                meta.geo.norte = null;
                meta.geo.este = null;
            }
        }

        return meta;
    }

    /* -------------------- Bucle de render / captura -------------------- */

    /**
     * Callback de `session.requestAnimationFrame`. Nunca debe lanzar: cualquier
     * fallo se reporta por el evento 'error' y el bucle continúa.
     * @param {number} tiempo
     * @param {XRFrame} frame
     */
    _bucle(tiempo, frame) {
        if (!this._activo || this._deteniendo) return;
        const sesion = this._session;
        if (!sesion) return;

        // Se vuelve a pedir el frame antes de trabajar para no perder cadencia.
        try {
            this._rafId = sesion.requestAnimationFrame(this._bucle);
        } catch (e) {
            this._rafId = null;
            return;
        }

        try {
            const pose = frame.getViewerPose(this._refSpace);
            if (!pose) {
                // Sin pose el seguimiento está perdido (movimiento brusco, poca luz).
                this._estado('Buscando superficies…', 'buscando');
                return;
            }

            this._contarFps(tiempo);

            const capa = sesion.renderState && sesion.renderState.baseLayer;
            const gl = this._gl;
            if (gl && capa) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, capa.framebuffer);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            }

            const antes = this._n;

            for (const vista of pose.views) {
                if (!this._pausado) this._acumularDeVista(frame, vista);
                if (gl && capa) this._dibujarVista(vista, capa);
            }

            if (this._n > antes && !this._pausado) {
                this._notificarPuntos(tiempo);
                if (this._n > 0) this._estado('Escaneando…', 'escaneando');
            }
        } catch (e) {
            this._error('Error procesando un fotograma del escaneo.', e);
        }
    }

    /** Actualiza el contador de fotogramas por segundo. */
    _contarFps(tiempo) {
        this._framesFps++;
        if (this._marcaFps === 0) { this._marcaFps = tiempo; return; }
        const dt = tiempo - this._marcaFps;
        if (dt >= 1000) {
            this._fps = Math.round((this._framesFps * 1000) / dt);
            this._framesFps = 0;
            this._marcaFps = tiempo;
        }
    }

    /** Emite 'puntos' como mucho 5 veces por segundo. */
    _notificarPuntos(tiempo) {
        if (tiempo - this._ultimoEventoPuntos < MS_ENTRE_EVENTOS_PUNTOS) return;
        this._ultimoEventoPuntos = tiempo;
        this._emitir('puntos', { count: this._n, fps: this._fps });
    }

    /**
     * Lee el mapa de profundidad de una vista y añade los puntos al vóxel-grid.
     * @param {XRFrame} frame
     * @param {XRView} vista
     */
    _acumularDeVista(frame, vista) {
        if (typeof frame.getDepthInformation !== 'function') return;

        let info;
        try {
            info = frame.getDepthInformation(vista);
        } catch (e) {
            return; // el fotograma aún no tiene profundidad válida
        }
        if (!info || !info.width || !info.height) return;

        const invProy = invertirMat4(vista.projectionMatrix, this._invProy);
        if (!invProy) return;
        const mundoDesdeVista = vista.transform.matrix;

        // Color real de cámara (si el navegador lo permite); si no, rampa por profundidad.
        const usarCamara = this._prepararColorCamara(vista);

        const paso = this.submuestreo;
        const ancho = info.width;
        const alto = info.height;

        // Datos crudos por si `getDepthInMeters` no está disponible.
        const datos = this._vistaDeDatos(info);
        const escala = typeof info.rawValueToMeters === 'number' ? info.rawValueToMeters : 0.001;
        const mBufDesdeVista = (info.normDepthBufferFromNormView && info.normDepthBufferFromNormView.matrix)
            ? info.normDepthBufferFromNormView.matrix
            : null;
        const tieneMetodo = typeof info.getDepthInMeters === 'function';

        for (let fy = 0; fy < alto; fy += paso) {
            // Coordenadas normalizadas de vista (0..1), origen arriba-izquierda.
            const v = (fy + 0.5) / alto;
            for (let fx = 0; fx < ancho; fx += paso) {
                const u = (fx + 0.5) / ancho;

                const d = this._profundidadEn(info, u, v, tieneMetodo, datos, mBufDesdeVista, escala, ancho, alto);
                if (!(d > PROFUNDIDAD_MIN_M && d < PROFUNDIDAD_MAX_M)) continue;

                // 1) NDC: X hacia la derecha, Y hacia arriba (por eso se invierte v).
                const ndcX = u * 2 - 1;
                const ndcY = 1 - v * 2;

                // 2) Retroproyección al espacio de vista con la inversa de la proyección.
                const cerca = transformarPunto(invProy, ndcX, ndcY, -1, this._tmpA);
                if (!cerca || cerca[2] >= -1e-6) continue;

                // 3) Se escala el rayo hasta que su componente -Z valga la profundidad medida.
                const k = d / (-cerca[2]);
                const vx = cerca[0] * k;
                const vy = cerca[1] * k;
                const vz = cerca[2] * k;

                // 4) Espacio de vista -> espacio de referencia (mundo).
                const mundo = transformarPunto(mundoDesdeVista, vx, vy, vz, this._tmpB);
                if (!mundo) continue;

                let color;
                if (usarCamara) {
                    color = this._colorDeCamaraEn(u, v) || rampaProfundidad(d);
                } else {
                    color = rampaProfundidad(d);
                }

                this._agregarPunto(mundo[0], mundo[1], mundo[2], color, confianzaPorDistancia(d));
            }
        }
    }

    /**
     * Devuelve la profundidad en metros en coordenadas normalizadas de vista.
     * Usa `getDepthInMeters` cuando existe y, si no, lee el buffer a mano
     * soportando `luminance-alpha` (Uint16) y `float32` (Float32).
     * @returns {number} metros, o NaN si no hay dato válido.
     */
    _profundidadEn(info, u, v, tieneMetodo, datos, mBufDesdeVista, escala, ancho, alto) {
        if (tieneMetodo) {
            try {
                const m = info.getDepthInMeters(u, v);
                if (isFinite(m)) return m;
            } catch (e) {
                // Fuera del área válida del mapa: se intenta la lectura manual.
            }
        }
        if (!datos) return NaN;

        // Coordenadas normalizadas de vista -> normalizadas del buffer de profundidad.
        let bu = u;
        let bv = v;
        if (mBufDesdeVista) {
            const p = transformarPunto(mBufDesdeVista, u, v, 0, this._tmpA);
            if (!p) return NaN;
            bu = p[0];
            bv = p[1];
        }
        if (bu < 0 || bu >= 1 || bv < 0 || bv >= 1) return NaN;

        const px = Math.min(ancho - 1, Math.max(0, Math.floor(bu * ancho)));
        const py = Math.min(alto - 1, Math.max(0, Math.floor(bv * alto)));
        const bruto = datos[py * ancho + px];
        if (!isFinite(bruto) || bruto === 0) return NaN;
        return bruto * escala;
    }

    /**
     * Envuelve `info.data` según el formato declarado.
     * - 'luminance-alpha': 2 bytes por muestra -> Uint16Array (valor crudo).
     * - 'float32'        : 4 bytes por muestra -> Float32Array (metros ya escalados
     *                      por `rawValueToMeters`, que en ese formato vale 1).
     * @returns {Uint16Array|Float32Array|null}
     */
    _vistaDeDatos(info) {
        try {
            if (!info.data) return null;
            const formato = info.dataFormat || 'luminance-alpha';
            if (formato === 'float32') return new Float32Array(info.data);
            return new Uint16Array(info.data);
        } catch (e) {
            return null;
        }
    }

    /* -------------------- Acumulación en vóxeles -------------------- */

    /**
     * Añade un punto si su vóxel está libre. Al alcanzar `maxPuntos` se duplica
     * el tamaño de vóxel y se recompacta la nube (se conserva el primer punto de
     * cada vóxel nuevo), de modo que el escaneo puede seguir indefinidamente.
     */
    _agregarPunto(x, y, z, color, confianza) {
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;

        const t = this._voxelActual;
        const ix = Math.floor(x / t);
        const iy = Math.floor(y / t);
        const iz = Math.floor(z / t);
        const clave = ix + ',' + iy + ',' + iz;
        if (this._voxeles.has(clave)) return;

        if (this._n >= this.maxPuntos) {
            this._recompactar();
            // Tras recompactar cambia el tamaño de vóxel: se recalcula la clave.
            const t2 = this._voxelActual;
            const clave2 = Math.floor(x / t2) + ',' + Math.floor(y / t2) + ',' + Math.floor(z / t2);
            if (this._voxeles.has(clave2)) return;
            if (this._n >= this.maxPuntos) return; // salvaguarda: nube saturada
            this._escribirPunto(clave2, x, y, z, color, confianza);
            return;
        }

        this._escribirPunto(clave, x, y, z, color, confianza);
    }

    /** Escribe el punto en los arrays y registra su vóxel. */
    _escribirPunto(clave, x, y, z, color, confianza) {
        if (this._n >= this._capacidad) this._ampliarCapacidad();
        const i = this._n;
        this._pos[i * 3] = x;
        this._pos[i * 3 + 1] = y;
        this._pos[i * 3 + 2] = z;
        this._col[i * 3] = color[0];
        this._col[i * 3 + 1] = color[1];
        this._col[i * 3 + 2] = color[2];
        this._conf[i] = confianza;
        this._voxeles.set(clave, i);
        this._n = i + 1;
    }

    /** Duplica la capacidad de los arrays sin superar `maxPuntos`. */
    _ampliarCapacidad() {
        const nueva = Math.min(this.maxPuntos, Math.max(1024, this._capacidad * 2));
        if (nueva === this._capacidad) return;
        const pos = new Float32Array(nueva * 3);
        const col = new Uint8Array(nueva * 3);
        const conf = new Uint8Array(nueva);
        pos.set(this._pos.subarray(0, this._n * 3));
        col.set(this._col.subarray(0, this._n * 3));
        conf.set(this._conf.subarray(0, this._n));
        this._pos = pos;
        this._col = col;
        this._conf = conf;
        this._capacidad = nueva;
        this._reSubirTodo = true;   // los buffers de GPU quedan obsoletos
    }

    /**
     * Duplica el tamaño de vóxel y compacta la nube en sitio: se recorre en
     * orden y se conserva el primer punto de cada vóxel nuevo. Reduce el conteo
     * aproximadamente a la mitad o menos, dejando espacio para seguir escaneando.
     */
    _recompactar() {
        this._voxelActual *= 2;
        const t = this._voxelActual;
        const nuevos = new Map();
        let escritos = 0;

        for (let i = 0; i < this._n; i++) {
            const x = this._pos[i * 3];
            const y = this._pos[i * 3 + 1];
            const z = this._pos[i * 3 + 2];
            const clave = Math.floor(x / t) + ',' + Math.floor(y / t) + ',' + Math.floor(z / t);
            if (nuevos.has(clave)) continue;
            const j = escritos;
            this._pos[j * 3] = x;
            this._pos[j * 3 + 1] = y;
            this._pos[j * 3 + 2] = z;
            this._col[j * 3] = this._col[i * 3];
            this._col[j * 3 + 1] = this._col[i * 3 + 1];
            this._col[j * 3 + 2] = this._col[i * 3 + 2];
            this._conf[j] = this._conf[i];
            nuevos.set(clave, j);
            escritos++;
        }

        this._voxeles = nuevos;
        this._n = escritos;
        this._subidos = 0;
        this._reSubirTodo = true;
        this._estado('Nube compactada a ' + (Math.round(t * 1000)) + ' mm por vóxel.', 'compactado');
    }

    /** Caja envolvente de la nube en el marco que se esté entregando. */
    _calcularBbox(positions, count) {
        if (!count) return { min: [0, 0, 0], max: [0, 0, 0] };
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < count; i++) {
            const x = positions[i * 3];
            const y = positions[i * 3 + 1];
            const z = positions[i * 3 + 2];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
        const r = (v) => Math.round(v * 1000) / 1000;
        return { min: [r(minX), r(minY), r(minZ)], max: [r(maxX), r(maxY), r(maxZ)] };
    }

    /* -------------------- Color desde la cámara -------------------- */

    /**
     * Intenta refrescar la imagen de cámara (como mucho cada 200 ms).
     * Requiere que el navegador haya concedido 'camera-access' y exponga
     * `XRWebGLBinding.getCameraImage`. Si falla una vez, se desactiva para
     * el resto de la sesión y se pasa a colorear por profundidad.
     * @returns {boolean} true si hay píxeles utilizables.
     */
    _prepararColorCamara(vista) {
        if (!this.capturarColor || !this._binding || !this._gl) return false;
        const camara = vista.camera;
        if (!camara || typeof this._binding.getCameraImage !== 'function') return false;

        const ahora = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (this._pixelesCamara && (ahora - this._ultimaLecturaCamara) < MS_ENTRE_LECTURAS_CAMARA) {
            return true; // se reutiliza la última lectura
        }

        const gl = this._gl;
        const anchoCam = camara.width | 0;
        const altoCam = camara.height | 0;
        if (!anchoCam || !altoCam) return false;

        try {
            const textura = this._binding.getCameraImage(camara);
            if (!textura) return false;

            if (!this._fboLectura) this._fboLectura = gl.createFramebuffer();
            const fboPrevio = gl.getParameter(gl.FRAMEBUFFER_BINDING);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboLectura);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textura, 0);

            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, fboPrevio);
                this._binding = null;
                return false;
            }

            if (!this._pixelesCamara || this._camAncho !== anchoCam || this._camAlto !== altoCam) {
                this._pixelesCamara = new Uint8Array(anchoCam * altoCam * 4);
                this._camAncho = anchoCam;
                this._camAlto = altoCam;
            }
            gl.readPixels(0, 0, anchoCam, altoCam, gl.RGBA, gl.UNSIGNED_BYTE, this._pixelesCamara);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboPrevio);

            this._ultimaLecturaCamara = ahora;
            this._colorDeCamara = true;
            this._origenColor = 'camara';
            return true;
        } catch (e) {
            // Sin acceso a la imagen: se colorea por profundidad el resto de la sesión.
            this._binding = null;
            this._pixelesCamara = null;
            this._colorDeCamara = false;
            this._origenColor = 'profundidad';
            return false;
        }
    }

    /**
     * Muestrea el color de la imagen de cámara en coordenadas normalizadas de
     * vista. Se asume que la imagen cubre el mismo encuadre que la vista
     * (aproximación razonable en ARCore); `readPixels` entrega las filas de
     * abajo hacia arriba, por eso se invierte la coordenada vertical.
     * @returns {number[]|null}
     */
    _colorDeCamaraEn(u, v) {
        const px = this._pixelesCamara;
        if (!px) return null;
        const x = Math.min(this._camAncho - 1, Math.max(0, Math.floor(u * this._camAncho)));
        const y = Math.min(this._camAlto - 1, Math.max(0, Math.floor((1 - v) * this._camAlto)));
        const i = (y * this._camAncho + x) * 4;
        return [px[i], px[i + 1], px[i + 2]];
    }

    /* -------------------- Lienzo y dibujo -------------------- */

    /** Crea el canvas dentro del contenedor y su contexto WebGL. */
    _crearLienzo(contenedor) {
        const canvas = document.createElement('canvas');
        canvas.className = 'josescan-lienzo';
        canvas.style.position = 'absolute';
        canvas.style.inset = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.style.touchAction = 'none';

        const atributos = { xrCompatible: true, alpha: true, antialias: false, depth: true, preserveDrawingBuffer: false };
        const gl = canvas.getContext('webgl2', atributos) || canvas.getContext('webgl', atributos);
        if (!gl) throw new Error('WebGL no disponible.');

        contenedor.appendChild(canvas);
        this._canvas = canvas;
        this._gl = gl;
    }

    /**
     * Compila el programa de puntos. Si algo falla, el escaneo continúa sin
     * previsualización (la nube se sigue acumulando igual).
     */
    _prepararPrograma() {
        const gl = this._gl;
        if (!gl) return;

        const vsFuente = [
            'attribute vec3 aPos;',
            'attribute vec3 aCol;',
            'uniform mat4 uVP;',
            'varying vec3 vCol;',
            'void main() {',
            '  vec4 p = uVP * vec4(aPos, 1.0);',
            '  gl_Position = p;',
            '  gl_PointSize = clamp(7.0 / max(p.w, 0.25), 2.0, 10.0);',
            '  vCol = aCol;',
            '}'
        ].join('\n');

        const fsFuente = [
            'precision mediump float;',
            'varying vec3 vCol;',
            'void main() {',
            '  vec2 d = gl_PointCoord - vec2(0.5);',
            '  if (dot(d, d) > 0.25) discard;',   // puntos redondos
            '  gl_FragColor = vec4(vCol, 0.95);',
            '}'
        ].join('\n');

        try {
            const vs = this._compilar(gl.VERTEX_SHADER, vsFuente);
            const fs = this._compilar(gl.FRAGMENT_SHADER, fsFuente);
            if (!vs || !fs) return;

            const programa = gl.createProgram();
            gl.attachShader(programa, vs);
            gl.attachShader(programa, fs);
            gl.linkProgram(programa);
            gl.deleteShader(vs);
            gl.deleteShader(fs);

            if (!gl.getProgramParameter(programa, gl.LINK_STATUS)) {
                gl.deleteProgram(programa);
                return;
            }

            this._programa = programa;
            this._locPos = gl.getAttribLocation(programa, 'aPos');
            this._locCol = gl.getAttribLocation(programa, 'aCol');
            this._locVP = gl.getUniformLocation(programa, 'uVP');

            this._bufPos = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufPos);
            gl.bufferData(gl.ARRAY_BUFFER, this._capacidad * 3 * 4, gl.DYNAMIC_DRAW);

            this._bufCol = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufCol);
            gl.bufferData(gl.ARRAY_BUFFER, this._capacidad * 3, gl.DYNAMIC_DRAW);

            this._subidos = 0;
            this._reSubirTodo = true;
        } catch (e) {
            this._programa = null; // se continúa sin previsualización
        }
    }

    /** Compila un shader; devuelve null si hay error de compilación. */
    _compilar(tipo, fuente) {
        const gl = this._gl;
        const sh = gl.createShader(tipo);
        gl.shaderSource(sh, fuente);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.warn('[JoseScan] Shader no compilado:', gl.getShaderInfoLog(sh));
            gl.deleteShader(sh);
            return null;
        }
        return sh;
    }

    /** Sube a la GPU los puntos nuevos (o todos, tras una recompactación). */
    _sincronizarBuffers() {
        const gl = this._gl;
        if (!gl || !this._bufPos || !this._bufCol) return;

        if (this._reSubirTodo) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufPos);
            gl.bufferData(gl.ARRAY_BUFFER, this._capacidad * 3 * 4, gl.DYNAMIC_DRAW);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._pos.subarray(0, this._n * 3));
            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufCol);
            gl.bufferData(gl.ARRAY_BUFFER, this._capacidad * 3, gl.DYNAMIC_DRAW);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._col.subarray(0, this._n * 3));
            this._subidos = this._n;
            this._reSubirTodo = false;
            return;
        }

        if (this._n <= this._subidos) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._bufPos);
        gl.bufferSubData(gl.ARRAY_BUFFER, this._subidos * 3 * 4, this._pos.subarray(this._subidos * 3, this._n * 3));
        gl.bindBuffer(gl.ARRAY_BUFFER, this._bufCol);
        gl.bufferSubData(gl.ARRAY_BUFFER, this._subidos * 3, this._col.subarray(this._subidos * 3, this._n * 3));
        this._subidos = this._n;
    }

    /** Dibuja la nube acumulada desde el punto de vista de una `XRView`. */
    _dibujarVista(vista, capa) {
        const gl = this._gl;
        if (!gl || !this._programa || this._n === 0) return;

        try {
            const vp = capa.getViewport(vista);
            if (!vp) return;
            gl.viewport(vp.x, vp.y, vp.width, vp.height);

            this._sincronizarBuffers();

            // viewProjection = proyección · (mundo -> vista)
            multiplicarMat4(vista.projectionMatrix, vista.transform.inverse.matrix, this._vp);

            gl.useProgram(this._programa);
            gl.uniformMatrix4fv(this._locVP, false, this._vp);

            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);

            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufPos);
            gl.enableVertexAttribArray(this._locPos);
            gl.vertexAttribPointer(this._locPos, 3, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this._bufCol);
            gl.enableVertexAttribArray(this._locCol);
            gl.vertexAttribPointer(this._locCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

            gl.drawArrays(gl.POINTS, 0, this._n);
        } catch (e) {
            // Un fallo de dibujo no debe detener la captura de puntos.
            this._programa = null;
        }
    }

    /* -------------------- Cierre y limpieza -------------------- */

    /** Handler del evento 'end' de la sesión (también si la cierra el sistema). */
    _alFinalizarSesion() {
        if (!this._resultado) this._finalizar();
    }

    /** Construye el resultado, libera recursos y emite 'fin'. Idempotente. */
    _finalizar() {
        if (this._resultado) return this._resultado;

        this._activo = false;
        this._pausado = false;
        this._fin = Date.now();

        let nube;
        let metadatos;
        try {
            nube = this.obtenerNube();
            metadatos = this.obtenerMetadatos();
        } catch (e) {
            this._error('No se pudieron preparar los datos del escaneo.', e);
            nube = { positions: new Float32Array(0), colors: new Uint8Array(0), confidences: new Uint8Array(0), count: 0, frame: 'arkit' };
            metadatos = { formato: FORMATO, id: this._id, sensor: 'webxr', marco: 'arkit', puntos: 0 };
        }

        const duracionSegundos = this._inicio ? Math.max(0, (this._fin - this._inicio) / 1000) : 0;
        this._resultado = {
            nube,
            metadatos,
            duracionSegundos: Math.round(duracionSegundos * 10) / 10
        };

        this._liberarRecursos();

        this._estado('Sesión finalizada', 'fin');
        this._emitir('fin', this._resultado);
        return this._resultado;
    }

    /**
     * Cancela el rAF, quita listeners, borra los recursos WebGL y saca el canvas
     * del contenedor. Se puede llamar varias veces sin efectos adversos.
     */
    _liberarRecursos() {
        const sesion = this._session;
        if (sesion) {
            try { sesion.removeEventListener('end', this._alFinalizarSesion); } catch (e) { /* nada que hacer */ }
            if (this._rafId !== null) {
                try { sesion.cancelAnimationFrame(this._rafId); } catch (e) { /* sesión cerrada */ }
            }
        }
        this._rafId = null;
        this._session = null;
        this._refSpace = null;
        this._binding = null;
        this._pixelesCamara = null;

        const gl = this._gl;
        if (gl) {
            try {
                if (this._bufPos) gl.deleteBuffer(this._bufPos);
                if (this._bufCol) gl.deleteBuffer(this._bufCol);
                if (this._fboLectura) gl.deleteFramebuffer(this._fboLectura);
                if (this._programa) gl.deleteProgram(this._programa);
                gl.bindBuffer(gl.ARRAY_BUFFER, null);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                // Libera el contexto WebGL de inmediato (evita "too many contexts")
                const perder = gl.getExtension('WEBGL_lose_context');
                if (perder) perder.loseContext();
            } catch (e) { /* el contexto ya podría estar perdido */ }
        }
        this._bufPos = null;
        this._bufCol = null;
        this._fboLectura = null;
        this._programa = null;
        this._gl = null;

        const canvas = this._canvas;
        if (canvas && canvas.parentNode) {
            try { canvas.parentNode.removeChild(canvas); } catch (e) { /* ya retirado */ }
        }
        this._canvas = null;
        this._contenedor = null;
        this._subidos = 0;
    }
}

export default LidarScanner;
