# Guía de escaneo 3D — JoseScan

Guía práctica para quien va a campo. Explica qué equipos sirven, cómo capturar
bien, cómo dejar el escaneo georreferenciado y cómo llevarlo a JoseMaps y al
software de escritorio.

Documentos relacionados:

- `docs/FORMATO-ESCANEO.md` — contrato del formato `josescan/1.0` (para quien
  programa o integra).
- `docs/ARQUITECTURA-LIDAR.md` — cómo está construido el sistema.
- `ios/JoseScan/CONSTRUIR.md` — cómo compilar e instalar la app en el iPhone.

---

## 1. Qué equipo necesitas

### 1.1 Dispositivos con LiDAR real

El sensor LiDAR de Apple sólo está en la línea **Pro** de iPhone y en el
**iPad Pro**. No está en los modelos estándar, Plus, mini ni Air.

| Familia | Modelos con LiDAR | Modelos SIN LiDAR |
|---|---|---|
| iPhone | 12 Pro / 12 Pro Max y todos los **Pro** y **Pro Max** posteriores (13, 14, 15, 16, 17) | iPhone 11 y anteriores; todos los modelos base, mini, Plus y Air de cualquier generación |
| iPad | iPad Pro 11" (2.ª generación, 2020) y iPad Pro 12,9" (4.ª generación, 2020) **y posteriores** | iPad, iPad Air, iPad mini de cualquier generación |
| Android | ninguno de forma estándar | — |

Regla corta: **si dice "Pro" y es de 2020 o posterior, tiene LiDAR.**

La app no se fía de la lista: al arrancar consulta a ARKit si el equipo admite
reconstrucción de escena con malla. Si no la admite, las pestañas *Escanear* e
*Interiores* siguen visibles pero muestran una explicación en lugar de la
cámara, con un aviso permanente en la parte superior. La pestaña *Escaneos*
sigue siendo utilizable para ver, importar y exportar escaneos hechos en otro
equipo.

Requisitos adicionales de la app nativa: **iOS 16 o superior**. El
levantamiento de interiores (pestaña *Interiores*, RoomPlan) necesita
**iOS 17 o superior**.

### 1.2 Advertencia honesta sobre el navegador

**Safari en iPhone y iPad no da acceso al LiDAR desde una página web.** No
existe API en WebKit para leer el mapa de profundidad ni la malla de ARKit.
Ninguna PWA, incluida JoseMaps, puede escanear en 3D dentro de Safari. Ésa es
exactamente la razón por la que existe la app nativa `JoseScan`.

En **Android**, el módulo web `js/lidar-scanner.js` sólo funciona si el
navegador expone **WebXR Depth Sensing** — en la práctica, Chrome sobre un
dispositivo con **ARCore** y servicios de Google Play para RA actualizados. Y
hay que ser claro sobre lo que da:

| | iPhone/iPad Pro con la app nativa | Android con WebXR Depth |
|---|---|---|
| Origen del dato | LiDAR (tiempo de vuelo) | profundidad **estimada** por visión y movimiento |
| Precisión típica | 1–2 cm a corta distancia | decimétrica, muy variable |
| Malla con clasificación | sí (muro, piso, techo…) | no |
| Funciona en oscuridad | sí | no |
| Superficies sin textura | sí | falla |
| Uso recomendado | medición y levantamiento | croquis y volumetría aproximada |

Un escaneo hecho en Android se guarda con `"sensor": "webxr"` en su
`escaneo.json`. Trátalo como croquis, no como levantamiento topográfico.

En cualquier navegador (incluido Safari), el panel **Escaneos 3D** de JoseMaps
sí permite abrir, ver en 3D, medir, georreferenciar y exportar escaneos ya
capturados. Lo único bloqueado en Safari es **capturar**.

---

## 2. Cómo escanear bien en campo

### 2.1 Antes de empezar

1. Batería por encima del 40 % y el teléfono frío. El escaneo consume mucho.
2. Espacio libre en el equipo: cuenta con **50–200 MB por escaneo** grande.
3. Limpia la ventana de las cámaras traseras. Una huella arruina el color y
   degrada el LiDAR.
4. Sal al aire libre unos segundos y mueve el teléfono en forma de ocho para
   que la brújula se calibre. Sin brújula fiable, el escaneo saldrá girado.
5. Espera a que el GPS baje de **5 m de precisión horizontal** antes de anclar.

### 2.2 Durante la captura

| Parámetro | Recomendación | Por qué |
|---|---|---|
| Distancia al objeto | **0,5 a 5 m** | por debajo de 0,5 m el sensor no resuelve; más allá de 5 m el ruido crece rápido |
| Velocidad | lenta y **continua**, sin tirones | los saltos rompen el seguimiento visual-inercial |
| Movimiento | traslación suave, no sólo girar sobre el eje | girando en el sitio, ARKit no gana geometría y deriva |
| Recorrido | **ciérralo**: vuelve al punto de partida | permite que ARKit reconozca el sitio y corrija la deriva acumulada |
| Solape | pasa dos veces por las zonas clave | el submuestreo promedia y baja el ruido |
| Iluminación | evita **sol directo** sobre la superficie | la luz infrarroja del sol satura el sensor |
| Superficies | evita vidrio, agua, metal pulido, plástico negro brillante | reflejan o absorben el láser y dejan huecos o puntos fantasma |
| Duración | 1 a 3 minutos por escaneo | más tiempo = más deriva, más calor y archivos enormes |

Si necesitas cubrir un frente largo (una vía, un canal, una cárcava), **haz
varios escaneos cortos y anclados**, no uno solo de diez minutos. Cada uno
llevará su propio origen GPS y en JoseMaps quedarán uno al lado del otro.

### 2.3 El anclaje GPS

El anclaje fija el origen del escaneo en el mundo real: guarda latitud,
longitud, altitud, precisión y **rumbo verdadero** en el momento del anclaje.
Sin eso, el escaneo queda en el marco `arkit` (coordenadas locales, sin norte)
y no se puede exportar a GeoJSON ni superponer en el mapa.

Buenas prácticas:

- Ancla **quieto**, de pie, con el teléfono en alto y lejos de vehículos,
  cercas metálicas, líneas eléctricas o estructuras de acero: todo eso desvía
  la brújula.
- Espera a `precisión < 5 m`. La app considera el ancla utilizable con
  precisión horizontal ≤ 20 m y precisión de rumbo ≤ 15°, pero eso es el
  límite tolerable, no el objetivo.
- **Promedia**: deja el equipo quieto unos 15–30 segundos antes de anclar para
  que la lectura se estabilice, y repite el anclaje si la primera lectura salió
  con mala precisión.
- Anota el rumbo. Si al abrir el escaneo en JoseMaps sale girado, casi siempre
  es la brújula: vuelve a anclar tras calibrarla.

---

## 3. Flujo completo de trabajo

```
   [1] ESCANEAR            App JoseScan, pestaña "Escanear"
        |                  Recorre despacio, cierra el recorrido
        v
   [2] ANCLAR GPS          Quieto, precisión < 5 m, brújula calibrada
        |                  El escaneo pasa del marco "arkit" al marco "enu"
        v
   [3] REVISAR CALIDAD     Puntaje 0-100 en la HUD (densidad, confianza,
        |                  seguimiento). Si es bajo, repite: sale más barato
        v                  que corregirlo en la oficina
   [4] GUARDAR             Queda en la pestaña "Escaneos" con nombre,
        |                  proyecto, notas y miniatura
        v
   [5] EXPORTAR            Compartir -> formato (ver tabla 4) o paquete
        |                  .josescan con todo dentro
        v
   [6] ABRIR EN JoseMaps   Panel "Escaneos 3D": visor 3D, mediciones,
        |                  huella sobre el mapa Leaflet
        v
   [7] EXPORTAR EL TRABAJO KMZ / Excel junto con marcadores y rutas
```

### Detalle del paso 6

En JoseMaps, el panel **Escaneos 3D** acepta el paquete `.josescan` o un `.ply`
/ `.obj` suelto. Al importarlo:

- se guarda en la base local del navegador (`JoseScanDB`), independiente de los
  mapas y marcadores;
- si el escaneo trae ancla GPS, su **huella** (el punto de origen y el polígono
  de la caja envolvente proyectada) aparece sobre el mapa, igual que un
  marcador;
- las coordenadas MAGNA-SIRGAS Origen Nacional (EPSG:9377) del origen se
  calculan con la misma definición que usa el resto de la app (`js/coords.js`,
  IGAC Res. 471/2020: TM, lat₀ 4° N, meridiano central −73°, k 0,9992, falso
  este 5 000 000 m, falso norte 2 000 000 m);
- desde ahí, la huella se exporta a KMZ y sus datos a Excel junto con el resto
  del trabajo de campo.

---

## 4. Qué formato usar para qué

| Formato | Contiene | Úsalo para | Software que lo abre |
|---|---|---|---|
| **PLY binario** (`.ply`) | nube de puntos: XYZ + color RGB + confianza | el formato **por defecto** para llevar la nube a la oficina | CloudCompare, MeshLab, Open3D, ReCap, Cyclone |
| **PLY texto** (`.ply` ASCII) | igual, pero legible | depurar, revisar a mano, importar en herramientas que no leen binario | cualquier editor de texto, CloudCompare |
| **OBJ** (`.obj` + `.mtl`) | malla triangular con normales, agrupada por muro/piso/techo | modelado, render, medir superficies | Blender, SketchUp, 3ds Max, MeshLab, Rhino |
| **STL** (`.stl`) | malla triangular sin color | impresión 3D y CAD | AutoCAD, Civil 3D, Fusion 360, cortadores 3D |
| **USDZ** (`.usdz`) | malla lista para RA | enseñar el escaneo a alguien en el celular, sin instalar nada | Vista Rápida de iOS/macOS, iMessage, WhatsApp (en iOS) |
| **XYZ** (`.xyz`) | texto plano: una línea por punto | software topográfico que sólo come texto | Civil 3D, Topocal, AutoCAD, Excel |
| **GeoJSON** (`.geojson`) | huella georreferenciada WGS84: punto de origen + polígono de la caja | llevar la **ubicación** del escaneo a un SIG o al mapa | QGIS, ArcGIS, JoseMaps, Google Earth (vía KMZ) |
| **CSV** (`.csv`) | puntos y/o mediciones tabulados | planillas, informes, cálculo de cantidades | Excel, LibreOffice, Google Sheets |
| **`.josescan`** | ZIP con todo: metadatos, nube, malla, miniatura y huella | **archivar** el escaneo y moverlo entre el iPhone y JoseMaps sin perder nada | la app JoseScan, el panel Escaneos 3D de JoseMaps, cualquier descompresor |

Reglas rápidas:

- ¿Vas a medir o a procesar la nube? → **PLY binario**.
- ¿Vas a dibujar planos en CAD? → **OBJ** o **STL**.
- ¿Sólo necesitas que la ubicación quede en el SIG? → **GeoJSON** (y de ahí a
  KMZ desde JoseMaps).
- ¿Vas a guardar el trabajo o pasarlo a otro equipo? → **`.josescan`**.
- OBJ, STL y USDZ **requieren malla**. Si desactivaste la captura de malla en
  Ajustes, esos tres formatos no estarán disponibles.

Todas las unidades son **metros**. Si el escaneo está anclado, los ejes son
`+X = Este`, `+Y = Norte`, `+Z = Arriba`; si no lo está, son los ejes locales de
ARKit (`+X` derecha, `+Y` arriba, `−Z` hacia donde miraba la cámara) y no tienen
norte.

---

## 5. Solución de problemas

### "El seguimiento se pierde" / "Reinicializando"

Causa: la cámara no ve suficiente textura, hay poca luz, o el movimiento fue
demasiado rápido.

Qué hacer:

1. Detente y apunta a una zona con detalle (grietas, textura, bordes).
2. Espera a que el aviso desaparezca antes de seguir.
3. Si sigue perdiéndose: enciende la linterna, muévete más despacio, evita
   apuntar a paredes lisas de un solo color o a cielo abierto.
4. Si ya perdiste mucha geometría, es mejor reiniciar el escaneo que arrastrar
   un modelo mal alineado.

### "Los puntos salen dobles" (superficies duplicadas o fantasma)

Causa: deriva del seguimiento. Al pasar por segunda vez, ARKit cree estar en
otro sitio y deposita la superficie desplazada.

Qué hacer:

- **Cierra el recorrido**: vuelve al punto de partida por el mismo camino.
- Haz escaneos más cortos.
- Sube el tamaño de vóxel en Ajustes (de 0,02 m a 0,03–0,05 m): el promediado
  por vóxel funde los duplicados cercanos, a costa de detalle.
- Sube la confianza mínima a *alta* para descartar el ruido de los bordes.

### "El escaneo sale girado" (rumbo/brújula)

Causa: el rumbo verdadero guardado al anclar era malo. La rotación
ARKit → ENU depende sólo de ese valor, así que un error de brújula gira todo el
escaneo en bloque.

Qué hacer:

1. Calibra la brújula: mueve el teléfono en forma de ocho durante unos segundos.
2. Aléjate de metal, vehículos, mallas, transformadores y líneas eléctricas.
3. Quítale la funda si tiene imán (MagSafe, soportes magnéticos de carro).
4. Vuelve a anclar. El giro se corrige por completo al reanclar; no hace falta
   volver a escanear la geometría.
5. Comprueba en la HUD que la precisión de rumbo esté por debajo de 15°.

### "No aparece el sensor" / la pestaña Escanear está bloqueada

Causa: el equipo no tiene LiDAR, o se negó el permiso de cámara.

Qué hacer:

- Verifica el modelo contra la tabla del apartado 1.1. Si es un iPhone no-Pro
  o un iPad Air/base, **no hay solución**: ese equipo no puede escanear.
- Si el equipo sí tiene LiDAR: Ajustes → JoseScan → activa **Cámara**. Sin ese
  permiso ARKit no arranca.
- En el navegador (Safari), la captura nunca estará disponible: ver 1.2.

### "Se calienta el teléfono"

El escaneo usa cámara, LiDAR, CPU y GPU a la vez. iOS reduce el rendimiento
cuando el equipo se calienta y la app lo avisa en la HUD.

Qué hacer:

- Escaneos de 1–3 minutos, con pausas entre uno y otro.
- Quítale la funda y no lo dejes al sol entre escaneos.
- Desconéctalo del cargador mientras escaneas.
- Baja `fps de captura` y sube el tamaño de vóxel en Ajustes: menos puntos por
  segundo, menos trabajo.
- Si aparece un aviso térmico, guarda lo que tengas y deja enfriar el equipo.

### "No hay espacio"

- Un escaneo grande ocupa entre 50 y 200 MB. Diez escaneos llenan 2 GB sin
  esfuerzo.
- Exporta y borra: desde *Escaneos*, comparte a Archivos o AirDrop y luego
  elimina de la app.
- Baja `máximo de puntos` y sube el tamaño de vóxel en Ajustes.
- Desactiva la captura de nube si sólo necesitas la malla (o al revés): la nube
  densa es lo que más pesa.
- Al exportar, **PLY binario ocupa aproximadamente la tercera parte que PLY
  texto** para el mismo contenido.

---

## 6. Límites y precisión realistas

El LiDAR del iPhone es un sensor de tiempo de vuelo pensado para realidad
aumentada, no un escáner topográfico. Lo que se puede esperar en campo:

| Distancia al objeto | Error típico esperable |
|---|---|
| 0,5 – 1 m | ~1 cm |
| 1 – 2 m | 1 – 2 cm |
| 2 – 3 m | 2 – 4 cm |
| 3 – 5 m | 4 cm o más, con ruido creciente |
| más de 5 m | fuera de alcance útil: los puntos son poco fiables |

Además:

- El **alcance útil es de unos 5 m.** Por eso la distancia máxima de captura
  viene configurada en 5 m: los puntos más lejanos se descartan a propósito.
- El error **relativo** (medir el ancho de una pared que se ve completa en el
  escaneo) es mejor que el error **absoluto** (dónde está esa pared en el
  mundo). La posición absoluta la limita el GPS del teléfono: en campo abierto,
  de 3 a 10 m; bajo dosel o entre edificios, peor.
- La **altitud** del GPS es el dato más pobre de todos. No la uses para
  nivelación ni para cotas de proyecto.
- La deriva del seguimiento se acumula con el tiempo y la distancia recorrida:
  un escaneo de 30 m de largo puede cerrar con varios centímetros —a veces
  decímetros— de error entre el principio y el final si no se cierra el
  recorrido.
- El sol directo, el vidrio, el agua, el metal pulido y las superficies negras
  mates producen huecos o puntos falsos. No es un defecto de la app.

**Conclusión práctica:** JoseScan sirve para levantar geometría, medir
elementos, documentar el estado de una obra o una cárcava y ubicarla en el
mapa. **No sustituye** una estación total, un GNSS RTK ni un escáner láser
terrestre cuando se necesita precisión centimétrica absoluta.
