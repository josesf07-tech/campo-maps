/* ==========================================================================
   JoseScan · Interfaz web del módulo de escaneos 3D LiDAR para JoseMaps
   --------------------------------------------------------------------------
   Módulo ES nativo autoarrancable. No requiere editar app.js: inyecta su
   propio botón en el dock `.map-controls`, su propio panel lateral y todas
   sus capas modales (captura, visor y exportación).

   API pública:
     initLidarUI(opciones)   → arranque idempotente
     abrirPanelLidar()       → abre el panel lateral
     cerrarPanelLidar()      → cierra el panel lateral

   Puente opcional con el mapa (si existe `window.JoseMapsBridge`):
     agregarHuellaEscaneo(geojson, meta) · toast(mensaje, tipo) · proyectoActual()
   ========================================================================== */

import { detectarCapacidades, LidarScanner } from './lidar-scanner.js';
import {
    initScanDB,
    guardarEscaneo,
    listarEscaneos,
    obtenerEscaneo,
    actualizarMeta,
    eliminarEscaneo,
    espacioUsado,
    exportarTodo,
    importarArchivo
} from './lidar-store.js';
import { scanAGeoJSON, scanAMagnaSirgas, resumenGeo, boundsDe } from './lidar-geo.js';
import { writePLY, writeOBJ, writeXYZ, writeCSV, buildScanBundle } from './lidar-formats.js';

/* --------------------------------------------------------------------------
   0. Estado del módulo
   -------------------------------------------------------------------------- */

const RUTA_GUIA = 'docs/GUIA-ESCANEO.md';

const S = {
    iniciado: false,
    iniciando: null,
    opciones: {},
    capacidades: null,
    panel: null,
    overlay: null,
    overlayPropio: false,
    boton: null,
    escaneos: [],
    cargandoGaleria: false,
    urlsMiniatura: [],
    // Captura
    captura: null,
    scanner: null,
    scannerActivo: false,
    scannerPausado: false,
    rafFps: 0,
    // Visor
    visor: null,
    viewer: null,
    visorRegistro: null,
    temporizadorMediciones: 0,
    // Capas apiladas (para Escape y foco)
    capas: []
};

/* --------------------------------------------------------------------------
   1. Utilidades generales
   -------------------------------------------------------------------------- */

/** Espera un frame de pintado: permite trocear bucles largos. */
function frame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Crea un elemento con atributos y contenido. */
function el(tag, attrs = {}, hijos = []) {
    const nodo = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') nodo.className = v;
        else if (k === 'text') nodo.textContent = v;
        else if (k === 'html') nodo.innerHTML = v;
        else if (k === 'dataset') Object.assign(nodo.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') nodo.addEventListener(k.slice(2), v);
        else if (v === true) nodo.setAttribute(k, '');
        else nodo.setAttribute(k, String(v));
    }
    const lista = Array.isArray(hijos) ? hijos : [hijos];
    for (const h of lista) {
        if (h === null || h === undefined || h === false) continue;
        nodo.appendChild(typeof h === 'string' ? document.createTextNode(h) : h);
    }
    return nodo;
}

/** Iconos SVG propios (no dependen del sprite de la app). */
const ICONOS = {
    escaner: '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="m12 7 5 2.8v5.6L12 18l-5-2.6V9.8z"/><path d="M12 7v11"/><path d="m7 9.8 5 2.9 5-2.9"/>',
    cerrar: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    ojo: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
    mapa: '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
    descargar: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    subir: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    lapiz: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    papelera: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pausa: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    reproducir: '<polygon points="6 4 20 12 6 20 6 4"/>',
    reiniciar: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/>',
    detener: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    regla: '<path d="M2.5 14.5 9.5 21.5 21.5 9.5 14.5 2.5z"/><line x1="6" y1="12" x2="8" y2="14"/><line x1="9" y1="9" x2="11" y2="11"/><line x1="12" y1="6" x2="14" y2="8"/>',
    camara: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    paquete: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    manzana: '<path d="M16.7 12.6c0-2.4 2-3.6 2.1-3.6-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.6.9s-1.9-.9-3.1-.8c-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.2 1.2 9.5.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8s1.9.8 3.1.7c1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7 0 0-2.5-1-2.6-3.8z"/><path d="M14.5 5.1c.6-.8 1.1-1.8 1-2.9-.9 0-2.1.6-2.8 1.4-.6.7-1.1 1.8-1 2.8 1 .1 2.1-.5 2.8-1.3z"/>',
    aviso: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    cubo: '<path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5"/><path d="M12 12v10"/>',
    globo: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    disco: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>'
};

/** Devuelve un nodo SVG del icono indicado. */
function icono(nombre, tamano = 18, grosor = 2) {
    const molde = document.createElement('div');
    molde.innerHTML =
        '<svg viewBox="0 0 24 24" width="' + tamano + '" height="' + tamano + '" fill="none" ' +
        'stroke="currentColor" stroke-width="' + grosor + '" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONOS[nombre] || '') + '</svg>';
    return molde.firstElementChild;
}

/** Puente opcional con la app anfitriona. */
function puente() {
    const b = typeof window !== 'undefined' ? window.JoseMapsBridge : null;
    return b && typeof b === 'object' ? b : null;
}

/** Notificación: usa el puente si existe, si no el contenedor de toasts de la app. */
function aviso(mensaje, tipo = 'info') {
    try {
        const b = puente();
        if (b && typeof b.toast === 'function') {
            b.toast(mensaje, tipo);
            return;
        }
    } catch (_e) { /* si el puente falla seguimos con el aviso propio */ }

    let cont = document.getElementById('toast-container');
    if (!cont) {
        cont = document.getElementById('lidar-toast-container');
        if (!cont) {
            cont = el('div', { id: 'lidar-toast-container', 'aria-live': 'polite' });
            document.body.appendChild(cont);
        }
    }
    const clase = tipo === 'error' ? ' toast-error' : tipo === 'warn' ? ' toast-warn' : tipo === 'exito' ? '' : ' toast-info';
    const t = el('div', { class: 'toast' + clase, role: 'status', text: mensaje });
    while (cont.children.length >= 3) cont.removeChild(cont.firstChild);
    cont.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 3200);
}

/** Nombre del proyecto activo, si la app lo expone. */
function proyectoActual() {
    try {
        const b = puente();
        if (b && typeof b.proyectoActual === 'function') {
            const p = b.proyectoActual();
            if (typeof p === 'string' && p.trim()) return p.trim();
            if (p && typeof p === 'object' && typeof p.nombre === 'string') return p.nombre;
        }
    } catch (_e) { /* sin proyecto */ }
    return null;
}

/** Mensaje legible de un error. */
function textoError(err) {
    if (!err) return 'Error desconocido.';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    return String(err);
}

const NF0 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF2 = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtEntero(n) {
    const v = Number(n);
    return Number.isFinite(v) ? NF0.format(v) : '--';
}

/** Bytes en KB / MB / GB con coma decimal (es-CO). */
function fmtBytes(bytes) {
    const b = Number(bytes);
    if (!Number.isFinite(b) || b <= 0) return '0 MB';
    if (b < 1024) return fmtEntero(b) + ' B';
    if (b < 1024 * 1024) return NF1.format(b / 1024) + ' KB';
    if (b < 1024 * 1024 * 1024) return NF1.format(b / (1024 * 1024)) + ' MB';
    return NF2.format(b / (1024 * 1024 * 1024)) + ' GB';
}

function fmtFecha(iso) {
    if (!iso) return 'Sin fecha';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Sin fecha';
    try {
        return new Intl.DateTimeFormat('es-CO', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        }).format(d);
    } catch (_e) {
        return d.toLocaleString('es-CO');
    }
}

function fmtDuracion(segundos) {
    const s = Number(segundos);
    if (!Number.isFinite(s) || s <= 0) return null;
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return m > 0 ? m + ' min ' + r + ' s' : r + ' s';
}

/** Limpia un nombre para usarlo como nombre de archivo. */
function nombreArchivo(base, extension) {
    const limpio = String(base || 'escaneo')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s.-]/g, '')
        .trim().replace(/\s+/g, '_')
        .slice(0, 60) || 'escaneo';
    return limpio + '.' + extension;
}

/** Normaliza cualquier salida de los escritores a un Blob. */
function aBlob(datos, mime) {
    const tipo = mime || 'application/octet-stream';
    if (!datos) return null;
    if (datos instanceof Blob) return datos;
    if (datos instanceof ArrayBuffer) return new Blob([datos], { type: tipo });
    if (ArrayBuffer.isView(datos)) return new Blob([datos.buffer.slice(datos.byteOffset, datos.byteOffset + datos.byteLength)], { type: tipo });
    if (typeof datos === 'string') return new Blob([datos], { type: tipo });
    if (datos.blob instanceof Blob) return datos.blob;
    if (typeof datos === 'object') return new Blob([JSON.stringify(datos)], { type: 'application/json' });
    return new Blob([String(datos)], { type: tipo });
}

const ES_IOS = (() => {
    try {
        const ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/.test(ua) ||
            (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
    } catch (_e) { return false; }
})();

/**
 * Descarga un Blob. En iOS, si la descarga directa no funciona, ofrece
 * `navigator.share` con archivos.
 */
async function descargar(blob, nombre) {
    if (!blob) throw new Error('No se generó ningún archivo.');

    if (ES_IOS && typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
        try {
            const archivo = new File([blob], nombre, { type: blob.type || 'application/octet-stream' });
            if (navigator.canShare({ files: [archivo] })) {
                await navigator.share({ files: [archivo], title: nombre });
                return true;
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return false;
            /* si compartir falla seguimos con la descarga clásica */
        }
    }

    let url = '';
    try {
        url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: nombre, rel: 'noopener' });
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        await frame();
        a.remove();
        return true;
    } catch (err) {
        if (ES_IOS && typeof navigator.share === 'function') {
            try {
                const archivo = new File([blob], nombre, { type: blob.type || 'application/octet-stream' });
                await navigator.share({ files: [archivo], title: nombre });
                return true;
            } catch (_e2) { /* nada más que intentar */ }
        }
        throw err;
    } finally {
        if (url) setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
}

/* --------------------------------------------------------------------------
   2. Normalización de los datos del almacén
   -------------------------------------------------------------------------- */

function listaDe(resultado) {
    if (Array.isArray(resultado)) return resultado;
    if (!resultado || typeof resultado !== 'object') return [];
    for (const k of ['items', 'escaneos', 'resultados', 'lista', 'datos']) {
        if (Array.isArray(resultado[k])) return resultado[k];
    }
    return [];
}

function metaDe(registro) {
    if (!registro || typeof registro !== 'object') return null;
    if (registro.meta && typeof registro.meta === 'object') return registro.meta;
    if (registro.metadatos && typeof registro.metadatos === 'object') return registro.metadatos;
    return registro;
}

function nubeDe(registro) {
    if (!registro || typeof registro !== 'object') return null;
    return registro.nube || registro.nubeDePuntos || registro.pointCloud || registro.puntosNube ||
        (registro.positions ? registro : null);
}

function mallaDe(registro) {
    if (!registro || typeof registro !== 'object') return null;
    return registro.malla || registro.mesh || registro.mallaObj || null;
}

function idDe(meta) {
    if (!meta) return '';
    return String(meta.id || meta.uuid || meta.clave || meta.key || '');
}

function bytesDe(resultado) {
    if (typeof resultado === 'number') return resultado;
    if (!resultado || typeof resultado !== 'object') return 0;
    for (const k of ['bytes', 'usado', 'usadoBytes', 'total', 'tamano', 'size']) {
        if (typeof resultado[k] === 'number') return resultado[k];
    }
    return 0;
}

function cuotaDe(resultado) {
    if (!resultado || typeof resultado !== 'object') return 0;
    for (const k of ['cuota', 'quota', 'disponible', 'limite']) {
        if (typeof resultado[k] === 'number') return resultado[k];
    }
    return 0;
}

/** Texto corto de georreferenciación a partir de `resumenGeo`. */
function textoGeo(meta) {
    try {
        const r = resumenGeo(meta);
        if (typeof r === 'string') return r.trim() || null;
        if (r && typeof r === 'object') {
            for (const k of ['texto', 'resumen', 'etiqueta', 'descripcion', 'label']) {
                if (typeof r[k] === 'string' && r[k].trim()) return r[k].trim();
            }
        }
    } catch (_e) { /* seguimos con el respaldo */ }
    const geo = meta && meta.geo;
    if (geo && Number.isFinite(Number(geo.latitude)) && Number.isFinite(Number(geo.longitude))) {
        return NF2.format(Number(geo.latitude)) + ', ' + NF2.format(Number(geo.longitude));
    }
    return null;
}

/** Coordenadas MAGNA-SIRGAS del origen del escaneo, si se pueden calcular. */
function textoMagna(meta) {
    try {
        const r = scanAMagnaSirgas(meta);
        if (!r) return null;
        if (typeof r === 'string') return r;
        const n = Number(r.norte ?? r.N ?? r.y);
        const e = Number(r.este ?? r.E ?? r.x);
        if (Number.isFinite(n) && Number.isFinite(e)) {
            return 'N ' + NF1.format(n) + ' · E ' + NF1.format(e);
        }
    } catch (_e) { /* sin coordenadas planas */ }
    return null;
}

/** Dimensiones de la caja envolvente, del meta o calculadas con `boundsDe`. */
function textoDimensiones(meta, nube) {
    let bbox = meta && meta.bbox;
    if ((!bbox || !bbox.min || !bbox.max) && nube) {
        try {
            const pos = nube.positions || nube.puntos || nube;
            if (pos && (ArrayBuffer.isView(pos) || Array.isArray(pos))) bbox = boundsDe(pos);
        } catch (_e) { bbox = null; }
    }
    if (!bbox) return null;
    const min = bbox.min || bbox[0];
    const max = bbox.max || bbox[1];
    if (!min || !max) return null;
    const dx = Math.abs(Number(max[0]) - Number(min[0]));
    const dy = Math.abs(Number(max[1]) - Number(min[1]));
    const dz = Math.abs(Number(max[2]) - Number(min[2]));
    if (![dx, dy, dz].every(Number.isFinite)) return null;
    return NF1.format(dx) + ' × ' + NF1.format(dy) + ' × ' + NF1.format(dz) + ' m';
}

/** URL de la miniatura (Blob, dataURL o ArrayBuffer). Registra para revocar. */
function urlMiniatura(valor) {
    if (!valor) return null;
    try {
        if (typeof valor === 'string') return valor;
        if (valor instanceof Blob) {
            const u = URL.createObjectURL(valor);
            S.urlsMiniatura.push(u);
            return u;
        }
        if (valor instanceof ArrayBuffer || ArrayBuffer.isView(valor)) {
            const u = URL.createObjectURL(new Blob([valor], { type: 'image/jpeg' }));
            S.urlsMiniatura.push(u);
            return u;
        }
    } catch (_e) { /* sin miniatura */ }
    return null;
}

function revocarMiniaturas() {
    for (const u of S.urlsMiniatura) {
        try { URL.revokeObjectURL(u); } catch (_e) { /* ya revocada */ }
    }
    S.urlsMiniatura = [];
}

/* --------------------------------------------------------------------------
   3. Capas: foco atrapado y tecla Escape
   -------------------------------------------------------------------------- */

const SELECTOR_FOCO = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function enfocables(raiz) {
    return Array.from(raiz.querySelectorAll(SELECTOR_FOCO))
        .filter((n) => n.offsetWidth > 0 || n.offsetHeight > 0 || n === document.activeElement);
}

function atraparFoco(raiz) {
    function onKey(e) {
        if (e.key !== 'Tab') return;
        const items = enfocables(raiz);
        if (!items.length) return;
        const primero = items[0];
        const ultimo = items[items.length - 1];
        if (e.shiftKey && document.activeElement === primero) {
            e.preventDefault();
            ultimo.focus();
        } else if (!e.shiftKey && document.activeElement === ultimo) {
            e.preventDefault();
            primero.focus();
        }
    }
    raiz.addEventListener('keydown', onKey);
    return () => raiz.removeEventListener('keydown', onKey);
}

function abrirCapa(nodo, cerrar, { foco = true } = {}) {
    const previo = document.activeElement;
    const liberar = atraparFoco(nodo);
    S.capas.push({ nodo, cerrar, liberar, previo });
    if (foco) {
        requestAnimationFrame(() => {
            const items = enfocables(nodo);
            if (items.length) items[0].focus();
        });
    }
}

function cerrarCapa(nodo) {
    const i = S.capas.findIndex((c) => c.nodo === nodo);
    if (i < 0) return;
    const capa = S.capas.splice(i, 1)[0];
    try { capa.liberar(); } catch (_e) { /* ya liberada */ }
    if (capa.previo && document.contains(capa.previo)) {
        try { capa.previo.focus(); } catch (_e) { /* sin foco previo */ }
    }
}

function onTeclaGlobal(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (S.capas.length) {
        const capa = S.capas[S.capas.length - 1];
        e.preventDefault();
        try { capa.cerrar(); } catch (err) { console.warn('[JoseScan] Error al cerrar capa:', err); }
        return;
    }
    if (S.panel && S.panel.classList.contains('open')) {
        e.preventDefault();
        cerrarPanelLidar();
    }
}

/* --------------------------------------------------------------------------
   4. Construcción del botón y del panel
   -------------------------------------------------------------------------- */

function asegurarHojaEstilos() {
    try {
        if (document.querySelector('link[href*="lidar.css"]')) return;
        const enlace = el('link', { rel: 'stylesheet', href: 'css/lidar.css' });
        document.head.appendChild(enlace);
    } catch (_e) { /* la hoja la puede enlazar el index */ }
}

function crearBoton() {
    if (document.getElementById('btn-lidar-open')) {
        S.boton = document.getElementById('btn-lidar-open');
        return;
    }
    const btn = el('button', {
        id: 'btn-lidar-open',
        type: 'button',
        class: 'control-btn',
        'aria-label': 'Escaneos 3D',
        title: 'Escaneos 3D LiDAR (JoseScan)',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false'
    }, [icono('escaner', 22, 2)]);

    btn.addEventListener('click', () => {
        if (S.panel && S.panel.classList.contains('open')) cerrarPanelLidar();
        else abrirPanelLidar();
    });

    const dock = document.querySelector('.map-controls');
    if (dock) {
        const medir = dock.querySelector('#btn-measure-toggle');
        if (medir && medir.parentNode === dock) dock.insertBefore(btn, medir.nextSibling);
        else dock.appendChild(btn);
    } else {
        btn.classList.add('lidar-boton-suelto');
        (document.getElementById('app') || document.getElementById('app-container') || document.body).appendChild(btn);
    }
    S.boton = btn;
}

function contenedorRaiz() {
    return document.getElementById('app') || document.getElementById('app-container') || document.body;
}

function asegurarOverlay() {
    const existente = document.getElementById('panel-overlay');
    if (existente) {
        S.overlay = existente;
        S.overlayPropio = false;
    } else {
        let propio = document.getElementById('lidar-overlay');
        if (!propio) {
            propio = el('div', { id: 'lidar-overlay', class: 'lidar-overlay lidar-oculto' });
            contenedorRaiz().appendChild(propio);
        }
        S.overlay = propio;
        S.overlayPropio = true;
    }
    S.overlay.addEventListener('click', () => {
        if (S.panel && S.panel.classList.contains('open')) cerrarPanelLidar();
    });
}

function mostrarOverlay(visible) {
    if (!S.overlay) return;
    if (S.overlayPropio) S.overlay.classList.toggle('lidar-oculto', !visible);
    else S.overlay.classList.toggle('hidden', !visible);
}

function crearPanel() {
    if (document.getElementById('panel-lidar')) {
        S.panel = document.getElementById('panel-lidar');
        return;
    }

    const cerrarBtn = el('button', {
        type: 'button',
        class: 'btn-close-panel',
        'aria-label': 'Cerrar panel de escaneos 3D',
        onclick: () => cerrarPanelLidar()
    }, [icono('cerrar', 18, 2)]);

    const cabecera = el('header', { class: 'panel-header' }, [
        el('div', {}, [
            el('h2', { id: 'lidar-panel-titulo', text: 'Escaneos 3D' }),
            el('div', { class: 'panel-subtitle', text: 'Nubes de puntos LiDAR georreferenciadas' })
        ]),
        cerrarBtn
    ]);

    const contenido = el('div', { class: 'panel-content' }, [
        el('section', { id: 'lidar-sensor', class: 'lidar-seccion', 'aria-label': 'Estado del sensor' }),
        el('section', { id: 'lidar-sec-escanear', class: 'lidar-seccion lidar-oculto', 'aria-label': 'Escanear' }),
        seccionImportar(),
        seccionGaleria(),
        seccionAlmacenamiento()
    ]);

    const panel = el('aside', {
        id: 'panel-lidar',
        class: 'side-panel lidar-panel',
        role: 'dialog',
        'aria-modal': 'false',
        'aria-labelledby': 'lidar-panel-titulo',
        'aria-label': 'Escaneos 3D'
    }, [cabecera, contenido]);

    contenedorRaiz().appendChild(panel);
    S.panel = panel;
}

/* --- Sección 3: importar ------------------------------------------------- */

function seccionImportar() {
    const input = el('input', {
        type: 'file',
        id: 'lidar-importar-input',
        class: 'lidar-input-archivo',
        accept: '.josescan,.ply,.obj',
        multiple: true,
        'aria-label': 'Seleccionar archivos de escaneo para importar'
    });
    input.addEventListener('change', () => {
        const archivos = Array.from(input.files || []);
        input.value = '';
        if (archivos.length) importarArchivos(archivos);
    });

    const zona = el('div', {
        id: 'lidar-dropzone',
        class: 'lidar-dropzone',
        role: 'button',
        tabindex: '0',
        'aria-label': 'Zona para arrastrar y soltar archivos de escaneo'
    }, [
        icono('subir', 26, 1.8),
        el('div', { class: 'lidar-dropzone-titulo', text: 'Arrastra aquí tus escaneos' }),
        el('div', { class: 'lidar-dropzone-ayuda', text: 'Formatos aceptados: .josescan, .ply y .obj' })
    ]);

    zona.addEventListener('click', () => input.click());
    zona.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    ['dragenter', 'dragover'].forEach((ev) => {
        zona.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            zona.classList.add('lidar-dropzone-activa');
        });
    });
    ['dragleave', 'dragend'].forEach((ev) => {
        zona.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            zona.classList.remove('lidar-dropzone-activa');
        });
    });
    zona.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zona.classList.remove('lidar-dropzone-activa');
        const archivos = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (archivos.length) importarArchivos(archivos);
    });

    const progreso = el('div', { id: 'lidar-progreso-importar', class: 'lidar-progreso lidar-oculto' }, [
        el('div', { class: 'lidar-progreso-barra' }, [el('span', { class: 'lidar-progreso-relleno' })]),
        el('div', { class: 'lidar-progreso-texto', text: 'Preparando…' })
    ]);

    return el('section', { class: 'lidar-seccion', 'aria-label': 'Importar escaneos' }, [
        el('div', { class: 'section-title', text: 'Importar' }),
        el('button', {
            type: 'button',
            class: 'btn-outline sky btn-block',
            onclick: () => input.click()
        }, [icono('subir'), 'Elegir archivos de escaneo']),
        input,
        zona,
        progreso,
        el('div', { id: 'lidar-resumen-importar', class: 'lidar-resumen lidar-oculto', role: 'status', 'aria-live': 'polite' })
    ]);
}

/* --- Sección 4: galería -------------------------------------------------- */

function seccionGaleria() {
    return el('section', { class: 'lidar-seccion', 'aria-label': 'Galería de escaneos' }, [
        el('div', { class: 'row-between lidar-titulo-fila' }, [
            el('div', { class: 'section-title lidar-titulo-plano', text: 'Escaneos guardados' }),
            el('button', {
                type: 'button',
                id: 'btn-lidar-refrescar',
                class: 'btn-ghost sky btn-sm',
                'aria-label': 'Actualizar la lista de escaneos',
                onclick: () => refrescarGaleria()
            }, [icono('reiniciar', 16), 'Actualizar'])
        ]),
        el('div', { id: 'lidar-galeria', class: 'lidar-galeria', 'aria-live': 'polite' })
    ]);
}

/* --- Sección 5: almacenamiento ------------------------------------------- */

function seccionAlmacenamiento() {
    return el('section', { class: 'lidar-seccion', 'aria-label': 'Almacenamiento' }, [
        el('div', { class: 'section-title', text: 'Almacenamiento' }),
        el('div', { class: 'card lidar-card-espacio' }, [
            el('div', { class: 'row-between' }, [
                el('span', { class: 'card-title' }, [icono('disco', 13, 2.2), 'Espacio usado']),
                el('span', { id: 'lidar-espacio-texto', class: 'lidar-espacio-valor', text: 'Calculando…' })
            ]),
            el('div', { class: 'card-text', text: 'Espacio ocupado por las nubes de puntos en este dispositivo.' })
        ]),
        el('button', {
            type: 'button',
            id: 'btn-lidar-exportar-todo',
            class: 'btn-outline accent btn-block mt-8',
            onclick: () => exportarTodoLosEscaneos()
        }, [icono('paquete'), 'Exportar todo'])
    ]);
}

/* --------------------------------------------------------------------------
   5. Sección 1: estado del sensor
   -------------------------------------------------------------------------- */

async function pintarEstadoSensor() {
    const cont = document.getElementById('lidar-sensor');
    if (!cont) return;

    cont.textContent = '';
    cont.appendChild(el('div', { class: 'section-title', text: 'Estado del sensor' }));

    let caps = S.capacidades;
    if (!caps) {
        try {
            caps = await detectarCapacidades();
            S.capacidades = caps;
        } catch (err) {
            cont.appendChild(tarjetaSensor({
                tono: 'warn',
                icono: 'aviso',
                titulo: 'No se pudo comprobar el sensor',
                texto: textoError(err)
            }));
            return;
        }
    }
    caps = caps || {};

    if (caps.ios) {
        cont.appendChild(tarjetaSensor({
            tono: 'sky',
            icono: 'manzana',
            titulo: 'iPhone / iPad: usa la app JoseScan',
            texto: 'Safari no da acceso al sensor LiDAR desde la web, así que aquí no es posible escanear. ' +
                'Para capturar con LiDAR usa la app nativa JoseScan y luego trae el archivo .josescan a este panel con "Importar".',
            enlace: { texto: 'Ver instrucciones de escaneo', href: S.opciones.docsGuia || RUTA_GUIA }
        }));
        cont.appendChild(el('div', { class: 'lidar-nota', text: 'Ver, medir y exportar los escaneos importados sí funciona en este iPhone o iPad.' }));
        return;
    }

    if (!caps.seguro) {
        cont.appendChild(tarjetaSensor({
            tono: 'warn',
            icono: 'aviso',
            titulo: 'Se necesita conexión segura (HTTPS)',
            texto: caps.motivo || 'El navegador sólo permite usar la cámara y la realidad aumentada en páginas servidas por HTTPS.'
        }));
        return;
    }

    if (caps.soportado && caps.webxr) {
        const detalles = [];
        if (caps.profundidad) detalles.push('sensor de profundidad disponible');
        if (caps.camara) detalles.push('cámara autorizada');
        cont.appendChild(tarjetaSensor({
            tono: 'accent',
            icono: 'check',
            titulo: 'Dispositivo compatible',
            texto: 'Este equipo puede escanear en 3D desde el navegador' +
                (detalles.length ? ' (' + detalles.join(', ') + ').' : '.')
        }));

        const sec = document.getElementById('lidar-sec-escanear');
        if (sec) {
            sec.classList.remove('lidar-oculto');
            sec.textContent = '';
            sec.appendChild(el('div', { class: 'section-title', text: 'Escanear' }));
            sec.appendChild(el('button', {
                type: 'button',
                id: 'btn-lidar-escanear',
                class: 'btn-primary btn-block btn-lg lidar-boton-escanear',
                'aria-label': 'Escanear ahora en 3D',
                onclick: () => abrirCaptura()
            }, [icono('cubo', 22), 'Escanear ahora']));
            sec.appendChild(el('div', {
                class: 'lidar-nota',
                text: 'Mueve el equipo despacio alrededor del objeto. Mantén de 1 a 4 metros de distancia para una nube limpia.'
            }));
        }
        return;
    }

    cont.appendChild(tarjetaSensor({
        tono: 'warn',
        icono: 'aviso',
        titulo: caps.android ? 'Este Android no permite escanear' : 'Escaneo no disponible en este navegador',
        texto: caps.motivo || 'El navegador no ofrece WebXR con datos de profundidad.',
        pie: caps.recomendacion || 'Puedes importar escaneos hechos con la app JoseScan y verlos aquí.',
        enlace: { texto: 'Ver instrucciones de escaneo', href: S.opciones.docsGuia || RUTA_GUIA }
    }));
}

function tarjetaSensor({ tono, icono: nombreIcono, titulo, texto, pie, enlace }) {
    const claseCard = tono === 'accent' ? 'card card-accent' : tono === 'sky' ? 'card card-sky' : 'card';
    const hijos = [
        el('div', { class: 'lidar-sensor-fila' }, [
            el('span', { class: 'lidar-sensor-icono lidar-tono-' + (tono || 'neutro') }, [icono(nombreIcono || 'cubo', 20)]),
            el('div', { class: 'lidar-sensor-texto' }, [
                el('div', { class: 'card-heading lidar-sensor-titulo', text: titulo }),
                el('div', { class: 'card-text', text: texto })
            ])
        ])
    ];
    if (pie) hijos.push(el('div', { class: 'card-text lidar-nota', text: pie }));
    if (enlace) {
        hijos.push(el('a', {
            class: 'lidar-enlace',
            href: enlace.href,
            target: '_blank',
            rel: 'noopener',
            'aria-label': enlace.texto
        }, [icono('ojo', 16), enlace.texto]));
    }
    return el('div', { class: claseCard + ' lidar-card-sensor lidar-tono-borde-' + (tono || 'neutro') }, hijos);
}

/* --------------------------------------------------------------------------
   6. Sección 3: importación de archivos
   -------------------------------------------------------------------------- */

function progresoImportar(visible, porcentaje, texto) {
    const cont = document.getElementById('lidar-progreso-importar');
    if (!cont) return;
    cont.classList.toggle('lidar-oculto', !visible);
    const relleno = cont.querySelector('.lidar-progreso-relleno');
    const etiqueta = cont.querySelector('.lidar-progreso-texto');
    if (relleno) relleno.style.width = Math.max(0, Math.min(100, porcentaje || 0)) + '%';
    if (etiqueta && texto) etiqueta.textContent = texto;
}

async function importarArchivos(archivos) {
    const resumen = document.getElementById('lidar-resumen-importar');
    if (resumen) {
        resumen.classList.add('lidar-oculto');
        resumen.textContent = '';
    }

    const total = archivos.length;
    const correctos = [];
    const fallidos = [];

    progresoImportar(true, 0, 'Importando 0 de ' + total + '…');
    await frame();

    for (let i = 0; i < total; i++) {
        const archivo = archivos[i];
        progresoImportar(true, Math.round((i / total) * 100), 'Importando ' + (i + 1) + ' de ' + total + ': ' + archivo.name);
        await frame();
        try {
            const resultado = await importarArchivo(archivo);
            const meta = metaDe(resultado) || {};
            const id = idDe(meta);
            const proyecto = proyectoActual();
            if (id && proyecto && !meta.proyecto) {
                try { await actualizarMeta(id, { proyecto }); } catch (_e) { /* etiqueta opcional */ }
            }
            correctos.push(meta.nombre || archivo.name);
        } catch (err) {
            fallidos.push({ nombre: archivo.name, motivo: textoError(err) });
        }
        await frame();
    }

    progresoImportar(true, 100, 'Importación terminada');
    setTimeout(() => progresoImportar(false, 0, ''), 900);

    if (resumen) {
        resumen.textContent = '';
        resumen.classList.remove('lidar-oculto');
        resumen.appendChild(el('div', {
            class: 'lidar-resumen-linea lidar-resumen-ok',
            text: correctos.length + ' de ' + total + (total === 1 ? ' archivo importado' : ' archivos importados')
        }));
        for (const f of fallidos) {
            resumen.appendChild(el('div', {
                class: 'lidar-resumen-linea lidar-resumen-error',
                text: f.nombre + ': ' + f.motivo
            }));
        }
    }

    if (correctos.length) aviso(correctos.length === 1 ? 'Escaneo importado.' : correctos.length + ' escaneos importados.', 'exito');
    if (fallidos.length) aviso('No se pudieron importar ' + fallidos.length + ' archivo(s).', 'error');

    await refrescarGaleria();
    await refrescarEspacio();
}

/* --------------------------------------------------------------------------
   7. Sección 4: galería
   -------------------------------------------------------------------------- */

async function refrescarGaleria() {
    const cont = document.getElementById('lidar-galeria');
    if (!cont || S.cargandoGaleria) return;
    S.cargandoGaleria = true;

    cont.textContent = '';
    cont.appendChild(el('div', { class: 'lidar-cargando', text: 'Cargando escaneos…' }));

    let lista = [];
    try {
        const r = await listarEscaneos({ orden: 'creado', descendente: true });
        lista = listaDe(r);
    } catch (err) {
        cont.textContent = '';
        cont.appendChild(el('div', { class: 'empty-state', text: 'No se pudo leer la lista de escaneos: ' + textoError(err) }));
        S.cargandoGaleria = false;
        return;
    }

    S.escaneos = lista;
    revocarMiniaturas();
    cont.textContent = '';

    if (!lista.length) {
        cont.appendChild(el('div', { class: 'empty-state' }, [
            el('div', { class: 'empty-icon', text: '🧊' }),
            el('div', { text: 'Todavía no hay escaneos guardados.' }),
            el('div', { class: 'lidar-nota', text: 'Importa un archivo .josescan o captura uno nuevo si tu equipo lo permite.' })
        ]));
        S.cargandoGaleria = false;
        return;
    }

    const fragmento = document.createDocumentFragment();
    for (let i = 0; i < lista.length; i++) {
        fragmento.appendChild(tarjetaEscaneo(metaDe(lista[i]) || {}));
        if ((i + 1) % 8 === 0) {
            cont.appendChild(fragmento);
            await frame();
        }
    }
    cont.appendChild(fragmento);
    S.cargandoGaleria = false;
}

function tarjetaEscaneo(meta) {
    const id = idDe(meta);
    const nombre = meta.nombre || 'Escaneo sin nombre';
    const miniatura = urlMiniatura(meta.miniatura || meta.thumbnail || meta.miniaturaBlob);

    const medios = el('div', { class: 'lidar-card-medios' }, [
        miniatura
            ? el('img', { src: miniatura, alt: 'Miniatura de ' + nombre, loading: 'lazy', decoding: 'async' })
            : el('div', { class: 'lidar-card-sinfoto', 'aria-hidden': 'true' }, [icono('cubo', 26, 1.6)])
    ]);

    const datos = [];
    if (Number(meta.puntos) > 0) datos.push(fmtEntero(meta.puntos) + ' puntos');
    if (Number(meta.triangulos) > 0) datos.push(fmtEntero(meta.triangulos) + ' triángulos');
    const dur = fmtDuracion(meta.duracionSegundos);
    if (dur) datos.push(dur);

    const chips = [];
    const geo = textoGeo(meta);
    chips.push(geo
        ? el('span', { class: 'badge badge-accent lidar-chip', title: 'Escaneo georreferenciado' }, [icono('globo', 12, 2.2), geo])
        : el('span', { class: 'badge lidar-chip', title: 'Escaneo sin coordenadas' }, [icono('aviso', 12, 2.2), 'Sin georreferenciar']));
    if (meta.proyecto) chips.push(el('span', { class: 'badge badge-sky lidar-chip', text: meta.proyecto }));

    const acciones = el('div', { class: 'lidar-card-acciones' }, [
        el('button', {
            type: 'button', class: 'btn-secondary btn-sm lidar-accion',
            'aria-label': 'Ver el escaneo ' + nombre,
            onclick: () => abrirVisor(id, meta)
        }, [icono('ojo', 16), 'Ver']),
        el('button', {
            type: 'button', class: 'btn-secondary btn-sm lidar-accion',
            'aria-label': 'Ver ' + nombre + ' en el mapa',
            onclick: () => verEnElMapa(meta)
        }, [icono('mapa', 16), 'En el mapa']),
        el('button', {
            type: 'button', class: 'btn-secondary btn-sm lidar-accion',
            'aria-label': 'Exportar el escaneo ' + nombre,
            onclick: () => abrirHojaExportar(id, meta)
        }, [icono('descargar', 16), 'Exportar']),
        el('button', {
            type: 'button', class: 'btn-secondary btn-sm lidar-accion',
            'aria-label': 'Renombrar el escaneo ' + nombre,
            onclick: () => pedirNuevoNombre(id, nombre)
        }, [icono('lapiz', 16), 'Renombrar']),
        el('button', {
            type: 'button', class: 'btn-outline danger btn-sm lidar-accion',
            'aria-label': 'Eliminar el escaneo ' + nombre,
            onclick: () => confirmarEliminar(id, nombre)
        }, [icono('papelera', 16), 'Eliminar'])
    ]);

    return el('article', { class: 'lidar-card', dataset: { id } }, [
        el('div', { class: 'lidar-card-cabecera' }, [
            medios,
            el('div', { class: 'lidar-card-info' }, [
                el('h3', { class: 'lidar-card-nombre', text: nombre }),
                el('div', { class: 'lidar-card-fecha', text: fmtFecha(meta.creado || meta.fecha) }),
                datos.length ? el('div', { class: 'lidar-card-datos', text: datos.join(' · ') }) : null,
                el('div', { class: 'lidar-card-chips' }, chips)
            ])
        ]),
        acciones
    ]);
}

/* --------------------------------------------------------------------------
   8. Almacenamiento
   -------------------------------------------------------------------------- */

async function refrescarEspacio() {
    const nodo = document.getElementById('lidar-espacio-texto');
    if (!nodo) return;
    try {
        const r = await espacioUsado();
        const bytes = bytesDe(r);
        const cuota = cuotaDe(r);
        nodo.textContent = cuota > 0
            ? fmtBytes(bytes) + ' de ' + fmtBytes(cuota)
            : fmtBytes(bytes);
    } catch (err) {
        nodo.textContent = 'No disponible';
        console.warn('[JoseScan] No se pudo calcular el espacio usado:', err);
    }
}

async function exportarTodoLosEscaneos() {
    const btn = document.getElementById('btn-lidar-exportar-todo');
    if (btn) { btn.disabled = true; btn.classList.add('lidar-ocupado'); }
    try {
        const r = await exportarTodo();
        const blob = aBlob(r && r.blob ? r.blob : r, 'application/zip');
        if (!blob || blob.size === 0) throw new Error('No hay escaneos para exportar.');
        const nombre = (r && r.nombre) ? r.nombre : nombreArchivo('josescan_todos_' + new Date().toISOString().slice(0, 10), 'zip');
        await descargar(blob, nombre);
        aviso('Copia de seguridad generada.', 'exito');
    } catch (err) {
        aviso('No se pudo exportar todo: ' + textoError(err), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('lidar-ocupado'); }
    }
}

/* --------------------------------------------------------------------------
   9. Ver en el mapa
   -------------------------------------------------------------------------- */

async function verEnElMapa(meta) {
    let geojson = null;
    try {
        geojson = scanAGeoJSON(meta, { incluirHuella: true });
    } catch (err) {
        aviso('No se pudo generar la huella: ' + textoError(err), 'error');
        return;
    }
    if (!geojson) {
        aviso('Este escaneo no tiene coordenadas para ubicarlo en el mapa.', 'warn');
        return;
    }

    const b = puente();
    if (b && typeof b.agregarHuellaEscaneo === 'function') {
        try {
            await b.agregarHuellaEscaneo(geojson, meta);
            cerrarPanelLidar();
            aviso('Huella del escaneo añadida al mapa.', 'exito');
            return;
        } catch (err) {
            aviso('El mapa no pudo dibujar la huella: ' + textoError(err), 'error');
            return;
        }
    }

    try {
        const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
        await descargar(blob, nombreArchivo(meta.nombre || 'escaneo', 'geojson'));
        aviso('Mapa no disponible: se descargó la huella en GeoJSON.', 'info');
    } catch (err) {
        aviso('No se pudo descargar la huella: ' + textoError(err), 'error');
    }
}

/* --------------------------------------------------------------------------
   10. Modales genéricos: nombre y confirmación
   -------------------------------------------------------------------------- */

function crearModal(id, titulo, cuerpo, pie) {
    let modal = document.getElementById(id);
    if (modal) modal.remove();

    const contenido = el('div', { class: 'modal-content lidar-modal-content' }, [
        el('header', { class: 'modal-header' }, [
            el('h2', { id: id + '-titulo', text: titulo }),
            el('button', {
                type: 'button', class: 'btn-close-modal', 'aria-label': 'Cerrar',
                onclick: () => cerrarModal(id)
            }, [icono('cerrar', 18, 2)])
        ]),
        el('div', { class: 'modal-body' }, cuerpo),
        pie ? el('footer', { class: 'modal-footer' }, pie) : null
    ]);

    modal = el('div', {
        id,
        class: 'modal hidden lidar-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': id + '-titulo'
    }, [contenido]);

    modal.addEventListener('click', (e) => { if (e.target === modal) cerrarModal(id); });
    document.body.appendChild(modal);
    return modal;
}

function mostrarModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    requestAnimationFrame(() => modal.classList.remove('hidden'));
    abrirCapa(modal, () => cerrarModal(id));
}

function cerrarModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    cerrarCapa(modal);
    modal.classList.add('hidden');
    setTimeout(() => { if (modal.parentNode) modal.remove(); }, 320);
}

function pedirNuevoNombre(id, nombreActual) {
    const idModal = 'lidar-modal-nombre';
    const campo = el('input', {
        type: 'text',
        class: 'form-control',
        id: 'lidar-campo-nombre',
        value: nombreActual,
        maxlength: '80',
        'aria-label': 'Nuevo nombre del escaneo',
        autocomplete: 'off'
    });

    async function guardar() {
        const nuevo = campo.value.trim();
        if (!nuevo) {
            aviso('Escribe un nombre para el escaneo.', 'warn');
            campo.focus();
            return;
        }
        cerrarModal(idModal);
        try {
            await actualizarMeta(id, { nombre: nuevo });
            aviso('Escaneo renombrado.', 'exito');
            await refrescarGaleria();
        } catch (err) {
            aviso('No se pudo renombrar: ' + textoError(err), 'error');
        }
    }

    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); guardar(); } });

    crearModal(idModal, 'Renombrar escaneo', [
        el('div', { class: 'field' }, [
            el('label', { for: 'lidar-campo-nombre', text: 'Nombre' }),
            campo
        ])
    ], [
        el('button', { type: 'button', class: 'btn-secondary', onclick: () => cerrarModal(idModal), text: 'Cancelar' }),
        el('button', { type: 'button', class: 'btn-primary', onclick: guardar, text: 'Guardar' })
    ]);
    mostrarModal(idModal);
    requestAnimationFrame(() => { campo.focus(); campo.select(); });
}

function confirmarEliminar(id, nombre) {
    const idModal = 'lidar-modal-confirmar';

    async function eliminar() {
        cerrarModal(idModal);
        try {
            await eliminarEscaneo(id);
            aviso('Escaneo eliminado.', 'exito');
            await refrescarGaleria();
            await refrescarEspacio();
        } catch (err) {
            aviso('No se pudo eliminar: ' + textoError(err), 'error');
        }
    }

    crearModal(idModal, 'Eliminar escaneo', [
        el('p', { class: 'lidar-texto-confirmar', text: '¿Seguro que quieres eliminar «' + nombre + '»?' }),
        el('p', { class: 'card-text', text: 'Se borrarán la nube de puntos, la malla y las mediciones. Esta acción no se puede deshacer.' })
    ], [
        el('button', { type: 'button', class: 'btn-secondary', onclick: () => cerrarModal(idModal), text: 'Cancelar' }),
        el('button', { type: 'button', class: 'btn-danger', onclick: eliminar }, [icono('papelera', 16), 'Eliminar'])
    ]);
    mostrarModal(idModal);
}

/* --------------------------------------------------------------------------
   11. Hoja de exportación
   -------------------------------------------------------------------------- */

const FORMATOS = [
    { clave: 'ply', etiqueta: 'PLY · nube de puntos', ext: 'ply', mime: 'application/octet-stream' },
    { clave: 'obj', etiqueta: 'OBJ · malla triangular', ext: 'obj', mime: 'text/plain' },
    { clave: 'xyz', etiqueta: 'XYZ · texto plano', ext: 'xyz', mime: 'text/plain' },
    { clave: 'csv', etiqueta: 'CSV · tabla de puntos', ext: 'csv', mime: 'text/csv' },
    { clave: 'geojson', etiqueta: 'GeoJSON · huella para el mapa', ext: 'geojson', mime: 'application/geo+json' },
    { clave: 'josescan', etiqueta: 'Paquete .josescan · todo junto', ext: 'josescan', mime: 'application/zip' }
];

function abrirHojaExportar(id, meta) {
    const idModal = 'lidar-modal-exportar';
    const casillas = FORMATOS.map((f) => {
        const input = el('input', { type: 'checkbox', id: 'lidar-fmt-' + f.clave, value: f.clave });
        if (f.clave === 'josescan') input.checked = true;
        return el('label', { class: 'checkbox-row lidar-casilla', for: 'lidar-fmt-' + f.clave }, [
            input,
            el('span', { text: f.etiqueta })
        ]);
    });

    const estado = el('div', { class: 'lidar-resumen lidar-oculto', id: 'lidar-exportar-estado', role: 'status', 'aria-live': 'polite' });

    const botonExportar = el('button', { type: 'button', class: 'btn-primary' }, [icono('descargar', 16), 'Exportar']);
    botonExportar.addEventListener('click', async () => {
        const elegidos = FORMATOS.filter((f) => {
            const c = document.getElementById('lidar-fmt-' + f.clave);
            return c && c.checked;
        });
        if (!elegidos.length) {
            aviso('Elige al menos un formato.', 'warn');
            return;
        }
        botonExportar.disabled = true;
        estado.classList.remove('lidar-oculto');
        estado.textContent = '';
        estado.appendChild(el('div', { class: 'lidar-resumen-linea', text: 'Preparando los archivos…' }));
        await frame();
        try {
            await exportarEscaneo(id, meta, elegidos, estado);
        } finally {
            botonExportar.disabled = false;
        }
    });

    crearModal(idModal, 'Exportar escaneo', [
        el('p', { class: 'card-text lidar-mb8', text: 'Escaneo: ' + (meta.nombre || 'sin nombre') }),
        el('div', { class: 'lidar-casillas' }, casillas),
        estado
    ], [
        el('button', { type: 'button', class: 'btn-secondary', onclick: () => cerrarModal(idModal), text: 'Cerrar' }),
        botonExportar
    ]);
    mostrarModal(idModal);
}

async function exportarEscaneo(id, metaBase, formatos, estado) {
    function linea(texto, clase) {
        if (!estado) return;
        estado.appendChild(el('div', { class: 'lidar-resumen-linea ' + (clase || ''), text: texto }));
    }

    let registro = null;
    try {
        registro = await obtenerEscaneo(id);
    } catch (err) {
        linea('No se pudo leer el escaneo: ' + textoError(err), 'lidar-resumen-error');
        aviso('No se pudo leer el escaneo.', 'error');
        return;
    }

    const meta = metaDe(registro) || metaBase || {};
    const nube = nubeDe(registro);
    const malla = mallaDe(registro);
    const base = meta.nombre || 'escaneo';
    let ok = 0;

    for (const f of formatos) {
        await frame();
        try {
            let blob = null;
            if (f.clave === 'ply') {
                if (!nube) throw new Error('este escaneo no tiene nube de puntos');
                blob = aBlob(writePLY(nube, { binario: true, marco: meta.marco }), f.mime);
            } else if (f.clave === 'obj') {
                if (!malla) throw new Error('este escaneo no tiene malla');
                blob = aBlob(writeOBJ(malla), f.mime);
            } else if (f.clave === 'xyz') {
                if (!nube) throw new Error('este escaneo no tiene nube de puntos');
                blob = aBlob(writeXYZ(nube), f.mime);
            } else if (f.clave === 'csv') {
                if (!nube) throw new Error('este escaneo no tiene nube de puntos');
                blob = aBlob(writeCSV(nube, { separador: ';', decimales: 3 }), f.mime);
            } else if (f.clave === 'geojson') {
                const gj = scanAGeoJSON(meta, { incluirHuella: true });
                if (!gj) throw new Error('el escaneo no está georreferenciado');
                blob = new Blob([JSON.stringify(gj, null, 2)], { type: f.mime });
            } else if (f.clave === 'josescan') {
                blob = aBlob(await buildScanBundle({ meta, nube, malla, miniatura: meta.miniatura }), f.mime);
            }
            if (!blob) throw new Error('no se generó contenido');
            await descargar(blob, nombreArchivo(base, f.ext));
            ok++;
            linea('Listo: ' + f.etiqueta, 'lidar-resumen-ok');
        } catch (err) {
            linea('No se pudo exportar ' + f.clave.toUpperCase() + ': ' + textoError(err), 'lidar-resumen-error');
        }
    }

    if (ok > 0) aviso(ok === 1 ? 'Archivo exportado.' : ok + ' archivos exportados.', 'exito');
    else aviso('No se pudo exportar ningún formato.', 'error');
}

/* --------------------------------------------------------------------------
   12. Capa de captura (escáner)
   -------------------------------------------------------------------------- */

function crearCapaCaptura() {
    const lienzo = el('div', { id: 'lidar-captura-lienzo', class: 'lidar-lienzo' });

    const hud = el('div', { id: 'lidar-hud', class: 'lidar-hud', role: 'status', 'aria-live': 'polite' }, [
        el('div', { class: 'lidar-hud-datos' }, [
            el('div', { class: 'lidar-hud-item' }, [
                el('span', { class: 'lidar-hud-etiqueta', text: 'Puntos' }),
                el('span', { id: 'lidar-hud-puntos', class: 'lidar-hud-valor', text: '0' })
            ]),
            el('div', { class: 'lidar-hud-item' }, [
                el('span', { class: 'lidar-hud-etiqueta', text: 'FPS' }),
                el('span', { id: 'lidar-hud-fps', class: 'lidar-hud-valor', text: '--' })
            ])
        ]),
        el('div', { id: 'lidar-hud-estado', class: 'lidar-hud-estado', text: 'Preparando el sensor…' })
    ]);

    const btnPausar = el('button', {
        type: 'button', id: 'btn-lidar-pausar', class: 'btn-secondary lidar-btn-captura',
        'aria-label': 'Pausar el escaneo',
        onclick: () => alternarPausa()
    }, [icono('pausa', 18), el('span', { text: 'Pausar' })]);

    const btnReiniciar = el('button', {
        type: 'button', id: 'btn-lidar-reiniciar', class: 'btn-secondary lidar-btn-captura',
        'aria-label': 'Reiniciar el escaneo',
        onclick: () => reiniciarCaptura()
    }, [icono('reiniciar', 18), el('span', { text: 'Reiniciar' })]);

    const btnFinalizar = el('button', {
        type: 'button', id: 'btn-lidar-finalizar', class: 'btn-primary lidar-btn-captura lidar-btn-finalizar',
        'aria-label': 'Finalizar y guardar el escaneo',
        onclick: () => finalizarCaptura()
    }, [icono('detener', 18), el('span', { text: 'Finalizar' })]);

    const btnCancelar = el('button', {
        type: 'button', id: 'btn-lidar-cancelar-captura', class: 'lidar-btn-cerrar',
        'aria-label': 'Cancelar el escaneo y cerrar',
        onclick: () => cerrarCaptura(true)
    }, [icono('cerrar', 20, 2.2)]);

    const capa = el('div', {
        id: 'lidar-captura',
        class: 'lidar-capa lidar-oculto',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Captura de escaneo 3D'
    }, [
        lienzo,
        el('div', { class: 'lidar-capa-superior' }, [
            el('div', { class: 'lidar-capa-titulo', text: 'Escaneando en 3D' }),
            btnCancelar
        ]),
        hud,
        el('div', { class: 'lidar-barra-inferior' }, [btnPausar, btnReiniciar, btnFinalizar])
    ]);

    document.body.appendChild(capa);
    S.captura = capa;
    return capa;
}

function estadoCaptura(texto) {
    const n = document.getElementById('lidar-hud-estado');
    if (n) n.textContent = texto;
}

function contadorCaptura(valor) {
    const n = document.getElementById('lidar-hud-puntos');
    if (n) n.textContent = fmtEntero(valor);
}

function medirFps() {
    let ultimo = performance.now();
    let cuadros = 0;
    const nodo = () => document.getElementById('lidar-hud-fps');
    function paso(t) {
        if (!S.scannerActivo) return;
        cuadros++;
        if (t - ultimo >= 1000) {
            const n = nodo();
            if (n) n.textContent = String(Math.round((cuadros * 1000) / (t - ultimo)));
            cuadros = 0;
            ultimo = t;
        }
        S.rafFps = requestAnimationFrame(paso);
    }
    S.rafFps = requestAnimationFrame(paso);
}

async function abrirCaptura() {
    if (S.scannerActivo) return;

    const capa = S.captura || crearCapaCaptura();
    capa.classList.remove('lidar-oculto');
    abrirCapa(capa, () => cerrarCaptura(true));
    estadoCaptura('Preparando el sensor…');
    contadorCaptura(0);
    S.scannerPausado = false;
    actualizarBotonPausa();

    const lienzo = document.getElementById('lidar-captura-lienzo');
    try {
        S.scanner = new LidarScanner({
            resolucion: 'media',
            color: true,
            confianza: true
        });

        S.scanner.on('estado', (e) => {
            const texto = typeof e === 'string' ? e : (e && (e.mensaje || e.estado)) || '';
            if (texto) estadoCaptura(texto);
        });
        S.scanner.on('puntos', (e) => {
            const n = typeof e === 'number' ? e : (e && (e.conteo ?? e.total ?? e.puntos));
            contadorCaptura(Number.isFinite(Number(n)) ? Number(n) : (S.scanner ? S.scanner.conteo : 0));
        });
        S.scanner.on('error', (e) => {
            aviso('Error del escáner: ' + textoError(e), 'error');
            cerrarCaptura(true);
        });
        S.scanner.on('fin', () => {
            if (S.scannerActivo) finalizarCaptura();
        });

        await S.scanner.iniciar(lienzo);
        S.scannerActivo = true;
        estadoCaptura('Mueve el equipo despacio alrededor del objeto.');
        medirFps();
    } catch (err) {
        aviso('No se pudo iniciar el escaneo: ' + textoError(err), 'error');
        await cerrarCaptura(true);
    }
}

function actualizarBotonPausa() {
    const btn = document.getElementById('btn-lidar-pausar');
    if (!btn) return;
    const etiqueta = btn.querySelector('span');
    const svgViejo = btn.querySelector('svg');
    const nuevo = icono(S.scannerPausado ? 'reproducir' : 'pausa', 18);
    if (svgViejo) btn.replaceChild(nuevo, svgViejo);
    if (etiqueta) etiqueta.textContent = S.scannerPausado ? 'Reanudar' : 'Pausar';
    btn.setAttribute('aria-label', S.scannerPausado ? 'Reanudar el escaneo' : 'Pausar el escaneo');
}

function alternarPausa() {
    if (!S.scanner) return;
    try {
        if (S.scannerPausado) {
            S.scanner.reanudar();
            S.scannerPausado = false;
            estadoCaptura('Escaneo reanudado.');
        } else {
            S.scanner.pausar();
            S.scannerPausado = true;
            estadoCaptura('Escaneo en pausa.');
        }
        actualizarBotonPausa();
    } catch (err) {
        aviso('No se pudo cambiar la pausa: ' + textoError(err), 'error');
    }
}

function reiniciarCaptura() {
    if (!S.scanner) return;
    try {
        S.scanner.reiniciar();
        S.scannerPausado = false;
        actualizarBotonPausa();
        contadorCaptura(0);
        estadoCaptura('Escaneo reiniciado. Vuelve a recorrer la zona.');
        aviso('Escaneo reiniciado.', 'info');
    } catch (err) {
        aviso('No se pudo reiniciar: ' + textoError(err), 'error');
    }
}

async function finalizarCaptura() {
    if (!S.scanner) {
        await cerrarCaptura(false);
        return;
    }
    const btn = document.getElementById('btn-lidar-finalizar');
    if (btn) btn.disabled = true;
    estadoCaptura('Guardando el escaneo…');

    let nube = null;
    let meta = null;
    try {
        await S.scanner.detener();
        S.scannerActivo = false;
        nube = S.scanner.obtenerNube();
        meta = S.scanner.obtenerMetadatos() || {};
    } catch (err) {
        aviso('No se pudo cerrar el sensor: ' + textoError(err), 'error');
    }

    try {
        if (!nube) throw new Error('el escaneo quedó vacío');
        const proyecto = proyectoActual();
        const nombre = meta.nombre || ('Escaneo ' + fmtFecha(new Date()));
        await guardarEscaneo({
            meta: Object.assign({}, meta, { nombre, proyecto: meta.proyecto || proyecto || undefined }),
            nube,
            nombre,
            proyecto: proyecto || undefined
        });
        aviso('Escaneo guardado.', 'exito');
    } catch (err) {
        aviso('No se pudo guardar el escaneo: ' + textoError(err), 'error');
    } finally {
        if (btn) btn.disabled = false;
        await cerrarCaptura(false);
        await refrescarGaleria();
        await refrescarEspacio();
    }
}

async function cerrarCaptura(detener) {
    if (S.rafFps) { cancelAnimationFrame(S.rafFps); S.rafFps = 0; }
    S.scannerActivo = false;

    if (detener && S.scanner) {
        try { await S.scanner.detener(); } catch (_e) { /* ya detenido */ }
    }
    S.scanner = null;
    S.scannerPausado = false;

    const capa = document.getElementById('lidar-captura');
    if (capa) {
        cerrarCapa(capa);
        capa.classList.add('lidar-oculto');
        const lienzo = document.getElementById('lidar-captura-lienzo');
        if (lienzo) lienzo.textContent = '';
    }
}

/* --------------------------------------------------------------------------
   13. Visor 3D
   -------------------------------------------------------------------------- */

const MODOS = [
    { clave: 'puntos', etiqueta: 'Puntos' },
    { clave: 'malla', etiqueta: 'Malla' },
    { clave: 'ambos', etiqueta: 'Ambos' }
];
const COLOREADOS = [
    { clave: 'rgb', etiqueta: 'RGB' },
    { clave: 'altura', etiqueta: 'Altura' },
    { clave: 'confianza', etiqueta: 'Confianza' }
];
const VISTAS = [
    { clave: 'planta', etiqueta: 'Planta' },
    { clave: 'frente', etiqueta: 'Frente' },
    { clave: 'lado', etiqueta: 'Lado' },
    { clave: 'iso', etiqueta: 'Iso' }
];

function grupoSegmentado(id, etiquetaGrupo, opciones, activo, alElegir) {
    const grupo = el('div', { id, class: 'lidar-seg', role: 'group', 'aria-label': etiquetaGrupo });
    for (const op of opciones) {
        const b = el('button', {
            type: 'button',
            class: 'lidar-seg-btn' + (op.clave === activo ? ' lidar-seg-activo' : ''),
            'aria-pressed': op.clave === activo ? 'true' : 'false',
            'aria-label': etiquetaGrupo + ': ' + op.etiqueta,
            dataset: { valor: op.clave },
            text: op.etiqueta
        });
        b.addEventListener('click', () => {
            for (const otro of grupo.querySelectorAll('.lidar-seg-btn')) {
                const act = otro === b;
                otro.classList.toggle('lidar-seg-activo', act);
                otro.setAttribute('aria-pressed', act ? 'true' : 'false');
            }
            alElegir(op.clave);
        });
        grupo.appendChild(b);
    }
    return grupo;
}

function crearCapaVisor() {
    const lienzo = el('div', { id: 'lidar-visor-lienzo', class: 'lidar-lienzo' });

    const cerrar = el('button', {
        type: 'button', id: 'btn-lidar-visor-cerrar', class: 'lidar-btn-cerrar',
        'aria-label': 'Cerrar el visor 3D',
        onclick: () => cerrarVisor()
    }, [icono('cerrar', 20, 2.2)]);

    const superior = el('div', { class: 'lidar-capa-superior' }, [
        el('div', { class: 'lidar-capa-titulo' }, [
            el('span', { id: 'lidar-visor-titulo', text: 'Escaneo' }),
            el('span', { id: 'lidar-visor-sub', class: 'lidar-capa-sub', text: '' })
        ]),
        cerrar
    ]);

    const barra = el('div', { id: 'lidar-visor-barra', class: 'lidar-visor-barra' }, [
        el('div', { class: 'lidar-fila-control' }, [
            el('span', { class: 'lidar-etiqueta-control', text: 'Modo' }),
            grupoSegmentado('lidar-visor-modo', 'Modo de visualización', MODOS, 'puntos', (v) => {
                try { if (S.viewer) S.viewer.setModo(v); } catch (err) { aviso('No se pudo cambiar el modo: ' + textoError(err), 'error'); }
            })
        ]),
        el('div', { class: 'lidar-fila-control' }, [
            el('span', { class: 'lidar-etiqueta-control', text: 'Color' }),
            grupoSegmentado('lidar-visor-color', 'Coloreado', COLOREADOS, 'rgb', (v) => {
                try { if (S.viewer) S.viewer.setColoreado(v); } catch (err) { aviso('No se pudo cambiar el coloreado: ' + textoError(err), 'error'); }
            })
        ]),
        el('div', { class: 'lidar-fila-control' }, [
            el('span', { class: 'lidar-etiqueta-control', text: 'Vista' }),
            grupoSegmentado('lidar-visor-vistas', 'Vista de cámara', VISTAS, 'iso', (v) => {
                try { if (S.viewer) S.viewer.vista(v); } catch (err) { aviso('No se pudo cambiar la vista: ' + textoError(err), 'error'); }
            })
        ]),
        el('div', { class: 'lidar-fila-control' }, [
            el('label', { class: 'lidar-etiqueta-control', for: 'lidar-visor-tamano', text: 'Tamaño' }),
            el('input', {
                type: 'range', id: 'lidar-visor-tamano', class: 'lidar-rango',
                min: '1', max: '8', step: '1', value: '2',
                'aria-label': 'Tamaño de los puntos en píxeles',
                oninput: (e) => {
                    try { if (S.viewer) S.viewer.setTamanoPunto(Number(e.target.value)); } catch (_err) { /* sin efecto */ }
                }
            })
        ]),
        el('div', { class: 'lidar-acciones-visor' }, [
            el('button', {
                type: 'button', id: 'btn-lidar-medir', class: 'btn-secondary lidar-btn-visor',
                'aria-pressed': 'false', 'aria-label': 'Activar o desactivar la medición',
                onclick: () => alternarMedicion()
            }, [icono('regla', 18), el('span', { text: 'Medir' })]),
            el('button', {
                type: 'button', id: 'btn-lidar-encuadrar', class: 'btn-secondary lidar-btn-visor',
                'aria-label': 'Encuadrar el escaneo en pantalla',
                onclick: () => { try { if (S.viewer) S.viewer.encuadrar(); } catch (_e) { /* sin efecto */ } }
            }, [icono('cubo', 18), el('span', { text: 'Encuadrar' })]),
            el('button', {
                type: 'button', id: 'btn-lidar-captura-png', class: 'btn-secondary lidar-btn-visor',
                'aria-label': 'Guardar una captura de pantalla en PNG',
                onclick: () => capturarPantalla()
            }, [icono('camara', 18), el('span', { text: 'Captura' })])
        ]),
        el('div', { id: 'lidar-mediciones', class: 'lidar-mediciones lidar-oculto', 'aria-live': 'polite' })
    ]);

    const capa = el('div', {
        id: 'lidar-visor',
        class: 'lidar-capa lidar-oculto',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Visor de escaneo 3D'
    }, [lienzo, superior, barra]);

    document.body.appendChild(capa);
    S.visor = capa;
    return capa;
}

async function abrirVisor(id, metaBase) {
    if (S.viewer) return;

    const capa = S.visor || crearCapaVisor();
    capa.classList.remove('lidar-oculto');
    abrirCapa(capa, () => cerrarVisor());

    const titulo = document.getElementById('lidar-visor-titulo');
    if (titulo) titulo.textContent = (metaBase && metaBase.nombre) || 'Escaneo';
    const sub = document.getElementById('lidar-visor-sub');
    if (sub) sub.textContent = 'Cargando…';

    let registro = null;
    try {
        registro = await obtenerEscaneo(id);
    } catch (err) {
        aviso('No se pudo abrir el escaneo: ' + textoError(err), 'error');
        await cerrarVisor();
        return;
    }

    const meta = metaDe(registro) || metaBase || {};
    const nube = nubeDe(registro);
    const malla = mallaDe(registro);
    S.visorRegistro = { id, meta };

    if (sub) {
        const partes = [];
        const dim = textoDimensiones(meta, nube);
        if (dim) partes.push(dim);
        const magna = textoMagna(meta);
        if (magna) partes.push(magna);
        sub.textContent = partes.join(' · ');
    }

    try {
        const modulo = await import('./lidar-viewer.js');
        const contenedor = document.getElementById('lidar-visor-lienzo');
        contenedor.textContent = '';
        S.viewer = new modulo.ScanViewer(contenedor, {
            fondo: 'oscuro',
            tamanoPunto: 2,
            ejes: true
        });

        if (nube) await S.viewer.cargarNube(nube);
        if (malla) await S.viewer.cargarMalla(malla);
        if (!nube && !malla) throw new Error('el escaneo no tiene geometría para mostrar');

        try { S.viewer.setModo(malla && !nube ? 'malla' : 'puntos'); } catch (_e) { /* modo por defecto */ }
        try { S.viewer.encuadrar(); } catch (_e) { /* encuadre por defecto */ }

        for (const ev of ['medicion', 'mediciones', 'cambio']) {
            try { S.viewer.on(ev, () => pintarMediciones()); } catch (_e) { /* evento no soportado */ }
        }
        try { S.viewer.on('error', (e) => aviso('Visor: ' + textoError(e), 'error')); } catch (_e) { /* sin evento error */ }

        window.addEventListener('resize', alRedimensionarVisor);
        window.addEventListener('orientationchange', alRedimensionarVisor);
        await frame();
        alRedimensionarVisor();
    } catch (err) {
        aviso('No se pudo mostrar el escaneo: ' + textoError(err), 'error');
        await cerrarVisor();
    }
}

function alRedimensionarVisor() {
    try { if (S.viewer) S.viewer.redimensionar(); } catch (_e) { /* sin efecto */ }
}

function alternarMedicion() {
    const btn = document.getElementById('btn-lidar-medir');
    if (!btn || !S.viewer) return;
    const activo = btn.getAttribute('aria-pressed') !== 'true';
    try {
        S.viewer.habilitarMedicion(activo);
    } catch (err) {
        aviso('No se pudo activar la medición: ' + textoError(err), 'error');
        return;
    }
    btn.setAttribute('aria-pressed', activo ? 'true' : 'false');
    btn.classList.toggle('lidar-btn-activo', activo);
    const lista = document.getElementById('lidar-mediciones');
    if (lista) lista.classList.toggle('lidar-oculto', !activo);

    if (activo) {
        aviso('Toca dos puntos del modelo para medir.', 'info');
        pintarMediciones();
        if (!S.temporizadorMediciones) {
            S.temporizadorMediciones = setInterval(pintarMediciones, 800);
        }
    } else {
        detenerSeguimientoMediciones();
    }
}

function detenerSeguimientoMediciones() {
    if (S.temporizadorMediciones) {
        clearInterval(S.temporizadorMediciones);
        S.temporizadorMediciones = 0;
    }
}

function pintarMediciones() {
    const cont = document.getElementById('lidar-mediciones');
    if (!cont || !S.viewer) return;

    let lista = [];
    try {
        lista = S.viewer.mediciones || [];
    } catch (_e) { lista = []; }

    cont.textContent = '';
    const cabecera = el('div', { class: 'row-between lidar-mediciones-cabecera' }, [
        el('span', { class: 'lidar-etiqueta-control', text: 'Mediciones (' + lista.length + ')' }),
        el('button', {
            type: 'button', class: 'btn-ghost danger btn-xs',
            'aria-label': 'Borrar todas las mediciones',
            onclick: () => {
                try {
                    S.viewer.limpiarMediciones();
                    pintarMediciones();
                } catch (err) { aviso('No se pudieron borrar: ' + textoError(err), 'error'); }
            },
            text: 'Limpiar'
        })
    ]);
    cont.appendChild(cabecera);

    if (!lista.length) {
        cont.appendChild(el('div', { class: 'lidar-nota', text: 'Todavía no hay mediciones. Toca dos puntos del modelo.' }));
        return;
    }

    const ul = el('ul', { class: 'lidar-lista-mediciones' });
    for (const m of lista) {
        const valor = Number(m && (m.value ?? m.valor));
        const unidad = (m && (m.unit || m.unidad)) || 'm';
        const tipo = (m && (m.kind || m.tipo)) || 'distancia';
        const etiqueta = (m && (m.label || m.etiqueta)) || tipo.charAt(0).toUpperCase() + tipo.slice(1);
        ul.appendChild(el('li', { class: 'lidar-medicion' }, [
            el('span', { class: 'lidar-medicion-nombre', text: etiqueta }),
            el('span', { class: 'lidar-medicion-valor', text: (Number.isFinite(valor) ? NF2.format(valor) : '--') + ' ' + unidad })
        ]));
    }
    cont.appendChild(ul);
}

async function capturarPantalla() {
    if (!S.viewer) return;
    try {
        const r = await S.viewer.captura();
        let blob = null;
        if (r instanceof Blob) blob = r;
        else if (typeof r === 'string' && r.startsWith('data:')) blob = await (await fetch(r)).blob();
        else if (r && typeof r.toBlob === 'function') {
            blob = await new Promise((resolve) => r.toBlob(resolve, 'image/png'));
        } else if (r) blob = aBlob(r, 'image/png');

        if (!blob) throw new Error('el visor no devolvió imagen');
        const nombre = nombreArchivo((S.visorRegistro && S.visorRegistro.meta && S.visorRegistro.meta.nombre) || 'escaneo', 'png');
        await descargar(blob, nombre);
        aviso('Captura guardada.', 'exito');
    } catch (err) {
        aviso('No se pudo tomar la captura: ' + textoError(err), 'error');
    }
}

async function cerrarVisor() {
    detenerSeguimientoMediciones();
    window.removeEventListener('resize', alRedimensionarVisor);
    window.removeEventListener('orientationchange', alRedimensionarVisor);

    if (S.viewer) {
        try { S.viewer.destruir(); } catch (err) { console.warn('[JoseScan] Error al destruir el visor:', err); }
        S.viewer = null;
    }
    S.visorRegistro = null;

    const capa = document.getElementById('lidar-visor');
    if (capa) {
        cerrarCapa(capa);
        capa.classList.add('lidar-oculto');
        const lienzo = document.getElementById('lidar-visor-lienzo');
        if (lienzo) lienzo.textContent = '';
    }
    const btnMedir = document.getElementById('btn-lidar-medir');
    if (btnMedir) {
        btnMedir.setAttribute('aria-pressed', 'false');
        btnMedir.classList.remove('lidar-btn-activo');
    }
    const listaMed = document.getElementById('lidar-mediciones');
    if (listaMed) listaMed.classList.add('lidar-oculto');
}

/* --------------------------------------------------------------------------
   14. API pública
   -------------------------------------------------------------------------- */

/** Abre el panel lateral de escaneos 3D. */
export function abrirPanelLidar() {
    if (!S.panel) return;

    for (const p of document.querySelectorAll('.side-panel.open')) {
        if (p !== S.panel) p.classList.remove('open');
    }
    for (const n of document.querySelectorAll('#bottom-nav .nav-item[data-target]')) {
        n.classList.remove('active');
    }

    S.panel.classList.add('open');
    mostrarOverlay(true);
    if (S.boton) {
        S.boton.classList.add('active');
        S.boton.setAttribute('aria-expanded', 'true');
    }

    refrescarGaleria().catch((err) => console.warn('[JoseScan] Galería:', err));
    refrescarEspacio().catch((err) => console.warn('[JoseScan] Espacio:', err));
}

/** Cierra el panel lateral de escaneos 3D. */
export function cerrarPanelLidar() {
    if (!S.panel) return;
    S.panel.classList.remove('open');
    mostrarOverlay(false);
    if (S.boton) {
        S.boton.classList.remove('active');
        S.boton.setAttribute('aria-expanded', 'false');
    }
    revocarMiniaturas();
}

/**
 * Arranca la interfaz de escaneos 3D. Idempotente: se puede llamar varias
 * veces sin duplicar botones, paneles ni escuchadores.
 *
 * @param {{docsGuia?: string, abrirAlIniciar?: boolean}} [opciones]
 */
export async function initLidarUI(opciones = {}) {
    if (S.iniciado) return apiPublica();
    if (S.iniciando) return S.iniciando;

    S.iniciando = (async () => {
        S.opciones = Object.assign({ docsGuia: RUTA_GUIA }, opciones);

        try {
            asegurarHojaEstilos();
            asegurarOverlay();
            crearPanel();
            crearBoton();
            document.addEventListener('keydown', onTeclaGlobal);
        } catch (err) {
            console.error('[JoseScan] No se pudo montar la interfaz:', err);
            S.iniciando = null;
            throw err;
        }

        S.iniciado = true;

        try {
            await initScanDB();
        } catch (err) {
            console.warn('[JoseScan] Base de datos de escaneos no disponible:', err);
            aviso('El almacén de escaneos no está disponible: ' + textoError(err), 'error');
        }

        try {
            await pintarEstadoSensor();
        } catch (err) {
            console.warn('[JoseScan] Estado del sensor:', err);
        }

        try {
            await refrescarGaleria();
            await refrescarEspacio();
        } catch (err) {
            console.warn('[JoseScan] Carga inicial:', err);
        }

        if (S.opciones.abrirAlIniciar) abrirPanelLidar();

        return apiPublica();
    })();

    return S.iniciando;
}

function apiPublica() {
    return {
        abrir: abrirPanelLidar,
        cerrar: cerrarPanelLidar,
        refrescar: async () => { await refrescarGaleria(); await refrescarEspacio(); }
    };
}

/* --------------------------------------------------------------------------
   15. Autoarranque
   -------------------------------------------------------------------------- */

function autoArrancar() {
    initLidarUI().catch((err) => console.error('[JoseScan] Error de arranque:', err));
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoArrancar, { once: true });
    } else {
        autoArrancar();
    }
}

export default { initLidarUI, abrirPanelLidar, cerrarPanelLidar };
