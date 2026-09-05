/**
 * lidar-store.js — Almacén local de escaneos JoseScan.
 *
 * Base de datos IndexedDB **propia e independiente** de `js/storage.js`
 * (`CampoMapsDB`), para no interferir con los mapas, rutas y marcadores de
 * JoseMaps:
 *
 *   Base: `JoseScanDB`, versión 1
 *   ├── `escaneos`   (keyPath `id`, índices `creado` y `proyecto`)
 *   │     Sólo metadatos: `escaneo.json` + `tamanoBytes` + `origen`.
 *   └── `geometria`  (keyPath `id`)
 *         `{ id, nube: ArrayBuffer|null, malla: string|null, miniatura: string|null }`
 *
 * La nube se guarda siempre como PLY binario little-endian (16 bytes/punto),
 * de modo que ocupe poco y sea directamente exportable a `.josescan`.
 *
 * Toda la API es asíncrona; cada solicitud de IndexedDB resuelve o rechaza su
 * promesa (`onsuccess` / `onerror` / `onabort` / `onblocked`), nunca queda
 * colgada.
 *
 * @module lidar-store
 */

import {
    FORMATO_ACTUAL,
    MARCOS_VALIDOS,
    parsePLY,
    writePLY,
    parseOBJ,
    writeOBJ,
    parseScanBundle,
    buildScanBundle,
    validarMetadatos,
    crearZip
} from './lidar-formats.js';

import { boundsDe, scanAGeoJSON } from './lidar-geo.js';

/* ───────────────────────── Constantes ───────────────────────── */

/** Nombre de la base de datos propia de JoseScan. */
export const SCAN_DB_NAME = 'JoseScanDB';

/** Versión del esquema. */
export const SCAN_DB_VERSION = 1;

/** Almacén de metadatos. */
export const ALMACEN_ESCANEOS = 'escaneos';

/** Almacén de geometría (nube, malla y miniatura). */
export const ALMACEN_GEOMETRIA = 'geometria';

/** Orígenes admitidos para un escaneo. */
const ORIGENES = ['app', 'web', 'importado'];

/** Promesa de apertura compartida (evita abrir la base varias veces). */
let _promesaDB = null;

/** Instancia abierta de la base. */
let _db = null;

/* ───────────────────────── Utilidades ───────────────────────── */

/**
 * Genera un UUID en mayúsculas, igual que `Foundation.UUID` en iOS.
 * @returns {string}
 */
function _uuid() {
    let bruto;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        bruto = crypto.randomUUID();
    } else if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const hex = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
        bruto = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } else {
        bruto = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
        });
    }
    return bruto.toUpperCase();
}

/**
 * Envuelve una `IDBRequest` en una promesa.
 * @param {IDBRequest} solicitud
 * @returns {Promise<*>}
 */
function _promesa(solicitud) {
    return new Promise((resolver, rechazar) => {
        solicitud.onsuccess = () => resolver(solicitud.result);
        solicitud.onerror = () => rechazar(solicitud.error || new Error('Error de IndexedDB en JoseScanDB.'));
    });
}

/**
 * Ejecuta una operación dentro de una transacción y resuelve al completarse.
 * @param {string[]} almacenes
 * @param {IDBTransactionMode} modo
 * @param {(tx:IDBTransaction)=>*} cuerpo Puede devolver un valor o una promesa.
 * @returns {Promise<*>}
 */
async function _transaccion(almacenes, modo, cuerpo) {
    const db = await initScanDB();
    return new Promise((resolver, rechazar) => {
        let tx;
        try {
            tx = db.transaction(almacenes, modo);
        } catch (e) {
            rechazar(e);
            return;
        }
        let resultado;
        let fallo = null;
        tx.oncomplete = () => resolver(resultado);
        tx.onerror = () => rechazar(fallo || tx.error || new Error('La transacción de JoseScanDB falló.'));
        tx.onabort = () => rechazar(fallo || tx.error || new Error('La transacción de JoseScanDB fue abortada.'));
        try {
            const salida = cuerpo(tx);
            if (salida && typeof salida.then === 'function') {
                salida.then((v) => { resultado = v; }, (e) => {
                    fallo = e;
                    try { tx.abort(); } catch (_) { rechazar(e); }
                });
            } else {
                resultado = salida;
            }
        } catch (e) {
            fallo = e;
            try { tx.abort(); } catch (_) { /* la transacción ya terminó */ }
            rechazar(e);
        }
    });
}

/**
 * Solicita almacenamiento persistente sin bloquear al llamante.
 * @returns {void}
 */
function _pedirPersistencia() {
    try {
        if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
            navigator.storage.persist()
                .then((ok) => console.log(`[JoseScan] Persistencia garantizada: ${ok}`))
                .catch((e) => console.warn('[JoseScan] No se pudo solicitar persistencia:', e));
        }
    } catch (e) {
        console.warn('[JoseScan] No se pudo solicitar persistencia:', e);
    }
}

/**
 * Calcula el tamaño aproximado en bytes de la geometría almacenada.
 * @param {{nube:ArrayBuffer|null, malla:string|null, miniatura:string|null}} geometria
 * @returns {number}
 */
function _tamanoDe(geometria) {
    let total = 0;
    if (geometria.nube) total += geometria.nube.byteLength || 0;
    if (geometria.malla) total += geometria.malla.length;          // 1 byte por carácter ASCII
    if (geometria.miniatura) total += Math.floor(geometria.miniatura.length * 0.75); // base64 → bytes
    return total;
}

/**
 * Convierte una nube (objeto o binario) al `ArrayBuffer` de PLY binario.
 * @param {object|ArrayBuffer|Uint8Array|null} nube
 * @returns {ArrayBuffer|null}
 */
function _nubeABuffer(nube) {
    if (!nube) return null;
    if (nube instanceof ArrayBuffer) return nube;
    if (ArrayBuffer.isView(nube)) return nube.buffer.slice(nube.byteOffset, nube.byteOffset + nube.byteLength);
    if (typeof nube === 'object' && (nube.positions || nube.posiciones || nube.vertices)) {
        return writePLY(nube, { binario: true });
    }
    return null;
}

/**
 * Convierte una malla (objeto o texto) a texto OBJ.
 * @param {object|string|null} malla
 * @returns {string|null}
 */
function _mallaATexto(malla) {
    if (!malla) return null;
    if (typeof malla === 'string') return malla;
    if (typeof malla === 'object' && malla.indices && malla.indices.length > 0) return writeOBJ(malla);
    return null;
}

/**
 * Nombre de archivo sin ruta ni extensión.
 * @param {string} nombreArchivo
 * @returns {string}
 */
function _nombreBase(nombreArchivo) {
    const base = String(nombreArchivo || '').split(/[\\/]/).pop();
    const punto = base.lastIndexOf('.');
    return (punto > 0 ? base.slice(0, punto) : base) || 'Escaneo importado';
}

/**
 * Convierte un nombre a un nombre de archivo seguro.
 * @param {string} texto
 * @returns {string}
 */
function _nombreSeguro(texto) {
    return String(texto || 'escaneo')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'escaneo';
}

/* ───────────────────────── Apertura de la base ───────────────────────── */

/**
 * Abre (y crea si hace falta) la base `JoseScanDB`.
 * Es idempotente: llamadas sucesivas reutilizan la misma conexión.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function initScanDB() {
    if (_db) return Promise.resolve(_db);
    if (_promesaDB) return _promesaDB;

    _promesaDB = new Promise((resolver, rechazar) => {
        if (typeof indexedDB === 'undefined') {
            rechazar(new Error('Este navegador no permite IndexedDB; JoseScan no puede guardar escaneos.'));
            return;
        }
        let solicitud;
        try {
            solicitud = indexedDB.open(SCAN_DB_NAME, SCAN_DB_VERSION);
        } catch (e) {
            rechazar(e);
            return;
        }

        solicitud.onupgradeneeded = () => {
            const db = solicitud.result;
            if (!db.objectStoreNames.contains(ALMACEN_ESCANEOS)) {
                const almacen = db.createObjectStore(ALMACEN_ESCANEOS, { keyPath: 'id' });
                almacen.createIndex('creado', 'creado', { unique: false });
                almacen.createIndex('proyecto', 'proyecto', { unique: false });
            }
            if (!db.objectStoreNames.contains(ALMACEN_GEOMETRIA)) {
                db.createObjectStore(ALMACEN_GEOMETRIA, { keyPath: 'id' });
            }
        };

        solicitud.onsuccess = () => {
            _db = solicitud.result;
            _db.onversionchange = () => {
                // Otra pestaña quiere migrar la base: se cierra para no bloquearla.
                try { _db.close(); } catch (e) { /* ya cerrada */ }
                _db = null;
                _promesaDB = null;
            };
            _db.onclose = () => { _db = null; _promesaDB = null; };
            resolver(_db);
        };

        solicitud.onerror = () => {
            _promesaDB = null;
            rechazar(solicitud.error || new Error('No se pudo abrir la base JoseScanDB.'));
        };

        solicitud.onblocked = () => {
            _promesaDB = null;
            rechazar(new Error('JoseScanDB está bloqueada por otra pestaña abierta de JoseMaps. Ciérrala y vuelve a intentar.'));
        };
    });

    _pedirPersistencia();
    return _promesaDB;
}

/* ───────────────────────── Guardar ───────────────────────── */

/**
 * Normaliza y completa los metadatos antes de guardarlos.
 * @param {object} meta
 * @param {object|null} nube Nube ya interpretada (para derivar contadores).
 * @param {object|null} malla Malla ya interpretada.
 * @returns {object}
 */
function _prepararMeta(meta, nube, malla) {
    const salida = { ...(meta || {}) };
    salida.formato = FORMATO_ACTUAL;
    salida.id = (typeof salida.id === 'string' && salida.id.trim()) ? salida.id.trim() : _uuid();
    salida.nombre = (typeof salida.nombre === 'string' && salida.nombre.trim()) ? salida.nombre.trim() : 'Escaneo sin nombre';
    salida.creado = (typeof salida.creado === 'string' && Number.isFinite(Date.parse(salida.creado)))
        ? new Date(salida.creado).toISOString()
        : new Date().toISOString();
    salida.dispositivo = typeof salida.dispositivo === 'string' ? salida.dispositivo : '';
    salida.sistema = typeof salida.sistema === 'string' ? salida.sistema : '';
    salida.sensor = typeof salida.sensor === 'string' && salida.sensor ? salida.sensor : 'lidar';

    if (!MARCOS_VALIDOS.includes(salida.marco)) {
        salida.marco = (nube && MARCOS_VALIDOS.includes(nube.frame)) ? nube.frame : 'arkit';
    }

    if (nube && Number.isFinite(nube.count)) salida.puntos = nube.count;
    if (!Number.isFinite(salida.puntos)) salida.puntos = 0;

    if (malla) {
        salida.vertices = Number.isFinite(malla.count) ? malla.count : Math.floor((malla.positions || []).length / 3);
        salida.triangulos = Math.floor((malla.indices ? malla.indices.length : 0) / 3);
    }
    if (!Number.isFinite(salida.vertices)) salida.vertices = 0;
    if (!Number.isFinite(salida.triangulos)) salida.triangulos = 0;

    if (!salida.bbox || !Array.isArray(salida.bbox.min) || !Array.isArray(salida.bbox.max)) {
        const fuente = (nube && nube.positions && nube.positions.length) ? nube.positions
            : ((malla && malla.positions && malla.positions.length) ? malla.positions : null);
        if (fuente) {
            const b = boundsDe(fuente);
            salida.bbox = b.vacio ? null : { min: b.min, max: b.max };
        } else if (salida.bbox === undefined) {
            salida.bbox = null;
        }
    }

    if (!Number.isFinite(salida.duracionSegundos)) salida.duracionSegundos = 0;
    if (!Array.isArray(salida.mediciones)) salida.mediciones = [];
    if (salida.proyecto !== undefined && salida.proyecto !== null && typeof salida.proyecto !== 'string') {
        salida.proyecto = String(salida.proyecto);
    }
    if (typeof salida.notas !== 'string') salida.notas = salida.notas == null ? '' : String(salida.notas);
    if (!ORIGENES.includes(salida.origen)) salida.origen = 'web';
    return salida;
}

/**
 * Guarda (o reemplaza) un escaneo completo.
 *
 * La nube se serializa a PLY binario y la malla a OBJ antes de persistirlas.
 *
 * @param {{meta:object, nube?:object|ArrayBuffer|null, malla?:object|string|null, miniatura?:string|null}} escaneo
 * @returns {Promise<object>} Metadatos guardados (con `id`, `tamanoBytes` y `origen`).
 * @throws {Error} Si los metadatos resultantes no cumplen `josescan/1.0`.
 */
export async function guardarEscaneo({ meta, nube = null, malla = null, miniatura = null } = {}) {
    const nubeInterpretada = (nube && typeof nube === 'object' && !(nube instanceof ArrayBuffer) && !ArrayBuffer.isView(nube))
        ? nube : null;
    const mallaInterpretada = (malla && typeof malla === 'object') ? malla : null;

    const bufferNube = _nubeABuffer(nube);
    const textoMalla = _mallaATexto(malla);

    // Si la nube llegó ya serializada, se lee para derivar contadores y caja.
    let nubeParaMeta = nubeInterpretada;
    if (!nubeParaMeta && bufferNube) {
        try { nubeParaMeta = parsePLY(bufferNube); } catch (e) { nubeParaMeta = null; }
    }
    let mallaParaMeta = mallaInterpretada;
    if (!mallaParaMeta && typeof malla === 'string' && malla.length > 0) {
        try { mallaParaMeta = parseOBJ(malla); } catch (e) { mallaParaMeta = null; }
    }

    const metaFinal = _prepararMeta(meta, nubeParaMeta, mallaParaMeta);
    const geometria = {
        id: metaFinal.id,
        nube: bufferNube,
        malla: textoMalla,
        miniatura: typeof miniatura === 'string' && miniatura ? miniatura : null
    };
    metaFinal.tamanoBytes = _tamanoDe(geometria);
    metaFinal.archivoNube = geometria.nube ? 'nube.ply' : null;
    metaFinal.archivoMalla = geometria.malla ? 'malla.obj' : null;
    metaFinal.archivoMiniatura = geometria.miniatura ? 'miniatura.jpg' : null;

    const validacion = validarMetadatos(metaFinal);
    if (!validacion.valido) {
        throw new Error(`No se pudo guardar el escaneo:\n- ${validacion.errores.join('\n- ')}`);
    }

    await _transaccion([ALMACEN_ESCANEOS, ALMACEN_GEOMETRIA], 'readwrite', (tx) => {
        tx.objectStore(ALMACEN_ESCANEOS).put(metaFinal);
        tx.objectStore(ALMACEN_GEOMETRIA).put(geometria);
    });

    return metaFinal;
}

/* ───────────────────────── Consultas ───────────────────────── */

/**
 * Lista los metadatos de los escaneos guardados.
 *
 * @param {{proyecto?:string|null, orden?:('fecha'|'nombre'|'tamano'|'puntos')}} [opciones]
 * @returns {Promise<object[]>}
 */
export async function listarEscaneos({ proyecto = null, orden = 'fecha' } = {}) {
    const lista = await _transaccion([ALMACEN_ESCANEOS], 'readonly', (tx) => {
        const almacen = tx.objectStore(ALMACEN_ESCANEOS);
        if (typeof proyecto === 'string' && proyecto !== '') {
            return _promesa(almacen.index('proyecto').getAll(proyecto));
        }
        return _promesa(almacen.getAll());
    });

    const salida = Array.isArray(lista) ? lista.slice() : [];
    switch (orden) {
        case 'nombre':
            salida.sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es-CO', { sensitivity: 'base' }));
            break;
        case 'tamano':
            salida.sort((a, b) => (b.tamanoBytes || 0) - (a.tamanoBytes || 0));
            break;
        case 'puntos':
            salida.sort((a, b) => (b.puntos || 0) - (a.puntos || 0));
            break;
        case 'fecha':
        default:
            salida.sort((a, b) => (Date.parse(b.creado) || 0) - (Date.parse(a.creado) || 0));
            break;
    }
    return salida;
}

/**
 * Recupera un escaneo completo.
 *
 * Por omisión la nube y la malla se devuelven ya interpretadas; con
 * `{ crudo: true }` se devuelven tal cual están almacenadas (PLY binario en un
 * `ArrayBuffer` y OBJ en texto), lo que es mucho más rápido para reexportar.
 *
 * @param {string} id
 * @param {{crudo?:boolean}} [opciones]
 * @returns {Promise<{meta:object, nube:object|ArrayBuffer|null, malla:object|string|null, miniatura:string|null, nubeCruda:ArrayBuffer|null, mallaCruda:string|null}|null>}
 */
export async function obtenerEscaneo(id, { crudo = false } = {}) {
    if (!id) return null;
    const datos = await _transaccion([ALMACEN_ESCANEOS, ALMACEN_GEOMETRIA], 'readonly', async (tx) => {
        const meta = await _promesa(tx.objectStore(ALMACEN_ESCANEOS).get(id));
        const geometria = await _promesa(tx.objectStore(ALMACEN_GEOMETRIA).get(id));
        return { meta, geometria };
    });

    if (!datos || !datos.meta) return null;
    const geometria = datos.geometria || { nube: null, malla: null, miniatura: null };

    if (crudo) {
        return {
            meta: datos.meta,
            nube: geometria.nube || null,
            malla: geometria.malla || null,
            miniatura: geometria.miniatura || null,
            nubeCruda: geometria.nube || null,
            mallaCruda: geometria.malla || null
        };
    }

    let nube = null;
    if (geometria.nube) {
        try { nube = parsePLY(geometria.nube); } catch (e) { console.warn('[JoseScan] Nube ilegible:', e); }
    }
    let malla = null;
    if (geometria.malla) {
        try { malla = parseOBJ(geometria.malla); } catch (e) { console.warn('[JoseScan] Malla ilegible:', e); }
    }

    return {
        meta: datos.meta,
        nube,
        malla,
        miniatura: geometria.miniatura || null,
        nubeCruda: geometria.nube || null,
        mallaCruda: geometria.malla || null
    };
}

/* ───────────────────────── Modificación ───────────────────────── */

/**
 * Aplica un parche parcial a los metadatos de un escaneo.
 * El `id`, el `formato` y `tamanoBytes` no se pueden sobrescribir.
 *
 * @param {string} id
 * @param {object} parche
 * @returns {Promise<object>} Metadatos actualizados.
 * @throws {Error} Si el escaneo no existe o el resultado no es válido.
 */
export async function actualizarMeta(id, parche) {
    if (!id) throw new Error('Falta el identificador del escaneo a actualizar.');
    if (!parche || typeof parche !== 'object') throw new Error('El parche de metadatos debe ser un objeto.');

    return _transaccion([ALMACEN_ESCANEOS], 'readwrite', async (tx) => {
        const almacen = tx.objectStore(ALMACEN_ESCANEOS);
        const actual = await _promesa(almacen.get(id));
        if (!actual) throw new Error(`No existe ningún escaneo con el identificador "${id}".`);

        const fusionado = { ...actual, ...parche };
        fusionado.id = actual.id;
        fusionado.formato = FORMATO_ACTUAL;
        fusionado.tamanoBytes = actual.tamanoBytes || 0;
        if (!ORIGENES.includes(fusionado.origen)) fusionado.origen = actual.origen || 'web';

        const validacion = validarMetadatos(fusionado);
        if (!validacion.valido) {
            throw new Error(`No se pudo actualizar el escaneo:\n- ${validacion.errores.join('\n- ')}`);
        }
        await _promesa(almacen.put(fusionado));
        return fusionado;
    });
}

/**
 * Elimina un escaneo y su geometría.
 *
 * @param {string} id
 * @returns {Promise<string>} El identificador eliminado.
 */
export async function eliminarEscaneo(id) {
    if (!id) throw new Error('Falta el identificador del escaneo a eliminar.');
    await _transaccion([ALMACEN_ESCANEOS, ALMACEN_GEOMETRIA], 'readwrite', (tx) => {
        tx.objectStore(ALMACEN_ESCANEOS).delete(id);
        tx.objectStore(ALMACEN_GEOMETRIA).delete(id);
    });
    return id;
}

/* ───────────────────────── Espacio en disco ───────────────────────── */

/**
 * Espacio ocupado por los escaneos y cuota disponible del navegador.
 *
 * @returns {Promise<{bytes:number, escaneos:number, cuota:number, disponible:number}>}
 */
export async function espacioUsado() {
    let bytes = 0;
    let escaneos = 0;
    try {
        const lista = await listarEscaneos();
        escaneos = lista.length;
        for (const meta of lista) bytes += meta.tamanoBytes || 0;
    } catch (e) {
        console.warn('[JoseScan] No se pudo calcular el espacio usado:', e);
    }

    let cuota = 0;
    let usadoTotal = 0;
    try {
        if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
            const estimado = await navigator.storage.estimate();
            cuota = Number(estimado.quota) || 0;
            usadoTotal = Number(estimado.usage) || 0;
        }
    } catch (e) {
        console.warn('[JoseScan] navigator.storage.estimate no disponible:', e);
    }

    const disponible = cuota > 0 ? Math.max(0, cuota - usadoTotal) : 0;
    return { bytes, escaneos, cuota, disponible };
}

/* ───────────────────────── Exportación ───────────────────────── */

/**
 * Exporta todos los escaneos guardados en un único ZIP que contiene un
 * archivo `.josescan` por escaneo.
 *
 * @returns {Promise<Blob>}
 * @throws {Error} Si no hay ningún escaneo que exportar.
 */
export async function exportarTodo() {
    const lista = await listarEscaneos();
    if (lista.length === 0) throw new Error('No hay escaneos guardados para exportar.');

    const entradas = [];
    const usados = new Set();

    for (const meta of lista) {
        const completo = await obtenerEscaneo(meta.id, { crudo: true });
        if (!completo) continue;
        if (!completo.nube && !completo.malla) continue; // paquete sin geometría: no es válido

        let huella = null;
        try { huella = scanAGeoJSON(completo.meta); } catch (e) { huella = null; }

        const paquete = await buildScanBundle({
            meta: completo.meta,
            nube: completo.nube,
            malla: completo.malla,
            miniatura: completo.miniatura,
            huella
        });

        let nombre = `${_nombreSeguro(completo.meta.nombre)}.josescan`;
        let n = 2;
        while (usados.has(nombre)) {
            nombre = `${_nombreSeguro(completo.meta.nombre)}_${n++}.josescan`;
        }
        usados.add(nombre);

        entradas.push({ nombre, datos: new Uint8Array(await paquete.arrayBuffer()) });
    }

    if (entradas.length === 0) throw new Error('Ningún escaneo guardado contiene geometría exportable.');

    const JSZipGlobal = (typeof window !== 'undefined' && window.JSZip) ? window.JSZip
        : (typeof globalThis !== 'undefined' && globalThis.JSZip ? globalThis.JSZip : null);

    if (JSZipGlobal) {
        const zip = new JSZipGlobal();
        for (const entrada of entradas) zip.file(entrada.nombre, entrada.datos);
        // Los `.josescan` ya vienen comprimidos: se almacenan sin recomprimir.
        return zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'STORE' });
    }
    return crearZip(entradas, { tipo: 'application/zip' });
}

/* ───────────────────────── Importación ───────────────────────── */

/**
 * Detecta el tipo de archivo por firma binaria y, en su defecto, por extensión.
 * @param {Uint8Array} bytes
 * @param {string} nombreArchivo
 * @returns {'josescan'|'ply'|'obj'}
 * @throws {Error} Si el tipo no es reconocible.
 */
function _detectarTipo(bytes, nombreArchivo) {
    const nombre = String(nombreArchivo || '').toLowerCase();
    // Firma ZIP: "PK".
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
        return 'josescan';
    }
    // Firma PLY: "ply" seguido de fin de línea.
    if (bytes.length >= 4 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79
        && (bytes[3] === 0x0a || bytes[3] === 0x0d)) {
        return 'ply';
    }
    if (nombre.endsWith('.josescan') || nombre.endsWith('.zip')) return 'josescan';
    if (nombre.endsWith('.ply')) return 'ply';
    if (nombre.endsWith('.obj')) return 'obj';

    // Último recurso: buscar directivas típicas de OBJ en las primeras líneas.
    const cabeza = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    if (/^\s*(v|vn|vt|f|g|o|mtllib|usemtl)\s/m.test(cabeza)) return 'obj';

    throw new Error('Formato no reconocido: se admiten archivos .josescan, .ply y .obj.');
}

/**
 * Importa un archivo del disco del usuario y lo guarda en la base.
 *
 * Admite `.josescan` (paquete completo), `.ply` (nube de puntos) y `.obj`
 * (malla). Los metadatos que falten se rellenan con valores por defecto:
 * nombre tomado del archivo, `creado` = ahora en ISO-8601, `sensor` =
 * `'importado'` y `formato` = `'josescan/1.0'`.
 *
 * @param {File|Blob} file
 * @returns {Promise<object>} Metadatos guardados.
 * @throws {Error} Si el archivo está vacío, es de un tipo no admitido o los
 *                 metadatos resultantes no son válidos.
 */
export async function importarArchivo(file) {
    if (!file) throw new Error('No se recibió ningún archivo para importar.');
    const nombreArchivo = file.name || 'escaneo';
    const buffer = await file.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) throw new Error(`El archivo "${nombreArchivo}" está vacío.`);
    const bytes = new Uint8Array(buffer);

    const tipo = _detectarTipo(bytes, nombreArchivo);
    const ahora = new Date().toISOString();

    if (tipo === 'josescan') {
        const paquete = await parseScanBundle(bytes);
        const meta = { ...(paquete.meta || {}) };
        meta.formato = FORMATO_ACTUAL;
        if (!meta.nombre) meta.nombre = _nombreBase(nombreArchivo);
        if (!meta.creado || !Number.isFinite(Date.parse(meta.creado))) meta.creado = ahora;
        if (!meta.sensor) meta.sensor = 'importado';
        meta.origen = 'importado';
        return guardarEscaneo({
            meta,
            nube: paquete.nube,
            malla: paquete.malla,
            miniatura: paquete.miniatura
        });
    }

    if (tipo === 'ply') {
        const nube = parsePLY(bytes);
        const malla = (nube.indices && nube.indices.length >= 3)
            ? { positions: nube.positions, normals: nube.normals, indices: nube.indices, count: nube.count }
            : null;
        const meta = {
            formato: FORMATO_ACTUAL,
            id: _uuid(),
            nombre: _nombreBase(nombreArchivo),
            creado: ahora,
            dispositivo: '',
            sistema: '',
            sensor: 'importado',
            marco: nube.frame,
            geo: null,
            duracionSegundos: 0,
            mediciones: [],
            proyecto: 'Proyecto General',
            notas: `Importado desde ${nombreArchivo}`,
            origen: 'importado'
        };
        return guardarEscaneo({ meta, nube, malla });
    }

    // tipo === 'obj'
    const texto = new TextDecoder('utf-8').decode(bytes);
    const malla = parseOBJ(texto);
    if (malla.count === 0) throw new Error(`El archivo "${nombreArchivo}" no contiene vértices legibles.`);
    const meta = {
        formato: FORMATO_ACTUAL,
        id: _uuid(),
        nombre: _nombreBase(nombreArchivo),
        creado: ahora,
        dispositivo: '',
        sistema: '',
        sensor: 'importado',
        marco: 'arkit',
        geo: null,
        duracionSegundos: 0,
        mediciones: [],
        proyecto: 'Proyecto General',
        notas: `Importado desde ${nombreArchivo}`,
        origen: 'importado'
    };
    return guardarEscaneo({ meta, malla: texto });
}

/* ───────────────────────── Mantenimiento ───────────────────────── */

/**
 * Cierra la conexión con `JoseScanDB` (útil al desmontar el módulo web).
 * @returns {void}
 */
export function cerrarScanDB() {
    if (_db) {
        try { _db.close(); } catch (e) { /* ya cerrada */ }
    }
    _db = null;
    _promesaDB = null;
}
