# Pruebas del módulo JoseScan (LiDAR)

Suite de pruebas unitarias del módulo web **JoseScan** de la PWA JoseMaps:
lectura y escritura de formatos de escaneo, georreferenciación y almacén local.

Se ejecuta con **Node 22 puro**. No hay `package.json`, ni `npm install`, ni
dependencias externas: sólo `node:test`, `node:assert/strict` y la librería
estándar.

---

## Cómo ejecutar

Desde la raíz del repositorio (`campo-maps/`):

```bash
# 1) Runner nativo, descubriendo automáticamente los tests/*.test.mjs
node --test

# 2) Igual, pero nombrando los archivos de forma explícita
#    (las comillas son importantes: quien expande el patrón es Node, no el shell)
node --test "tests/*.test.mjs"

# 3) Lanzador propio: mismo informe + resumen en español y código de salida
node tests/ejecutar.mjs

# 4) Sólo el resumen, sin el detalle prueba a prueba
node tests/ejecutar.mjs --silencioso
```

Para ejecutar un solo archivo:

```bash
node --test tests/lidar-geo.test.mjs
```

> **Nota sobre `node --test tests/`**
> En la versión de Node de este entorno (v22.22.2) pasar un **directorio** como
> argumento posicional no dispara el descubrimiento de archivos: Node intenta
> ejecutar `tests` como si fuera un módulo y falla con `MODULE_NOT_FOUND`.
> Usa cualquiera de las cuatro formas de arriba.

`node tests/ejecutar.mjs` sale con **código 0** sólo si no falla ninguna prueba;
con cualquier fallo sale con código 1, de modo que sirve tal cual en CI o en un
hook de `pre-commit`.

---

## Archivos

| Archivo | Contenido |
|---|---|
| `ayudantes.mjs` | Utilidades compartidas: carga perezosa de módulos, aserciones con tolerancia, generadores deterministas, doble de IndexedDB y `proj4` mínimo. No contiene pruebas. |
| `lidar-formats.test.mjs` | PLY (binario, ascii, big-endian), OBJ, XYZ, CSV, paquete `.josescan` y `validarMetadatos`. |
| `lidar-geo.test.mjs` | ARKit → ENU, ENU ↔ WGS84, huella GeoJSON, EPSG:9377 y métricas geométricas. |
| `lidar-store.test.mjs` | Ciclo completo del almacén IndexedDB: guardar, listar, obtener, actualizar, exportar, importar y eliminar. |
| `ejecutar.mjs` | Lanzador con resumen en español. |

---

## Qué se cubre

### `js/lidar-formats.js` — contrato de `docs/FORMATO-ESCANEO.md` §1, §2, §4 y §5

- Ida y vuelta `writePLY` → `parsePLY` en **binario** y en **ascii**: posiciones
  con tolerancia `1e-5`, colores `uchar` **exactos** y confianzas **exactas**.
- La cabecera del PLY binario contiene, **en orden**, las once líneas exigidas
  por el contrato (`ply`, `format binary_little_endian 1.0`, `element vertex N`,
  las siete `property` y `end_header`), más los comentarios `JoseScan
  josescan/1.0` y `marco`; el cuerpo mide exactamente `16 · n` bytes.
- `parsePLY` sobre un PLY ascii **escrito a mano** con las propiedades en orden
  inesperado (confianza y color antes que `x/y/z`, y `z/y/x` invertidos) y con
  un elemento `face`.
- `parsePLY` sobre `binary_big_endian`, que el escritor propio nunca produce.
- `parsePLY` lanza `Error` con cabeceras inválidas: sin `ply`, sin `end_header`,
  con un `format` desconocido y con el archivo vacío.
- `parseOBJ` con las cuatro formas de cara (`f a`, `f a/b`, `f a//c`,
  `f a/b/c`), con **índices negativos** y con una cara de **5 vértices**, que
  debe triangularse en abanico (3 triángulos).
- Ida y vuelta `writeOBJ` → `parseOBJ` del cubo de 1 m, comparando los 12
  triángulos por coordenadas para tolerar reordenamientos o deduplicación.
- `writeXYZ`: una línea por punto, tres números separados por espacios, sin
  comas.
- `writeCSV`: número de filas, **coherencia de columnas** analizando el texto
  con un lector RFC 4180 (así se detecta un escapado incorrecto), respeto de
  `{ limite }` y uso de comillas cuando un campo trae coma o comilla.
- `validarMetadatos`: caso válido, formato desconocido, fechas **no ISO-8601**
  (`05/09/2026`, `September 5, 2026`, …) y contadores negativos.
- `buildScanBundle` → `parseScanBundle`: el paquete es un ZIP real (empieza por
  `PK`) y conserva metadatos, nube y malla.

### `js/lidar-geo.js` — contrato §3 y §6

- `arkitAEnu`: rumbo 0 lleva `(1, 2, −3)` a `(1, 3, 2)`; rumbo 180° invierte el
  plano horizontal dejando el vertical intacto; rumbo 90° manda el eje `−Z` al
  eje este–oeste; la **longitud del vector horizontal se conserva** para 8
  rumbos distintos; y la transformación se aplica punto a punto sobre una nube
  entera.
- `ejeVertical` (`enu` → Z, `arkit` → Y), `boundsDe` (forma `{min, max}` como el
  `bbox` del contrato), `distancia3D`, `areaPoligono` (cuadrado de 2 m = 4 m²,
  independiente del sentido de recorrido y del cierre del anillo) y
  `volumenSobreBase` (cubo de 1 m sobre base 0 = 1 m³; y una superficie abierta
  de 1 m² a 2 m de altura = 2 m³, donde la cota de base sí cambia el resultado).
- Ida y vuelta `enuAWgs84` ↔ `wgs84AEnu` con error **< 1 mm** para
  desplazamientos de 1, 10, 100 y 1000 m en las cuatro direcciones desde el
  ancla de Bogotá (4,60971 N — 74,08175 W, 2570 m), más el sentido correcto del
  movimiento y la identidad exacta en el origen.
- `scanAGeoJSON`: `FeatureCollection` con exactamente 2 *features* (`Point` y
  `Polygon`), orden `[lng, lat]`, anillo **cerrado** y rodeando el ancla, y las
  propiedades `id`, `nombre`, `puntos` y `triangulos`. Sin ancla debe degradar
  (lanzar un `Error` explicativo, devolver `null` o una colección vacía), nunca
  inventar coordenadas.
- `scanAMagnaSirgas`: coincide con `js/coords.js` dentro de 0,5 m y cae en el
  rango EPSG:9377 esperado para Bogotá; y **degrada sin lanzar** cuando no hay
  `proj4`.
- `resumenGeo`: cadena en español con separadores de millar **es-CO**
  (`2.067.459`) y sin el agrupamiento en-US; tolera metadatos sin `geo`.

### `js/lidar-store.js` — ciclo completo sobre el doble de IndexedDB

`initScanDB` → `guardarEscaneo` (×3) → `listarEscaneos` (completo, ordenado por
fecha, filtrado por proyecto) → `obtenerEscaneo` (con geometría íntegra) →
`actualizarMeta` (parche que no borra el resto) → `espacioUsado` →
`exportarTodo` → `importarArchivo` con un `.ply` sintético → `eliminarEscaneo`
(borra sólo el indicado y es idempotente).

---

## Qué **no** se cubre (y por qué)

Estas cosas **no son comprobables en Node** y quedan deliberadamente fuera:

- **El sensor LiDAR real.** `ARKit`, `ARSession`, `ARDepthData`,
  `ARConfidenceLevel` y la reconstrucción de escena sólo existen en un iPhone/
  iPad Pro. Aquí sólo se prueba el *formato* que produce el escáner, no el
  escáner.
- **WebXR y `getUserMedia`.** `navigator.xr`, las sesiones inmersivas y el
  acceso a la cámara no tienen implementación en Node ni doble razonable.
- **WebGL / el visor 3D** (`js/lidar-viewer.js`). Requiere un contexto gráfico;
  no hay `canvas.getContext('webgl2')`.
- **La interfaz** (`js/lidar-ui.js`) y la captura (`js/lidar-scanner.js`).
  Dependen del DOM real, de Leaflet y de eventos de usuario.
- **Geolocalización real** (`navigator.geolocation`) y la brújula
  (`deviceorientation`).
- **IndexedDB de verdad.** Se usa un doble en memoria (ver abajo); las cuotas
  del navegador, la persistencia entre sesiones y el comportamiento ante
  `QuotaExceededError` no se ejercitan.
- **`proj4` de verdad.** Se usa una implementación mínima de Transverse
  Mercator; para trabajo topográfico real la referencia sigue siendo
  `js/coords.js` con el `proj4` que carga `index.html`.

---

## Cómo están hechos los dobles

### Doble de IndexedDB (`ayudantes.mjs`)

Implementación en memoria de `indexedDB.open`, `onupgradeneeded`,
`createObjectStore` con `keyPath`, `createIndex`, `transaction`, `objectStore`,
`put` / `add` / `get` / `getAll` / `getAllKeys` / `count` / `delete` / `clear`,
cursores sobre el almacén y sobre índices (`next`, `prev`, `nextunique`,
`prevunique`), `IDBKeyRange` (`only`, `bound`, `lowerBound`, `upperBound`) y el
orden de claves de la especificación (número < fecha < texto < arreglo).

Detalle importante: **`complete` se despacha como tarea, no como microtarea**
(`setTimeout(…, 0)`), igual que en un navegador. Así una transacción sobrevive a
un `await` entre solicitudes, que es el patrón que usa `js/lidar-store.js`.

Los valores se copian con `structuredClone` al escribir y al leer, como hace
IndexedDB de verdad, de modo que los `Float32Array` y `ArrayBuffer` de la
geometría se ejercitan igual que en producción.

Lo que el doble **no** cubre: `versionchange` entre conexiones abiertas,
`onblocked`, índices `multiEntry` sobre claves no-arreglo, y las cuotas reales.
Si alguna función del módulo necesitara algo de eso, la prueba correspondiente
se marca con `t.skip('motivo')` **explicando el motivo**; ninguna prueba finge
haber pasado.

### Otros globales

- `navigator.storage.estimate()` / `.persist()` / `.persisted()`: dobles
  mínimos; `estimate()` informa un uso derivado del contenido real del doble de
  IndexedDB.
- `Blob`, `File` y `structuredClone`: **los nativos de Node 22**, sin envoltorio.
- `window` apunta al propio `globalThis`, y se instala un `document` mínimo.
- `window.proj4`: implementación propia de Transverse Mercator sobre GRS80 con
  los parámetros de MAGNA-SIRGAS Origen Nacional (`lat_0=4`, `lon_0=−73`,
  `k=0.9992`, falso este 5 000 000, falso norte 2 000 000). Conoce **sólo**
  EPSG:4326 y EPSG:9377, que es lo único que pide `js/coords.js`. Su ida y
  vuelta es exacta a 1e-8°.

  > El ejemplo de `docs/FORMATO-ESCANEO.md` §2 (`norte: 2067412.55`,
  > `este: 4898231.10`) **no corresponde** a la latitud/longitud que aparece
  > junto a él: con esa definición EPSG:9377, `4,60971 N — 74,08175 W` proyecta
  > a ≈ `este 4 880 056`, `norte 2 067 459`. Los valores del documento parecen
  > ilustrativos, así que las pruebas comparan contra la proyección calculada y
  > contra `js/coords.js`, no contra esas cifras.

---

## Convenciones para añadir pruebas

1. **Escribe sólo dentro de `tests/`.** Nada de esta suite modifica el resto del
   repositorio.
2. **Importa los módulos bajo prueba de forma perezosa**, con
   `cargarModulo('js/…')` de `ayudantes.mjs`. Si el archivo aún no existe,
   `cargarModulo` devuelve `null` y la prueba debe hacer
   `return t.skip(mensajeAusente(ruta))` en vez de reventar la suite.
3. **Nunca falsees una prueba.** Si el entorno no da para comprobar algo, usa
   `t.skip('motivo concreto')`; el lanzador imprime los motivos agrupados al
   final.
4. **Generadores deterministas.** Nada de `Math.random()` sin semilla: usa
   `nubeSintetica`, `cuboUnitario`, `metadatosEjemplo` o `azarDeterminista`.
5. **Comentarios y mensajes de aserción en español (es-CO)**, explicando *qué*
   regla del contrato se está comprobando.
