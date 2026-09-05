/**
 * lidar-formats.js — Lectores y escritores de los formatos de JoseScan.
 *
 * Implementa, byte a byte, el contrato descrito en docs/FORMATO-ESCANEO.md
 * (`josescan/1.0`): PLY (ASCII y binario en ambos endianes), Wavefront OBJ,
 * XYZ, CSV y el paquete ZIP `.josescan`.
 *
 * Este módulo es el lector/escritor de referencia en el navegador y es el
 * espejo de `ios/JoseScan/Sources/Export/*` en la app nativa.
 *
 * Módulo ES nativo, sin dependencias npm. Usa `window.JSZip` cuando está
 * disponible; si no, cae en un lector/escritor ZIP mínimo propio (método
 * "store" al escribir, "store" + "deflate" al leer).
 *
 * @module lidar-formats
 */

/* ───────────────────────── Constantes del contrato ───────────────────────── */

/** Identificador de versión del formato. */
export const FORMATO_ACTUAL = 'josescan/1.0';

/** Marcos de coordenadas admitidos (docs/FORMATO-ESCANEO.md §3). */
export const MARCOS_VALIDOS = ['arkit', 'enu'];

/** Nombres canónicos de los archivos dentro del paquete `.josescan` (§1). */
export const ARCHIVOS_PAQUETE = Object.freeze({
    meta: 'escaneo.json',
    nube: 'nube.ply',
    malla: 'malla.obj',
    material: 'malla.mtl',
    miniatura: 'miniatura.jpg',
    huella: 'huella.geojson'
});

/** Nombre legible de cada clasificación semántica de cara (ARMeshClassification). */
const CLASES_MALLA = ['sin_clasificar', 'muro', 'piso', 'techo', 'mesa', 'asiento', 'ventana', 'puerta'];

/* ───────────────────────── Utilidades internas ───────────────────────── */

const _textDecoder = new TextDecoder('utf-8');
const _textEncoder = new TextEncoder();

/**
 * Normaliza cualquier entrada binaria a `Uint8Array` sin copiar si se puede.
 * @param {ArrayBuffer|Uint8Array|DataView|ArrayBufferView} dato
 * @returns {Uint8Array}
 */
function _aBytes(dato) {
    if (dato instanceof Uint8Array) return dato;
    if (dato instanceof ArrayBuffer) return new Uint8Array(dato);
    if (ArrayBuffer.isView(dato)) return new Uint8Array(dato.buffer, dato.byteOffset, dato.byteLength);
    throw new Error('Se esperaba un ArrayBuffer o un Uint8Array.');
}

/**
 * Devuelve un `ArrayBuffer` exacto (recortado) a partir de una vista.
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
function _aArrayBuffer(bytes) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    return bytes.slice().buffer;
}

/**
 * Aplana posiciones que pueden venir como `Float32Array` plano o como arreglo
 * de tripletas `[[x,y,z], …]`.
 * @param {Float32Array|number[]|number[][]} posiciones
 * @returns {Float32Array}
 */
function _aplanarPosiciones(posiciones) {
    if (!posiciones) return new Float32Array(0);
    if (posiciones instanceof Float32Array) return posiciones;
    if (ArrayBuffer.isView(posiciones)) return new Float32Array(posiciones);
    if (Array.isArray(posiciones)) {
        if (posiciones.length === 0) return new Float32Array(0);
        if (Array.isArray(posiciones[0]) || ArrayBuffer.isView(posiciones[0])) {
            const salida = new Float32Array(posiciones.length * 3);
            for (let i = 0; i < posiciones.length; i++) {
                const p = posiciones[i];
                salida[i * 3] = +p[0] || 0;
                salida[i * 3 + 1] = +p[1] || 0;
                salida[i * 3 + 2] = +p[2] || 0;
            }
            return salida;
        }
        return Float32Array.from(posiciones, (v) => +v || 0);
    }
    throw new Error('Las posiciones deben ser un Float32Array o un arreglo de tripletas.');
}

/**
 * Normaliza un objeto de nube de puntos proveniente de cualquier fuente.
 * @param {object} nube
 * @returns {{positions:Float32Array, colors:Uint8Array|null, confidences:Uint8Array|null, normals:Float32Array|null, count:number, frame:string}}
 */
function _normalizarNube(nube) {
    if (!nube || typeof nube !== 'object') throw new Error('Nube de puntos inválida o ausente.');
    const positions = _aplanarPosiciones(nube.positions || nube.posiciones || nube.vertices);
    const count = Math.floor(positions.length / 3);
    let colors = null;
    const crudoColor = nube.colors || nube.colores;
    if (crudoColor && crudoColor.length >= count * 3) {
        colors = crudoColor instanceof Uint8Array ? crudoColor : Uint8Array.from(crudoColor);
    }
    let confidences = null;
    const crudoConf = nube.confidences || nube.confianzas;
    if (crudoConf && crudoConf.length >= count) {
        confidences = crudoConf instanceof Uint8Array ? crudoConf : Uint8Array.from(crudoConf);
    }
    let normals = null;
    const crudoNorm = nube.normals || nube.normales;
    if (crudoNorm && crudoNorm.length >= count * 3) normals = _aplanarPosiciones(crudoNorm);
    const frame = MARCOS_VALIDOS.includes(nube.frame) ? nube.frame
        : (MARCOS_VALIDOS.includes(nube.marco) ? nube.marco : 'arkit');
    return { positions, colors, confidences, normals, count, frame };
}

/**
 * Redondea a un número fijo de decimales devolviendo la cadena más corta
 * posible (elimina ceros finales), con punto como separador decimal.
 * @param {number} valor
 * @param {number} decimales
 * @returns {string}
 */
function _num(valor, decimales) {
    if (!Number.isFinite(valor)) return '0';
    const texto = valor.toFixed(decimales);
    return texto.includes('.') ? texto.replace(/0+$/, '').replace(/\.$/, '') : texto;
}

/* ───────────────────────── PLY ───────────────────────── */

/** Tipos escalares del PLY con sus alias y su lector en `DataView`. */
const TIPOS_PLY = {
    char: { tam: 1, metodo: 'getInt8' },
    int8: { tam: 1, metodo: 'getInt8' },
    uchar: { tam: 1, metodo: 'getUint8' },
    uint8: { tam: 1, metodo: 'getUint8' },
    short: { tam: 2, metodo: 'getInt16' },
    int16: { tam: 2, metodo: 'getInt16' },
    ushort: { tam: 2, metodo: 'getUint16' },
    uint16: { tam: 2, metodo: 'getUint16' },
    int: { tam: 4, metodo: 'getInt32' },
    int32: { tam: 4, metodo: 'getInt32' },
    uint: { tam: 4, metodo: 'getUint32' },
    uint32: { tam: 4, metodo: 'getUint32' },
    float: { tam: 4, metodo: 'getFloat32' },
    float32: { tam: 4, metodo: 'getFloat32' },
    double: { tam: 8, metodo: 'getFloat64' },
    float64: { tam: 8, metodo: 'getFloat64' }
};

/** Tipos considerados de coma flotante (para reescalar colores 0…1 → 0…255). */
const TIPOS_FLOTANTES = new Set(['float', 'float32', 'double', 'float64']);

/** Alias aceptados para cada campo de interés del elemento `vertex`. */
const ALIAS_VERTICE = {
    x: ['x'], y: ['y'], z: ['z'],
    nx: ['nx', 'normal_x'], ny: ['ny', 'normal_y'], nz: ['nz', 'normal_z'],
    red: ['red', 'r', 'diffuse_red'],
    green: ['green', 'g', 'diffuse_green'],
    blue: ['blue', 'b', 'diffuse_blue'],
    confidence: ['confidence', 'conf', 'quality', 'scalar_confidence']
};

/**
 * Localiza el final de la cabecera ASCII de un PLY.
 * @param {Uint8Array} bytes
 * @returns {{finTexto:number, inicioDatos:number}|null}
 */
function _finCabeceraPLY(bytes) {
    const patron = [0x65, 0x6e, 0x64, 0x5f, 0x68, 0x65, 0x61, 0x64, 0x65, 0x72]; // "end_header"
    const limite = Math.min(bytes.length, 1 << 21) - patron.length;
    for (let i = 0; i <= limite; i++) {
        if (bytes[i] !== 0x65) continue;
        let coincide = true;
        for (let j = 1; j < patron.length; j++) {
            if (bytes[i + j] !== patron[j]) { coincide = false; break; }
        }
        if (!coincide) continue;
        let fin = i + patron.length;
        while (fin < bytes.length && bytes[fin] !== 0x0a) fin++;
        return { finTexto: i + patron.length, inicioDatos: Math.min(fin + 1, bytes.length) };
    }
    return null;
}

/**
 * Analiza la cabecera textual del PLY.
 * @param {string} texto
 * @returns {{formato:string, elementos:Array, marco:string}}
 */
function _analizarCabeceraPLY(texto) {
    const lineas = texto.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lineas.length === 0 || lineas[0].toLowerCase() !== 'ply') {
        throw new Error('Cabecera PLY inválida: falta la línea mágica "ply".');
    }
    let formato = null;
    let marco = 'arkit';
    const elementos = [];
    let actual = null;

    for (let i = 1; i < lineas.length; i++) {
        const linea = lineas[i];
        const partes = linea.split(/\s+/);
        const clave = partes[0].toLowerCase();

        if (clave === 'comment' || clave === 'obj_info') {
            if (partes[1] && partes[1].toLowerCase() === 'marco' && MARCOS_VALIDOS.includes((partes[2] || '').toLowerCase())) {
                marco = partes[2].toLowerCase();
            }
            continue;
        }
        if (clave === 'format') {
            formato = (partes[1] || '').toLowerCase();
            if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(formato)) {
                throw new Error(`Cabecera PLY inválida: formato "${partes[1] || ''}" no soportado.`);
            }
            continue;
        }
        if (clave === 'element') {
            const nombre = (partes[1] || '').toLowerCase();
            const cantidad = Number.parseInt(partes[2], 10);
            if (!nombre || !Number.isFinite(cantidad) || cantidad < 0) {
                throw new Error(`Cabecera PLY inválida: elemento mal declarado ("${linea}").`);
            }
            actual = { nombre, cantidad, propiedades: [] };
            elementos.push(actual);
            continue;
        }
        if (clave === 'property') {
            if (!actual) throw new Error('Cabecera PLY inválida: "property" antes de cualquier "element".');
            if ((partes[1] || '').toLowerCase() === 'list') {
                const tipoConteo = (partes[2] || '').toLowerCase();
                const tipoValor = (partes[3] || '').toLowerCase();
                const nombre = (partes[4] || '').toLowerCase();
                if (!TIPOS_PLY[tipoConteo] || !TIPOS_PLY[tipoValor] || !nombre) {
                    throw new Error(`Cabecera PLY inválida: lista mal declarada ("${linea}").`);
                }
                actual.propiedades.push({ lista: true, tipoConteo, tipoValor, nombre });
            } else {
                const tipo = (partes[1] || '').toLowerCase();
                const nombre = (partes[2] || '').toLowerCase();
                if (!TIPOS_PLY[tipo] || !nombre) {
                    throw new Error(`Cabecera PLY inválida: propiedad mal declarada ("${linea}").`);
                }
                actual.propiedades.push({ lista: false, tipo, nombre });
            }
            continue;
        }
        if (clave === 'end_header') break;
        // Cualquier otra directiva desconocida se ignora silenciosamente (PLY lo permite).
    }

    if (!formato) throw new Error('Cabecera PLY inválida: falta la línea "format".');
    if (elementos.length === 0) throw new Error('Cabecera PLY inválida: no se declaró ningún elemento.');
    return { formato, elementos, marco };
}

/**
 * Construye el índice nombre→posición de las propiedades de un elemento.
 * @param {Array} propiedades
 * @returns {Object<string, number>}
 */
function _indicePropiedades(propiedades) {
    const indice = {};
    propiedades.forEach((p, i) => { indice[p.nombre] = i; });
    return indice;
}

/**
 * Busca el índice de la primera propiedad cuyo nombre coincida con algún alias.
 * @param {Object<string,number>} indice
 * @param {string[]} alias
 * @returns {number} -1 si no existe
 */
function _buscarAlias(indice, alias) {
    for (const nombre of alias) {
        if (Object.prototype.hasOwnProperty.call(indice, nombre)) return indice[nombre];
    }
    return -1;
}

/**
 * Triangula en abanico una cara de N vértices y la agrega al arreglo destino.
 * @param {number[]} cara
 * @param {number[]} destino
 */
function _triangularAbanico(cara, destino) {
    for (let k = 2; k < cara.length; k++) {
        destino.push(cara[0] >>> 0, cara[k - 1] >>> 0, cara[k] >>> 0);
    }
}

/**
 * Lee una nube de puntos y/o malla desde un archivo PLY.
 *
 * Soporta `format ascii 1.0`, `binary_little_endian 1.0` y
 * `binary_big_endian 1.0`; propiedades en cualquier orden; todos los tipos
 * escalares y sus alias; los elementos `vertex` y `face` (con listas
 * `property list uchar int vertex_indices`, trianguladas en abanico);
 * comentarios; y la extracción de `comment marco enu|arkit`.
 *
 * @param {ArrayBuffer|Uint8Array} buffer Contenido completo del archivo.
 * @returns {{positions:Float32Array, colors:Uint8Array|null, confidences:Uint8Array|null, normals:Float32Array|null, indices:Uint32Array|null, count:number, frame:string}}
 * @throws {Error} Si la cabecera es inválida o los datos están truncados.
 */
export function parsePLY(buffer) {
    const bytes = _aBytes(buffer);
    if (bytes.length < 4) throw new Error('Archivo PLY vacío o demasiado corto.');

    const corte = _finCabeceraPLY(bytes);
    if (!corte) throw new Error('Cabecera PLY inválida: no se encontró "end_header".');

    const textoCabecera = _textDecoder.decode(bytes.subarray(0, corte.finTexto));
    const { formato, elementos, marco } = _analizarCabeceraPLY(textoCabecera);

    const elemVertice = elementos.find((e) => e.nombre === 'vertex');
    if (!elemVertice) throw new Error('Cabecera PLY inválida: falta el elemento "vertex".');

    const cuenta = elemVertice.cantidad;
    const idx = _indicePropiedades(elemVertice.propiedades);
    const iX = _buscarAlias(idx, ALIAS_VERTICE.x);
    const iY = _buscarAlias(idx, ALIAS_VERTICE.y);
    const iZ = _buscarAlias(idx, ALIAS_VERTICE.z);
    if (iX < 0 || iY < 0 || iZ < 0) {
        throw new Error('Cabecera PLY inválida: el elemento "vertex" no declara las propiedades x, y, z.');
    }
    const iNX = _buscarAlias(idx, ALIAS_VERTICE.nx);
    const iNY = _buscarAlias(idx, ALIAS_VERTICE.ny);
    const iNZ = _buscarAlias(idx, ALIAS_VERTICE.nz);
    const iR = _buscarAlias(idx, ALIAS_VERTICE.red);
    const iG = _buscarAlias(idx, ALIAS_VERTICE.green);
    const iB = _buscarAlias(idx, ALIAS_VERTICE.blue);
    const iC = _buscarAlias(idx, ALIAS_VERTICE.confidence);

    const hayColor = iR >= 0 && iG >= 0 && iB >= 0;
    const hayNormales = iNX >= 0 && iNY >= 0 && iNZ >= 0;
    const hayConfianza = iC >= 0;
    const colorFlotante = hayColor && !elemVertice.propiedades[iR].lista
        && TIPOS_FLOTANTES.has(elemVertice.propiedades[iR].tipo);

    const positions = new Float32Array(cuenta * 3);
    const colors = hayColor ? new Uint8Array(cuenta * 3) : null;
    const normals = hayNormales ? new Float32Array(cuenta * 3) : null;
    const confidences = hayConfianza ? new Uint8Array(cuenta) : null;
    const indicesTmp = [];

    /** Convierte un valor de color crudo a 0…255. */
    const aByteColor = (v) => {
        let n = colorFlotante ? (v <= 1.0000001 ? v * 255 : v) : v;
        n = Math.round(n);
        return n < 0 ? 0 : (n > 255 ? 255 : n);
    };

    if (formato === 'ascii') {
        const texto = _textDecoder.decode(bytes.subarray(corte.inicioDatos));
        const lineas = texto.split(/\r\n|\r|\n/);
        let ln = 0;
        /** Devuelve los campos de la siguiente línea no vacía. */
        const siguienteFila = () => {
            while (ln < lineas.length) {
                const l = lineas[ln++].trim();
                if (l.length === 0 || l.startsWith('comment')) continue;
                return l.split(/\s+/);
            }
            return null;
        };

        for (const elemento of elementos) {
            const esVertice = elemento === elemVertice;
            const esCara = elemento.nombre === 'face';
            const idxCara = esCara ? _indicePropiedades(elemento.propiedades) : null;
            const iLista = esCara
                ? (Object.prototype.hasOwnProperty.call(idxCara, 'vertex_indices') ? idxCara.vertex_indices
                    : (Object.prototype.hasOwnProperty.call(idxCara, 'vertex_index') ? idxCara.vertex_index : -1))
                : -1;

            for (let n = 0; n < elemento.cantidad; n++) {
                const campos = siguienteFila();
                if (!campos) {
                    if (esVertice) throw new Error(`Archivo PLY truncado: se esperaban ${elemento.cantidad} "${elemento.nombre}" y sólo hay ${n}.`);
                    break;
                }
                // Desempaqueta los valores respetando listas.
                const valores = [];
                let c = 0;
                for (const prop of elemento.propiedades) {
                    if (prop.lista) {
                        const largo = Number.parseInt(campos[c++], 10) || 0;
                        const lista = new Array(largo);
                        for (let k = 0; k < largo; k++) lista[k] = Number(campos[c++]);
                        valores.push(lista);
                    } else {
                        valores.push(Number(campos[c++]));
                    }
                }
                if (esVertice) {
                    positions[n * 3] = valores[iX];
                    positions[n * 3 + 1] = valores[iY];
                    positions[n * 3 + 2] = valores[iZ];
                    if (colors) {
                        colors[n * 3] = aByteColor(valores[iR]);
                        colors[n * 3 + 1] = aByteColor(valores[iG]);
                        colors[n * 3 + 2] = aByteColor(valores[iB]);
                    }
                    if (normals) {
                        normals[n * 3] = valores[iNX];
                        normals[n * 3 + 1] = valores[iNY];
                        normals[n * 3 + 2] = valores[iNZ];
                    }
                    if (confidences) confidences[n] = Math.max(0, Math.min(255, Math.round(valores[iC]) || 0));
                } else if (esCara && iLista >= 0 && Array.isArray(valores[iLista])) {
                    _triangularAbanico(valores[iLista], indicesTmp);
                }
            }
        }
    } else {
        const le = formato === 'binary_little_endian';
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let cursor = corte.inicioDatos;

        /** Lee un escalar del tipo indicado avanzando el cursor. */
        const leerEscalar = (tipo) => {
            const t = TIPOS_PLY[tipo];
            if (cursor + t.tam > bytes.byteLength) throw new Error('Archivo PLY truncado: los datos binarios terminan antes de lo declarado.');
            const v = dv[t.metodo](cursor, le);
            cursor += t.tam;
            return v;
        };

        for (const elemento of elementos) {
            const esVertice = elemento === elemVertice;
            const esCara = elemento.nombre === 'face';
            const idxCara = esCara ? _indicePropiedades(elemento.propiedades) : null;
            const iLista = esCara
                ? (Object.prototype.hasOwnProperty.call(idxCara, 'vertex_indices') ? idxCara.vertex_indices
                    : (Object.prototype.hasOwnProperty.call(idxCara, 'vertex_index') ? idxCara.vertex_index : -1))
                : -1;
            const props = elemento.propiedades;
            const valores = new Array(props.length);

            for (let n = 0; n < elemento.cantidad; n++) {
                for (let p = 0; p < props.length; p++) {
                    const prop = props[p];
                    if (prop.lista) {
                        const largo = leerEscalar(prop.tipoConteo);
                        const lista = new Array(largo < 0 ? 0 : largo);
                        for (let k = 0; k < lista.length; k++) lista[k] = leerEscalar(prop.tipoValor);
                        valores[p] = lista;
                    } else {
                        valores[p] = leerEscalar(prop.tipo);
                    }
                }
                if (esVertice) {
                    positions[n * 3] = valores[iX];
                    positions[n * 3 + 1] = valores[iY];
                    positions[n * 3 + 2] = valores[iZ];
                    if (colors) {
                        colors[n * 3] = aByteColor(valores[iR]);
                        colors[n * 3 + 1] = aByteColor(valores[iG]);
                        colors[n * 3 + 2] = aByteColor(valores[iB]);
                    }
                    if (normals) {
                        normals[n * 3] = valores[iNX];
                        normals[n * 3 + 1] = valores[iNY];
                        normals[n * 3 + 2] = valores[iNZ];
                    }
                    if (confidences) confidences[n] = Math.max(0, Math.min(255, valores[iC] | 0));
                } else if (esCara && iLista >= 0 && Array.isArray(valores[iLista])) {
                    _triangularAbanico(valores[iLista], indicesTmp);
                }
            }
        }
    }

    return {
        positions,
        colors,
        confidences,
        normals,
        indices: indicesTmp.length > 0 ? Uint32Array.from(indicesTmp) : null,
        count: cuenta,
        frame: marco
    };
}

/**
 * Escribe una nube de puntos en PLY según el contrato (§4).
 *
 * En binario produce exactamente 16 bytes por punto:
 * `x,y,z` como `float` little-endian y `red,green,blue,confidence` como `uchar`.
 *
 * @param {{positions:(Float32Array|number[][]), colors?:Uint8Array, confidences?:Uint8Array, frame?:string}} nube
 * @param {{binario?:boolean}} [opciones]
 * @returns {ArrayBuffer}
 */
export function writePLY(nube, { binario = true } = {}) {
    const n = _normalizarNube(nube);
    const marco = n.frame;
    const cabecera =
        'ply\n' +
        `format ${binario ? 'binary_little_endian' : 'ascii'} 1.0\n` +
        `comment JoseScan ${FORMATO_ACTUAL}\n` +
        `comment marco ${marco}\n` +
        `element vertex ${n.count}\n` +
        'property float x\n' +
        'property float y\n' +
        'property float z\n' +
        'property uchar red\n' +
        'property uchar green\n' +
        'property uchar blue\n' +
        'property uchar confidence\n' +
        'end_header\n';

    const bytesCabecera = _textEncoder.encode(cabecera);

    if (!binario) {
        const partes = new Array(n.count + 1);
        partes[0] = cabecera;
        for (let i = 0; i < n.count; i++) {
            const r = n.colors ? n.colors[i * 3] : 255;
            const g = n.colors ? n.colors[i * 3 + 1] : 255;
            const b = n.colors ? n.colors[i * 3 + 2] : 255;
            const c = n.confidences ? n.confidences[i] : 2;
            partes[i + 1] = `${_num(n.positions[i * 3], 6)} ${_num(n.positions[i * 3 + 1], 6)} ${_num(n.positions[i * 3 + 2], 6)} ${r} ${g} ${b} ${c}\n`;
        }
        return _aArrayBuffer(_textEncoder.encode(partes.join('')));
    }

    const salida = new Uint8Array(bytesCabecera.length + n.count * 16);
    salida.set(bytesCabecera, 0);
    const dv = new DataView(salida.buffer, salida.byteOffset + bytesCabecera.length, n.count * 16);
    for (let i = 0; i < n.count; i++) {
        const o = i * 16;
        dv.setFloat32(o, n.positions[i * 3], true);
        dv.setFloat32(o + 4, n.positions[i * 3 + 1], true);
        dv.setFloat32(o + 8, n.positions[i * 3 + 2], true);
        dv.setUint8(o + 12, n.colors ? n.colors[i * 3] : 255);
        dv.setUint8(o + 13, n.colors ? n.colors[i * 3 + 1] : 255);
        dv.setUint8(o + 14, n.colors ? n.colors[i * 3 + 2] : 255);
        dv.setUint8(o + 15, n.confidences ? n.confidences[i] : 2);
    }
    return salida.buffer;
}

/* ───────────────────────── Wavefront OBJ ───────────────────────── */

/**
 * Lee una malla triangular desde texto Wavefront OBJ.
 *
 * Soporta `v`, `vn`, `vt` (ignorado), caras `f` en los formatos `a`, `a/b`,
 * `a//c` y `a/b/c`, índices negativos (relativos al final), caras de N
 * vértices (trianguladas en abanico) y líneas continuadas con `\`.
 *
 * @param {string} texto
 * @returns {{positions:Float32Array, normals:Float32Array|null, indices:Uint32Array, count:number}}
 * @throws {Error} Si el texto no es una cadena o una cara referencia un vértice inexistente.
 */
export function parseOBJ(texto) {
    if (typeof texto !== 'string') {
        if (texto && (texto instanceof ArrayBuffer || ArrayBuffer.isView(texto))) {
            texto = _textDecoder.decode(_aBytes(texto));
        } else {
            throw new Error('parseOBJ espera el contenido del OBJ como texto.');
        }
    }

    const vertices = [];   // plano: x, y, z
    const normales = [];   // plano: nx, ny, nz
    const caras = [];      // índices de vértice (0-based) ya triangulados
    const normalPorVertice = [];  // índice de normal asociado a cada vértice, o -1

    const lineasCrudas = texto.split(/\r\n|\r|\n/);
    let acumulado = '';

    for (let li = 0; li < lineasCrudas.length; li++) {
        let linea = lineasCrudas[li];
        // Líneas de continuación: la barra invertida final une con la siguiente.
        if (/\\\s*$/.test(linea)) {
            acumulado += linea.replace(/\\\s*$/, ' ');
            continue;
        }
        if (acumulado) { linea = acumulado + linea; acumulado = ''; }

        const limpia = linea.trim();
        if (limpia.length === 0 || limpia.charCodeAt(0) === 35 /* # */) continue;

        const campos = limpia.split(/\s+/);
        const clave = campos[0];

        if (clave === 'v') {
            vertices.push(+campos[1] || 0, +campos[2] || 0, +campos[3] || 0);
            normalPorVertice.push(-1);
        } else if (clave === 'vn') {
            normales.push(+campos[1] || 0, +campos[2] || 0, +campos[3] || 0);
        } else if (clave === 'f') {
            const totalV = vertices.length / 3;
            const totalN = normales.length / 3;
            const cara = [];
            const caraNormal = [];
            for (let k = 1; k < campos.length; k++) {
                const pieza = campos[k];
                if (!pieza) continue;
                const trozos = pieza.split('/');
                let iv = Number.parseInt(trozos[0], 10);
                if (!Number.isFinite(iv)) continue;
                iv = iv < 0 ? totalV + iv : iv - 1;
                if (iv < 0 || iv >= totalV) {
                    throw new Error(`OBJ inválido: la cara de la línea ${li + 1} referencia el vértice ${trozos[0]}, fuera de rango.`);
                }
                let inr = -1;
                if (trozos.length >= 3 && trozos[2] !== '' && trozos[2] !== undefined) {
                    const bruto = Number.parseInt(trozos[2], 10);
                    if (Number.isFinite(bruto)) {
                        inr = bruto < 0 ? totalN + bruto : bruto - 1;
                        if (inr < 0 || inr >= totalN) inr = -1;
                    }
                }
                cara.push(iv);
                caraNormal.push(inr);
            }
            if (cara.length >= 3) {
                for (let k = 0; k < cara.length; k++) {
                    if (caraNormal[k] >= 0 && normalPorVertice[cara[k]] < 0) normalPorVertice[cara[k]] = caraNormal[k];
                }
                _triangularAbanico(cara, caras);
            }
        }
        // 'vt', 'g', 'o', 'usemtl', 'mtllib', 's' y demás se ignoran.
    }

    const count = vertices.length / 3;
    const positions = Float32Array.from(vertices);
    let normals = null;
    if (normales.length > 0) {
        normals = new Float32Array(count * 3);
        const totalN = normales.length / 3;
        for (let i = 0; i < count; i++) {
            // Si hay tantas normales como vértices y las caras no las indexaron,
            // se asume correspondencia 1 a 1 (caso típico de las mallas de ARKit).
            const in_ = normalPorVertice[i] >= 0 ? normalPorVertice[i] : (totalN === count ? i : -1);
            if (in_ >= 0) {
                normals[i * 3] = normales[in_ * 3];
                normals[i * 3 + 1] = normales[in_ * 3 + 1];
                normals[i * 3 + 2] = normales[in_ * 3 + 2];
            }
        }
    }

    return { positions, normals, indices: Uint32Array.from(caras), count };
}

/**
 * Escribe una malla triangular en Wavefront OBJ (§5, unidades en metros).
 *
 * Si la malla trae `clasificaciones` (una por triángulo, número o cadena) las
 * caras se agrupan con `g muro`, `g piso`, `g techo`, etc.
 *
 * @param {{positions?:Float32Array, vertices?:Float32Array, normals?:Float32Array, indices:Uint32Array, clasificaciones?:Array}} malla
 * @returns {string}
 */
export function writeOBJ(malla) {
    if (!malla || typeof malla !== 'object') throw new Error('Malla inválida o ausente.');
    const positions = _aplanarPosiciones(malla.positions || malla.vertices);
    const nv = Math.floor(positions.length / 3);
    const normals = (malla.normals || malla.normales) ? _aplanarPosiciones(malla.normals || malla.normales) : null;
    const hayNormales = !!normals && normals.length >= nv * 3;
    const indices = malla.indices ? (malla.indices instanceof Uint32Array ? malla.indices : Uint32Array.from(malla.indices)) : new Uint32Array(0);
    const clases = Array.isArray(malla.clasificaciones) ? malla.clasificaciones : null;

    const partes = [];
    partes.push(`# JoseScan ${FORMATO_ACTUAL}\n`);
    partes.push(`# malla triangular en metros — marco ${malla.frame || malla.marco || 'arkit'}\n`);
    partes.push(`# ${nv} vértices, ${Math.floor(indices.length / 3)} triángulos\n`);
    if (malla.archivoMaterial) partes.push(`mtllib ${malla.archivoMaterial}\n`);

    for (let i = 0; i < nv; i++) {
        partes.push(`v ${_num(positions[i * 3], 6)} ${_num(positions[i * 3 + 1], 6)} ${_num(positions[i * 3 + 2], 6)}\n`);
    }
    if (hayNormales) {
        for (let i = 0; i < nv; i++) {
            partes.push(`vn ${_num(normals[i * 3], 6)} ${_num(normals[i * 3 + 1], 6)} ${_num(normals[i * 3 + 2], 6)}\n`);
        }
    }

    let grupoActual = null;
    for (let t = 0; t + 2 < indices.length; t += 3) {
        if (clases) {
            const bruto = clases[t / 3];
            const nombre = typeof bruto === 'number' ? (CLASES_MALLA[bruto] || CLASES_MALLA[0]) : String(bruto || CLASES_MALLA[0]);
            if (nombre !== grupoActual) { partes.push(`g ${nombre}\n`); grupoActual = nombre; }
        }
        const a = indices[t] + 1, b = indices[t + 1] + 1, c = indices[t + 2] + 1;
        partes.push(hayNormales ? `f ${a}//${a} ${b}//${b} ${c}//${c}\n` : `f ${a} ${b} ${c}\n`);
    }
    return partes.join('');
}

/* ───────────────────────── XYZ y CSV ───────────────────────── */

/**
 * Exporta la nube a texto plano XYZ para software topográfico.
 * Formato: `x y z` y, si hay color, `x y z r g b` (separador: espacio,
 * separador decimal: punto, para máxima interoperabilidad).
 *
 * @param {object} nube
 * @returns {string}
 */
export function writeXYZ(nube) {
    const n = _normalizarNube(nube);
    const partes = new Array(n.count);
    for (let i = 0; i < n.count; i++) {
        const base = `${_num(n.positions[i * 3], 4)} ${_num(n.positions[i * 3 + 1], 4)} ${_num(n.positions[i * 3 + 2], 4)}`;
        partes[i] = n.colors
            ? `${base} ${n.colors[i * 3]} ${n.colors[i * 3 + 1]} ${n.colors[i * 3 + 2]}`
            : base;
    }
    return partes.join('\n') + (n.count > 0 ? '\n' : '');
}

/**
 * Exporta la nube a CSV. Si supera `limite` puntos se submuestrea de forma
 * regular (salto constante) conservando el primero y repartiendo el resto.
 *
 * Cabecera: `indice,x,y,z,rojo,verde,azul,confianza`.
 *
 * @param {object} nube
 * @param {{limite?:number}} [opciones]
 * @returns {string}
 */
export function writeCSV(nube, { limite = 100000 } = {}) {
    const n = _normalizarNube(nube);
    const tope = Number.isFinite(limite) && limite > 0 ? Math.floor(limite) : n.count;
    const salto = n.count > tope ? Math.ceil(n.count / tope) : 1;

    const filas = ['indice,x,y,z,rojo,verde,azul,confianza'];
    for (let i = 0; i < n.count; i += salto) {
        const r = n.colors ? n.colors[i * 3] : '';
        const g = n.colors ? n.colors[i * 3 + 1] : '';
        const b = n.colors ? n.colors[i * 3 + 2] : '';
        const c = n.confidences ? n.confidences[i] : '';
        filas.push(`${i},${_num(n.positions[i * 3], 4)},${_num(n.positions[i * 3 + 1], 4)},${_num(n.positions[i * 3 + 2], 4)},${r},${g},${b},${c}`);
    }
    return filas.join('\n') + '\n';
}

/* ───────────────────────── ZIP mínimo (respaldo de JSZip) ───────────────────────── */

let _tablaCRC = null;

/** Construye (una sola vez) la tabla del CRC-32 IEEE 802.3. */
function _crcTabla() {
    if (_tablaCRC) return _tablaCRC;
    const tabla = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        tabla[i] = c >>> 0;
    }
    _tablaCRC = tabla;
    return tabla;
}

/**
 * CRC-32 estándar de un bloque de bytes.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function _crc32(bytes) {
    const tabla = _crcTabla();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = tabla[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Convierte una fecha a la pareja (hora, fecha) del formato MS-DOS. */
function _fechaDOS(fecha) {
    const d = fecha instanceof Date && !Number.isNaN(fecha.getTime()) ? fecha : new Date();
    const anio = Math.max(1980, d.getFullYear());
    const hora = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    const dia = (((anio - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { hora: hora & 0xffff, dia: dia & 0xffff };
}

/**
 * Descomprime un bloque *raw deflate* usando `DecompressionStream`.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function _inflarRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('El paquete está comprimido (deflate) y este navegador no puede descomprimirlo sin JSZip.');
    }
    const flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(flujo).arrayBuffer();
    return new Uint8Array(buf);
}

/**
 * Lector ZIP mínimo propio: recorre el directorio central y devuelve el
 * contenido de cada entrada. Admite el método 0 (store) y el 8 (deflate).
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function leerZip(buffer) {
    const bytes = _aBytes(buffer);
    if (bytes.length < 22) throw new Error('Archivo ZIP inválido: demasiado corto.');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Localiza el "End Of Central Directory" buscando su firma desde el final.
    let eocd = -1;
    const minimo = Math.max(0, bytes.length - 22 - 0xFFFF);
    for (let i = bytes.length - 22; i >= minimo; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Archivo ZIP inválido: no se encontró el directorio central (EOCD).');

    const totalEntradas = dv.getUint16(eocd + 10, true);
    let desplazamiento = dv.getUint32(eocd + 16, true);
    const salida = new Map();

    for (let n = 0; n < totalEntradas; n++) {
        if (desplazamiento + 46 > bytes.length || dv.getUint32(desplazamiento, true) !== 0x02014b50) {
            throw new Error('Archivo ZIP inválido: entrada del directorio central corrupta.');
        }
        const metodo = dv.getUint16(desplazamiento + 10, true);
        const tamComprimido = dv.getUint32(desplazamiento + 20, true);
        const largoNombre = dv.getUint16(desplazamiento + 28, true);
        const largoExtra = dv.getUint16(desplazamiento + 30, true);
        const largoComentario = dv.getUint16(desplazamiento + 32, true);
        const offsetLocal = dv.getUint32(desplazamiento + 42, true);
        const nombre = _textDecoder.decode(bytes.subarray(desplazamiento + 46, desplazamiento + 46 + largoNombre));
        desplazamiento += 46 + largoNombre + largoExtra + largoComentario;

        if (nombre.endsWith('/')) continue; // directorio
        if (offsetLocal + 30 > bytes.length || dv.getUint32(offsetLocal, true) !== 0x04034b50) {
            throw new Error(`Archivo ZIP inválido: encabezado local corrupto en "${nombre}".`);
        }
        const nombreLocal = dv.getUint16(offsetLocal + 26, true);
        const extraLocal = dv.getUint16(offsetLocal + 28, true);
        const inicio = offsetLocal + 30 + nombreLocal + extraLocal;
        const crudo = bytes.subarray(inicio, inicio + tamComprimido);

        if (metodo === 0) salida.set(nombre, crudo);
        else if (metodo === 8) salida.set(nombre, await _inflarRaw(crudo));
        else throw new Error(`Archivo ZIP inválido: método de compresión ${metodo} no soportado en "${nombre}".`);
    }
    return salida;
}

/**
 * Escritor ZIP mínimo propio (método "store", sin compresión). El resultado es
 * un ZIP válido para `unzip`, JSZip y el Finder de macOS.
 *
 * @param {Array<{nombre:string, datos:(string|Uint8Array|ArrayBuffer)}>} entradas
 * @param {{tipo?:string}} [opciones] Tipo MIME del Blob resultante.
 * @returns {Blob}
 */
export function crearZip(entradas, { tipo = 'application/zip' } = {}) {
    if (!Array.isArray(entradas) || entradas.length === 0) {
        throw new Error('No hay entradas para crear el ZIP.');
    }
    const { hora, dia } = _fechaDOS(new Date());
    const locales = [];
    const centrales = [];
    let desplazamiento = 0;

    for (const entrada of entradas) {
        const nombreBytes = _textEncoder.encode(entrada.nombre);
        const datos = typeof entrada.datos === 'string' ? _textEncoder.encode(entrada.datos) : _aBytes(entrada.datos);
        const crc = _crc32(datos);
        // Bit 11 = nombre en UTF-8 (sólo si el nombre no es ASCII puro).
        const bandera = /^[\x20-\x7e]*$/.test(entrada.nombre) ? 0 : 0x0800;

        const local = new Uint8Array(30 + nombreBytes.length);
        const dvl = new DataView(local.buffer);
        dvl.setUint32(0, 0x04034b50, true);
        dvl.setUint16(4, 20, true);            // versión necesaria: 2.0
        dvl.setUint16(6, bandera, true);
        dvl.setUint16(8, 0, true);             // método 0 = store
        dvl.setUint16(10, hora, true);
        dvl.setUint16(12, dia, true);
        dvl.setUint32(14, crc, true);
        dvl.setUint32(18, datos.length, true);
        dvl.setUint32(22, datos.length, true);
        dvl.setUint16(26, nombreBytes.length, true);
        dvl.setUint16(28, 0, true);
        local.set(nombreBytes, 30);
        locales.push(local, datos);

        const central = new Uint8Array(46 + nombreBytes.length);
        const dvc = new DataView(central.buffer);
        dvc.setUint32(0, 0x02014b50, true);
        dvc.setUint16(4, 20, true);            // versión del creador
        dvc.setUint16(6, 20, true);            // versión necesaria
        dvc.setUint16(8, bandera, true);
        dvc.setUint16(10, 0, true);
        dvc.setUint16(12, hora, true);
        dvc.setUint16(14, dia, true);
        dvc.setUint32(16, crc, true);
        dvc.setUint32(20, datos.length, true);
        dvc.setUint32(24, datos.length, true);
        dvc.setUint16(28, nombreBytes.length, true);
        dvc.setUint32(42, desplazamiento, true); // desplazamiento del encabezado local
        central.set(nombreBytes, 46);
        centrales.push(central);

        desplazamiento += local.length + datos.length;
    }

    let tamCentral = 0;
    for (const c of centrales) tamCentral += c.length;

    const fin = new Uint8Array(22);
    const dvf = new DataView(fin.buffer);
    dvf.setUint32(0, 0x06054b50, true);
    dvf.setUint16(8, centrales.length, true);
    dvf.setUint16(10, centrales.length, true);
    dvf.setUint32(12, tamCentral, true);
    dvf.setUint32(16, desplazamiento, true);

    return new Blob([...locales, ...centrales, fin], { type: tipo });
}

/* ───────────────────────── Paquete .josescan ───────────────────────── */

/** Codifica bytes a base64 en bloques (evita desbordar la pila con `apply`). */
function _base64Desde(bytes) {
    let binario = '';
    const bloque = 0x8000;
    for (let i = 0; i < bytes.length; i += bloque) {
        binario += String.fromCharCode.apply(null, bytes.subarray(i, i + bloque));
    }
    if (typeof btoa === 'function') return btoa(binario);
    /* Respaldo fuera del navegador (pruebas en Node). */
    // eslint-disable-next-line no-undef
    return Buffer.from(bytes).toString('base64');
}

/** Decodifica una cadena base64 (o un dataURL completo) a bytes. */
function _bytesDesdeBase64(texto) {
    const limpio = String(texto).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (typeof atob === 'function') {
        const binario = atob(limpio);
        const salida = new Uint8Array(binario.length);
        for (let i = 0; i < binario.length; i++) salida[i] = binario.charCodeAt(i);
        return salida;
    }
    // eslint-disable-next-line no-undef
    return new Uint8Array(Buffer.from(limpio, 'base64'));
}

/** Deduce el tipo MIME de una miniatura por el nombre del archivo. */
function _mimeMiniatura(nombre) {
    const n = String(nombre || '').toLowerCase();
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
}

/**
 * Abre un paquete `.josescan` y devuelve su contenido ya interpretado.
 *
 * Tolera la ausencia de cualquier archivo opcional; sólo exige `escaneo.json`.
 *
 * @param {ArrayBuffer|Uint8Array|Blob} buffer
 * @returns {Promise<{meta:object, nube:object|null, malla:object|null, miniatura:string|null, huella:object|null}>}
 * @throws {Error} Si el ZIP es inválido o falta `escaneo.json`.
 */
export async function parseScanBundle(buffer) {
    let bytes;
    if (typeof Blob !== 'undefined' && buffer instanceof Blob) bytes = new Uint8Array(await buffer.arrayBuffer());
    else bytes = _aBytes(buffer);

    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        throw new Error('El archivo no es un paquete .josescan válido (no empieza por la firma ZIP "PK").');
    }

    /** @type {Map<string, Uint8Array>} */
    let contenido = new Map();
    const JSZipGlobal = (typeof window !== 'undefined' && window.JSZip) ? window.JSZip
        : (typeof globalThis !== 'undefined' && globalThis.JSZip ? globalThis.JSZip : null);

    if (JSZipGlobal) {
        const zip = await JSZipGlobal.loadAsync(bytes);
        const nombres = Object.keys(zip.files);
        for (const nombre of nombres) {
            const archivo = zip.files[nombre];
            if (!archivo || archivo.dir) continue;
            contenido.set(nombre, await archivo.async('uint8array'));
        }
    } else {
        contenido = await leerZip(bytes);
    }

    /** Busca una entrada por nombre exacto o por su nombre base (rutas anidadas). */
    const buscar = (nombre) => {
        if (contenido.has(nombre)) return contenido.get(nombre);
        for (const [clave, valor] of contenido) {
            const base = clave.split('/').pop();
            if (base === nombre) return valor;
        }
        return null;
    };

    const crudoMeta = buscar(ARCHIVOS_PAQUETE.meta);
    if (!crudoMeta) throw new Error('Paquete .josescan inválido: falta "escaneo.json".');

    let meta;
    try {
        meta = JSON.parse(_textDecoder.decode(crudoMeta));
    } catch (e) {
        throw new Error(`Paquete .josescan inválido: "escaneo.json" no es JSON válido (${e.message}).`);
    }

    const nombreNube = (meta && meta.archivoNube) || ARCHIVOS_PAQUETE.nube;
    const nombreMalla = (meta && meta.archivoMalla) || ARCHIVOS_PAQUETE.malla;
    const nombreMini = (meta && meta.archivoMiniatura) || ARCHIVOS_PAQUETE.miniatura;

    let nube = null;
    const crudoNube = buscar(nombreNube) || buscar(ARCHIVOS_PAQUETE.nube);
    if (crudoNube && crudoNube.length > 0) nube = parsePLY(crudoNube);

    let malla = null;
    const crudoMalla = buscar(nombreMalla) || buscar(ARCHIVOS_PAQUETE.malla);
    if (crudoMalla && crudoMalla.length > 0) malla = parseOBJ(_textDecoder.decode(crudoMalla));

    let miniatura = null;
    const crudoMini = buscar(nombreMini) || buscar(ARCHIVOS_PAQUETE.miniatura);
    if (crudoMini && crudoMini.length > 0) {
        miniatura = `data:${_mimeMiniatura(nombreMini)};base64,${_base64Desde(crudoMini)}`;
    }

    let huella = null;
    const crudoHuella = buscar(ARCHIVOS_PAQUETE.huella);
    if (crudoHuella && crudoHuella.length > 0) {
        try { huella = JSON.parse(_textDecoder.decode(crudoHuella)); } catch (e) { huella = null; }
    }

    return { meta, nube, malla, miniatura, huella };
}

/**
 * Arma un paquete `.josescan` (ZIP) con los archivos del contrato §1.
 *
 * Usa `window.JSZip` (con compresión DEFLATE) cuando está disponible; si no,
 * usa el escritor ZIP propio con método "store".
 *
 * @param {{meta:object, nube?:object, malla?:object, miniatura?:string|null, huella?:object|null}} paquete
 * @returns {Promise<Blob>}
 * @throws {Error} Si faltan los metadatos o no hay ni nube ni malla.
 */
export async function buildScanBundle({ meta, nube, malla, miniatura, huella } = {}) {
    if (!meta || typeof meta !== 'object') throw new Error('No se puede armar el paquete: faltan los metadatos del escaneo.');
    if (!nube && !malla) throw new Error('No se puede armar el paquete: debe incluir al menos la nube de puntos o la malla.');

    const metaFinal = { ...meta };
    metaFinal.formato = metaFinal.formato || FORMATO_ACTUAL;
    metaFinal.archivoNube = nube ? ARCHIVOS_PAQUETE.nube : null;
    metaFinal.archivoMalla = malla ? ARCHIVOS_PAQUETE.malla : null;
    metaFinal.archivoMiniatura = miniatura ? ARCHIVOS_PAQUETE.miniatura : null;

    const entradas = [];
    entradas.push({ nombre: ARCHIVOS_PAQUETE.meta, datos: JSON.stringify(metaFinal, null, 2) });

    if (nube) {
        // La nube puede venir ya serializada (ArrayBuffer de PLY) o como objeto.
        const datosNube = (nube instanceof ArrayBuffer || ArrayBuffer.isView(nube))
            ? _aBytes(nube)
            : _aBytes(writePLY(nube, { binario: true }));
        entradas.push({ nombre: ARCHIVOS_PAQUETE.nube, datos: datosNube });
    }
    if (malla) {
        const datosMalla = typeof malla === 'string' ? malla : writeOBJ(malla);
        entradas.push({ nombre: ARCHIVOS_PAQUETE.malla, datos: datosMalla });
    }
    if (miniatura) {
        entradas.push({ nombre: ARCHIVOS_PAQUETE.miniatura, datos: _bytesDesdeBase64(miniatura) });
    }
    if (huella) {
        entradas.push({
            nombre: ARCHIVOS_PAQUETE.huella,
            datos: typeof huella === 'string' ? huella : JSON.stringify(huella, null, 2)
        });
    }

    const JSZipGlobal = (typeof window !== 'undefined' && window.JSZip) ? window.JSZip
        : (typeof globalThis !== 'undefined' && globalThis.JSZip ? globalThis.JSZip : null);

    if (JSZipGlobal) {
        const zip = new JSZipGlobal();
        for (const entrada of entradas) zip.file(entrada.nombre, entrada.datos);
        return zip.generateAsync({
            type: 'blob',
            mimeType: 'application/octet-stream',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });
    }
    return crearZip(entradas, { tipo: 'application/octet-stream' });
}

/* ───────────────────────── Validación de metadatos ───────────────────────── */

/** Verdadero si el valor es una cadena ISO-8601 interpretable. */
function _esFechaISO(valor) {
    if (typeof valor !== 'string' || valor.length < 10) return false;
    const t = Date.parse(valor);
    return Number.isFinite(t);
}

/** Verdadero si el valor es un entero finito mayor o igual que cero. */
function _esEnteroNoNegativo(valor) {
    return Number.isFinite(valor) && Math.floor(valor) === valor && valor >= 0;
}

/** Verdadero si el valor es una tripleta numérica. */
function _esTripleta(valor) {
    return Array.isArray(valor) && valor.length === 3 && valor.every((v) => Number.isFinite(v));
}

/**
 * Valida un `escaneo.json` contra el contrato `josescan/1.0`.
 *
 * @param {object} meta
 * @returns {{valido:boolean, errores:string[]}}
 */
export function validarMetadatos(meta) {
    const errores = [];
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        return { valido: false, errores: ['Los metadatos deben ser un objeto JSON.'] };
    }

    if (meta.formato !== FORMATO_ACTUAL) {
        errores.push(`El campo "formato" debe ser "${FORMATO_ACTUAL}" (se recibió "${meta.formato}").`);
    }
    if (typeof meta.id !== 'string' || meta.id.trim() === '') {
        errores.push('El campo "id" es obligatorio y debe ser una cadena no vacía.');
    }
    if (typeof meta.nombre !== 'string' || meta.nombre.trim() === '') {
        errores.push('El campo "nombre" es obligatorio y debe ser una cadena no vacía.');
    }
    if (!_esFechaISO(meta.creado)) {
        errores.push('El campo "creado" debe ser una fecha ISO-8601 (por ejemplo 2026-09-05T14:22:31Z).');
    }
    if (!MARCOS_VALIDOS.includes(meta.marco)) {
        errores.push(`El campo "marco" debe ser "arkit" o "enu" (se recibió "${meta.marco}").`);
    }

    for (const campo of ['puntos', 'vertices', 'triangulos']) {
        if (meta[campo] !== undefined && meta[campo] !== null && !_esEnteroNoNegativo(meta[campo])) {
            errores.push(`El campo "${campo}" debe ser un entero mayor o igual que cero.`);
        }
    }
    if (meta.duracionSegundos !== undefined && meta.duracionSegundos !== null && !(Number.isFinite(meta.duracionSegundos) && meta.duracionSegundos >= 0)) {
        errores.push('El campo "duracionSegundos" debe ser un número mayor o igual que cero.');
    }
    if (meta.puntos === 0 && meta.triangulos === 0 && meta.vertices === 0) {
        errores.push('El escaneo no contiene ni puntos ni triángulos.');
    }

    if (meta.geo !== undefined && meta.geo !== null) {
        const g = meta.geo;
        if (typeof g !== 'object' || Array.isArray(g)) {
            errores.push('El campo "geo" debe ser un objeto.');
        } else {
            if (!Number.isFinite(g.latitude) || g.latitude < -90 || g.latitude > 90) {
                errores.push('El campo "geo.latitude" debe ser un número entre -90 y 90.');
            }
            if (!Number.isFinite(g.longitude) || g.longitude < -180 || g.longitude > 180) {
                errores.push('El campo "geo.longitude" debe ser un número entre -180 y 180.');
            }
            if (g.altitude !== undefined && g.altitude !== null && !Number.isFinite(g.altitude)) {
                errores.push('El campo "geo.altitude" debe ser numérico.');
            }
            if (g.timestamp !== undefined && g.timestamp !== null && !_esFechaISO(g.timestamp)) {
                errores.push('El campo "geo.timestamp" debe ser una fecha ISO-8601.');
            }
            for (const campo of ['norte', 'este']) {
                if (g[campo] !== undefined && g[campo] !== null && !Number.isFinite(g[campo])) {
                    errores.push(`El campo "geo.${campo}" debe ser numérico.`);
                }
            }
        }
    }

    if (meta.bbox !== undefined && meta.bbox !== null) {
        const b = meta.bbox;
        if (typeof b !== 'object' || !_esTripleta(b.min) || !_esTripleta(b.max)) {
            errores.push('El campo "bbox" debe tener "min" y "max" como arreglos de tres números.');
        } else if (b.min.some((v, i) => v > b.max[i])) {
            errores.push('El campo "bbox" es inconsistente: algún "min" es mayor que su "max".');
        }
    }

    if (meta.mediciones !== undefined && meta.mediciones !== null && !Array.isArray(meta.mediciones)) {
        errores.push('El campo "mediciones" debe ser un arreglo.');
    }
    for (const campo of ['nombre', 'dispositivo', 'sistema', 'sensor', 'proyecto', 'notas']) {
        const v = meta[campo];
        if (v !== undefined && v !== null && typeof v !== 'string') {
            errores.push(`El campo "${campo}" debe ser una cadena de texto.`);
        }
    }

    return { valido: errores.length === 0, errores };
}
