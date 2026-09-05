#!/usr/bin/env node
/**
 * Lanzador de la suite de pruebas de JoseScan.
 *
 * Ejecuta todos los `tests/*.test.mjs` con `node --test`, muestra el informe
 * legible del reportero `spec` y, al terminar, imprime un resumen en español
 * con el número de pruebas aprobadas, falladas y omitidas.
 *
 * Sale con código 0 sólo si no falló ninguna prueba.
 *
 *     node tests/ejecutar.mjs
 *     node tests/ejecutar.mjs --silencioso     (sólo el resumen)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const silencioso = process.argv.includes('--silencioso') || process.argv.includes('-s');

/** Archivos de prueba, en orden alfabético para que la salida sea estable. */
function archivosDePrueba() {
    return fs.readdirSync(AQUI)
        .filter((n) => n.endsWith('.test.mjs'))
        .sort()
        .map((n) => path.join(AQUI, n));
}

/** Formatea un número de milisegundos como texto breve en español. */
function duracion(ms) {
    if (!Number.isFinite(ms)) return 'desconocida';
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

/** Extrae los contadores del informe TAP de `node --test`. */
function analizarTAP(texto) {
    const numero = (etiqueta) => {
        const m = texto.match(new RegExp(`^#\\s*${etiqueta}\\s+([0-9.]+)\\s*$`, 'm'));
        return m ? Number(m[1]) : 0;
    };
    const fallidas = [];
    for (const linea of texto.split('\n')) {
        const m = linea.match(/^\s*not ok\s+\d+\s+-\s+(.*)$/);
        if (m) {
            const nombre = m[1].trim();
            // `node --test` marca también el archivo contenedor como fallido;
            // se conserva porque ayuda a localizar el error.
            if (!fallidas.includes(nombre)) fallidas.push(nombre);
        }
    }
    const omitidasPorMotivo = [];
    const re = /^\s*#\s*SKIP\s+(.*)$/gm;
    let hallazgo;
    while ((hallazgo = re.exec(texto)) !== null) omitidasPorMotivo.push(hallazgo[1].trim());

    return {
        total: numero('tests'),
        aprobadas: numero('pass'),
        falladas: numero('fail'),
        omitidas: numero('skipped'),
        canceladas: numero('cancelled'),
        pendientes: numero('todo'),
        duracionMs: numero('duration_ms'),
        fallidas,
        omitidasPorMotivo
    };
}

function linea(caracter = '─', ancho = 68) {
    return caracter.repeat(ancho);
}

async function principal() {
    const archivos = archivosDePrueba();
    if (archivos.length === 0) {
        console.error('No se encontró ningún archivo *.test.mjs en tests/.');
        process.exit(1);
    }

    console.log(linea('═'));
    console.log('  Suite de pruebas JoseScan — módulo LiDAR de JoseMaps');
    console.log(linea('═'));
    console.log(`  Node:     ${process.version}`);
    console.log(`  Archivos: ${archivos.map((f) => path.basename(f)).join(', ')}`);
    console.log(linea());
    console.log('');

    const informeTAP = path.join(
        os.tmpdir(),
        `josescan-tap-${process.pid}-${Date.now()}.txt`
    );

    // Dos reporteros a la vez: `spec` a la consola (legible) y `tap` a un
    // archivo temporal, que es el que se analiza para el resumen.
    const argumentos = [
        '--test',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=tap',
        `--test-reporter-destination=${informeTAP}`,
        ...archivos
    ];

    const codigo = await new Promise((resolver) => {
        const hijo = spawn(process.execPath, argumentos, {
            cwd: path.resolve(AQUI, '..'),
            stdio: silencioso ? ['ignore', 'ignore', 'inherit'] : 'inherit'
        });
        hijo.on('error', (e) => {
            console.error(`No se pudo lanzar node --test: ${e.message}`);
            resolver(1);
        });
        hijo.on('close', (c) => resolver(c === null ? 1 : c));
    });

    let resumen = null;
    try {
        resumen = analizarTAP(fs.readFileSync(informeTAP, 'utf8'));
    } catch (e) {
        console.error(`\nNo se pudo leer el informe TAP (${e.message}).`);
    } finally {
        try { fs.unlinkSync(informeTAP); } catch { /* archivo temporal: da igual */ }
    }

    console.log('');
    console.log(linea('═'));
    console.log('  RESUMEN');
    console.log(linea('═'));

    if (resumen) {
        console.log(`  Pruebas ejecutadas : ${resumen.total}`);
        console.log(`  Aprobadas          : ${resumen.aprobadas}`);
        console.log(`  Falladas           : ${resumen.falladas}`);
        console.log(`  Omitidas (skip)    : ${resumen.omitidas}`);
        if (resumen.canceladas > 0) console.log(`  Canceladas         : ${resumen.canceladas}`);
        if (resumen.pendientes > 0) console.log(`  Pendientes (todo)  : ${resumen.pendientes}`);
        console.log(`  Duración total     : ${duracion(resumen.duracionMs)}`);

        if (resumen.omitidas > 0 && resumen.omitidasPorMotivo.length > 0) {
            console.log('');
            console.log('  Motivos de omisión:');
            const cuenta = new Map();
            for (const motivo of resumen.omitidasPorMotivo) {
                cuenta.set(motivo, (cuenta.get(motivo) || 0) + 1);
            }
            for (const [motivo, veces] of cuenta) {
                console.log(`    · ${motivo}${veces > 1 ? ` (×${veces})` : ''}`);
            }
        }

        if (resumen.falladas > 0) {
            console.log('');
            console.log('  Pruebas fallidas:');
            for (const nombre of resumen.fallidas) console.log(`    ✗ ${nombre}`);
        }
    } else {
        console.log('  No se pudo calcular el resumen; revisa la salida anterior.');
    }

    console.log(linea('═'));
    const hayFallos = codigo !== 0 || (resumen ? resumen.falladas > 0 : true);
    console.log(hayFallos
        ? '  Resultado: HAY FALLOS. Revisa el detalle de arriba.'
        : '  Resultado: TODO EN ORDEN.');
    console.log(linea('═'));

    process.exit(hayFallos ? 1 : 0);
}

principal().catch((e) => {
    console.error('Error inesperado en el lanzador:', e);
    process.exit(1);
});
