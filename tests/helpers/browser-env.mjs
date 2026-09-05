/**
 * Entorno de navegador mínimo para poder ejecutar en Node los módulos de JoseMaps.
 *
 * Los módulos de `js/` están escritos para el navegador y dependen de globales
 * (`window`, `window.proj4`, `window.L`, `document`, ...). Este helper instala
 * lo mínimo imprescindible ANTES de que se importen esos módulos.
 *
 * IMPORTANTE: proj4 es el paquete REAL (devDependency), no un doble. El objetivo
 * de las pruebas de coordenadas es validar la proyección de verdad.
 *
 * Uso:
 *     import { proj4, sinProj4 } from './helpers/browser-env.mjs';
 *     import { toMagnaSirgas } from '../js/coords.js';
 */

import proj4Real from 'proj4';

export const proj4 = proj4Real;

// --- Stub mínimo de elemento DOM -------------------------------------------
function crearElementoFalso(tag = 'div') {
    const el = {
        tagName: String(tag).toUpperCase(),
        id: '',
        className: '',
        innerHTML: '',
        textContent: '',
        children: [],
        classList: {
            _set: new Set(),
            add(...c) { c.forEach(x => this._set.add(x)); },
            remove(...c) { c.forEach(x => this._set.delete(x)); },
            contains(c) { return this._set.has(c); },
            toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
        },
        appendChild(hijo) { this.children.push(hijo); return hijo; },
        removeChild(hijo) { this.children = this.children.filter(h => h !== hijo); return hijo; },
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        setAttribute() {},
        getAttribute() { return null; },
        remove() {}
    };
    return el;
}

export { crearElementoFalso };

// --- Instalación de globales ------------------------------------------------
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {};
}
globalThis.window.proj4 = proj4Real;

if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag) => crearElementoFalso(tag),
        body: crearElementoFalso('body')
    };
}
globalThis.window.document = globalThis.document;

/**
 * Ejecuta `fn` con `window.proj4` ausente (rama de respaldo de coords.js)
 * y restaura el estado previo al terminar, incluso si `fn` lanza.
 */
export function sinProj4(fn) {
    const previo = globalThis.window.proj4;
    delete globalThis.window.proj4;
    try {
        return fn();
    } finally {
        globalThis.window.proj4 = previo;
    }
}

/**
 * Ejecuta `fn` sin ningún `window` global (entorno Node puro / Web Worker).
 * Sirve para verificar que los módulos no revientan con ReferenceError.
 */
export function sinWindow(fn) {
    const previo = globalThis.window;
    delete globalThis.window;
    try {
        return fn();
    } finally {
        globalThis.window = previo;
    }
}

/**
 * Silencia console.error/console.warn mientras corre `fn` y devuelve
 * { resultado, errores, avisos } para poder aseverar sobre los mensajes.
 */
export function silenciarConsola(fn) {
    const errOriginal = console.error;
    const warnOriginal = console.warn;
    const errores = [];
    const avisos = [];
    console.error = (...args) => errores.push(args.join(' '));
    console.warn = (...args) => avisos.push(args.join(' '));
    try {
        return { resultado: fn(), errores, avisos };
    } finally {
        console.error = errOriginal;
        console.warn = warnOriginal;
    }
}

/**
 * mapEngine falso: MeasurementTool sólo usa `mapEngine?.map` para dibujar
 * capas de Leaflet. Sin `window.L` el método redraw() sale temprano, así que
 * las pruebas de cálculo puro no necesitan Leaflet.
 */
export function crearMapEngineFalso() {
    const capas = [];
    return {
        capas,
        map: {
            on() {},
            off() {},
            removeLayer(capa) {
                const i = capas.indexOf(capa);
                if (i >= 0) capas.splice(i, 1);
            }
        }
    };
}

/** Punto latlng al estilo Leaflet. */
export const latlng = (lat, lng) => ({ lat, lng });
