# JoseMaps

PWA (aplicación web instalable) de mapas offline para trabajo de campo en Colombia.
Antes se llamaba CampoMaps; el nombre cambió en la v24 y el identificador interno de
versión y de cachés sigue usando el prefijo `campo-maps` / `CAMPOMAPS_VERSION`.

Versión actual: la que declare `js/version.js` (hoy `v25`).

## Para qué sirve

Está pensada para el recorrido de campo con el teléfono, normalmente sin señal de datos:

- Llevar el plano del proyecto (GeoPDF georreferenciado o imagen calibrada) encima de
  imagen satelital, y verse a uno mismo sobre ese plano con el GPS del teléfono.
- Tomar puntos (marcadores) con fotos, coordenadas MAGNA-SIRGAS y ficha de censo.
- Grabar el recorrido, medir distancias, azimuts y áreas en hectáreas.
- Salir del campo con los entregables ya generados: KMZ, registro fotográfico en Word
  y censo de Uso y Usuarios en Excel.

Todo se guarda en el propio teléfono (IndexedDB + caché del Service Worker). No hay
servidor, ni cuentas, ni sincronización: lo que no se exporte se queda en el dispositivo.

## Funcionalidades

### Mapas base y uso offline

- Cuatro capas base, conmutables con un botón (`js/map-engine.js`): Google Híbrido
  (satélite + vías), Esri World Imagery, OpenStreetMap y OpenTopoMap.
- Descargador de mosaicos (`js/tile-downloader.js`) con dos modos:
  - **Pantalla actual**: el encuadre visible y dos niveles de zoom más.
  - **Plano + buffer de 2 km**: el perímetro del GeoPDF cargado expandido 2 km en todas
    las direcciones, zooms 13 a 17, para tener también caminos y accesos.
  Antes de descargar muestra número de mosaicos y espacio estimado.
- Las teselas descargadas se marcan como "fijadas" (`pinned`) y no las desaloja la
  limpieza LRU del Service Worker (límite general: 12.000 teselas).
- La caché de teselas no lleva número de versión, así que los mapas descargados
  sobreviven a las actualizaciones de la app.
- Cuando falta una tesela sin conexión se dibuja una tesela SVG gris con la leyenda
  "Sin conexión", en lugar de un hueco.

### GeoPDF y calibración de planos

- Carga de PDF o imagen desde el teléfono (`js/calibration.js`).
- Detección automática de georreferenciación leyendo los bytes del PDF: `/GPTS`
  (ISO 32000-1 / Adobe), etiquetas USGS (`/SW_Lat`, `/NE_Long`, …), envolvente
  `gml:lowerCorner` / `gml:upperCorner` (exportes de ArcGIS/QGIS) y `/GeoBBox`.
  Si las esquinas vienen en coordenadas proyectadas MAGNA-SIRGAS, se convierten a
  geográficas antes de usarlas.
- Con georreferencia válida: botón "Cargar directamente" y el plano queda encima del
  mapa, guardado en IndexedDB y restaurado al reabrir la app.
- Sin georreferencia hay dos alternativas:
  - **Calibración manual**: se tocan puntos sobre la imagen y se escribe para cada uno
    su Norte/Este MAGNA-SIRGAS (o su lat/lon).
  - **Posicionar sobre el GPS**: coloca el plano centrado en la posición actual, útil
    como referencia rápida.
- El PDF se rasteriza con pdf.js respetando el límite de lienzo de iOS/Safari
  (máx. ~16,7 Mpx y 4096 px por lado); por encima de eso Safari devuelve un lienzo en
  blanco.

### GPS y precisión

- `js/gps-tracker.js` envuelve `navigator.geolocation` con suavizado ponderado por
  precisión (últimas 5 muestras) y frecuencia mínima configurable entre actualizaciones.
- Barra superior con Norte y Este MAGNA-SIRGAS, lat/lon, altitud y precisión, con
  semáforo: verde ≤ 5 m, amarillo ≤ 15 m, rojo por encima.
- **Promediar GPS**: toma hasta 8 lecturas (12 s de tope), descarta el 20 % peor y
  promedia ponderando por precisión antes de fijar el punto.
- Brújula por `deviceorientation` / `deviceorientationabsolute`, reconstruyendo la matriz
  de rotación completa para que el rumbo no se invierta con el teléfono vertical, y
  usando `webkitCompassHeading` como referencia absoluta en iOS. Cuando no hay norte real
  la interfaz avisa "sin calibrar".
- Mira de precisión (retícula) en el centro del mapa que muestra en vivo las coordenadas
  MAGNA-SIRGAS del punto apuntado.

### Marcadores y fotos

- Se crean con el botón flotante (sobre la mira) o con pulsación larga sobre el mapa.
- Cámara en la propia app con **ráfaga continua**: se dispara varias veces sin salir,
  cada foto queda numerada y con su rumbo de brújula editable ("045° NE", "Aguas arriba", …).
  También hay acceso a la cámara nativa del teléfono y a la galería.
- Sello técnico opcional sobre la foto (proyecto, coordenadas, altitud, precisión, fecha).
- Cono de visión dibujado sobre el mapa según el rumbo de cada foto.
- Los marcadores pertenecen a un **proyecto**; las listas y las exportaciones se filtran
  siempre por el proyecto activo.

### Rutas

- Grabación con pausa/reanudación (`js/track-recorder.js`), filtrando puntos por distancia
  mínima (1,5 m), intervalo mínimo (1 s) y precisión (descarta lecturas peores que 50 m).
- Estadísticas: distancia, duración, velocidad media y máxima, desnivel positivo y negativo.
- Las rutas guardadas se redibujan al abrir la app.

### Mediciones

- Modo distancia: longitud acumulada del tramo más azimut del último segmento y su
  cuadrante (N, NNE, NE, …).
- Modo área: superficie en hectáreas y m², más perímetro.
- Fórmulas en `js/measurement.js`: distancia por haversine (R = 6.371.000 m), azimut
  geodésico y área poligonal esférica sobre el radio WGS84 (6.378.137 m).

### Censo "Uso y Usuarios"

Formulario plegable dentro del marcador (`censoAgua`), con: identificador de campo,
municipio, vereda, predio, número de habitantes, cota, usos del agua (fuente primaria,
secundaria, pecuaria y agrícola, en selección múltiple sobre la lista de fuentes hídricas
de `js/excel-export.js`), otros usos, y manejo de residuos líquidos y sólidos.

### Exportaciones

Se generan en el dispositivo, sin servidor. En móvil se ofrecen por el menú nativo de
compartir cuando está disponible (`navigator.share`), y si no, como descarga directa.

- **KMZ** (`js/kmz-export.js`): puntos con nombre, descripción, fotos incrustadas en
  `files/` y coordenadas MAGNA-SIRGAS en la ficha de cada punto.
- **Word .docx** (`js/docx-export.js`): registro fotográfico generado a mano (OOXML dentro
  de un ZIP hecho con JSZip), Century Gothic 8 pt, dos fotos por fila, con numeración
  continua "Fotografía 1..X", coordenadas Norte/Este y fecha.
- **Excel .xlsx** (`js/excel-export.js`): censo de Uso y Usuarios con la cabecera oficial
  de tres filas y celdas combinadas; con ExcelJS incrusta la primera foto de cada predio
  en la columna 101 (FOTOGRAFÍA). Si ExcelJS no está disponible cae a SheetJS (sin imagen).
- **Exportar todo**: genera los tres archivos en secuencia para el proyecto activo.

## Ejecutar en local

No hay paso de compilación: es HTML, CSS y módulos ES nativos. Basta servir la carpeta
por http(s) — con `file://` el Service Worker y los módulos no cargan.

```bash
cd campo-maps
python3 -m http.server 8080
# o: npx serve .
```

Y abrir `http://localhost:8080`. `localhost` cuenta como origen seguro, así que el
Service Worker, la geolocalización y la cámara funcionan sin certificado. Para probar
desde el teléfono en la red local hace falta HTTPS real (túnel tipo cloudflared/ngrok),
porque el GPS y `getUserMedia` exigen contexto seguro fuera de `localhost`.

Dependencias de Node: solo para las pruebas (`proj4` como `devDependency`). La app en el
navegador carga sus librerías por CDN.

```bash
npm install        # solo si se van a correr pruebas
npm test           # runner de Node: node --test tests/
npm run check-version
```

## Publicación

El despliegue es estático a [surge.sh](https://surge.sh). `.surgeignore` lista lo que no
se sube: `node_modules`, `tests`, `scripts`, `package.json`, `package-lock.json`,
`CLAUDE.md`, PDFs, scripts de Python, logs y temporales.

```bash
npm run bump          # sube la versión y la sincroniza en los 4 archivos
npx surge . <dominio>.surge.sh
```

`npm run bump` es obligatorio antes de publicar: si `index.html`, `sw.js` y `package.json`
quedan con un número distinto al de `js/version.js`, el navegador puede servir código viejo
en la primera carga. El dominio no está guardado en el repositorio (el `CNAME` se eliminó);
en el historial de git figura `campomaps-colombia.surge.sh`.

## Sistema de coordenadas

Toda la app muestra y exporta en **MAGNA-SIRGAS / Origen Nacional, EPSG:9377**, que es el
sistema oficial de Colombia según las resoluciones del IGAC citadas en `js/coords.js`
(Res. 471 de 2020, 529 de 2020 y 370 de 2021). Es lo que exigen las autoridades
ambientales en los informes, de ahí que el Word y el Excel lleven Norte y Este en metros
y no lat/lon.

Definición usada con proj4 (`js/coords.js`):

```
+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000
+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs
```

Internamente el mapa trabaja en WGS84 (Leaflet); la conversión a EPSG:9377 se hace al
mostrar y al exportar. `coords.js` también convierte en sentido inverso (Norte/Este a
lat/lon), que es lo que permite calibrar planos escribiendo coordenadas MAGNA, e incluye
una heurística (`isMagnaSirgasCoords`) para reconocer si un par de números de un GeoPDF
son coordenadas proyectadas de este origen.

## Requisitos del navegador

- Navegador con módulos ES, Service Worker, IndexedDB y `getUserMedia`.
- Contexto seguro (https o `localhost`) para GPS, cámara y Service Worker.
- Probada sobre todo en Safari/iOS y Chrome/Android instalada como PWA
  (`display: standalone`).

### Notas de iOS

Varias correcciones del historial son específicas de iOS y conviene tenerlas presentes al
tocar la interfaz:

- **Viewport**: se usa `100dvh` (no `100vh`) y `viewport-fit=cover` con
  `env(safe-area-inset-*)`. Con `100vh` la barra de Safari tapa controles; el botón de
  obturador de la cámara desaparecía por esto (v18).
- **Modales**: diseño tipo bottom-sheet y alturas en `dvh`; con el patrón anterior el
  scroll del modal se bloqueaba en iOS (v19).
- **Cámara**: además de la cámara interna hay un botón directo a la cámara nativa del
  teléfono, porque `getUserMedia` puede fallar o no ofrecerse según permisos (v18).
- **Lienzo**: Safari limita el tamaño del canvas; por eso el rasterizado del GeoPDF se
  escala hacia abajo. Si se supera, el plano sale en blanco sin lanzar error.
- **Brújula**: `DeviceOrientationEvent.requestPermission()` exige un gesto del usuario, y
  el rumbo absoluto llega por `webkitCompassHeading` en vez de
  `deviceorientationabsolute` (v25).
- **Descargas**: en iOS no hay descarga clásica de archivos desde la web; los entregables
  salen por la hoja de compartir (`navigator.share` con `files`), con descarga por enlace
  como respaldo en escritorio.
- **Fotos**: `window.open()` con URL `data:` está bloqueado, así que las fotos se abren en
  un visor propio (lightbox) dentro de la app.

## Estructura

```
index.html          Interfaz completa (paneles, modales, sprite SVG) y carga de CDNs
sw.js               Service Worker: precaché de la app + caché de teselas con LRU
manifest.json       Manifiesto PWA
js/version.js       Versión canónica (script clásico, compartido con el SW)
js/*.js             Módulos ES (ver CLAUDE.md para el mapa de responsabilidades)
css/style.css       Estilos con tokens, modo claro y modo oscuro
scripts/bump-version.mjs   Sincronizador de versión
assets/icons, icons/       Iconos de la PWA
```

`CLAUDE.md` contiene las instrucciones operativas (versionado, pruebas, Service Worker,
convenciones) para trabajar sobre este repositorio.
