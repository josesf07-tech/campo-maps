# CLAUDE.md — instrucciones de trabajo en este repositorio

JoseMaps (antes CampoMaps): PWA de mapas offline con GPS, planos GeoPDF, coordenadas
MAGNA-SIRGAS (EPSG:9377) y censo de Uso y Usuarios, usada en campo en Colombia.
Contexto de uso y funcionalidades: ver `README.md`.

## Arquitectura en una pantalla

- Sitio estático. **Sin bundler, sin paso de compilación, sin TypeScript, sin framework.**
  Lo que está en el repositorio es exactamente lo que corre en el navegador.
- `index.html` es la interfaz completa (paneles laterales, modales, sprite SVG) y el único
  punto de carga. Carga en este orden: `js/version.js` (script clásico), las librerías CDN,
  `css/style.css`, `js/app.js` como `type="module"` y el registro del Service Worker.
- `js/app.js` importa el resto de módulos ES por ruta relativa. No hay `import` dinámico ni
  `importmap`.
- Librerías de terceros por CDN, con versión fijada: Leaflet 1.9.4 (unpkg), pdf.js 3.11.174,
  proj4js 2.9.2, JSZip 3.10.1 (cdnjs), xlsx 0.18.5 y ExcelJS 4.4.0 (jsDelivr). Se usan como
  globales (`window.L`, `window.pdfjsLib`, `window.proj4`, `window.JSZip`, `window.XLSX`,
  `window.ExcelJS`), nunca como imports. **El Service Worker las precachea**, por eso la app
  arranca sin señal; si se añade o cambia una CDN hay que actualizar `PRECACHE_ASSETS`.
- Persistencia: IndexedDB `CampoMapsDB` v2 (`js/storage.js`) con almacenes `projects`,
  `maps`, `tracks`, `placemarks`, `settings`. Las fotos se guardan como data URL dentro del
  marcador. El SW mantiene aparte su propia base `CampoMaps_SW_DB` para metadatos LRU de
  teselas.
- Estado de la app: un único objeto `state` en `js/app.js`. Comunicación página↔SW por
  `postMessage` (`SKIP_WAITING`, `CACHE_TILES`, `CLEAR_TILE_CACHE`, `GET_CACHE_SIZE`).
- Puentes globales existentes (no eliminar sin revisar los usos):
  `window.CAMPOMAPS_VERSION`, `window.__campoMapsOpenPhoto`, `__campoMapsRenderPhotos`,
  `__campoMapsClearPhotos`, `__campoMapsGetPhotos`, `__campoMapsUpdateBadges`,
  `__campoMapsSaveSetting`.

## Mapa de módulos (`js/`)

| Archivo | Responsabilidad |
| --- | --- |
| `version.js` | Versión canónica. Script clásico (no módulo) para poder usarse desde la página y desde `importScripts` en el SW. |
| `app.js` | Orquestador (~2.465 líneas). Cablea toda la interfaz. Secciones marcadas con `// ========== X ==========`: APP STATE, INITIALIZATION, LOAD SAVED DATA, NAVIGATION, PANELS, GPS, TRACKS, PLACEMARKS, CALIBRATION, MAP CONTROLS, SETTINGS, MODALS, BORRADO DE DATOS, TOAST NOTIFICATIONS, PROJECTS MANAGEMENT. |
| `storage.js` | IndexedDB: apertura/migración, CRUD genérico y atajos por almacén, `generateUUID`, `requestPersistentStorage`, `clearAllData`. |
| `map-engine.js` | Leaflet: `BASE_LAYERS` (Google Híbrido, Esri, OSM, OpenTopoMap), cambio de capa, `buildTileUrl`, overlays de imagen para planos, marcador GPS con rumbo, líneas de ruta, clic y pulsación larga. |
| `gps-tracker.js` | `navigator.geolocation` + brújula: suavizado ponderado por precisión, intervalo mínimo, suscriptores, `getAveragedPosition`, reconstrucción de rumbo desde la matriz de rotación, mensajes de error. |
| `track-recorder.js` | Grabación de recorridos: suscripción al GPSTracker, filtros de distancia/tiempo/precisión, estadísticas. |
| `placemarks.js` | Marcadores en el mapa: render, popups con fotos, conos de visión por rumbo, alta/edición/borrado contra `storage.js`. |
| `calibration.js` | Carga de PDF/imagen, rasterizado con pdf.js, extracción de georreferencia GeoPDF (`/GPTS`, USGS, GML, `/GeoBBox`), puntos de control y ajuste afín, guardado del plano. |
| `coords.js` | EPSG:9377 con proj4: `toMagnaSirgas`, `fromMagnaSirgas`, `isMagnaSirgasCoords`. |
| `measurement.js` | Herramienta de medición: distancia haversine, azimut geodésico y cuadrante, área poligonal esférica en ha/m², y su barra de interfaz. |
| `tile-downloader.js` | Descarga de mosaicos para offline: cálculo de teselas por bounds y zoom, buffer de 2 km alrededor del GeoPDF, modal de progreso, fijado (`pinned`) contra el desalojo LRU. |
| `kmz-export.js` | KMZ con fotos incrustadas y coordenadas MAGNA; `navigator.share` con respaldo de descarga. |
| `docx-export.js` | Registro fotográfico .docx generando OOXML a mano dentro de un ZIP (JSZip). |
| `excel-export.js` | Censo Uso y Usuarios .xlsx con cabecera oficial de 3 filas; ExcelJS (con foto incrustada en la col. 101) y respaldo SheetJS. Exporta también los catálogos `FUENTES_AGUA`, `RESIDUOS_LIQUIDOS`, `RESIDUOS_SOLIDOS`. |

## Flujo de versionado (crítico)

La versión canónica vive en **`js/version.js`** (`root.CAMPOMAPS_VERSION = 'vNN'`) y debe
estar replicada en tres sitios más:

- `index.html`: todos los sufijos `?v=NN` de css/js (el `sw.js?v=` del registro se arma en
  tiempo de ejecución con `window.CAMPOMAPS_VERSION`, no lleva número literal).
- `sw.js`: la constante de respaldo `CACHE_VERSION` (define el nombre `campo-maps-vNN`).
- `package.json`: campo `version` como `NN.0.0`.

**Nunca se editan a mano.** Siempre:

```bash
npm run bump            # sube 1 (v25 -> v26) y sincroniza los 4 archivos
npm run bump -- v30     # fija una versión concreta
npm run check-version   # no modifica nada; sale con código 1 si hay desfase
```

Por qué importa: hasta la v25 estos números se editaban a mano y quedaron desfasados
(`js/version.js` en `v25` mientras `index.html` seguía pidiendo `app.js?v=24`). Con el
sufijo viejo el navegador puede servir el archivo cacheado por HTTP antes de que el
Service Worker tome el control, es decir, mezclar módulos de dos versiones en la primera
carga tras publicar. Ese fallo no se ve en desarrollo, solo en el teléfono del usuario.

Reglas:

- Toda publicación de una versión nueva pasa por `npm run bump`.
- Si se toca `index.html`, `sw.js` o `package.json` en algo relacionado con versión,
  ejecutar `npm run check-version` antes de dar el trabajo por terminado.
- El script vive en `scripts/bump-version.mjs`; si se añaden más sitios donde aparezca la
  versión, hay que enseñárselos ahí, no duplicar la edición manual.

## Pruebas

```bash
npm test    # node --test tests/
```

Runner integrado de Node, sin framework de pruebas. `proj4` es `devDependency` para poder
verificar las conversiones de `coords.js` fuera del navegador. Las demás `devDependencies`
(`@playwright/test`, y copias locales de leaflet, pdfjs-dist, jszip, xlsx y exceljs con la
misma versión que las CDN) son solo para la prueba de humo end-to-end; **nada de esto entra
en la app publicada**, que sigue cargando sus librerías por CDN.

Los módulos con pruebas son los de cálculo: **`js/coords.js`, `js/measurement.js` y
`js/calibration.js`**. Tienen pruebas porque un error ahí no rompe la app de forma visible:
produce coordenadas, áreas o georreferencias equivocadas que acaban impresas en informes
oficiales.

Regla: **cambiar cualquiera de esos tres módulos exige ejecutar `npm test` antes de
terminar.** Si un cambio de comportamiento invalida una prueba, se corrige la prueba de
forma explícita y se dice en el commit; no se borra.

### Prueba de humo end-to-end (Playwright)

```bash
npm run test:e2e    # playwright test  (tests/e2e/)
npm run test:all    # unitarias + end-to-end
```

Red de seguridad para tocar `js/app.js` y la interfaz. No comprueba reglas de negocio:
comprueba que la app **arranca** y que su esqueleto sigue en pie — sin errores de consola
ni excepciones ni recursos propios rotos, mapa de Leaflet montado con la capa base por
defecto, los cuatro paneles laterales abriendo y cerrando, los modales principales, los
botones de respaldo, `CampoMapsDB` creada con sus cinco almacenes, los puentes globales
`window.__campoMaps*` definidos y el Service Worker registrado. `tests/e2e/precache.spec.mjs`
además lee `PRECACHE_ASSETS` de `sw.js` y verifica contra el disco que no falta ni sobra
nada: es la comprobación que evita el fallo que solo aparece sin conexión.

Detalles del montaje:

- `tests/e2e/static-server.mjs` sirve el repositorio en `http://127.0.0.1:4173`
  (`file://` no vale: hay módulos ES y Service Worker).
- Las CDN **no se piden a internet**: `tests/e2e/fixtures.mjs` intercepta la red y responde
  Leaflet, pdf.js, proj4, JSZip, xlsx y ExcelJS desde `node_modules` con la misma versión
  que pide `index.html`, y las teselas con un PNG de 1x1. Si `index.html` estrena una CDN
  hay que añadirla a `LIBRERIAS_CDN` (y a `PRECACHE_ASSETS`), o la prueba falla nombrando
  la URL que se quedó fuera.
- El GPS se simula con una posición fija en Bogotá (4.65, -74.06) y permiso concedido.

Los módulos que dependen del DOM, de Leaflet o del GPS no tienen pruebas unitarias: su
única cobertura automática es esta prueba de humo, que verifica el arranque y el cableado,
no el comportamiento. Lo demás se sigue verificando a mano en el navegador.

## Service Worker (`sw.js`)

Dos cachés, con ciclos de vida distintos a propósito:

- `campo-maps-<versión>` — app shell. Se renombra en cada versión y las anteriores se
  borran al activar (también hay una purga desde `index.html`).
- `campo-maps-tiles` — **sin versión**, para que los mapas descargados sobrevivan a las
  actualizaciones. Al activar, migra teselas desde cachés antiguas `campo-maps-tiles-vNN`.

Estrategias:

- Teselas (`isTileRequest`): cache-first, sin revalidación en segundo plano (no gastar
  datos móviles en campo). Sin red y sin caché devuelve una tesela SVG "Sin conexión".
- App shell y CDNs (`isAppAssetRequest`): network-first con tiempo límite de 4 s y
  respaldo en caché; en navegación cae a `./index.html` y, en último extremo, a un HTML
  de cortesía. Los archivos propios se piden con `cache: 'no-cache'` para no mezclar
  versiones de módulos.
- Resto: network-first con respaldo en caché.

LRU de teselas: `MAX_TILES = 12000`, metadatos en IndexedDB `CampoMaps_SW_DB`, poda cada
150 accesos, y las teselas con `pinned: 1` (descargadas a propósito para un plano) nunca
se desalojan.

**Al crear un archivo nuevo en `js/` hay que añadirlo a `PRECACHE_ASSETS` en `sw.js`.**
Si se olvida, la app funciona en desarrollo y con red, y se rompe sin conexión —
justo el escenario real de uso. Lo mismo aplica a un CSS nuevo, un icono nuevo o una CDN
nueva.

## Convenciones de código

- Indentación de **4 espacios** en JS, HTML y CSS.
- **Español** en comentarios, nombres de secciones, textos de interfaz, mensajes de error y
  avisos (`showToast`). Los identificadores del código son mezcla de español e inglés según
  el módulo; se sigue el estilo del archivo que se está tocando en vez de renombrar.
- JSDoc breve en las funciones no triviales de los módulos; `app.js` usa sobre todo
  comentarios de sección.
- Módulos ES con `export class` / `export function`. Sin `default export`.
- Nada de framework, TypeScript, bundler, ni dependencias nuevas de tiempo de ejecución en
  npm. Una librería nueva entra por CDN con versión fijada **y** entra en `PRECACHE_ASSETS`.
- Escapar siempre lo que se inyecta con `innerHTML` (`escapeHtml` en `app.js` y
  `placemarks.js`, `escapeXml` en `kmz-export.js`).
- La interfaz usa emoji en textos de botones y avisos: es el estilo existente del proyecto,
  no hay que quitarlos ni añadirlos en código o commits nuevos por iniciativa propia.
- CSS con tokens en `:root`, modo claro por clase `light-mode` en `body`, alturas en `dvh`
  y `env(safe-area-inset-*)`.

## Mensajes de commit

Convención observada en `git log`:

```
JoseMaps v25: corrige la brújula invertida 180° con el teléfono vertical
```

- Asunto: `JoseMaps vNN: ` + descripción en español, en minúscula tras los dos puntos,
  concreta (qué cambió, no "varios arreglos"). Los commits anteriores a v24 usan el
  nombre antiguo `CampoMaps vNN:`.
- Un commit por versión publicada; el número del asunto coincide con `js/version.js`.
- Cuerpo opcional pero habitual en los cambios grandes: párrafos explicando el porqué y/o
  listas agrupadas por área (Diseño, Estabilidad y funcionalidad, GPS, Service Worker…).
  Se menciona explícitamente cómo se verificó el cambio.
- Trailer `Co-Authored-By:` cuando el trabajo lo hizo un agente.

No hacer commit ni push salvo petición explícita del usuario.

## Trampas conocidas

- **El offline es el requisito duro.** La app se usa en zonas sin señal. Cualquier cosa que
  dependa de red en tiempo de ejecución (una CDN sin precachear, una fuente remota, una
  llamada a API) rompe el caso de uso principal. Verificar los cambios con el modo sin
  conexión del navegador, no solo con red.
- **Los datos viven en el teléfono.** IndexedDB + caché del SW, sin servidor ni copia de
  seguridad. Un cambio de `DB_NAME`/`DB_VERSION` o de la forma de los registros sin
  migración le borra el trabajo de campo a alguien. Los marcadores guardan `censoAgua`,
  `projectId` y `createdAt`: si alguno se pierde al guardar, el Excel de censo sale vacío
  y las exportaciones por proyecto dejan de filtrar (ya ocurrió antes de la v23).
- **iOS.** `100dvh` en vez de `100vh` (con `100vh` la barra de Safari tapa controles, p. ej.
  el obturador); modales tipo bottom-sheet porque el patrón anterior bloqueaba el scroll;
  límite de canvas (~16,7 Mpx, 4096 px por lado) que deja el GeoPDF en blanco sin lanzar
  error; permiso de brújula que exige gesto del usuario y rumbo absoluto por
  `webkitCompassHeading`; `window.open()` con `data:` bloqueado (por eso el visor propio de
  fotos); descarga de archivos por `navigator.share` en vez de `<a download>`.
- **Coordenadas.** Todo lo que ve el usuario y todo entregable va en EPSG:9377. `proj4` se
  carga como global: `coords.js` degrada a lat/lon si `window.proj4` no está, así que un
  fallo de carga de la CDN se manifiesta como coordenadas geográficas donde deberían ir
  metros, sin error visible.
- **Descarga de teselas.** Las URLs deben construirse con `MapEngine.buildTileUrl` para que
  coincidan exactamente con las que pide Leaflet (misma capa, mismo subdominio); si no
  coinciden, el SW no las sirve desde la caché y en campo aparecen huecos pese a haber
  "descargado" el área.
- **`calibration.js` tiene un ajuste afín a medias**: `calibrate()` resuelve por mínimos
  cuadrados la matriz `{A..F}` y la guarda, pero `pixelToLatLng()` devuelve la esquina
  mínima de los puntos de control y `getImageBounds()` extrapola solo con los dos primeros
  puntos, porque `L.ImageOverlay` de Leaflet no admite rotación. Los comentarios del propio
  archivo lo reconocen. No asumir que la matriz se está usando para posicionar el plano.
- **Rutas del repositorio**: los iconos existen duplicados en `assets/icons/` y `icons/`, y
  `PRECACHE_ASSETS` referencia ambas. `manifest.json` apunta a `assets/icons/`.
