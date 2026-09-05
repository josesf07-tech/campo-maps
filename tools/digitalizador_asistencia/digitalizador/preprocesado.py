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
    escala: float
    angulo: float
    recortada: bool


# --------------------------------------------------------------------------
# Carga
# --------------------------------------------------------------------------
def cargar_paginas(ruta: Path | str, dpi: int = 300) -> List[np.ndarray]:
    """Devuelve las páginas de un PDF o la única página de una imagen."""
    ruta = Path(ruta)
    if not ruta.exists():
        raise FileNotFoundError(f"No existe el archivo: {ruta}")
    if ruta.suffix.lower() == ".pdf":
        return _paginas_pdf(ruta, dpi)
    if ruta.suffix.lower() not in EXTENSIONES_IMAGEN:
        raise ValueError(f"Formato no soportado: {ruta.suffix}")
    datos = np.fromfile(str(ruta), dtype=np.uint8)
    imagen = cv2.imdecode(datos, cv2.IMREAD_COLOR)
    if imagen is None:
        raise ValueError(f"No se pudo leer la imagen: {ruta}")
    return [imagen]


def _paginas_pdf(ruta: Path, dpi: int) -> List[np.ndarray]:
    try:
        import pypdfium2  # type: ignore
    except ImportError:
        pass
    else:
        documento = pypdfium2.PdfDocument(str(ruta))
        paginas = []
        for indice in range(len(documento)):
            mapa = documento[indice].render(scale=dpi / 72)
            arreglo = np.asarray(mapa.to_pil().convert("RGB"))
            paginas.append(cv2.cvtColor(arreglo, cv2.COLOR_RGB2BGR))
        return paginas

    try:
        import fitz  # type: ignore  (PyMuPDF)
    except ImportError as exc:  # pragma: no cover - depende del entorno
        raise RuntimeError(
            "Para leer PDF instala 'pypdfium2' o 'pymupdf'."
        ) from exc

    documento = fitz.open(str(ruta))
    paginas = []
    for pagina in documento:
        mapa = pagina.get_pixmap(dpi=dpi)
        arreglo = np.frombuffer(mapa.samples, dtype=np.uint8)
        arreglo = arreglo.reshape(mapa.height, mapa.width, mapa.n)
        if mapa.n == 4:
            paginas.append(cv2.cvtColor(arreglo, cv2.COLOR_RGBA2BGR))
        else:
            paginas.append(cv2.cvtColor(arreglo, cv2.COLOR_RGB2BGR))
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
    """Recorta el documento, endereza, normaliza el fondo y binariza."""
    trabajo = imagen
    recortada = False
    if cfg.recortar_documento:
        recorte = recortar_documento(trabajo)
        if recorte is not None:
            trabajo = recorte
            recortada = True

    trabajo, escala = escalar(trabajo, cfg)

    angulo = 0.0
    if cfg.enderezar:
        angulo = estimar_inclinacion(trabajo, cfg.angulo_maximo)
        if abs(angulo) > 0.1:
            trabajo = rotar(trabajo, angulo)

    gris = cv2.cvtColor(trabajo, cv2.COLOR_BGR2GRAY)
    gris = quitar_sombra(gris)
    binaria = binarizar(gris, cfg)
    return Pagina(
        color=trabajo,
        gris=gris,
        binaria=binaria,
        escala=escala,
        angulo=angulo,
        recortada=recortada,
    )


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
