"""Motores de reconocimiento de escritura manuscrita.

Motores disponibles:

* ``claude-hoja`` (por defecto): envía la página completa al modelo de visión
  de Claude y recibe la tabla ya estructurada. Es el más preciso con letra
  manuscrita porque el modelo ve el contexto de toda la hoja (encabezados,
  columnas, el resto de nombres) en lugar de recortes sueltos.
* ``claude``: transcribe celda a celda, en lotes, sobre la rejilla detectada
  localmente. Útil cuando se quiere control total de la segmentación.
* ``trocr``: TrOCR (``microsoft/trocr-base-handwritten``), local y sin API.
* ``tesseract``: rápido y offline, pensado para hojas con letra de imprenta;
  con manuscrita su acierto es bajo.
* ``nulo``: no reconoce texto. Sirve para probar la segmentación y para
  contar marcas de asistencia sin transcribir nombres.
"""

from __future__ import annotations

import base64
import json
import os
import re
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Sequence

import cv2
import numpy as np

from .config import Config
from .modelos import Campo

ALTO_MINIMO_RECORTE = 64
TIPO_TEXTO = "texto"
TIPO_NOMBRE = "nombre"
TIPO_NUMERO = "numero"
TIPO_DOCUMENTO = "documento"


# --------------------------------------------------------------------------
# Utilidades comunes
# --------------------------------------------------------------------------
def ampliar(recorte: np.ndarray, alto_minimo: int = ALTO_MINIMO_RECORTE) -> np.ndarray:
    """Escala el recorte hasta una altura mínima legible por el OCR."""
    if recorte.size == 0:
        return recorte
    alto = recorte.shape[0]
    if alto >= alto_minimo:
        return recorte
    factor = alto_minimo / float(alto)
    return cv2.resize(recorte, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)


def a_png_base64(imagen: np.ndarray) -> str:
    correcto, buffer = cv2.imencode(".png", imagen)
    if not correcto:  # pragma: no cover - imencode solo falla con datos inválidos
        raise ValueError("No se pudo codificar el recorte a PNG")
    return base64.standard_b64encode(buffer.tobytes()).decode("ascii")


def extraer_json(texto: str) -> Any:
    """Extrae el primer objeto o array JSON de una respuesta de texto."""
    limpio = re.sub(r"^\s*```(?:json)?|```\s*$", "", texto.strip(), flags=re.MULTILINE)
    try:
        return json.loads(limpio)
    except json.JSONDecodeError:
        pass
    for apertura, cierre in (("[", "]"), ("{", "}")):
        inicio = limpio.find(apertura)
        final = limpio.rfind(cierre)
        if inicio != -1 and final > inicio:
            try:
                return json.loads(limpio[inicio:final + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError("La respuesta del modelo no contenía JSON válido")


# --------------------------------------------------------------------------
# Interfaz
# --------------------------------------------------------------------------
class MotorOCR(ABC):
    nombre = "base"
    #: si es True, el pipeline no segmenta celdas y usa `transcribir_hoja`
    hoja_completa = False

    @abstractmethod
    def reconocer(self, recortes: Sequence[np.ndarray], tipo: str = TIPO_TEXTO) -> List[Campo]:
        """Transcribe una lista de recortes del mismo tipo de campo."""

    def transcribir_hoja(  # pragma: no cover - solo motores de hoja completa
        self, imagen: np.ndarray, cfg: Config
    ) -> Dict[str, Any]:
        raise NotImplementedError


class MotorNulo(MotorOCR):
    """No transcribe nada; deja los campos vacíos."""

    nombre = "nulo"

    def reconocer(self, recortes: Sequence[np.ndarray], tipo: str = TIPO_TEXTO) -> List[Campo]:
        return [Campo(texto="", confianza=0.0, motor=self.nombre) for _ in recortes]


# --------------------------------------------------------------------------
# Tesseract
# --------------------------------------------------------------------------
class MotorTesseract(MotorOCR):
    nombre = "tesseract"

    def __init__(self, cfg: Config):
        try:
            import pytesseract  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "Falta 'pytesseract' (y el binario tesseract-ocr). "
                "Instala: pip install pytesseract && apt-get install tesseract-ocr tesseract-ocr-spa"
            ) from exc
        self._pytesseract = pytesseract
        self.cfg = cfg

    def _opciones(self, tipo: str) -> str:
        base = "--oem 1 --psm 7"
        if tipo == TIPO_NUMERO:
            return base + " -c tessedit_char_whitelist=0123456789"
        if tipo == TIPO_DOCUMENTO:
            return base + " -c tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-"
        return base

    def reconocer(self, recortes: Sequence[np.ndarray], tipo: str = TIPO_TEXTO) -> List[Campo]:
        resultados: List[Campo] = []
        for recorte in recortes:
            imagen = ampliar(recorte)
            if imagen.size == 0:
                resultados.append(Campo(motor=self.nombre))
                continue
            datos = self._pytesseract.image_to_data(
                imagen,
                lang=self.cfg.idioma_tesseract,
                config=self._opciones(tipo),
                output_type=self._pytesseract.Output.DICT,
            )
            palabras, confianzas = [], []
            for texto, confianza in zip(datos["text"], datos["conf"]):
                if texto.strip():
                    palabras.append(texto.strip())
                    try:
                        valor = float(confianza)
                    except (TypeError, ValueError):
                        valor = -1.0
                    if valor >= 0:
                        confianzas.append(valor / 100.0)
            texto = " ".join(palabras)
            confianza = float(np.mean(confianzas)) if confianzas else 0.0
            resultados.append(
                Campo(texto=texto, confianza=confianza, texto_crudo=texto, motor=self.nombre)
            )
        return resultados


# --------------------------------------------------------------------------
# TrOCR (local)
# --------------------------------------------------------------------------
class MotorTrOCR(MotorOCR):
    nombre = "trocr"

    def __init__(self, cfg: Config, tamano_lote: int = 8):
        try:
            import torch  # type: ignore
            from transformers import TrOCRProcessor, VisionEncoderDecoderModel  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "Falta 'transformers' y 'torch'. Instala: pip install transformers torch pillow"
            ) from exc
        self._torch = torch
        self.tamano_lote = tamano_lote
        self.procesador = TrOCRProcessor.from_pretrained(cfg.modelo_trocr)
        self.modelo = VisionEncoderDecoderModel.from_pretrained(cfg.modelo_trocr)
        self.dispositivo = "cuda" if torch.cuda.is_available() else "cpu"
        self.modelo.to(self.dispositivo)
        self.modelo.eval()

    def reconocer(self, recortes: Sequence[np.ndarray], tipo: str = TIPO_TEXTO) -> List[Campo]:
        from PIL import Image  # type: ignore

        resultados: List[Campo] = []
        for inicio in range(0, len(recortes), self.tamano_lote):
            lote = [ampliar(r) for r in recortes[inicio:inicio + self.tamano_lote]]
            imagenes = [
                Image.fromarray(cv2.cvtColor(r, cv2.COLOR_GRAY2RGB) if r.ndim == 2
                                else cv2.cvtColor(r, cv2.COLOR_BGR2RGB))
                for r in lote
            ]
            entradas = self.procesador(images=imagenes, return_tensors="pt").to(self.dispositivo)
            with self._torch.no_grad():
                salida = self.modelo.generate(
                    **entradas,
                    max_new_tokens=48,
                    output_scores=True,
                    return_dict_in_generate=True,
                )
            textos = self.procesador.batch_decode(salida.sequences, skip_special_tokens=True)
            confianzas = self._confianzas(salida)
            for texto, confianza in zip(textos, confianzas):
                resultados.append(
                    Campo(
                        texto=texto.strip(),
                        confianza=confianza,
                        texto_crudo=texto.strip(),
                        motor=self.nombre,
                    )
                )
        return resultados

    def _confianzas(self, salida) -> List[float]:
        """Probabilidad media por token de cada secuencia generada."""
        try:
            transiciones = self.modelo.compute_transition_scores(
                salida.sequences, salida.scores, normalize_logits=True
            )
            probabilidades = self._torch.exp(transiciones)
            validos = self._torch.isfinite(probabilidades)
            medias = (probabilidades * validos).sum(dim=1) / validos.sum(dim=1).clamp(min=1)
            return [float(v) for v in medias.cpu().numpy()]
        except Exception:  # pragma: no cover - depende de la versión de transformers
            return [0.5] * len(salida.sequences)


# --------------------------------------------------------------------------
# Claude (API de visión)
# --------------------------------------------------------------------------
SISTEMA_CELDAS = (
    "Eres un transcriptor experto de listados de asistencia manuscritos en español. "
    "Recibes recortes de celdas de una misma columna y devuelves su transcripción literal. "
    "No inventes ni completes datos: si una celda está vacía o es ilegible, devuelve texto vacío. "
    "Respeta tildes, la letra Ñ y los nombres compuestos. Responde únicamente con JSON."
)

SISTEMA_HOJA = (
    "Eres un transcriptor experto de listados de asistencia manuscritos en español. "
    "Recibes la foto de una hoja de asistencia y devuelves su contenido como tabla estructurada. "
    "Reglas: transcribe literalmente lo escrito, sin inventar ni completar datos; "
    "una fila de salida por cada fila escrita de la hoja, en el mismo orden; "
    "las filas totalmente vacías se omiten; respeta tildes, Ñ y nombres compuestos; "
    "para las columnas de firma o asistencia indica 'presente' si hay una marca, aspa, "
    "palomita o firma, 'ausente' si la celda está claramente vacía y 'dudoso' si no puedes "
    "decidirlo. Responde únicamente con JSON."
)


class _ClienteClaude:
    """Envoltorio mínimo del SDK de Anthropic."""

    def __init__(self, cfg: Config):
        try:
            import anthropic  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "Falta el SDK de Anthropic. Instala: pip install anthropic"
            ) from exc
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            # El SDK también acepta un perfil de `ant auth login`; solo avisamos.
            pass
        self._anthropic = anthropic
        self.cliente = anthropic.Anthropic()
        self.cfg = cfg

    def preguntar(self, sistema: str, contenido: List[Dict[str, Any]]) -> str:
        respuesta = self.cliente.messages.create(
            model=self.cfg.modelo_claude,
            max_tokens=self.cfg.max_tokens_claude,
            system=sistema,
            thinking={"type": "adaptive"},
            output_config={"effort": self.cfg.esfuerzo_claude},
            messages=[{"role": "user", "content": contenido}],
        )
        if respuesta.stop_reason == "refusal":  # pragma: no cover - depende del servicio
            detalle = getattr(respuesta, "stop_details", None)
            raise RuntimeError(f"El modelo rechazó la petición: {detalle}")
        return "".join(bloque.text for bloque in respuesta.content if bloque.type == "text")


def _bloque_imagen(imagen: np.ndarray) -> Dict[str, Any]:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": a_png_base64(imagen),
        },
    }


class MotorClaude(MotorOCR):
    """Transcribe celda a celda, en lotes, con la API de Claude."""

    nombre = "claude"

    def __init__(self, cfg: Config, cliente: Optional[_ClienteClaude] = None):
        self.cfg = cfg
        self.cliente = cliente or _ClienteClaude(cfg)

    def reconocer(self, recortes: Sequence[np.ndarray], tipo: str = TIPO_TEXTO) -> List[Campo]:
        resultados: List[Campo] = []
        for inicio in range(0, len(recortes), self.cfg.lote_claude):
            lote = list(recortes[inicio:inicio + self.cfg.lote_claude])
            resultados.extend(self._reconocer_lote(lote, tipo))
        return resultados

    def _reconocer_lote(self, lote: Sequence[np.ndarray], tipo: str) -> List[Campo]:
        contenido: List[Dict[str, Any]] = []
        for indice, recorte in enumerate(lote):
            contenido.append({"type": "text", "text": f"Celda {indice}:"})
            contenido.append(_bloque_imagen(ampliar(recorte)))
        contenido.append({"type": "text", "text": self._instruccion(tipo, len(lote))})

        try:
            crudo = self.cliente.preguntar(SISTEMA_CELDAS, contenido)
            datos = extraer_json(crudo)
        except Exception as exc:  # noqa: BLE001 - se degrada, no se aborta la hoja
            return [Campo(texto="", confianza=0.0, motor=f"{self.nombre}:error", texto_crudo=str(exc))
                    for _ in lote]

        por_indice: Dict[int, Dict[str, Any]] = {}
        for elemento in datos if isinstance(datos, list) else datos.get("celdas", []):
            if isinstance(elemento, dict) and "celda" in elemento:
                try:
                    por_indice[int(elemento["celda"])] = elemento
                except (TypeError, ValueError):
                    continue

        campos: List[Campo] = []
        for indice in range(len(lote)):
            elemento = por_indice.get(indice, {})
            texto = str(elemento.get("texto", "") or "").strip()
            confianza = _confianza(elemento.get("confianza"))
            campos.append(
                Campo(texto=texto, confianza=confianza, texto_crudo=texto, motor=self.nombre)
            )
        return campos

    def _instruccion(self, tipo: str, cantidad: int) -> str:
        detalle = {
            TIPO_NOMBRE: "Cada celda contiene el nombre y apellidos de una persona.",
            TIPO_NUMERO: "Cada celda contiene un número de orden. Devuelve solo dígitos.",
            TIPO_DOCUMENTO: "Cada celda contiene un número de documento de identidad.",
        }.get(tipo, "Cada celda contiene un texto corto escrito a mano.")
        return (
            f"{detalle} Transcribe las {cantidad} celdas anteriores y responde con un array JSON: "
            '[{"celda": 0, "texto": "...", "confianza": 0.0}]. '
            "La confianza es tu seguridad en la lectura, de 0 a 1. "
            "Si la celda está vacía o es ilegible usa texto \"\" y confianza 0."
        )


class MotorClaudeHoja(MotorClaude):
    """Transcribe la hoja completa de una vez: máxima precisión con manuscrita."""

    nombre = "claude-hoja"
    hoja_completa = True

    def transcribir_hoja(self, imagen: np.ndarray, cfg: Config) -> Dict[str, Any]:
        contenido: List[Dict[str, Any]] = [
            _bloque_imagen(imagen),
            {"type": "text", "text": self._instruccion_hoja(cfg)},
        ]
        crudo = self.cliente.preguntar(SISTEMA_HOJA, contenido)
        datos = extraer_json(crudo)
        if isinstance(datos, list):
            datos = {"columnas": [], "filas": datos}
        if not isinstance(datos, dict):
            raise ValueError("Respuesta inesperada del modelo al transcribir la hoja")
        datos.setdefault("columnas", [])
        datos.setdefault("filas", [])
        return datos

    def _instruccion_hoja(self, cfg: Config) -> str:
        pista = ""
        if cfg.columnas:
            pista = (
                "Las columnas de la hoja, en orden, son: "
                + ", ".join(cfg.columnas)
                + ". "
            )
        return (
            "Transcribe esta hoja de asistencia completa. "
            + pista
            + "Responde con este JSON exacto:\n"
            '{"columnas": [{"etiqueta": "texto del encabezado", '
            '"rol": "numero|nombre|documento|cargo|contacto|firma|asistencia|ignorar"}], '
            '"filas": [{"numero": 1, "nombre": "...", "documento": "...", '
            '"extras": {"etiqueta": "valor"}, '
            '"asistencia": {"etiqueta de la columna": "presente|ausente|dudoso"}, '
            '"confianza": 0.0}]}\n'
            "Usa como claves de 'asistencia' y 'extras' exactamente las etiquetas que "
            "declaraste en 'columnas'. Incluye 'confianza' (0 a 1) por fila según lo "
            "legible que sea el nombre. No añadas texto fuera del JSON."
        )


def _confianza(valor: Any) -> float:
    try:
        numero = float(valor)
    except (TypeError, ValueError):
        return 0.5
    if numero > 1.0:  # algunos modelos responden en porcentaje
        numero /= 100.0
    return float(min(max(numero, 0.0), 1.0))


# --------------------------------------------------------------------------
# Fábrica
# --------------------------------------------------------------------------
def crear_motor(cfg: Config) -> MotorOCR:
    nombre = (cfg.motor or "").strip().lower()
    if nombre in {"claude-hoja", "claude_hoja", "hoja"}:
        return MotorClaudeHoja(cfg)
    if nombre == "claude":
        return MotorClaude(cfg)
    if nombre == "trocr":
        return MotorTrOCR(cfg)
    if nombre == "tesseract":
        return MotorTesseract(cfg)
    if nombre in {"nulo", "ninguno", "none"}:
        return MotorNulo()
    raise ValueError(
        f"Motor desconocido: {cfg.motor!r}. "
        "Usa claude-hoja, claude, trocr, tesseract o nulo."
    )
