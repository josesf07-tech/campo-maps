"""Detección de la rejilla del listado y asignación de roles a las columnas.

Estrategia:
  1. Se aíslan las líneas rectas con morfología (kernels largos horizontales
     y verticales) y se agrupan sus proyecciones para obtener las coordenadas
     de la rejilla.
  2. Si la hoja no tiene rejilla impresa (o está muy borrada), se cae al
     modo "solo filas": segmentación por proyección horizontal de la tinta.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import List, Optional, Sequence

import cv2
import numpy as np

from .config import (
    PALABRAS_ROL,
    ROL_ASISTENCIA,
    ROL_DOCUMENTO,
    ROL_FIRMA,
    ROL_IGNORAR,
    ROL_NOMBRE,
    ROL_NUMERO,
    Config,
)
from .modelos import BBox


@dataclass
class Rejilla:
    """Coordenadas de la tabla detectada."""

    xs: List[int] = field(default_factory=list)   # bordes verticales
    ys: List[int] = field(default_factory=list)   # bordes horizontales
    con_rejilla: bool = True
    filas_libres: List[BBox] = field(default_factory=list)  # modo sin rejilla

    @property
    def n_filas(self) -> int:
        return len(self.filas_libres) if not self.con_rejilla else max(len(self.ys) - 1, 0)

    @property
    def n_columnas(self) -> int:
        return 1 if not self.con_rejilla else max(len(self.xs) - 1, 0)

    def celda(self, fila: int, columna: int) -> BBox:
        if not self.con_rejilla:
            if columna != 0:
                raise IndexError("sin rejilla solo existe la columna 0")
            return self.filas_libres[fila]
        x0, x1 = self.xs[columna], self.xs[columna + 1]
        y0, y1 = self.ys[fila], self.ys[fila + 1]
        return (x0, y0, x1 - x0, y1 - y0)

    def fila_bbox(self, fila: int) -> BBox:
        if not self.con_rejilla:
            return self.filas_libres[fila]
        y0, y1 = self.ys[fila], self.ys[fila + 1]
        return (self.xs[0], y0, self.xs[-1] - self.xs[0], y1 - y0)

    def ancho_columna(self, columna: int) -> int:
        if not self.con_rejilla:
            return self.filas_libres[0][2] if self.filas_libres else 0
        return self.xs[columna + 1] - self.xs[columna]


# --------------------------------------------------------------------------
# Líneas
# --------------------------------------------------------------------------
def mascaras_lineas(binaria: np.ndarray, cfg: Config):
    """Devuelve (mascara_horizontal, mascara_vertical)."""
    alto, ancho = binaria.shape[:2]
    largo_h = max(15, ancho // cfg.divisor_kernel_lineas)
    largo_v = max(15, alto // cfg.divisor_kernel_lineas)

    nucleo_h = cv2.getStructuringElement(cv2.MORPH_RECT, (largo_h, 1))
    horizontal = cv2.morphologyEx(binaria, cv2.MORPH_OPEN, nucleo_h, iterations=1)
    horizontal = cv2.dilate(horizontal, cv2.getStructuringElement(cv2.MORPH_RECT, (largo_h // 2 or 1, 1)))

    nucleo_v = cv2.getStructuringElement(cv2.MORPH_RECT, (1, largo_v))
    vertical = cv2.morphologyEx(binaria, cv2.MORPH_OPEN, nucleo_v, iterations=1)
    vertical = cv2.dilate(vertical, cv2.getStructuringElement(cv2.MORPH_RECT, (1, largo_v // 2 or 1)))
    return horizontal, vertical


def posiciones_lineas(
    mascara: np.ndarray,
    eje: int,
    cobertura: float,
    separacion_minima: int,
) -> List[int]:
    """Centros de las líneas detectadas a lo largo de un eje.

    `eje=0` devuelve coordenadas Y (líneas horizontales);
    `eje=1` devuelve coordenadas X (líneas verticales).
    """
    proyeccion = (mascara > 0).sum(axis=1 if eje == 0 else 0).astype(np.float32)
    if proyeccion.max() <= 0:
        return []
    longitud = mascara.shape[1] if eje == 0 else mascara.shape[0]

    for factor in (1.0, 0.6, 0.35):
        umbral = max(cobertura * factor * longitud, 0.30 * proyeccion.max())
        indices = np.where(proyeccion >= umbral)[0]
        centros = _agrupar(indices, separacion_minima)
        if len(centros) >= 2:
            return centros
    return []


def _agrupar(indices: Sequence[int], separacion_minima: int) -> List[int]:
    """Agrupa índices contiguos y devuelve el centro de cada grupo."""
    if len(indices) == 0:
        return []
    grupos: List[List[int]] = [[int(indices[0])]]
    for indice in indices[1:]:
        if indice - grupos[-1][-1] <= separacion_minima:
            grupos[-1].append(int(indice))
        else:
            grupos.append([int(indice)])
    return [int(round(float(np.mean(g)))) for g in grupos]


# --------------------------------------------------------------------------
# Rejilla
# --------------------------------------------------------------------------
def detectar_rejilla(binaria: np.ndarray, cfg: Config) -> Rejilla:
    horizontal, vertical = mascaras_lineas(binaria, cfg)
    ys = posiciones_lineas(horizontal, 0, cfg.cobertura_linea_h, cfg.separacion_minima)
    xs = posiciones_lineas(vertical, 1, cfg.cobertura_linea_v, cfg.separacion_minima)

    ys = _filtrar_separacion(ys, cfg.alto_minimo_fila)
    xs = _filtrar_separacion(xs, cfg.ancho_minimo_columna)

    if len(ys) >= 3 and len(xs) >= 2:
        return Rejilla(xs=xs, ys=ys, con_rejilla=True)

    filas = filas_por_proyeccion(binaria, cfg)
    return Rejilla(con_rejilla=False, filas_libres=filas)


def _filtrar_separacion(posiciones: List[int], minimo: int) -> List[int]:
    """Elimina líneas dobles: si dos bordes están más juntos que `minimo`, fusiona."""
    if not posiciones:
        return []
    limpias = [posiciones[0]]
    for posicion in posiciones[1:]:
        if posicion - limpias[-1] < minimo:
            limpias[-1] = (limpias[-1] + posicion) // 2
        else:
            limpias.append(posicion)
    return limpias


def filas_por_proyeccion(binaria: np.ndarray, cfg: Config) -> List[BBox]:
    """Fallback sin rejilla: bandas horizontales con tinta."""
    alto, ancho = binaria.shape[:2]
    perfil = (binaria > 0).sum(axis=1).astype(np.float32)
    if perfil.max() <= 0:
        return []
    nucleo = np.ones(max(3, cfg.alto_minimo_fila // 3), dtype=np.float32)
    perfil = np.convolve(perfil, nucleo / nucleo.sum(), mode="same")
    umbral = max(0.012 * ancho, 0.10 * perfil.max())

    filas: List[BBox] = []
    inicio: Optional[int] = None
    for y in range(alto):
        activo = perfil[y] >= umbral
        if activo and inicio is None:
            inicio = y
        elif not activo and inicio is not None:
            if y - inicio >= cfg.alto_minimo_fila:
                filas.append((0, inicio, ancho, y - inicio))
            inicio = None
    if inicio is not None and alto - inicio >= cfg.alto_minimo_fila:
        filas.append((0, inicio, ancho, alto - inicio))
    return filas


# --------------------------------------------------------------------------
# Roles de columna
# --------------------------------------------------------------------------
def _clave(texto: str) -> str:
    sin_tildes = unicodedata.normalize("NFKD", texto)
    sin_tildes = "".join(c for c in sin_tildes if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9#]+", " ", sin_tildes.lower()).strip()


def rol_por_encabezado(texto: str) -> Optional[str]:
    """Deduce el rol de una columna a partir del texto de su encabezado."""
    clave = _clave(texto)
    if not clave:
        return None
    palabras = set(clave.split())
    compacto = clave.replace(" ", "")
    mejor: Optional[str] = None
    mejor_puntaje = 0.0
    for rol, terminos in PALABRAS_ROL.items():
        for termino in terminos:
            # Los términos largos pesan más: "dni" en "D.N.I." debe ganar a la
            # "n" suelta que también aparece en las palabras clave de "numero".
            if termino in palabras:
                puntaje = 1.0 + len(termino)
            elif len(termino) >= 3 and termino in compacto:
                puntaje = 0.6 + len(termino)
            else:
                continue
            if puntaje > mejor_puntaje:
                mejor, mejor_puntaje = rol, puntaje
    return mejor


def inferir_roles(
    rejilla: Rejilla,
    encabezados: Sequence[str],
    cfg: Config,
) -> List[str]:
    """Rol de cada columna: por configuración, por encabezado o por geometría."""
    n = rejilla.n_columnas
    if cfg.columnas:
        roles = list(cfg.columnas)[:n]
        roles += [ROL_IGNORAR] * (n - len(roles))
        return roles

    roles: List[Optional[str]] = [None] * n
    for indice in range(n):
        texto = encabezados[indice] if indice < len(encabezados) else ""
        roles[indice] = rol_por_encabezado(texto)

    if not any(roles):
        return _roles_por_geometria(rejilla)

    # El nombre es obligatorio: si ningún encabezado lo delata, se usa la
    # columna más ancha que siga sin rol.
    if ROL_NOMBRE not in roles:
        candidatas = [i for i in range(n) if roles[i] is None]
        if candidatas:
            roles[max(candidatas, key=rejilla.ancho_columna)] = ROL_NOMBRE
    return [rol or ROL_IGNORAR for rol in roles]


def _roles_por_geometria(rejilla: Rejilla) -> List[str]:
    """Sin encabezados legibles: heurística por anchos relativos."""
    n = rejilla.n_columnas
    if n == 0:
        return []
    if n == 1:
        return [ROL_NOMBRE]

    anchos = [rejilla.ancho_columna(i) for i in range(n)]
    total = float(sum(anchos)) or 1.0
    roles: List[str] = [ROL_IGNORAR] * n

    indice_nombre = int(np.argmax(anchos))
    roles[indice_nombre] = ROL_NOMBRE

    if indice_nombre > 0 and anchos[0] / total < 0.10:
        roles[0] = ROL_NUMERO

    restantes = [i for i in range(n) if roles[i] == ROL_IGNORAR]
    if restantes:
        ultima = restantes[-1]
        if ultima > indice_nombre:
            roles[ultima] = ROL_FIRMA
            restantes = restantes[:-1]
    posteriores = [i for i in restantes if i > indice_nombre]
    for indice in posteriores:
        roles[indice] = ROL_ASISTENCIA
    anteriores = [i for i in restantes if i < indice_nombre]
    if anteriores:
        roles[anteriores[-1]] = ROL_DOCUMENTO
    return roles


def detectar_fila_encabezado(
    rejilla: Rejilla,
    encabezados: Sequence[str],
    cfg: Config,
) -> bool:
    """¿La primera fila es un encabezado impreso?

    En modo `auto` se considera encabezado cuando al menos dos celdas de la
    primera fila se reconocen como títulos de columna conocidos.
    """
    if cfg.fila_encabezado == "no" or rejilla.n_filas < 2:
        return False
    if cfg.fila_encabezado == "si":
        return True
    return sum(1 for texto in encabezados if rol_por_encabezado(texto)) >= 2


def nombre_columna(indice: int, rol: str, encabezado: str) -> str:
    """Etiqueta legible para la columna en la salida."""
    texto = (encabezado or "").strip()
    if texto:
        return re.sub(r"\s+", " ", texto)
    return f"{rol}_{indice + 1}"
