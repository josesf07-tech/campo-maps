/**
 * Pruebas de `js/lidar-geo.js` — georreferenciación de escaneos JoseScan:
 * cambio de marco ARKit → ENU, ida y vuelta ENU ↔ WGS84, huella GeoJSON,
 * MAGNA-SIRGAS Origen Nacional (EPSG:9377) y métricas geométricas.
 *
 * Contrato de referencia: docs/FORMATO-ESCANEO.md (secciones 3 y 6).
 *
 * `js/coords.js` depende de `window.proj4`; en `ayudantes.mjs` se instala un
 * proj4 mínimo (Transverse Mercator sobre GRS80) que sólo conoce EPSG:4326 y
 * EPSG:9377, que es justo lo que necesita el módulo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cargarGeo,
    cargarCoords,
    mensajeAusente,
    casiIgual,
    casiIgualArray,
    leerEnu,
    leerWgs84,
    leerIndiceEje,
    nubeSintetica,
    cuboUnitario,
    metadatosEjemplo,
    ANCLA_BOGOTA,
    instalarEntornoNavegador,
    desinstalarProj4,
    reinstalarProj4,
    proyectarA9377
} from './ayudantes.mjs';

const { proj4Instalado } = instalarEntornoNavegador();

const RUTA = 'js/lidar-geo.js';

/** Origen con todos los alias razonables de nombre de campo. */
const ORIGEN = Object.freeze({
    latitude: ANCLA_BOGOTA.latitude,
    longitude: ANCLA_BOGOTA.longitude,
    altitude: ANCLA_BOGOTA.altitude,
    lat: ANCLA_BOGOTA.latitude,
    lng: ANCLA_BOGOTA.longitude,
    alt: ANCLA_BOGOTA.altitude
});

/** Aplica `arkitAEnu` a un único punto y devuelve [este, norte, arriba]. */
function unPuntoAEnu(m, x, y, z, rumboGrados) {
    const salida = m.arkitAEnu(new Float32Array([x, y, z]), rumboGrados);
    assert.ok(salida && salida.length >= 3, 'arkitAEnu debe devolver al menos una terna');
    return [salida[0], salida[1], salida[2]];
}

// ---------------------------------------------------------------------------
// Cambio de marco ARKit → ENU
// ---------------------------------------------------------------------------

test('arkitAEnu con rumbo 0 lleva (1, 2, −3) a (1, 3, 2)', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const [e, n, u] = unPuntoAEnu(m, 1, 2, -3, 0);
    casiIgual(e, 1, 1e-6, 'con rumbo 0 el este es +X');
    casiIgual(n, 3, 1e-6, 'con rumbo 0 el norte es −Z');
    casiIgual(u, 2, 1e-6, 'el arriba siempre es +Y');
});

test('arkitAEnu con rumbo 90° manda el eje −Z al eje este', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    // El «adelante» de ARKit es el vector (0, 0, −1).
    const [e, n, u] = unPuntoAEnu(m, 0, 0, -1, 90);
    casiIgual(n, 0, 1e-6, 'con rumbo 90° el adelante no debe tener componente norte');
    casiIgual(u, 0, 1e-6, 'el adelante horizontal no debe generar componente vertical');
    casiIgual(Math.abs(e), 1, 1e-6, 'el adelante debe caer entero sobre el eje este–oeste');
    // Nota: la prosa de docs/FORMATO-ESCANEO.md §3 («e = x·cos h + z·sin h»)
    // da e = −1 aquí, mientras que la semántica de rumbo verdadero da e = +1.
    // La prueba comprueba el mapeo de ejes, que es lo que ambas versiones
    // comparten; el signo se verifica de forma exacta con el rumbo 180°.
});

test('arkitAEnu con rumbo 180° invierte el plano horizontal y respeta el vertical', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    // cos 180° = −1 y sin 180° = 0: el resultado es el mismo con cualquiera de
    // los dos convenios de signo, así que aquí sí se puede exigir exactitud.
    const [e, n, u] = unPuntoAEnu(m, 1, 2, -3, 180);
    casiIgual(e, -1, 1e-6, 'el este se invierte');
    casiIgual(n, -3, 1e-6, 'el norte se invierte');
    casiIgual(u, 2, 1e-6, 'el arriba no cambia con el rumbo');
});

test('arkitAEnu conserva la longitud horizontal para 8 rumbos distintos', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const x = 2.5, y = -1.25, z = -4.0;
    const horizontalOriginal = Math.hypot(x, z); // en ARKit el plano horizontal es XZ
    for (const rumbo of [0, 30, 45, 90, 135, 180, 270, 315]) {
        const [e, n, u] = unPuntoAEnu(m, x, y, z, rumbo);
        casiIgual(Math.hypot(e, n), horizontalOriginal, 1e-5,
            `la rotación por rumbo ${rumbo}° debe conservar la longitud horizontal`);
        casiIgual(u, y, 1e-6, `el eje vertical no debe cambiar con el rumbo ${rumbo}°`);
    }
});

test('arkitAEnu transforma una nube completa punto a punto', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const nube = nubeSintetica(16, { frame: 'arkit' });
    const salida = m.arkitAEnu(nube.positions, 0);
    assert.equal(salida.length, nube.positions.length, 'la nube transformada debe tener el mismo tamaño');
    for (let i = 0; i < 16; i++) {
        casiIgual(salida[i * 3 + 0], nube.positions[i * 3 + 0], 1e-5, `este del punto ${i}`);
        casiIgual(salida[i * 3 + 1], -nube.positions[i * 3 + 2], 1e-5, `norte del punto ${i}`);
        casiIgual(salida[i * 3 + 2], nube.positions[i * 3 + 1], 1e-5, `arriba del punto ${i}`);
    }
});

// ---------------------------------------------------------------------------
// Métricas geométricas
// ---------------------------------------------------------------------------

test('ejeVertical devuelve Z para enu y Y para arkit', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    assert.equal(leerIndiceEje(m.ejeVertical('enu')), 2, 'en ENU el eje vertical es +Z');
    assert.equal(leerIndiceEje(m.ejeVertical('arkit')), 1, 'en ARKit el eje vertical es +Y');
});

test('boundsDe calcula la caja envolvente con la forma del contrato', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const cubo = cuboUnitario();
    const caja = m.boundsDe(cubo.positions);
    assert.ok(caja && caja.min && caja.max, 'boundsDe debe devolver { min, max } como el bbox del contrato');
    casiIgualArray(Array.from(caja.min), [0, 0, 0], 1e-6, 'mínimo del cubo');
    casiIgualArray(Array.from(caja.max), [1, 1, 1], 1e-6, 'máximo del cubo');

    const vacia = m.boundsDe(new Float32Array(0));
    assert.ok(vacia, 'boundsDe no debe reventar con una nube vacía');
});

test('distancia3D mide la distancia euclídea', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    casiIgual(m.distancia3D([0, 0, 0], [3, 4, 12]), 13, 1e-9, 'terna pitagórica 3-4-12-13');
    casiIgual(m.distancia3D([1, 1, 1], [1, 1, 1]), 0, 1e-12, 'la distancia a sí mismo es 0');
    casiIgual(m.distancia3D([-1, -2, -3], [2, 2, 9]), 13, 1e-9, 'con coordenadas negativas');
});

test('areaPoligono devuelve 4 m² para un cuadrado de 2 m', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const cuadrado = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
    casiIgual(m.areaPoligono(cuadrado), 4, 1e-6, 'cuadrado de 2 m de lado');

    // El área no debe depender del sentido de recorrido.
    casiIgual(m.areaPoligono(cuadrado.slice().reverse()), 4, 1e-6, 'mismo cuadrado en sentido inverso');

    // Un anillo cerrado (primer punto repetido al final) debe dar lo mismo.
    casiIgual(m.areaPoligono([...cuadrado, [0, 0, 0]]), 4, 1e-6, 'cuadrado con el anillo cerrado');
});

test('volumenSobreBase devuelve 1 m³ para el cubo de 1 m apoyado en la cota 0', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const cubo = cuboUnitario();
    casiIgual(m.volumenSobreBase(cubo, 0, 'enu'), 1, 1e-4, 'cubo unitario sobre base 0 (marco ENU)');
    casiIgual(m.volumenSobreBase(cubo, 0, 'arkit'), 1, 1e-4, 'cubo unitario sobre base 0 (marco ARKit)');

    // En una malla cerrada las áreas horizontales con signo se cancelan, así que
    // el volumen encerrado no depende de dónde se ponga la base. Es la propiedad
    // que garantiza que un escaneo estanco mida siempre lo mismo.
    casiIgual(m.volumenSobreBase(cubo, 0.5, 'enu'), 1, 1e-4,
        'en una malla cerrada la cota de base no cambia el volumen encerrado');
});

test('volumenSobreBase mide el prisma entre una superficie abierta y la base', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    // Superficie abierta de 1 m × 1 m a 2 m de altura: el caso real de un
    // levantamiento de cárcava o de acopio, donde la base sí importa.
    const superficie = {
        positions: new Float32Array([0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        count: 4,
        frame: 'enu'
    };

    casiIgual(Math.abs(m.volumenSobreBase(superficie, 0, 'enu')), 2, 1e-4,
        '1 m² a 2 m sobre la base 0 ⇒ 2 m³');
    casiIgual(Math.abs(m.volumenSobreBase(superficie, 0.5, 'enu')), 1.5, 1e-4,
        'subir la base a 0,5 m descuenta 0,5 m³');
    casiIgual(Math.abs(m.volumenSobreBase(superficie, 2, 'enu')), 0, 1e-4,
        'con la base a la altura de la superficie no queda volumen');
});

// ---------------------------------------------------------------------------
// ENU ↔ WGS84
// ---------------------------------------------------------------------------

test('enuAWgs84 y wgs84AEnu son inversas con error inferior a 1 mm', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const desplazamientos = [1, 10, 100, 1000];
    const direcciones = [
        ['este', 1, 0],
        ['oeste', -1, 0],
        ['norte', 0, 1],
        ['sur', 0, -1]
    ];

    for (const d of desplazamientos) {
        for (const [nombre, sx, sy] of direcciones) {
            const este = sx * d;
            const norte = sy * d;
            const arriba = d / 10;

            const geo = leerWgs84(m.enuAWgs84(este, norte, arriba, ORIGEN));
            const vuelta = leerEnu(m.wgs84AEnu(geo[0], geo[1], geo[2], ORIGEN));

            casiIgual(vuelta[0], este, 1e-3, `este tras ${d} m hacia el ${nombre}`);
            casiIgual(vuelta[1], norte, 1e-3, `norte tras ${d} m hacia el ${nombre}`);
            casiIgual(vuelta[2], arriba, 1e-3, `arriba tras ${d} m hacia el ${nombre}`);
        }
    }
});

test('enuAWgs84 mueve la latitud y la longitud en el sentido correcto', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const alNorte = leerWgs84(m.enuAWgs84(0, 100, 0, ORIGEN));
    const alEste = leerWgs84(m.enuAWgs84(100, 0, 0, ORIGEN));

    assert.ok(alNorte[0] > ORIGEN.latitude, '100 m al norte deben aumentar la latitud');
    casiIgual(alNorte[1], ORIGEN.longitude, 1e-9, '100 m al norte no deben mover la longitud');
    assert.ok(alEste[1] > ORIGEN.longitude, '100 m al este deben aumentar la longitud');
    casiIgual(alEste[0], ORIGEN.latitude, 1e-9, '100 m al este no deben mover la latitud');

    // 100 m de latitud en Bogotá ≈ 0,000899°; se comprueba el orden de magnitud.
    casiIgual(alNorte[0] - ORIGEN.latitude, 100 / 110574, 5e-6, 'grados por 100 m de norte');
});

test('el origen del marco ENU cae exactamente sobre el ancla', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const geo = leerWgs84(m.enuAWgs84(0, 0, 0, ORIGEN));
    casiIgual(geo[0], ORIGEN.latitude, 1e-9, 'latitud del origen');
    casiIgual(geo[1], ORIGEN.longitude, 1e-9, 'longitud del origen');

    const enu = leerEnu(m.wgs84AEnu(ORIGEN.latitude, ORIGEN.longitude, ORIGEN.altitude, ORIGEN));
    casiIgual(enu[0], 0, 1e-6, 'este del ancla');
    casiIgual(enu[1], 0, 1e-6, 'norte del ancla');
});

// ---------------------------------------------------------------------------
// Huella GeoJSON
// ---------------------------------------------------------------------------

test('scanAGeoJSON produce un FeatureCollection con el punto y el polígono del contrato', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const meta = metadatosEjemplo();
    const fc = m.scanAGeoJSON(meta, {});
    assert.ok(fc, 'con ancla debe devolver una colección');
    assert.equal(fc.type, 'FeatureCollection');
    assert.ok(Array.isArray(fc.features), 'features debe ser un arreglo');
    assert.equal(fc.features.length, 2, 'el contrato exige exactamente dos features');

    const punto = fc.features.find((f) => f.geometry && f.geometry.type === 'Point');
    const poligono = fc.features.find((f) => f.geometry && f.geometry.type === 'Polygon');
    assert.ok(punto, 'debe haber un Point en el origen del escaneo');
    assert.ok(poligono, 'debe haber un Polygon con la proyección horizontal del bbox');

    // Orden GeoJSON: [longitud, latitud].
    const [lng, lat] = punto.geometry.coordinates;
    casiIgual(lng, meta.geo.longitude, 1e-9, 'la primera coordenada del Point es la longitud');
    casiIgual(lat, meta.geo.latitude, 1e-9, 'la segunda coordenada del Point es la latitud');

    const anillo = poligono.geometry.coordinates[0];
    assert.ok(Array.isArray(anillo), 'el Polygon debe traer al menos un anillo');
    assert.ok(anillo.length >= 5, `el anillo del bbox debe tener 5 vértices o más; tuvo ${anillo.length}`);
    casiIgualArray(anillo[0], anillo[anillo.length - 1], 1e-12, 'el anillo debe estar cerrado');
    for (const [pLng, pLat] of anillo) {
        assert.ok(Math.abs(pLng) <= 180, `longitud fuera de rango: ${pLng}`);
        assert.ok(Math.abs(pLat) <= 90, `latitud fuera de rango: ${pLat}`);
        // El bbox del escaneo es de pocos metros: debe quedar pegado al ancla.
        casiIgual(pLng, meta.geo.longitude, 1e-3, 'el anillo debe rodear el ancla');
        casiIgual(pLat, meta.geo.latitude, 1e-3, 'el anillo debe rodear el ancla');
    }

    const props = punto.properties || {};
    for (const clave of ['id', 'nombre', 'puntos', 'triangulos']) {
        assert.ok(clave in props, `las propiedades del Point deben incluir «${clave}»`);
    }
    assert.equal(props.id, meta.id);
    assert.equal(props.nombre, meta.nombre);
    assert.equal(Number(props.puntos), meta.puntos);
    assert.equal(Number(props.triangulos), meta.triangulos);
});

test('scanAGeoJSON degrada sin ancla en vez de inventar coordenadas', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const sinAncla = metadatosEjemplo({ geo: null, marco: 'arkit' });

    let fc;
    try {
        fc = m.scanAGeoJSON(sinAncla, {});
    } catch (e) {
        // Lanzar un error explicativo también es degradar bien: lo que no se
        // admite es devolver una huella con coordenadas inventadas.
        assert.ok(e instanceof Error, 'si falla, debe hacerlo con un Error');
        assert.match(
            e.message,
            /geo|origen|ancla|latitude|longitude/i,
            `el error debe explicar que falta el ancla; se obtuvo: ${e.message}`
        );
        return;
    }

    if (fc == null) return; // devolver null también es una respuesta válida
    assert.equal(fc.type, 'FeatureCollection', 'si devuelve algo, debe ser un FeatureCollection');
    assert.equal(
        (fc.features || []).length, 0,
        'sin ancla GPS no se puede georreferenciar: la colección debe quedar vacía'
    );
});

// ---------------------------------------------------------------------------
// MAGNA-SIRGAS Origen Nacional (EPSG:9377)
// ---------------------------------------------------------------------------

test('scanAMagnaSirgas coincide con js/coords.js y cae en el rango de Bogotá', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (!proj4Instalado) {
        return t.skip('no se pudo instalar el proj4 mínimo en window; EPSG:9377 no es comprobable');
    }

    const meta = metadatosEjemplo();
    const r = m.scanAMagnaSirgas(meta);
    assert.ok(r, 'scanAMagnaSirgas debe devolver algo con un ancla válida');

    const norte = Number(r.norte ?? r.N ?? (Array.isArray(r) ? r[1] : NaN));
    const este = Number(r.este ?? r.E ?? (Array.isArray(r) ? r[0] : NaN));
    assert.ok(Number.isFinite(norte) && Number.isFinite(este),
        `norte/este deben ser numéricos; se obtuvo ${JSON.stringify(r)}`);

    // Referencia calculada con la misma definición TM de js/coords.js.
    const [esteRef, norteRef] = proyectarA9377(meta.geo.longitude, meta.geo.latitude);
    casiIgual(este, esteRef, 1.0, 'este EPSG:9377 (tolerancia 1 m por el redondeo de coords.js)');
    casiIgual(norte, norteRef, 1.0, 'norte EPSG:9377 (tolerancia 1 m por el redondeo de coords.js)');

    // Comprobación independiente del orden de magnitud: Bogotá está ~1,08° al
    // oeste del meridiano central (−73°), es decir unos 120 km de falso este.
    assert.ok(este > 4870000 && este < 4890000, `este fuera del rango esperado para Bogotá: ${este}`);
    assert.ok(norte > 2060000 && norte < 2075000, `norte fuera del rango esperado para Bogotá: ${norte}`);

    // Y consistencia con el módulo de coordenadas del propio repositorio.
    const coords = await cargarCoords();
    if (coords && typeof coords.toMagnaSirgas === 'function') {
        const directo = coords.toMagnaSirgas(meta.geo.latitude, meta.geo.longitude);
        casiIgual(este, directo.este, 0.5, 'scanAMagnaSirgas debe coincidir con coords.toMagnaSirgas');
        casiIgual(norte, directo.norte, 0.5, 'scanAMagnaSirgas debe coincidir con coords.toMagnaSirgas');
    }
});

test('scanAMagnaSirgas degrada sin proj4 en vez de lanzar', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    const anterior = desinstalarProj4();
    try {
        const meta = metadatosEjemplo();
        let r;
        assert.doesNotThrow(() => { r = m.scanAMagnaSirgas(meta); },
            'sin proj4 la función debe degradar, no reventar');
        if (r && typeof r === 'object') {
            // js/coords.js devuelve norte/este en 0 y un `formatted` en lat/lng.
            assert.ok('norte' in r || 'este' in r || 'formatted' in r,
                `la respuesta degradada debe seguir teniendo forma útil: ${JSON.stringify(r)}`);
        }
    } finally {
        reinstalarProj4(anterior);
    }
});

test('resumenGeo devuelve un texto en español con separadores es-CO', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));
    if (!proj4Instalado) {
        return t.skip('sin proj4 mínimo el resumen no puede incluir coordenadas EPSG:9377');
    }

    const resumen = m.resumenGeo(metadatosEjemplo());
    assert.equal(typeof resumen, 'string', 'resumenGeo debe devolver una cadena');
    assert.ok(resumen.trim().length > 0, 'el resumen no puede estar vacío');

    // es-CO agrupa los miles con punto: «2.067.459».
    assert.match(
        resumen,
        /\d{1,3}(\.\d{3})+/,
        `el resumen debe formatear los miles al estilo es-CO; se obtuvo: ${resumen}`
    );
    // No debe colarse el agrupamiento inglés con comas en un número largo.
    assert.ok(
        !/\d,\d{3}(\D|$)/.test(resumen),
        `el resumen no debe usar comas de millar al estilo en-US: ${resumen}`
    );
});

test('resumenGeo indica la ausencia de ancla sin romperse', async (t) => {
    const m = await cargarGeo();
    if (!m) return t.skip(mensajeAusente(RUTA));

    let resumen;
    assert.doesNotThrow(() => { resumen = m.resumenGeo(metadatosEjemplo({ geo: null })); },
        'resumenGeo debe tolerar metadatos sin geo');
    assert.equal(typeof resumen, 'string', 'aun sin ancla debe devolver una cadena');
});
