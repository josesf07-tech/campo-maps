#!/usr/bin/env node
/**
 * Sincroniza la versión de JoseMaps en todos los sitios donde aparece.
 *
 * La versión canónica vive en js/version.js. Este script la propaga a:
 *   - js/version.js          (CAMPOMAPS_VERSION)
 *   - index.html             (todos los sufijos ?v=NN de css/js)
 *   - sw.js                  (constante de respaldo CACHE_VERSION)
 *   - package.json           (campo version, como NN.0.0)
 *
 * Uso:
 *   npm run bump              -> sube la versión en 1 (v25 -> v26)
 *   npm run bump -- v30       -> fija la versión en v30
 *   npm run check-version     -> no modifica nada; falla si algo está desfasado
 *
 * Motivo: hasta v25 estos sufijos se editaban a mano y quedaron desfasados
 * (version.js decía v25 mientras index.html seguía pidiendo app.js?v=24), lo
 * que hace que el navegador pueda servir código viejo en la primera carga,
 * antes de que el Service Worker tome el control.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
    version: join(ROOT, 'js/version.js'),
    index: join(ROOT, 'index.html'),
    sw: join(ROOT, 'sw.js'),
    pkg: join(ROOT, 'package.json')
};

const read = (f) => readFileSync(f, 'utf8');

/** Extrae la versión canónica declarada en js/version.js */
function currentVersion() {
    const m = read(files.version).match(/root\.CAMPOMAPS_VERSION\s*=\s*'(v\d+)'/);
    if (!m) throw new Error('No se encontró CAMPOMAPS_VERSION en js/version.js');
    return m[1];
}

/** Devuelve la lista de desfases entre la versión canónica y el resto de archivos */
function findDrift(version) {
    const n = version.slice(1);
    const drift = [];

    for (const [line, suffix] of numberedMatches(read(files.index), /\?v=(\d+)/g)) {
        if (suffix !== n) drift.push(`index.html:${line} usa ?v=${suffix} (esperado ?v=${n})`);
    }

    const swFallback = read(files.sw).match(/self\.CAMPOMAPS_VERSION\s*:\s*'(v\d+)'/);
    if (swFallback && swFallback[1] !== version) {
        drift.push(`sw.js usa el respaldo '${swFallback[1]}' (esperado '${version}')`);
    }

    const pkgVersion = JSON.parse(read(files.pkg)).version;
    if (pkgVersion !== `${n}.0.0`) {
        drift.push(`package.json usa version "${pkgVersion}" (esperado "${n}.0.0")`);
    }

    return drift;
}

/** Itera coincidencias de un regex global devolviendo [nºlínea, grupo1] */
function* numberedMatches(text, re) {
    for (const m of text.matchAll(re)) {
        yield [text.slice(0, m.index).split('\n').length, m[1]];
    }
}

/** Escribe la versión dada en los cuatro archivos */
function applyVersion(version) {
    const n = version.slice(1);

    writeFileSync(files.version, read(files.version)
        .replace(/(root\.CAMPOMAPS_VERSION\s*=\s*')v\d+(')/, `$1${version}$2`));

    writeFileSync(files.index, read(files.index)
        .replace(/\?v=\d+/g, `?v=${n}`));

    writeFileSync(files.sw, read(files.sw)
        .replace(/(self\.CAMPOMAPS_VERSION\s*:\s*')v\d+(')/, `$1${version}$2`));

    const pkg = JSON.parse(read(files.pkg));
    pkg.version = `${n}.0.0`;
    writeFileSync(files.pkg, JSON.stringify(pkg, null, 2) + '\n');
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const explicit = args.find((a) => /^v?\d+$/.test(a));

if (checkOnly) {
    const version = currentVersion();
    const drift = findDrift(version);
    if (drift.length) {
        console.error(`Versión canónica ${version}, pero hay ${drift.length} desfase(s):`);
        drift.forEach((d) => console.error(`  - ${d}`));
        console.error('\nCorrige con: npm run bump -- ' + version);
        process.exit(1);
    }
    console.log(`Versión ${version} sincronizada en index.html, sw.js y package.json.`);
} else {
    const from = currentVersion();
    const to = explicit
        ? (explicit.startsWith('v') ? explicit : `v${explicit}`)
        : `v${Number(from.slice(1)) + 1}`;
    applyVersion(to);
    console.log(`Versión ${from} -> ${to} aplicada en js/version.js, index.html, sw.js y package.json.`);
    const drift = findDrift(to);
    if (drift.length) {
        console.error('Quedaron desfases sin resolver:');
        drift.forEach((d) => console.error(`  - ${d}`));
        process.exit(1);
    }
}
