/**
 * Pruebas de regresión del convenio de rumbo (ARKit → ENU).
 *
 * Motivo: la primera versión de `docs/FORMATO-ESCANEO.md` §3 traía la rotación
 * con el signo invertido, y tanto la app iOS como los dos módulos web la
 * copiaron. El error mandaba el «adelante» del teléfono al oeste en vez de al
 * este, o sea espejaba el escaneo, y sólo se manifestaba con rumbos distintos
 * de 0° y 180°.
 *
 * Por eso estas pruebas usan a propósito rumbos de 90° y 270°: son los que
 * distinguen un convenio del otro. Una prueba que sólo mire |este| o que use
 * rumbo 180° pasa con la fórmula equivocada.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { instalarEntornoNavegador, cargarGeo, casiIgual, motivoFallo } from './ayudantes.mjs';

instalarEntornoNavegador();

const GRADOS = Math.PI / 180;

/** Aplica la conversión a un solo punto y devuelve [este, norte, arriba]. */
function convertir(geo, x, y, z, rumbo) {
    return Array.from(geo.arkitAEnu(new Float32Array([x, y, z]), rumbo));
}

test('el eje -Z de ARKit cae exactamente en el azimut del rumbo', async (t) => {
    const geo = await cargarGeo().catch(() => null);
    if (!geo) return t.skip(motivoFallo('js/lidar-geo.js'));

    for (const h of [0, 30, 45, 90, 135, 180, 225, 270, 315]) {
        const [este, norte] = convertir(geo, 0, 0, -1, h);
        casiIgual(este, Math.sin(h * GRADOS), 1e-6,
            `con rumbo ${h}° el adelante debe tener este = sin(${h}°)`);
        casiIgual(norte, Math.cos(h * GRADOS), 1e-6,
            `con rumbo ${h}° el adelante debe tener norte = cos(${h}°)`);
    }
});

test('con rumbo 90 el adelante apunta al este, no al oeste', async (t) => {
    const geo = await cargarGeo().catch(() => null);
    if (!geo) return t.skip(motivoFallo('js/lidar-geo.js'));

    const [este, norte] = convertir(geo, 0, 0, -1, 90);
    assert.ok(este > 0.99,
        `mirando al este, el adelante debe dar este positivo (se obtuvo ${este})`);
    casiIgual(norte, 0, 1e-6, 'mirando al este, el norte del adelante debe ser cero');
});

test('el eje +X de ARKit queda 90 grados a la derecha del rumbo', async (t) => {
    const geo = await cargarGeo().catch(() => null);
    if (!geo) return t.skip(motivoFallo('js/lidar-geo.js'));

    for (const h of [0, 90, 200, 350]) {
        const [este, norte] = convertir(geo, 1, 0, 0, h);
        const azimut = (Math.atan2(este, norte) / GRADOS + 360) % 360;
        casiIgual(azimut, (h + 90) % 360, 1e-4,
            `con rumbo ${h}° la derecha del dispositivo debe quedar en el azimut ${(h + 90) % 360}°`);
    }
});

test('la conversión es una isometría: conserva distancias y ángulos', async (t) => {
    const geo = await cargarGeo().catch(() => null);
    if (!geo) return t.skip(motivoFallo('js/lidar-geo.js'));

    const a = [1, 2, -3];
    const b = [-2, 0.5, 4];
    const dist0 = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

    for (const h of [0, 37, 90, 213, 270]) {
        const ea = convertir(geo, ...a, h);
        const eb = convertir(geo, ...b, h);
        casiIgual(Math.hypot(...ea), Math.hypot(...a), 1e-5,
            `con rumbo ${h}° la norma del punto A debe conservarse`);
        casiIgual(Math.hypot(ea[0] - eb[0], ea[1] - eb[1], ea[2] - eb[2]), dist0, 1e-5,
            `con rumbo ${h}° la distancia entre A y B debe conservarse`);
    }
});

test('la vertical de ARKit (Y) pasa intacta al arriba de ENU (Z)', async (t) => {
    const geo = await cargarGeo().catch(() => null);
    if (!geo) return t.skip(motivoFallo('js/lidar-geo.js'));

    for (const h of [0, 90, 180, 270]) {
        const [, , arriba] = convertir(geo, 3, 7.25, -2, h);
        casiIgual(arriba, 7.25, 1e-6,
            `con rumbo ${h}° la altura no debe cambiar al rotar sobre la vertical`);
    }
});

test('el punto de referencia (1, 2, -3) coincide con el esperado por la suite de iOS', async (t) => {
    const geo = await cargarGeo().catch(() => null);
    if (!geo) return t.skip(motivoFallo('js/lidar-geo.js'));

    // Los mismos valores que afirma ios/JoseScanTests/GeoTransformTests.swift,
    // para que las dos plataformas no puedan divergir en silencio.
    const esperados = {
        0: [1, 3, 2],
        90: [3, -1, 2],
        180: [-1, -3, 2],
        270: [-3, 1, 2]
    };
    for (const [rumbo, esperado] of Object.entries(esperados)) {
        const obtenido = convertir(geo, 1, 2, -3, Number(rumbo));
        for (let i = 0; i < 3; i++) {
            casiIgual(obtenido[i], esperado[i], 1e-5,
                `con rumbo ${rumbo}° la componente ${'ENU'[i]} de (1, 2, -3)`);
        }
    }
});
