/**
 * Pruebas de js/calibration.js — MapCalibrator (georreferenciación de GeoPDF).
 *
 * AVISO DE ALCANCE (verificado en el código, no supuesto):
 * `calibrate()` resuelve por mínimos cuadrados una matriz afín {A..F} y la
 * guarda en `this.matrix`, pero ESA MATRIZ NO SE USA PARA POSICIONAR EL PLANO:
 *   - `pixelToLatLng()` ignora por completo (x, y) y devuelve siempre la esquina
 *     mínima (SO) de los puntos de control. No consulta `this.matrix`.
 *   - `getImageBounds()` extrapola linealmente usando SÓLO los dos primeros
 *     puntos de control, y es lo único que consume app.js (línea ~1790).
 * El motivo de fondo es que L.ImageOverlay de Leaflet no admite rotación.
 *
 * Por eso las pruebas están separadas en tres bloques:
 *   1. `calibrate()` como RESOLUTOR DE MÍNIMOS CUADRADOS (no como posicionador).
 *   2. `pixelToLatLng()` y `getImageBounds()` contra su comportamiento REAL.
 *   3. Extracción de metadatos GeoPDF (parseGeoMetadataString), que sí es
 *      la vía por la que un plano georreferenciado se coloca de verdad.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/browser-env.mjs';
import { MapCalibrator } from '../js/calibration.js';
import { toMagnaSirgas } from '../js/coords.js';

const rad = (d) => d * Math.PI / 180;

// Escala aproximada para convertir errores en grados a metros (Colombia, ~4,6°N)
const M_POR_GRADO_LAT = 110574;
const M_POR_GRADO_LNG = 111320 * Math.cos(rad(4.6));
const enMetros = (a, b) => Math.hypot(
    (a.lat - b.lat) * M_POR_GRADO_LAT,
    (a.lng - b.lng) * M_POR_GRADO_LNG
);

// Plano sintético: render de 4000 × 3000 px que cubre 2.000 m × 1.500 m.
const W = 4000, H = 3000;
const LAT0 = 4.6, LNG0 = -73.4;

/** Transformación afín verdadera del plano, con rotación opcional en grados. */
function planoVerdadero(rotGrados = 0) {
    const th = rad(rotGrados);
    const sx = 2000 / W, sy = 1500 / H;     // metros por píxel
    return (x, y) => {
        const ex = x * sx, ny = -y * sy;    // la Y de imagen crece hacia abajo
        const e = ex * Math.cos(th) - ny * Math.sin(th);
        const n = ex * Math.sin(th) + ny * Math.cos(th);
        return { lat: LAT0 + n / M_POR_GRADO_LAT, lng: LNG0 + e / M_POR_GRADO_LNG };
    };
}

/** Crea un calibrador con los puntos de control indicados (en píxeles). */
function calibradorCon(pixeles, rotGrados = 0) {
    const f = planoVerdadero(rotGrados);
    const c = new MapCalibrator();
    c.imageSize = { width: W, height: H };
    for (const [x, y] of pixeles) {
        const g = f(x, y);
        c.addControlPoint(x, y, g.lat, g.lng);
    }
    return c;
}

describe('calibration.js — puntos de control', () => {
    test('addControlPoint guarda px, py, lat y lng', () => {
        const c = new MapCalibrator();
        c.addControlPoint(120, 340, 4.6, -73.4);
        assert.equal(c.controlPoints.length, 1);
        assert.deepEqual(c.controlPoints[0], { px: 120, py: 340, lat: 4.6, lng: -73.4 });
    });

    test('removeControlPoint elimina por índice', () => {
        const c = new MapCalibrator();
        c.addControlPoint(0, 0, 4.6, -73.4);
        c.addControlPoint(100, 100, 4.7, -73.3);
        c.removeControlPoint(0);
        assert.equal(c.controlPoints.length, 1);
        assert.equal(c.controlPoints[0].px, 100);
    });

    test('removeControlPoint ignora índices fuera de rango', () => {
        const c = new MapCalibrator();
        c.addControlPoint(0, 0, 4.6, -73.4);
        c.removeControlPoint(-1);
        c.removeControlPoint(99);
        assert.equal(c.controlPoints.length, 1);
    });

    test('un calibrador recién creado no tiene matriz', () => {
        const c = new MapCalibrator();
        assert.equal(c.matrix, null);
        assert.equal(c.pixelToLatLng(10, 10), null, 'sin matriz devuelve null');
    });
});

describe('calibration.js — calibrate() como resolutor de mínimos cuadrados', () => {
    // Nota: estas pruebas validan EL CÁLCULO de la matriz afín, no el
    // posicionamiento del plano (que no pasa por la matriz; ver cabecera).

    test('con menos de 3 puntos de control lanza un error explícito', () => {
        for (const n of [0, 1, 2]) {
            const c = calibradorCon([[0, 0], [W, H]].slice(0, n));
            assert.throws(
                () => c.calibrate(),
                /Se requieren al menos 3 puntos de control/,
                `con ${n} puntos debería lanzar`
            );
        }
    });

    test('la convención real es lng = A + B·x + C·y y lat = D + E·x + F·y', () => {
        // OJO: el comentario del código fuente dice "lon = A*x + B*y + C", que
        // NO es lo que resuelve el sistema. A y D son los términos independientes.
        const c = calibradorCon([[0, 0], [W, H], [W, 0], [0, H]]);
        const m = c.calibrate();
        const f = planoVerdadero(0);
        const esperado0 = f(0, 0);
        assert.ok(Math.abs(m.A - esperado0.lng) < 1e-12, 'A es el lng en el píxel (0,0)');
        assert.ok(Math.abs(m.D - esperado0.lat) < 1e-12, 'D es la lat en el píxel (0,0)');
    });

    test('recupera exactamente una transformación afín conocida (sin rotación)', () => {
        const c = calibradorCon([[0, 0], [W, H], [W, 0], [0, H]]);
        const m = c.calibrate();
        const f = planoVerdadero(0);
        for (const [x, y] of [[0, 0], [W, H], [W / 2, H / 2], [1234, 567], [W, 0]]) {
            const lng = m.A + m.B * x + m.C * y;
            const lat = m.D + m.E * x + m.F * y;
            const err = enMetros({ lat, lng }, f(x, y));
            assert.ok(err < 0.001, `error de ${err.toFixed(4)} m en el píxel (${x},${y})`);
        }
    });

    test('recupera exactamente una transformación afín ROTADA 5°', () => {
        // La matriz afín sí sabe representar rotación; el problema es que nadie
        // la usa para colocar el plano.
        const c = calibradorCon([[0, 0], [W, H], [W, 0], [0, H]], 5);
        const m = c.calibrate();
        const f = planoVerdadero(5);
        for (const [x, y] of [[0, 0], [W / 2, H / 2], [3999, 2999]]) {
            const lng = m.A + m.B * x + m.C * y;
            const lat = m.D + m.E * x + m.F * y;
            const err = enMetros({ lat, lng }, f(x, y));
            assert.ok(err < 0.001, `error de ${err.toFixed(4)} m en el píxel (${x},${y})`);
        }
    });

    test('con más puntos de los necesarios sigue ajustando bien (mínimos cuadrados)', () => {
        const c = calibradorCon([[0, 0], [W, 0], [0, H], [W, H], [1000, 900], [2500, 2100]]);
        const m = c.calibrate();
        const f = planoVerdadero(0);
        const err = enMetros(
            { lat: m.D + m.E * 2000 + m.F * 1500, lng: m.A + m.B * 2000 + m.C * 1500 },
            f(2000, 1500)
        );
        assert.ok(err < 0.001, `error de ${err.toFixed(4)} m`);
    });

    test('todos los coeficientes de la matriz son finitos, nunca NaN', () => {
        const c = calibradorCon([[0, 0], [W, H], [W, 0]]);
        const m = c.calibrate();
        for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
            assert.ok(Number.isFinite(m[k]), `el coeficiente ${k} es ${m[k]}`);
        }
    });

    test('calibrate() guarda la matriz en this.matrix y la devuelve', () => {
        const c = calibradorCon([[0, 0], [W, H], [W, 0]]);
        const m = c.calibrate();
        assert.equal(c.matrix, m);
    });

    test('puntos colineales con píxeles enteros lanzan error de sistema singular', () => {
        const c = new MapCalibrator();
        // Tres clics sobre la misma diagonal del plano.
        for (const [x, y] of [[0, 0], [100, 100], [200, 200]]) {
            c.addControlPoint(x, y, LAT0 + y * 1e-6, LNG0 + x * 1e-6);
        }
        assert.throws(() => c.calibrate(), /colineales o sistema singular/);
    });

    test('puntos colineales en la misma fila lanzan error', () => {
        const c = new MapCalibrator();
        for (const x of [0, 2000, 4000]) {
            c.addControlPoint(x, 500, LAT0, LNG0 + x * 1e-6);
        }
        assert.throws(() => c.calibrate(), /colineales o sistema singular/);
    });

    test('puntos colineales en la misma columna lanzan error', () => {
        const c = new MapCalibrator();
        for (const y of [0, 1500, 3000]) {
            c.addControlPoint(300, y, LAT0 + y * 1e-6, LNG0);
        }
        assert.throws(() => c.calibrate(), /colineales o sistema singular/);
    });

    test(
        'puntos colineales con píxeles NO enteros también deberían lanzar error',
        { todo: 'BUG: el umbral |det| < 1e-10 es absoluto. Con coordenadas de píxel ' +
                'decimales el determinante de tres puntos exactamente colineales vale ' +
                '~-0,04 (ruido de punto flotante amplificado por sumas de x², y², xy de ' +
                'orden 1e7), así que la guarda no salta y calibrate() devuelve ' +
                'coeficientes inestables sin avisar. El arreglo (normalizar el ' +
                'determinante respecto a la escala de los datos) es una decisión de ' +
                'diseño: no se toca desde las pruebas.' },
        () => {
            const c = new MapCalibrator();
            const m = 0.7405, b = 0.2;
            for (const x of [0.1, 2048.7, 4000.3]) {
                const y = b + m * x;
                c.addControlPoint(x, y, LAT0 + y * 1e-6, LNG0 + x * 1e-6);
            }
            assert.throws(() => c.calibrate(), /colineales o sistema singular/);
        }
    );

    test('puntos casi colineales (1 px de desviación) no producen NaN', () => {
        const c = new MapCalibrator();
        const pts = [[0, 0], [2000, 1481], [4000, 2962]];
        pts.forEach(([x, y], i) => {
            const yy = y + (i === 1 ? 1 : 0);
            c.addControlPoint(x, yy, LAT0 + yy * 1e-6, LNG0 + x * 1e-6);
        });
        const m = c.calibrate();
        for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
            assert.ok(Number.isFinite(m[k]), `${k} = ${m[k]} no es finito`);
        }
    });
});

describe('calibration.js — pixelToLatLng (comportamiento real)', () => {
    // IMPORTANTE: pixelToLatLng NO usa la matriz afín. Sólo comprueba que exista
    // y devuelve la esquina SO (mínimo lat, mínimo lng) de los puntos de control,
    // sea cual sea el píxel consultado. Por eso el plano no se puede rotar.

    test('devuelve null si todavía no se ha calibrado', () => {
        const c = calibradorCon([[0, 0], [W, H], [W, 0]]);
        assert.equal(c.pixelToLatLng(100, 100), null);
    });

    test('devuelve la esquina SO de los puntos de control, ignorando el píxel', () => {
        const c = calibradorCon([[0, 0], [W, H], [W, 0], [0, H]]);
        c.calibrate();
        const lats = c.controlPoints.map(p => p.lat);
        const lngs = c.controlPoints.map(p => p.lng);
        const so = { lat: Math.min(...lats), lng: Math.min(...lngs) };
        assert.deepEqual(c.pixelToLatLng(0, 0), so);
        assert.deepEqual(c.pixelToLatLng(W, H), so);
        assert.deepEqual(c.pixelToLatLng(W / 2, H / 2), so);
    });

    test('píxeles distintos dan siempre el MISMO resultado (transformación degenerada)', () => {
        const c = calibradorCon([[0, 0], [W, H], [W, 0], [0, H]]);
        c.calibrate();
        const a = c.pixelToLatLng(10, 10);
        const b = c.pixelToLatLng(3990, 2990);
        assert.deepEqual(a, b,
            'hoy no distingue píxeles: la transformación píxel->geo no es inyectiva');
    });

    test('al menos devuelve coordenadas finitas dentro del plano, no NaN', () => {
        const c = calibradorCon([[0, 0], [W, H], [W, 0], [0, H]]);
        c.calibrate();
        const r = c.pixelToLatLng(1234, 567);
        assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lng));
    });

    test(
        'ida y vuelta píxel -> geo -> píxel debería ser consistente',
        { todo: 'BUG: pixelToLatLng() ignora (x, y) y devuelve la esquina SO de los ' +
                'puntos de control, así que no hay ida y vuelta posible. En un plano ' +
                'de 2.000 × 1.500 m el error en el centro es de ~1.250 m (media ' +
                'diagonal). El método NO se usa en producción (app.js sólo llama a ' +
                'calibrate() y getImageBounds()), por eso no se arregla desde las ' +
                'pruebas: implementar la inversa de la afín es una decisión de diseño.' },
        () => {
            const c = calibradorCon([[0, 0], [W, H], [W, 0], [0, H]]);
            c.calibrate();
            const f = planoVerdadero(0);
            for (const [x, y] of [[0, 0], [W / 2, H / 2], [W, H]]) {
                const err = enMetros(c.pixelToLatLng(x, y), f(x, y));
                assert.ok(err < 1, `error de ${err.toFixed(1)} m en el píxel (${x},${y})`);
            }
        }
    );
});

describe('calibration.js — getImageBounds (lo que sí usa app.js)', () => {
    test('devuelve null con menos de 2 puntos de control', () => {
        const c = calibradorCon([[0, 0]]);
        assert.equal(c.getImageBounds(), null);
        assert.equal(new MapCalibrator().getImageBounds(), null);
    });

    test('devuelve [[SO], [NE]] con las latitudes y longitudes bien ordenadas', () => {
        const c = calibradorCon([[0, 0], [W, H]]);
        const b = c.getImageBounds();
        assert.equal(b.length, 2);
        assert.ok(b[0][0] <= b[1][0], 'la latitud SO no puede superar a la NE');
        assert.ok(b[0][1] <= b[1][1], 'la longitud SO no puede superar a la NE');
        b.flat().forEach(v => assert.ok(Number.isFinite(v), `valor no finito: ${v}`));
    });

    test('con los dos primeros puntos en esquinas opuestas los bounds son exactos', () => {
        const c = calibradorCon([[0, 0], [W, H], [W, 0]]);
        const b = c.getImageBounds();
        const f = planoVerdadero(0);
        const esquinas = [f(0, 0), f(W, 0), f(0, H), f(W, H)];
        const so = {
            lat: Math.min(...esquinas.map(p => p.lat)),
            lng: Math.min(...esquinas.map(p => p.lng))
        };
        const ne = {
            lat: Math.max(...esquinas.map(p => p.lat)),
            lng: Math.max(...esquinas.map(p => p.lng))
        };
        assert.ok(enMetros({ lat: b[0][0], lng: b[0][1] }, so) < 0.01);
        assert.ok(enMetros({ lat: b[1][0], lng: b[1][1] }, ne) < 0.01);
    });

    test('acepta un ancho y alto explícitos (app.js pasa el tamaño natural del <img>)', () => {
        const c = calibradorCon([[0, 0], [W, H]]);
        const completo = c.getImageBounds(W, H);
        const mitad = c.getImageBounds(W / 2, H / 2);
        const altoCompleto = completo[1][0] - completo[0][0];
        const altoMitad = mitad[1][0] - mitad[0][0];
        assert.ok(Math.abs(altoMitad / altoCompleto - 0.5) < 1e-9,
            'la mitad del alto debe cubrir la mitad del rango de latitud');
    });

    test('usa SÓLO los dos primeros puntos de control: los demás no cambian nada', () => {
        const base = calibradorCon([[0, 0], [W, H]]);
        const conExtras = calibradorCon([[0, 0], [W, H], [1234, 567], [3000, 2500]]);
        assert.deepEqual(conExtras.getImageBounds(), base.getImageBounds());
    });

    test(
        'los dos primeros puntos en la MISMA fila no deberían aplastar la latitud',
        { todo: 'BUG con impacto real en campo: getImageBounds() sólo usa los dos ' +
                'primeros puntos de control y protege la división con `|| 1`. Si el ' +
                'usuario marca primero las dos esquinas SUPERIORES del plano (px ' +
                'distintos, py idéntico), la escala de latitud sale 0 y los bounds ' +
                'quedan como una franja de altura cero: el plano se coloca con la ' +
                'esquina SO desplazada 1.500 m (todo el alto del plano) en el ejemplo ' +
                'de 2.000 × 1.500 m. Simétricamente, dos puntos en la misma columna ' +
                'desplazan la esquina NE 2.000 m. Arreglarlo (usar min/max de todos ' +
                'los puntos, o la matriz afín) es una decisión del dueño del repo.' },
        () => {
            const c = calibradorCon([[0, 0], [W, 0], [0, H]]);
            const b = c.getImageBounds();
            const f = planoVerdadero(0);
            const so = { lat: f(0, H).lat, lng: f(0, 0).lng };
            const err = enMetros({ lat: b[0][0], lng: b[0][1] }, so);
            assert.ok(err < 1, `la esquina SO está a ${err.toFixed(0)} m de su sitio`);
        }
    );

    test(
        'un plano rotado debería colocarse sin error apreciable',
        { todo: 'LIMITACIÓN DE DISEÑO conocida: L.ImageOverlay de Leaflet no admite ' +
                'rotación, así que getImageBounds() sólo puede devolver un rectángulo ' +
                'norte-arriba. Con 2° de rotación las esquinas quedan a ~70 m de su ' +
                'sitio y con 5° a ~174 m (plano de 2.000 × 1.500 m). La matriz afín de ' +
                'calibrate() SÍ resuelve la rotación correctamente, pero nadie la usa.' },
        () => {
            const c = calibradorCon([[0, 0], [W, H], [W, 0], [0, H]], 5);
            const b = c.getImageBounds();
            const f = planoVerdadero(5);
            const esquinas = [f(0, 0), f(W, 0), f(0, H), f(W, H)];
            const so = {
                lat: Math.min(...esquinas.map(p => p.lat)),
                lng: Math.min(...esquinas.map(p => p.lng))
            };
            const err = enMetros({ lat: b[0][0], lng: b[0][1] }, so);
            assert.ok(err < 1, `la esquina SO está a ${err.toFixed(0)} m de su sitio`);
        }
    );
});

describe('calibration.js — parseGeoMetadataString (GeoPDF)', () => {
    test('GPTS con grados geográficos', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            '/GPTS [ 4.7 -74.1 4.7 -74.0 4.8 -74.0 4.8 -74.1 ]'
        );
        assert.ok(meta, 'debe reconocer el GPTS');
        assert.equal(meta.format, 'ISO-GeoPDF (GPTS)');
        assert.deepEqual(meta.bounds, [[4.7, -74.1], [4.8, -74.0]]);
        assert.deepEqual(meta.center, [4.75, -74.05]);
    });

    test('GPTS con coordenadas MAGNA-SIRGAS proyectadas se reproyecta a grados', () => {
        // Prueba de integración real entre calibration.js y coords.js.
        const meta = MapCalibrator.parseGeoMetadataString(
            '/GPTS [ 2066190 4991660 2066190 4995660 2070190 4995660 2070190 4991660 ] ' +
            '/Magna_Origen_Nacional'
        );
        assert.ok(meta, 'debe reconocer coordenadas proyectadas');
        assert.match(meta.format, /MAGNA-SIRGAS/);
        const [[minLat, minLng], [maxLat, maxLng]] = meta.bounds;
        assert.ok(minLat > 4.5 && maxLat < 4.7, `latitudes fuera de rango: ${minLat}-${maxLat}`);
        assert.ok(minLng > -73.2 && maxLng < -73.0, `longitudes fuera de rango: ${minLng}-${maxLng}`);
        assert.ok(minLat < maxLat && minLng < maxLng, 'el rectángulo no puede ser degenerado');
    });

    test('la reproyección del GPTS MAGNA vuelve a los metros de partida', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            '/GPTS [ 2066190 4991660 2066190 4995660 2070190 4995660 2070190 4991660 ]'
        );
        const [[minLat, minLng], [maxLat, maxLng]] = meta.bounds;
        // El rectángulo en metros NO es un rectángulo exacto en grados (los
        // meridianos convergen), así que la esquina SO en grados cae hasta ~0,5 m
        // del vértice proyectado. Lo importante es que la ida y vuelta cierre
        // dentro del metro y que los bounds encierren el plano completo.
        const so = toMagnaSirgas(minLat, minLng);
        const ne = toMagnaSirgas(maxLat, maxLng);
        assert.ok(Math.abs(so.norte - 2066190) < 1, `norte SO ${so.norte}`);
        assert.ok(Math.abs(so.este - 4991660) < 1, `este SO ${so.este}`);
        assert.ok(Math.abs(ne.norte - 2070190) < 1, `norte NE ${ne.norte}`);
        assert.ok(Math.abs(ne.este - 4995660) < 1, `este NE ${ne.este}`);
    });

    test('GPTS corrige el orden invertido sólo cuando |lng| > 90', () => {
        // El GPTS de ISO 32000-1 se define como pares (lat, lon), así que ese es
        // el orden por omisión. El código sólo puede reordenar cuando el primer
        // número es imposible como latitud (|c1| > 90). Con longitudes
        // colombianas (-67° a -82°) esa ambigüedad NO se puede resolver: ver
        // nota en el informe.
        const invertido = MapCalibrator.parseGeoMetadataString(
            '/GPTS [ -174.1 4.7 -174.0 4.7 -174.0 4.8 -174.1 4.8 ]'
        );
        assert.deepEqual(invertido.bounds, [[4.7, -174.1], [4.8, -174.0]]);
    });

    test('un GPTS colombiano invertido se lee como lat/lon (ambigüedad inevitable)', () => {
        // Documenta el límite del heurístico: -74.1 es un valor de latitud
        // sintácticamente válido, así que el módulo no puede saber que era
        // una longitud. Fija la expectativa para que nadie "arregle" esto sin
        // pensarlo.
        const meta = MapCalibrator.parseGeoMetadataString(
            '/GPTS [ -74.1 4.7 -74.0 4.7 -74.0 4.8 -74.1 4.8 ]'
        );
        assert.deepEqual(meta.bounds, [[-74.1, 4.7], [-74.0, 4.8]],
            'se interpreta literalmente como (lat, lon), según la especificación');
    });

    test('etiquetas USGS SW_Lat / NE_Long', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            '/SW_Lat 4.5 /SW_Long -74.2 /NE_Lat 4.9 /NE_Long -73.9'
        );
        assert.equal(meta.format, 'USGS-GeoPDF');
        assert.deepEqual(meta.bounds, [[4.5, -74.2], [4.9, -73.9]]);
    });

    test('las etiquetas USGS se ordenan aunque SW y NE vengan al revés', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            '/SW_Lat 4.9 /SW_Long -73.9 /NE_Lat 4.5 /NE_Long -74.2'
        );
        assert.deepEqual(meta.bounds, [[4.5, -74.2], [4.9, -73.9]]);
    });

    test('sobre gml:Envelope de ArcGIS / QGIS', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            '<gml:lowerCorner>4.5 -74.2</gml:lowerCorner>' +
            '<gml:upperCorner>4.9 -73.9</gml:upperCorner>'
        );
        assert.equal(meta.format, 'GML-Envelope');
        assert.deepEqual(meta.bounds, [[4.5, -74.2], [4.9, -73.9]]);
    });

    test('gml:Envelope con nombre MAGNA se marca como tal', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            'EPSG:9377 <gml:lowerCorner>4.5 -74.2</gml:lowerCorner>' +
            '<gml:upperCorner>4.9 -73.9</gml:upperCorner>'
        );
        assert.equal(meta.format, 'GeoPDF GML MAGNA-SIRGAS');
    });

    test('gml:Envelope en orden lng/lat se corrige solo', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            '<gml:lowerCorner>-174.2 4.5</gml:lowerCorner>' +
            '<gml:upperCorner>-173.9 4.9</gml:upperCorner>'
        );
        assert.deepEqual(meta.bounds, [[4.5, -174.2], [4.9, -173.9]]);
    });

    test('devuelve null si no hay metadatos reconocibles', () => {
        assert.equal(MapCalibrator.parseGeoMetadataString('%PDF-1.7 texto cualquiera'), null);
        assert.equal(MapCalibrator.parseGeoMetadataString(''), null);
    });

    test('devuelve null si el GPTS es degenerado (los cuatro vértices iguales)', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            '/GPTS [ 4.7 -74.1 4.7 -74.1 4.7 -74.1 4.7 -74.1 ]'
        );
        assert.equal(meta, null, 'un rectángulo de área cero no sirve como bounds');
    });

    test('devuelve null si el GPTS trae menos de 4 vértices', () => {
        assert.equal(
            MapCalibrator.parseGeoMetadataString('/GPTS [ 4.7 -74.1 4.8 -74.0 ]'),
            null
        );
    });

    test('nunca lanza, sea cual sea la entrada', () => {
        const entradas = ['/GPTS [ ]', '/GPTS [ abc def ]', '<gml:lowerCorner></gml:lowerCorner>',
                          '/SW_Lat x /SW_Long y /NE_Lat z /NE_Long w', '/GeoBBox [ ]'];
        for (const raw of entradas) {
            assert.doesNotThrow(() => MapCalibrator.parseGeoMetadataString(raw), `entrada: ${raw}`);
        }
    });

    test('el centro siempre queda dentro de los bounds', () => {
        const meta = MapCalibrator.parseGeoMetadataString(
            '/GPTS [ 4.7 -74.1 4.7 -74.0 4.8 -74.0 4.8 -74.1 ]'
        );
        const [[minLat, minLng], [maxLat, maxLng]] = meta.bounds;
        assert.ok(meta.center[0] >= minLat && meta.center[0] <= maxLat);
        assert.ok(meta.center[1] >= minLng && meta.center[1] <= maxLng);
    });

    test(
        'un /GeoBBox con longitudes colombianas debería reconocerse',
        { todo: 'BUG: la rama /GeoBBox exige `Math.abs(x1) > 90` para decidir que el ' +
                'primer valor es una longitud. Colombia está entre -67° y -82°, así que ' +
                'esa condición NUNCA se cumple y la rama queda muerta para planos ' +
                'colombianos: parseGeoMetadataString devuelve null y el GeoPDF se ' +
                'trata como no georreferenciado. Arreglarlo obliga a decidir el orden ' +
                'de ejes por defecto (x,y vs y,x), que es semántica: no se toca aquí.' },
        () => {
            const meta = MapCalibrator.parseGeoMetadataString('/GeoBBox [ -74.2 4.5 -73.9 4.9 ]');
            assert.ok(meta, 'debería devolver bounds para un plano de Colombia');
            assert.deepEqual(meta.bounds, [[4.5, -74.2], [4.9, -73.9]]);
        }
    );
});

describe('calibration.js — extractGeoPdfMetadata', () => {
    const aBuffer = (texto) => new TextEncoder().encode(texto).buffer;

    test('encuentra los metadatos en la cola del archivo', () => {
        const relleno = 'x'.repeat(5000);
        const buf = aBuffer(relleno + '/GPTS [ 4.7 -74.1 4.7 -74.0 4.8 -74.0 4.8 -74.1 ]');
        const meta = MapCalibrator.extractGeoPdfMetadata(buf);
        assert.ok(meta);
        assert.deepEqual(meta.bounds, [[4.7, -74.1], [4.8, -74.0]]);
    });

    test('devuelve null en un PDF sin georreferencia', () => {
        assert.equal(MapCalibrator.extractGeoPdfMetadata(aBuffer('%PDF-1.7\n' + 'y'.repeat(2000))), null);
    });

    test('no lanza con un buffer vacío', () => {
        assert.doesNotThrow(() => MapCalibrator.extractGeoPdfMetadata(new ArrayBuffer(0)));
        assert.equal(MapCalibrator.extractGeoPdfMetadata(new ArrayBuffer(0)), null);
    });
});
