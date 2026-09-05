/**
 * Prueba de humo de JoseMaps.
 *
 * Red de seguridad para refactorizar `js/app.js`: no comprueba reglas de
 * negocio, comprueba que la app ARRANCA y que su esqueleto sigue en pie. Un
 * import mal escrito, un `export` que falta, un identificador que se quedó sin
 * mover o un puente global perdido salen aquí en rojo.
 */

import { test, expect, abrirApp, esperarAppLista } from './fixtures.mjs';

const PANELES = [
    { id: 'panel-maps', titulo: 'Mapas y proyectos' },
    { id: 'panel-tracks', titulo: 'Rutas' },
    { id: 'panel-placemarks', titulo: 'Marcadores' },
    { id: 'panel-settings', titulo: 'Ajustes' }
];

/** Puentes globales documentados en CLAUDE.md. Perder uno rompe otros módulos. */
const PUENTES_GLOBALES = [
    'CAMPOMAPS_VERSION',
    '__campoMapsOpenPhoto',
    '__campoMapsRenderPhotos',
    '__campoMapsClearPhotos',
    '__campoMapsGetPhotos',
    '__campoMapsUpdateBadges',
    '__campoMapsSaveSetting'
];

test.describe('Prueba de humo de JoseMaps', () => {

    test('1. la app arranca sin errores de consola, excepciones ni recursos rotos', async ({ page, errores }) => {
        await abrirApp(page, errores);

        await expect(page).toHaveTitle(/JoseMaps/);
        await expect(page.locator('#app-container')).toBeVisible();

        // La comprobación que más vale de toda la suite.
        expect(errores.resumen(), 'La carga de la app no debe producir ningún error').toEqual([]);
    });

    test('2. el mapa de Leaflet se monta con la capa base por defecto y sus controles', async ({ page, errores }) => {
        await abrirApp(page, errores);

        // Leaflet montado sobre #map.
        const mapa = page.locator('#map');
        await expect(mapa).toHaveClass(/leaflet-container/);
        await expect(page.locator('#map .leaflet-tile-pane')).toHaveCount(1);
        await expect(page.locator('#map .leaflet-control-attribution')).toContainText('Google');

        // Capa base por defecto: Google Híbrido (satellite en map-engine.js).
        const teselas = page.locator('#map .leaflet-tile-pane img');
        await expect.poll(
            async () => teselas.count(),
            { message: 'La capa base debe pedir teselas' }
        ).toBeGreaterThan(0);
        const src = await teselas.first().getAttribute('src');
        expect(src, 'La capa base por defecto debe ser Google Híbrido (lyrs=y)').toMatch(/mt\d\.google\.com\/vt\/lyrs=y/);

        // El panel de mapas nombra la capa base activa.
        await page.locator('#bottom-nav .nav-item[data-target="panel-maps"]').click();
        await expect(page.locator('#base-layer-item .item-title')).toHaveText('Google Híbrido');

        // Controles del dock, navegación inferior y botón flotante.
        for (const id of ['btn-quick-projects', 'btn-layers', 'btn-measure-toggle', 'btn-crosshair-toggle',
            'btn-zoom-in', 'btn-zoom-out', 'btn-compass', 'btn-gps-center']) {
            await expect(page.locator(`#${id}`), `Falta el control #${id}`).toBeAttached();
        }
        await expect(page.locator('#fab-add-placemark')).toBeAttached();
        await expect(page.locator('#bottom-nav .nav-item')).toHaveCount(5);
        await expect(page.locator('#map-crosshair')).toBeAttached();

        expect(errores.resumen()).toEqual([]);
    });

    test('3. cada panel lateral abre y cierra', async ({ page, errores }) => {
        await abrirApp(page, errores);

        const overlay = page.locator('#panel-overlay');

        for (const { id, titulo } of PANELES) {
            const panel = page.locator(`#${id}`);
            const boton = page.locator(`#bottom-nav .nav-item[data-target="${id}"]`);

            await boton.click();
            await expect(panel, `#${id} debería abrirse`).toHaveClass(/\bopen\b/);
            await expect(panel.locator('.panel-header h2')).toHaveText(titulo);
            await expect(overlay, 'El velo debe aparecer con el panel abierto').not.toHaveClass(/\bhidden\b/);
            await expect(boton).toHaveClass(/\bactive\b/);

            await panel.locator('.btn-close-panel').click();
            await expect(panel, `#${id} debería cerrarse`).not.toHaveClass(/\bopen\b/);
            await expect(overlay).toHaveClass(/\bhidden\b/);
        }

        // El velo también cierra el panel abierto.
        await page.locator('#bottom-nav .nav-item[data-target="panel-settings"]').click();
        await expect(page.locator('#panel-settings')).toHaveClass(/\bopen\b/);
        await overlay.click({ position: { x: 10, y: 10 } });
        await expect(page.locator('#panel-settings')).not.toHaveClass(/\bopen\b/);

        expect(errores.resumen()).toEqual([]);
    });

    test('4. la interfaz de respaldo existe y abre sus diálogos', async ({ page, errores }) => {
        await abrirApp(page, errores);

        await page.locator('#bottom-nav .nav-item[data-target="panel-settings"]').click();
        await expect(page.locator('#panel-settings')).toHaveClass(/\bopen\b/);

        const btnExportar = page.locator('#btn-backup-export');
        const btnImportar = page.locator('#btn-backup-import');
        await expect(btnExportar).toBeVisible();
        await expect(btnImportar).toBeVisible();

        // Exportar: backup.js crea #modal-backup-export bajo demanda.
        await btnExportar.click();
        const modalExportar = page.locator('#modal-backup-export');
        await expect(modalExportar).toHaveCount(1);
        await expect(modalExportar, 'El diálogo de respaldo debe quedar visible').not.toHaveClass(/\bhidden\b/);
        await expect(modalExportar).toContainText('Crear respaldo');
        await expect(modalExportar.locator('#btn-start-backup')).toBeVisible();

        await modalExportar.locator('#btn-close-backup').click();
        await expect(modalExportar).toHaveClass(/\bhidden\b/);

        // Importar: dispara el selector de archivos (#input-backup-file).
        // No se restaura nada de verdad; se verifica el cableado del botón.
        const [selector] = await Promise.all([
            page.waitForEvent('filechooser'),
            btnImportar.click()
        ]);
        expect(selector, 'El botón de restaurar debe abrir el selector de archivos').toBeTruthy();

        expect(errores.resumen()).toEqual([]);
    });

    test('5. IndexedDB se inicializa y los puentes globales siguen definidos', async ({ page, errores }) => {
        await abrirApp(page, errores);

        const bases = await page.evaluate(async () => {
            if (!indexedDB.databases) return null;
            return (await indexedDB.databases()).map((b) => ({ name: b.name, version: b.version }));
        });
        expect(bases, 'El navegador debe poder listar las bases').not.toBeNull();
        const campo = bases.find((b) => b.name === 'CampoMapsDB');
        expect(campo, 'Debe existir la base CampoMapsDB').toBeTruthy();

        // Los almacenes documentados en CLAUDE.md.
        const almacenes = await page.evaluate(() => new Promise((resolver, rechazar) => {
            const peticion = indexedDB.open('CampoMapsDB');
            peticion.onsuccess = () => {
                const db = peticion.result;
                const nombres = Array.from(db.objectStoreNames);
                db.close();
                resolver(nombres);
            };
            peticion.onerror = () => rechazar(peticion.error);
        }));
        for (const almacen of ['projects', 'maps', 'tracks', 'placemarks', 'settings']) {
            expect(almacenes, `Falta el almacén ${almacen} en CampoMapsDB`).toContain(almacen);
        }

        // Puentes globales: un refactor que se deje uno por el camino falla aquí.
        const definidos = await page.evaluate((claves) => {
            const salida = {};
            for (const clave of claves) salida[clave] = typeof window[clave];
            return salida;
        }, PUENTES_GLOBALES);

        expect(definidos.CAMPOMAPS_VERSION).toBe('string');
        expect(definidos.CAMPOMAPS_VERSION, 'window.CAMPOMAPS_VERSION debe estar definido').not.toBe('undefined');
        for (const clave of PUENTES_GLOBALES.filter((c) => c !== 'CAMPOMAPS_VERSION')) {
            expect(definidos[clave], `window.${clave} debe ser una función`).toBe('function');
        }

        // La versión que muestra Ajustes es la canónica de js/version.js.
        const version = await page.evaluate(() => window.CAMPOMAPS_VERSION);
        await expect(page.locator('#app-version-label')).toHaveText(version);

        expect(errores.resumen()).toEqual([]);
    });

    test('6. el Service Worker se registra y toma el control', async ({ page, errores }) => {
        await abrirApp(page, errores);

        const estado = await page.evaluate(async () => {
            if (!('serviceWorker' in navigator)) return { soportado: false };
            const registro = await navigator.serviceWorker.getRegistration('./');
            if (!registro) return { soportado: true, registrado: false };
            const activo = registro.active || registro.waiting || registro.installing;
            return {
                soportado: true,
                registrado: true,
                alcance: registro.scope,
                script: activo ? activo.scriptURL : null
            };
        });

        expect(estado.soportado, 'El navegador de prueba debe soportar Service Workers').toBe(true);
        expect(estado.registrado, 'La app debe registrar su Service Worker').toBe(true);
        expect(estado.script, 'El Service Worker registrado debe ser ./sw.js').toContain('/sw.js');

        // El registro se pide con el sufijo de versión canónico.
        const version = await page.evaluate(() => window.CAMPOMAPS_VERSION);
        expect(estado.script).toContain(`v=${version}`);

        expect(errores.resumen()).toEqual([]);
    });

    test('7. recargar la app con el Service Worker ya activo la deja igual de sana', async ({ page, errores }) => {
        // Segunda carga: aquí el SW ya controla la página y sirve los módulos.
        // Es el escenario real del usuario (abre la app cada mañana) y el que
        // destapa una lista PRECACHE_ASSETS desincronizada.
        await abrirApp(page, errores);
        await page.evaluate(() => navigator.serviceWorker.ready);

        await page.reload();
        await esperarAppLista(page);

        await expect(page.locator('#map')).toHaveClass(/leaflet-container/);
        await page.locator('#bottom-nav .nav-item[data-target="panel-placemarks"]').click();
        await expect(page.locator('#panel-placemarks')).toHaveClass(/\bopen\b/);

        expect(errores.resumen()).toEqual([]);
    });

    test('8. los modales principales abren y cierran', async ({ page, errores }) => {
        await abrirApp(page, errores);

        // Gestor de proyectos (setupProjects).
        await page.locator('#btn-quick-projects').click();
        const modalProyectos = page.locator('#modal-projects');
        await expect(modalProyectos).not.toHaveClass(/\bhidden\b/);
        await modalProyectos.locator('.btn-close-modal').first().click();
        await expect(modalProyectos).toHaveClass(/\bhidden\b/);

        // Nuevo marcador desde la mira (setupPlacemarks).
        await page.locator('#fab-add-placemark').click();
        const modalMarcador = page.locator('#modal-placemark');
        await expect(modalMarcador).not.toHaveClass(/\bhidden\b/);

        // La coordenada del formulario va en MAGNA-SIRGAS (metros), no en
        // lat/lon: si proj4 no cargara, coords.js degrada en silencio a 0 y
        // esta comprobación es la única que lo delata.
        const magna = await page.locator('#pm-status-magna').textContent();
        expect(magna, 'El marcador debe mostrar N/E en MAGNA-SIRGAS').toMatch(/^N: .+ \| E: .+$/);
        const norte = Number(magna.replace(/^N:\s*/, '').split('|')[0].replace(/[^0-9]/g, ''));
        expect(norte, 'El Norte MAGNA de Colombia ronda los 2.000.000 m; un 0 significa proj4 caído').toBeGreaterThan(1_000_000);

        await modalMarcador.locator('.btn-close-modal').first().click();
        await expect(modalMarcador).toHaveClass(/\bhidden\b/);

        // Importar o calibrar plano (setupCalibration).
        await page.locator('#bottom-nav .nav-item[data-target="panel-maps"]').click();
        await page.locator('#btn-open-calibrate').click();
        const modalCalibrar = page.locator('#modal-calibrate');
        await expect(modalCalibrar).not.toHaveClass(/\bhidden\b/);
        await modalCalibrar.locator('.btn-close-modal').first().click();
        await expect(modalCalibrar).toHaveClass(/\bhidden\b/);

        // Descarga de satélite offline (tile-downloader.js, modal creado al vuelo).
        await page.locator('#bottom-nav .nav-item[data-target="panel-maps"]').click();
        await page.locator('#btn-open-offline-dl').click();
        const modalDescarga = page.locator('#modal-offline-download');
        await expect(modalDescarga).toHaveCount(1);
        await expect(modalDescarga).not.toHaveClass(/\bhidden\b/);
        await modalDescarga.locator('#btn-cancel-dl').click();
        await expect(modalDescarga).toHaveClass(/\bhidden\b/);

        expect(errores.resumen()).toEqual([]);
    });
});
