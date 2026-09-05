/**
 * ayudantes.mjs — utilidades compartidas por la suite de pruebas de JoseScan.
 *
 * Contiene, en este orden:
 *   1. Carga perezosa y tolerante de los módulos bajo prueba.
 *   2. Aserciones auxiliares con tolerancia numérica.
 *   3. Generadores deterministas (nube de puntos, cubo de 1 m, metadatos).
 *   4. Un doble en memoria de IndexedDB + los globales de navegador que
 *      necesita `js/lidar-store.js` (navigator.storage, window, Blob, File).
 *   5. Un `proj4` mínimo (Transverse Mercator sobre GRS80) para que
 *      `js/coords.js` pueda resolver EPSG:9377 dentro de Node.
 *
 * Sin dependencias externas: sólo librería estándar de Node 22.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 1. Carga perezosa de los módulos bajo prueba
// ---------------------------------------------------------------------------

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/** Raíz del repositorio (…/campo-maps). */
export const RAIZ = path.resolve(AQUI, '..');

const cacheModulos = new Map();

/**
 * Importa un módulo del repositorio de forma perezosa.
 * Devuelve `null` si el archivo aún no existe o si falla al evaluarse, para que
 * la prueba pueda marcarse con `t.skip(...)` en vez de reventar la suite.
 *
 * @param {string} rutaRelativa Ruta relativa a la raíz, p. ej. 'js/lidar-geo.js'.
 * @returns {Promise<object|null>}
 */
export async function cargarModulo(rutaRelativa) {
    if (cacheModulos.has(rutaRelativa)) return cacheModulos.get(rutaRelativa);
    let modulo = null;
    try {
        modulo = await import(pathToFileURL(path.join(RAIZ, rutaRelativa)).href);
    } catch (e) {
        // Se guarda el motivo para poder explicarlo en el mensaje de skip.
        modulo = null;
        motivosFallo.set(rutaRelativa, e && e.message ? e.message : String(e));
    }
    cacheModulos.set(rutaRelativa, modulo);
    return modulo;
}

const motivosFallo = new Map();

/** Motivo textual por el que un módulo no pudo cargarse (o cadena vacía). */
export function motivoFallo(rutaRelativa) {
    return motivosFallo.get(rutaRelativa) || 'archivo no encontrado';
}

/** Mensaje estándar para `t.skip(...)` cuando un módulo no está disponible. */
export function mensajeAusente(rutaRelativa) {
    return `${rutaRelativa} aún no disponible (${motivoFallo(rutaRelativa)})`;
}

export const cargarFormatos = () => cargarModulo('js/lidar-formats.js');
export const cargarGeo = () => cargarModulo('js/lidar-geo.js');
export const cargarStore = () => cargarModulo('js/lidar-store.js');
export const cargarCoords = () => cargarModulo('js/coords.js');

// ---------------------------------------------------------------------------
// 2. Aserciones auxiliares
// ---------------------------------------------------------------------------

/**
 * Falla si |a − b| > tolerancia.
 * @param {number} a Valor obtenido.
 * @param {number} b Valor esperado.
 * @param {number} [tolerancia=1e-6]
 * @param {string} [mensaje='']
 */
export function casiIgual(a, b, tolerancia = 1e-6, mensaje = '') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error(
            `casiIgual: valores no finitos (obtenido=${a}, esperado=${b})` +
            (mensaje ? ` — ${mensaje}` : '')
        );
    }
    const dif = Math.abs(a - b);
    if (dif > tolerancia) {
        throw new Error(
            `casiIgual: |${a} − ${b}| = ${dif} > ${tolerancia}` +
            (mensaje ? ` — ${mensaje}` : '')
        );
    }
}

/**
 * Compara dos secuencias numéricas elemento a elemento con tolerancia.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {number} [tolerancia=1e-6]
 * @param {string} [mensaje='']
 */
export function casiIgualArray(a, b, tolerancia = 1e-6, mensaje = '') {
    if (a == null || b == null) {
        throw new Error(`casiIgualArray: alguna secuencia es nula${mensaje ? ` — ${mensaje}` : ''}`);
    }
    if (a.length !== b.length) {
        throw new Error(
            `casiIgualArray: longitudes distintas (${a.length} vs ${b.length})` +
            (mensaje ? ` — ${mensaje}` : '')
        );
    }
    for (let i = 0; i < a.length; i++) {
        const dif = Math.abs(a[i] - b[i]);
        if (!(dif <= tolerancia)) {
            throw new Error(
                `casiIgualArray: en el índice ${i}: |${a[i]} − ${b[i]}| = ${dif} > ${tolerancia}` +
                (mensaje ? ` — ${mensaje}` : '')
            );
        }
    }
}

/** Compara dos secuencias de enteros exigiendo igualdad exacta. */
export function igualArrayExacto(a, b, mensaje = '') {
    if (a == null || b == null) {
        throw new Error(`igualArrayExacto: alguna secuencia es nula${mensaje ? ` — ${mensaje}` : ''}`);
    }
    if (a.length !== b.length) {
        throw new Error(
            `igualArrayExacto: longitudes distintas (${a.length} vs ${b.length})` +
            (mensaje ? ` — ${mensaje}` : '')
        );
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            throw new Error(
                `igualArrayExacto: en el índice ${i}: ${a[i]} ≠ ${b[i]}` +
                (mensaje ? ` — ${mensaje}` : '')
            );
        }
    }
}

// --- Lectores tolerantes de valores de retorno --------------------------------
// Los módulos bajo prueba se están escribiendo en paralelo; estos lectores
// aceptan las dos formas razonables de devolver una terna (objeto con nombres o
// arreglo posicional) sin dejar de comprobar el contenido numérico.

/** Normaliza {este,norte,arriba} | [e,n,u] → [e, n, u]. */
export function leerEnu(v) {
    if (v == null) throw new Error('leerEnu: valor nulo');
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return [Number(v[0]), Number(v[1]), Number(v[2] ?? 0)];
    const e = v.este ?? v.e ?? v.east ?? v.x;
    const n = v.norte ?? v.n ?? v.north ?? v.y;
    const u = v.arriba ?? v.u ?? v.up ?? v.alt ?? v.z ?? 0;
    if (e === undefined || n === undefined) throw new Error(`leerEnu: forma no reconocida: ${JSON.stringify(v)}`);
    return [Number(e), Number(n), Number(u)];
}

/** Normaliza {lat,lng,alt} | {latitude,longitude,altitude} | [lng,lat,alt] → [lat, lng, alt]. */
export function leerWgs84(v) {
    if (v == null) throw new Error('leerWgs84: valor nulo');
    if (Array.isArray(v)) return [Number(v[1]), Number(v[0]), Number(v[2] ?? 0)];
    const lat = v.lat ?? v.latitude ?? v.latitud;
    const lng = v.lng ?? v.lon ?? v.longitude ?? v.longitud;
    const alt = v.alt ?? v.altitude ?? v.altitud ?? v.arriba ?? 0;
    if (lat === undefined || lng === undefined) {
        throw new Error(`leerWgs84: forma no reconocida: ${JSON.stringify(v)}`);
    }
    return [Number(lat), Number(lng), Number(alt)];
}

/**
 * Normaliza el resultado de `ejeVertical(frame)` a un índice 0|1|2.
 * Acepta el índice numérico o el nombre del eje ('x'|'y'|'z').
 */
export function leerIndiceEje(v) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2) return v;
    if (typeof v === 'string') {
        const i = ['x', 'y', 'z'].indexOf(v.trim().toLowerCase());
        if (i >= 0) return i;
    }
    throw new Error(`leerIndiceEje: no se reconoce el eje ${JSON.stringify(v)}`);
}

// ---------------------------------------------------------------------------
// 3. Generadores deterministas
// ---------------------------------------------------------------------------

/** Ancla de referencia de todas las pruebas: Bogotá D.C. */
export const ANCLA_BOGOTA = Object.freeze({
    latitude: 4.60971,
    longitude: -74.08175,
    altitude: 2570
});

/**
 * Generador congruente lineal: misma semilla ⇒ misma secuencia en toda máquina.
 * @param {number} semilla
 * @returns {() => number} función que devuelve un flotante en [0, 1).
 */
export function azarDeterminista(semilla = 20260905) {
    let s = semilla >>> 0;
    return function siguiente() {
        // Constantes de Numerical Recipes (LCG de 32 bits).
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * Nube sintética de N puntos dispuestos en una rejilla cuadrada sobre el plano
 * horizontal, con una ondulación suave en el eje vertical.
 *
 * Los valores se redondean a 3 decimales para que sobrevivan sin pérdida
 * apreciable al formato ascii `%.6f` del PLY y a la precisión de `Float32Array`.
 *
 * @param {number} n Número de puntos.
 * @param {{ frame?: string, paso?: number, conColor?: boolean, conConfianza?: boolean }} [opciones]
 * @returns {{ positions: Float32Array, colors: Uint8Array|null, confidences: Uint8Array|null, count: number, frame: string }}
 */
export function nubeSintetica(n = 64, opciones = {}) {
    const { frame = 'enu', paso = 0.25, conColor = true, conConfianza = true } = opciones;
    const lado = Math.max(1, Math.ceil(Math.sqrt(n)));
    const positions = new Float32Array(n * 3);
    const colors = conColor ? new Uint8Array(n * 3) : null;
    const confidences = conConfianza ? new Uint8Array(n) : null;

    for (let i = 0; i < n; i++) {
        const col = i % lado;
        const fil = Math.floor(i / lado);
        const x = redondear3((col - lado / 2) * paso);
        const y = redondear3((fil - lado / 2) * paso);
        // Ondulación determinista, sin números aleatorios, en el eje vertical.
        const z = redondear3(0.5 * Math.sin(col * 0.7) * Math.cos(fil * 0.4));
        positions[i * 3 + 0] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        if (colors) {
            colors[i * 3 + 0] = (i * 37) % 256;
            colors[i * 3 + 1] = (i * 91 + 17) % 256;
            colors[i * 3 + 2] = (i * 13 + 200) % 256;
        }
        if (confidences) confidences[i] = i % 3; // 0 baja, 1 media, 2 alta
    }

    return { positions, colors, confidences, count: n, frame };
}

/** Redondea a 3 decimales (evita ruido al pasar por texto y por float32). */
function redondear3(v) {
    return Math.round(v * 1000) / 1000;
}

/**
 * Cubo de 1 m de arista con una esquina en el origen: 8 vértices y 12
 * triángulos con enrollado antihorario visto desde fuera.
 *
 * @param {{ frame?: string, conNormales?: boolean }} [opciones]
 * @returns {{ positions: Float32Array, normals: Float32Array|null, indices: Uint32Array, count: number, frame: string }}
 */
export function cuboUnitario(opciones = {}) {
    const { frame = 'enu', conNormales = true } = opciones;

    const positions = new Float32Array([
        0, 0, 0, // 0
        1, 0, 0, // 1
        1, 1, 0, // 2
        0, 1, 0, // 3
        0, 0, 1, // 4
        1, 0, 1, // 5
        1, 1, 1, // 6
        0, 1, 1  // 7
    ]);

    const indices = new Uint32Array([
        // cara inferior (z = 0), normal −Z
        0, 2, 1, 0, 3, 2,
        // cara superior (z = 1), normal +Z
        4, 5, 6, 4, 6, 7,
        // cara y = 0, normal −Y
        0, 1, 5, 0, 5, 4,
        // cara x = 1, normal +X
        1, 2, 6, 1, 6, 5,
        // cara y = 1, normal +Y
        2, 3, 7, 2, 7, 6,
        // cara x = 0, normal −X
        3, 0, 4, 3, 4, 7
    ]);

    // Normal por vértice: la diagonal normalizada desde el centro del cubo.
    let normals = null;
    if (conNormales) {
        normals = new Float32Array(8 * 3);
        const k = 1 / Math.sqrt(3);
        for (let i = 0; i < 8; i++) {
            normals[i * 3 + 0] = redondear3((positions[i * 3 + 0] - 0.5) * 2 * k);
            normals[i * 3 + 1] = redondear3((positions[i * 3 + 1] - 0.5) * 2 * k);
            normals[i * 3 + 2] = redondear3((positions[i * 3 + 2] - 0.5) * 2 * k);
        }
    }

    return { positions, normals, indices, count: 8, frame };
}

/**
 * Metadatos `josescan/1.0` de ejemplo, anclados en Bogotá.
 * @param {object} [parche] Campos a sobreescribir (mezcla superficial).
 * @returns {object}
 */
export function metadatosEjemplo(parche = {}) {
    const base = {
        formato: 'josescan/1.0',
        id: '3F2504E0-4F89-41D3-9A0C-0305E82C3301',
        nombre: 'Cárcava K12+400',
        creado: '2026-09-05T14:22:31Z',
        dispositivo: 'iPhone 15 Pro',
        sistema: 'iOS 18.2',
        sensor: 'lidar',
        marco: 'enu',
        geo: {
            latitude: ANCLA_BOGOTA.latitude,
            longitude: ANCLA_BOGOTA.longitude,
            altitude: ANCLA_BOGOTA.altitude,
            horizontalAccuracy: 3.2,
            verticalAccuracy: 4.0,
            heading: 172.5,
            headingAccuracy: 8.0,
            timestamp: '2026-09-05T14:22:31Z'
        },
        puntos: 812344,
        vertices: 51233,
        triangulos: 98120,
        bbox: { min: [-4.2, -3.1, -1.0], max: [5.9, 6.0, 2.4] },
        duracionSegundos: 92.4,
        mediciones: [
            {
                id: 'B1D0A6E2-0000-4000-8000-000000000001',
                kind: 'distancia',
                value: 3.42,
                unit: 'm',
                points: [[0, 0, 0], [3.42, 0, 0]],
                label: 'Ancho',
                createdAt: '2026-09-05T14:23:02Z'
            }
        ],
        proyecto: 'Proyecto General',
        notas: '',
        archivoNube: 'nube.ply',
        archivoMalla: 'malla.obj',
        archivoMiniatura: 'miniatura.jpg'
    };
    return { ...base, ...parche };
}

/** Convierte una cadena a un `ArrayBuffer` exacto (sin desplazamiento). */
export function textoABuffer(texto) {
    const bytes = new TextEncoder().encode(texto);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Convierte un `ArrayBuffer`/`TypedArray` a texto latin1 (byte a byte). */
export function bufferATexto(buffer) {
    const bytes = buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer ? buffer.buffer : buffer,
                         buffer.byteOffset || 0,
                         buffer.byteLength);
    let salida = '';
    for (let i = 0; i < bytes.length; i++) salida += String.fromCharCode(bytes[i]);
    return salida;
}

/**
 * Construye un PLY binario a mano, con el orden de bytes indicado.
 * Se usa para probar el lector con `binary_big_endian`, que el escritor propio
 * nunca genera.
 *
 * @param {{positions: Float32Array, colors?: Uint8Array|null, confidences?: Uint8Array|null, count: number}} nube
 * @param {boolean} bigEndian
 * @returns {ArrayBuffer}
 */
export function plyBinarioAMano(nube, bigEndian = false) {
    const n = nube.count;
    const cabecera =
        'ply\n' +
        `format ${bigEndian ? 'binary_big_endian' : 'binary_little_endian'} 1.0\n` +
        'comment JoseScan josescan/1.0\n' +
        'comment marco enu\n' +
        `element vertex ${n}\n` +
        'property float x\n' +
        'property float y\n' +
        'property float z\n' +
        'property uchar red\n' +
        'property uchar green\n' +
        'property uchar blue\n' +
        'property uchar confidence\n' +
        'end_header\n';
    const bytesCabecera = new TextEncoder().encode(cabecera);
    const salida = new Uint8Array(bytesCabecera.length + n * 16);
    salida.set(bytesCabecera, 0);
    const vista = new DataView(salida.buffer, bytesCabecera.length);
    for (let i = 0; i < n; i++) {
        const off = i * 16;
        vista.setFloat32(off + 0, nube.positions[i * 3 + 0], !bigEndian);
        vista.setFloat32(off + 4, nube.positions[i * 3 + 1], !bigEndian);
        vista.setFloat32(off + 8, nube.positions[i * 3 + 2], !bigEndian);
        vista.setUint8(off + 12, nube.colors ? nube.colors[i * 3 + 0] : 200);
        vista.setUint8(off + 13, nube.colors ? nube.colors[i * 3 + 1] : 200);
        vista.setUint8(off + 14, nube.colors ? nube.colors[i * 3 + 2] : 200);
        vista.setUint8(off + 15, nube.confidences ? nube.confidences[i] : 2);
    }
    return salida.buffer;
}

// ---------------------------------------------------------------------------
// 4. Doble en memoria de IndexedDB
// ---------------------------------------------------------------------------

/** Registro global de bases de datos falsas: nombre → estado persistente. */
const basesDeDatos = new Map();

/** Lista de nombres al estilo `DOMStringList` (tiene `contains` e `item`). */
class ListaNombres extends Array {
    contains(nombre) { return this.indexOf(nombre) !== -1; }
    item(i) { return i >= 0 && i < this.length ? this[i] : null; }
}

/** Error equivalente a `DOMException` para el doble. */
function errorDOM(mensaje, nombre = 'DataError') {
    const e = new Error(mensaje);
    e.name = nombre;
    return e;
}

/** Orden de tipos de clave según la especificación de IndexedDB. */
function rangoTipo(v) {
    if (typeof v === 'number') return 0;
    if (v instanceof Date) return 1;
    if (typeof v === 'string') return 2;
    if (Array.isArray(v)) return 4;
    return 3;
}

/** Comparador total de claves de IndexedDB. */
export function compararClaves(a, b) {
    const ta = rangoTipo(a), tb = rangoTipo(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (Array.isArray(a)) {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const c = compararClaves(a[i], b[i]);
            if (c !== 0) return c;
        }
        return a.length - b.length;
    }
    if (a instanceof Date) return a.getTime() - b.getTime();
    if (typeof a === 'string') return a < b ? -1 : (a > b ? 1 : 0);
    return a < b ? -1 : (a > b ? 1 : 0);
}

/** Extrae la clave de un valor según un `keyPath` (con soporte de puntos y arreglos). */
function extraerClave(valor, keyPath) {
    if (keyPath == null) return undefined;
    if (Array.isArray(keyPath)) {
        const partes = keyPath.map((k) => extraerClave(valor, k));
        return partes.some((p) => p === undefined) ? undefined : partes;
    }
    let actual = valor;
    for (const trozo of String(keyPath).split('.')) {
        if (actual == null || typeof actual !== 'object') return undefined;
        actual = actual[trozo];
    }
    return actual;
}

/** Rango de claves equivalente a `IDBKeyRange`. */
class RangoClaves {
    constructor(inferior, superior, inferiorAbierto, superiorAbierto) {
        this.lower = inferior;
        this.upper = superior;
        this.lowerOpen = !!inferiorAbierto;
        this.upperOpen = !!superiorAbierto;
    }
    includes(clave) {
        if (this.lower !== undefined) {
            const c = compararClaves(clave, this.lower);
            if (c < 0 || (c === 0 && this.lowerOpen)) return false;
        }
        if (this.upper !== undefined) {
            const c = compararClaves(clave, this.upper);
            if (c > 0 || (c === 0 && this.upperOpen)) return false;
        }
        return true;
    }
    static only(v) { return new RangoClaves(v, v, false, false); }
    static bound(l, u, lo = false, uo = false) { return new RangoClaves(l, u, lo, uo); }
    static lowerBound(l, abierto = false) { return new RangoClaves(l, undefined, abierto, false); }
    static upperBound(u, abierto = false) { return new RangoClaves(undefined, u, false, abierto); }
}

/** ¿Coincide la clave con el filtro (rango, clave suelta o `null`)? */
function coincide(filtro, clave) {
    if (filtro === undefined || filtro === null) return true;
    if (filtro instanceof RangoClaves) return filtro.includes(clave);
    return compararClaves(filtro, clave) === 0;
}

/** Solicitud equivalente a `IDBRequest`. */
class SolicitudFalsa {
    constructor(transaccion, fuente) {
        this.transaction = transaccion || null;
        this.source = fuente || null;
        this.result = undefined;
        this.error = null;
        this.readyState = 'pending';
        this.onsuccess = null;
        this.onerror = null;
        this._oyentes = { success: [], error: [] };
        if (this.transaction) this.transaction._registrar();
    }

    addEventListener(tipo, fn) {
        if (this._oyentes[tipo]) this._oyentes[tipo].push(fn);
    }
    removeEventListener(tipo, fn) {
        if (!this._oyentes[tipo]) return;
        const i = this._oyentes[tipo].indexOf(fn);
        if (i >= 0) this._oyentes[tipo].splice(i, 1);
    }

    _emitir(tipo) {
        const ev = { target: this, currentTarget: this, type: tipo };
        try {
            const manejador = tipo === 'success' ? this.onsuccess : this.onerror;
            if (typeof manejador === 'function') manejador.call(this, ev);
            for (const fn of this._oyentes[tipo].slice()) fn.call(this, ev);
        } finally {
            if (this.transaction) this.transaction._liberar();
        }
    }

    _exito(valor) {
        queueMicrotask(() => {
            this.result = valor;
            this.readyState = 'done';
            this._emitir('success');
        });
    }

    _fallo(error) {
        queueMicrotask(() => {
            this.error = error;
            this.readyState = 'done';
            this._emitir('error');
            if (this.transaction) this.transaction._abortarPorError(error);
        });
    }
}

/** Solicitud de apertura de base de datos (`IDBOpenDBRequest`). */
class SolicitudApertura extends SolicitudFalsa {
    constructor() {
        super(null, null);
        this.onupgradeneeded = null;
        this.onblocked = null;
        this._oyentes.upgradeneeded = [];
        this._oyentes.blocked = [];
    }
}

/** Almacén persistente (los datos sobreviven entre conexiones). */
class AlmacenPersistente {
    constructor(nombre, opciones = {}) {
        this.nombre = nombre;
        this.keyPath = opciones.keyPath ?? null;
        this.autoIncrement = !!opciones.autoIncrement;
        this.datos = new Map();      // claveSerializada → { clave, valor }
        this.indices = new Map();    // nombre → { keyPath, unique, multiEntry }
        this.siguienteClave = 1;
    }
    /** Clave serializada estable para usar como llave del Map. */
    static serializar(clave) {
        return JSON.stringify(clave instanceof Date ? { __fecha: clave.getTime() } : clave);
    }
    /** Registros ordenados por clave primaria. */
    registrosOrdenados() {
        return Array.from(this.datos.values()).sort((a, b) => compararClaves(a.clave, b.clave));
    }
}

/** Estado persistente de una base de datos falsa. */
class BasePersistente {
    constructor(nombre) {
        this.nombre = nombre;
        this.version = 0;
        this.almacenes = new Map();
    }
}

/** Índice equivalente a `IDBIndex`. */
class IndiceFalso {
    constructor(almacenTx, nombre, definicion) {
        this._almacenTx = almacenTx;
        this.name = nombre;
        this.keyPath = definicion.keyPath;
        this.unique = !!definicion.unique;
        this.multiEntry = !!definicion.multiEntry;
        this.objectStore = almacenTx;
    }

    /** Entradas {claveIndice, clave, valor} ordenadas por (claveIndice, clave). */
    _entradas() {
        const persistente = this._almacenTx._persistente;
        const salida = [];
        for (const reg of persistente.datos.values()) {
            const ci = extraerClave(reg.valor, this.keyPath);
            if (ci === undefined) continue; // los valores sin la propiedad no se indexan
            if (this.multiEntry && Array.isArray(ci)) {
                for (const sub of ci) salida.push({ claveIndice: sub, clave: reg.clave, valor: reg.valor });
            } else {
                salida.push({ claveIndice: ci, clave: reg.clave, valor: reg.valor });
            }
        }
        salida.sort((a, b) => {
            const c = compararClaves(a.claveIndice, b.claveIndice);
            return c !== 0 ? c : compararClaves(a.clave, b.clave);
        });
        return salida;
    }

    get(clave) {
        const tx = this._almacenTx._tx;
        const sol = new SolicitudFalsa(tx, this);
        const hallado = this._entradas().find((e) => coincide(clave, e.claveIndice));
        sol._exito(hallado ? structuredClone(hallado.valor) : undefined);
        return sol;
    }

    getAll(consulta, limite) {
        const tx = this._almacenTx._tx;
        const sol = new SolicitudFalsa(tx, this);
        let filas = this._entradas().filter((e) => coincide(consulta, e.claveIndice));
        if (typeof limite === 'number') filas = filas.slice(0, limite);
        sol._exito(filas.map((e) => structuredClone(e.valor)));
        return sol;
    }

    getAllKeys(consulta, limite) {
        const tx = this._almacenTx._tx;
        const sol = new SolicitudFalsa(tx, this);
        let filas = this._entradas().filter((e) => coincide(consulta, e.claveIndice));
        if (typeof limite === 'number') filas = filas.slice(0, limite);
        sol._exito(filas.map((e) => e.clave));
        return sol;
    }

    count(consulta) {
        const tx = this._almacenTx._tx;
        const sol = new SolicitudFalsa(tx, this);
        sol._exito(this._entradas().filter((e) => coincide(consulta, e.claveIndice)).length);
        return sol;
    }

    openCursor(consulta, direccion = 'next') {
        return crearCursor(this._almacenTx, this, consulta, direccion, true);
    }

    openKeyCursor(consulta, direccion = 'next') {
        return crearCursor(this._almacenTx, this, consulta, direccion, false);
    }
}

/**
 * Crea un cursor sobre un almacén (índice `null`) o sobre un índice.
 * Emite `success` una vez por registro y un último `success` con `null`.
 */
function crearCursor(almacenTx, indice, consulta, direccion, conValor) {
    const tx = almacenTx._tx;
    const sol = new SolicitudFalsa(tx, indice || almacenTx);

    let entradas;
    if (indice) {
        entradas = indice._entradas().filter((e) => coincide(consulta, e.claveIndice));
    } else {
        entradas = almacenTx._persistente.registrosOrdenados()
            .filter((r) => coincide(consulta, r.clave))
            .map((r) => ({ claveIndice: r.clave, clave: r.clave, valor: r.valor }));
    }
    if (direccion === 'prev' || direccion === 'prevunique') entradas.reverse();
    if (direccion === 'nextunique' || direccion === 'prevunique') {
        const vistas = [];
        entradas = entradas.filter((e) => {
            if (vistas.some((v) => compararClaves(v, e.claveIndice) === 0)) return false;
            vistas.push(e.claveIndice);
            return true;
        });
    }

    let i = 0;
    const avanzar = () => {
        if (i >= entradas.length) { sol._exito(null); return; }
        const ent = entradas[i++];
        const cursor = {
            key: ent.claveIndice,
            primaryKey: ent.clave,
            direction: direccion,
            source: indice || almacenTx,
            request: sol,
            value: conValor ? structuredClone(ent.valor) : undefined,
            continue(_clave) {
                tx._registrar();
                avanzar();
            },
            advance(cuantos) {
                i += Math.max(0, cuantos - 1);
                tx._registrar();
                avanzar();
            },
            delete() {
                const s = new SolicitudFalsa(tx, almacenTx);
                almacenTx._persistente.datos.delete(AlmacenPersistente.serializar(ent.clave));
                s._exito(undefined);
                return s;
            },
            update(nuevo) {
                const s = new SolicitudFalsa(tx, almacenTx);
                almacenTx._persistente.datos.set(
                    AlmacenPersistente.serializar(ent.clave),
                    { clave: ent.clave, valor: structuredClone(nuevo) }
                );
                s._exito(ent.clave);
                return s;
            }
        };
        sol._exito(cursor);
    };
    avanzar();
    return sol;
}

/** Almacén dentro de una transacción (`IDBObjectStore`). */
class AlmacenTransaccion {
    constructor(tx, persistente) {
        this._tx = tx;
        this._persistente = persistente;
        this.name = persistente.nombre;
        this.keyPath = persistente.keyPath;
        this.autoIncrement = persistente.autoIncrement;
    }

    get indexNames() {
        return ListaNombres.from(this._persistente.indices.keys());
    }

    _verificarEscritura() {
        if (this._tx.mode === 'readonly') {
            throw errorDOM('No se puede escribir en una transacción readonly', 'ReadOnlyError');
        }
    }

    createIndex(nombre, keyPath, opciones = {}) {
        if (!this._tx._esActualizacion) {
            throw errorDOM('createIndex sólo es válido durante onupgradeneeded', 'InvalidStateError');
        }
        this._persistente.indices.set(nombre, {
            keyPath,
            unique: !!opciones.unique,
            multiEntry: !!opciones.multiEntry
        });
        return new IndiceFalso(this, nombre, this._persistente.indices.get(nombre));
    }

    deleteIndex(nombre) {
        this._persistente.indices.delete(nombre);
    }

    index(nombre) {
        const def = this._persistente.indices.get(nombre);
        if (!def) throw errorDOM(`No existe el índice «${nombre}»`, 'NotFoundError');
        return new IndiceFalso(this, nombre, def);
    }

    _guardar(valor, clave, permitirReemplazo) {
        this._verificarEscritura();
        const sol = new SolicitudFalsa(this._tx, this);
        let k = clave;
        if (k === undefined) k = extraerClave(valor, this._persistente.keyPath);
        if (k === undefined && this._persistente.autoIncrement) {
            k = this._persistente.siguienteClave++;
            if (this._persistente.keyPath) valor = { ...valor, [this._persistente.keyPath]: k };
        }
        if (k === undefined) {
            sol._fallo(errorDOM('No se pudo determinar la clave del registro', 'DataError'));
            return sol;
        }
        const serie = AlmacenPersistente.serializar(k);
        if (!permitirReemplazo && this._persistente.datos.has(serie)) {
            sol._fallo(errorDOM(`Ya existe un registro con la clave ${serie}`, 'ConstraintError'));
            return sol;
        }
        let copia;
        try {
            copia = structuredClone(valor);
        } catch (e) {
            sol._fallo(errorDOM(`Valor no clonable: ${e.message}`, 'DataCloneError'));
            return sol;
        }
        this._persistente.datos.set(serie, { clave: k, valor: copia });
        if (typeof k === 'number' && k >= this._persistente.siguienteClave) {
            this._persistente.siguienteClave = k + 1;
        }
        sol._exito(k);
        return sol;
    }

    put(valor, clave) { return this._guardar(valor, clave, true); }
    add(valor, clave) { return this._guardar(valor, clave, false); }

    get(clave) {
        const sol = new SolicitudFalsa(this._tx, this);
        if (clave instanceof RangoClaves) {
            const reg = this._persistente.registrosOrdenados().find((r) => clave.includes(r.clave));
            sol._exito(reg ? structuredClone(reg.valor) : undefined);
            return sol;
        }
        const reg = this._persistente.datos.get(AlmacenPersistente.serializar(clave));
        sol._exito(reg ? structuredClone(reg.valor) : undefined);
        return sol;
    }

    getKey(clave) {
        const sol = new SolicitudFalsa(this._tx, this);
        const reg = this._persistente.registrosOrdenados().find((r) => coincide(clave, r.clave));
        sol._exito(reg ? reg.clave : undefined);
        return sol;
    }

    getAll(consulta, limite) {
        const sol = new SolicitudFalsa(this._tx, this);
        let filas = this._persistente.registrosOrdenados().filter((r) => coincide(consulta, r.clave));
        if (typeof limite === 'number') filas = filas.slice(0, limite);
        sol._exito(filas.map((r) => structuredClone(r.valor)));
        return sol;
    }

    getAllKeys(consulta, limite) {
        const sol = new SolicitudFalsa(this._tx, this);
        let filas = this._persistente.registrosOrdenados().filter((r) => coincide(consulta, r.clave));
        if (typeof limite === 'number') filas = filas.slice(0, limite);
        sol._exito(filas.map((r) => r.clave));
        return sol;
    }

    count(consulta) {
        const sol = new SolicitudFalsa(this._tx, this);
        sol._exito(this._persistente.registrosOrdenados().filter((r) => coincide(consulta, r.clave)).length);
        return sol;
    }

    delete(clave) {
        this._verificarEscritura();
        const sol = new SolicitudFalsa(this._tx, this);
        if (clave instanceof RangoClaves) {
            for (const r of this._persistente.registrosOrdenados()) {
                if (clave.includes(r.clave)) {
                    this._persistente.datos.delete(AlmacenPersistente.serializar(r.clave));
                }
            }
        } else {
            this._persistente.datos.delete(AlmacenPersistente.serializar(clave));
        }
        sol._exito(undefined);
        return sol;
    }

    clear() {
        this._verificarEscritura();
        const sol = new SolicitudFalsa(this._tx, this);
        this._persistente.datos.clear();
        sol._exito(undefined);
        return sol;
    }

    openCursor(consulta, direccion = 'next') {
        return crearCursor(this, null, consulta, direccion, true);
    }

    openKeyCursor(consulta, direccion = 'next') {
        return crearCursor(this, null, consulta, direccion, false);
    }
}

/** Transacción equivalente a `IDBTransaction`. */
class TransaccionFalsa {
    constructor(conexion, nombres, modo, esActualizacion = false) {
        this.db = conexion;
        this.mode = modo;
        this.objectStoreNames = ListaNombres.from(nombres);
        this.error = null;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this._esActualizacion = esActualizacion;
        this._pendientes = 0;
        this._finalizada = false;
        this._abortada = false;
        this._almacenes = new Map();
        // Una transacción sin ninguna operación también debe completarse.
        setTimeout(() => this._quizaCompletar(), 0);
    }

    objectStore(nombre) {
        if (!this.objectStoreNames.contains(nombre)) {
            throw errorDOM(`El almacén «${nombre}» no participa en esta transacción`, 'NotFoundError');
        }
        if (this._almacenes.has(nombre)) return this._almacenes.get(nombre);
        const persistente = this.db._base.almacenes.get(nombre);
        if (!persistente) throw errorDOM(`No existe el almacén «${nombre}»`, 'NotFoundError');
        const almacen = new AlmacenTransaccion(this, persistente);
        this._almacenes.set(nombre, almacen);
        return almacen;
    }

    _registrar() { this._pendientes++; }

    _liberar() {
        this._pendientes--;
        // IndexedDB despacha `complete` como una *tarea*, no como microtarea: la
        // transacción sigue viva mientras se drena la cola de microtareas, que es
        // lo que permite encadenar `await` entre solicitudes. Con `queueMicrotask`
        // el doble cerraría la transacción antes de que el código bajo prueba
        // reanudara su `async`, así que aquí se usa `setTimeout(…, 0)`.
        setTimeout(() => this._quizaCompletar(), 0);
    }

    _quizaCompletar() {
        if (this._finalizada || this._abortada) return;
        if (this._pendientes > 0) return;
        this._finalizada = true;
        const ev = { target: this, type: 'complete' };
        if (typeof this.oncomplete === 'function') this.oncomplete(ev);
    }

    _abortarPorError(error) {
        if (this._finalizada || this._abortada) return;
        this._abortada = true;
        this.error = error;
        const ev = { target: this, type: 'error' };
        if (typeof this.onerror === 'function') this.onerror(ev);
        if (typeof this.onabort === 'function') this.onabort({ target: this, type: 'abort' });
    }

    abort() { this._abortarPorError(errorDOM('Transacción abortada', 'AbortError')); }
    commit() { /* el doble confirma solo; se acepta la llamada por compatibilidad */ }
}

/** Conexión equivalente a `IDBDatabase`. */
class ConexionFalsa {
    constructor(base) {
        this._base = base;
        this.name = base.nombre;
        this.onversionchange = null;
        this.onclose = null;
        this._cerrada = false;
    }
    get version() { return this._base.version; }
    get objectStoreNames() { return ListaNombres.from(this._base.almacenes.keys()); }

    createObjectStore(nombre, opciones = {}) {
        if (this._base.almacenes.has(nombre)) {
            throw errorDOM(`El almacén «${nombre}» ya existe`, 'ConstraintError');
        }
        const almacen = new AlmacenPersistente(nombre, opciones);
        this._base.almacenes.set(nombre, almacen);
        // Se devuelve envuelto en la transacción de actualización en curso.
        return new AlmacenTransaccion(this._txActualizacion, almacen);
    }

    deleteObjectStore(nombre) { this._base.almacenes.delete(nombre); }

    transaction(nombres, modo = 'readonly') {
        if (this._cerrada) throw errorDOM('La conexión está cerrada', 'InvalidStateError');
        const lista = Array.isArray(nombres) ? nombres : [nombres];
        for (const n of lista) {
            if (!this._base.almacenes.has(n)) {
                throw errorDOM(`No existe el almacén «${n}»`, 'NotFoundError');
            }
        }
        return new TransaccionFalsa(this, lista, modo);
    }

    close() { this._cerrada = true; }
}

/** Fábrica equivalente a `IDBFactory`. */
class FabricaFalsa {
    open(nombre, version) {
        const sol = new SolicitudApertura();
        let base = basesDeDatos.get(nombre);
        if (!base) {
            base = new BasePersistente(nombre);
            basesDeDatos.set(nombre, base);
        }
        const versionDestino = version === undefined ? Math.max(1, base.version) : version;

        queueMicrotask(() => {
            if (versionDestino < base.version) {
                sol.error = errorDOM('La versión solicitada es menor que la existente', 'VersionError');
                sol.readyState = 'done';
                sol._emitir('error');
                return;
            }
            const conexion = new ConexionFalsa(base);
            sol.result = conexion;

            if (versionDestino > base.version) {
                const versionAnterior = base.version;
                base.version = versionDestino;
                // Transacción especial `versionchange` en la que valen
                // createObjectStore y createIndex.
                const tx = new TransaccionFalsa(
                    conexion,
                    Array.from(base.almacenes.keys()),
                    'versionchange',
                    true
                );
                conexion._txActualizacion = tx;
                sol.transaction = tx;
                const ev = {
                    target: sol,
                    type: 'upgradeneeded',
                    oldVersion: versionAnterior,
                    newVersion: versionDestino
                };
                sol.readyState = 'done';
                if (typeof sol.onupgradeneeded === 'function') sol.onupgradeneeded(ev);
                for (const fn of sol._oyentes.upgradeneeded.slice()) fn(ev);
                tx._finalizada = true;
            }

            sol.readyState = 'done';
            queueMicrotask(() => {
                const ev = { target: sol, type: 'success' };
                if (typeof sol.onsuccess === 'function') sol.onsuccess(ev);
                for (const fn of sol._oyentes.success.slice()) fn(ev);
            });
        });

        return sol;
    }

    deleteDatabase(nombre) {
        const sol = new SolicitudApertura();
        queueMicrotask(() => {
            basesDeDatos.delete(nombre);
            sol.result = undefined;
            sol.readyState = 'done';
            sol._emitir('success');
        });
        return sol;
    }

    databases() {
        return Promise.resolve(
            Array.from(basesDeDatos.values()).map((b) => ({ name: b.nombre, version: b.version }))
        );
    }

    cmp(a, b) { return compararClaves(a, b); }
}

/**
 * Borra todas las bases falsas y reinicia el estado del doble.
 * Debe llamarse entre pruebas que compartan nombres de base de datos.
 */
export function reiniciarIndexedDB() {
    basesDeDatos.clear();
    for (const clave of Array.from(cacheModulos.keys())) {
        // Los módulos guardan la conexión en una variable de módulo; al borrar
        // las bases hay que olvidar también el módulo para que vuelva a abrir.
        if (clave.includes('lidar-store')) cacheModulos.delete(clave);
    }
}

/** Bytes ocupados por todas las bases falsas (aproximación por JSON). */
export function bytesEnIndexedDB() {
    let total = 0;
    for (const base of basesDeDatos.values()) {
        for (const almacen of base.almacenes.values()) {
            for (const reg of almacen.datos.values()) {
                try { total += JSON.stringify(reg.valor).length; } catch { total += 1024; }
            }
        }
    }
    return total;
}

// ---------------------------------------------------------------------------
// 5. proj4 mínimo — Transverse Mercator sobre GRS80 (EPSG:9377)
// ---------------------------------------------------------------------------

/** Parámetros de MAGNA-SIRGAS Origen Nacional (IGAC Res. 471/2020). */
const TM = {
    a: 6378137.0,
    f: 1 / 298.257222101, // GRS80
    k0: 0.9992,
    lat0: 4 * Math.PI / 180,
    lon0: -73 * Math.PI / 180,
    x0: 5000000,
    y0: 2000000
};
TM.e2 = 2 * TM.f - TM.f * TM.f;
TM.ep2 = TM.e2 / (1 - TM.e2);

/** Distancia meridional desde el ecuador hasta la latitud `p` (radianes). */
function arcoMeridiano(p) {
    const { a, e2 } = TM;
    const e4 = e2 * e2, e6 = e4 * e2;
    return a * (
        (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * p
        - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * p)
        + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * p)
        - (35 * e6 / 3072) * Math.sin(6 * p)
    );
}

const M0 = arcoMeridiano(TM.lat0);

/** WGS84 (grados) → EPSG:9377 [este, norte] en metros. */
export function proyectarA9377(lng, lat) {
    const { a, e2, ep2, k0, lon0, x0, y0 } = TM;
    const p = lat * Math.PI / 180;
    const l = lng * Math.PI / 180;
    const sinP = Math.sin(p), cosP = Math.cos(p), tanP = Math.tan(p);
    const N = a / Math.sqrt(1 - e2 * sinP * sinP);
    const T = tanP * tanP;
    const C = ep2 * cosP * cosP;
    const A = (l - lon0) * cosP;
    const A2 = A * A, A3 = A2 * A, A4 = A3 * A, A5 = A4 * A, A6 = A5 * A;

    const este = x0 + k0 * N * (
        A + (1 - T + C) * A3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A5 / 120
    );
    const norte = y0 + k0 * (
        arcoMeridiano(p) - M0 + N * tanP * (
            A2 / 2
            + (5 - T + 9 * C + 4 * C * C) * A4 / 24
            + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A6 / 720
        )
    );
    return [este, norte];
}

/** EPSG:9377 [este, norte] → WGS84 [lng, lat] en grados. */
export function desproyectarDe9377(este, norte) {
    const { a, e2, ep2, k0, lon0, x0, y0 } = TM;
    const e4 = e2 * e2, e6 = e4 * e2;
    const M = M0 + (norte - y0) / k0;
    const mu = M / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const e1_2 = e1 * e1, e1_3 = e1_2 * e1, e1_4 = e1_3 * e1;

    const p1 = mu
        + (3 * e1 / 2 - 27 * e1_3 / 32) * Math.sin(2 * mu)
        + (21 * e1_2 / 16 - 55 * e1_4 / 32) * Math.sin(4 * mu)
        + (151 * e1_3 / 96) * Math.sin(6 * mu)
        + (1097 * e1_4 / 512) * Math.sin(8 * mu);

    const sinP1 = Math.sin(p1), cosP1 = Math.cos(p1), tanP1 = Math.tan(p1);
    const C1 = ep2 * cosP1 * cosP1;
    const T1 = tanP1 * tanP1;
    const N1 = a / Math.sqrt(1 - e2 * sinP1 * sinP1);
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinP1 * sinP1, 1.5);
    const D = (este - x0) / (N1 * k0);
    const D2 = D * D, D3 = D2 * D, D4 = D3 * D, D5 = D4 * D, D6 = D5 * D;

    const p = p1 - (N1 * tanP1 / R1) * (
        D2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D6 / 720
    );
    const l = lon0 + (
        D - (1 + 2 * T1 + C1) * D3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D5 / 120
    ) / cosP1;

    return [l * 180 / Math.PI, p * 180 / Math.PI];
}

/** Normaliza los alias de sistema usados por `js/coords.js`. */
function normalizarSistema(nombre) {
    const s = String(nombre).toUpperCase();
    if (s.includes('4326') || s.includes('WGS84')) return 'WGS84';
    if (s.includes('9377') || s.includes('MAGNA')) return 'MAGNA';
    return s;
}

/**
 * Sustituto mínimo de `proj4` suficiente para `js/coords.js`:
 * sólo conoce EPSG:4326 y EPSG:9377 (y sus alias registrados con `defs`).
 */
export function crearProj4Minimo() {
    const definiciones = new Map();

    function proj4(desde, hasta, coordenadas) {
        const a = normalizarSistema(definiciones.get(desde) === undefined ? desde : desde);
        const b = normalizarSistema(hasta);
        const [u, v] = coordenadas;
        if (a === 'WGS84' && b === 'MAGNA') return proyectarA9377(u, v);
        if (a === 'MAGNA' && b === 'WGS84') return desproyectarDe9377(u, v);
        if (a === b) return [u, v];
        throw new Error(`proj4 mínimo: transformación no soportada ${desde} → ${hasta}`);
    }

    proj4.defs = function defs(nombre, definicion) {
        if (definicion === undefined) return definiciones.get(nombre);
        definiciones.set(nombre, definicion);
        return proj4;
    };
    proj4.esMinimo = true;
    return proj4;
}

// ---------------------------------------------------------------------------
// Instalación de los globales de navegador
// ---------------------------------------------------------------------------

let instalado = false;

/**
 * Instala en `globalThis` los dobles necesarios para ejecutar los módulos web
 * dentro de Node: `indexedDB`, `IDBKeyRange`, `navigator.storage`, `window` y
 * `window.proj4`. `Blob`, `File` y `structuredClone` ya existen en Node 22 y se
 * reutilizan tal cual.
 *
 * @param {{ proj4?: boolean }} [opciones]
 * @returns {{ indexedDB: FabricaFalsa, proj4Instalado: boolean }}
 */
export function instalarEntornoNavegador(opciones = {}) {
    const { proj4: conProj4 = true } = opciones;

    const fabrica = globalThis.indexedDB instanceof FabricaFalsa
        ? globalThis.indexedDB
        : new FabricaFalsa();

    if (!instalado) {
        globalThis.indexedDB = fabrica;
        globalThis.IDBKeyRange = RangoClaves;

        // `navigator` existe en Node 22 pero no trae `storage`; se le añade.
        const almacenamiento = {
            estimate: async () => ({
                quota: 2 * 1024 * 1024 * 1024,  // 2 GiB simulados
                usage: bytesEnIndexedDB(),
                usageDetails: { indexedDB: bytesEnIndexedDB() }
            }),
            persist: async () => true,
            persisted: async () => true
        };
        try {
            Object.defineProperty(globalThis.navigator, 'storage', {
                value: almacenamiento,
                configurable: true,
                writable: true
            });
        } catch {
            Object.defineProperty(globalThis, 'navigator', {
                value: { storage: almacenamiento, userAgent: 'node-pruebas' },
                configurable: true,
                writable: true
            });
        }

        // `window` apunta al propio global: así `window.indexedDB`,
        // `window.proj4` y `window.navigator` quedan consistentes.
        if (!globalThis.window) globalThis.window = globalThis;
        if (!globalThis.self) globalThis.self = globalThis;
        if (!globalThis.document) {
            globalThis.document = {
                createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
                createElementNS: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
                addEventListener() {},
                removeEventListener() {},
                body: { appendChild() {}, removeChild() {} }
            };
        }
        instalado = true;
    }

    let proj4Instalado = false;
    if (conProj4 && !globalThis.window.proj4) {
        globalThis.window.proj4 = crearProj4Minimo();
        proj4Instalado = true;
    } else if (conProj4) {
        proj4Instalado = true;
    }

    return { indexedDB: fabrica, proj4Instalado };
}

/** Quita el `proj4` mínimo para poder probar la degradación sin proj4. */
export function desinstalarProj4() {
    const anterior = globalThis.window ? globalThis.window.proj4 : undefined;
    if (globalThis.window) globalThis.window.proj4 = undefined;
    if (globalThis.proj4 !== undefined) globalThis.proj4 = undefined;
    return anterior;
}

/** Vuelve a poner el `proj4` guardado por `desinstalarProj4`. */
export function reinstalarProj4(anterior) {
    if (globalThis.window) globalThis.window.proj4 = anterior;
    if (anterior !== undefined) globalThis.proj4 = anterior;
}

/** Crea un `File` a partir de texto (usa el `File` nativo de Node 22). */
export function archivoDeTexto(texto, nombre, tipo = 'application/octet-stream') {
    return new File([texto], nombre, { type: tipo });
}

/** Crea un `File` a partir de un `ArrayBuffer`. */
export function archivoDeBuffer(buffer, nombre, tipo = 'application/octet-stream') {
    return new File([new Uint8Array(buffer)], nombre, { type: tipo });
}

export { RangoClaves as IDBKeyRangeFalso, FabricaFalsa };
