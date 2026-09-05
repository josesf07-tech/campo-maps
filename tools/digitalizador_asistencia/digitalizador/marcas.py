"""Detección de marcas de asistencia (X, palomita, firma) por celda.

No se intenta "leer" la marca: se mide cuánta tinta manuscrita hay en la
celda una vez descontadas las líneas de la rejilla. El umbral se calibra por
columna (Otsu 1-D sobre los ratios de esa columna), porque la densidad de una
firma a bolígrafo fino y la de una X gruesa son muy distintas entre hojas.
"""

from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

import cv2
import numpy as np

from .config import Config
from .modelos import AUSENTE, DUDOSO, PRESENTE, BBox
from .preprocesado import recortar


def quitar_lineas(binaria: np.ndarray, cfg: Config) -> np.ndarray:
    """Devuelve la tinta manuscrita: la binaria sin las líneas de la rejilla."""
    from .tabla import mascaras_lineas  # import diferido: evita ciclo

    horizontal, vertical = mascaras_lineas(binaria, cfg)
    rejilla = cv2.bitwise_or(horizontal, vertical)
    rejilla = cv2.dilate(rejilla, np.ones((3, 3), np.uint8), iterations=1)
    limpia = cv2.bitwise_and(binaria, cv2.bitwise_not(rejilla))
    return cv2.morphologyEx(limpia, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))


def ratio_tinta(tinta: np.ndarray, bbox: BBox, margen: int) -> float:
    """Fracción de píxeles con tinta dentro de la celda."""
    recorte = recortar(tinta, bbox, margen)
    if recorte.size == 0:
        return 0.0
    return float((recorte > 0).sum()) / float(recorte.size)


def umbral_otsu_1d(valores: Sequence[float]) -> float:
    """Otsu clásico sobre una lista de valores continuos.

    Devuelve el corte que maximiza la varianza entre clases. Sirve para
    separar "celda vacía" de "celda marcada" dentro de una misma columna.
    """
    datos = np.asarray([v for v in valores if np.isfinite(v)], dtype=np.float64)
    if datos.size < 4:
        return float("nan")
    orden = np.sort(datos)
    total = orden.size
    suma_total = orden.sum()
    mejor_corte, mejor_varianza = float("nan"), -1.0
    suma_izquierda = 0.0
    for i in range(1, total):
        suma_izquierda += orden[i - 1]
        peso_izq = i / total
        peso_der = 1.0 - peso_izq
        if peso_izq <= 0 or peso_der <= 0:
            continue
        media_izq = suma_izquierda / i
        media_der = (suma_total - suma_izquierda) / (total - i)
        varianza = peso_izq * peso_der * (media_izq - media_der) ** 2
        if varianza > mejor_varianza:
            mejor_varianza = varianza
            mejor_corte = float((orden[i - 1] + orden[i]) / 2.0)
    return mejor_corte


def clasificar_columna(
    ratios: Sequence[float],
    cfg: Config,
) -> Tuple[List[str], Dict[str, float]]:
    """Clasifica todas las celdas de una columna de marcas.

    Devuelve (estados, umbrales_usados). Los estados son 'presente',
    'ausente' o 'dudoso'; 'dudoso' se reserva para los valores que caen en
    la zona ambigua alrededor del umbral, que son los que conviene revisar
    a mano.
    """
    bajo, alto = cfg.umbral_marca_bajo, cfg.umbral_marca_alto
    corte = float("nan")
    if cfg.calibrar_marcas and len(ratios) >= 4:
        candidato = umbral_otsu_1d(ratios)
        disperso = float(np.max(ratios) - np.min(ratios)) if ratios else 0.0
        # Solo se confía en el corte si la columna realmente tiene dos grupos.
        if np.isfinite(candidato) and disperso >= 2 * cfg.umbral_marca_bajo:
            corte = candidato
            bajo = corte * 0.65
            alto = corte * 1.35

    estados = []
    for ratio in ratios:
        if ratio >= alto:
            estados.append(PRESENTE)
        elif ratio <= bajo:
            estados.append(AUSENTE)
        else:
            estados.append(DUDOSO)
    return estados, {"bajo": bajo, "alto": alto, "corte": corte}
