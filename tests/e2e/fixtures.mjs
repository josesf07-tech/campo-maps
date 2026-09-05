/**
 * Utilidades comunes de las pruebas end-to-end.
 *
 * Aporta tres cosas:
 *
 * 1. Un `test` extendido que intercepta TODA la red del navegador. Las librerías
 *    que en producción vienen de CDN (Leaflet, pdf.js, proj4, JSZip, xlsx,
 *    ExcelJS) se responden desde `node_modules`, y las teselas de mapa base con
 *    un PNG de 1x1. Así la prueba no depende de internet y es determinista.
 *    Cualquier otra petición externa se corta y se anota como fallo: si alguien
 *    añade una dependencia de red nueva, la prueba lo dice en voz alta.
 * 2. Un recolector de errores (`errores`) con la consola, los `pageerror`, las
 *    peticiones fallidas de recursos propios y los externos inesperados.
 * 3. `esperarAppLista()`, que espera al final real de `initApp()`.
 */

import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ_REPO = path.resolve(AQUI, '..', '..');

/**
 * Dependencias externas que la app necesita sí o sí para arrancar.
 * URL exacta pedida por `index.html` -> copia local equivalente y misma versión.
 * Si `index.html` cambia una CDN de sitio o de versión, esta tabla deja de
 * cubrirla, la petición se corta y la prueba falla indicando la URL.
 */
export const LIBRERIAS_CDN = new Map([
    ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'node_modules/leaflet/dist/leaflet.css'],
    ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'node_modules/leaflet/dist/leaflet.js'],
    ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'node_modules/pdfjs-dist/build/pdf.min.js'],
    ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', 'node_modules/pdfjs-dist/build/pdf.worker.min.js'],
    ['https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.2/proj4.js', 'node_modules/proj4/dist/proj4.js'],
    ['https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', 'node_modules/jszip/dist/jszip.min.js'],
    ['https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'node_modules/xlsx/dist/xlsx.full.min.js'],
    ['https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js', 'node_modules/exceljs/dist/exceljs.min.js']
]);

/** Iconos de Leaflet referenciados desde su propio CSS. */
const PREFIJO_IMAGENES_LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/images/';
const DIR_IMAGENES_LEAFLET = 'node_modules/leaflet/dist/images';

/** Servidores de teselas de las capas base de `map-engine.js`. */
const HOSTS_TESELAS = [
    /^https:\/\/mt[0-9]\.google\.com\//,
    /^https:\/\/server\.arcgisonline\.com\//,
    /^https:\/\/[a-c]\.tile\.openstreetmap\.org\//,
    /^https:\/\/[a-c]\.tile\.opentopomap\.org\//
];

/** PNG transparente de 1x1, respuesta para cualquier tesela. */
const TESELA_VACIA = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

/** Coordenadas fijas dentro de Colombia (Bogotá) para simular el GPS. */
export const POSICION_SIMULADA = { latitude: 4.65, longitude: -74.06, accuracy: 8 };

/** Devuelve la copia local de una URL de CDN, o `null` si no está mapeada. */
export function archivoLocalParaCdn(url) {
    const sinConsulta = url.split('?')[0];
    if (LIBRERIAS_CDN.has(sinConsulta)) {
        return path.join(RAIZ_REPO, LIBRERIAS_CDN.get(sinConsulta));
    }
    if (sinConsulta.startsWith(PREFIJO_IMAGENES_LEAFLET)) {
        const nombre = path.basename(sinConsulta);
        return path.join(RAIZ_REPO, DIR_IMAGENES_LEAFLET, nombre);
    }
    return null;
}

function esTesela(url) {
    return HOSTS_TESELAS.some((re) => re.test(url));
}

export const test = base.extend({
    /**
     * Recolector de errores + interceptación de red. Es `auto` para que ninguna
     * prueba pueda navegar sin la red controlada, aunque no lo pida.
     */
    errores: [async ({ context, page, baseURL }, usar) => {
        const consola = [];
        const excepciones = [];
        const peticionesFallidas = [];
        const respuestasMalas = [];
        const externosInesperados = [];

        const esPropio = (url) => url.startsWith(baseURL);

        await context.route('**/*', async (ruta) => {
            const url = ruta.request().url();

            if (esPropio(url) || url.startsWith('data:') || url.startsWith('blob:')) {
                await ruta.continue();
                return;
            }

            const local = archivoLocalParaCdn(url);
            if (local) {
                if (!fs.existsSync(local)) {
                    externosInesperados.push(`${url} (falta la copia local ${local}; ejecuta npm install)`);
                    await ruta.abort();
                    return;
                }
                await ruta.fulfill({ path: local });
                return;
            }

            if (esTesela(url)) {
                await ruta.fulfill({ status: 200, contentType: 'image/png', body: TESELA_VACIA });
                return;
            }

            externosInesperados.push(url);
            await ruta.abort();
        });

        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                consola.push(`${msg.text()} @ ${msg.location().url}:${msg.location().lineNumber}`);
            }
        });

        page.on('pageerror', (err) => {
            excepciones.push(err.stack || String(err));
        });

        page.on('requestfailed', (req) => {
            // Los externos cortados a propósito ya se anotan arriba.
            if (!esPropio(req.url())) return;
            peticionesFallidas.push(`${req.url()} (${req.failure()?.errorText || 'desconocido'})`);
        });

        page.on('response', (res) => {
            if (!esPropio(res.url())) return;
            if (res.status() >= 400) respuestasMalas.push(`${res.url()} -> HTTP ${res.status()}`);
        });

        const api = {
            consola,
            excepciones,
            peticionesFallidas,
            respuestasMalas,
            externosInesperados,
            /** Lista plana y legible de todo lo que ha ido mal. */
            resumen() {
                return [
                    ...excepciones.map((e) => `Excepción de página: ${e}`),
                    ...consola.map((e) => `Error de consola: ${e}`),
                    ...peticionesFallidas.map((e) => `Petición propia fallida: ${e}`),
                    ...respuestasMalas.map((e) => `Respuesta propia con error: ${e}`),
                    ...externosInesperados.map((e) => `Dependencia externa no declarada: ${e}`)
                ];
            }
        };

        await usar(api);
    }, { auto: true }]
});

export { expect };

/**
 * Abre la app y espera a que `initApp()` haya terminado de verdad: mapa montado
 * y listas ya pintadas por `loadSavedData()`.
 */
export async function abrirApp(page, errores = null) {
    await page.goto('/index.html');
    try {
        await esperarAppLista(page);
    } catch (fallo) {
        // Si la app no arrancó, casi siempre hay una causa concreta en la
        // consola (un import roto, un export que falta). Se antepone al
        // mensaje de espera agotada, que por sí solo no dice nada.
        const problemas = errores ? errores.resumen() : [];
        if (problemas.length > 0) {
            throw new Error(
                'La app no terminó de arrancar. Causa probable:\n  - '
                + problemas.join('\n  - ')
                + '\n\nEspera fallida: ' + fallo.message
            );
        }
        throw fallo;
    }
}

export async function esperarAppLista(page) {
    // Leaflet montado.
    await expect(page.locator('#map .leaflet-container, #map.leaflet-container')).toHaveCount(1);
    // Última fase de initApp: loadSavedData() ya pintó las listas del proyecto.
    await expect(page.locator('#list-placemarks li')).not.toHaveCount(0);
    await expect(page.locator('#list-tracks li')).not.toHaveCount(0);
    // Puentes globales cableados por los setup*().
    await page.waitForFunction(() => typeof window.__campoMapsSaveSetting === 'function');
}
