# Arquitectura del subsistema LiDAR — JoseScan

Documento técnico del escáner 3D de JoseMaps. Describe el flujo de datos, los
módulos y su API pública, los marcos de coordenadas, las decisiones de diseño y
las limitaciones conocidas.

Fuente de verdad del formato de intercambio: **`docs/FORMATO-ESCANEO.md`**
(`josescan/1.0`). Contrato de tipos en Swift:
**`ios/JoseScan/Sources/Model/ScanTypes.swift`**.

---

## 1. Panorama

JoseScan tiene dos implementaciones que comparten un mismo formato de datos:

- **App nativa iOS** (`ios/JoseScan/`, SwiftUI + ARKit, bundle
  `com.josemaps.josescan`, iOS 16+). Es la única vía para leer el LiDAR.
- **Módulo web** dentro de la PWA JoseMaps (`js/lidar-*.js`). Visualiza, mide,
  georreferencia, almacena y exporta escaneos en cualquier navegador; **captura**
  sólo donde el navegador expone WebXR Depth Sensing (Chrome + ARCore).

Ambos lados leen y escriben el paquete `.josescan` y el `escaneo.json` descrito
en `docs/FORMATO-ESCANEO.md`. Ese archivo es el único acoplamiento entre los
dos mundos.

---

## 2. Flujo de datos

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  DISPOSITIVO iOS (iPhone Pro / iPad Pro con LiDAR)                       │
 │                                                                          │
 │   LiDAR + cámara ancha + IMU                                             │
 │        │                                                                 │
 │        v                                                                 │
 │   ARKit  ARWorldTrackingConfiguration                                    │
 │     ├── sceneDepth / smoothedSceneDepth  (ARDepthData: depthMap +        │
 │     │                                     confidenceMap)                 │
 │     ├── capturedImage (YCbCr)                                            │
 │     ├── camera.transform / intrinsics                                    │
 │     └── ARMeshAnchor  (scene reconstruction, con clasificación)          │
 │            │                    │                                        │
 │            v                    v                                        │
 │   ┌─────────────────┐   ┌──────────────────┐                             │
 │   │DepthPointExtrac.│   │ MeshAccumulator  │  Sources/Capture/           │
 │   │ píxel→mundo,    │   │ anclas por UUID, │                             │
 │   │ color, confianza│   │ malla unificada  │                             │
 │   └────────┬────────┘   └────────┬─────────┘                             │
 │            v                     │                                       │
 │   ┌─────────────────┐            │                                       │
 │   │ VoxelDownsampler│            │   ScanConfiguration gobierna a los     │
 │   │ rejilla hash,   │            │   tres (vóxel, confianza mínima,      │
 │   │ promedio, tope  │            │   distancia máx., fps, tope puntos)   │
 │   └────────┬────────┘            │                                       │
 │            └──────────┬──────────┘                                       │
 │                       v                                                  │
 │              ┌──────────────────┐                                        │
 │              │   ScanSession    │  Sources/Capture/  (ObservableObject)   │
 │              │  orquesta ARKit, │  publica métricas a la interfaz         │
 │              │  hilos y estado  │  (ScanQualityMetrics)                   │
 │              └───────┬──────────┘                                        │
 │                      │                                                   │
 │      ┌───────────────┼───────────────────┐                               │
 │      v               v                   v                               │
 │  Sources/Rendering   Sources/Geo    Sources/RoomCapture                   │
 │  ScanScreen          LocationProvider   RoomCaptureScreen (iOS 17+)       │
 │  ScanARViewContainer Georeferencer      RoomCaptureCoordinator            │
 │  ScanHUDView         GeoTransform       RoomPlanConverter → ScanMesh      │
 │  QualityGauge        MagnaSirgas        RoomSummaryView                   │
 │  ScanResultSheet     MeasurementEngine                                    │
 │                          │                                               │
 │                          v                                               │
 │              ┌────────────────────────┐                                  │
 │              │      ScanDocument      │  metadata + PointCloud + ScanMesh │
 │              │  (marco arkit o enu)   │  Sources/Model/ScanTypes.swift    │
 │              └───────────┬────────────┘                                  │
 │                          │                                               │
 │      ┌───────────────────┼────────────────────┐                          │
 │      v                                        v                          │
 │  Sources/Library                        Sources/Export                   │
 │  ScanStore (disco)                      ScanExporter (fachada)           │
 │  AppSettings                            PLY / OBJ / STL / USDZ /         │
 │  ScanLibraryView                        GeoJSON / CSV Writers            │
 │  ScanDetailView                         ScanBundleWriter + ZipArchive    │
 │  ScanExportSheet · ShareSheet                    │                       │
 └──────────────────────────────────────────────────┼───────────────────────┘
                                                    │
                       archivo .josescan / .ply / .obj / .geojson
                       (Archivos, AirDrop, Compartir, iCloud)
                                                    │
 ┌──────────────────────────────────────────────────┼───────────────────────┐
 │  PWA JoseMaps (cualquier navegador)              v                       │
 │                                                                          │
 │   js/lidar-formats.js  ── lee/escribe PLY, OBJ, XYZ, CSV y .josescan      │
 │            │                                                             │
 │            v                                                             │
 │   js/lidar-store.js    ── IndexedDB "JoseScanDB" (aparte de CampoMapsDB)  │
 │            │                                                             │
 │            ├──> js/lidar-viewer.js  ── visor three.js (nubes y mallas)    │
 │            ├──> js/lidar-geo.js     ── ENU ↔ WGS84 ↔ EPSG:9377, GeoJSON,  │
 │            │                            mediciones                       │
 │            └──> js/lidar-ui.js + css/lidar.css ── panel "Escaneos 3D"     │
 │                          │                                               │
 │                          v                                               │
 │            huella GeoJSON sobre el mapa Leaflet (js/map-engine.js)        │
 │                          │                                               │
 │                          v                                               │
 │            js/kmz-export.js · js/excel-export.js  (entrega final)         │
 │                                                                          │
 │   js/lidar-scanner.js  ── captura WebXR Depth Sensing (sólo Android con   │
 │                            ARCore); produce sensor:"webxr"                │
 └──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Módulos y API pública

### 3.1 `Sources/Model/` — contrato compartido

`ScanTypes.swift` sólo depende de `Foundation` y `simd` (no importa ARKit),
para poder usarse en pruebas unitarias y en cualquier capa.

| Tipo | Responsabilidad | API pública destacada |
|---|---|---|
| `BoundingBox` | caja alineada a ejes, en metros | `min`, `max`, `empty`, `isEmpty`, `center`, `size`, `diagonal`, `expand(_:)` (punto y caja); `Codable` como `[x,y,z]` |
| `ScanCoordinateFrame` | marco de las coordenadas | `.arkit`, `.enu` |
| `PointCloud` | nube densa; tres arreglos paralelos | `positions`, `colors`, `confidences`, `frame`, `count`, `isEmpty`, `hasColor`, `bounds`, `append(_:)`, `reserveCapacity(_:)`, `isConsistent` |
| `ScanFaceClass` | clasificación semántica de cara | `none/wall/floor/ceiling/table/seat/window/door`, `nombre` |
| `ScanMesh` | malla triangular | `vertices`, `normals`, `indices`, `classifications`, `frame`, `vertexCount`, `triangleCount`, `hasNormals`, `bounds`, `isConsistent`, `surfaceArea()` |
| `GeoReference` | ancla geodésica del origen | `latitude`, `longitude`, `altitude`, `horizontalAccuracy`, `verticalAccuracy`, `heading`, `headingAccuracy`, `timestamp`, `norte?`, `este?`, `esConfiable` |
| `MeasurementKind` / `MeasurementRecord` | mediciones persistidas | `distancia/area/volumen/altura/azimut`; `id`, `kind`, `value`, `unit`, `points`, `label?`, `createdAt` |
| `ScanQualityMetrics` | métricas vivas para la HUD | `pointCount`, `triangleCount`, `highConfidenceRatio`, `coveredArea`, `trackingOK`, `trackingMessage`, `fps`, `thermalWarning?`, `score` (0–100) |
| `ScanMetadata` | contenido de `escaneo.json` | `formatoActual = "josescan/1.0"`, todos los campos del contrato, `jsonEncoder()` / `jsonDecoder()` con fechas ISO-8601 |
| `ScanDocument` | escaneo completo en memoria (clase) | `metadata`, `cloud`, `mesh`, `refreshMetadata()`, `isEmpty` |
| `ScanExportFormat` | formatos de salida | `ply`, `plyAscii`, `obj`, `stl`, `usdz`, `xyz`, `geojson`, `csv`, `bundle`; `extensionArchivo`, `nombre`, `requiereMalla` |
| `ScanError` | errores del dominio | `sensorNoDisponible`, `sinDatos`, `sinMalla`, `sinGeorreferencia`, `formatoInvalido(_)`, `escrituraFallida(_)`, `permisoDenegado(_)`, `cancelado` |

`ScanQualityMetrics.score` es una combinación explícita y auditable:

```
densidad    = min(1, puntos / 400 000)
confianza   = fracción de puntos con confianza alta
seguimiento = 1.0 si el tracking va bien, 0.4 si no
score       = round((densidad·0,4 + confianza·0,4 + seguimiento·0,2) · 100)
```

### 3.2 `Sources/Capture/` — motor de captura

| Módulo | Responsabilidad | API pública destacada |
|---|---|---|
| `ScanConfiguration` | parámetros de captura, tipo de valor puro, `Codable` tolerante a claves ausentes | `capturarMalla`, `capturarNube`, `capturarColor`, `confianzaMinima` (0/1/2), `tamanoVoxel` (m), `maxPuntos`, `distanciaMaxima` (m), `submuestreoImagen`, `fpsCaptura`; `porDefecto`, `intervaloCaptura`, `saneada()`, `requiereReinicioAR(respectoA:)` |
| `DepthPointExtractor` | convierte el mapa de profundidad de un `ARFrame` en `PointCloud` en coordenadas mundo, muestreando color; recorre punteros crudos | `init()`, `extraer(desde:configuracion:) -> PointCloud` |
| `MeshAccumulator` | mantiene los `ARMeshAnchor` vivos y produce una malla unificada; cachea conteos por ancla | `frame`, `actualizar(_:)`, `eliminar(_:)`, `eliminar(identificador:)`, `reiniciar()`, `conteoAnclas`, `conteoVertices`, `conteoTriangulos`, `areaSuperficie`, `isEmpty`, `malla() -> ScanMesh`, `clasificar(_: ARMeshClassification) -> ScanFaceClass` |
| `VoxelDownsampler` | rejilla de vóxeles con tabla hash; promedia posición y color por celda y recompacta al llegar al tope | `init(tamanoVoxel:maxPuntos:…)`, `tamanoVoxel`, `tamanoVoxelSolicitado`, `maxPuntos`, `frame`, `count`, `isEmpty`, `proporcionAltaConfianza`, `reiniciar()`, `aplicar(_: ScanConfiguration)`, `insertar(_: PointCloud)`, `insertar(posicion:color:confianza:)`, `nube() -> PointCloud`, `bounds() -> BoundingBox` |
| `ScanSession` | orquesta la sesión de ARKit, los hilos de captura y el estado publicado a la interfaz | `ObservableObject` observado por `ScanARViewContainer` y `ScanHUDView` |

Valores por omisión de `ScanConfiguration.porDefecto`: malla, nube y color
activados; confianza mínima 1 (media); vóxel 0,02 m; tope 3 000 000 de puntos;
distancia máxima 5,0 m; submuestreo de imagen 2; 10 fps de captura.
`saneada()` acota todo a rangos seguros (vóxel 0,002–1,0 m; puntos
10 000–20 000 000; distancia 0,1–100 m; submuestreo 1–16; fps 0,5–60).

### 3.3 `Sources/Rendering/` — captura en pantalla

| Módulo | Responsabilidad | API pública destacada |
|---|---|---|
| `ScanScreen` | pantalla completa de la pestaña *Escanear*: cámara + HUD + hoja de resultado | vista SwiftUI |
| `ScanARViewContainer` | envuelve un `ARSCNView` y dibuja la malla sobre la imagen | `UIViewRepresentable`; `init(sesion:modoVisualizacion:)`; `ModoVisualizacion` (`id`, `nombre`, `iconoSistema`, `siguiente`) |
| `ScanHUDView` | superposición con métricas, controles y estado del GPS | `init(sesion:geo:modoVisualizacion:onFinalizar:onCancelar:)`; utilidades `entero(_:)`, `decimal(_:)`, `puntoCardinal(_:)` |
| `QualityGauge` | anillo de calidad 0–100, rojo → ámbar → verde | `init(valor:etiqueta:diametro:grosor:conMarcas:)`, `color(para:) -> Color` |
| `ScanResultSheet` | resumen al terminar: guardar, descartar o exportar | vista SwiftUI |

### 3.4 `Sources/Geo/` — georreferenciación y medición

| Módulo | Responsabilidad |
|---|---|
| `LocationProvider` | envoltura de CoreLocation: posición, precisión y rumbo verdadero |
| `Georeferencer` | `ObservableObject` compartido por la app (`@StateObject` en `JoseScanApp`); produce el `GeoReference` del ancla y lo publica a la HUD |
| `GeoTransform` | rotación ARKit → ENU y conversión ENU ↔ WGS84 (apartado 4) |
| `MagnaSirgas` | proyección WGS84 ↔ MAGNA-SIRGAS Origen Nacional (EPSG:9377), misma definición que `js/coords.js` |
| `MeasurementEngine` | cálculo de distancias, áreas, volúmenes, alturas y azimutes; produce `MeasurementRecord` |

### 3.5 `Sources/Export/` — escritores

| Módulo | Responsabilidad | API pública destacada |
|---|---|---|
| `ScanExporter` | fachada: recibe un `ScanDocument` y un `ScanExportFormat` y devuelve el archivo | valida `requiereMalla` y la presencia de georreferencia |
| `PLYWriter` | PLY binario little-endian y ASCII | `colorPorOmision` (200,200,200), `confianzaPorOmision` (2), `bytesPorPunto` (16), `encabezado(cantidad:binario:marco:)`, `datos(de:binario:marco:)`, `datos(de:binario:)`, `texto(de:marco:)` |
| `OBJWriter` | Wavefront OBJ + MTL, caras agrupadas por clasificación | `nombreMTLPorOmision` (`malla.mtl`), `grupo(_:)`, `color(_:)`, `ordenGrupos`, `texto(de:mtllib:)`, `materialMTL()`, `datos(de:mtllib:)`, `datosMTL()` |
| `STLWriter` | STL binario y ASCII | `bytesPorTriangulo` (50), `cabeceraBinaria`, `nombreSolido`, `normal(a:b:c:normalesVertice:)`, `datos(de:binario:)`, `datos(de:)`, `texto(de:)`, `Cara`, `carasValidas(de:)` |
| `USDZWriter` | malla a USDZ para Vista Rápida en iOS | requiere malla |
| `GeoJSONWriter` | `FeatureCollection` WGS84 con el punto de origen y el polígono de la huella | requiere georreferencia |
| `CSVWriter` | listado tabulado de puntos y de mediciones | — |
| `ScanBundleWriter` | arma el paquete `.josescan` con `escaneo.json`, `nube.ply`, `malla.obj`, `malla.mtl`, `miniatura.jpg` y `huella.geojson` | usa `ZipArchive` |
| `ZipArchive` | escritor ZIP autocontenido, método **store** (sin comprimir), sin dependencias externas | `firmaLocal/firmaCentral/firmaFin`, `version` (20), `metodoStore` (0), `banderaUTF8` (0x0800), `maximoEntradas` (65535), `maximoBytes` (4 GiB−1), `crc32(_:)`, `fechaMSDOS(_:zonaHoraria:)`, `nombreNormalizado(_:)`, `crear(entradas:fecha:zonaHoraria:)`, `crear(entradas:)` |

`PLYWriter.datos(de:binario:marco:)` **no transforma coordenadas**: el
parámetro `marco` sólo determina la línea `comment marco` del encabezado. La
conversión ARKit → ENU se hace antes, en el módulo de georreferenciación.

### 3.6 `Sources/Library/` y `Sources/RoomCapture/`

| Módulo | Responsabilidad |
|---|---|
| `ScanStore` | persistencia de los escaneos en disco; `@StateObject` en `JoseScanApp` |
| `AppSettings` | preferencias del usuario (incluida la `ScanConfiguration`); `@StateObject` en `JoseScanApp` |
| `ScanLibraryView` / `ScanDetailView` | galería de escaneos y ficha individual |
| `ScanExportSheet` / `ShareSheet` | elección de formato y hoja de compartir del sistema |
| `SettingsView` | pestaña *Ajustes* |
| `RoomCaptureScreen`, `RoomCaptureCoordinator`, `RoomCaptureViewContainer` | levantamiento de interiores con RoomPlan (iOS 17+) |
| `RoomPlanConverter` | convierte el resultado de RoomPlan en un `ScanMesh` con clasificación, para que siga el mismo camino de exportación |
| `RoomSummaryView` | resumen del recinto levantado |

### 3.7 Módulos web (PWA)

| Archivo | Responsabilidad pública |
|---|---|
| `js/lidar-scanner.js` | captura con WebXR Depth Sensing (Chrome + ARCore); produce escaneos con `sensor: "webxr"` |
| `js/lidar-viewer.js` | visor 3D con three.js: nubes de puntos y mallas, órbita, encuadre |
| `js/lidar-formats.js` | lectura y escritura de PLY (binario y ASCII), OBJ, XYZ, CSV y del paquete `.josescan` |
| `js/lidar-geo.js` | ENU ↔ WGS84 ↔ MAGNA-SIRGAS (EPSG:9377), generación de la huella GeoJSON y mediciones sobre el escaneo |
| `js/lidar-store.js` | persistencia en IndexedDB, base `JoseScanDB` |
| `js/lidar-ui.js` + `css/lidar.css` | panel lateral **Escaneos 3D**, con la misma estética que los paneles existentes (`panel-maps`, `panel-tracks`, `panel-placemarks`, `panel-settings`) |

La conversión a EPSG:9377 en la PWA reutiliza `js/coords.js`
(`toMagnaSirgas` / `fromMagnaSirgas`, sobre proj4 ya cargado por `index.html`).
La huella se dibuja sobre el mismo mapa Leaflet de `js/map-engine.js` y se
exporta con `js/kmz-export.js` y `js/excel-export.js`.

---

## 4. Marcos de coordenadas y transformaciones

### 4.1 Los tres marcos

| Marco | Ejes | Origen | Unidad |
|---|---|---|---|
| **ARKit** (`arkit`) | +X derecha, +Y arriba, −Z hacia donde mira la cámara | donde arrancó la sesión de ARKit | m |
| **ENU** (`enu`) | +X = Este, +Y = Norte, +Z = Arriba | el punto anclado con GPS | m |
| **WGS84** (EPSG:4326) | latitud, longitud, altitud | elipsoide WGS84 | ° y m |
| **MAGNA-SIRGAS Origen Nacional** (EPSG:9377) | Este, Norte | falso origen nacional | m |

`ScanMetadata.marco` sólo admite `arkit` o `enu`. Un escaneo sin ancla fiable
se queda en `arkit` y **no** se puede exportar a GeoJSON (`ScanError.sinGeorreferencia`).

### 4.2 ARKit → ENU

Es una rotación alrededor del eje vertical más un cambio de eje. Con `h` = rumbo
verdadero, en radianes, del eje −Z de ARKit en el instante del anclaje
(`GeoReference.heading`, en grados, hacia radianes):

```
este   =  x·cos(h) + z·sin(h)
norte  =  x·sin(h) − z·cos(h)
arriba =  y
```

En forma matricial, con `p_arkit = (x, y, z)`:

```
        ┌  cos h    0    sin h ┐
R_enu = │  sin h    0   −cos h │        p_enu = R_enu · p_arkit
        └    0      1      0   ┘
```

La matriz es ortonormal (rotación rígida), así que **conserva distancias,
ángulos y áreas**: `ScanMesh.surfaceArea()` da el mismo valor antes y después.
Todo el error de esta etapa se concentra en `h`, y gira el escaneo completo en
bloque; por eso un rumbo malo se corrige reanclando, sin volver a escanear.

### 4.3 ENU → WGS84 (aproximación local plana)

El origen ENU es exactamente `geo.latitude`, `geo.longitude`, `geo.altitude`.
Con `φ₀`, `λ₀` en radianes y los radios de curvatura del elipsoide WGS84
evaluados en `φ₀`:

```
a  = 6 378 137,0 m                      (semieje mayor WGS84)
f  = 1 / 298,257223563                  (achatamiento)
e² = 2f − f² = 0,006694379990141...

           a·(1 − e²)
M(φ₀) = ─────────────────────           radio de curvatura meridiano
        (1 − e²·sin²φ₀)^(3/2)

               a
N(φ₀) = ──────────────────              radio de curvatura primer vertical
        (1 − e²·sin²φ₀)^(1/2)
```

y entonces, para un punto ENU `(e, n, u)` en metros:

```
φ = φ₀ + n / M(φ₀)                      [rad]
λ = λ₀ + e / (N(φ₀) · cos φ₀)           [rad]
altitud = altitud₀ + u
```

La inversa es directa: `n = (φ − φ₀)·M(φ₀)`, `e = (λ − λ₀)·N(φ₀)·cos φ₀`.

Esta aproximación desprecia la curvatura terrestre y la convergencia de
meridianos. Para las decenas de metros que abarca un escaneo LiDAR el error
introducido es de milímetros, muy por debajo del error del GPS que fija el
origen. **No** es válida para distancias kilométricas.

### 4.4 WGS84 → MAGNA-SIRGAS Origen Nacional (EPSG:9377)

Transverse Mercator sobre GRS80, con la definición oficial de Colombia
(IGAC Res. 471 de 2020 / 529 de 2020 / 370 de 2021), idéntica a la de
`js/coords.js`:

| Parámetro | Valor |
|---|---|
| Proyección | Transverse Mercator |
| Latitud de origen | 4° N |
| Meridiano central | −73° W |
| Factor de escala `k₀` | 0,9992 |
| Falso Este `x₀` | 5 000 000,0 m |
| Falso Norte `y₀` | 2 000 000,0 m |
| Elipsoide | GRS80 |
| `towgs84` | 0,0,0,0,0,0,0 |

```
+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000
+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs
```

GRS80 y WGS84 difieren en el semieje menor por unos 0,1 mm: irrelevante aquí.

`geo.norte` y `geo.este` en `escaneo.json` corresponden **al origen del
escaneo**, no a cada punto. Para obtener las coordenadas planas de un punto
concreto se pasa por WGS84 (4.3) y luego se proyecta; sumar directamente `(e, n)`
a `(este₀, norte₀)` introduce el error del factor de escala y de la
convergencia de meridianos, aceptable sólo para croquis.

---

## 5. Decisiones de diseño

### 5.1 Por qué una app nativa en iOS y no sólo la PWA

WebKit no expone el LiDAR. En iOS no hay WebXR Depth Sensing, y `getUserMedia`
entrega únicamente la imagen RGB de la cámara: ni mapa de profundidad, ni
`ARMeshAnchor`, ni las poses de la cámara con la calidad del seguimiento
visual-inercial de ARKit. Como Apple obliga además a que todo navegador en iOS
use WebKit, no hay ningún navegador alternativo que lo resuelva.

Las opciones eran: (a) renunciar al escaneo en iOS, (b) esperar a que WebKit lo
soporte, o (c) una app nativa mínima que capture y exporte. Se eligió (c),
acotada a lo que sólo puede hacer la app nativa: **capturar, anclar, guardar y
exportar**. Toda la explotación posterior —visor, mediciones, mapa, KMZ,
Excel— vive en la PWA, que ya es el centro del trabajo de campo. El
acoplamiento entre ambas es un único archivo documentado (`.josescan`), no una
API ni un servidor.

### 5.2 Por qué submuestreo por vóxeles

A 10 fps de captura, con decenas de miles de puntos válidos por frame, un
escaneo de dos minutos genera del orden de decenas de millones de puntos
crudos. Sin filtrar, eso agota la memoria del dispositivo y produce archivos
inmanejables.

La rejilla de vóxeles resuelve cuatro problemas a la vez:

1. **Memoria acotada.** El número de puntos no depende del tiempo de escaneo
   sino del **volumen** recorrido: pasar cinco veces por la misma pared no
   añade ni un punto.
2. **Coste constante por punto.** La inserción es un `floor(p / arista)` y un
   acceso a tabla hash: O(1), sin estructuras espaciales ni vecindarios.
3. **Menos ruido.** Cada celda guarda el **promedio** de posición y color de
   los puntos que cayeron dentro, lo que atenúa el ruido del sensor.
4. **Menos duplicados.** Las superficies dobles por deriva pequeña se funden si
   caen dentro de la misma celda; subir la arista es la palanca directa contra
   ese defecto.

Con arista de 0,02 m se conserva el detalle que el sensor realmente resuelve
(1–2 cm) sin guardar redundancia. `VoxelDownsampler` mantiene la arista
solicitada (`tamanoVoxelSolicitado`) separada de la efectiva (`tamanoVoxel`):
al superar `maxPuntos` recompacta con una arista mayor, degradando el detalle
en vez de fallar o quedarse sin memoria.

### 5.3 Por qué PLY binario como formato principal de nube

- **Tamaño.** 16 bytes exactos por punto (3 × Float32 + RGB + confianza) frente
  a ~50–60 bytes en ASCII. Un millón de puntos son ~16 MB en binario y ~55 MB en
  texto. En campo, sin cobertura y con el almacenamiento justo, la diferencia
  importa.
- **Velocidad.** Escribir el binario es copiar memoria; el ASCII exige formatear
  siete números por punto, lo que en un teléfono ya cargado térmicamente añade
  segundos.
- **Sin pérdida.** Float32 conserva la precisión completa del sensor; el ASCII
  con pocos decimales la recorta.
- **Compatibilidad.** PLY es el formato universal de nubes: CloudCompare,
  MeshLab, Open3D, PDAL, ReCap y Cyclone lo leen sin conversión, y admite
  atributos por punto (color y **confianza**) que XYZ y CSV no llevan.

Se mantiene la variante ASCII (`ScanExportFormat.plyAscii`) para inspección y
para herramientas antiguas. Los lectores del proyecto deben tolerar archivos
sin color, sin confianza y en `format ascii 1.0`.

### 5.4 Por qué IndexedDB `JoseScanDB` y no la base existente `CampoMapsDB`

`js/storage.js` define `CampoMapsDB` en `DB_VERSION = 2`, con los almacenes
`projects`, `maps`, `tracks`, `placemarks` y `settings`. Meter los escaneos ahí
tenía tres inconvenientes:

1. **Riesgo sobre datos de campo reales.** Añadir almacenes obliga a subir
   `DB_VERSION` y a ejecutar una migración `onupgradeneeded` en **todas** las
   instalaciones existentes de la PWA. Un fallo ahí compromete mapas y
   marcadores ya levantados, que son irrepetibles.
2. **Ciclos de vida distintos.** Un escaneo son decenas o cientos de megabytes
   de geometría binaria; un marcador son unos cientos de bytes. Conviene poder
   vaciar los escaneos sin tocar nada más — y que una cuota agotada por
   escaneos no bloquee el guardado de un marcador.
3. **Módulos independientes.** El subsistema LiDAR se puede desarrollar,
   versionar y desactivar por completo sin tocar el núcleo de JoseMaps. El
   contrato entre ambos es la huella GeoJSON, no una tabla compartida.

El precio es que no hay transacciones atómicas entre las dos bases. Se asume:
la relación se establece por `proyecto` en `escaneo.json`, un campo de texto, y
el borrado de un proyecto no arrastra sus escaneos.

### 5.5 Por qué ZIP sin compresión (método *store*)

`ZipArchive` implementa **sólo el método 0 (store)**:

- **Cero dependencias.** Comprimir con deflate desde Swift exigiría enlazar
  zlib o una librería de terceros. El escritor completo —cabeceras locales,
  directorio central, EOCD y CRC-32— cabe en un archivo y no arrastra nada.
- **El contenido ya es incompresible.** El grueso del paquete son `nube.ply`
  (Float32 densos, entropía alta) y `miniatura.jpg` (ya comprimida). Deflate
  ahorraría poco a cambio de CPU.
- **Coste térmico.** Se escribe justo después de un escaneo, con el equipo ya
  caliente. Store es una copia de memoria; deflate es trabajo de CPU adicional
  en el peor momento.
- **Compatibilidad total.** Store es parte del ZIP estándar (APPNOTE.TXT 6.3.x):
  `unzip`, el Finder de macOS, el Explorador de Windows y **JSZip** —que ya
  carga `index.html` para el KMZ— lo abren sin más.

El **lector** de la PWA acepta tanto *store* como *deflate*: un `.josescan`
generado desde el navegador con JSZip puede venir comprimido y sigue siendo
válido.

---

## 6. Limitaciones conocidas

| Área | Limitación |
|---|---|
| Hardware | La captura exige LiDAR: sólo iPhone Pro (12 Pro y posteriores) e iPad Pro (2020 y posteriores). Sin él, las pestañas de captura quedan deshabilitadas con explicación. |
| Safari | Ningún navegador de iOS puede capturar. Es una restricción de WebKit, no una carencia de la PWA. |
| Android | La captura web depende de WebXR Depth Sensing (Chrome + ARCore) y entrega profundidad **estimada**, no LiDAR. |
| Alcance | Puntos útiles hasta ~5 m; `distanciaMaxima` viene en 5,0 m a propósito. |
| Precisión absoluta | La limita el GPS del teléfono (metros), no el LiDAR (centímetros). La altitud GPS es el dato más pobre. |
| Deriva | El seguimiento acumula error con el recorrido. No hay cierre de bucle propio: se depende del relocalizado de ARKit y de que el operador cierre el recorrido. |
| Registro entre escaneos | No hay alineación (ICP) entre escaneos distintos. Cada uno lleva su propio origen y quedan yuxtapuestos, no fusionados. |
| Rumbo | Toda la orientación depende de una sola lectura de brújula. Cerca de metal el escaneo sale girado en bloque. |
| ENU → WGS84 | Aproximación local plana: válida para decenas de metros, no para kilómetros. |
| ZIP | Sin ZIP64: máximo 65 535 entradas y 4 GiB por archivo (holgado para este uso). |
| RoomPlan | La pestaña *Interiores* requiere iOS 17+, aunque la app corra desde iOS 16. |
| Térmico | Escaneos largos disparan la limitación térmica de iOS; la app avisa pero no puede evitarla. |
| Atomicidad | Escaneos (`JoseScanDB`) y proyectos (`CampoMapsDB`) viven en bases separadas; la relación es por nombre de proyecto. |

---

## 7. Trabajo futuro

1. **Cierre de bucle y registro (ICP)** para fundir varios escaneos del mismo
   sitio en un solo modelo coherente.
2. **Promediado de posiciones GNSS** en una ventana de tiempo, con descarte de
   valores atípicos, en lugar de una sola lectura al anclar.
3. **Anclaje por dos o más puntos conocidos** (dos estacas con coordenadas
   MAGNA-SIRGAS), que eliminaría la dependencia de la brújula y resolvería de
   una vez el escaneo girado.
4. **Corrección de rumbo posterior**: rotar el escaneo ya guardado desde
   JoseMaps arrastrándolo sobre el mapa.
5. **Recorte y limpieza en el visor web**: quitar suelo, aislar una región,
   filtrar por confianza antes de exportar.
6. **Ortoimagen y perfil transversal** derivados de la nube, que es lo que
   normalmente termina en el informe.
7. **ZIP64 y escritura por streaming** para escaneos que superen los límites
   actuales.
8. **Exportación LAS/LAZ**, el formato esperado por el software topográfico
   profesional.
9. **Cálculo de volúmenes** por diferencia contra un plano o una superficie de
   referencia (cárcavas, excavaciones, acopios).
