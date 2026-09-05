/**
 * JoseScan — Visor 3D de escaneos LiDAR (nubes de puntos y mallas)
 * ---------------------------------------------------------------
 * Módulo ES nativo para la PWA JoseMaps. Sin bundler y sin dependencias npm:
 * three.js se descarga bajo demanda desde CDN (con respaldos) y se cachea.
 *
 * Pensado para uso en campo con un celular en pleno sol:
 *  - controles táctiles propios (órbita, pellizco, paneo de dos dedos),
 *  - colores de alto contraste y etiquetas legibles,
 *  - carga progresiva de nubes grandes para no congelar el hilo principal,
 *  - pausa del bucle de render cuando la vista no está visible (batería),
 *  - liberación rigurosa de recursos en destruir().
 *
 * Marcos de coordenadas (ver docs/FORMATO-ESCANEO.md):
 *  - 'arkit' → +X derecha, +Y arriba, −Z hacia la cámara  (vertical = Y)
 *  - 'enu'   → +X Este, +Y Norte, +Z Arriba (metros)      (vertical = Z)
 *
 * Todo el contenido del escaneo vive dentro de un grupo raíz que se rota para
 * que el "arriba" del modelo coincida con +Y del mundo de three.js. Así los
 * controles de cámara son siempre Y-arriba, sin casos especiales.
 *
 * @module js/lidar-viewer
 */

/* ------------------------------------------------------------------------- */
/* Carga de three.js desde CDN                                               */
/* ------------------------------------------------------------------------- */

/** CDNs en orden de preferencia. */
const CDN_THREE = [
    'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js',
    'https://unpkg.com/three@0.160.0/build/three.module.js'
];

const MENSAJE_SIN_THREE =
    'No se pudo cargar la librería 3D (three.js). Se requiere conexión a ' +
    'internet la primera vez que abres el visor; después queda guardada en la ' +
    'caché del navegador y funciona sin señal.';

/** Promesa cacheada del módulo THREE (una sola descarga por sesión). */
let _promesaThree = null;

/**
 * Carga three.js desde CDN una sola vez; devuelve el módulo THREE.
 * Intenta cada CDN en orden y cachea la promesa resultante. Si todos fallan,
 * limpia la caché para permitir un reintento posterior (por ejemplo, cuando el
 * usuario recupera señal) y lanza un error en español.
 *
 * @returns {Promise<object>} módulo THREE
 */
export async function cargarThree() {
    if (_promesaThree) return _promesaThree;

    _promesaThree = (async () => {
        const fallos = [];
        for (const url of CDN_THREE) {
            try {
                const modulo = await import(/* @vite-ignore */ url);
                // Verificación mínima de que es realmente three.js.
                if (modulo && (modulo.Scene || (modulo.default && modulo.default.Scene))) {
                    return modulo.Scene ? modulo : modulo.default;
                }
                fallos.push(`${url}: módulo inesperado`);
            } catch (err) {
                fallos.push(`${url}: ${err && err.message ? err.message : err}`);
            }
        }
        // Permitir reintentar más adelante.
        _promesaThree = null;
        const error = new Error(MENSAJE_SIN_THREE);
        error.detalle = fallos.join(' | ');
        throw error;
    })();

    return _promesaThree;
}

/* ------------------------------------------------------------------------- */
/* Utilidades de color                                                        */
/* ------------------------------------------------------------------------- */

/** Paradas de la rampa de altura: azul → cian → verde → ámbar → rojo. */
const RAMPA_ALTURA = [
    [0.145, 0.388, 0.922], // #2563eb azul
    [0.133, 0.827, 0.933], // #22d3ee cian
    [0.063, 0.725, 0.506], // #10b981 verde
    [0.961, 0.620, 0.043], // #f59e0b ámbar
    [0.937, 0.267, 0.267]  // #ef4444 rojo
];

/** Colores por nivel de confianza ARKit: 0 baja, 1 media, 2 alta. */
const COLOR_CONFIANZA = [
    [0.937, 0.267, 0.267], // rojo
    [0.961, 0.620, 0.043], // ámbar
    [0.063, 0.725, 0.506]  // verde
];

/**
 * Evalúa la rampa continua de altura.
 * @param {number} t valor normalizado 0..1
 * @param {Float32Array|number[]} salida arreglo destino
 * @param {number} i índice base (se escriben i, i+1, i+2)
 */
function evaluarRampa(t, salida, i) {
    const u = t <= 0 ? 0 : (t >= 1 ? 1 : t);
    const escalado = u * (RAMPA_ALTURA.length - 1);
    let idx = Math.floor(escalado);
    if (idx >= RAMPA_ALTURA.length - 1) idx = RAMPA_ALTURA.length - 2;
    const f = escalado - idx;
    const a = RAMPA_ALTURA[idx];
    const b = RAMPA_ALTURA[idx + 1];
    salida[i] = a[0] + (b[0] - a[0]) * f;
    salida[i + 1] = a[1] + (b[1] - a[1]) * f;
    salida[i + 2] = a[2] + (b[2] - a[2]) * f;
}

/** Formatea metros con dos decimales y coma decimal (es-CO). */
function formatearMetros(valor) {
    return `${Number(valor).toLocaleString('es-CO', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} m`;
}

/* ------------------------------------------------------------------------- */
/* Visor                                                                      */
/* ------------------------------------------------------------------------- */

const EVENTOS_VALIDOS = ['listo', 'medicion', 'error', 'progreso'];

/** Umbral de puntos a partir del cual la subida de atributos se hace por trozos. */
const LIMITE_CARGA_PROGRESIVA = 300000;

/** Tamaño de cada trozo en la carga progresiva (en puntos). */
const TROZO_PUNTOS = 60000;

export class ScanViewer {
    /**
     * @param {HTMLElement|string} contenedor elemento (o selector) que aloja el lienzo
     * @param {{fondo?: string, tamanoPunto?: number, modo?: string}} [opciones]
     */
    constructor(contenedor, opciones = {}) {
        const nodo = typeof contenedor === 'string'
            ? document.querySelector(contenedor)
            : contenedor;
        if (!nodo || !nodo.appendChild) {
            throw new Error('ScanViewer: se requiere un contenedor válido del DOM.');
        }

        /** @type {HTMLElement} */
        this.contenedor = nodo;
        this.opciones = {
            fondo: opciones.fondo || '#0b1020',
            tamanoPunto: Number(opciones.tamanoPunto) > 0 ? Number(opciones.tamanoPunto) : 2,
            modo: opciones.modo || 'puntos'
        };

        // --- Estado general -------------------------------------------------
        this.THREE = null;
        this.escena = null;
        this.camara = null;
        this.renderizador = null;
        this.raiz = null;          // grupo con la geometría del escaneo (coords del modelo)
        this.nube = null;          // THREE.Points
        this.malla = null;         // THREE.Mesh
        this.mallaAlambre = null;  // THREE.Mesh con material wireframe
        this.rejilla = null;       // THREE.GridHelper (plano horizontal del mundo)
        this.grupoEjes = null;
        this.grupoMedicion = null;

        this.destruido = false;
        this._iniciado = false;
        this._modo = this.opciones.modo;
        this._coloreado = 'rgb';
        this._tamanoPunto = this.opciones.tamanoPunto;
        this._mostrarAlambre = false;
        this._marco = 'enu';
        this._escala = 10;              // diagonal aproximada del modelo (m)
        this._umbralPuntos = 0.05;      // threshold del raycaster para Points

        // Datos crudos de la nube (para recolorear sin volver a cargar).
        this._datos = null;   // { positions, colors, confidences, count, ejeVertical, minV, maxV }

        // --- Eventos --------------------------------------------------------
        this._oyentes = new Map();
        for (const nombre of EVENTOS_VALIDOS) this._oyentes.set(nombre, new Set());

        // --- Cámara orbital (coordenadas esféricas alrededor de un objetivo) -
        this._objetivo = null;   // THREE.Vector3, se crea al iniciar
        this._radio = 12;
        this._theta = Math.PI * 0.25;   // azimut
        this._phi = Math.PI * 0.32;     // cenital (0 = cenit)
        this._radioMin = 0.05;
        this._radioMax = 5000;

        // --- Punteros -------------------------------------------------------
        this._punteros = new Map();
        this._pellizco = null;
        this._medicionActiva = false;
        this._mediciones = [];
        this._puntoPendiente = null;

        // --- Bucle ----------------------------------------------------------
        this._idAnimacion = 0;
        this._sucio = true;
        this._visible = true;
        this._pestanaVisible = !document.hidden;
        this._idCargaRAF = 0;
        this._tokenCarga = 0;

        // --- Manejadores enlazados (para poder removerlos en destruir) -------
        this._hPunteroAbajo = this._alPunteroAbajo.bind(this);
        this._hPunteroMueve = this._alPunteroMueve.bind(this);
        this._hPunteroArriba = this._alPunteroArriba.bind(this);
        this._hRueda = this._alRueda.bind(this);
        this._hMenu = (e) => e.preventDefault();
        this._hVisibilidad = this._alCambiarVisibilidad.bind(this);
        this._hPerdidaContexto = (e) => {
            e.preventDefault();
            this._emitir('error', new Error('Se perdió el contexto WebGL. Vuelve a abrir el escaneo.'));
        };

        this._observadorTamano = null;
        this._observadorInterseccion = null;

        // Inicio asíncrono: descarga three.js y arma la escena.
        this.listo = this._inicializar();
        this.listo.catch(() => { /* el error ya se emitió por el evento 'error' */ });
    }

    /* --------------------------------------------------------------------- */
    /* Eventos                                                                */
    /* --------------------------------------------------------------------- */

    /**
     * Suscribe un manejador.
     * @param {'listo'|'medicion'|'error'|'progreso'} evento
     * @param {Function} cb
     */
    on(evento, cb) {
        const conjunto = this._oyentes.get(evento);
        if (conjunto && typeof cb === 'function') conjunto.add(cb);
        return this;
    }

    /**
     * Cancela la suscripción de un manejador.
     * @param {'listo'|'medicion'|'error'|'progreso'} evento
     * @param {Function} cb
     */
    off(evento, cb) {
        const conjunto = this._oyentes.get(evento);
        if (conjunto) conjunto.delete(cb);
        return this;
    }

    /** @private */
    _emitir(evento, dato) {
        const conjunto = this._oyentes.get(evento);
        if (!conjunto || conjunto.size === 0) return;
        for (const cb of Array.from(conjunto)) {
            try {
                cb(dato);
            } catch (err) {
                // Un oyente roto no debe tumbar el visor.
                if (evento !== 'error') {
                    console.error('[JoseScan] Error en oyente de "' + evento + '":', err);
                }
            }
        }
    }

    /* --------------------------------------------------------------------- */
    /* Inicialización                                                         */
    /* --------------------------------------------------------------------- */

    /** @private */
    async _inicializar() {
        let THREE;
        try {
            THREE = await cargarThree();
        } catch (err) {
            this._emitir('error', err);
            throw err;
        }
        if (this.destruido) return;

        this.THREE = THREE;

        const ancho = Math.max(1, this.contenedor.clientWidth || 1);
        const alto = Math.max(1, this.contenedor.clientHeight || 1);

        // Escena y fondo.
        this.escena = new THREE.Scene();
        this.escena.background = new THREE.Color(this.opciones.fondo);

        // Cámara.
        this.camara = new THREE.PerspectiveCamera(55, ancho / alto, 0.05, 4000);
        this.camara.up.set(0, 1, 0);
        this._objetivo = new THREE.Vector3(0, 0, 0);

        // Renderizador.
        this.renderizador = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance'
        });
        this.renderizador.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderizador.setSize(ancho, alto, false);
        if ('outputColorSpace' in this.renderizador && THREE.SRGBColorSpace) {
            this.renderizador.outputColorSpace = THREE.SRGBColorSpace;
        }

        const lienzo = this.renderizador.domElement;
        lienzo.style.display = 'block';
        lienzo.style.width = '100%';
        lienzo.style.height = '100%';
        lienzo.style.touchAction = 'none';   // los gestos los manejamos nosotros
        lienzo.style.outline = 'none';
        lienzo.setAttribute('aria-label', 'Vista 3D del escaneo');
        this.contenedor.appendChild(lienzo);

        // Grupo raíz: contiene el escaneo en coordenadas del modelo.
        this.raiz = new THREE.Group();
        this.raiz.name = 'escaneo';
        this.escena.add(this.raiz);

        // Grupo de mediciones (dentro de la raíz → coordenadas del modelo).
        this.grupoMedicion = new THREE.Group();
        this.grupoMedicion.name = 'mediciones';
        this.raiz.add(this.grupoMedicion);

        // Luces para la malla.
        this.luzHemisferica = new THREE.HemisphereLight(0xcfe6ff, 0x14202f, 2.1);
        this.escena.add(this.luzHemisferica);
        this.luzDireccional = new THREE.DirectionalLight(0xffffff, 1.5);
        this.luzDireccional.position.set(1, 2.2, 1.4);
        this.escena.add(this.luzDireccional);

        // Rejilla y ejes.
        this._construirRejilla(20);
        this._construirEjes(2);

        // Raycaster para medición.
        this._rayo = new THREE.Raycaster();
        this._rayo.params.Points.threshold = this._umbralPuntos;
        this._ndc = new THREE.Vector2();

        this._aplicarMarco('enu');
        this._colocarCamara();

        // Eventos de puntero / rueda.
        lienzo.addEventListener('pointerdown', this._hPunteroAbajo);
        lienzo.addEventListener('pointermove', this._hPunteroMueve);
        lienzo.addEventListener('pointerup', this._hPunteroArriba);
        lienzo.addEventListener('pointercancel', this._hPunteroArriba);
        lienzo.addEventListener('pointerleave', this._hPunteroArriba);
        lienzo.addEventListener('wheel', this._hRueda, { passive: false });
        lienzo.addEventListener('contextmenu', this._hMenu);
        lienzo.addEventListener('webglcontextlost', this._hPerdidaContexto, false);

        // Redimensionado del contenedor.
        if (typeof ResizeObserver !== 'undefined') {
            this._observadorTamano = new ResizeObserver(() => this.redimensionar());
            this._observadorTamano.observe(this.contenedor);
        }

        // Pausa cuando el contenedor sale de pantalla.
        if (typeof IntersectionObserver !== 'undefined') {
            this._observadorInterseccion = new IntersectionObserver((entradas) => {
                for (const entrada of entradas) {
                    this._visible = entrada.isIntersecting;
                }
                this._evaluarBucle();
            }, { threshold: 0.01 });
            this._observadorInterseccion.observe(this.contenedor);
        }

        // Pausa cuando la pestaña queda oculta.
        document.addEventListener('visibilitychange', this._hVisibilidad);

        this._iniciado = true;
        this.setModo(this._modo);
        this._evaluarBucle();
        this._emitir('listo', { tipo: 'visor' });
    }

    /* --------------------------------------------------------------------- */
    /* Marco de coordenadas, rejilla y ejes                                   */
    /* --------------------------------------------------------------------- */

    /**
     * Orienta el grupo raíz para que el eje vertical del modelo apunte a +Y del
     * mundo. Con 'enu' (Z arriba) se aplica una rotación de −90° en X; con
     * 'arkit' (Y arriba) no hace falta rotar.
     * @private
     */
    _aplicarMarco(marco) {
        this._marco = marco === 'arkit' ? 'arkit' : 'enu';
        if (!this.raiz) return;
        this.raiz.rotation.set(this._marco === 'enu' ? -Math.PI / 2 : 0, 0, 0);
        this.raiz.updateMatrixWorld(true);
        this._construirEjes(Math.max(2, this._escala * 0.18));
    }

    /** Índice del eje vertical en coordenadas del modelo: Y (1) o Z (2). @private */
    get _ejeVertical() {
        return this._marco === 'arkit' ? 1 : 2;
    }

    /**
     * Rejilla de referencia de 1 m, en el plano horizontal del mundo (XZ).
     * @private
     */
    _construirRejilla(tamano) {
        const THREE = this.THREE;
        if (!THREE) return;
        const lado = Math.max(4, Math.min(400, Math.ceil(tamano)));
        if (this.rejilla) {
            this.escena.remove(this.rejilla);
            this._liberarObjeto(this.rejilla);
            this.rejilla = null;
        }
        // divisiones = lado → celdas de exactamente 1 m
        this.rejilla = new THREE.GridHelper(lado, lado, 0x2f6f8f, 0x1b2b44);
        this.rejilla.material.transparent = true;
        this.rejilla.material.opacity = 0.55;
        this.rejilla.material.depthWrite = false;
        this.rejilla.name = 'rejilla-1m';
        this.escena.add(this.rejilla);
        this._sucio = true;
    }

    /**
     * Ejes rotulados en español. Se construyen en coordenadas del modelo (dentro
     * del grupo raíz): Este rojo, Norte verde, Arriba azul.
     * En marco 'arkit' los rótulos horizontales se ajustan (X y Frente), porque
     * no hay orientación geográfica confiable.
     * @private
     */
    _construirEjes(largo) {
        const THREE = this.THREE;
        if (!THREE || !this.raiz) return;

        if (this.grupoEjes) {
            this.raiz.remove(this.grupoEjes);
            this._liberarObjeto(this.grupoEjes);
            this.grupoEjes = null;
        }

        const L = Math.max(0.5, largo);
        const grupo = new THREE.Group();
        grupo.name = 'ejes';

        const esEnu = this._marco === 'enu';
        // [dirección en coords del modelo, color, rótulo]
        const definicion = esEnu
            ? [
                [[L, 0, 0], 0xef4444, 'Este'],
                [[0, L, 0], 0x22c55e, 'Norte'],
                [[0, 0, L], 0x3b82f6, 'Arriba']
            ]
            : [
                [[L, 0, 0], 0xef4444, 'X (derecha)'],
                [[0, 0, -L], 0x22c55e, 'Frente'],
                [[0, L, 0], 0x3b82f6, 'Arriba']
            ];

        for (const [dir, color, rotulo] of definicion) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(
                [0, 0, 0, dir[0], dir[1], dir[2]], 3));
            const mat = new THREE.LineBasicMaterial({
                color,
                depthTest: false,
                transparent: true,
                opacity: 0.95
            });
            const linea = new THREE.Line(geo, mat);
            linea.renderOrder = 5;
            grupo.add(linea);

            const etiqueta = this._crearEtiqueta(rotulo, {
                fondo: 'rgba(7, 11, 20, 0.86)',
                borde: `#${color.toString(16).padStart(6, '0')}`,
                texto: '#f1f5f9'
            });
            if (etiqueta) {
                etiqueta.position.set(dir[0] * 1.06, dir[1] * 1.06, dir[2] * 1.06);
                etiqueta.userData.factorEscala = 0.035;
                grupo.add(etiqueta);
            }
        }

        this.grupoEjes = grupo;
        this.raiz.add(grupo);
        this._sucio = true;
    }

    /* --------------------------------------------------------------------- */
    /* Carga de nube de puntos                                                */
    /* --------------------------------------------------------------------- */

    /**
     * Carga (o reemplaza) la nube de puntos.
     * @param {{positions: Float32Array, colors?: Uint8Array|Float32Array,
     *          confidences?: Uint8Array, count?: number, frame?: string}} datos
     */
    async cargarNube(datos) {
        await this.listo;
        if (this.destruido || !this.THREE) return;

        const THREE = this.THREE;
        const entrada = datos || {};
        const positions = entrada.positions;
        if (!positions || !positions.length) {
            const err = new Error('La nube de puntos está vacía o no tiene posiciones.');
            this._emitir('error', err);
            throw err;
        }

        const total = Math.min(
            Number.isFinite(entrada.count) && entrada.count > 0
                ? Math.floor(entrada.count)
                : Math.floor(positions.length / 3),
            Math.floor(positions.length / 3)
        );

        if (entrada.frame) this._aplicarMarco(entrada.frame);
        this._cancelarCargaProgresiva();
        this._eliminarNube();

        // Posiciones en Float32Array propio (evita depender del búfer de origen).
        const pos = positions instanceof Float32Array && positions.length === total * 3
            ? positions
            : Float32Array.from(positions.subarray
                ? positions.subarray(0, total * 3)
                : positions.slice(0, total * 3));

        // Colores de origen normalizados a 0..1.
        let rgb = null;
        if (entrada.colors && entrada.colors.length >= total * 3) {
            rgb = new Float32Array(total * 3);
            const esByte = entrada.colors instanceof Uint8Array
                || entrada.colors instanceof Uint8ClampedArray;
            const k = esByte ? 1 / 255 : 1;
            for (let i = 0; i < total * 3; i++) rgb[i] = entrada.colors[i] * k;
        }

        const conf = entrada.confidences && entrada.confidences.length >= total
            ? entrada.confidences
            : null;

        // Rango vertical para el coloreado por altura.
        const eje = this._ejeVertical;
        let minV = Infinity;
        let maxV = -Infinity;
        for (let i = 0; i < total; i++) {
            const v = pos[i * 3 + eje];
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        if (!Number.isFinite(minV)) { minV = 0; maxV = 1; }

        this._datos = { pos, rgb, conf, total, minV, maxV };

        // Geometría: los atributos se reservan completos y, si la nube es grande,
        // se suben a la GPU por trozos con requestAnimationFrame.
        const geometria = new THREE.BufferGeometry();
        const atrPos = new THREE.BufferAttribute(new Float32Array(total * 3), 3);
        const atrCol = new THREE.BufferAttribute(new Float32Array(total * 3), 3);
        atrPos.setUsage(THREE.DynamicDrawUsage);
        atrCol.setUsage(THREE.DynamicDrawUsage);
        geometria.setAttribute('position', atrPos);
        geometria.setAttribute('color', atrCol);

        const material = new THREE.PointsMaterial({
            vertexColors: true,
            sizeAttenuation: false,
            size: this._tamanoPunto * this.renderizador.getPixelRatio()
        });

        this.nube = new THREE.Points(geometria, material);
        this.nube.name = 'nube';
        this.nube.frustumCulled = false;
        this.raiz.add(this.nube);

        // Colores del modo actual (sobre el arreglo destino final).
        const destinoColor = atrCol.array;
        this._pintarColores(destinoColor, 0, total);

        // Caja envolvente calculada a mano (los atributos aún están en blanco).
        this._calcularLimites(pos, total, geometria);
        this.setModo(this._modo);

        if (total > LIMITE_CARGA_PROGRESIVA) {
            await this._subirPorTrozos(atrPos, atrCol, pos, destinoColor, total, geometria);
        } else {
            atrPos.array.set(pos.subarray(0, total * 3));
            atrPos.needsUpdate = true;
            atrCol.needsUpdate = true;
            geometria.setDrawRange(0, total);
            this._emitir('progreso', { porcentaje: 100, puntos: total, total });
        }

        if (this.destruido) return;
        this.encuadrar();
        this._emitir('listo', { tipo: 'nube', puntos: total, marco: this._marco });
    }

    /**
     * Sube posiciones y colores a la GPU en trozos, cediendo el hilo entre cada
     * uno para que la interfaz siga respondiendo en un celular.
     * @private
     */
    _subirPorTrozos(atrPos, atrCol, pos, colores, total, geometria) {
        const token = ++this._tokenCarga;
        return new Promise((resolver) => {
            let subidos = 0;
            const paso = () => {
                if (this.destruido || token !== this._tokenCarga) {
                    resolver();
                    return;
                }
                const fin = Math.min(total, subidos + TROZO_PUNTOS);
                const desde = subidos * 3;
                const hasta = fin * 3;

                atrPos.array.set(pos.subarray(desde, hasta), desde);
                this._marcarRango(atrPos, desde, hasta - desde);
                this._marcarRango(atrCol, desde, hasta - desde);
                atrPos.needsUpdate = true;
                atrCol.needsUpdate = true;
                geometria.setDrawRange(0, fin);
                void colores; // ya fueron escritos en el arreglo del atributo

                subidos = fin;
                this._sucio = true;
                this._emitir('progreso', {
                    porcentaje: Math.round((subidos / total) * 100),
                    puntos: subidos,
                    total
                });

                if (subidos < total) {
                    this._idCargaRAF = requestAnimationFrame(paso);
                } else {
                    this._idCargaRAF = 0;
                    resolver();
                }
            };
            this._idCargaRAF = requestAnimationFrame(paso);
        });
    }

    /**
     * Marca un rango parcial del atributo para subirlo con bufferSubData cuando
     * la versión de three lo soporta (r159+ usa addUpdateRange).
     * @private
     */
    _marcarRango(atributo, offset, count) {
        if (typeof atributo.addUpdateRange === 'function') {
            atributo.clearUpdateRanges();
            atributo.addUpdateRange(offset, count);
        } else if (atributo.updateRange) {
            atributo.updateRange.offset = offset;
            atributo.updateRange.count = count;
        }
    }

    /** @private */
    _cancelarCargaProgresiva() {
        this._tokenCarga++;
        if (this._idCargaRAF) {
            cancelAnimationFrame(this._idCargaRAF);
            this._idCargaRAF = 0;
        }
    }

    /** Calcula caja/esfera envolvente a partir de las posiciones crudas. @private */
    _calcularLimites(pos, total, geometria) {
        const THREE = this.THREE;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < total; i++) {
            const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        if (!Number.isFinite(minX)) { minX = minY = minZ = -1; maxX = maxY = maxZ = 1; }
        const caja = new THREE.Box3(
            new THREE.Vector3(minX, minY, minZ),
            new THREE.Vector3(maxX, maxY, maxZ)
        );
        geometria.boundingBox = caja.clone();
        const centro = caja.getCenter(new THREE.Vector3());
        const tam = caja.getSize(new THREE.Vector3());
        geometria.boundingSphere = new THREE.Sphere(centro, tam.length() / 2 || 1);
    }

    /**
     * Rellena el arreglo de colores según el modo de coloreado activo.
     * @private
     */
    _pintarColores(destino, desde, hasta) {
        const d = this._datos;
        if (!d) return;
        const tipo = this._coloreado;

        if (tipo === 'altura') {
            const eje = this._ejeVertical;
            const rango = (d.maxV - d.minV) || 1;
            for (let i = desde; i < hasta; i++) {
                evaluarRampa((d.pos[i * 3 + eje] - d.minV) / rango, destino, i * 3);
            }
            return;
        }

        if (tipo === 'confianza') {
            for (let i = desde; i < hasta; i++) {
                const nivel = d.conf ? Math.min(2, Math.max(0, d.conf[i] | 0)) : 2;
                const c = COLOR_CONFIANZA[nivel];
                destino[i * 3] = c[0];
                destino[i * 3 + 1] = c[1];
                destino[i * 3 + 2] = c[2];
            }
            return;
        }

        // 'rgb' (o cualquier otro valor): color capturado; si no hay, gris claro.
        if (d.rgb) {
            destino.set(d.rgb.subarray(desde * 3, hasta * 3), desde * 3);
        } else {
            for (let i = desde * 3; i < hasta * 3; i += 3) {
                destino[i] = 0.78; destino[i + 1] = 0.84; destino[i + 2] = 0.92;
            }
        }
    }

    /* --------------------------------------------------------------------- */
    /* Carga de malla                                                         */
    /* --------------------------------------------------------------------- */

    /**
     * Carga (o reemplaza) la malla triangular.
     * @param {{positions: Float32Array, normals?: Float32Array,
     *          indices?: Uint32Array|Uint16Array|number[], frame?: string}} datos
     */
    async cargarMalla(datos) {
        await this.listo;
        if (this.destruido || !this.THREE) return;

        const THREE = this.THREE;
        const entrada = datos || {};
        if (!entrada.positions || !entrada.positions.length) {
            const err = new Error('La malla está vacía o no tiene vértices.');
            this._emitir('error', err);
            throw err;
        }

        if (entrada.frame) this._aplicarMarco(entrada.frame);
        this._eliminarMalla();

        const posiciones = entrada.positions instanceof Float32Array
            ? entrada.positions
            : Float32Array.from(entrada.positions);

        const geometria = new THREE.BufferGeometry();
        geometria.setAttribute('position', new THREE.BufferAttribute(posiciones, 3));

        if (entrada.indices && entrada.indices.length) {
            const cantidadVertices = posiciones.length / 3;
            const indices = cantidadVertices > 65535
                ? (entrada.indices instanceof Uint32Array
                    ? entrada.indices : Uint32Array.from(entrada.indices))
                : (entrada.indices instanceof Uint16Array
                    ? entrada.indices : Uint16Array.from(entrada.indices));
            geometria.setIndex(new THREE.BufferAttribute(indices, 1));
        }

        if (entrada.normals && entrada.normals.length >= posiciones.length) {
            const normales = entrada.normals instanceof Float32Array
                ? entrada.normals : Float32Array.from(entrada.normals);
            geometria.setAttribute('normal', new THREE.BufferAttribute(normales, 3));
        } else {
            geometria.computeVertexNormals();
        }
        geometria.computeBoundingBox();
        geometria.computeBoundingSphere();

        const material = new THREE.MeshStandardMaterial({
            color: 0xb8c6d9,
            roughness: 0.92,
            metalness: 0.04,
            side: THREE.DoubleSide,
            flatShading: false
        });

        this.malla = new THREE.Mesh(geometria, material);
        this.malla.name = 'malla';
        this.raiz.add(this.malla);

        // Alambre opcional: comparte la geometría, sólo cambia el material.
        const materialAlambre = new THREE.MeshBasicMaterial({
            color: 0x22d3ee,
            wireframe: true,
            transparent: true,
            opacity: 0.35,
            depthWrite: false
        });
        this.mallaAlambre = new THREE.Mesh(geometria, materialAlambre);
        this.mallaAlambre.name = 'malla-alambre';
        this.mallaAlambre.visible = this._mostrarAlambre;
        this.raiz.add(this.mallaAlambre);

        this.setModo(this._modo);
        this.encuadrar();

        const triangulos = geometria.index
            ? geometria.index.count / 3
            : posiciones.length / 9;
        this._emitir('progreso', { porcentaje: 100 });
        this._emitir('listo', {
            tipo: 'malla',
            vertices: posiciones.length / 3,
            triangulos: Math.floor(triangulos),
            marco: this._marco
        });
    }

    /* --------------------------------------------------------------------- */
    /* Modos de visualización                                                 */
    /* --------------------------------------------------------------------- */

    /**
     * Cambia el modo de visualización.
     * @param {'puntos'|'malla'|'ambos'} modo
     */
    setModo(modo) {
        if (modo === 'puntos' || modo === 'malla' || modo === 'ambos') {
            this._modo = modo;
        }
        if (this.nube) {
            this.nube.visible = this._modo === 'puntos' || this._modo === 'ambos';
        }
        if (this.malla) {
            this.malla.visible = this._modo === 'malla' || this._modo === 'ambos';
        }
        if (this.mallaAlambre) {
            this.mallaAlambre.visible = this._mostrarAlambre
                && (this._modo === 'malla' || this._modo === 'ambos');
        }
        this._sucio = true;
        return this;
    }

    /**
     * Cambia el coloreado de la nube de puntos.
     * @param {'rgb'|'altura'|'confianza'} tipo
     */
    setColoreado(tipo) {
        const valido = tipo === 'rgb' || tipo === 'altura' || tipo === 'confianza';
        this._coloreado = valido ? tipo : 'rgb';
        if (this.nube && this._datos) {
            const atr = this.nube.geometry.getAttribute('color');
            this._pintarColores(atr.array, 0, this._datos.total);
            if (typeof atr.clearUpdateRanges === 'function') atr.clearUpdateRanges();
            else if (atr.updateRange) { atr.updateRange.offset = 0; atr.updateRange.count = -1; }
            atr.needsUpdate = true;
            this._sucio = true;
        }
        return this;
    }

    /**
     * Tamaño del punto en píxeles CSS (se compensa la densidad de pantalla).
     * @param {number} px
     */
    setTamanoPunto(px) {
        const valor = Number(px);
        if (Number.isFinite(valor) && valor > 0) {
            this._tamanoPunto = Math.min(20, valor);
        }
        if (this.nube && this.renderizador) {
            this.nube.material.size = this._tamanoPunto * this.renderizador.getPixelRatio();
            this.nube.material.needsUpdate = true;
            this._sucio = true;
        }
        return this;
    }

    /**
     * Muestra u oculta el alambre de la malla.
     * @param {boolean} activo
     */
    setAlambre(activo) {
        this._mostrarAlambre = !!activo;
        this.setModo(this._modo);
        return this;
    }

    /* --------------------------------------------------------------------- */
    /* Cámara: encuadre y vistas                                              */
    /* --------------------------------------------------------------------- */

    /** Ajusta la cámara a la caja envolvente del escaneo. */
    encuadrar() {
        if (!this.THREE || !this.camara) return this;
        const THREE = this.THREE;

        this.raiz.updateMatrixWorld(true);
        const caja = new THREE.Box3();
        let hayGeometria = false;
        for (const objeto of [this.nube, this.malla]) {
            if (!objeto) continue;
            const propia = new THREE.Box3().setFromObject(objeto);
            if (propia.isEmpty()) continue;
            caja.union(propia);
            hayGeometria = true;
        }
        if (!hayGeometria) {
            caja.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
        }

        const centro = caja.getCenter(new THREE.Vector3());
        const tamano = caja.getSize(new THREE.Vector3());
        const diagonal = Math.max(0.5, tamano.length());
        this._escala = diagonal;

        const fov = (this.camara.fov * Math.PI) / 180;
        const radio = Math.max(0.5, (diagonal / 2) / Math.sin(fov / 2)) * 1.12;

        this._objetivo.copy(centro);
        this._radio = radio;
        this._radioMin = Math.max(0.05, diagonal * 0.01);
        this._radioMax = diagonal * 25;

        this.camara.near = Math.max(0.01, radio * 0.002);
        this.camara.far = radio * 60 + diagonal * 10;
        this.camara.updateProjectionMatrix();

        // La rejilla se apoya en el nivel más bajo del modelo.
        this._construirRejilla(Math.max(6, Math.ceil(Math.max(tamano.x, tamano.z) * 1.6)));
        if (this.rejilla) {
            this.rejilla.position.set(centro.x, caja.min.y, centro.z);
        }
        this._construirEjes(Math.max(1, diagonal * 0.18));

        // Umbral del raycaster proporcional al tamaño de la escena.
        this._umbralPuntos = Math.max(0.01, diagonal * 0.006);
        if (this._rayo) this._rayo.params.Points.threshold = this._umbralPuntos;

        this._colocarCamara();
        return this;
    }

    /**
     * Vistas predefinidas.
     * @param {'planta'|'frente'|'lado'|'iso'} nombre
     */
    vista(nombre) {
        switch (nombre) {
            case 'planta':  // desde arriba (cenit)
                this._theta = 0;
                this._phi = 0.0025;
                break;
            case 'frente':  // de frente al modelo
                this._theta = 0;
                this._phi = Math.PI / 2;
                break;
            case 'lado':    // desde el Este
                this._theta = Math.PI / 2;
                this._phi = Math.PI / 2;
                break;
            case 'iso':
            default:
                this._theta = Math.PI * 0.25;
                this._phi = Math.PI * 0.32;
                break;
        }
        this._colocarCamara();
        return this;
    }

    /**
     * Coloca la cámara a partir del estado esférico (radio, theta, phi).
     * theta = azimut alrededor de +Y del mundo; phi = ángulo desde el cenit.
     * @private
     */
    _colocarCamara() {
        if (!this.camara || !this._objetivo) return;
        this._phi = Math.min(Math.PI - 0.0025, Math.max(0.0025, this._phi));
        this._radio = Math.min(this._radioMax, Math.max(this._radioMin, this._radio));

        const senoPhi = Math.sin(this._phi);
        this.camara.position.set(
            this._objetivo.x + this._radio * senoPhi * Math.sin(this._theta),
            this._objetivo.y + this._radio * Math.cos(this._phi),
            this._objetivo.z + this._radio * senoPhi * Math.cos(this._theta)
        );
        this.camara.lookAt(this._objetivo);
        this.camara.updateMatrixWorld();

        if (this.luzDireccional) {
            // La luz acompaña a la cámara para que la malla nunca quede en negro.
            this.luzDireccional.position.copy(this.camara.position);
        }
        this._sucio = true;
    }

    /* --------------------------------------------------------------------- */
    /* Controles de órbita propios                                            */
    /* --------------------------------------------------------------------- */
    /*
     * No usamos OrbitControls porque no viene en el bundle principal de three.
     * Implementación:
     *   - Un puntero (dedo o botón izquierdo): órbita. dx→theta, dy→phi.
     *   - Un puntero con botón derecho / medio / tecla Shift: paneo.
     *   - Dos punteros: pellizco para zoom (razón de distancias) y arrastre del
     *     centroide para paneo.
     *   - Rueda del ratón: zoom exponencial.
     * El paneo desplaza el objetivo por los ejes derecha/arriba de la cámara,
     * escalado con la distancia y el FOV para que el modelo "siga al dedo".
     * Un toque corto y sin desplazamiento se interpreta como clic de medición.
     */

    /** @private */
    _alPunteroAbajo(evento) {
        if (this.destruido || !this.renderizador) return;
        const lienzo = this.renderizador.domElement;
        if (typeof lienzo.setPointerCapture === 'function') {
            try { lienzo.setPointerCapture(evento.pointerId); } catch (_) { /* ignorar */ }
        }
        this._punteros.set(evento.pointerId, {
            x: evento.clientX,
            y: evento.clientY,
            xIni: evento.clientX,
            yIni: evento.clientY,
            tIni: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
            recorrido: 0,
            boton: evento.button,
            shift: evento.shiftKey
        });
        if (this._punteros.size === 2) {
            this._pellizco = this._estadoPellizco();
        }
    }

    /** @private */
    _estadoPellizco() {
        const lista = Array.from(this._punteros.values());
        const [a, b] = lista;
        return {
            distancia: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2
        };
    }

    /** @private */
    _alPunteroMueve(evento) {
        if (this.destruido) return;
        const estado = this._punteros.get(evento.pointerId);
        if (!estado) return;

        const dx = evento.clientX - estado.x;
        const dy = evento.clientY - estado.y;
        estado.x = evento.clientX;
        estado.y = evento.clientY;
        estado.recorrido += Math.abs(dx) + Math.abs(dy);

        if (this._punteros.size === 1) {
            const paneando = estado.boton === 2 || estado.boton === 1
                || estado.shift || evento.shiftKey;
            if (paneando) {
                this._panear(dx, dy);
            } else {
                this._orbitar(dx, dy);
            }
            this._colocarCamara();
            return;
        }

        if (this._punteros.size >= 2) {
            const nuevo = this._estadoPellizco();
            const previo = this._pellizco || nuevo;
            const razon = previo.distancia / nuevo.distancia;
            this._radio = this._radio * razon;
            this._panear(nuevo.cx - previo.cx, nuevo.cy - previo.cy);
            this._pellizco = nuevo;
            this._colocarCamara();
        }
    }

    /** @private */
    _alPunteroArriba(evento) {
        if (this.destruido) return;
        const estado = this._punteros.get(evento.pointerId);
        if (!estado) return;
        this._punteros.delete(evento.pointerId);
        if (this._punteros.size < 2) this._pellizco = null;
        if (this._punteros.size === 2) this._pellizco = this._estadoPellizco();

        const lienzo = this.renderizador && this.renderizador.domElement;
        if (lienzo && typeof lienzo.releasePointerCapture === 'function') {
            try { lienzo.releasePointerCapture(evento.pointerId); } catch (_) { /* ignorar */ }
        }

        // ¿Fue un toque corto y quieto? → clic de medición.
        const ahora = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const duracion = ahora - estado.tIni;
        const desplazamiento = Math.hypot(evento.clientX - estado.xIni, evento.clientY - estado.yIni);
        if (this._medicionActiva && evento.type === 'pointerup'
            && duracion < 600 && desplazamiento < 10 && estado.recorrido < 24) {
            this._medirEn(evento.clientX, evento.clientY);
        }
    }

    /** @private */
    _alRueda(evento) {
        if (this.destruido) return;
        evento.preventDefault();
        const paso = evento.deltaMode === 1 ? evento.deltaY * 16 : evento.deltaY;
        this._radio *= Math.exp(paso * 0.0012);
        this._colocarCamara();
    }

    /** Órbita: convierte píxeles arrastrados en ángulos. @private */
    _orbitar(dx, dy) {
        const alto = Math.max(1, this.contenedor.clientHeight || 1);
        this._theta -= (dx / alto) * Math.PI * 2;
        this._phi -= (dy / alto) * Math.PI;
    }

    /** Paneo: mueve el objetivo por los ejes derecha/arriba de la cámara. @private */
    _panear(dx, dy) {
        if (!this.camara) return;
        const THREE = this.THREE;
        const alto = Math.max(1, this.contenedor.clientHeight || 1);
        const fov = (this.camara.fov * Math.PI) / 180;
        // Metros por píxel a la distancia del objetivo.
        const escala = (2 * this._radio * Math.tan(fov / 2)) / alto;

        const derecha = new THREE.Vector3().setFromMatrixColumn(this.camara.matrix, 0);
        const arriba = new THREE.Vector3().setFromMatrixColumn(this.camara.matrix, 1);
        this._objetivo.addScaledVector(derecha, -dx * escala);
        this._objetivo.addScaledVector(arriba, dy * escala);
    }

    /* --------------------------------------------------------------------- */
    /* Medición                                                               */
    /* --------------------------------------------------------------------- */

    /**
     * Activa o desactiva el modo de medición por toques.
     * @param {boolean} activo
     */
    habilitarMedicion(activo) {
        this._medicionActiva = !!activo;
        if (!this._medicionActiva) this._descartarPuntoPendiente();
        if (this.renderizador) {
            this.renderizador.domElement.style.cursor =
                this._medicionActiva ? 'crosshair' : 'grab';
        }
        return this;
    }

    /** Mediciones registradas. @returns {Array<{tipo:string,valor:number,unidad:string,puntos:number[][]}>} */
    get mediciones() {
        return this._mediciones.map((m) => ({
            tipo: m.tipo,
            valor: m.valor,
            unidad: m.unidad,
            puntos: m.puntos.map((p) => p.slice())
        }));
    }

    /** Borra todas las mediciones y sus objetos 3D. */
    limpiarMediciones() {
        this._descartarPuntoPendiente();
        if (this.grupoMedicion) {
            for (const hijo of Array.from(this.grupoMedicion.children)) {
                this.grupoMedicion.remove(hijo);
                this._liberarObjeto(hijo);
            }
        }
        this._mediciones = [];
        this._sucio = true;
        return this;
    }

    /** @private */
    _descartarPuntoPendiente() {
        if (this._puntoPendiente && this._puntoPendiente.marcador && this.grupoMedicion) {
            this.grupoMedicion.remove(this._puntoPendiente.marcador);
            this._liberarObjeto(this._puntoPendiente.marcador);
        }
        this._puntoPendiente = null;
        this._sucio = true;
    }

    /**
     * Lanza un rayo desde la pantalla y registra el punto tocado.
     * @private
     */
    _medirEn(clientX, clientY) {
        if (!this.THREE || !this.camara) return;
        const THREE = this.THREE;
        const lienzo = this.renderizador.domElement;
        const rect = lienzo.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        this._ndc.set(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );
        this._rayo.setFromCamera(this._ndc, this.camara);
        this._rayo.params.Points.threshold = this._umbralPuntos;

        const objetivos = [];
        if (this.nube && this.nube.visible) objetivos.push(this.nube);
        if (this.malla && this.malla.visible) objetivos.push(this.malla);
        if (objetivos.length === 0) return;

        const impactos = this._rayo.intersectObjects(objetivos, false);
        if (!impactos.length) {
            this._emitir('error', new Error('No se encontró geometría en ese punto. Acerca la vista e intenta de nuevo.'));
            return;
        }

        // El punto viene en coordenadas del mundo; lo pasamos al marco del modelo.
        const mundo = impactos[0].point.clone();
        const modelo = this.raiz.worldToLocal(mundo.clone());

        const marcador = this._crearMarcador(modelo);
        this.grupoMedicion.add(marcador);

        if (!this._puntoPendiente) {
            this._puntoPendiente = { punto: modelo, marcador };
            this._sucio = true;
            return;
        }

        const a = this._puntoPendiente.punto;
        const b = modelo;
        const distancia = a.distanceTo(b);

        // Línea entre A y B.
        const geoLinea = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
        const matLinea = new THREE.LineBasicMaterial({
            color: 0xf59e0b,
            depthTest: false,
            transparent: true,
            opacity: 0.98
        });
        const linea = new THREE.Line(geoLinea, matLinea);
        linea.renderOrder = 20;
        this.grupoMedicion.add(linea);

        // Etiqueta con el valor en metros (formato es-CO).
        const etiqueta = this._crearEtiqueta(formatearMetros(distancia), {
            fondo: 'rgba(7, 11, 20, 0.92)',
            borde: '#f59e0b',
            texto: '#ffffff',
            grande: true
        });
        if (etiqueta) {
            etiqueta.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
            etiqueta.userData.factorEscala = 0.045;
            this.grupoMedicion.add(etiqueta);
        }

        const medicion = {
            tipo: 'distancia',
            valor: Number(distancia.toFixed(4)),
            unidad: 'm',
            puntos: [[a.x, a.y, a.z], [b.x, b.y, b.z]],
            texto: formatearMetros(distancia),
            marco: this._marco
        };
        this._mediciones.push(medicion);
        this._puntoPendiente = null;
        this._sucio = true;

        this._emitir('medicion', {
            tipo: medicion.tipo,
            valor: medicion.valor,
            unidad: medicion.unidad,
            puntos: medicion.puntos.map((p) => p.slice()),
            texto: medicion.texto,
            marco: medicion.marco
        });
    }

    /** Esfera pequeña que marca un extremo de la medición. @private */
    _crearMarcador(posicion) {
        const THREE = this.THREE;
        const radio = Math.max(0.008, this._escala * 0.006);
        const geo = new THREE.SphereGeometry(radio, 12, 8);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x22d3ee,
            depthTest: false,
            transparent: true,
            opacity: 0.95
        });
        const esfera = new THREE.Mesh(geo, mat);
        esfera.position.copy(posicion);
        esfera.renderOrder = 21;
        return esfera;
    }

    /**
     * Crea un THREE.Sprite con texto dibujado en un canvas 2D. Alto contraste
     * para que se lea con el celular al sol.
     * @private
     */
    _crearEtiqueta(texto, estilo = {}) {
        const THREE = this.THREE;
        if (!THREE) return null;

        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const tamanoFuente = (estilo.grande ? 46 : 36) * dpr;
        const relleno = 18 * dpr;
        const lienzo = document.createElement('canvas');
        const ctx = lienzo.getContext('2d');
        if (!ctx) return null;

        const fuente = `700 ${tamanoFuente}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
        ctx.font = fuente;
        const anchoTexto = ctx.measureText(texto).width;

        lienzo.width = Math.ceil(anchoTexto + relleno * 2);
        lienzo.height = Math.ceil(tamanoFuente + relleno * 1.4);

        // Tras redimensionar el canvas se pierde el estado: hay que reconfigurar.
        ctx.font = fuente;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const r = 12 * dpr;
        const w = lienzo.width;
        const h = lienzo.height;
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(w - r, 0);
        ctx.quadraticCurveTo(w, 0, w, r);
        ctx.lineTo(w, h - r);
        ctx.quadraticCurveTo(w, h, w - r, h);
        ctx.lineTo(r, h);
        ctx.quadraticCurveTo(0, h, 0, h - r);
        ctx.lineTo(0, r);
        ctx.quadraticCurveTo(0, 0, r, 0);
        ctx.closePath();
        ctx.fillStyle = estilo.fondo || 'rgba(7, 11, 20, 0.9)';
        ctx.fill();
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = estilo.borde || '#10b981';
        ctx.stroke();

        ctx.fillStyle = estilo.texto || '#f1f5f9';
        ctx.fillText(texto, w / 2, h / 2 + dpr);

        const textura = new THREE.CanvasTexture(lienzo);
        textura.needsUpdate = true;
        if ('colorSpace' in textura && THREE.SRGBColorSpace) {
            textura.colorSpace = THREE.SRGBColorSpace;
        }
        textura.minFilter = THREE.LinearFilter;
        textura.magFilter = THREE.LinearFilter;
        textura.generateMipmaps = false;

        const material = new THREE.SpriteMaterial({
            map: textura,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.renderOrder = 30;
        sprite.userData.relacion = w / h;
        sprite.userData.factorEscala = 0.04;
        sprite.userData.esEtiqueta = true;
        return sprite;
    }

    /**
     * Mantiene las etiquetas de tamaño constante en pantalla ajustando su escala
     * según la distancia de la cámara.
     * @private
     */
    _actualizarEtiquetas() {
        const base = this._radio;
        const escalaRaiz = 1; // el grupo raíz sólo rota, no escala
        const ajustar = (objeto) => {
            for (const hijo of objeto.children) {
                if (hijo.userData && hijo.userData.esEtiqueta) {
                    const k = base * (hijo.userData.factorEscala || 0.04) * escalaRaiz;
                    hijo.scale.set(k * (hijo.userData.relacion || 3), k, 1);
                }
                if (hijo.children && hijo.children.length) ajustar(hijo);
            }
        };
        if (this.raiz) ajustar(this.raiz);
    }

    /* --------------------------------------------------------------------- */
    /* Bucle de render, tamaño y captura                                      */
    /* --------------------------------------------------------------------- */

    /** @private */
    _alCambiarVisibilidad() {
        this._pestanaVisible = !document.hidden;
        this._evaluarBucle();
    }

    /** Arranca o detiene el bucle según visibilidad (ahorro de batería). @private */
    _evaluarBucle() {
        if (this.destruido || !this._iniciado) return;
        const debeCorrer = this._visible && this._pestanaVisible;
        if (debeCorrer && !this._idAnimacion) {
            this._sucio = true;
            const paso = () => {
                if (this.destruido) return;
                this._idAnimacion = requestAnimationFrame(paso);
                if (!this._sucio) return;    // sólo dibujamos cuando algo cambió
                this._sucio = false;
                this._dibujar();
            };
            this._idAnimacion = requestAnimationFrame(paso);
        } else if (!debeCorrer && this._idAnimacion) {
            cancelAnimationFrame(this._idAnimacion);
            this._idAnimacion = 0;
        }
    }

    /** @private */
    _dibujar() {
        if (!this.renderizador || !this.escena || !this.camara) return;
        this._actualizarEtiquetas();
        this.renderizador.render(this.escena, this.camara);
    }

    /** Reajusta el lienzo al tamaño actual del contenedor. */
    redimensionar() {
        if (this.destruido || !this.renderizador || !this.camara) return this;
        const ancho = Math.max(1, this.contenedor.clientWidth || 1);
        const alto = Math.max(1, this.contenedor.clientHeight || 1);
        this.renderizador.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderizador.setSize(ancho, alto, false);
        this.camara.aspect = ancho / alto;
        this.camara.updateProjectionMatrix();
        this.setTamanoPunto(this._tamanoPunto);
        this._sucio = true;
        this._dibujar();
        return this;
    }

    /**
     * Captura el lienzo actual.
     * @returns {string} dataURL PNG (cadena vacía si el visor no está listo)
     */
    captura() {
        if (this.destruido || !this.renderizador) return '';
        // Se dibuja justo antes de leer para no depender de preserveDrawingBuffer.
        this._dibujar();
        try {
            return this.renderizador.domElement.toDataURL('image/png');
        } catch (err) {
            this._emitir('error', new Error('No se pudo capturar la vista 3D: ' + err.message));
            return '';
        }
    }

    /* --------------------------------------------------------------------- */
    /* Liberación de recursos                                                 */
    /* --------------------------------------------------------------------- */

    /** @private */
    _liberarMaterial(material) {
        if (!material) return;
        for (const clave of Object.keys(material)) {
            const valor = material[clave];
            if (valor && valor.isTexture && typeof valor.dispose === 'function') {
                valor.dispose();
            }
        }
        if (typeof material.dispose === 'function') material.dispose();
    }

    /**
     * Libera geometrías, materiales y texturas de un objeto y sus hijos.
     * Las geometrías compartidas (malla + alambre) se protegen con un conjunto.
     * @private
     */
    _liberarObjeto(objeto, geometriasOmitidas) {
        if (!objeto || typeof objeto.traverse !== 'function') return;
        objeto.traverse((nodo) => {
            if (nodo.geometry && typeof nodo.geometry.dispose === 'function') {
                if (!geometriasOmitidas || !geometriasOmitidas.has(nodo.geometry)) {
                    nodo.geometry.dispose();
                }
            }
            const material = nodo.material;
            if (Array.isArray(material)) material.forEach((m) => this._liberarMaterial(m));
            else this._liberarMaterial(material);
        });
    }

    /** @private */
    _eliminarNube() {
        if (!this.nube) return;
        this.raiz.remove(this.nube);
        this._liberarObjeto(this.nube);
        this.nube = null;
        this._datos = null;
        this._sucio = true;
    }

    /** @private */
    _eliminarMalla() {
        if (this.mallaAlambre) {
            const compartida = new Set();
            if (this.malla && this.malla.geometry) compartida.add(this.malla.geometry);
            this.raiz.remove(this.mallaAlambre);
            this._liberarObjeto(this.mallaAlambre, compartida);
            this.mallaAlambre = null;
        }
        if (this.malla) {
            this.raiz.remove(this.malla);
            this._liberarObjeto(this.malla);
            this.malla = null;
        }
        this._sucio = true;
    }

    /** Destruye el visor y libera todos los recursos. Es idempotente. */
    destruir() {
        if (this.destruido) return;
        this.destruido = true;

        this._cancelarCargaProgresiva();
        if (this._idAnimacion) {
            cancelAnimationFrame(this._idAnimacion);
            this._idAnimacion = 0;
        }

        if (this._observadorTamano) {
            this._observadorTamano.disconnect();
            this._observadorTamano = null;
        }
        if (this._observadorInterseccion) {
            this._observadorInterseccion.disconnect();
            this._observadorInterseccion = null;
        }
        document.removeEventListener('visibilitychange', this._hVisibilidad);

        if (this.renderizador) {
            const lienzo = this.renderizador.domElement;
            lienzo.removeEventListener('pointerdown', this._hPunteroAbajo);
            lienzo.removeEventListener('pointermove', this._hPunteroMueve);
            lienzo.removeEventListener('pointerup', this._hPunteroArriba);
            lienzo.removeEventListener('pointercancel', this._hPunteroArriba);
            lienzo.removeEventListener('pointerleave', this._hPunteroArriba);
            lienzo.removeEventListener('wheel', this._hRueda);
            lienzo.removeEventListener('contextmenu', this._hMenu);
            lienzo.removeEventListener('webglcontextlost', this._hPerdidaContexto);

            if (this.escena) {
                const compartidas = new Set();
                if (this.malla && this.malla.geometry) compartidas.add(this.malla.geometry);
                this._liberarObjeto(this.escena, null);
                void compartidas; // traverse ya llama dispose() una sola vez por geometría
                this.escena.clear ? this.escena.clear() : null;
            }

            this.renderizador.dispose();
            if (this.renderizador.renderLists) this.renderizador.renderLists.dispose();
            if (typeof this.renderizador.forceContextLoss === 'function') {
                try { this.renderizador.forceContextLoss(); } catch (_) { /* ignorar */ }
            }
            if (lienzo.parentNode === this.contenedor) {
                this.contenedor.removeChild(lienzo);
            }
        }

        this._punteros.clear();
        this._pellizco = null;
        this._mediciones = [];
        this._puntoPendiente = null;
        this._datos = null;

        this.nube = null;
        this.malla = null;
        this.mallaAlambre = null;
        this.rejilla = null;
        this.grupoEjes = null;
        this.grupoMedicion = null;
        this.raiz = null;
        this.escena = null;
        this.camara = null;
        this.renderizador = null;
        this.luzHemisferica = null;
        this.luzDireccional = null;
        this._rayo = null;
        this.THREE = null;

        for (const conjunto of this._oyentes.values()) conjunto.clear();
    }
}

export default ScanViewer;
