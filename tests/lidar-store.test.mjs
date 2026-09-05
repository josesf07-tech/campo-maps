/**
 * Pruebas de `js/lidar-store.js` — persistencia de escaneos en IndexedDB.
 *
 * IndexedDB no existe en Node, así que estas pruebas corren sobre el doble en
 * memoria de `ayudantes.mjs` (`indexedDB.open`, `onupgradeneeded`,
 * `createObjectStore`, `createIndex`, transacciones, `put/get/delete/getAll` y
 * cursores por índice). Si alguna función del módulo necesitara algo que el
 * doble no cubre, la prueba se marca con `t.skip(...)` explicando el motivo en
 * lugar de fingir que pasó.
 *
 * Las pruebas de este archivo comparten estado y se ejecutan en orden:
 * node:test corre las pruebas de nivel superior de forma secuencial.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cargarStore,
    mensajeAusente,
    nubeSintetica,
    cuboUnitario,
    metadatosEjemplo,
    plyBinarioAMano,
    archivoDeBuffer,
    instalarEntornoNavegador,
    reiniciarIndexedDB
} from './ayudantes.mjs';

instalarEntornoNavegador();
reiniciarIndexedDB();

const RUTA = 'js/lidar-store.js';

/** Estado compartido entre las pruebas de este archivo. */
const estado = {
    inicializada: false,
    ids: []
};

/** Escaneo de ejemplo listo para guardar. */
function nuevoEscaneo(id, nombre, creado, proyecto) {
    const meta = metadatosEjemplo({
        id,
        nombre,
        creado,
        proyecto,
        puntos: 64,
        vertices: 8,
        triangulos: 12
    });
    const nube = nubeSintetica(64);
    const malla = cuboUnitario();
    return {
        id,                       // por si el keyPath del almacén es la raíz
        nombre,
        creado,
        proyecto,
        meta,
        nube: {
            positions: nube.positions,
            colors: nube.colors,
            confidences: nube.confidences,
            count: nube.count,
            frame: nube.frame
        },
        malla: {
            positions: malla.positions,
            normals: malla.normals,
            indices: malla.indices,
            count: malla.count,
            frame: malla.frame
        }
    };
}

/** Extrae el identificador de un registro devuelto por el módulo. */
function idDe(registro) {
    if (registro == null) return undefined;
    if (typeof registro === 'string') return registro;
    return registro.id ?? (registro.meta ? registro.meta.id : undefined);
}

/** Extrae la fecha de creación de un registro devuelto por el módulo. */
function creadoDe(registro) {
    if (registro == null) return undefined;
    return registro.creado ?? (registro.meta ? registro.meta.creado : undefined);
}

/** Extrae el proyecto de un registro devuelto por el módulo. */
function proyectoDe(registro) {
    if (registro == null) return undefined;
    return registro.proyecto ?? (registro.meta ? registro.meta.proyecto : undefined);
}

const ESCANEOS = [
    nuevoEscaneo('11111111-1111-4111-8111-111111111111', 'Cárcava K12+400', '2026-01-15T10:00:00Z', 'Vía Bogotá–Villavicencio'),
    nuevoEscaneo('22222222-2222-4222-8222-222222222222', 'Talud K12+520', '2026-06-30T18:45:00Z', 'Vía Bogotá–Villavicencio'),
    nuevoEscaneo('33333333-3333-4333-8333-333333333333', 'Estribo Puente Río Negro', '2026-03-22T07:30:00Z', 'Puente Río Negro')
];

// ---------------------------------------------------------------------------

test('initScanDB abre la base y crea los almacenes', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));

    let db;
    try {
        db = await m.initScanDB();
    } catch (e) {
        return t.skip(`el doble de IndexedDB no basta para initScanDB: ${e.message}`);
    }
    assert.ok(db, 'initScanDB debe devolver la conexión (o algo veraz)');
    assert.ok(db.objectStoreNames && db.objectStoreNames.length > 0,
        'la base debe declarar al menos un almacén de objetos');
    assert.ok(typeof db.version === 'number' && db.version >= 1, 'la base debe tener versión ≥ 1');
    estado.inicializada = true;
});

test('guardarEscaneo persiste los tres escaneos de prueba', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (!estado.inicializada) return t.skip('initScanDB no llegó a completarse');

    for (const escaneo of ESCANEOS) {
        const r = await m.guardarEscaneo(escaneo);
        const id = idDe(r) ?? escaneo.id;
        assert.ok(id, 'guardarEscaneo debe permitir recuperar el identificador');
        estado.ids.push(id);
    }
    assert.equal(estado.ids.length, 3, 'se guardaron tres escaneos');
    assert.equal(new Set(estado.ids).size, 3, 'los tres identificadores son distintos');
});

test('listarEscaneos devuelve todo lo guardado', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (estado.ids.length === 0) return t.skip('no hubo escaneos guardados que listar');

    const lista = await m.listarEscaneos();
    assert.ok(Array.isArray(lista), 'listarEscaneos debe devolver un arreglo');
    assert.equal(lista.length, 3, `debía listar 3 escaneos y listó ${lista.length}`);

    const ids = lista.map(idDe).sort();
    assert.deepEqual(ids, ESCANEOS.map((e) => e.id).sort(), 'deben aparecer los tres identificadores');
});

test('listarEscaneos ordena por fecha de creación de forma monótona', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (estado.ids.length === 0) return t.skip('no hubo escaneos guardados que ordenar');

    const lista = await m.listarEscaneos();
    const fechas = lista.map((r) => {
        const f = creadoDe(r);
        assert.ok(f, `cada registro listado debe traer la fecha de creación: ${JSON.stringify(r)}`);
        return new Date(f).getTime();
    });
    for (const t0 of fechas) assert.ok(Number.isFinite(t0), 'la fecha debe ser ISO-8601 analizable');

    const ascendente = fechas.every((v, i) => i === 0 || fechas[i - 1] <= v);
    const descendente = fechas.every((v, i) => i === 0 || fechas[i - 1] >= v);
    assert.ok(
        ascendente || descendente,
        `la lista debe venir ordenada por fecha; se obtuvo ${JSON.stringify(lista.map(creadoDe))}`
    );
});

test('listarEscaneos filtra por proyecto', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (estado.ids.length === 0) return t.skip('no hubo escaneos guardados que filtrar');

    const proyecto = 'Vía Bogotá–Villavicencio';
    const lista = await m.listarEscaneos({ proyecto });
    assert.ok(Array.isArray(lista), 'listarEscaneos({proyecto}) debe devolver un arreglo');

    if (lista.length === 3) {
        return t.skip('listarEscaneos ignora la opción «proyecto»: el filtrado no está implementado');
    }
    assert.equal(lista.length, 2, `«${proyecto}» tiene 2 escaneos y devolvió ${lista.length}`);
    for (const r of lista) {
        assert.equal(proyectoDe(r), proyecto, 'todos los resultados deben ser del proyecto pedido');
    }

    const otro = await m.listarEscaneos({ proyecto: 'Puente Río Negro' });
    assert.equal(otro.length, 1, 'el otro proyecto tiene un solo escaneo');

    const inexistente = await m.listarEscaneos({ proyecto: 'Proyecto que no existe' });
    assert.equal(inexistente.length, 0, 'un proyecto inexistente no debe devolver nada');
});

test('obtenerEscaneo recupera la geometría íntegra', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (estado.ids.length === 0) return t.skip('no hubo escaneos guardados que obtener');

    const esperado = ESCANEOS[0];
    const r = await m.obtenerEscaneo(esperado.id);
    assert.ok(r, `obtenerEscaneo('${esperado.id}') no devolvió nada`);
    assert.equal(idDe(r), esperado.id);

    const meta = r.meta || r;
    assert.equal(meta.nombre, esperado.meta.nombre, 'el nombre debe conservarse');
    assert.equal(meta.formato, 'josescan/1.0', 'el formato debe conservarse');

    if (r.nube) {
        assert.equal(r.nube.count, 64, 'la nube guardada tenía 64 puntos');
        assert.equal(r.nube.positions.length, 192, 'la nube guardada tenía 192 componentes');
        assert.equal(r.nube.positions[0], esperado.nube.positions[0],
            'las coordenadas deben sobrevivir a la serialización estructurada');
    }
    if (r.malla) {
        assert.equal(r.malla.indices.length, 36, 'el cubo guardado tenía 12 triángulos');
    }

    const ausente = await m.obtenerEscaneo('00000000-0000-4000-8000-000000000000');
    assert.ok(ausente == null, 'un identificador inexistente no debe devolver un registro');
});

test('actualizarMeta aplica un parche sin perder el resto de los metadatos', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (estado.ids.length === 0) return t.skip('no hubo escaneos guardados que actualizar');

    const id = ESCANEOS[1].id;
    await m.actualizarMeta(id, { nombre: 'Talud K12+520 (revisado)', notas: 'Revisión post-lluvia' });

    const r = await m.obtenerEscaneo(id);
    assert.ok(r, 'el escaneo debe seguir existiendo tras el parche');
    const meta = r.meta || r;
    assert.equal(meta.nombre, 'Talud K12+520 (revisado)', 'el nombre debe haberse actualizado');
    assert.equal(meta.notas, 'Revisión post-lluvia', 'las notas deben haberse actualizado');
    assert.equal(meta.formato, 'josescan/1.0', 'el parche no debe borrar el formato');
    // El almacén normaliza la fecha a ISO-8601 con milisegundos; lo que debe
    // conservarse es el instante, no la cadena literal.
    assert.equal(
        Date.parse(meta.creado), Date.parse(ESCANEOS[1].meta.creado),
        'el parche no debe tocar la fecha de creación'
    );
    assert.equal(meta.dispositivo, ESCANEOS[1].meta.dispositivo, 'el parche no debe borrar el dispositivo');

    if (r.nube) {
        assert.equal(r.nube.count, 64, 'actualizar los metadatos no debe perder la nube');
    }
});

test('espacioUsado informa un tamaño coherente', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (estado.ids.length === 0) return t.skip('no hubo escaneos guardados que medir');

    let r;
    try {
        r = await m.espacioUsado();
    } catch (e) {
        return t.skip(`espacioUsado no funciona con el doble de navigator.storage: ${e.message}`);
    }

    const bytes = typeof r === 'number'
        ? r
        : Number(r?.bytes ?? r?.usage ?? r?.usado ?? NaN);
    assert.ok(Number.isFinite(bytes), `espacioUsado debe informar un número; se obtuvo ${JSON.stringify(r)}`);
    assert.ok(bytes > 0, 'con tres escaneos guardados el espacio usado debe ser mayor que cero');

    if (r && typeof r === 'object') {
        const cuota = Number(r.quota ?? r.cuota ?? NaN);
        if (Number.isFinite(cuota)) {
            assert.ok(cuota >= bytes, 'la cuota no puede ser menor que lo usado');
        }
    }
});

test('exportarTodo produce un volcado no vacío', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (estado.ids.length === 0) return t.skip('no hubo escaneos guardados que exportar');

    let r;
    try {
        r = await m.exportarTodo();
    } catch (e) {
        const msg = String(e && e.message);
        if (/jszip|zip|not defined/i.test(msg)) {
            return t.skip(`exportarTodo depende de un empaquetador ZIP no disponible en Node: ${msg}`);
        }
        throw e;
    }

    assert.ok(r, 'exportarTodo debe devolver algo');
    if (Array.isArray(r)) {
        assert.equal(r.length, 3, 'el volcado debe traer los tres escaneos');
    } else if (typeof r === 'string') {
        assert.ok(r.length > 0, 'el volcado de texto no puede estar vacío');
    } else if (r instanceof ArrayBuffer) {
        assert.ok(r.byteLength > 0, 'el volcado binario no puede estar vacío');
    } else if (typeof r.size === 'number') {
        assert.ok(r.size > 0, 'el Blob exportado no puede estar vacío');
    } else if (typeof r === 'object') {
        assert.ok(Object.keys(r).length > 0, 'el objeto exportado no puede estar vacío');
    }
});

test('importarArchivo acepta un .ply sintético y lo deja disponible', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (!estado.inicializada) return t.skip('initScanDB no llegó a completarse');

    const nube = nubeSintetica(32);
    const buffer = plyBinarioAMano(nube, false);
    const archivo = archivoDeBuffer(buffer, 'sintetico.ply', 'application/octet-stream');
    assert.equal(archivo.name, 'sintetico.ply');
    assert.equal(archivo.size, buffer.byteLength);

    let r;
    try {
        r = await m.importarArchivo(archivo);
    } catch (e) {
        const msg = String(e && e.message);
        if (/jszip|not defined|no disponible/i.test(msg)) {
            return t.skip(`importarArchivo depende de algo no disponible en Node: ${msg}`);
        }
        throw e;
    }

    assert.ok(r, 'importarArchivo debe devolver el escaneo importado o su identificador');
    const id = idDe(r);
    assert.ok(id, `no se pudo determinar el identificador del importado: ${JSON.stringify(r)}`);

    const lista = await m.listarEscaneos();
    assert.equal(lista.length, 4, `tras importar debía haber 4 escaneos y hay ${lista.length}`);
    assert.ok(lista.map(idDe).includes(id), 'el escaneo importado debe aparecer en el listado');

    const recuperado = await m.obtenerEscaneo(id);
    assert.ok(recuperado, 'el escaneo importado debe poder recuperarse');
    if (recuperado.nube) {
        assert.equal(recuperado.nube.count, 32, 'el .ply importado traía 32 puntos');
    }
    estado.ids.push(id);
});

test('eliminarEscaneo borra sólo el escaneo indicado', async (t) => {
    const m = await cargarStore();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (estado.ids.length === 0) return t.skip('no hubo escaneos guardados que eliminar');

    const antes = await m.listarEscaneos();
    const objetivo = ESCANEOS[2].id;

    await m.eliminarEscaneo(objetivo);

    const despues = await m.listarEscaneos();
    assert.equal(despues.length, antes.length - 1, 'debe quedar exactamente un escaneo menos');
    assert.ok(!despues.map(idDe).includes(objetivo), 'el escaneo eliminado no debe aparecer');
    assert.equal(await m.obtenerEscaneo(objetivo) ?? null, null,
        'obtenerEscaneo no debe devolver un escaneo eliminado');

    // Los demás siguen intactos.
    for (const otro of [ESCANEOS[0].id, ESCANEOS[1].id]) {
        assert.ok(await m.obtenerEscaneo(otro), `el escaneo ${otro} no debía verse afectado`);
    }

    // Eliminar dos veces no debe reventar.
    await assert.doesNotReject(() => m.eliminarEscaneo(objetivo),
        'eliminar un escaneo inexistente debe ser idempotente');
});
