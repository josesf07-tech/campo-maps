/**
 * Pruebas de js/coords.js — MAGNA-SIRGAS Origen Nacional (EPSG:9377).
 *
 * Módulo más crítico del proyecto: si falla, las coordenadas que salen en los
 * informes de campo están mal. Se valida contra valores de verdad conocidos de
 * la definición oficial del IGAC (Res. 471 de 2020), no contra "lo que devuelve
 * hoy el código".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { proj4, sinProj4, sinWindow, silenciarConsola } from './helpers/browser-env.mjs';
import {
    MAGNA_SIRGAS_ORIGEN_NACIONAL_DEF,
    initCoords,
    toMagnaSirgas,
    fromMagnaSirgas,
    isMagnaSirgasCoords
} from '../js/coords.js';

// Falsos origen oficiales de EPSG:9377
const FALSO_ESTE = 5000000;
const FALSO_NORTE = 2000000;

// Tolerancia sub-centimétrica para el viaje de ida y vuelta.
const TOL_MM = 0.001;   // 1 mm en metros proyectados
const TOL_GRADOS = 1e-9; // ~0.1 mm en latitud

// Puntos de control dentro de Colombia (lat, lng, descripción)
const PUNTOS_COLOMBIA = [
    [4.0000, -73.0000, 'Origen de la proyección'],
    [4.7110, -74.0721, 'Bogotá D.C.'],
    [6.2442, -75.5812, 'Medellín'],
    [10.3910, -75.4794, 'Cartagena'],
    [3.4516, -76.5320, 'Cali'],
    [-4.2153, -69.9406, 'Leticia (extremo sur)'],
    [12.4500, -81.7000, 'San Andrés (extremo occidental)'],
    [11.1000, -71.3000, 'La Guajira (extremo nororiental)'],
    [1.2000, -70.0000, 'Amazonía oriental']
];

describe('coords.js — definición de la proyección', () => {
    test('la definición proj4 contiene los parámetros oficiales del IGAC', () => {
        const def = MAGNA_SIRGAS_ORIGEN_NACIONAL_DEF;
        assert.match(def, /\+proj=tmerc\b/, 'debe ser Transverse Mercator');
        assert.match(def, /\+lat_0=4\b/, 'latitud de origen 4°N');
        assert.match(def, /\+lon_0=-73\b/, 'meridiano central 73°W');
        assert.match(def, /\+k=0\.9992\b/, 'factor de escala 0.9992');
        assert.match(def, /\+x_0=5000000\b/, 'falso Este 5.000.000 m');
        assert.match(def, /\+y_0=2000000\b/, 'falso Norte 2.000.000 m');
        assert.match(def, /\+ellps=GRS80\b/, 'elipsoide GRS80');
        assert.match(def, /\+units=m\b/, 'unidades en metros');
    });

    test('initCoords registra EPSG:9377 en proj4 y devuelve true', () => {
        assert.equal(initCoords(), true);
        assert.ok(proj4.defs('EPSG:9377'), 'EPSG:9377 debe quedar definido');
        assert.ok(proj4.defs('MAGNA_ORIGEN_NACIONAL'), 'el alias también debe quedar definido');
    });

    test('initCoords devuelve false si no hay window', () => {
        assert.equal(sinWindow(() => initCoords()), false);
    });

    test('initCoords devuelve false si window existe pero no hay proj4', () => {
        assert.equal(sinProj4(() => initCoords()), false);
    });
});

describe('coords.js — prueba ancla: el origen de la proyección', () => {
    test('lat 4.0 / lon -73.0 da exactamente Este 5.000.000 m y Norte 2.000.000 m', () => {
        const r = toMagnaSirgas(4.0, -73.0);
        assert.equal(r.este, FALSO_ESTE, 'el falso Este debe ser exactamente 5.000.000');
        assert.equal(r.norte, FALSO_NORTE, 'el falso Norte debe ser exactamente 2.000.000');
    });

    test('el origen inverso: (2.000.000 N, 5.000.000 E) da lat 4.0 / lon -73.0', () => {
        const { lat, lng } = fromMagnaSirgas(FALSO_NORTE, FALSO_ESTE);
        assert.ok(Math.abs(lat - 4.0) < TOL_GRADOS, `lat=${lat} debe ser 4.0`);
        assert.ok(Math.abs(lng - (-73.0)) < TOL_GRADOS, `lng=${lng} debe ser -73.0`);
    });
});

describe('coords.js — Norte y Este NO deben estar intercambiados', () => {
    // En la v20 hubo un bug real de este tipo ("northing -> norte/este").
    // Estas pruebas fijan el orden correcto para siempre.
    // Recordatorio: proj4 devuelve [x, y] = [este, norte].

    test('al norte del paralelo 4°N el Norte crece por encima de 2.000.000', () => {
        const r = toMagnaSirgas(5.0, -73.0);
        assert.ok(r.norte > FALSO_NORTE, `norte=${r.norte} debe ser > 2.000.000`);
        assert.ok(Math.abs(r.este - FALSO_ESTE) < 0.5,
            `sobre el meridiano central el Este debe seguir en 5.000.000, no ${r.este}`);
    });

    test('al sur del paralelo 4°N el Norte baja de 2.000.000', () => {
        const r = toMagnaSirgas(3.0, -73.0);
        assert.ok(r.norte < FALSO_NORTE, `norte=${r.norte} debe ser < 2.000.000`);
        assert.ok(Math.abs(r.este - FALSO_ESTE) < 0.5, 'el Este no debe moverse');
    });

    test('al oeste del meridiano -73° el Este baja de 5.000.000', () => {
        const r = toMagnaSirgas(4.0, -74.0);
        assert.ok(r.este < FALSO_ESTE, `este=${r.este} debe ser < 5.000.000`);
        assert.ok(Math.abs(r.norte - FALSO_NORTE) < 500,
            `sobre el paralelo de origen el Norte apenas varía, no ${r.norte}`);
    });

    test('al este del meridiano -73° el Este sube de 5.000.000', () => {
        const r = toMagnaSirgas(4.0, -72.0);
        assert.ok(r.este > FALSO_ESTE, `este=${r.este} debe ser > 5.000.000`);
    });

    test('un grado de latitud mueve el Norte ~110 km y casi nada el Este', () => {
        const a = toMagnaSirgas(4.0, -73.0);
        const b = toMagnaSirgas(5.0, -73.0);
        const dNorte = b.norte - a.norte;
        const dEste = Math.abs(b.este - a.este);
        assert.ok(dNorte > 110000 && dNorte < 111500,
            `un grado de latitud son ~110,5 km en el Norte, no ${dNorte}`);
        assert.ok(dEste < 1, `el Este no debe cambiar con la latitud (cambió ${dEste} m)`);
    });

    test('el Norte en Colombia continental siempre es menor que el Este', () => {
        // Rango típico: Norte 0,8-3,5 M m ; Este 3,5-6,5 M m. Si alguien invierte
        // el par, este invariante se rompe de inmediato.
        for (const [lat, lng, nombre] of PUNTOS_COLOMBIA) {
            const r = toMagnaSirgas(lat, lng);
            assert.ok(r.norte < r.este, `${nombre}: norte=${r.norte} debe ser < este=${r.este}`);
        }
    });

    test('fromMagnaSirgas recibe (norte, este) en ese orden, no al revés', () => {
        const correcto = fromMagnaSirgas(2078651.31, 4881143.15); // Bogotá
        assert.ok(Math.abs(correcto.lat - 4.7110) < 1e-4, `lat=${correcto.lat}`);
        assert.ok(Math.abs(correcto.lng - (-74.0721)) < 1e-4, `lng=${correcto.lng}`);

        // Si se pasan invertidos el resultado debe quedar clarísimamente fuera
        // de Colombia (no debe "colar" silenciosamente).
        const invertido = fromMagnaSirgas(4881143.15, 2078651.31);
        assert.ok(
            Math.abs(invertido.lat - 4.7110) > 1,
            `pasar (este, norte) invertidos no puede parecerse a la latitud real: ${invertido.lat}`
        );
    });
});

describe('coords.js — ida y vuelta (round-trip)', () => {
    for (const [lat, lng, nombre] of PUNTOS_COLOMBIA) {
        test(`round-trip sub-centimétrico en ${nombre}`, () => {
            const proyectado = toMagnaSirgas(lat, lng);
            const vuelta = fromMagnaSirgas(proyectado.norte, proyectado.este);

            // toMagnaSirgas redondea a 2 decimales (1 cm), así que la vuelta a
            // grados debe caer dentro de ~1 cm sobre el terreno.
            const errLatM = Math.abs(vuelta.lat - lat) * 111320;
            const errLngM = Math.abs(vuelta.lng - lng) * 111320 * Math.cos(lat * Math.PI / 180);
            assert.ok(errLatM < 0.01, `error en latitud ${errLatM.toFixed(4)} m debe ser < 1 cm`);
            assert.ok(errLngM < 0.01, `error en longitud ${errLngM.toFixed(4)} m debe ser < 1 cm`);
        });
    }

    test('ida y vuelta desde metros: (norte, este) -> lat/lng -> (norte, este)', () => {
        const casos = [
            [2000000, 5000000],
            [2066190, 4991660],
            [1100000, 4600000],
            [2500000, 5400000]
        ];
        for (const [norte, este] of casos) {
            const { lat, lng } = fromMagnaSirgas(norte, este);
            const vuelta = toMagnaSirgas(lat, lng);
            assert.ok(Math.abs(vuelta.norte - norte) <= 0.01,
                `norte ${vuelta.norte} vs ${norte}`);
            assert.ok(Math.abs(vuelta.este - este) <= 0.01,
                `este ${vuelta.este} vs ${este}`);
        }
    });

    test('la proyección es determinista: la misma entrada da la misma salida', () => {
        const a = toMagnaSirgas(4.7110, -74.0721);
        const b = toMagnaSirgas(4.7110, -74.0721);
        assert.deepEqual(a, b);
    });
});

describe('coords.js — formato de salida', () => {
    test('formatted usa "N: ... m | E: ... m" con el Norte primero', () => {
        const r = toMagnaSirgas(4.7110, -74.0721);
        assert.match(r.formatted, /^N: .+ m \| E: .+ m$/);
        const [, nStr, eStr] = r.formatted.match(/^N: (.+) m \| E: (.+) m$/);
        const nNum = Number(nStr.replace(/\D/g, ''));
        const eNum = Number(eStr.replace(/\D/g, ''));
        assert.equal(nNum, Math.round(r.norte), 'el primer número del texto es el Norte');
        assert.equal(eNum, Math.round(r.este), 'el segundo número del texto es el Este');
    });

    test('los metros vienen redondeados a 2 decimales (1 cm)', () => {
        const r = toMagnaSirgas(4.7110, -74.0721);
        assert.equal(r.norte, Math.round(r.norte * 100) / 100);
        assert.equal(r.este, Math.round(r.este * 100) / 100);
    });

    test('devuelve números finitos, nunca NaN', () => {
        for (const [lat, lng, nombre] of PUNTOS_COLOMBIA) {
            const r = toMagnaSirgas(lat, lng);
            assert.ok(Number.isFinite(r.norte), `${nombre}: norte NaN`);
            assert.ok(Number.isFinite(r.este), `${nombre}: este NaN`);
        }
    });
});

describe('coords.js — comportamiento de respaldo sin proj4', () => {
    test('toMagnaSirgas sin proj4 devuelve ceros y el texto "Lat: ..., Lng: ..."', () => {
        const r = sinProj4(() => toMagnaSirgas(4.7110, -74.0721));
        assert.equal(r.norte, 0);
        assert.equal(r.este, 0);
        assert.equal(r.formatted, 'Lat: 4.71100, Lng: -74.07210');
    });

    test('toMagnaSirgas sin window tampoco lanza ReferenceError', () => {
        // Regresión: `if (!window.proj4)` sin guarda `typeof` reventaba en Node.
        const r = sinWindow(() => toMagnaSirgas(4.7110, -74.0721));
        assert.equal(r.norte, 0);
        assert.equal(r.este, 0);
        assert.equal(r.formatted, 'Lat: 4.71100, Lng: -74.07210');
    });

    test('fromMagnaSirgas sin proj4 lanza un error explícito en español', () => {
        assert.throws(
            () => sinProj4(() => fromMagnaSirgas(2000000, 5000000)),
            /Motor de proyecciones Proj4 no disponible/
        );
    });

    test('fromMagnaSirgas sin window lanza el mismo error, no ReferenceError', () => {
        assert.throws(
            () => sinWindow(() => fromMagnaSirgas(2000000, 5000000)),
            (e) => e instanceof Error
                && !(e instanceof ReferenceError)
                && /Motor de proyecciones Proj4 no disponible/.test(e.message)
        );
    });

    test('si proj4 falla, toMagnaSirgas cae al respaldo sin propagar la excepción', () => {
        const previo = globalThis.window.proj4;
        globalThis.window.proj4 = Object.assign(
            () => { throw new Error('fallo simulado del motor'); },
            { defs: () => {} }
        );
        try {
            const { resultado, errores } = silenciarConsola(() => toMagnaSirgas(4.0, -73.0));
            assert.equal(resultado.norte, 0);
            assert.equal(resultado.este, 0);
            assert.equal(resultado.formatted, 'Lat: 4.00000, Lng: -73.00000');
            assert.equal(errores.length, 1, 'debe registrar el error en consola');
        } finally {
            globalThis.window.proj4 = previo;
        }
    });
});

describe('coords.js — isMagnaSirgasCoords', () => {
    test('reconoce un par (norte, este) válido de Colombia', () => {
        assert.equal(isMagnaSirgasCoords(2066190, 4991660), true);
        assert.equal(isMagnaSirgasCoords(2000000, 5000000), true);
        assert.equal(isMagnaSirgasCoords(1000000, 4000000), true);
    });

    test('reconoce el par con los argumentos invertidos (este, norte)', () => {
        // La detección es simétrica a propósito: sirve para decidir después
        // cuál de los dos números es el Norte.
        assert.equal(isMagnaSirgasCoords(4991660, 2066190), true);
        assert.equal(isMagnaSirgasCoords(5000000, 2000000), true);
    });

    test('todos los puntos reales de Colombia se detectan como MAGNA-SIRGAS', () => {
        for (const [lat, lng, nombre] of PUNTOS_COLOMBIA) {
            const r = toMagnaSirgas(lat, lng);
            assert.equal(isMagnaSirgasCoords(r.norte, r.este), true,
                `${nombre} (N=${r.norte}, E=${r.este}) debería detectarse`);
            assert.equal(isMagnaSirgasCoords(r.este, r.norte), true,
                `${nombre} invertido también debería detectarse`);
        }
    });

    test('rechaza pares de grados WGS84', () => {
        assert.equal(isMagnaSirgasCoords(4.7110, -74.0721), false);
        assert.equal(isMagnaSirgasCoords(-74.0721, 4.7110), false);
        assert.equal(isMagnaSirgasCoords(0, 0), false);
    });

    test('rechaza pares fuera de rango', () => {
        assert.equal(isMagnaSirgasCoords(100, 200), false, 'demasiado pequeños');
        assert.equal(isMagnaSirgasCoords(9000000, 9000000), false, 'demasiado grandes');
        assert.equal(isMagnaSirgasCoords(2000000, 2000000), false, 'ambos en rango Norte');
        assert.equal(isMagnaSirgasCoords(5000000, 5000000), false, 'ambos en rango Este');
        assert.equal(isMagnaSirgasCoords(2000000, 500000), false, 'el segundo fuera de rango Este');
    });

    test('el signo no altera la detección (usa valor absoluto)', () => {
        assert.equal(isMagnaSirgasCoords(-2066190, -4991660), true);
    });

    test('los límites del rango se comportan como intervalos cerrados', () => {
        assert.equal(isMagnaSirgasCoords(800000, 3500000), true, 'límite inferior incluido');
        assert.equal(isMagnaSirgasCoords(3500000, 6500000), true, 'límite superior incluido');
        assert.equal(isMagnaSirgasCoords(799999, 3500000), false, 'justo por debajo');
        assert.equal(isMagnaSirgasCoords(3500000, 6500001), false, 'justo por encima');
    });
});
