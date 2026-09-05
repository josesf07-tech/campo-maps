# Digitalizador de listados de asistencia

Convierte fotos o escaneos de listas de asistencia **escritas a mano** en datos
utilizables (CSV, Excel o JSON), indicando quién firmó, quién no, y qué filas
necesitan una revisión humana.

Está pensado para el caso real: **PDF escaneados** de hojas rellenadas a mano
—páginas torcidas o de lado, escaneos flojos, hojas en blanco intercaladas— y
**letra de calidad muy desigual**, con gente que escribe fatal.

## Qué hace

1. **Preparación de la imagen**: rasteriza el PDF, detecta la hoja y corrige la
   perspectiva, endereza la inclinación, corrige los escaneos que salen de lado
   o del revés, elimina sombras dividiendo por el fondo estimado, realza el
   contraste de los escaneos flojos y binariza con umbral adaptativo. Las
   páginas en blanco se detectan y se omiten sin gastar una petición.
2. **Estructura**: aísla las líneas de la rejilla con morfología y deduce filas
   y columnas. Si la hoja no tiene rejilla, segmenta las filas por proyección
   de la tinta.
3. **Roles de columna**: los deduce del encabezado impreso (N.º, Nombre, DNI,
   Firma, fechas…) o, si no lo hay, de la geometría de la tabla. También se
   pueden forzar con `--columnas`.
4. **Transcripción**: envía la hoja al modelo de visión de Claude, que devuelve
   la tabla ya estructurada; o transcribe celda a celda con Claude, TrOCR o
   Tesseract.
5. **Marcas de asistencia**: en las columnas de firma o de asistencia no
   "lee" nada: mide la tinta manuscrita de cada celda descontando las líneas de
   la rejilla, y calibra el umbral por columna con Otsu 1-D. Las celdas
   ambiguas se marcan como `dudoso` en vez de inventar un valor.
6. **Segunda lectura de lo dudoso**: las filas que quedan flojas se vuelven a
   preguntar en una única petición extra por página, indicando qué se leyó, por
   qué se marcó y los nombres del padrón más parecidos. La nueva lectura solo
   se acepta si mejora; lo que sigue ilegible se queda marcado como tal.
7. **Validación** (la parte que hace que el resultado sea *correcto*):
   - limpia nombres y documentos, corrigiendo confusiones típicas (`0/O`,
     `1/I`, `5/S`, `8/B`) según el tipo de campo;
   - valida la letra de control de DNI/NIE españoles;
   - coteja cada nombre contra el **padrón** (la lista oficial de personas) y
     corrige la grafía cuando el parecido es alto;
   - detecta duplicados y saltos en la numeración;
   - marca para revisión toda fila poco fiable, con el motivo concreto.

El resultado nunca "adivina": lo que no está claro se etiqueta como dudoso y
aparece en el informe de revisión.

## Instalación

```bash
cd tools/digitalizador_asistencia
pip install -r requirements.txt                   # núcleo (incluye lectura de PDF)
pip install anthropic rapidfuzz openpyxl          # motor por defecto + extras
export ANTHROPIC_API_KEY="tu-clave"               # o `ant auth login`
```

Otros extras según lo que necesites: `pytesseract`, `transformers torch pillow`
(TrOCR), `pytest` y `pillow` (pruebas). Ver `requirements.txt`.

## Uso

```bash
# Caso habitual: un PDF escaneado con la lista oficial de personas
python -m digitalizador acta.pdf --padron padron.csv -s asistencia.xlsx -f xlsx

# Solo unas páginas del PDF, y a más resolución si la letra es pequeña
python -m digitalizador acta.pdf --paginas 2-5,9 --dpi 400 -f todos

# Una carpeta entera de escaneos o fotos
python -m digitalizador escaneos/ --padron padron.csv -s asistencia.csv

# Sin API: solo estructura y marcas de asistencia
python -m digitalizador lista.jpg --motor nulo --columnas numero,nombre,documento,firma

# Prueba rápida con una hoja sintética, sin necesidad de imágenes ni API
python -m digitalizador --demo --motor nulo --encabezado si \
    --columnas numero,nombre,documento,firma -s demo.csv --depuracion debug/
```

Desde Python:

```python
from digitalizador import Config, procesar_archivo, exportar, informe
from digitalizador.normalizacion import cargar_padron

cfg = Config(motor="claude-hoja", umbral_confianza=0.7)
hojas = procesar_archivo("lista.jpg", cfg, padron=cargar_padron("padron.csv"))

for registro in hojas[0].registros:
    print(registro.numero, registro.nombre.texto, registro.asistencia)

print(informe(hojas))
exportar(hojas, "asistencia.xlsx", "xlsx")
```

### Opciones principales

| Opción | Para qué sirve |
|---|---|
| `--motor` | `claude-hoja` (por defecto), `claude`, `trocr`, `tesseract`, `nulo` |
| `--padron` | CSV (`nombre[,documento]`) o TXT con un nombre por línea |
| `--columnas` | Fuerza los roles: `numero,nombre,documento,cargo,contacto,firma,asistencia,ignorar` |
| `--encabezado` | `auto`, `si` o `no` (si la primera fila es un encabezado impreso) |
| `--formato` | `csv`, `json`, `xlsx` o `todos` |
| `--paginas` | Páginas del PDF a procesar: `2-5,9` (vacío = todas) |
| `--dpi` | Resolución al rasterizar el PDF (300 por defecto; 400 si la letra es pequeña) |
| `--rotacion` | `auto` (detecta escaneos de lado o del revés), o un giro fijo `0/90/180/270` |
| `--sin-segunda-opinion` | No releer las filas dudosas (ahorra una petición por página) |
| `--imagen-modelo` | Qué ve el modelo: `auto`, `color` o `realzada` |
| `--depuracion` | Carpeta donde guardar la página con las filas detectadas dibujadas |
| `--informe` | Guarda en un `.txt` el listado de filas a revisar |
| `--config` | JSON con cualquier campo de `Config` (todos los umbrales) |

## Motores

| Motor | Dónde corre | Manuscrita | Notas |
|---|---|---|---|
| `claude-hoja` *(por defecto)* | API | **Muy buena** | Una petición por página; el modelo ve toda la hoja, por lo que aprovecha el contexto de las columnas y del resto de nombres |
| `claude` | API | Muy buena | Transcribe celda a celda sobre la rejilla detectada localmente; útil si quieres controlar tú la segmentación |
| `trocr` | Local | Buena | `microsoft/trocr-base-handwritten`, sin API; entrenado en inglés, con nombres en español acierta menos |
| `tesseract` | Local | Baja | Pensado para letra de imprenta; sirve para formularios rellenados en mayúsculas de molde |
| `nulo` | — | — | No transcribe; solo estructura y marcas de asistencia |

Los motores de API usan `claude-opus-5` con razonamiento adaptativo. Se puede
cambiar con `--modelo` y ajustar el coste con `--esfuerzo low|medium|high`.

## Salida

Una fila por persona con:

`archivo, pagina, fila, numero, nombre, documento, <columnas de la hoja>,
confianza, revisar, motivos, relectura, nombre_leido, padron_estado,
padron_puntaje`

- `presente` / `ausente` / `dudoso` en cada columna de firma o asistencia.
- `confianza` de 0 a 1; por debajo de `--umbral-confianza` (0.60) la fila se
  marca para revisión.
- `motivos` explica por qué hay que revisarla: *nombre vacío o ilegible*,
  *no figura en el padrón*, *posible 'Ana Belén Ortega' (78 % de parecido)*,
  *documento con dígito de control incorrecto*, *marca ambigua en 'Firma'*,
  *posible duplicado de la fila 4*, *numeración inesperada*,
  *sigue ilegible tras la segunda lectura*.
- `relectura` indica si esa fila pasó por la segunda lectura, y `nombre_leido`
  conserva la transcripción original para poder auditar la corrección.

En Excel las filas a revisar salen resaltadas. Con `--depuracion` se guarda la
página con cada fila dibujada en verde (correcta) o rojo (a revisar).

## PDF escaneados

Es el formato de entrada previsto, y el pipeline lo trata como un lote:

- **Multipágina**: una hoja de salida por página, y el número de página que
  aparece en el CSV es el real dentro del PDF (aunque se procese solo un rango
  con `--paginas 2-5,9`).
- **Una página mala no tumba el lote**: si una falla (rasterizado corrupto,
  error de red), esa hoja se anota con el error, sale en el informe y el resto
  del PDF continúa.
- **Páginas en blanco**: se detectan por densidad de tinta y se omiten sin
  gastar una petición a la API.
- **Escaneos de lado o del revés**: se corrigen antes de segmentar. La
  detección combina dos señales: una lista tiene muchas más líneas de fila que
  de columna, y en la escritura latina la tinta de cada renglón se concentra
  por debajo del centro. Si las señales no son claras, no se arriesga el giro y
  se anota en el informe; siempre puedes forzarlo con `--rotacion 180`.
- **Escaneos flojos**: en páginas en escala de grises se envía al modelo el
  gris normalizado y realzado (CLAHE) en vez del original, que en fotocopias
  pálidas se lee bastante mejor. Con `--imagen-modelo` se puede forzar.
- **Resolución**: 300 ppp va bien para letra normal; sube a `--dpi 400` si la
  hoja tiene muchas filas o la letra es pequeña. Si la imagen se pasa del
  límite de tamaño de la API, se recodifica a JPEG antes de tocar la
  resolución, que es lo que de verdad perjudica a la lectura.

```bash
python -m digitalizador acta.pdf --padron padron.csv --dpi 400 \
    -s asistencia.xlsx -f xlsx --informe revision.txt --depuracion debug/
```

## Cuando la letra es mala

Es el caso normal, no la excepción, y el diseño lo asume:

1. **El padrón entra como contexto.** Si aportas `--padron`, los nombres
   esperados viajan con la hoja: el modelo ancla la grafía a la lista oficial
   en vez de inventar una ortografía. La instrucción es explícita en no
   sustituir un nombre por otro parecido sin que los trazos lo respalden.
2. **Segunda lectura dirigida.** Terminada la primera pasada, las filas
   marcadas (lectura floja, nombre fuera del padrón, documento inválido, marca
   ambigua) se releen en **una sola petición extra por página**, indicando qué
   se leyó, por qué se dudó y los candidatos del padrón más parecidos a esa
   lectura. La nueva versión solo sustituye a la anterior si viene con más
   confianza o anclada a un nombre del padrón: nunca se cambia una lectura
   buena por una peor.
3. **Lo ilegible se queda ilegible.** Si tras la segunda lectura sigue sin
   entenderse, la fila conserva la mejor transcripción disponible pero queda
   marcada con el motivo "sigue ilegible tras la segunda lectura". El sistema
   no rellena huecos por su cuenta.
4. **Trazabilidad.** El CSV guarda `nombre_leido` (lo que se leyó en la hoja)
   junto al `nombre` final, más `padron_estado`, `padron_puntaje` y `relectura`,
   para poder auditar cada corrección.

Con `--sin-segunda-opinion` se desactiva el paso 2 si prefieres ahorrar
peticiones; el resto sigue igual.

## Cómo conseguir buenos resultados

- **Aporta el padrón siempre que exista.** Es lo que más sube la precisión:
  transforma el problema de "leer una palabra" en "elegir de una lista".
- **Escanea a 300 ppp o más**, en escala de grises y con la hoja bien apoyada;
  si fotografías, que se vean las cuatro esquinas y no haya sombra sobre la
  tabla.
- **Revisa el informe por páginas**: indica los giros aplicados, las páginas en
  blanco, los errores y cuántas filas mejoró la segunda lectura.
- Con hojas de varios días, usa `--columnas` para nombrar cada columna de
  asistencia, o deja que el encabezado impreso las identifique.
- Revisa siempre las filas con `revisar = True`: son pocas y son justo donde
  el sistema no se juega la exactitud.
- Si la rejilla es muy tenue, baja `cobertura_linea_h` / `cobertura_linea_v` en
  un JSON de configuración; si sale rejilla donde no la hay, súbelas.

## Estructura del código

```
digitalizador/
├── config.py         umbrales y roles de columna
├── preprocesado.py   carga (imagen/PDF), perspectiva, enderezado, binarizado
├── tabla.py          rejilla, filas, roles de columna
├── marcas.py         tinta por celda y calibración de umbrales (Otsu 1-D)
├── ocr.py            motores: claude-hoja, claude, trocr, tesseract, nulo
├── revision.py       segunda lectura de las filas dudosas
├── normalizacion.py  limpieza, validación de documento, cotejo con el padrón
├── pipeline.py       orquestación y validación final
├── exportacion.py    CSV / JSON / XLSX e informe
├── sintetico.py      generador de hojas de prueba
└── cli.py            interfaz de línea de comandos
```

## Pruebas

```bash
pip install pytest
python -m pytest tests -q
```

Las pruebas generan hojas sintéticas y PDF escaneados simulados (girados,
en blanco, con ruido y bajo contraste) y comprueban la corrección de rotación,
la detección de la rejilla, la clasificación de marcas contra la verdad
conocida, la selección de páginas, el cotejo con el padrón, la segunda lectura
y la exportación. Las rutas del modelo de visión se prueban con un cliente
falso, así que **no hacen falta ni API ni red**.

## Limitaciones conocidas

- La confianza que reporta el modelo de visión es una autoevaluación, no una
  probabilidad calibrada: úsala para priorizar la revisión, no como garantía.
- Celdas con dos nombres, tachones o notas al margen se transcriben como una
  sola cadena; conviene revisarlas.
- La detección de páginas del revés (180°) es heurística: con hojas de muy poco
  texto puede quedarse corta y no girar. El informe dice qué giro se aplicó y
  `--rotacion` permite forzarlo para todo el lote.
- La segunda lectura mejora los casos flojos, pero no obra milagros con una
  firma ilegible: ahí lo correcto es que la fila salga marcada.
- La validación de dígito de control solo cubre DNI/NIE españoles; otros
  documentos solo se comprueban por longitud y formato.
- `trocr` y `tesseract` rinden mucho peor que los motores de visión con letra
  manuscrita real; están para casos sin conectividad.
