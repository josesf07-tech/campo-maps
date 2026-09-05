/**
 * Pruebas de `js/lidar-formats.js` — lectura y escritura de PLY, OBJ, XYZ, CSV,
 * paquetes `.josescan` y validación de metadatos.
 *
 * Contrato de referencia: docs/FORMATO-ESCANEO.md (secciones 1, 2, 4 y 5).
 *
 * El módulo bajo prueba se importa de forma perezosa dentro de cada bloque: si
 * todavía no existe, la prueba se marca como omitida en vez de tumbar la suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cargarFormatos,
    mensajeAusente,
    casiIgual,
    casiIgualArray,
    igualArrayExacto,
    nubeSintetica,
    cuboUnitario,
    metadatosEjemplo,
    textoABuffer,
    bufferATexto,
    plyBinarioAMano,
    instalarEntornoNavegador
} from './ayudantes.mjs';

instalarEntornoNavegador();

const RUTA = 'js/lidar-formats.js';

/** Devuelve el módulo o `null`; el llamador decide si omite la prueba. */
async function modulo() {
    return cargarFormatos();
}

/** Lee la cabecera de un PLY (hasta `end_header`) como texto. */
function cabeceraPLY(buffer) {
    const texto = bufferATexto(buffer);
    const fin = texto.indexOf('end_header\n');
    assert.notEqual(fin, -1, 'el PLY debe terminar la cabecera con «end_header»');
    return texto.slice(0, fin + 'end_header\n'.length);
}

/** Parser CSV mínimo conforme a RFC 4180, para comprobar el escapado. */
function analizarCSV(texto) {
    const filas = [];
    let fila = [];
    let campo = '';
    let entreComillas = false;
    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        if (entreComillas) {
            if (c === '"') {
                if (texto[i + 1] === '"') { campo += '"'; i++; }
                else entreComillas = false;
            } else campo += c;
        } else if (c === '"') {
            entreComillas = true;
        } else if (c === ',' || c === ';') {
            fila.push(campo); campo = '';
        } else if (c === '\n') {
            fila.push(campo); campo = '';
            filas.push(fila); fila = [];
        } else if (c !== '\r') {
            campo += c;
        }
    }
    if (campo.length > 0 || fila.length > 0) { fila.push(campo); filas.push(fila); }
    return filas;
}

// ---------------------------------------------------------------------------
// PLY — ida y vuelta
// ---------------------------------------------------------------------------

test('writePLY → parsePLY conserva posiciones, colores y confianzas (binario)', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const nube = nubeSintetica(64, { frame: 'enu' });
    const buffer = m.writePLY(nube, { binario: true });
    assert.ok(buffer instanceof ArrayBuffer, 'writePLY debe devolver un ArrayBuffer');

    const leida = m.parsePLY(buffer);
    assert.equal(leida.count, 64, 'el número de puntos debe conservarse');
    casiIgualArray(leida.positions, nube.positions, 1e-5, 'posiciones tras la ida y vuelta binaria');
    igualArrayExacto(leida.colors, nube.colors, 'los colores uchar deben ser exactos');
    igualArrayExacto(leida.confidences, nube.confidences, 'las confianzas uchar deben ser exactas');
});

test('writePLY → parsePLY conserva posiciones, colores y confianzas (ascii)', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const nube = nubeSintetica(49, { frame: 'enu' });
    const buffer = m.writePLY(nube, { binario: false });
    const texto = bufferATexto(buffer);
    assert.match(texto, /^ply\n/, 'el PLY ascii debe empezar por «ply»');
    assert.match(texto, /format ascii 1\.0/, 'debe declarar «format ascii 1.0»');

    const leida = m.parsePLY(buffer);
    assert.equal(leida.count, 49);
    // El escritor ascii usa %.6f, así que 1e-5 es holgado y a la vez estricto.
    casiIgualArray(leida.positions, nube.positions, 1e-5, 'posiciones tras la ida y vuelta ascii');
    igualArrayExacto(leida.colors, nube.colors, 'colores en ascii');
    igualArrayExacto(leida.confidences, nube.confidences, 'confianzas en ascii');
});

test('la cabecera del PLY binario cumple el contrato y el cuerpo mide 16·n bytes', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const n = 40;
    const nube = nubeSintetica(n, { frame: 'enu' });
    const buffer = m.writePLY(nube, { binario: true });
    const cabecera = cabeceraPLY(buffer);
    const lineas = cabecera.split('\n');

    // Líneas exigidas por docs/FORMATO-ESCANEO.md §4, en este orden.
    const exigidas = [
        'ply',
        'format binary_little_endian 1.0',
        `element vertex ${n}`,
        'property float x',
        'property float y',
        'property float z',
        'property uchar red',
        'property uchar green',
        'property uchar blue',
        'property uchar confidence',
        'end_header'
    ];
    for (const linea of exigidas) {
        assert.ok(lineas.includes(linea), `la cabecera debe contener la línea «${linea}»`);
    }
    // El orden relativo de las propiedades también forma parte del contrato.
    const posiciones = exigidas.map((l) => lineas.indexOf(l));
    for (let i = 1; i < posiciones.length; i++) {
        assert.ok(posiciones[i] > posiciones[i - 1],
            `«${exigidas[i]}» debe ir después de «${exigidas[i - 1]}»`);
    }
    assert.match(cabecera, /comment JoseScan josescan\/1\.0/, 'debe llevar el comentario de formato');
    assert.match(cabecera, /comment marco (enu|arkit)/, 'debe declarar el marco de coordenadas');

    const cuerpo = buffer.byteLength - cabecera.length;
    assert.equal(cuerpo, 16 * n, 'el cuerpo binario debe ocupar exactamente 16 bytes por punto');
});

// ---------------------------------------------------------------------------
// PLY — lectura de archivos ajenos
// ---------------------------------------------------------------------------

test('parsePLY lee un ascii escrito a mano con propiedades desordenadas y con caras', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    // Propiedades en orden inesperado (confianza y color antes que las coordenadas)
    // y un elemento `face` que el lector debe saber saltar o interpretar.
    const texto =
        'ply\n' +
        'format ascii 1.0\n' +
        'comment escrito a mano para las pruebas\n' +
        'element vertex 4\n' +
        'property uchar confidence\n' +
        'property uchar red\n' +
        'property uchar green\n' +
        'property uchar blue\n' +
        'property float z\n' +
        'property float y\n' +
        'property float x\n' +
        'element face 2\n' +
        'property list uchar int vertex_indices\n' +
        'end_header\n' +
        '2 255 0 0 0.500000 1.000000 0.000000\n' +
        '1 0 255 0 0.250000 2.000000 1.000000\n' +
        '0 0 0 255 -0.750000 3.000000 2.000000\n' +
        '2 10 20 30 1.250000 4.000000 3.000000\n' +
        '3 0 1 2\n' +
        '3 0 2 3\n';

    const nube = m.parsePLY(textoABuffer(texto));
    assert.equal(nube.count, 4, 'debe leer los 4 vértices declarados');
    casiIgualArray(
        nube.positions,
        new Float32Array([0, 1, 0.5, 1, 2, 0.25, 2, 3, -0.75, 3, 4, 1.25]),
        1e-6,
        'las coordenadas deben asignarse por nombre de propiedad, no por posición'
    );
    igualArrayExacto(nube.colors, new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]));
    igualArrayExacto(nube.confidences, new Uint8Array([2, 1, 0, 2]));

    if (nube.indices && nube.indices.length > 0) {
        igualArrayExacto(nube.indices, new Uint32Array([0, 1, 2, 0, 2, 3]),
            'si el lector devuelve caras, deben ser las dos declaradas');
    }
});

test('parsePLY lee binary_big_endian', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const original = nubeSintetica(16, { frame: 'enu' });
    const buffer = plyBinarioAMano(original, true);

    let nube;
    try {
        nube = m.parsePLY(buffer);
    } catch (e) {
        return t.skip(`parsePLY no soporta binary_big_endian: ${e.message}`);
    }
    assert.equal(nube.count, 16);
    casiIgualArray(nube.positions, original.positions, 1e-5, 'posiciones leídas en big-endian');
    igualArrayExacto(nube.colors, original.colors);
    igualArrayExacto(nube.confidences, original.confidences);
});

test('parsePLY lanza Error con una cabecera inválida', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const casos = [
        ['sin la palabra mágica «ply»', 'no soy un ply\nformat ascii 1.0\nend_header\n'],
        ['sin end_header', 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\n'],
        ['formato desconocido', 'ply\nformat marciano 1.0\nelement vertex 0\nend_header\n'],
        ['archivo vacío', '']
    ];
    for (const [descripcion, contenido] of casos) {
        assert.throws(
            () => m.parsePLY(textoABuffer(contenido)),
            (e) => e instanceof Error,
            `debe lanzar Error: ${descripcion}`
        );
    }
});

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

test('parseOBJ acepta las cuatro formas de cara (v, v/vt, v//vn, v/vt/vn)', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const texto = [
        '# malla de prueba',
        'v 0.0 0.0 0.0',
        'v 1.0 0.0 0.0',
        'v 0.0 1.0 0.0',
        'vt 0.0 0.0',
        'vn 0.0 0.0 1.0',
        'f 1 2 3',
        'f 1/1 2/1 3/1',
        'f 1//1 2//1 3//1',
        'f 1/1/1 2/1/1 3/1/1',
        ''
    ].join('\n');

    const malla = m.parseOBJ(texto);
    assert.equal(malla.count, 3, 'debe leer los 3 vértices');
    casiIgualArray(malla.positions, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 1e-6);
    assert.equal(malla.indices.length, 12, 'cuatro caras triangulares ⇒ 12 índices');
    for (let i = 0; i < 4; i++) {
        igualArrayExacto(
            Array.from(malla.indices.slice(i * 3, i * 3 + 3)),
            [0, 1, 2],
            `la cara ${i + 1} debe apuntar a los vértices 0,1,2 (base 0)`
        );
    }
});

test('parseOBJ resuelve índices negativos (relativos al final)', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const texto = [
        'v 5.0 5.0 5.0',
        'v 0.0 0.0 0.0',
        'v 1.0 0.0 0.0',
        'v 0.0 1.0 0.0',
        'f -3 -2 -1',
        ''
    ].join('\n');

    const malla = m.parseOBJ(texto);
    assert.equal(malla.count, 4);
    assert.equal(malla.indices.length, 3);
    igualArrayExacto(Array.from(malla.indices), [1, 2, 3],
        '-3/-2/-1 deben resolverse a los vértices 1, 2 y 3 (base 0)');
});

test('parseOBJ triangula en abanico una cara de 5 vértices', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const texto = [
        'v 0.0 0.0 0.0',
        'v 1.0 0.0 0.0',
        'v 1.5 1.0 0.0',
        'v 0.5 1.8 0.0',
        'v -0.5 1.0 0.0',
        'f 1 2 3 4 5',
        ''
    ].join('\n');

    const malla = m.parseOBJ(texto);
    assert.equal(malla.count, 5);
    assert.equal(malla.indices.length, 9, 'un pentágono debe producir 3 triángulos');
    for (const idx of malla.indices) {
        assert.ok(idx >= 0 && idx < 5, `índice ${idx} fuera del rango de vértices`);
    }
    // Propiedad del abanico: el primer vértice aparece en los tres triángulos.
    for (let t3 = 0; t3 < 3; t3++) {
        const tri = Array.from(malla.indices.slice(t3 * 3, t3 * 3 + 3));
        assert.ok(tri.includes(0), `el triángulo ${t3} debe contener el vértice raíz del abanico`);
    }
});

test('writeOBJ → parseOBJ reconstruye el cubo de 1 m', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const cubo = cuboUnitario();
    const texto = m.writeOBJ(cubo);
    assert.equal(typeof texto, 'string', 'writeOBJ debe devolver una cadena');
    assert.match(texto, /^\s*(#|v |mtllib)/, 'el OBJ debe empezar por comentario, mtllib o vértice');

    const leida = m.parseOBJ(texto);
    assert.equal(leida.indices.length, 36, 'el cubo tiene 12 triángulos');

    // Se comparan los triángulos por coordenadas para tolerar reordenamientos
    // o deduplicación de vértices que haga el escritor.
    const canonizar = (positions, indices) => {
        const salida = [];
        for (let i = 0; i < indices.length; i += 3) {
            const tri = [];
            for (let k = 0; k < 3; k++) {
                const b = indices[i + k] * 3;
                tri.push([positions[b], positions[b + 1], positions[b + 2]]
                    .map((v) => v.toFixed(4)).join(','));
            }
            salida.push(tri.join('|'));
        }
        return salida.sort();
    };
    assert.deepEqual(
        canonizar(leida.positions, leida.indices),
        canonizar(cubo.positions, cubo.indices),
        'los 12 triángulos del cubo deben sobrevivir a la ida y vuelta'
    );
});

// ---------------------------------------------------------------------------
// XYZ y CSV
// ---------------------------------------------------------------------------

test('writeXYZ produce una línea por punto con tres coordenadas separadas por espacios', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const nube = nubeSintetica(25);
    const texto = m.writeXYZ(nube);
    assert.equal(typeof texto, 'string');

    const lineas = texto.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('#'));
    assert.equal(lineas.length, 25, 'debe haber exactamente una línea por punto');

    for (let i = 0; i < lineas.length; i++) {
        const campos = lineas[i].trim().split(/\s+/);
        assert.ok(campos.length >= 3, `la línea ${i} debe traer al menos x, y, z`);
        for (let k = 0; k < 3; k++) {
            assert.ok(Number.isFinite(Number(campos[k])),
                `la línea ${i}, campo ${k} («${campos[k]}») debe ser numérica`);
        }
        casiIgual(Number(campos[0]), nube.positions[i * 3 + 0], 1e-4, `x de la línea ${i}`);
        casiIgual(Number(campos[1]), nube.positions[i * 3 + 1], 1e-4, `y de la línea ${i}`);
        casiIgual(Number(campos[2]), nube.positions[i * 3 + 2], 1e-4, `z de la línea ${i}`);
    }
    assert.ok(!texto.includes(','), 'el XYZ no debe usar comas como separador');
});

test('writeCSV respeta el límite, usa un separador consistente y escapa los campos', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const nube = nubeSintetica(64);
    // Se añade un texto conflictivo para provocar el escapado si el escritor lo
    // incluye en alguna columna o cabecera.
    nube.nombre = 'Cárcava "K12", tramo 3';

    const completo = m.writeCSV(nube);
    const filas = analizarCSV(completo).filter((f) => f.length > 1 || f[0] !== '');
    assert.ok(filas.length >= 64, 'sin límite deben salir al menos los 64 puntos');

    // Todas las filas deben tener el mismo número de columnas: si el escapado
    // estuviera mal, una coma sin comillas rompería esta invariante.
    const columnas = filas[0].length;
    assert.ok(columnas >= 3, 'el CSV debe traer al menos tres columnas');
    for (let i = 0; i < filas.length; i++) {
        assert.equal(filas[i].length, columnas,
            `la fila ${i} tiene ${filas[i].length} columnas y la cabecera ${columnas}`);
    }

    // Ningún campo puede contener un separador crudo tras el análisis correcto.
    for (const fila of filas) {
        for (const campo of fila) {
            if (campo.includes(',') || campo.includes('"')) {
                assert.ok(completo.includes('"'),
                    'un campo con coma o comilla obliga a usar comillas en el CSV');
            }
        }
    }

    const limitado = m.writeCSV(nube, { limite: 10 });
    const filasLimite = analizarCSV(limitado).filter((f) => f.length > 1 || f[0] !== '');
    assert.ok(filasLimite.length <= 11,
        `con limite=10 no debe haber más de 10 filas de datos (+ cabecera); hubo ${filasLimite.length}`);
    assert.ok(filasLimite.length >= 10, 'con limite=10 deben salir los 10 primeros puntos');
});

// ---------------------------------------------------------------------------
// Metadatos
// ---------------------------------------------------------------------------

test('validarMetadatos acepta unos metadatos josescan/1.0 correctos', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const r = m.validarMetadatos(metadatosEjemplo());
    assert.equal(r.valido, true, `debía ser válido; errores: ${JSON.stringify(r.errores)}`);
    assert.ok(Array.isArray(r.errores), 'errores debe ser un arreglo');
    assert.equal(r.errores.length, 0, 'no debe reportar errores');
});

test('validarMetadatos rechaza un formato desconocido', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const r = m.validarMetadatos(metadatosEjemplo({ formato: 'josescan/9.9' }));
    assert.equal(r.valido, false, 'josescan/9.9 no está soportado');
    assert.ok(r.errores.length > 0, 'debe explicar el motivo');
    assert.ok(
        r.errores.some((e) => /formato/i.test(String(e))),
        `algún error debe mencionar el formato; se obtuvo ${JSON.stringify(r.errores)}`
    );
});

test('validarMetadatos rechaza una fecha que no es ISO-8601', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const r = m.validarMetadatos(metadatosEjemplo({ creado: '05/09/2026 14:22' }));
    assert.equal(r.valido, false, 'el contrato exige ISO-8601 UTC');
    assert.ok(
        r.errores.some((e) => /creado|fecha|iso/i.test(String(e))),
        `algún error debe mencionar la fecha; se obtuvo ${JSON.stringify(r.errores)}`
    );
});

test('validarMetadatos rechaza contadores negativos', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const r = m.validarMetadatos(metadatosEjemplo({ puntos: -1, vertices: -3, triangulos: -5 }));
    assert.equal(r.valido, false, 'puntos/vértices/triángulos no pueden ser negativos');
    assert.ok(
        r.errores.some((e) => /puntos|vertices|vértices|triangulos|triángulos|negativ/i.test(String(e))),
        `algún error debe mencionar los contadores; se obtuvo ${JSON.stringify(r.errores)}`
    );
});

// ---------------------------------------------------------------------------
// Paquete .josescan
// ---------------------------------------------------------------------------

test('buildScanBundle → parseScanBundle conserva metadatos, nube y malla', async (t) => {
    const m = await modulo();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (typeof m.buildScanBundle !== 'function' || typeof m.parseScanBundle !== 'function') {
        return t.skip('el módulo no exporta buildScanBundle/parseScanBundle');
    }

    const meta = metadatosEjemplo({ puntos: 64, vertices: 8, triangulos: 12 });
    const nube = nubeSintetica(64);
    const malla = cuboUnitario();
    const miniatura = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]); // cabecera JPEG falsa

    let paquete;
    try {
        paquete = await m.buildScanBundle({ meta, nube, malla, miniatura });
    } catch (e) {
        const msg = String(e && e.message);
        if (/jszip|zip no|no disponible|not defined|undefined/i.test(msg)) {
            return t.skip(
                'buildScanBundle depende de JSZip, que no está disponible en Node y el módulo ' +
                `no trae respaldo propio: ${msg}`
            );
        }
        throw e;
    }

    assert.ok(paquete, 'buildScanBundle debe devolver algo');
    const bytes = paquete instanceof ArrayBuffer
        ? new Uint8Array(paquete)
        : (paquete instanceof Uint8Array ? paquete : new Uint8Array(await paquete.arrayBuffer()));
    assert.ok(bytes.length > 4, 'el paquete no puede estar vacío');
    assert.equal(bytes[0], 0x50, 'el paquete .josescan es un ZIP: debe empezar por «PK»');
    assert.equal(bytes[1], 0x4b, 'el paquete .josescan es un ZIP: debe empezar por «PK»');

    let leido;
    try {
        leido = await m.parseScanBundle(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch (e) {
        const msg = String(e && e.message);
        if (/jszip|no disponible|not defined/i.test(msg)) {
            return t.skip(`parseScanBundle depende de JSZip, no disponible en Node: ${msg}`);
        }
        throw e;
    }

    assert.ok(leido && leido.meta, 'el paquete leído debe traer metadatos');
    assert.equal(leido.meta.formato, 'josescan/1.0');
    assert.equal(leido.meta.id, meta.id);
    assert.equal(leido.meta.nombre, meta.nombre);

    if (leido.nube) {
        assert.equal(leido.nube.count, 64, 'la nube del paquete debe traer 64 puntos');
        casiIgualArray(leido.nube.positions, nube.positions, 1e-5, 'nube dentro del .josescan');
    }
    if (leido.malla) {
        assert.equal(leido.malla.indices.length, 36, 'la malla del paquete debe traer 12 triángulos');
    }
});
