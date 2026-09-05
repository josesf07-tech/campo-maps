# Formato de escaneo JoseScan (`josescan/1.0`)

Contrato compartido entre la app nativa iOS (`ios/JoseScan`) y el módulo web de
la PWA JoseMaps (`js/lidar-*.js`). **No modificar sin actualizar ambos lados.**

## 1. Paquete `.josescan`

Un archivo `.josescan` es un ZIP sin cifrado, escrito con el método **store**
(sin compresión) para que el escritor sea autocontenido y no dependa de zlib. Los
lectores deben aceptar también entradas `deflate`, que es lo que produce JSZip.
Estructura:

```
escaneo.json        Metadatos (obligatorio)
nube.ply            Nube de puntos, PLY binario little-endian (opcional)
malla.obj           Malla triangular Wavefront OBJ (opcional)
malla.mtl           Material del OBJ (opcional)
miniatura.jpg       Miniatura 512x512 para la galería (opcional)
huella.geojson      Huella georreferenciada WGS84 para JoseMaps (opcional)
```

Debe existir `escaneo.json` y al menos `nube.ply` o `malla.obj`.

## 2. `escaneo.json`

```json
{
  "formato": "josescan/1.0",
  "id": "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
  "nombre": "Cárcava K12+400",
  "creado": "2026-09-05T14:22:31Z",
  "dispositivo": "iPhone 15 Pro",
  "sistema": "iOS 18.2",
  "sensor": "lidar",
  "marco": "enu",
  "geo": {
    "latitude": 4.60971, "longitude": -74.08175, "altitude": 2570.4,
    "horizontalAccuracy": 3.2, "verticalAccuracy": 4.0,
    "heading": 172.5, "headingAccuracy": 8.0,
    "timestamp": "2026-09-05T14:22:31Z",
    "norte": 2067459.13, "este": 4880056.02
  },
  "puntos": 812344,
  "vertices": 51233,
  "triangulos": 98120,
  "bbox": { "min": [-4.2, -3.1, -1.0], "max": [5.9, 6.0, 2.4] },
  "duracionSegundos": 92.4,
  "mediciones": [
    { "id": "…", "kind": "distancia", "value": 3.42, "unit": "m",
      "points": [[0,0,0],[3.42,0,0]], "label": "Ancho", "createdAt": "…" }
  ],
  "proyecto": "Proyecto General",
  "notas": "",
  "archivoNube": "nube.ply",
  "archivoMalla": "malla.obj",
  "archivoMiniatura": "miniatura.jpg"
}
```

Reglas:

- Fechas siempre **ISO-8601 UTC** (`JSONEncoder.dateEncodingStrategy = .iso8601`
  en Swift, `new Date().toISOString()` en JS).
- `id` es un UUID en mayúsculas (formato de `Foundation.UUID`); la PWA lo trata
  como cadena opaca.
- Campos opcionales pueden faltar o venir `null`; ningún consumidor debe
  asumir su presencia.

## 3. Marcos de coordenadas

`marco` sólo admite dos valores:

| valor   | Ejes                                              | Uso |
|---------|---------------------------------------------------|-----|
| `arkit` | +X derecha, +Y arriba, −Z hacia la cámara         | Escaneo sin ancla GPS confiable |
| `enu`   | **+X = Este, +Y = Norte, +Z = Arriba** (metros)   | Escaneo georreferenciado |

La conversión ARKit → ENU es una rotación alrededor del eje vertical más un
cambio de eje. Con `h` = rumbo verdadero en radianes del eje −Z de ARKit y
`f = −z` (la componente «hacia adelante» del punto):

```
este   =  x·cos h + f·sin h   ... es decir  e =  x·cos h − z·sin h
norte  = −x·sin h + f·cos h   ... es decir  n = −x·sin h − z·cos h
arriba =  y
```

La comprobación que fija los signos: el eje −Z de ARKit es, por definición de
`heading`, el que apunta al azimut `h`, así que el vector `(0, 0, −1)` debe caer
en `(este, norte) = (sin h, cos h)`. Con `h = 90°` (el teléfono mirando al este)
tiene que dar `este = +1`; si diera `−1` los escaneos saldrían espejados.
Los rumbos 0° y 180° **no** sirven para verificarlo: ahí ambos signos coinciden.

La matriz 3×3 completa es ortonormal y de determinante +1 (una rotación propia),
de modo que se conservan distancias, ángulos y el sentido de giro de los
triángulos: los índices de la malla no se tocan.

La inversa ENU → ARKit es la misma fórmula aplicada sobre `(e, n)`, porque el
bloque horizontal es una involución:

```
x =  e·cos h − n·sin h
z = −e·sin h − n·cos h
y =  u
```

El origen del marco ENU es exactamente `geo.latitude / geo.longitude /
geo.altitude`. Para pasar a WGS84 se usa la aproximación local plana
(radio de curvatura del elipsoide WGS84 en la latitud del origen), suficiente
para escaneos de decenas de metros.

Las coordenadas MAGNA-SIRGAS Origen Nacional (EPSG:9377) de `geo.norte` /
`geo.este` corresponden **al origen**, no a cada punto; se derivan con la misma
definición que usa `js/coords.js`.

## 4. `nube.ply`

PLY binario little-endian, un solo elemento `vertex`:

```
ply
format binary_little_endian 1.0
comment JoseScan josescan/1.0
comment marco enu
element vertex <N>
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
property uchar confidence
end_header
<N × 16 bytes>
```

`confidence`: 0 baja, 1 media, 2 alta (ARConfidenceLevel). Los lectores deben
tolerar archivos sin color y sin confianza, y también `format ascii 1.0`.

## 5. `malla.obj`

Wavefront OBJ estándar, unidades en metros, con `v`, `vn` y `f v//vn`.
Las caras se agrupan por clasificación semántica con `g muro`, `g piso`,
`g techo`, etc. cuando ARKit la provee.

## 6. `huella.geojson`

`FeatureCollection` en WGS84 (EPSG:4326) con dos *features*:

1. `Point` en el origen del escaneo, con las propiedades del escaneo
   (`id`, `nombre`, `puntos`, `triangulos`, `norte`, `este`).
2. `Polygon` con la proyección horizontal de la caja envolvente.

Esto es lo que la PWA superpone en el mapa Leaflet y lo que se puede exportar a
KMZ junto con los marcadores existentes.
