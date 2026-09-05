# JoseScan — app iOS de escaneo LiDAR

App nativa que acompaña a la PWA **JoseMaps**. Captura terreno y estructuras con
el sensor LiDAR del iPhone/iPad Pro, las ancla al GPS en coordenadas
MAGNA-SIRGAS y exporta el resultado en los formatos que entiende el software de
campo y de escritorio.

- Bundle: `com.josemaps.josescan`
- Plataforma: iOS 16 o superior (iPhone y iPad)
- Interfaz: SwiftUI, en español (es-CO), apariencia oscura fija
- Proyecto: generado con **XcodeGen** desde `project.yml` — ver
  [`CONSTRUIR.md`](CONSTRUIR.md)

Documentación relacionada:

| Documento | Para qué |
|---|---|
| [`CONSTRUIR.md`](CONSTRUIR.md) | compilar, firmar e instalar en un dispositivo |
| [`../../docs/GUIA-ESCANEO.md`](../../docs/GUIA-ESCANEO.md) | cómo escanear bien en campo |
| [`../../docs/ARQUITECTURA-LIDAR.md`](../../docs/ARQUITECTURA-LIDAR.md) | arquitectura y decisiones de diseño |
| [`../../docs/FORMATO-ESCANEO.md`](../../docs/FORMATO-ESCANEO.md) | contrato del formato `josescan/1.0` |

---

## 1. Qué hace

1. **Escanea** con el LiDAR: acumula una nube de puntos densa (posición, color y
   confianza por punto) y, en paralelo, la malla reconstruida por ARKit con su
   clasificación semántica (muro, piso, techo, mesa, asiento, ventana, puerta).
2. **Ancla** el escaneo al mundo real: guarda latitud, longitud, altitud,
   precisiones y rumbo verdadero, y convierte las coordenadas del marco local de
   ARKit al marco **ENU** (+X Este, +Y Norte, +Z Arriba). Calcula además el
   Norte/Este MAGNA-SIRGAS Origen Nacional (EPSG:9377) del origen.
3. **Mide** sobre el escaneo: distancias, áreas, volúmenes, alturas y azimutes,
   que quedan guardados con el escaneo.
4. **Guarda** los escaneos en el dispositivo, con nombre, proyecto, notas y
   miniatura.
5. **Exporta** a PLY (binario y texto), OBJ+MTL, STL, USDZ, XYZ, GeoJSON, CSV y
   al paquete `.josescan` que abre la PWA JoseMaps.

Lo que **no** hace: no dibuja mapas, no descarga tiles, no gestiona el censo de
campo. Eso es trabajo de JoseMaps. JoseScan captura y entrega el archivo.

---

## 2. Requisitos de hardware

La captura necesita **sensor LiDAR**. La app no se fía del modelo: al arrancar
consulta a ARKit si el equipo admite `ARWorldTrackingConfiguration` con
reconstrucción de escena por malla (`supportsSceneReconstruction(.mesh)`).

| Equipo | Captura LiDAR |
|---|---|
| iPhone 12 Pro / Pro Max y toda la línea **Pro** posterior | sí |
| iPhone base, mini, Plus y Air (cualquier generación) | no |
| iPhone 11 y anteriores | no |
| iPad Pro 11" 2.ª gen. (2020), iPad Pro 12,9" 4.ª gen. (2020) y posteriores | sí |
| iPad, iPad Air, iPad mini | no |
| Simulador de iOS | no (ARKit no funciona en el simulador) |

Otros requisitos:

- **iOS 16+** para la app.
- **iOS 17+** para la pestaña *Interiores* (RoomPlan).
- El `Info.plist` declara `UIRequiredDeviceCapabilities = arkit`, de modo que
  la App Store no ofrecería la app a un equipo sin ARKit.

**Sin LiDAR la app sigue siendo utilizable**, sólo que no captura: las pestañas
*Escanear* e *Interiores* muestran una explicación en lugar de la cámara, con
una franja de aviso permanente arriba, y la app arranca directamente en
*Escaneos* para consultar, importar y exportar escaneos hechos en otro equipo.

---

## 3. Las cuatro pestañas

La barra inferior tiene cuatro pestañas (`App/RootView.swift`), con la barra
opaca en el color de superficie de la marca.

### 3.1 Escanear — `viewfinder`

Captura al aire libre y de estructuras, con LiDAR directo.

```
┌──────────────────────────────────────────────┐
│  ● 01:12   ▣ 812.344 pts   △ 98.120 tri      │  <- métricas vivas
│                                              │
│         [ imagen de la cámara con            │
│           la malla superpuesta ]             │
│                                     ╭─────╮  │
│                                     │  78 │  │  <- QualityGauge 0-100
│                                     │Calid│  │     (rojo → ámbar → verde)
│                                     ╰─────╯  │
│                                              │
│  GPS  ±3,2 m    Rumbo 172° S     [Anclar]    │  <- estado del ancla
│                                              │
│  [Malla] [Puntos] [Cámara]                   │  <- ModoVisualizacion
│         (  ⏹ Finalizar  )        [Cancelar]  │
└──────────────────────────────────────────────┘
```

- `ScanARViewContainer` dibuja la malla sobre la imagen de la cámara; el modo
  de visualización alterna entre malla, nube y cámara limpia.
- `ScanHUDView` muestra tiempo, puntos, triángulos, fps, estado del seguimiento,
  aviso térmico y estado del GPS y la brújula, y ofrece anclar, reiniciar,
  finalizar y cancelar (las dos últimas con confirmación).
- `QualityGauge` resume la calidad en un número de 0 a 100 combinando densidad
  (40 %), confianza del sensor (40 %) y estado del seguimiento (20 %).
- Al finalizar, `ScanResultSheet` presenta el resumen y permite guardar,
  descartar o exportar directamente.

### 3.2 Interiores — `house`

Levantamiento de recintos con **RoomPlan** (requiere iOS 17+). Produce el
esquema del recinto —muros, puertas, ventanas, mobiliario— que
`RoomPlanConverter` traduce a la misma `ScanMesh` que usa el resto de la app,
de modo que se guarda y se exporta por el mismo camino.

```
┌──────────────────────────────────────────────┐
│      [ vista RoomPlan del recinto ]          │
│                                              │
│   Muros 6   Puertas 2   Ventanas 3           │
│   Área de piso 24,8 m²   Altura 2,45 m       │
│                                              │
│         (  Terminar recinto  )               │
└──────────────────────────────────────────────┘
```

### 3.3 Escaneos — `square.stack.3d.up`

Biblioteca de todo lo capturado (`ScanStore`). Es la única pestaña que funciona
en cualquier equipo, con LiDAR o sin él.

```
┌──────────────────────────────────────────────┐
│  Escaneos                        Proyecto ▾  │
├──────────────────────────────────────────────┤
│ ▨  Cárcava K12+400                           │
│    05/09/2026 · 812.344 pts · 92 s · ancl.   │
├──────────────────────────────────────────────┤
│ ▨  Box culvert entrada                       │
│    05/09/2026 · 231.008 pts · 41 s           │
└──────────────────────────────────────────────┘
```

- `ScanDetailView`: ficha del escaneo con miniatura, metadatos, coordenadas
  MAGNA-SIRGAS del origen, mediciones y notas.
- `ScanExportSheet`: elección de formato. Los formatos de malla (OBJ, STL,
  USDZ) sólo aparecen si el escaneo tiene malla; GeoJSON sólo si está anclado.
- `ShareSheet`: hoja de compartir del sistema — Archivos, AirDrop, correo,
  mensajería.

### 3.4 Ajustes — `gearshape`

Preferencias persistentes (`AppSettings`), que se traducen en la
`ScanConfiguration` del motor de captura.

| Ajuste | Por omisión | Rango saneado |
|---|---|---|
| Capturar malla | activado | — |
| Capturar nube de puntos | activado | — |
| Capturar color | activado | — |
| Confianza mínima | media (1) | baja (0) / media (1) / alta (2) |
| Tamaño de vóxel | 0,02 m | 0,002 – 1,0 m |
| Máximo de puntos | 3 000 000 | 10 000 – 20 000 000 |
| Distancia máxima | 5,0 m | 0,1 – 100 m |
| Submuestreo de imagen | 2 (1 de cada 2 píxeles) | 1 – 16 |
| fps de captura | 10 | 0,5 – 60 |

Cambiar *Capturar malla* obliga a reiniciar la sesión de ARKit: la
reconstrucción de escena sólo se puede activar al arrancar.

---

## 4. Permisos que pide la app y por qué

Los textos que ve el usuario están en `App/Info.plist`, en español.

| Clave | Cuándo se pide | Por qué es necesario | Si se niega |
|---|---|---|---|
| `NSCameraUsageDescription` | al abrir *Escanear* o *Interiores* | ARKit necesita la cámara para el seguimiento visual-inercial y para muestrear el color de cada punto. El LiDAR no se expone por separado: se accede a través de ARKit. | **La captura no funciona.** Es el único permiso imprescindible. |
| `NSLocationWhenInUseUsageDescription` | al anclar por primera vez | Georreferenciar el escaneo: latitud, longitud, altitud, precisiones y rumbo verdadero, de donde salen el marco ENU y las coordenadas MAGNA-SIRGAS. | Se puede escanear y exportar, pero el escaneo queda en el marco `arkit`, sin norte, y no se puede exportar a GeoJSON ni superponer en el mapa de JoseMaps. |
| `NSPhotoLibraryAddUsageDescription` | sólo al guardar una miniatura o captura en Fotos | Dejar la imagen del escaneo en el carrete del usuario. | Todo lo demás funciona igual; sólo no se guarda en Fotos. |

*"When in use"* significa que la ubicación sólo se consulta con la app en
primer plano: la app no rastrea en segundo plano.

Además, el `Info.plist` activa `UIFileSharingEnabled` y
`LSSupportsOpeningDocumentsInPlace`, de modo que **la carpeta de la app aparece
en la app Archivos** (En mi iPhone → JoseScan) y los escaneos se pueden sacar
sin pasar por la hoja de compartir. También declara el tipo exportado
`com.josemaps.josescan.scan` (extensión `.josescan`, conforme a
`public.zip-archive`), lo que hace que iOS reconozca el paquete y lo asocie a
la app.

---

## 5. Mapa de carpetas

```
ios/JoseScan/
├── project.yml                    Especificación XcodeGen (iOS 16+, bundle
│                                  com.josemaps.josescan, targets JoseScan y
│                                  JoseScanTests, esquema con cobertura)
├── README.md                      este documento
├── CONSTRUIR.md                   compilación, firma e instalación
│
├── App/                           Arranque, tema y configuración del paquete
│   ├── JoseScanApp.swift          @main; crea ScanStore, AppSettings y
│   │                              Georeferencer como @StateObject compartidos
│   ├── RootView.swift             TabView de 4 pestañas; detecta LiDAR y
│   │                              sustituye las de captura si no lo hay
│   ├── Theme.swift                JoseTheme: paleta oscura, tipografías,
│   │                              métricas y el modificador TarjetaJoseScan
│   ├── Info.plist                 permisos, capacidades, orientaciones,
│   │                              File Sharing y el UTI .josescan
│   └── Assets.xcassets            AppIcon y AccentColor
│
├── Sources/
│   ├── Model/                     CONTRATO COMPARTIDO
│   │   └── ScanTypes.swift        BoundingBox, PointCloud, ScanMesh,
│   │                              GeoReference, MeasurementRecord,
│   │                              ScanQualityMetrics, ScanMetadata,
│   │                              ScanDocument, ScanExportFormat, ScanError.
│   │                              Sólo Foundation + simd: se puede probar
│   │                              sin ARKit.
│   │
│   ├── Capture/                   Motor de captura
│   │   ├── ScanSession.swift      orquesta ARKit, hilos y estado publicado
│   │   ├── ScanConfiguration.swift parámetros saneables y persistibles
│   │   ├── DepthPointExtractor.swift  ARFrame → PointCloud en coord. mundo
│   │   ├── MeshAccumulator.swift  ARMeshAnchor → ScanMesh unificada
│   │   └── VoxelDownsampler.swift rejilla hash, promedio y tope de puntos
│   │
│   ├── Rendering/                 Pantalla de captura
│   │   ├── ScanScreen.swift       pestaña Escanear completa
│   │   ├── ScanARViewContainer.swift  ARSCNView + ModoVisualizacion
│   │   ├── ScanHUDView.swift      métricas, GPS, controles
│   │   ├── QualityGauge.swift     anillo de calidad 0-100
│   │   └── ScanResultSheet.swift  resumen al finalizar
│   │
│   ├── Export/                    Escritores de archivo
│   │   ├── ScanExporter.swift     fachada: documento + formato → archivo
│   │   ├── PLYWriter.swift        PLY binario LE (16 B/punto) y ASCII
│   │   ├── OBJWriter.swift        OBJ + MTL, grupos por clasificación
│   │   ├── STLWriter.swift        STL binario (50 B/triángulo) y ASCII
│   │   ├── USDZWriter.swift       USDZ para Vista Rápida en iOS
│   │   ├── GeoJSONWriter.swift    huella WGS84: punto de origen + polígono
│   │   ├── CSVWriter.swift        puntos y mediciones tabulados
│   │   ├── ScanBundleWriter.swift arma el paquete .josescan
│   │   └── ZipArchive.swift       ZIP propio, método store, sin dependencias
│   │
│   ├── Geo/                       Georreferenciación y medición
│   │   ├── MagnaSirgas.swift      WGS84 ↔ EPSG:9377 (IGAC Res. 471/2020)
│   │   ├── GeoTransform.swift     ARKit → ENU → WGS84
│   │   ├── LocationProvider.swift CoreLocation: posición, precisión, rumbo
│   │   ├── Georeferencer.swift    produce y publica el GeoReference del ancla
│   │   └── MeasurementEngine.swift distancias, áreas, volúmenes, azimutes
│   │
│   ├── Library/                   Biblioteca, ajustes y compartir
│   │   ├── ScanStore.swift        persistencia en disco de los escaneos
│   │   ├── AppSettings.swift      preferencias del usuario
│   │   ├── ScanLibraryView.swift  galería (pestaña Escaneos)
│   │   ├── ScanDetailView.swift   ficha de un escaneo
│   │   ├── ScanExportSheet.swift  elección de formato
│   │   ├── SettingsView.swift     pestaña Ajustes
│   │   └── ShareSheet.swift       UIActivityViewController
│   │
│   └── RoomCapture/               Interiores con RoomPlan (iOS 17+)
│       ├── RoomCaptureScreen.swift
│       ├── RoomCaptureCoordinator.swift
│       ├── RoomCaptureViewContainer.swift
│       ├── RoomPlanConverter.swift    resultado de RoomPlan → ScanMesh
│       └── RoomSummaryView.swift
│
└── (JoseScan.xcodeproj)           GENERADO por xcodegen; no se versiona

ios/JoseScanTests/                 Pruebas XCTest de la lógica pura
                                   (geometría, vóxeles, escritores, ZIP, geo).
                                   Vive fuera de ios/JoseScan/ a propósito;
                                   project.yml lo referencia como
                                   ../JoseScanTests.
```

El `.xcodeproj` es un artefacto generado y está ignorado en `ios/.gitignore`:
se reconstruye con `xcodegen generate`.

---

## 6. Cómo encaja con JoseMaps

```
   App JoseScan (iOS)                        PWA JoseMaps (navegador)
   ─────────────────────                     ────────────────────────
   captura LiDAR                             visor 3D (three.js)
   ancla GPS + MAGNA-SIRGAS      .josescan   mediciones
   mide                       ───────────>   huella sobre el mapa Leaflet
   guarda y exporta                          exportación a KMZ y Excel
```

El único punto de contacto es el archivo. Ambos lados implementan el mismo
contrato, descrito en `docs/FORMATO-ESCANEO.md`: **no modificar ese formato sin
actualizar los dos lados.**
