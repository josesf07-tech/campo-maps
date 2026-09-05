"""Generador de hojas de asistencia sintéticas.

Sirve para probar el pipeline (segmentación, detección de marcas, exportación)
sin depender de una API ni de fotos reales, y para las pruebas automáticas.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

NOMBRES = [
    "María Fernández Ruiz",
    "José Antonio Pérez",
    "Lucía Gómez Salinas",
    "Carlos Iván Ramírez",
    "Ana Belén Ortega",
    "Miguel Ángel Soto",
    "Paula Núñez Cabrera",
    "Andrés Felipe Vargas",
    "Rocío Delgado Marín",
    "Javier Molina Castro",
]

ENCABEZADOS = ["N", "Nombre y apellidos", "DNI", "Firma"]


def crear_hoja(
    nombres: Optional[Sequence[str]] = None,
    presentes: Optional[Sequence[bool]] = None,
    documentos: Optional[Sequence[str]] = None,
    inclinacion: float = 0.0,
    ruido: float = 0.0,
    semilla: int = 7,
) -> Tuple[np.ndarray, List[Dict[str, Any]]]:
    """Devuelve (imagen BGR, verdad de referencia)."""
    generador = np.random.default_rng(semilla)
    nombres = list(nombres or NOMBRES)
    if presentes is None:
        presentes = [i % 3 != 2 for i in range(len(nombres))]
    presentes = list(presentes)
    documentos = list(documentos or [f"{10000000 + i * 1111111}X" for i in range(len(nombres))])

    margen = 60
    alto_fila = 74
    anchos = [90, 700, 260, 250]
    ancho_tabla = sum(anchos)
    ancho = ancho_tabla + 2 * margen
    alto = margen * 2 + alto_fila * (len(nombres) + 1) + 90

    imagen = np.full((alto, ancho, 3), 248, dtype=np.uint8)
    cv2.putText(
        imagen, "LISTA DE ASISTENCIA", (margen, margen - 16),
        cv2.FONT_HERSHEY_DUPLEX, 0.9, (40, 40, 40), 2, cv2.LINE_AA,
    )

    y0 = margen + 10
    xs = [margen]
    for ancho_columna in anchos:
        xs.append(xs[-1] + ancho_columna)
    ys = [y0 + i * alto_fila for i in range(len(nombres) + 2)]

    # Rejilla
    for y in ys:
        cv2.line(imagen, (xs[0], y), (xs[-1], y), (70, 70, 70), 2, cv2.LINE_AA)
    for x in xs:
        cv2.line(imagen, (x, ys[0]), (x, ys[-1]), (70, 70, 70), 2, cv2.LINE_AA)

    # Encabezado impreso
    for indice, titulo in enumerate(ENCABEZADOS):
        cv2.putText(
            imagen, titulo, (xs[indice] + 12, ys[0] + 48),
            cv2.FONT_HERSHEY_SIMPLEX, 0.72, (30, 30, 30), 2, cv2.LINE_AA,
        )

    verdad: List[Dict[str, Any]] = []
    for indice, nombre in enumerate(nombres):
        fila = indice + 1
        base = ys[fila] + 50
        tinta = (90, 40, 30)
        cv2.putText(imagen, str(indice + 1), (xs[0] + 30, base),
                    cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 1.0, tinta, 2, cv2.LINE_AA)
        cv2.putText(imagen, nombre, (xs[1] + 16, base),
                    cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 1.0, tinta, 2, cv2.LINE_AA)
        cv2.putText(imagen, documentos[indice], (xs[2] + 16, base),
                    cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 0.9, tinta, 2, cv2.LINE_AA)
        if presentes[indice]:
            _dibujar_firma(imagen, xs[3], ys[fila], anchos[3], alto_fila, generador, tinta)
        verdad.append(
            {
                "numero": indice + 1,
                "nombre": nombre,
                "documento": documentos[indice],
                "presente": bool(presentes[indice]),
            }
        )

    if ruido > 0:
        gaussiano = generador.normal(0, 255 * ruido, imagen.shape)
        imagen = np.clip(imagen.astype(np.float32) + gaussiano, 0, 255).astype(np.uint8)
    if abs(inclinacion) > 0.01:
        centro = (ancho / 2.0, alto / 2.0)
        matriz = cv2.getRotationMatrix2D(centro, inclinacion, 1.0)
        imagen = cv2.warpAffine(
            imagen, matriz, (ancho, alto),
            flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE,
        )
    return imagen, verdad


def _dibujar_firma(imagen, x, y, ancho, alto, generador, color) -> None:
    """Garabato manuscrito que simula una firma dentro de la celda."""
    puntos = []
    n = 26
    for i in range(n):
        avance = i / (n - 1)
        px = x + int(0.12 * ancho + avance * 0.76 * ancho)
        oscilacion = np.sin(avance * 9.0) * 0.22 + generador.normal(0, 0.05)
        py = y + int(alto * (0.55 + oscilacion))
        puntos.append([px, int(np.clip(py, y + 6, y + alto - 6))])
    cv2.polylines(imagen, [np.array(puntos, dtype=np.int32)], False, color, 3, cv2.LINE_AA)
