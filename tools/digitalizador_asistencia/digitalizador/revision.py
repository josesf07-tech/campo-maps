"""Segunda lectura de las filas dudosas.

Con letra descuidada, la primera pasada deja siempre un puñado de filas
flojas. En vez de dar por buena esa lectura, se vuelve a preguntar solo por
esas filas, dándole al modelo tres cosas que no tenía antes: qué se leyó, por
qué se marcó como dudosa, y los nombres del padrón que más se le parecen.

El coste es una petición extra por página (solo si hay dudas) y el resultado
únicamente se acepta cuando mejora: nunca se sustituye una lectura fiable por
una peor.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence

import numpy as np

from .config import Config
from .modelos import AUSENTE, DUDOSO, PRESENTE, Campo, Hoja, Registro
from .normalizacion import (
    EntradaPadron,
    normalizar_documento,
    normalizar_espacios,
    similitud,
)
from .ocr import MotorOCR


def candidatos_padron(
    nombre: str, padron: Sequence[EntradaPadron], cantidad: int
) -> List[str]:
    """Los nombres del padrón más parecidos a la lectura dudosa."""
    if not padron or not nombre.strip():
        return [entrada.nombre for entrada in padron[:cantidad]]
    puntuados = sorted(
        ((similitud(nombre, entrada.nombre), entrada.nombre) for entrada in padron),
        key=lambda par: par[0],
        reverse=True,
    )
    return [nombre_padron for puntaje, nombre_padron in puntuados[:cantidad] if puntaje > 0.30]


def recopilar_dudas(
    hoja: Hoja, cfg: Config, padron: Sequence[EntradaPadron]
) -> List[Dict[str, Any]]:
    """Describe las filas que merecen una segunda lectura."""
    dudas: List[Dict[str, Any]] = []
    for registro in hoja.registros:
        if not registro.revisar:
            continue
        if _solo_duplicado(registro):
            continue          # un duplicado real no se arregla releyendo
        dudas.append(
            {
                "fila": registro.fila,
                "numero": registro.numero,
                "lectura": registro.nombre.texto,
                "documento": registro.documento.texto if registro.documento else "",
                "motivo": "; ".join(registro.motivos) or "lectura poco fiable",
                "candidatos": candidatos_padron(
                    registro.nombre.texto, padron, cfg.candidatos_padron
                ),
                "marcas_dudosas": [
                    etiqueta
                    for etiqueta, estado in registro.asistencia.items()
                    if estado == DUDOSO
                ],
            }
        )
        if len(dudas) >= cfg.max_filas_segunda_opinion:
            break
    return dudas


def _solo_duplicado(registro: Registro) -> bool:
    return bool(registro.motivos) and all("duplicado" in m for m in registro.motivos)


def aplicar_segunda_opinion(
    hoja: Hoja,
    imagen: np.ndarray,
    cfg: Config,
    motor: MotorOCR,
    padron: Sequence[EntradaPadron],
) -> Dict[str, Any]:
    """Relee las filas dudosas y actualiza las que mejoran. Devuelve un resumen."""
    resumen: Dict[str, Any] = {"consultadas": 0, "actualizadas": 0, "ilegibles": 0}
    if not (cfg.segunda_opinion and motor.soporta_relectura):
        return resumen

    dudas = recopilar_dudas(hoja, cfg, padron)
    if not dudas:
        return resumen
    resumen["consultadas"] = len(dudas)

    try:
        lecturas = motor.releer(imagen, dudas, cfg)
    except Exception as exc:  # noqa: BLE001 - la primera lectura sigue siendo válida
        resumen["error"] = str(exc)
        return resumen

    por_fila = {registro.fila: registro for registro in hoja.registros}
    for fila, lectura in lecturas.items():
        registro = por_fila.get(fila)
        if registro is None:
            continue
        if _actualizar(registro, lectura, cfg):
            resumen["actualizadas"] += 1
        if lectura.get("ilegible"):
            resumen["ilegibles"] += 1
            registro.marcar_revision("sigue ilegible tras la segunda lectura")
    return resumen


def _actualizar(registro: Registro, lectura: Dict[str, Any], cfg: Config) -> bool:
    """Aplica la relectura de una fila si aporta algo. True si cambió algo."""
    cambio = False
    nombre = normalizar_espacios(str(lectura.get("nombre", "") or ""))
    confianza = _confianza(lectura.get("confianza"), registro.nombre.confianza)
    del_padron = bool(lectura.get("candidato_padron"))

    if nombre and nombre != registro.nombre.texto:
        # Solo se pisa la lectura anterior si la nueva es al menos tan segura,
        # o si el modelo la ha anclado a un nombre del padrón.
        if del_padron or confianza >= registro.nombre.confianza:
            registro.nombre = Campo(
                texto=nombre,
                confianza=confianza,
                texto_crudo=registro.nombre.texto_crudo or registro.nombre.texto,
                motor=f"{registro.nombre.motor}+relectura",
            )
            cambio = True
    elif nombre and confianza > registro.nombre.confianza:
        registro.nombre.confianza = confianza
        cambio = True

    documento = normalizar_documento(str(lectura.get("documento", "") or ""))
    if documento:
        actual = registro.documento.texto if registro.documento else ""
        if documento != actual and (not actual or confianza >= registro.nombre.confianza):
            registro.documento = Campo(
                texto=documento,
                confianza=confianza,
                texto_crudo=actual or documento,
                motor="relectura",
            )
            cambio = True

    marcas = lectura.get("asistencia")
    if isinstance(marcas, dict):
        for etiqueta, estado in marcas.items():
            etiqueta = str(etiqueta)
            if etiqueta not in registro.asistencia:
                continue
            if registro.asistencia[etiqueta] != DUDOSO:
                continue          # solo se resuelven las que estaban dudosas
            nuevo = _estado(estado)
            if nuevo != DUDOSO:
                registro.asistencia[etiqueta] = nuevo
                cambio = True

    if cambio:
        registro.relectura = True
    return cambio


def _estado(valor: Any) -> str:
    texto = str(valor or "").strip().lower()
    if texto in {"presente", "si", "sí", "x", "true", "1", "p"}:
        return PRESENTE
    if texto in {"ausente", "no", "false", "0", "vacio", "vacío", "a"}:
        return AUSENTE
    return DUDOSO


def _confianza(valor: Any, por_defecto: float) -> float:
    try:
        numero = float(valor)
    except (TypeError, ValueError):
        return por_defecto
    if numero > 1.0:
        numero /= 100.0
    return float(min(max(numero, 0.0), 1.0))
