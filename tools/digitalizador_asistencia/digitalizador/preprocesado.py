"""Carga y preparación de las imágenes del listado.

Pensado para el caso real: fotos de móvil de una hoja apoyada en una mesa,
con sombras, perspectiva e inclinación, o escaneos/PDF.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np

from .config import Config

EXTENSIONES_IMAGEN = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}


@dataclass
class Pagina:
    """Imagen lista para segmentar."""

    color: np.ndarray      # BGR, ya enderezada y reescalada
    gris: np.ndarray       # gris con el fondo normalizado
    binaria: np.ndarray    # tinta = 255, papel = 0
    modelo: np.ndarray     # versión que se envía al modelo de visión
    escala: float
    angulo: float
    recortada: bool
    rotacion: int = 0          # múltiplo de 90 aplicado para enderezar el escaneo
    en_blanco: bool = False
    tinta: float = 0.0         # fracción de píxeles con tinta (sin líneas)


# --------------------------------------------------------------------------
# Carga
# --------------------------------------------------------------------------
def analizar_seleccion(especificacion: str, total: int) -> List[int]:
    """Convierte "1-3,7" en índices 0..total-1. Vacío = todas las páginas."""
    especificacion = (especificacion or "").strip()
    if not especificacion:
        return list(range(total))
    indices: List[int] = []
    for trozo in especificacion.split(","):
        trozo = trozo.strip()
        if not trozo:
            continue
        if "-" in trozo:
            desde, _, hasta = trozo.partition("-")
            try:
                inicio = int(desde) if desde.strip() else 1
                final = int(hasta) if hasta.strip() else total
            except ValueError as exc:
                raise ValueError(f"Rango de páginas inválido: {trozo!r}") from exc
            paso = 1 if final >= inicio else -1
            candidatos = range(inicio, final + paso, paso)
        else:
            try:
                candidatos = [int(trozo)]
            except ValueError as exc:
                raise ValueError(f"Página inválida: {trozo!r}") from exc
        for numero in candidatos:
            indice = numero - 1
            if 0 <= indice < total and indice not in indices:
                indices.append(indice)
    return indices


def contar_paginas(ruta: Path | str) -> int:
    """Número de páginas del archivo (1 para una imagen suelta)."""
    ruta = Path(ruta)
    if ruta.suffix.lower() != ".pdf":
        return 1
    lector, documento = _abrir_pdf(ruta)
    return len(documento) if lector == "pypdfium2" else documento.page_count


def cargar_paginas(
    ruta: Path | str, dpi: int = 300, seleccion: str = ""
) -> List[Tuple[int, np.ndarray]]:
    """Páginas de un PDF (o la única de una imagen) como (número, imagen BGR).

    El número devuelto es el de la página real dentro del archivo, para que la
    salida siga siendo trazable aunque se procese solo un rango.
    """
    ruta = Path(ruta)
    if not ruta.exists():
        raise FileNotFoundError(f"No existe el archivo: {ruta}")
    if ruta.suffix.lower() == ".pdf":
        return _paginas_pdf(ruta, dpi, seleccion)
    if ruta.suffix.lower() not in EXTENSIONES_IMAGEN:
        raise ValueError(f"Formato no soportado: {ruta.suffix}")
    datos = np.fromfile(str(ruta), dtype=np.uint8)
    imagen = cv2.imdecode(datos, cv2.IMREAD_COLOR)
    if imagen is None:
        raise ValueError(f"No se pudo leer la imagen: {ruta}")
    return [(1, imagen)]


def _abrir_pdf(ruta: Path):
    """Abre el PDF con la biblioteca disponible: (nombre, documento)."""
    try:
        import pypdfium2  # type: ignore
    except ImportError:
        pass
    else:
        return "pypdfium2", pypdfium2.PdfDocument(str(ruta))

    try:
        import fitz  # type: ignore  (PyMuPDF)
    except ImportError as exc:  # pragma: no cover - depende del entorno
        raise RuntimeError(
            "Para leer PDF instala 'pypdfium2' (recomendado) o 'pymupdf'."
        ) from exc
    return "pymupdf", fitz.open(str(ruta))


def _paginas_pdf(ruta: Path, dpi: int, seleccion: str = "") -> List[Tuple[int, np.ndarray]]:
    lector, documento = _abrir_pdf(ruta)
    total = len(documento) if lector == "pypdfium2" else documento.page_count
    indices = analizar_seleccion(seleccion, total)

    paginas: List[Tuple[int, np.ndarray]] = []
    for indice in indices:
        if lector == "pypdfium2":
            mapa = documento[indice].render(scale=dpi / 72.0)
            arreglo = np.asarray(mapa.to_pil().convert("RGB"))
            imagen = cv2.cvtColor(arreglo, cv2.COLOR_RGB2BGR)
        else:  # pragma: no cover - ruta alternativa según el entorno
            mapa = documento[indice].get_pixmap(dpi=dpi)
            arreglo = np.frombuffer(mapa.samples, dtype=np.uint8)
            arreglo = arreglo.reshape(mapa.height, mapa.width, mapa.n)
            conversion = cv2.COLOR_RGBA2BGR if mapa.n == 4 else cv2.COLOR_RGB2BGR
            imagen = cv2.cvtColor(arreglo, conversion) if mapa.n >= 3 else cv2.cvtColor(
                arreglo.reshape(mapa.height, mapa.width), cv2.COLOR_GRAY2BGR
            )
        paginas.append((indice + 1, imagen))
    return paginas


def listar_entradas(ruta: Path | str) -> List[Path]:
    """Un archivo, o todos los archivos soportados de una carpeta."""
    ruta = Path(ruta)
    if ruta.is_file():
        return [ruta]
    if not ruta.is_dir():
        raise FileNotFoundError(f"No existe la ruta: {ruta}")
    validas = EXTENSIONES_IMAGEN | {".pdf"}
    return sorted(p for p in ruta.iterdir() if p.suffix.lower() in validas)


# --------------------------------------------------------------------------
# Preparación
# --------------------------------------------------------------------------
def preparar(imagen: np.ndarray, cfg: Config) -> Pagina:
    """Recorta el documento, corrige la rotación, endereza, normaliza y binariza."""
    trabajo = imagen
    recortada = False
    if cfg.recortar_documento:
        recorte = recortar_documento(trabajo)
        if recorte is not None:
            trabajo = recorte
            recortada = True

    trabajo, escala = escalar(trabajo, cfg)

    # Los escaneos por lotes salen a menudo de lado o del revés.
    rotacion = resolver_rotacion(trabajo, cfg)
    if rotacion:
        trabajo = aplicar_rotacion(trabajo, rotacion)

    angulo = 0.0
    if cfg.enderezar:
        angulo = estimar_inclinacion(trabajo, cfg.angulo_maximo)
        if abs(angulo) > 0.1:
            trabajo = rotar(trabajo, angulo)

    gris = quitar_sombra(cv2.cvtColor(trabajo, cv2.COLOR_BGR2GRAY))
    binaria = binarizar(gris, cfg)
    tinta = float((binaria > 0).mean())
    return Pagina(
        color=trabajo,
        gris=gris,
        binaria=binaria,
        modelo=imagen_para_modelo(trabajo, gris, cfg),
        escala=escala,
        angulo=angulo,
        recortada=recortada,
        rotacion=rotacion,
        en_blanco=tinta < cfg.umbral_pagina_blanco,
        tinta=tinta,
    )


# --------------------------------------------------------------------------
# Orientación (escaneos de lado o del revés)
# --------------------------------------------------------------------------
def resolver_rotacion(imagen: np.ndarray, cfg: Config) -> int:
    """Grados horarios que hay que girar la página para dejarla derecha."""
    if cfg.rotacion != "auto":
        return int(cfg.rotacion) % 360
    if not cfg.corregir_rotacion:
        return 0
    return detectar_rotacion(imagen, cfg)


def detectar_rotacion(imagen: np.ndarray, cfg: Config) -> int:
    """Detecta si el escaneo está de lado o del revés.

    Dos señales independientes:
      1. Una lista de asistencia tiene muchas más líneas de fila que de
         columna; si se detecta lo contrario, la hoja está de lado.
      2. En escritura latina la tinta de cada renglón se concentra por debajo
         del centro de la banda (cuerpo de las letras frente a las
         ascendentes), así que el giro correcto es el que maximiza esa
         asimetría. Si las dos alternativas empatan, no se gira.
    """
    gris = quitar_sombra(cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY))
    binaria = binarizar(gris, cfg)
    if (binaria > 0).mean() < cfg.umbral_pagina_blanco:
        return 0

    from .tabla import mascaras_lineas, posiciones_lineas  # import diferido

    horizontal, vertical = mascaras_lineas(binaria, cfg)
    n_filas = len(posiciones_lineas(horizontal, 0, cfg.cobertura_linea_h, cfg.separacion_minima))
    n_columnas = len(posiciones_lineas(vertical, 1, cfg.cobertura_linea_v, cfg.separacion_minima))
    de_lado = n_columnas >= max(6, 2 * n_filas)

    candidatos = (90, 270) if de_lado else (0, 180)
    puntajes = {
        grados: puntaje_orientacion(aplicar_rotacion(binaria, grados), cfg)
        for grados in candidatos
    }
    mejor = max(candidatos, key=lambda g: puntajes[g])
    peor = min(candidatos, key=lambda g: puntajes[g])
    if puntajes[mejor] - puntajes[peor] < cfg.margen_orientacion:
        # Señal débil: no se arriesga un giro de 180°, solo se endereza si
        # la hoja está claramente de lado.
        return 90 if de_lado else 0
    return mejor


def puntaje_orientacion(binaria: np.ndarray, cfg: Config) -> float:
    """Asimetría vertical de la tinta: positiva cuando el texto está derecho."""
    from .marcas import quitar_lineas  # import diferido

    tinta = quitar_lineas(binaria, cfg)
    perfil = (tinta > 0).sum(axis=1).astype(np.float32)
    if perfil.max() <= 0:
        return 0.0
    umbral = 0.08 * perfil.max()
    puntajes: List[float] = []
    inicio: Optional[int] = None
    for y in range(len(perfil) + 1):
        activo = y < len(perfil) and perfil[y] >= umbral
        if activo and inicio is None:
            inicio = y
        elif not activo and inicio is not None:
            if y - inicio >= 8:
                banda = perfil[inicio:y]
                if banda.sum() > 0:
                    posiciones = np.arange(len(banda), dtype=np.float32)
                    centro = float((posiciones * banda).sum() / banda.sum())
                    puntajes.append(centro / max(len(banda) - 1, 1) - 0.5)
            inicio = None
    return float(np.mean(puntajes)) if puntajes else 0.0


def aplicar_rotacion(imagen: np.ndarray, grados: int) -> np.ndarray:
    """Gira la imagen un múltiplo de 90 grados en sentido horario."""
    grados = int(grados) % 360
    if grados == 90:
        return cv2.rotate(imagen, cv2.ROTATE_90_CLOCKWISE)
    if grados == 180:
        return cv2.rotate(imagen, cv2.ROTATE_180)
    if grados == 270:
        return cv2.rotate(imagen, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return imagen


# --------------------------------------------------------------------------
# Imagen que se envía al modelo de visión
# --------------------------------------------------------------------------
def realzar(gris: np.ndarray) -> np.ndarray:
    """Realza el contraste local: rescata trazos flojos de lápiz o fotocopia."""
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    return clahe.apply(gris)


def es_gris(imagen: np.ndarray, tolerancia: int = 12) -> bool:
    """¿La página es prácticamente en escala de grises? (típico de un escaneo).

    Se mira el percentil alto de la separación entre canales, no la media: en
    una hoja el papel ocupa casi todo el área y ahogaría el color de la tinta.
    """
    if imagen.ndim != 3 or imagen.shape[2] < 3:
        return True
    muestra = imagen[::4, ::4].astype(np.int16)
    extension = muestra.max(axis=2) - muestra.min(axis=2)
    return float(np.percentile(extension, 99)) <= tolerancia


def imagen_para_modelo(color: np.ndarray, gris: np.ndarray, cfg: Config) -> np.ndarray:
    """Elige qué versión de la página ve el modelo de visión.

    En escaneos (grises, con poco contraste) el gris normalizado y realzado se
    lee mucho mejor que el original; en fotos a color se conserva el color,
    que ayuda a distinguir el bolígrafo del formulario impreso.
    """
    modo = cfg.imagen_modelo
    if modo == "color":
        return color
    if modo == "realzada" or (modo == "auto" and es_gris(color)):
        return realzar(gris)
    return color


def escalar(imagen: np.ndarray, cfg: Config) -> Tuple[np.ndarray, float]:
    """Lleva la página a un ancho de trabajo estable."""
    ancho = imagen.shape[1]
    objetivo = cfg.ancho_objetivo
    if ancho < cfg.ancho_minimo:
        objetivo = max(objetivo, cfg.ancho_minimo)
    if ancho == objetivo:
        return imagen, 1.0
    factor = objetivo / float(ancho)
    interpolacion = cv2.INTER_AREA if factor < 1 else cv2.INTER_CUBIC
    redimensionada = cv2.resize(imagen, None, fx=factor, fy=factor, interpolation=interpolacion)
    return redimensionada, factor


def quitar_sombra(gris: np.ndarray, radio: int = 31) -> np.ndarray:
    """Divide la imagen por su fondo estimado: elimina sombras e iluminación desigual."""
    nucleo = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radio, radio))
    fondo = cv2.morphologyEx(gris, cv2.MORPH_CLOSE, nucleo)
    fondo = cv2.GaussianBlur(fondo, (0, 0), radio / 3.0)
    normalizada = cv2.divide(gris, fondo, scale=255)
    return normalizada


def binarizar(gris: np.ndarray, cfg: Config) -> np.ndarray:
    """Binariza dejando la tinta en 255 sobre fondo 0."""
    suavizada = cv2.medianBlur(gris, 3)
    binaria = cv2.adaptiveThreshold(
        suavizada,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        cfg.bloque_umbral,
        cfg.constante_umbral,
    )
    # Quita motas sueltas sin comerse los trazos finos del bolígrafo.
    return cv2.morphologyEx(binaria, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))


def estimar_inclinacion(imagen: np.ndarray, angulo_maximo: float = 15.0) -> float:
    """Ángulo de inclinación en grados a partir de las líneas de la tabla."""
    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)
    bordes = cv2.Canny(gris, 60, 180, apertureSize=3)
    longitud_minima = max(60, imagen.shape[1] // 6)
    lineas = cv2.HoughLinesP(
        bordes,
        1,
        np.pi / 720,
        threshold=120,
        minLineLength=longitud_minima,
        maxLineGap=20,
    )
    if lineas is None or len(lineas) == 0:
        return 0.0
    angulos = []
    for x1, y1, x2, y2 in np.asarray(lineas).reshape(-1, 4):
        angulo = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(angulo) <= angulo_maximo:          # líneas casi horizontales
            angulos.append(angulo)
    if not angulos:
        return 0.0
    return float(np.median(angulos))


def rotar(imagen: np.ndarray, angulo: float) -> np.ndarray:
    alto, ancho = imagen.shape[:2]
    centro = (ancho / 2.0, alto / 2.0)
    matriz = cv2.getRotationMatrix2D(centro, angulo, 1.0)
    return cv2.warpAffine(
        imagen,
        matriz,
        (ancho, alto),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


def recortar_documento(imagen: np.ndarray, area_minima: float = 0.35) -> Optional[np.ndarray]:
    """Detecta la hoja y corrige la perspectiva. None si no se encuentra."""
    alto, ancho = imagen.shape[:2]
    escala = 900.0 / max(alto, ancho)
    pequena = cv2.resize(imagen, None, fx=escala, fy=escala) if escala < 1 else imagen.copy()
    factor = pequena.shape[1] / float(ancho)

    gris = cv2.cvtColor(pequena, cv2.COLOR_BGR2GRAY)
    gris = cv2.GaussianBlur(gris, (5, 5), 0)
    bordes = cv2.Canny(gris, 50, 150)
    bordes = cv2.dilate(bordes, np.ones((3, 3), np.uint8), iterations=1)

    contornos, _ = cv2.findContours(bordes, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contornos:
        return None
    area_pagina = pequena.shape[0] * pequena.shape[1]
    for contorno in sorted(contornos, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(contorno)
        if area < area_minima * area_pagina:
            break
        aproximado = cv2.approxPolyDP(contorno, 0.02 * cv2.arcLength(contorno, True), True)
        if len(aproximado) != 4 or not cv2.isContourConvex(aproximado):
            continue
        if area > 0.995 * area_pagina:      # es el borde de la propia imagen
            continue
        esquinas = aproximado.reshape(4, 2).astype(np.float32) / factor
        return _corregir_perspectiva(imagen, esquinas)
    return None


def _ordenar_esquinas(puntos: np.ndarray) -> np.ndarray:
    suma = puntos.sum(axis=1)
    diferencia = np.diff(puntos, axis=1).ravel()
    return np.array(
        [
            puntos[np.argmin(suma)],      # superior izquierda
            puntos[np.argmin(diferencia)],  # superior derecha
            puntos[np.argmax(suma)],      # inferior derecha
            puntos[np.argmax(diferencia)],  # inferior izquierda
        ],
        dtype=np.float32,
    )


def _corregir_perspectiva(imagen: np.ndarray, esquinas: np.ndarray) -> np.ndarray:
    ordenadas = _ordenar_esquinas(esquinas)
    (si, sd, id_, ii) = ordenadas
    ancho = int(max(np.linalg.norm(sd - si), np.linalg.norm(id_ - ii)))
    alto = int(max(np.linalg.norm(ii - si), np.linalg.norm(id_ - sd)))
    if ancho < 200 or alto < 200:
        return imagen
    destino = np.array(
        [[0, 0], [ancho - 1, 0], [ancho - 1, alto - 1], [0, alto - 1]],
        dtype=np.float32,
    )
    matriz = cv2.getPerspectiveTransform(ordenadas, destino)
    return cv2.warpPerspective(imagen, matriz, (ancho, alto))


def recortar(imagen: np.ndarray, bbox, margen: int = 0) -> np.ndarray:
    """Recorta un bbox (x, y, w, h) aplicando un margen hacia dentro."""
    x, y, ancho, alto = bbox
    x0 = max(0, x + margen)
    y0 = max(0, y + margen)
    x1 = min(imagen.shape[1], x + ancho - margen)
    y1 = min(imagen.shape[0], y + alto - margen)
    if x1 <= x0 or y1 <= y0:
        return imagen[y:y + max(alto, 1), x:x + max(ancho, 1)]
    return imagen[y0:y1, x0:x1]
