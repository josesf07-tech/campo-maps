/**
 * Ciclo completo del flujo de marcadores de JoseMaps.
 *
 * A diferencia de la prueba de humo, esto SÍ comprueba comportamiento: el punto
 * se crea desde el botón flotante como en campo, se llena la ficha de censo
 * "Uso y Usuarios", se guarda, **se recarga la página** y se verifica que el
 * registro volvió íntegro desde IndexedDB.
 *
 * La recarga es el corazón de la prueba: sin ella nada obliga al dato a pasar
 * por el almacenamiento, y el fallo que se quiere cazar (perder `censoAgua`,
 * `projectId` o `createdAt` al partir `js/app.js` en módulos) no se ve en
 * pantalla — se ve semanas después, con el Excel del censo vacío.
 */

import { test, expect, abrirApp, esperarAppLista } from './fixtures.mjs';

/** Lo que se teclea en el formulario. Se compara campo a campo contra la base. */
const PUNTO = {
    // Con `#` y `&` a propósito: el nombre pasa por `escapeHtml` al pintar la lista.
    nombre: 'Pozo #3 & anexo',
    descripcion: 'Punto de muestreo aguas abajo del vertimiento',
    icono: 'water',
    censo: {
        idCampo: 'P-01',
        municipio: 'Aguazul',
        vereda: 'San José',
        predio: 'Finca La Esperanza',
        habitantes: '7',
        cota: '345',
        otrosUsos: 'Piscícola y recreativo',
        fuentePrimaria: ['Río', 'Aljibe'],
        fuenteSecundaria: ['Quebrada'],
        fuentePecuario: ['Jagüey'],
        fuenteAgricola: ['Manantial'],
        residuoLiquido: ['Pozo Séptico'],
        residuoSolido: ['Quema']
    }
};

/** Contenedor de chips de cada lista del censo, en el orden en que se llenan. */
const CHIPS_POR_CAMPO = [
    ['fuentePrimaria', 'chips-fuente-primaria', 'badge-fuente-primaria'],
    ['fuenteSecundaria', 'chips-fuente-secundaria', 'badge-fuente-secundaria'],
    ['fuentePecuario', 'chips-fuente-pecuario', 'badge-fuente-pecuario'],
    ['fuenteAgricola', 'chips-fuente-agricola', 'badge-fuente-agricola'],
    ['residuoLiquido', 'chips-residuo-liquido', 'badge-residuo-liquido'],
    ['residuoSolido', 'chips-residuo-solido', 'badge-residuo-solido']
];

// ---------------------------------------------------------------- utilidades

/**
 * Lee el almacén `placemarks` tal cual quedó en IndexedDB, sin pasar por el
 * `state` de la app: es la única forma de saber qué se guardó de verdad.
 */
async function leerMarcadoresGuardados(page) {
    return page.evaluate(() => new Promise((resolver, rechazar) => {
        const peticion = indexedDB.open('CampoMapsDB');
        peticion.onerror = () => rechazar(peticion.error);
        peticion.onsuccess = () => {
            const db = peticion.result;
            if (!db.objectStoreNames.contains('placemarks')) {
                db.close();
                rechazar(new Error('CampoMapsDB no tiene el almacén placemarks'));
                return;
            }
            const consulta = db.transaction('placemarks', 'readonly').objectStore('placemarks').getAll();
            consulta.onsuccess = () => {
                const registros = consulta.result;
                db.close();
                resolver(registros);
            };
            consulta.onerror = () => {
                db.close();
                rechazar(consulta.error);
            };
        };
    }));
}

/**
 * Proyecta lat/lng con el propio `js/coords.js` de la app. Si `proj4` no cargó,
 * ese módulo degrada en silencio a `{ norte: 0, este: 0 }`, así que este es el
 * punto donde se ve.
 */
async function magnaSegunLaApp(page, lat, lng) {
    return page.evaluate(async ({ lat, lng }) => {
        const coords = await import('/js/coords.js');
        return coords.toMagnaSirgas(lat, lng);
    }, { lat, lng });
}

/**
 * Extrae Norte y Este de los textos que pinta la app
 * ("N: 2.063.144 m | E: 4.856.301 m"). Si `proj4` hubiera caído, el texto sería
 * "Lat: ..., Lng: ..." y los números salen fuera de rango o NaN.
 */
function coordenadasDelTexto(texto) {
    const partes = String(texto).split('|');
    const soloDigitos = (t) => (t === undefined ? NaN : Number(String(t).replace(/[^0-9]/g, '')));
    return { norte: soloDigitos(partes[0]), este: soloDigitos(partes[1]) };
}

/** Comprueba que un par Norte/Este es del orden del millón, no un 0 disfrazado. */
function esperarMagnaCoherente(magna, contexto) {
    expect(magna.norte, `${contexto}: el Norte MAGNA de Colombia ronda los 2.000.000 m; un 0 significa proj4 caído`)
        .toBeGreaterThan(1_000_000);
    expect(magna.norte, `${contexto}: Norte fuera de rango para Colombia`).toBeLessThan(3_000_000);
    expect(magna.este, `${contexto}: el Este MAGNA de Colombia ronda los 5.000.000 m; un 0 significa proj4 caído`)
        .toBeGreaterThan(4_000_000);
    expect(magna.este, `${contexto}: Este fuera de rango para Colombia`).toBeLessThan(6_000_000);
}

/** Despliega el `<details>` que contiene una lista de chips del censo. */
async function abrirListaDeChips(page, idContenedor) {
    const detalle = page.locator(`details.censo-details:has(#${idContenedor})`);
    if (!(await detalle.evaluate((el) => el.open))) {
        await detalle.locator('summary').click();
    }
    await expect(page.locator(`#${idContenedor}`)).toBeVisible();
}

/** Marca un chip por su valor y espera a que quede seleccionado. */
async function marcarChip(page, idContenedor, valor) {
    const chip = page.locator(`#${idContenedor} .censo-chip[data-val="${valor}"]`);
    await expect(chip, `No existe el chip "${valor}" en #${idContenedor}`).toHaveCount(1);
    await chip.click();
    await expect(chip, `El chip "${valor}" debería quedar seleccionado`).toHaveClass(/\bselected\b/);
}

/** Abre el modal de marcador con el botón flotante (el punto cae en la mira). */
async function abrirModalDesdeLaMira(page) {
    await page.locator('#fab-add-placemark').click();
    const modal = page.locator('#modal-placemark');
    await expect(modal, 'El botón + debe abrir el modal de marcador').not.toHaveClass(/\bhidden\b/);
    return modal;
}

/** Crea un marcador mínimo (solo nombre) y espera a que el modal se cierre. */
async function crearMarcadorSimple(page, nombre) {
    const modal = await abrirModalDesdeLaMira(page);
    await modal.locator('#pm-name').fill(nombre);
    await modal.locator('#btn-save-placemark').click();
    await expect(modal, 'Guardar debe cerrar el modal').toHaveClass(/\bhidden\b/);
}

/** Abre el panel de Marcadores y espera a que esté desplegado. */
async function abrirPanelMarcadores(page) {
    await page.locator('#bottom-nav .nav-item[data-target="panel-placemarks"]').click();
    const panel = page.locator('#panel-placemarks');
    await expect(panel).toHaveClass(/\bopen\b/);
    return panel;
}

/** Cierra cualquier panel lateral abierto (para poder tocar el mapa). */
async function cerrarPaneles(page) {
    const abierto = page.locator('.side-panel.open');
    if (await abierto.count() > 0) {
        await abierto.first().locator('.btn-close-panel').click();
    }
    await expect(page.locator('.side-panel.open')).toHaveCount(0);
}

// ------------------------------------------------------------------ pruebas

test.describe('Ciclo completo de marcadores', () => {

    test('1. crear un marcador con censo, recargar y comprobar que vuelve íntegro de IndexedDB', async ({ page, errores }) => {
        await abrirApp(page, errores);

        // --- 1. El flujo real de campo: el + coloca el punto en la mira.
        const modal = await abrirModalDesdeLaMira(page);

        // La coordenada del formulario ya debe venir en MAGNA-SIRGAS.
        const textoModal = await modal.locator('#pm-status-magna').textContent();
        esperarMagnaCoherente(coordenadasDelTexto(textoModal), 'Coordenada del formulario');

        // --- 2. Campos básicos e icono.
        await modal.locator('#pm-name').fill(PUNTO.nombre);
        await modal.locator('#pm-desc').fill(PUNTO.descripcion);
        await modal.locator(`.icon-option[data-icon="${PUNTO.icono}"]`).click();
        await expect(modal.locator(`.icon-option[data-icon="${PUNTO.icono}"]`)).toHaveClass(/\bselected\b/);

        // --- 2b. Ficha de censo "Uso y Usuarios": el acordeón la activa.
        const cuerpoCenso = page.locator('#censo-form-body');
        await expect(cuerpoCenso, 'El censo arranca plegado').toHaveClass(/\bhidden\b/);
        await page.locator('#toggle-censo-header').click();
        await expect(cuerpoCenso, 'El acordeón debe desplegar la ficha de censo').not.toHaveClass(/\bhidden\b/);
        await expect(page.locator('#check-enable-censo'), 'Desplegar el acordeón activa el censo').toBeChecked();

        await page.locator('#censo-id-campo').fill(PUNTO.censo.idCampo);
        await page.locator('#censo-municipio').fill(PUNTO.censo.municipio);
        await page.locator('#censo-vereda').fill(PUNTO.censo.vereda);
        await page.locator('#censo-predio').fill(PUNTO.censo.predio);
        await page.locator('#censo-habitantes').fill(PUNTO.censo.habitantes);
        await page.locator('#censo-cota').fill(PUNTO.censo.cota);
        await page.locator('#censo-otros-usos').fill(PUNTO.censo.otrosUsos);

        for (const [campo, idContenedor, idBadge] of CHIPS_POR_CAMPO) {
            await abrirListaDeChips(page, idContenedor);
            for (const valor of PUNTO.censo[campo]) {
                await marcarChip(page, idContenedor, valor);
            }
            // El contador del acordeón es el único aviso visual de que hay selección.
            await expect(page.locator(`#${idBadge}`)).toHaveText(`✓ ${PUNTO.censo[campo].length} sel.`);
        }

        // --- 3. Guardar.
        const antesDeGuardar = Date.now();
        await modal.locator('#btn-save-placemark').click();
        await expect(modal, 'Guardar debe cerrar el modal').toHaveClass(/\bhidden\b/);

        // --- 4. Recargar: obliga al dato a haber pasado de verdad por IndexedDB.
        await page.reload();
        await esperarAppLista(page);

        // --- 5. El marcador está en la lista del panel y sobre el mapa.
        const panel = await abrirPanelMarcadores(page);
        const fila = panel.locator('#list-placemarks .list-item');
        await expect(fila, 'Tras recargar debe haber exactamente un marcador').toHaveCount(1);
        await expect(fila.locator('.item-title')).toHaveText(PUNTO.nombre);
        await expect(fila.locator('.item-icon'), 'La lista debe respetar el icono elegido').toHaveText('💧');
        await expect(fila.locator('.badge-sky'), 'La lista debe marcar que el punto trae censo').toHaveText('Censo');

        const textoLista = await fila.locator('.item-meta.mono').textContent();
        esperarMagnaCoherente(coordenadasDelTexto(textoLista), 'Coordenada de la lista');

        await cerrarPaneles(page);
        const marcadorMapa = page.locator('#map .custom-placemark');
        await expect(marcadorMapa, 'El marcador debe repintarse sobre el mapa tras recargar').toHaveCount(1);

        // El globo del marcador es lo que el usuario abre en campo.
        await marcadorMapa.click();
        const globo = page.locator('#map .pm-popup');
        await expect(globo.locator('h4')).toHaveText(PUNTO.nombre);
        await expect(globo.locator('.pm-popup-desc')).toHaveText(PUNTO.descripcion);
        esperarMagnaCoherente(coordenadasDelTexto(await globo.locator('.pm-popup-coords').textContent()), 'Coordenada del globo');

        // --- 6. La verdad: el registro tal cual está en IndexedDB.
        const guardados = await leerMarcadoresGuardados(page);
        expect(guardados, 'IndexedDB debe tener exactamente un marcador').toHaveLength(1);
        const registro = guardados[0];

        expect(registro.name).toBe(PUNTO.nombre);
        expect(registro.description).toBe(PUNTO.descripcion);
        expect(registro.icon).toBe(PUNTO.icono);

        // projectId: sin él las exportaciones por proyecto dejan de filtrar.
        expect(registro.projectId, 'El marcador debe guardar projectId').toBe('default_proj');

        // createdAt: sin él la lista pierde el orden y el Excel la fecha.
        expect(typeof registro.createdAt, 'createdAt debe guardarse como texto ISO').toBe('string');
        const creado = Date.parse(registro.createdAt);
        expect(Number.isNaN(creado), `createdAt no es una fecha válida: ${registro.createdAt}`).toBe(false);
        expect(creado, 'createdAt debe ser del momento del guardado').toBeGreaterThanOrEqual(antesDeGuardar - 60_000);
        expect(creado).toBeLessThanOrEqual(Date.now() + 60_000);

        // censoAgua: sin él el Excel de Uso y Usuarios sale vacío.
        expect(registro.censoAgua, 'El marcador debe guardar la ficha censoAgua').toBeTruthy();
        expect(registro.censoAgua).toEqual({
            idCampo: PUNTO.censo.idCampo,
            municipio: PUNTO.censo.municipio,
            vereda: PUNTO.censo.vereda,
            predio: PUNTO.censo.predio,
            habitantes: PUNTO.censo.habitantes,
            cota: PUNTO.censo.cota,
            fuentePrimaria: PUNTO.censo.fuentePrimaria,
            fuenteSecundaria: PUNTO.censo.fuenteSecundaria,
            fuentePecuario: PUNTO.censo.fuentePecuario,
            fuenteAgricola: PUNTO.censo.fuenteAgricola,
            otrosUsos: PUNTO.censo.otrosUsos,
            residuoLiquido: PUNTO.censo.residuoLiquido,
            residuoSolido: PUNTO.censo.residuoSolido
        });

        // Coordenadas guardadas: WGS84 en el registro, MAGNA coherente al proyectarlas.
        expect(typeof registro.lat).toBe('number');
        expect(typeof registro.lng).toBe('number');
        esperarMagnaCoherente(await magnaSegunLaApp(page, registro.lat, registro.lng), 'Coordenada guardada');

        expect(errores.resumen(), 'El ciclo de guardado no debe producir ningún error').toEqual([]);
    });

    test('2. un marcador sin censo se guarda igual y no inventa la ficha', async ({ page, errores }) => {
        await abrirApp(page, errores);

        await crearMarcadorSimple(page, 'Punto sin censo');
        await page.reload();
        await esperarAppLista(page);

        const panel = await abrirPanelMarcadores(page);
        await expect(panel.locator('#list-placemarks .list-item')).toHaveCount(1);
        await expect(panel.locator('#list-placemarks .item-title')).toHaveText('Punto sin censo');
        await expect(panel.locator('#list-placemarks .badge-sky'), 'Sin censo no debe salir la insignia').toHaveCount(0);

        const [registro] = await leerMarcadoresGuardados(page);
        expect(registro.censoAgua, 'Sin activar el acordeón, censoAgua debe quedar en null').toBeNull();
        expect(registro.projectId).toBe('default_proj');
        expect(typeof registro.createdAt).toBe('string');
        expect(Number.isNaN(Date.parse(registro.createdAt))).toBe(false);
        expect(registro.photos, 'Sin fotos, el registro guarda una lista vacía').toEqual([]);

        expect(errores.resumen()).toEqual([]);
    });

    test('3. borrar un marcador lo quita de la lista, del mapa y de IndexedDB', async ({ page, errores }) => {
        await abrirApp(page, errores);

        // El botón de borrar pregunta con confirm(): sin esto Playwright lo cancela.
        page.on('dialog', (dialogo) => dialogo.accept());

        await crearMarcadorSimple(page, 'Punto a borrar');
        await page.reload();
        await esperarAppLista(page);

        const panel = await abrirPanelMarcadores(page);
        await expect(panel.locator('#list-placemarks .list-item')).toHaveCount(1);
        expect(await leerMarcadoresGuardados(page)).toHaveLength(1);

        await panel.locator('#list-placemarks .btn-delete-pm').click();

        await expect(panel.locator('#list-placemarks .list-item'), 'La lista debe quedar vacía').toHaveCount(0);
        await expect(panel.locator('#list-placemarks .empty-state')).toHaveCount(1);
        await expect(page.locator('#map .custom-placemark'), 'El marcador debe salir del mapa').toHaveCount(0);
        expect(await leerMarcadoresGuardados(page), 'El borrado debe llegar a IndexedDB').toHaveLength(0);

        // Y sigue borrado tras recargar: no fue solo un cambio en pantalla.
        await page.reload();
        await esperarAppLista(page);
        await abrirPanelMarcadores(page);
        await expect(page.locator('#list-placemarks .list-item')).toHaveCount(0);
        expect(await leerMarcadoresGuardados(page)).toHaveLength(0);

        expect(errores.resumen()).toEqual([]);
    });

    test('4. los marcadores se filtran por projectId y no se cruzan entre proyectos', async ({ page, errores }) => {
        await abrirApp(page, errores);

        // Punto del proyecto por defecto.
        await crearMarcadorSimple(page, 'Punto del proyecto general');
        await expect(page.locator('#map .custom-placemark')).toHaveCount(1);

        // Proyecto nuevo: al crearlo queda activo.
        await page.locator('#btn-quick-projects').click();
        const modalProyectos = page.locator('#modal-projects');
        await expect(modalProyectos).not.toHaveClass(/\bhidden\b/);
        await modalProyectos.locator('#btn-show-project-form').click();
        await modalProyectos.locator('#new-project-name').fill('Obra Casanare');
        await modalProyectos.locator('#btn-save-new-project').click();
        await expect(modalProyectos, 'Al activar el proyecto nuevo el modal se cierra').toHaveClass(/\bhidden\b/);
        await expect(page.locator('#active-project-label')).toHaveText('Obra Casanare');

        // El punto del otro proyecto no debe aparecer ni en la lista ni en el mapa.
        const panel = await abrirPanelMarcadores(page);
        await expect(panel.locator('#panel-placemarks-project-name')).toHaveText('Obra Casanare');
        await expect(panel.locator('#list-placemarks .list-item'), 'El proyecto nuevo empieza sin marcadores').toHaveCount(0);
        await expect(panel.locator('#list-placemarks .empty-state')).toHaveCount(1);
        await cerrarPaneles(page);
        await expect(page.locator('#map .custom-placemark'), 'El mapa tampoco debe mostrar puntos de otro proyecto').toHaveCount(0);

        // Punto propio del proyecto nuevo.
        await crearMarcadorSimple(page, 'Punto de la obra');
        await abrirPanelMarcadores(page);
        await expect(panel.locator('#list-placemarks .list-item')).toHaveCount(1);
        await expect(panel.locator('#list-placemarks .item-title')).toHaveText('Punto de la obra');

        // El proyecto activo y su filtro sobreviven a la recarga.
        await page.reload();
        await esperarAppLista(page);
        await expect(page.locator('#active-project-label')).toHaveText('Obra Casanare');
        await abrirPanelMarcadores(page);
        await expect(page.locator('#list-placemarks .list-item')).toHaveCount(1);
        await expect(page.locator('#list-placemarks .item-title')).toHaveText('Punto de la obra');
        await cerrarPaneles(page);
        await expect(page.locator('#map .custom-placemark')).toHaveCount(1);

        // Volver al proyecto general: reaparece su punto y desaparece el de la obra.
        await page.locator('#btn-quick-projects').click();
        await expect(modalProyectos).not.toHaveClass(/\bhidden\b/);
        await modalProyectos.locator('.btn-activate-project[data-id="default_proj"]').click();
        await expect(modalProyectos).toHaveClass(/\bhidden\b/);
        await expect(page.locator('#active-project-label')).toHaveText('Proyecto General');
        await abrirPanelMarcadores(page);
        await expect(page.locator('#list-placemarks .list-item')).toHaveCount(1);
        await expect(page.locator('#list-placemarks .item-title')).toHaveText('Punto del proyecto general');
        await cerrarPaneles(page);
        await expect(page.locator('#map .custom-placemark')).toHaveCount(1);

        // En IndexedDB conviven los dos, cada uno con su projectId.
        const guardados = await leerMarcadoresGuardados(page);
        expect(guardados, 'Cambiar de proyecto no debe borrar marcadores').toHaveLength(2);
        const general = guardados.find((pm) => pm.name === 'Punto del proyecto general');
        const obra = guardados.find((pm) => pm.name === 'Punto de la obra');
        expect(general.projectId).toBe('default_proj');
        expect(obra.projectId, 'El punto creado en la obra debe llevar el id del proyecto nuevo').not.toBe('default_proj');
        expect(obra.projectId).toBeTruthy();
        expect(obra.projectId).not.toBe(general.projectId);

        expect(errores.resumen()).toEqual([]);
    });
});
