/**
 * Servidor estático mínimo para las pruebas end-to-end.
 *
 * `file://` no sirve: la app carga módulos ES y registra un Service Worker, y
 * ambas cosas exigen un origen http(s). Se usa 127.0.0.1 porque el navegador lo
 * trata como contexto seguro, igual que https, y así el Service Worker se
 * registra sin certificados.
 *
 * Sin dependencias externas a propósito: es solo `node:http` sobre la raíz del
 * repositorio, con cabeceras anti-caché para que cada prueba vea los archivos
 * tal y como están en el disco.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ_REPO = path.resolve(AQUI, '..', '..');

const PUERTO = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const TIPOS = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
};

/** Resuelve la URL pedida a una ruta dentro del repositorio, o `null` si se sale. */
export function resolverRuta(urlPedida) {
    let ruta;
    try {
        ruta = decodeURIComponent(new URL(urlPedida, 'http://localhost').pathname);
    } catch {
        return null;
    }
    if (ruta.endsWith('/')) ruta += 'index.html';
    const destino = path.resolve(RAIZ_REPO, '.' + ruta);
    if (destino !== RAIZ_REPO && !destino.startsWith(RAIZ_REPO + path.sep)) return null;
    return destino;
}

export function crearServidor() {
    return http.createServer(async (req, res) => {
        const destino = resolverRuta(req.url || '/');

        if (!destino) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Ruta fuera del repositorio');
            return;
        }

        try {
            const info = await fsp.stat(destino);
            if (info.isDirectory()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('No encontrado');
                return;
            }

            const tipo = TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': tipo,
                'Content-Length': info.size,
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                // El Service Worker se sirve desde la raíz: alcance completo.
                'Service-Worker-Allowed': '/'
            });
            fs.createReadStream(destino).pipe(res);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('No encontrado: ' + req.url);
        }
    });
}

// Solo arranca si se ejecuta directamente (`node tests/e2e/static-server.mjs`).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    crearServidor().listen(PUERTO, HOST, () => {
        console.log(`Servidor de pruebas en http://${HOST}:${PUERTO} (raíz: ${RAIZ_REPO})`);
    });
}
