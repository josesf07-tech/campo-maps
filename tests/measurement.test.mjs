/**
 * Pruebas de js/measurement.js — MeasurementTool.
 *
 * Se prueban los cálculos puros (distancia haversine, azimut y área esférica),
 * que son los que acaban en el informe de campo. La parte de UI/Leaflet queda
 * fuera: sin `window.L` ni `mapEngine.map` los métodos de dibujo salen temprano.
 *
 * Valores de verdad usados:
 *   - Distancia: haversine sobre esfera de R = 6.371.000 m (la que usa el módulo).
 *     1° de latitud = 111.194,93 m. El valor elipsoidal real es 110.574 m, así
 *     que el módulo tiene un sesgo conocido de ~0,56 % (ver informe).
 *   - Área: fórmula de exceso esférico con R = 6.378.137 m. Para un rectángulo
 *     lat/lng el resultado analítico exacto es R² · Δλ · |sen(lat2) − sen(lat1)|.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { crearMapEngineFalso, latlng } from './helpers/browser-env.mjs';
import { MeasurementTool } from '../js/measurement.js';

const R_DIST = 6371000;   // radio usado por calculateDistance
const R_AREA = 6378137;   // radio usado por calculatePolygonArea
const rad = (d) => d * Math.PI / 180;

// 1° de latitud según el modelo esférico del módulo
const GRADO_LAT_M = R_DIST * rad(1);          // 111.194,926644...
// Valor elipsoidal de referencia (arco de meridiano en el ecuador)
const GRADO_LAT_ELIPSOIDAL_M = 110574;

const nuevaHerramienta = () => new MeasurementTool(crearMapEngineFalso());

describe('measurement.js — calculateDistance (haversine)', () => {
    test('un grado de latitud mide 111.194,93 m en el modelo esférico del módulo', () => {
        const t = nuevaHerramienta();
        const d = t.calculateDistance(latlng(0, 0), latlng(1, 0));
        assert.ok(Math.abs(d - GRADO_LAT_M) < 0.01,
            `distancia ${d} debe ser ${GRADO_LAT_M}`);
    });

    test('un grado de latitud queda dentro del 0,7 % del valor elipsoidal (110,574 km)', () => {
        // Documenta el sesgo conocido de usar radio medio en vez del elipsoide:
        // ~0,56 % de más, es decir ~5,6 m de exceso por cada km medido.
        const t = nuevaHerramienta();
        const d = t.calculateDistance(latlng(0, 0), latlng(1, 0));
        const errorRel = Math.abs(d - GRADO_LAT_ELIPSOIDAL_M) / GRADO_LAT_ELIPSOIDAL_M;
        assert.ok(errorRel < 0.007,
            `error relativo ${(errorRel * 100).toFixed(3)} % frente al elipsoide`);
        assert.ok(errorRel > 0.004,
            'si este límite inferior falla, alguien cambió el modelo de distancia (¡revísalo!)');
    });

    test('la distancia no depende de la longitud de partida', () => {
        const t = nuevaHerramienta();
        const a = t.calculateDistance(latlng(4, -73), latlng(5, -73));
        const b = t.calculateDistance(latlng(4, -75), latlng(5, -75));
        assert.ok(Math.abs(a - b) < 1e-6);
        assert.ok(Math.abs(a - GRADO_LAT_M) < 0.01);
    });

    test('un grado de longitud se acorta con el coseno de la latitud', () => {
        const t = nuevaHerramienta();
        const ecuador = t.calculateDistance(latlng(0, -73), latlng(0, -72));
        const enColombia = t.calculateDistance(latlng(4, -73), latlng(4, -72));
        assert.ok(Math.abs(ecuador - GRADO_LAT_M) < 0.01,
            'en el ecuador 1° de longitud mide lo mismo que 1° de latitud');
        const esperado = GRADO_LAT_M * Math.cos(rad(4));
        assert.ok(Math.abs(enColombia - esperado) < 10,
            `en 4°N debe medir ~${esperado.toFixed(1)} m, midió ${enColombia.toFixed(1)}`);
    });

    test('una distancia corta de campo: 0,001° de latitud ≈ 111,19 m', () => {
        const t = nuevaHerramienta();
        const d = t.calculateDistance(latlng(4.0, -73.0), latlng(4.001, -73.0));
        assert.ok(Math.abs(d - 111.1949) < 0.001, `midió ${d}`);
    });

    test('la distancia de un punto a sí mismo es exactamente 0', () => {
        const t = nuevaHerramienta();
        assert.equal(t.calculateDistance(latlng(4.71, -74.07), latlng(4.71, -74.07)), 0);
    });

    test('la distancia es simétrica', () => {
        const t = nuevaHerramienta();
        const p1 = latlng(4.7110, -74.0721);
        const p2 = latlng(6.2442, -75.5812);
        assert.equal(t.calculateDistance(p1, p2), t.calculateDistance(p2, p1));
    });

    test('Bogotá–Medellín ronda los 240 km', () => {
        const t = nuevaHerramienta();
        const d = t.calculateDistance(latlng(4.7110, -74.0721), latlng(6.2442, -75.5812));
        assert.ok(d > 235000 && d < 245000, `midió ${(d / 1000).toFixed(1)} km`);
    });

    test('siempre devuelve un número finito no negativo', () => {
        const t = nuevaHerramienta();
        const pares = [
            [latlng(0, 0), latlng(0, 180)],
            [latlng(-4.2153, -69.9406), latlng(12.45, -81.7)],
            [latlng(90, 0), latlng(-90, 0)]
        ];
        for (const [a, b] of pares) {
            const d = t.calculateDistance(a, b);
            assert.ok(Number.isFinite(d) && d >= 0, `distancia inválida: ${d}`);
        }
    });
});

describe('measurement.js — calculateBearing (azimut)', () => {
    test('los cuatro rumbos cardinales', () => {
        const t = nuevaHerramienta();
        const o = latlng(0, 0);
        assert.ok(Math.abs(t.calculateBearing(o, latlng(1, 0)) - 0) < 1e-9, 'norte = 0°');
        assert.ok(Math.abs(t.calculateBearing(o, latlng(0, 1)) - 90) < 1e-9, 'este = 90°');
        assert.ok(Math.abs(t.calculateBearing(o, latlng(-1, 0)) - 180) < 1e-9, 'sur = 180°');
        assert.ok(Math.abs(t.calculateBearing(o, latlng(0, -1)) - 270) < 1e-9, 'oeste = 270°');
    });

    test('el azimut siempre cae en el intervalo [0, 360)', () => {
        const t = nuevaHerramienta();
        const base = latlng(4.6, -73.4);
        for (let a = 0; a < 360; a += 7) {
            const destino = latlng(
                4.6 + 0.01 * Math.cos(rad(a)),
                -73.4 + 0.01 * Math.sin(rad(a))
            );
            const b = t.calculateBearing(base, destino);
            assert.ok(b >= 0 && b < 360, `azimut fuera de rango: ${b}`);
        }
    });

    test('invertir los puntos gira el azimut ~180°', () => {
        const t = nuevaHerramienta();
        const p1 = latlng(4.600, -73.400);
        const p2 = latlng(4.610, -73.390);
        const ida = t.calculateBearing(p1, p2);
        const vuelta = t.calculateBearing(p2, p1);
        const diff = Math.abs(((vuelta - ida) + 360) % 360);
        assert.ok(Math.abs(diff - 180) < 0.01, `diferencia ${diff}, debía ser ~180`);
    });

    test('un rumbo nororiental de 45° en un tramo corto', () => {
        const t = nuevaHerramienta();
        // A latitud 4° un desplazamiento de dLat y dLng·cos(lat) iguales da 45°.
        const dLat = 0.001;
        const dLng = dLat / Math.cos(rad(4));
        const b = t.calculateBearing(latlng(4, -73), latlng(4 + dLat, -73 + dLng));
        assert.ok(Math.abs(b - 45) < 0.05, `azimut ${b}, debía ser ~45°`);
    });
});

describe('measurement.js — azimuthToQuadrant', () => {
    test('los rumbos cardinales e intercardinales', () => {
        const t = nuevaHerramienta();
        assert.equal(t.azimuthToQuadrant(0), 'N');
        assert.equal(t.azimuthToQuadrant(45), 'NE');
        assert.equal(t.azimuthToQuadrant(90), 'E');
        assert.equal(t.azimuthToQuadrant(135), 'SE');
        assert.equal(t.azimuthToQuadrant(180), 'S');
        assert.equal(t.azimuthToQuadrant(225), 'SW');
        assert.equal(t.azimuthToQuadrant(270), 'W');
        assert.equal(t.azimuthToQuadrant(315), 'NW');
    });

    test('los rumbos secundarios', () => {
        const t = nuevaHerramienta();
        assert.equal(t.azimuthToQuadrant(22.5), 'NNE');
        assert.equal(t.azimuthToQuadrant(67.5), 'ENE');
        assert.equal(t.azimuthToQuadrant(202.5), 'SSW');
    });

    test('cerca de 360° vuelve a "N" y nunca devuelve undefined', () => {
        const t = nuevaHerramienta();
        assert.equal(t.azimuthToQuadrant(359.9), 'N');
        assert.equal(t.azimuthToQuadrant(360), 'N');
        for (let d = 0; d < 360; d += 0.5) {
            assert.ok(typeof t.azimuthToQuadrant(d) === 'string',
                `sin rumbo para ${d}°`);
        }
    });
});

describe('measurement.js — calculatePolygonArea', () => {
    // Rectángulo de 1.000 m × 1.000 m construido con el mismo radio que usa el
    // módulo, de modo que el área analítica exacta es 1.000.000 m² = 100 ha.
    const M_POR_GRADO = R_AREA * rad(1);
    const LAT0 = 4.0;
    const D_LAT = 1000 / M_POR_GRADO;
    const D_LNG = 1000 / (M_POR_GRADO * Math.cos(rad(LAT0 + D_LAT / 2)));
    const LNG0 = -73.0;

    const rectangulo = [
        latlng(LAT0, LNG0),
        latlng(LAT0, LNG0 + D_LNG),
        latlng(LAT0 + D_LAT, LNG0 + D_LNG),
        latlng(LAT0 + D_LAT, LNG0)
    ];

    test('un rectángulo de 1 km × 1 km da 1.000.000 m² (100 ha)', () => {
        const t = nuevaHerramienta();
        const area = t.calculatePolygonArea(rectangulo);
        const errorRel = Math.abs(area - 1e6) / 1e6;
        assert.ok(errorRel < 1e-6,
            `área ${area.toFixed(2)} m² (${(area / 10000).toFixed(4)} ha), error ${errorRel}`);
    });

    test('el resultado en hectáreas es 100,0000 ha', () => {
        const t = nuevaHerramienta();
        const ha = t.calculatePolygonArea(rectangulo) / 10000;
        assert.equal(ha.toFixed(4), '100.0000');
    });

    test('coincide con la fórmula analítica R²·Δλ·|sen(lat2) − sen(lat1)|', () => {
        const t = nuevaHerramienta();
        const esperado = R_AREA * R_AREA * rad(D_LNG) *
            Math.abs(Math.sin(rad(LAT0 + D_LAT)) - Math.sin(rad(LAT0)));
        const area = t.calculatePolygonArea(rectangulo);
        assert.ok(Math.abs(area - esperado) / esperado < 1e-12,
            `área ${area} vs analítica ${esperado}`);
    });

    test('el área escala con el cuadrado del lado', () => {
        const t = nuevaHerramienta();
        const doble = [
            latlng(LAT0, LNG0),
            latlng(LAT0, LNG0 + 2 * D_LNG),
            latlng(LAT0 + 2 * D_LAT, LNG0 + 2 * D_LNG),
            latlng(LAT0 + 2 * D_LAT, LNG0)
        ];
        const razon = t.calculatePolygonArea(doble) / t.calculatePolygonArea(rectangulo);
        assert.ok(Math.abs(razon - 4) < 0.001, `razón ${razon}, debía ser ~4`);
    });

    test('el sentido de recorrido no cambia el área (horario = antihorario)', () => {
        const t = nuevaHerramienta();
        const horario = [...rectangulo].reverse();
        assert.equal(t.calculatePolygonArea(horario), t.calculatePolygonArea(rectangulo));
    });

    test('el polígono se cierra solo: repetir el primer vértice al final no altera el área', () => {
        const t = nuevaHerramienta();
        const cerradoExplicito = [...rectangulo, rectangulo[0]];
        assert.equal(
            t.calculatePolygonArea(cerradoExplicito),
            t.calculatePolygonArea(rectangulo),
            'el algoritmo ya cierra el anillo con el módulo % length'
        );
    });

    test('dividir el rectángulo en dos triángulos conserva el área total', () => {
        const t = nuevaHerramienta();
        const [a, b, c, d] = rectangulo;
        const suma = t.calculatePolygonArea([a, b, c]) + t.calculatePolygonArea([a, c, d]);
        const total = t.calculatePolygonArea(rectangulo);
        assert.ok(Math.abs(suma - total) / total < 1e-9,
            `triángulos ${suma} vs rectángulo ${total}`);
    });

    test('polígonos degenerados de 0, 1 y 2 puntos dan área 0', () => {
        const t = nuevaHerramienta();
        assert.equal(t.calculatePolygonArea([]), 0);
        assert.equal(t.calculatePolygonArea([latlng(4, -73)]), 0);
        assert.equal(t.calculatePolygonArea([latlng(4, -73), latlng(5, -73)]), 0);
    });

    test('tres puntos idénticos dan área 0, no NaN', () => {
        const t = nuevaHerramienta();
        const p = latlng(4.6, -73.4);
        const area = t.calculatePolygonArea([p, p, p]);
        assert.ok(Number.isFinite(area), 'no debe ser NaN');
        assert.equal(area, 0);
    });

    test('tres puntos colineales dan área ~0, no NaN', () => {
        const t = nuevaHerramienta();
        const area = t.calculatePolygonArea([
            latlng(4.600, -73.400),
            latlng(4.601, -73.400),
            latlng(4.602, -73.400)
        ]);
        assert.ok(Number.isFinite(area));
        assert.ok(area < 1e-3, `área ${area} debía ser ~0`);
    });

    test('el área nunca es negativa', () => {
        const t = nuevaHerramienta();
        assert.ok(t.calculatePolygonArea(rectangulo) > 0);
        assert.ok(t.calculatePolygonArea([...rectangulo].reverse()) > 0);
    });
});

describe('measurement.js — gestión de puntos', () => {
    test('addPoint acumula puntos sin necesitar Leaflet ni DOM', () => {
        const t = nuevaHerramienta();
        assert.equal(t.points.length, 0);
        t.addPoint(latlng(4.6, -73.4));
        t.addPoint(latlng(4.61, -73.39));
        assert.equal(t.points.length, 2);
        assert.deepEqual(t.points[0], latlng(4.6, -73.4));
    });

    test('clear() vacía los puntos y las capas', () => {
        const t = nuevaHerramienta();
        t.addPoint(latlng(4.6, -73.4));
        t.addPoint(latlng(4.61, -73.39));
        t.clear();
        assert.equal(t.points.length, 0);
        assert.equal(t.markers.length, 0);
        assert.equal(t.line, null);
        assert.equal(t.polygon, null);
    });

    test('setMode cambia entre distancia y área', () => {
        const t = nuevaHerramienta();
        assert.equal(t.mode, 'distance');
        t.setMode('area');
        assert.equal(t.mode, 'area');
    });

    test('onMapClick ignora los clics cuando la herramienta está inactiva', () => {
        const t = nuevaHerramienta();
        t.active = false;
        t.onMapClick({ latlng: latlng(4.6, -73.4) });
        assert.equal(t.points.length, 0);

        t.active = true;
        t.onMapClick({ latlng: latlng(4.6, -73.4) });
        assert.equal(t.points.length, 1);
    });

    test('la longitud total de una polilínea es la suma de sus tramos', () => {
        const t = nuevaHerramienta();
        const ruta = [
            latlng(4.600, -73.400),
            latlng(4.601, -73.400),
            latlng(4.601, -73.399),
            latlng(4.602, -73.399)
        ];
        ruta.forEach(p => t.addPoint(p));

        let total = 0;
        for (let i = 0; i < t.points.length - 1; i++) {
            total += t.calculateDistance(t.points[i], t.points[i + 1]);
        }
        // 2 tramos de 0,001° de latitud + 1 tramo de 0,001° de longitud en 4,601°N
        const esperado = 2 * 111.1949 + 111.1949 * Math.cos(rad(4.601));
        assert.ok(Math.abs(total - esperado) < 0.05,
            `perímetro ${total.toFixed(3)} vs esperado ${esperado.toFixed(3)}`);
    });
});
