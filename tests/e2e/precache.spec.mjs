/**
 * Coherencia del Service Worker con el disco.
 *
 * Estas comprobaciones no abren el navegador: leen `sw.js`, `index.html` y el
 * árbol de `js/`. Están aquí, y no en las unitarias, porque protegen el mismo
 * escenario que la prueba de humo — que la app siga arrancando tras un
 * refactor — pero en la variante que solo se nota en campo: SIN CONEXIÓN.
 *
 * El fallo que buscan es el descrito en CLAUDE.md: se crea un módulo nuevo en
 * `js/` y se olvida añadirlo a PRECACHE_ASSETS. Con red no se nota nada; sin
 * red la app queda inservible.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const swFuente = fs.readFileSync(path.join(RAIZ, 'sw.js'), 'utf8');
const htmlFuente = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');

/** Extrae la lista literal PRECACHE_ASSETS de `sw.js`. */
function leerPrecache() {
    const bloque = swFuente.match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\n\];/);
    expect(bloque, 'No se encontró la lista PRECACHE_ASSETS en sw.js').not.toBeNull();
    return [...bloque[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]);
}

/** Quita el sufijo de versión `?v=NN` y normaliza a la forma `./ruta`. */
function normalizar(ruta) {
    const limpia = ruta.split('?')[0];
    if (limpia.startsWith('./')) return limpia;
    return './' + limpia.replace(/^\//, '');
}

/** Lista recursiva de archivos de un directorio, en forma `./dir/archivo`. */
function listarArchivos(directorio) {
    const base = path.join(RAIZ, directorio);
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
        .flatMap((entrada) => (entrada.isDirectory()
            ? listarArchivos(path.join(directorio, entrada.name))
            : [`./${path.join(directorio, entrada.name).split(path.sep).join('/')}`]));
}

const PRECACHE = leerPrecache();
const LOCALES = PRECACHE.filter((a) => a.startsWith('./'));
const EXTERNOS = PRECACHE.filter((a) => a.startsWith('http'));

test.describe('PRECACHE_ASSETS del Service Worker', () => {

    test('la lista no está vacía y distingue recursos propios de CDN', () => {
        expect(LOCALES.length, 'PRECACHE_ASSETS debe listar recursos propios').toBeGreaterThan(10);
        expect(EXTERNOS.length, 'PRECACHE_ASSETS debe listar las CDN').toBeGreaterThan(0);
        expect(new Set(PRECACHE).size, 'PRECACHE_ASSETS tiene entradas duplicadas').toBe(PRECACHE.length);
    });

    test('cada ruta relativa de PRECACHE_ASSETS existe en el disco', () => {
        const faltantes = LOCALES.filter((entrada) => {
            const relativa = entrada === './' ? 'index.html' : entrada.slice(2);
            return !fs.existsSync(path.join(RAIZ, relativa));
        });
        expect(faltantes, 'Recursos precacheados que no existen: la app se rompe sin conexión').toEqual([]);
    });

    test('todo módulo de js/ y toda hoja de css/ está en PRECACHE_ASSETS', () => {
        const enDisco = [...listarArchivos('js'), ...listarArchivos('css')]
            .filter((f) => /\.(js|mjs|css)$/.test(f));
        const listados = new Set(LOCALES.map(normalizar));
        const olvidados = enDisco.filter((f) => !listados.has(f));
        expect(
            olvidados,
            'Archivos nuevos sin precachear: funcionarán con red y romperán la app sin conexión'
        ).toEqual([]);
    });

    test('todo recurso propio que pide index.html está en PRECACHE_ASSETS', () => {
        const referencias = [...htmlFuente.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
        const propios = referencias.filter((r) => (
            !r.startsWith('#') && !r.startsWith('http') && !r.startsWith('data:')
            && !r.split('?')[0].endsWith('sw.js')
        ));
        const listados = new Set(LOCALES.map(normalizar));
        const olvidados = [...new Set(propios.map(normalizar))].filter((r) => !listados.has(r));
        expect(olvidados, 'index.html pide recursos propios que el SW no precachea').toEqual([]);
    });

    test('toda CDN que pide index.html está en PRECACHE_ASSETS', () => {
        const referencias = [...htmlFuente.matchAll(/(?:src|href)="(https:\/\/[^"]+)"/g)].map((m) => m[1]);
        const listados = new Set(EXTERNOS);
        const olvidadas = [...new Set(referencias)].filter((r) => !listados.has(r));
        expect(
            olvidadas,
            'CDN sin precachear: la app dejaría de arrancar sin señal (ver CLAUDE.md)'
        ).toEqual([]);
    });
});

test.describe('Grafo de módulos ES', () => {

    test('todos los imports relativos de js/ resuelven a un archivo existente', () => {
        const rotos = [];
        for (const modulo of listarArchivos('js').filter((f) => f.endsWith('.js'))) {
            const rutaAbs = path.join(RAIZ, modulo.slice(2));
            const fuente = fs.readFileSync(rutaAbs, 'utf8');
            const especificadores = [
                ...fuente.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
                ...fuente.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)
            ].map((m) => m[1]);

            for (const especificador of especificadores) {
                const destino = path.resolve(path.dirname(rutaAbs), especificador);
                if (!fs.existsSync(destino)) rotos.push(`${modulo} -> ${especificador}`);
            }
        }
        expect(rotos, 'Imports que apuntan a archivos inexistentes').toEqual([]);
    });

    test('index.html carga app.js como módulo y version.js como script clásico', () => {
        expect(htmlFuente).toMatch(/<script\s+type="module"\s+src="js\/app\.js/);
        expect(htmlFuente).toMatch(/<script\s+src="js\/version\.js/);
    });
});
