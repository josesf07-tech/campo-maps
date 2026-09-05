# Digitalizador de listados de asistencia

Convierte fotos o escaneos de listas de asistencia **escritas a mano** en datos
utilizables (CSV, Excel o JSON), indicando quién firmó, quién no, y qué filas
necesitan una revisión humana.

Está pensado para el caso real: una foto de móvil de una hoja apoyada en una
mesa, con sombras, perspectiva, la hoja torcida y letra de campo.

## Qué hace

1. **Preparación de la imagen**: detecta la hoja y corrige la perspectiva,
   endereza la inclinación, elimina sombras dividiendo por el fondo estimado y
   binariza con umbral adaptativo.
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
6. **Validación** (la parte que hace que el resultado sea *correcto*):
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
pip install numpy opencv-python-headless          # núcleo
pip install anthropic rapidfuzz openpyxl          # motor por defecto + extras
export ANTHROPIC_API_KEY="tu-clave"               # o `ant auth login`
```

Otros extras según lo que necesites: `pypdfium2` (PDF), `pytesseract`,
`transformers torch pillow` (TrOCR), `pytest` (pruebas). Ver
`requirements.txt`.

## Uso

```bash
# Una foto, con la lista oficial de personas para corregir los nombres
python -m digitalizador lista.jpg --padron padron.csv -s asistencia.xlsx -f xlsx

# Una carpeta entera o un PDF de varias páginas
python -m digitalizador escaneos/ -s asistencia.csv
python -m digitalizador acta.pdf --dpi 400 -f todos

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
confianza, revisar, motivos, nombre_leido, padron_estado, padron_puntaje`

- `presente` / `ausente` / `dudoso` en cada columna de firma o asistencia.
- `confianza` de 0 a 1; por debajo de `--umbral-confianza` (0.60) la fila se
  marca para revisión.
- `motivos` explica por qué hay que revisarla: *nombre vacío o ilegible*,
  *no figura en el padrón*, *posible 'Ana Belén Ortega' (78 % de parecido)*,
  *documento con dígito de control incorrecto*, *marca ambigua en 'Firma'*,
  *posible duplicado de la fila 4*, *numeración inesperada*.

En Excel las filas a revisar salen resaltadas. Con `--depuracion` se guarda la
página con cada fila dibujada en verde (correcta) o rojo (a revisar).

## Cómo conseguir buenos resultados

- **Aporta el padrón siempre que exista.** Es lo que más sube la precisión:
  transforma el problema de "leer una palabra" en "elegir de una lista".
- **Fotografía la hoja completa**, con las cuatro esquinas visibles, lo más
  perpendicular posible y sin sombra sobre la tabla.
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

Las pruebas generan hojas sintéticas (con inclinación y ruido) y comprueban la
detección de la rejilla, la clasificación de marcas contra la verdad conocida,
el cotejo con el padrón y la exportación. La ruta del modelo de visión se
prueba con un cliente falso, así que **no hacen falta ni API ni red**.

## Limitaciones conocidas

- La confianza que reporta el modelo de visión es una autoevaluación, no una
  probabilidad calibrada: úsala para priorizar la revisión, no como garantía.
- Celdas con dos nombres, tachones o notas al margen se transcriben como una
  sola cadena; conviene revisarlas.
- La validación de dígito de control solo cubre DNI/NIE españoles; otros
  documentos solo se comprueban por longitud y formato.
- `trocr` y `tesseract` rinden mucho peor que los motores de visión con letra
  manuscrita real; están para casos sin conectividad.
