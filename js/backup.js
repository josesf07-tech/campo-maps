/**
 * JoseMaps · Respaldo y restauración completos en un archivo .zip
 *
 * Todos los datos de campo viven únicamente en el IndexedDB del teléfono
 * (CampoMapsDB). Si el usuario reinstala la PWA, el sistema libera espacio o
 * cambia de equipo, la jornada de campo se pierde. Este módulo empaqueta la
 * base completa en un .zip portable y la vuelve a montar en cualquier
 * dispositivo.
 *
 * ---------------------------------------------------------------------------
 * ESTRUCTURA DEL ARCHIVO .zip
 * ---------------------------------------------------------------------------
 *   manifest.json              Versión de formato, versión de app, fecha,
 *                              alcance y conteos por almacén.
 *   data/projects.json         Registros de IndexedDB en JSON (sin binarios).
 *   data/placemarks.json
 *   data/maps.json
 *   data/tracks.json
 *   data/settings.json
 *   media/photos/<id>_<n>.jpg  Fotos de los marcadores, como archivos reales.
 *   media/maps/<id>.png        Imagen del plano GeoPDF / mapa calibrado.
 *
 * Los binarios NO viajan en base64 dentro del JSON: cada foto y cada plano es
 * un archivo independiente del zip y el JSON solo guarda su ruta (campo
 * `file` en las fotos, `imageFile` en los mapas). Así un respaldo con 300
 * fotos sigue siendo un zip normal y no un JSON de 200 MB imposible de leer.
 *
 * ---------------------------------------------------------------------------
 * QUÉ NO SE RESPALDA (decisión de diseño consciente)
 * ---------------------------------------------------------------------------
 * Los mosaicos de mapa base descargados para uso offline NO se incluyen.
 * No viven en IndexedDB sino en la Cache API ('campo-maps-tiles', ver
 * tile-downloader.js y sw.js) y una sola descarga de buffer puede pesar
 * cientos de MB o varios GB: meterlos en el zip lo haría inmanejable y
 * además son datos reproducibles (se vuelven a descargar con conexión desde
 * el mismo diálogo de descarga offline). Los planos GeoPDF y las fotos, que
 * son irrecuperables, sí se respaldan siempre.
 */

import {
    STORE_KEY_PATHS,
    getStoreKeys, getRecord, putRecord, deleteRecord, clearStore
} from './storage.js';

export const BACKUP_FORMAT = 'josemaps-backup';
export const BACKUP_FORMAT_VERSION = 1;

const MANIFEST_NAME = 'manifest.json';
const DATA_DIR = 'data';
const PHOTOS_DIR = 'media/photos';
const MAPS_DIR = 'media/maps';

// Orden de recorrido: los proyectos y los puntos se leen antes que los mapas
// para saber qué planos hay que incluir en un respaldo por proyecto.
const STORE_ORDER = ['projects', 'placemarks', 'maps', 'tracks', 'settings'];

// Orden de escritura al restaurar: primero los contenedores, luego lo que
// los referencia.
const RESTORE_ORDER = ['projects', 'maps', 'tracks', 'placemarks', 'settings'];

const STORE_LABELS = {
    projects: 'Proyectos',
    placemarks: 'Marcadores',
    maps: 'Planos y mapas',
    tracks: 'Rutas GPS',
    settings: 'Ajustes'
};

// Campos donde los distintos flujos de la app guardan la imagen del plano
// (calibration.js usa imageUrl, app.js usa imageData).
const MAP_IMAGE_FIELDS = ['imageData', 'dataUrl', 'imageUrl'];

// Ajustes que dependen del dispositivo y no deben pisar los locales al fusionar.
const VOLATILE_SETTINGS = new Set(['activeProjectId']);

// Cada cuántos registros se cede el hilo para que la interfaz no se congele.
const YIELD_EVERY = 4;

const ICON_X = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/* ==========================================================================
   Utilidades
   ========================================================================== */

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Cede el hilo para que el navegador repinte (evita congelar la interfaz). */
function yieldToUI() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return `${bytes || 0} B`;
    const mb = bytes / (1024 * 1024);
    if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${mb.toFixed(1)} MB`;
}

function formatCount(n) {
    return Number(n || 0).toLocaleString('es-CO');
}

function safeSegment(value, fallback = 'item') {
    const clean = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    return clean || fallback;
}

function extFromMime(mime) {
    const map = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'application/pdf': 'pdf'
    };
    return map[String(mime || '').toLowerCase()] || 'bin';
}

/** Separa una data URL en tipo MIME y carga base64. Devuelve null si no lo es. */
function parseDataUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('data:')) return null;
    const match = url.match(/^data:([^;,]+)(;[^,]*)?;base64,(.*)$/s);
    if (!match) return null;
    return { mime: match[1], base64: match[3] };
}

/** Misma regla de pertenencia a proyecto que usa app.js. */
function belongsToProject(record, projectId) {
    if (!projectId || projectId === 'default_proj') {
        return !record.projectId || record.projectId === 'default_proj';
    }
    return record.projectId === projectId;
}

function isQuotaError(err) {
    if (!err) return false;
    const name = err.name || '';
    return name === 'QuotaExceededError'
        || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || /quota|espacio|storage full/i.test(err.message || '');
}

function describeError(err) {
    if (isQuotaError(err)) {
        return 'No queda espacio en el dispositivo para restaurar todos los datos. Libera espacio (o borra planos y mosaicos offline) y vuelve a intentarlo.';
    }
    return err && err.message ? err.message : String(err);
}

function requireJSZip() {
    if (!window.JSZip) {
        throw new Error('Librería JSZip no cargada. No es posible crear ni leer respaldos.');
    }
    return window.JSZip;
}

/* ==========================================================================
   Exportar
   ========================================================================== */

/**
 * Decide si un registro entra en el respaldo según el alcance elegido.
 */
function acceptsRecord(store, record, ctx) {
    if (ctx.scope === 'all') return true;

    if (store === 'projects') return record.id === ctx.projectId;
    if (store === 'placemarks') return belongsToProject(record, ctx.projectId);
    if (store === 'maps') return ctx.allowedMapIds.has(record.id);
    // Las rutas GPS no guardan projectId en el modelo de datos actual, así que
    // un respaldo por proyecto no puede saber cuáles le pertenecen.
    if (store === 'tracks') return false;
    // Los ajustes son de la aplicación, no de un proyecto: siempre viajan.
    if (store === 'settings') return true;
    return false;
}

/**
 * Extrae los binarios de un registro y los escribe como archivos del zip.
 * Devuelve una copia del registro apta para JSON.
 */
async function transformForExport(zip, store, record, ctx) {
    if (store === 'projects') {
        if (record.mapId) ctx.allowedMapIds.add(record.mapId);
        return { ...record };
    }

    if (store === 'placemarks') {
        if (record.mapId) ctx.allowedMapIds.add(record.mapId);
        const copy = { ...record };
        const photos = Array.isArray(record.photos) ? record.photos : [];
        const out = [];

        for (let i = 0; i < photos.length; i++) {
            const item = photos[i];
            const url = typeof item === 'string' ? item : (item && (item.url || item.dataUrl));
            const meta = (item && typeof item === 'object') ? { ...item } : {};
            delete meta.url;
            delete meta.dataUrl;

            const parsed = parseDataUrl(url);
            if (parsed) {
                const path = `${PHOTOS_DIR}/${safeSegment(record.id, 'pm')}_${i + 1}.${extFromMime(parsed.mime)}`;
                // Las fotos ya son JPEG comprimido: volver a comprimirlas solo
                // gasta CPU del teléfono, así que se guardan sin comprimir.
                zip.file(path, parsed.base64, { base64: true, compression: 'STORE' });
                meta.file = path;
                meta.mime = parsed.mime;
                ctx.counts.photos++;
                out.push(meta);
            } else if (typeof url === 'string' && url && !url.startsWith('blob:')) {
                // URL remota o de archivo local: se conserva la referencia.
                meta.url = url;
                out.push(meta);
            } else if (url) {
                ctx.warnings.push(`El marcador "${record.name || record.id}" tiene una foto temporal (blob:) que no se pudo respaldar.`);
            }
        }

        copy.photos = out;
        return copy;
    }

    if (store === 'maps') {
        const copy = { ...record };
        const field = MAP_IMAGE_FIELDS.find((f) => typeof record[f] === 'string' && record[f]);
        MAP_IMAGE_FIELDS.forEach((f) => delete copy[f]);

        if (!field) return copy;

        if (!ctx.includeMapImages) {
            copy.imageOmitted = true;
            ctx.counts.mapsWithoutImage++;
            return copy;
        }

        const parsed = parseDataUrl(record[field]);
        if (parsed) {
            const path = `${MAPS_DIR}/${safeSegment(record.id, 'map')}.${extFromMime(parsed.mime)}`;
            zip.file(path, parsed.base64, { base64: true, compression: 'STORE' });
            copy.imageFile = path;
            copy.imageField = field;
            copy.imageMime = parsed.mime;
            ctx.counts.mapImages++;
        } else {
            copy[field] = record[field];
        }
        return copy;
    }

    return { ...record };
}

/**
 * Recorre un almacén registro a registro (nunca con getAll) para no cargar
 * todas las fotos en memoria a la vez, y escribe data/<store>.json.
 */
async function exportStore(zip, store, ctx, onProgress) {
    const keys = await getStoreKeys(store);
    const records = [];
    let seen = 0;

    for (const key of keys) {
        let record = null;
        try {
            record = await getRecord(store, key);
        } catch (e) {
            ctx.warnings.push(`No se pudo leer un registro de ${STORE_LABELS[store]}: ${describeError(e)}`);
        }
        seen++;

        if (record && acceptsRecord(store, record, ctx)) {
            records.push(await transformForExport(zip, store, record, ctx));
        }

        if (onProgress) onProgress(store, seen, keys.length);
        if (seen % YIELD_EVERY === 0) await yieldToUI();
    }

    zip.file(`${DATA_DIR}/${store}.json`, JSON.stringify(records), {
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });

    return records.length;
}

/**
 * Conteo rápido de registros por almacén (solo claves, no lee las fotos).
 */
export async function getStoreCounts() {
    const counts = {};
    for (const store of RESTORE_ORDER) {
        try {
            counts[store] = (await getStoreKeys(store)).length;
        } catch (e) {
            counts[store] = 0;
        }
    }
    return counts;
}

/**
 * Genera el Blob del respaldo.
 *
 * @param {Object} options
 * @param {'all'|'project'} options.scope   Todo el dispositivo o un proyecto.
 * @param {string} [options.projectId]      Proyecto a respaldar si scope='project'.
 * @param {string} [options.projectName]
 * @param {boolean} [options.includeMapImages=true]  Incluir planos (pesan MB).
 * @param {string} [options.appVersion]
 * @param {Function} [options.onProgress]   ({ phase, percent, label })
 * @returns {Promise<{blob: Blob, manifest: Object, filename: string}>}
 */
export async function createBackupBlob({
    scope = 'all',
    projectId = null,
    projectName = '',
    includeMapImages = true,
    appVersion = '',
    onProgress = null
} = {}) {
    const JSZip = requireJSZip();
    const zip = new JSZip();

    const ctx = {
        scope,
        projectId,
        includeMapImages,
        allowedMapIds: new Set(),
        counts: { photos: 0, mapImages: 0, mapsWithoutImage: 0 },
        warnings: []
    };
    // allowedMapIds se rellena al recorrer proyectos y marcadores (que van
    // antes que los mapas en STORE_ORDER) con sus campos mapId.

    const report = (phase, percent, label) => {
        if (onProgress) onProgress({ phase, percent: Math.max(0, Math.min(100, percent)), label });
    };

    const counts = {};
    // La lectura de la base ocupa el primer 60 % de la barra; comprimir el 40 %.
    const slice = 60 / STORE_ORDER.length;

    for (let s = 0; s < STORE_ORDER.length; s++) {
        const store = STORE_ORDER[s];
        counts[store] = await exportStore(zip, store, ctx, (_store, done, total) => {
            const inner = total > 0 ? (done / total) : 1;
            report('read', (s * slice) + (inner * slice), `Leyendo ${STORE_LABELS[store].toLowerCase()}...`);
        });
    }

    const manifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        appVersion: appVersion || (window.CAMPOMAPS_VERSION || ''),
        createdAt: new Date().toISOString(),
        scope,
        projectId: scope === 'project' ? projectId : null,
        projectName: scope === 'project' ? projectName : null,
        includesMapImages: !!includeMapImages,
        counts,
        media: {
            photos: ctx.counts.photos,
            mapImages: ctx.counts.mapImages
        },
        keyPaths: STORE_KEY_PATHS,
        notes: [
            'Los mosaicos de mapa base descargados para uso offline no se incluyen: viven en la Cache API, pueden pesar varios GB y se pueden volver a descargar con conexión.',
            scope === 'project'
                ? 'Respaldo por proyecto: las rutas GPS no se incluyen porque no están asociadas a un proyecto en el modelo de datos.'
                : 'Respaldo completo del dispositivo.'
        ],
        warnings: ctx.warnings
    };

    zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));

    report('zip', 60, 'Comprimiendo respaldo...');
    const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
        // streamFiles queda desactivado a propósito: los descriptores de datos
        // que genera confunden a algunos descompresores de escritorio y el
        // respaldo tiene que poder abrirse también en un PC.
    }, (meta) => {
        report('zip', 60 + (meta.percent * 0.4), `Comprimiendo respaldo... ${Math.round(meta.percent)}%`);
    });

    report('done', 100, 'Respaldo listo');

    const stamp = new Date().toISOString().slice(0, 10);
    const tag = scope === 'project' ? safeSegment(projectName || projectId, 'Proyecto') : 'Completo';
    const filename = `JoseMaps_Respaldo_${tag}_${stamp}.zip`;

    return { blob, manifest, filename };
}

/**
 * Entrega el archivo al usuario: menú Compartir nativo en el teléfono
 * (Archivos, Drive, WhatsApp) y descarga estándar en escritorio.
 */
export async function deliverBackupFile(blob, filename) {
    const file = new File([blob], filename, { type: 'application/zip' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                title: 'JoseMaps · Respaldo de datos de campo',
                text: 'Copia de seguridad de proyectos, marcadores, fotos, rutas y planos.',
                files: [file]
            });
            return 'share';
        } catch (err) {
            if (err && err.name === 'AbortError') return 'cancelled';
            console.warn('Share falló, usando descarga estándar:', err);
        }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        if (a.parentNode) document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 2500);

    return 'download';
}

/* ==========================================================================
   Importar
   ========================================================================== */

/**
 * Abre y valida un archivo de respaldo SIN tocar la base de datos.
 * Devuelve el zip abierto, el manifiesto y los registros ya parseados
 * (los JSON no contienen binarios, así que ocupan poco).
 *
 * @param {File|Blob} file
 * @returns {Promise<{zip: Object, manifest: Object, data: Object, warnings: string[]}>}
 */
export async function readBackupFile(file) {
    const JSZip = requireJSZip();

    if (!file) throw new Error('No se seleccionó ningún archivo.');
    if (file.size === 0) throw new Error('El archivo está vacío.');

    let zip;
    try {
        zip = await JSZip.loadAsync(file);
    } catch (e) {
        throw new Error('El archivo no es un .zip válido o está dañado. Vuelve a copiarlo desde el origen.');
    }

    const manifestEntry = zip.file(MANIFEST_NAME);
    if (!manifestEntry) {
        throw new Error('El .zip no contiene manifest.json: no parece un respaldo de JoseMaps.');
    }

    let manifest;
    try {
        manifest = JSON.parse(await manifestEntry.async('string'));
    } catch (e) {
        throw new Error('El manifiesto del respaldo está dañado (JSON inválido).');
    }

    if (!manifest || manifest.format !== BACKUP_FORMAT) {
        throw new Error('Formato desconocido: este archivo no es un respaldo de JoseMaps.');
    }

    const version = Number(manifest.formatVersion);
    if (!Number.isFinite(version) || version < 1) {
        throw new Error('El respaldo no declara una versión de formato válida.');
    }
    if (version > BACKUP_FORMAT_VERSION) {
        throw new Error(`Este respaldo usa el formato v${version} y esta versión de JoseMaps solo entiende hasta v${BACKUP_FORMAT_VERSION}. Actualiza la aplicación antes de restaurarlo.`);
    }

    const warnings = [];
    if (manifest.appVersion && window.CAMPOMAPS_VERSION && manifest.appVersion !== window.CAMPOMAPS_VERSION) {
        warnings.push(`El respaldo se creó con JoseMaps ${manifest.appVersion} y esta app es ${window.CAMPOMAPS_VERSION}. Se restaurará igualmente.`);
    }
    if (manifest.includesMapImages === false) {
        warnings.push('Este respaldo se creó sin las imágenes de los planos: los mapas se restaurarán sin su plano de fondo.');
    }

    const data = {};
    for (const store of RESTORE_ORDER) {
        const entry = zip.file(`${DATA_DIR}/${store}.json`);
        if (!entry) {
            data[store] = [];
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(await entry.async('string'));
        } catch (e) {
            throw new Error(`El archivo data/${store}.json del respaldo está dañado (JSON inválido).`);
        }
        if (!Array.isArray(parsed)) {
            throw new Error(`El archivo data/${store}.json no tiene el formato esperado.`);
        }
        data[store] = parsed;
    }

    const total = RESTORE_ORDER.reduce((acc, s) => acc + data[s].length, 0);
    if (total === 0) {
        warnings.push('El respaldo no contiene ningún registro.');
    }

    return { zip, manifest, data, warnings };
}

/**
 * Compara el contenido del respaldo con lo que ya hay en el dispositivo.
 * Se usa para mostrar el resumen ANTES de escribir nada.
 */
export async function summarizeRestore(parsed) {
    const summary = {};
    let totalNew = 0;
    let totalExisting = 0;

    for (const store of RESTORE_ORDER) {
        const keyPath = STORE_KEY_PATHS[store];
        const existing = new Set(await getStoreKeys(store));
        const records = parsed.data[store] || [];
        let fresh = 0;
        let dup = 0;
        let invalid = 0;

        records.forEach((r) => {
            const key = r ? r[keyPath] : null;
            if (key === undefined || key === null || key === '') invalid++;
            else if (existing.has(key)) dup++;
            else fresh++;
        });

        summary[store] = { total: records.length, fresh, existing: dup, invalid, inDevice: existing.size };
        totalNew += fresh;
        totalExisting += dup;
    }

    summary.__totals = {
        records: RESTORE_ORDER.reduce((acc, s) => acc + summary[s].total, 0),
        fresh: totalNew,
        existing: totalExisting,
        photos: (parsed.manifest.media && parsed.manifest.media.photos) || 0,
        mapImages: (parsed.manifest.media && parsed.manifest.media.mapImages) || 0
    };

    return summary;
}

/**
 * Vuelve a montar los binarios de un registro leyéndolos del zip.
 */
async function hydrateRecord(store, record, zip, warnings) {
    if (store === 'placemarks') {
        const copy = { ...record };
        const photos = Array.isArray(record.photos) ? record.photos : [];
        const out = [];

        for (const meta of photos) {
            if (!meta || typeof meta !== 'object') continue;
            if (!meta.file) {
                if (meta.url) out.push({ ...meta });
                continue;
            }
            const entry = zip.file(meta.file);
            if (!entry) {
                warnings.push(`Falta la foto ${meta.file} dentro del respaldo: el marcador "${record.name || record.id}" se restaura sin ella.`);
                continue;
            }
            const base64 = await entry.async('base64');
            const clean = { ...meta };
            delete clean.file;
            delete clean.mime;
            clean.url = `data:${meta.mime || 'image/jpeg'};base64,${base64}`;
            out.push(clean);
        }

        copy.photos = out;
        return copy;
    }

    if (store === 'maps') {
        const copy = { ...record };
        if (!record.imageFile) return copy;

        const entry = zip.file(record.imageFile);
        delete copy.imageFile;
        delete copy.imageField;
        delete copy.imageMime;

        if (!entry) {
            warnings.push(`Falta el plano ${record.imageFile} dentro del respaldo: el mapa "${record.name || record.id}" se restaura sin imagen.`);
            return copy;
        }

        const base64 = await entry.async('base64');
        const field = MAP_IMAGE_FIELDS.includes(record.imageField) ? record.imageField : 'imageData';
        copy[field] = `data:${record.imageMime || 'image/png'};base64,${base64}`;
        return copy;
    }

    return { ...record };
}

/**
 * Restaura el respaldo en IndexedDB.
 *
 * Modos:
 *   'merge'   (por defecto) Añade solo lo que no existe. Los registros que ya
 *             están en el dispositivo se respetan tal cual: nunca se pisan.
 *   'replace' Vacía los almacenes y escribe el contenido del respaldo. Quien
 *             llama es responsable de pedir confirmación explícita y de
 *             ofrecer antes una copia de seguridad.
 *
 * Si algo falla a mitad de camino (zip dañado, cuota de almacenamiento
 * agotada) se deshace todo lo escrito en esta operación, de modo que la base
 * nunca queda con marcadores a medias o mapas sin plano.
 *
 * @returns {Promise<{added: Object, skipped: Object, warnings: string[], mode: string}>}
 */
export async function restoreBackup(parsed, { mode = 'merge', onProgress = null } = {}) {
    if (mode !== 'merge' && mode !== 'replace') {
        throw new Error(`Modo de restauración desconocido: ${mode}`);
    }
    if (!parsed || !parsed.zip || !parsed.data) {
        throw new Error('El respaldo no está cargado.');
    }

    const warnings = [...(parsed.warnings || [])];
    const added = {};
    const skipped = {};
    const written = [];

    const totalRecords = RESTORE_ORDER.reduce((acc, s) => acc + (parsed.data[s] || []).length, 0);
    let processed = 0;

    const report = (label) => {
        if (onProgress) {
            onProgress({
                done: processed,
                total: totalRecords,
                percent: totalRecords > 0 ? Math.round((processed / totalRecords) * 100) : 100,
                label
            });
        }
    };

    const existing = {};
    for (const store of RESTORE_ORDER) {
        existing[store] = new Set(await getStoreKeys(store));
    }

    if (mode === 'replace') {
        report('Vaciando datos anteriores...');
        for (const store of RESTORE_ORDER) {
            await clearStore(store);
            existing[store] = new Set();
        }
    }

    try {
        for (const store of RESTORE_ORDER) {
            const keyPath = STORE_KEY_PATHS[store];
            const records = parsed.data[store] || [];
            added[store] = 0;
            skipped[store] = 0;

            for (const record of records) {
                processed++;

                const key = record ? record[keyPath] : null;
                if (key === undefined || key === null || key === '') {
                    skipped[store]++;
                    warnings.push(`Se omitió un registro de ${STORE_LABELS[store]} sin identificador.`);
                    continue;
                }
                if (existing[store].has(key)) {
                    skipped[store]++;
                    continue;
                }
                if (store === 'settings' && mode === 'merge' && VOLATILE_SETTINGS.has(key)) {
                    skipped[store]++;
                    continue;
                }

                const hydrated = await hydrateRecord(store, record, parsed.zip, warnings);
                await putRecord(store, hydrated);
                existing[store].add(key);
                written.push({ store, key });
                added[store]++;

                if (processed % YIELD_EVERY === 0) {
                    report(`Restaurando ${STORE_LABELS[store].toLowerCase()}...`);
                    await yieldToUI();
                }
            }

            report(`Restaurando ${STORE_LABELS[store].toLowerCase()}...`);
        }
    } catch (err) {
        // Deshacer: se borra exactamente lo que esta operación escribió, así el
        // dispositivo queda como estaba antes de empezar (en modo fusionar) y
        // nunca con registros incompletos.
        for (let i = written.length - 1; i >= 0; i--) {
            try {
                await deleteRecord(written[i].store, written[i].key);
            } catch (e) {
                // Si tampoco se puede borrar no hay nada más que hacer aquí.
            }
        }
        const wrapped = new Error(describeError(err));
        wrapped.cause = err;
        wrapped.rolledBack = written.length;
        throw wrapped;
    }

    report('Restauración completada');
    return { added, skipped, warnings, mode };
}

/* ==========================================================================
   Interfaz (diálogos)
   ========================================================================== */

function ensureModal(id) {
    let modal = document.getElementById(id);
    if (!modal) {
        modal = document.createElement('div');
        modal.id = id;
        modal.className = 'modal';
        modal.setAttribute('data-no-dismiss', '');
        (document.getElementById('app-container') || document.body).appendChild(modal);
    }
    return modal;
}

function progressMarkup(prefix) {
    return `
        <div id="${prefix}-progress-box" class="progress-box hidden">
            <div class="progress-meta">
                <span id="${prefix}-status-text" class="status">Preparando...</span>
                <span id="${prefix}-percent-text" class="pct">0%</span>
            </div>
            <div class="progress-track"><div id="${prefix}-progress-bar" class="progress-fill"></div></div>
        </div>`;
}

function warningsMarkup(list) {
    if (!list || list.length === 0) return '';
    const items = list.slice(0, 8).map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    const more = list.length > 8 ? `<li>y ${list.length - 8} aviso(s) más...</li>` : '';
    return `<ul class="backup-log">${items}${more}</ul>`;
}

/**
 * Diálogo "Crear respaldo".
 *
 * @param {Object} ctx
 * @param {string} ctx.appVersion
 * @param {string} ctx.projectId    Proyecto activo.
 * @param {string} ctx.projectName
 * @param {Function} ctx.showToast
 */
export async function openBackupDialog(ctx = {}) {
    const showToast = ctx.showToast || (() => {});

    try {
        requireJSZip();
    } catch (e) {
        showToast('❌ ' + e.message);
        return;
    }

    let counts;
    try {
        counts = await getStoreCounts();
    } catch (e) {
        showToast('❌ No se pudo leer la base de datos: ' + describeError(e));
        return;
    }

    const hasProject = !!ctx.projectId;
    let scope = 'all';
    let includeMapImages = true;
    let busy = false;

    const modal = ensureModal('modal-backup-export');

    const render = () => {
        modal.innerHTML = `
            <div class="modal-content">
                <header class="modal-header">
                    <h2>Crear respaldo</h2>
                    <button class="btn-close-modal" id="btn-close-backup" aria-label="Cerrar">${ICON_X}</button>
                </header>
                <div class="modal-body">
                    <p class="text-xs mb-12">Guarda proyectos, marcadores, fotos, rutas y planos en un archivo <strong>.zip</strong> que puedes enviar a otro teléfono o dejar en la nube.</p>

                    ${hasProject ? `
                    <div class="card mb-12">
                        <div class="label mb-8">Qué respaldar</div>
                        <label class="dl-mode ${scope === 'all' ? 'selected' : ''}">
                            <input type="radio" name="bk-scope" value="all" ${scope === 'all' ? 'checked' : ''}>
                            <div>
                                <div class="dl-mode-title">Todo el dispositivo</div>
                                <div class="dl-mode-desc">Todos los proyectos, marcadores, rutas, planos y ajustes.</div>
                            </div>
                        </label>
                        <label class="dl-mode sky ${scope === 'project' ? 'selected' : ''}">
                            <input type="radio" name="bk-scope" value="project" ${scope === 'project' ? 'checked' : ''}>
                            <div>
                                <div class="dl-mode-title">Solo "${escapeHtml(ctx.projectName || 'Proyecto activo')}"</div>
                                <div class="dl-mode-desc">Sus marcadores, fotos y planos. Las rutas GPS no se incluyen: no están asociadas a un proyecto.</div>
                            </div>
                        </label>
                    </div>` : ''}

                    <div class="card spec-list mb-12">
                        <div><span>Proyectos</span><strong>${formatCount(counts.projects)}</strong></div>
                        <div><span>Marcadores</span><strong class="text-accent">${formatCount(counts.placemarks)}</strong></div>
                        <div><span>Rutas GPS</span><strong>${formatCount(counts.tracks)}</strong></div>
                        <div><span>Planos y mapas</span><strong class="text-sky">${formatCount(counts.maps)}</strong></div>
                    </div>

                    <label class="checkbox-row align-top">
                        <input type="checkbox" id="bk-include-maps" ${includeMapImages ? 'checked' : ''}>
                        <span>Incluir las imágenes de los planos<small class="setting-help">Necesarias para volver a ver los GeoPDF. Pueden pesar decenas de MB.</small></span>
                    </label>

                    <p class="backup-note mt-12">Los mosaicos de mapa base descargados para uso offline <strong>no</strong> se incluyen: pesan varios GB y se vuelven a descargar con conexión.</p>

                    ${progressMarkup('bk')}
                </div>
                <footer class="modal-footer">
                    <button type="button" class="btn-secondary" id="btn-cancel-backup">Cancelar</button>
                    <button type="button" class="btn-primary" id="btn-start-backup">
                        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Crear respaldo
                    </button>
                </footer>
            </div>`;

        modal.querySelectorAll('input[name="bk-scope"]').forEach((radio) => {
            radio.addEventListener('change', (e) => {
                scope = e.target.value;
                render();
            });
        });

        const chkMaps = modal.querySelector('#bk-include-maps');
        if (chkMaps) {
            chkMaps.addEventListener('change', () => { includeMapImages = chkMaps.checked; });
        }

        const close = () => {
            if (busy) {
                showToast('⚠️ El respaldo está en curso, espera a que termine');
                return;
            }
            modal.classList.add('hidden');
        };
        modal.querySelector('#btn-close-backup').addEventListener('click', close);
        modal.querySelector('#btn-cancel-backup').addEventListener('click', close);

        const btnStart = modal.querySelector('#btn-start-backup');
        btnStart.addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            btnStart.disabled = true;
            btnStart.textContent = 'Creando...';

            const box = modal.querySelector('#bk-progress-box');
            const bar = modal.querySelector('#bk-progress-bar');
            const status = modal.querySelector('#bk-status-text');
            const pct = modal.querySelector('#bk-percent-text');
            box.classList.remove('hidden');

            try {
                const { blob, manifest, filename } = await createBackupBlob({
                    scope,
                    projectId: ctx.projectId,
                    projectName: ctx.projectName,
                    includeMapImages,
                    appVersion: ctx.appVersion,
                    onProgress: ({ percent, label }) => {
                        bar.style.width = `${percent}%`;
                        pct.textContent = `${Math.round(percent)}%`;
                        status.textContent = label;
                    }
                });

                bar.style.width = '100%';
                pct.textContent = '100%';
                status.textContent = `✅ ${formatBytes(blob.size)} · ${formatCount(manifest.media.photos)} foto(s)`;

                const how = await deliverBackupFile(blob, filename);
                busy = false;
                btnStart.disabled = false;
                btnStart.textContent = 'Crear otro';

                if (how === 'cancelled') {
                    showToast('⚠️ Envío cancelado. El respaldo no se guardó.');
                } else {
                    showToast(`✅ Respaldo creado: ${formatBytes(blob.size)}`);
                    setTimeout(() => modal.classList.add('hidden'), 1600);
                }
            } catch (err) {
                console.error('Error creando respaldo:', err);
                busy = false;
                btnStart.disabled = false;
                btnStart.textContent = 'Reintentar';
                status.textContent = '❌ ' + describeError(err);
                showToast('❌ No se pudo crear el respaldo: ' + describeError(err));
            }
        });
    };

    render();
    modal.classList.remove('hidden');
}

/**
 * Diálogo "Restaurar respaldo": valida el archivo, muestra el resumen de lo
 * que se va a restaurar ANTES de tocar la base y deja elegir el modo.
 *
 * @param {File} file
 * @param {Object} ctx  { appVersion, showToast, onRestored }
 */
export async function openRestoreDialog(file, ctx = {}) {
    const showToast = ctx.showToast || (() => {});

    let parsed;
    let summary;
    try {
        parsed = await readBackupFile(file);
        summary = await summarizeRestore(parsed);
    } catch (err) {
        console.error('Error leyendo respaldo:', err);
        showToast('❌ ' + describeError(err), 5000);
        return;
    }

    const totals = summary.__totals;
    let mode = 'merge';
    let busy = false;
    let done = false;

    const modal = ensureModal('modal-backup-restore');
    const createdAt = parsed.manifest.createdAt
        ? new Date(parsed.manifest.createdAt).toLocaleString('es-CO')
        : 'desconocida';

    const rowFor = (store) => {
        const s = summary[store];
        if (!s || s.total === 0) return '';
        return `<div><span>${STORE_LABELS[store]}</span><strong>${formatCount(s.fresh)} nuevo(s)${s.existing ? ` · ${formatCount(s.existing)} ya existe(n)` : ''}</strong></div>`;
    };

    const render = () => {
        modal.innerHTML = `
            <div class="modal-content">
                <header class="modal-header">
                    <h2>Restaurar respaldo</h2>
                    <button class="btn-close-modal" id="btn-close-restore" aria-label="Cerrar">${ICON_X}</button>
                </header>
                <div class="modal-body">
                    <div class="card spec-list mb-12">
                        <div><span>Archivo</span><strong class="truncate">${escapeHtml(file.name || 'respaldo.zip')}</strong></div>
                        <div><span>Creado</span><strong>${escapeHtml(createdAt)}</strong></div>
                        <div><span>Versión de JoseMaps</span><strong>${escapeHtml(parsed.manifest.appVersion || '—')}</strong></div>
                        <div><span>Alcance</span><strong>${parsed.manifest.scope === 'project' ? escapeHtml(parsed.manifest.projectName || 'Un proyecto') : 'Todo el dispositivo'}</strong></div>
                    </div>

                    <div class="section-title">Qué contiene este respaldo</div>
                    <div class="card spec-list mb-12">
                        ${rowFor('projects')}
                        ${rowFor('placemarks')}
                        ${rowFor('tracks')}
                        ${rowFor('maps')}
                        ${rowFor('settings')}
                        <div><span>Fotos</span><strong class="text-accent">${formatCount(totals.photos)}</strong></div>
                        <div><span>Imágenes de planos</span><strong class="text-sky">${formatCount(totals.mapImages)}</strong></div>
                    </div>

                    <div class="card mb-12">
                        <div class="label mb-8">Cómo restaurar</div>
                        <label class="dl-mode ${mode === 'merge' ? 'selected' : ''}">
                            <input type="radio" name="rs-mode" value="merge" ${mode === 'merge' ? 'checked' : ''}>
                            <div>
                                <div class="dl-mode-title">Fusionar (recomendado)</div>
                                <div class="dl-mode-desc">Añade ${formatCount(totals.fresh)} registro(s) nuevo(s) y no borra ni modifica nada de lo que ya tienes${totals.existing ? ` (${formatCount(totals.existing)} ya están en el dispositivo y se conservan tal cual)` : ''}.</div>
                            </div>
                        </label>
                        <label class="dl-mode ${mode === 'replace' ? 'selected' : ''}">
                            <input type="radio" name="rs-mode" value="replace" ${mode === 'replace' ? 'checked' : ''}>
                            <div>
                                <div class="dl-mode-title">Reemplazar todo</div>
                                <div class="dl-mode-desc">Borra los datos actuales del teléfono y deja únicamente los del respaldo. Antes se descarga una copia de seguridad de lo que hay ahora.</div>
                            </div>
                        </label>
                    </div>

                    ${mode === 'replace' ? `<p class="backup-danger">⚠️ Se borrarán ${formatCount((summary.placemarks && summary.placemarks.inDevice) || 0)} marcador(es) y el resto de datos que hay ahora en este teléfono.</p>` : ''}

                    ${warningsMarkup(parsed.warnings)}

                    ${progressMarkup('rs')}
                </div>
                <footer class="modal-footer">
                    <button type="button" class="btn-secondary" id="btn-cancel-restore">Cancelar</button>
                    <button type="button" class="${mode === 'replace' ? 'btn-danger' : 'btn-primary'}" id="btn-start-restore">
                        ${mode === 'replace' ? 'Reemplazar todo' : `Restaurar ${formatCount(totals.fresh)} registro(s)`}
                    </button>
                </footer>
            </div>`;

        modal.querySelectorAll('input[name="rs-mode"]').forEach((radio) => {
            radio.addEventListener('change', (e) => {
                mode = e.target.value;
                render();
            });
        });

        const close = () => {
            if (busy) {
                showToast('⚠️ La restauración está en curso, espera a que termine');
                return;
            }
            modal.classList.add('hidden');
            if (done && ctx.onRestored) ctx.onRestored();
        };
        modal.querySelector('#btn-close-restore').addEventListener('click', close);
        modal.querySelector('#btn-cancel-restore').addEventListener('click', close);

        const btnStart = modal.querySelector('#btn-start-restore');
        btnStart.addEventListener('click', async () => {
            if (busy || done) return;

            if (totals.fresh === 0 && mode === 'merge') {
                showToast('⚠️ Todos los registros del respaldo ya están en este dispositivo');
                return;
            }

            const box = modal.querySelector('#rs-progress-box');
            const bar = modal.querySelector('#rs-progress-bar');
            const status = modal.querySelector('#rs-status-text');
            const pct = modal.querySelector('#rs-percent-text');

            if (mode === 'replace') {
                const ok = confirm('REEMPLAZAR TODO\n\nSe borrarán los proyectos, marcadores, fotos, rutas y planos que hay ahora en este teléfono y quedarán solo los del respaldo.\n\nPrimero se guardará una copia de seguridad de los datos actuales. ¿Continuar?');
                if (!ok) return;

                busy = true;
                btnStart.disabled = true;
                box.classList.remove('hidden');
                status.textContent = 'Guardando copia de seguridad de los datos actuales...';

                try {
                    const safety = await createBackupBlob({
                        scope: 'all',
                        includeMapImages: true,
                        appVersion: ctx.appVersion,
                        onProgress: ({ percent }) => {
                            bar.style.width = `${percent * 0.3}%`;
                            pct.textContent = `${Math.round(percent * 0.3)}%`;
                        }
                    });
                    await deliverBackupFile(safety.blob, safety.filename.replace('.zip', '_ANTES_DE_RESTAURAR.zip'));
                } catch (err) {
                    console.warn('No se pudo crear la copia de seguridad previa:', err);
                    const forzar = confirm('No se pudo crear la copia de seguridad previa:\n\n' + describeError(err) + '\n\n¿Reemplazar los datos de todos modos? Esta acción no se puede deshacer.');
                    if (!forzar) {
                        busy = false;
                        btnStart.disabled = false;
                        box.classList.add('hidden');
                        return;
                    }
                }

                const ok2 = confirm('Última confirmación: se borran los datos actuales y se restaura el respaldo. ¿Continuar?');
                if (!ok2) {
                    busy = false;
                    btnStart.disabled = false;
                    box.classList.add('hidden');
                    return;
                }
            } else {
                busy = true;
                btnStart.disabled = true;
                box.classList.remove('hidden');
            }

            btnStart.textContent = 'Restaurando...';

            try {
                const result = await restoreBackup(parsed, {
                    mode,
                    onProgress: ({ percent, label }) => {
                        const shown = mode === 'replace' ? 30 + (percent * 0.7) : percent;
                        bar.style.width = `${shown}%`;
                        pct.textContent = `${Math.round(shown)}%`;
                        status.textContent = label;
                    }
                });

                bar.style.width = '100%';
                pct.textContent = '100%';

                const totalAdded = Object.values(result.added).reduce((a, b) => a + b, 0);
                const totalSkipped = Object.values(result.skipped).reduce((a, b) => a + b, 0);
                status.textContent = `✅ ${formatCount(totalAdded)} registro(s) restaurado(s)${totalSkipped ? ` · ${formatCount(totalSkipped)} omitido(s)` : ''}`;

                done = true;
                busy = false;
                btnStart.disabled = false;
                btnStart.textContent = 'Listo';

                showToast(`✅ Respaldo restaurado: ${formatCount(totalAdded)} registro(s)`, 4000);
                if (result.warnings.length > 0) {
                    console.warn('[Backup] Avisos de la restauración:', result.warnings);
                }

                setTimeout(() => {
                    modal.classList.add('hidden');
                    if (ctx.onRestored) ctx.onRestored(result);
                }, 1400);
            } catch (err) {
                console.error('Error restaurando respaldo:', err);
                busy = false;
                btnStart.disabled = false;
                btnStart.textContent = 'Reintentar';
                status.textContent = '❌ ' + describeError(err);
                const undone = err.rolledBack ? ` Se deshicieron ${formatCount(err.rolledBack)} registro(s) para no dejar la base a medias.` : '';
                showToast('❌ No se pudo restaurar: ' + describeError(err) + undone, 6000);
            }
        });
    };

    render();
    modal.classList.remove('hidden');
}
