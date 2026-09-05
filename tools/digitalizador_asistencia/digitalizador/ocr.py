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


def codificar_imagen(imagen: np.ndarray, bytes_maximos: int = 4_500_000):
    """Codifica la imagen para la API respetando el límite de tamaño.

    Un escaneo a 300 ppp puede superar el máximo por imagen de la API; si el
    PNG se pasa, se recodifica en JPEG bajando la calidad, y solo como último
    recurso se reduce la resolución (que es lo que perjudica a la lectura).
    """
    correcto, buffer = cv2.imencode(".png", imagen)
    if correcto and buffer.nbytes <= bytes_maximos:
        return "image/png", base64.standard_b64encode(buffer.tobytes()).decode("ascii")

    trabajo = imagen
    for _ in range(4):
        for calidad in (92, 85, 75):
            correcto, buffer = cv2.imencode(".jpg", trabajo, [cv2.IMWRITE_JPEG_QUALITY, calidad])
            if correcto and buffer.nbytes <= bytes_maximos:
                return "image/jpeg", base64.standard_b64encode(buffer.tobytes()).decode("ascii")
        trabajo = cv2.resize(trabajo, None, fx=0.8, fy=0.8, interpolation=cv2.INTER_AREA)
    raise ValueError("No se pudo reducir la imagen por debajo del límite de la API")


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
    #: si es True, el motor puede releer las filas dudosas con más contexto
    soporta_relectura = False

    @abstractmethod
    def reconocer(self, recortes: Sequence[np.ndarray], tipo: str = TIPO_TEXTO) -> List[Campo]:
        """Transcribe una lista de recortes del mismo tipo de campo."""

    def transcribir_hoja(  # pragma: no cover - solo motores de hoja completa
        self, imagen: np.ndarray, cfg: Config, padron: Sequence[str] = ()
    ) -> Dict[str, Any]:
        raise NotImplementedError

    def releer(  # pragma: no cover - solo motores con relectura
        self, imagen: np.ndarray, dudas: Sequence[Dict[str, Any]], cfg: Config
    ) -> Dict[int, Dict[str, Any]]:
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
    "Eres un transcriptor experto de listados de asistencia manuscritos en español, "
    "acostumbrado a escaneos de mala calidad y a letra descuidada. "
    "Recibes la imagen de una hoja de asistencia y devuelves su contenido como tabla "
    "estructurada. Reglas: transcribe literalmente lo escrito, sin inventar ni completar "
    "datos; una fila de salida por cada fila escrita de la hoja, en el mismo orden; "
    "las filas totalmente vacías se omiten; respeta tildes, Ñ y nombres compuestos; "
    "para las columnas de firma o asistencia indica 'presente' si hay una marca, aspa, "
    "palomita o firma, 'ausente' si la celda está claramente vacía y 'dudoso' si no puedes "
    "decidirlo. Cuando la letra sea mala, transcribe tu mejor lectura y baja la confianza "
    "en lugar de dejarla en blanco; si es completamente ilegible, deja el texto vacío con "
    "confianza 0. Responde únicamente con JSON."
)

SISTEMA_RELECTURA = (
    "Eres un transcriptor experto de listados de asistencia manuscritos en español. "
    "Recibes una hoja ya transcrita y la lista de filas cuya lectura quedó dudosa. "
    "Vuelve a mirar solo esas filas con atención, apoyándote en el resto de la hoja "
    "(estilo de letra de la misma persona, columnas contiguas, numeración) y en los "
    "candidatos del padrón que se te ofrecen. Elige un candidato solo si de verdad "
    "coincide con los trazos; si no, mantén la lectura literal o deja el texto vacío. "
    "Nunca inventes un nombre. Responde únicamente con JSON."
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


def _bloque_imagen(imagen: np.ndarray, bytes_maximos: int = 4_500_000) -> Dict[str, Any]:
    tipo, datos = codificar_imagen(imagen, bytes_maximos)
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": tipo, "data": datos},
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

    def _preguntar_json(self, sistema: str, contenido: List[Dict[str, Any]]) -> Any:
        """Pregunta y parsea JSON, con un reintento más estricto si falla."""
        crudo = self.cliente.preguntar(sistema, contenido)
        try:
            return extraer_json(crudo)
        except ValueError:
            insistencia = list(contenido) + [
                {
                    "type": "text",
                    "text": "Tu respuesta anterior no era JSON válido. "
                            "Devuelve únicamente el JSON pedido, sin texto alrededor.",
                }
            ]
            return extraer_json(self.cliente.preguntar(sistema, insistencia))

    # -- segunda lectura de las filas dudosas ---------------------------
    soporta_relectura = True

    def releer(
        self, imagen: np.ndarray, dudas: Sequence[Dict[str, Any]], cfg: Config
    ) -> Dict[int, Dict[str, Any]]:
        """Relee las filas dudosas sobre la misma hoja y devuelve {fila: lectura}."""
        if not dudas:
            return {}
        contenido: List[Dict[str, Any]] = [
            _bloque_imagen(imagen, cfg.bytes_maximos_imagen),
            {"type": "text", "text": self._instruccion_relectura(dudas)},
        ]
        datos = self._preguntar_json(SISTEMA_RELECTURA, contenido)
        elementos = datos if isinstance(datos, list) else datos.get("filas", [])
        lecturas: Dict[int, Dict[str, Any]] = {}
        for elemento in elementos:
            if not isinstance(elemento, dict) or "fila" not in elemento:
                continue
            try:
                lecturas[int(elemento["fila"])] = elemento
            except (TypeError, ValueError):
                continue
        return lecturas

    def _instruccion_relectura(self, dudas: Sequence[Dict[str, Any]]) -> str:
        lineas = ["Estas son las filas dudosas de la hoja:"]
        for duda in dudas:
            detalle = (
                f"- fila {duda['fila']}"
                + (f" (nº {duda['numero']} escrito en la hoja)" if duda.get("numero") else "")
                + f": se leyó \"{duda.get('lectura', '')}\""
                + (f", documento \"{duda['documento']}\"" if duda.get("documento") else "")
                + f". Motivo de la duda: {duda.get('motivo', 'lectura poco fiable')}."
            )
            candidatos = duda.get("candidatos") or []
            if candidatos:
                detalle += " Candidatos del padrón: " + "; ".join(candidatos) + "."
            lineas.append(detalle)
        lineas.append(
            "Vuelve a leer esas filas concretas en la imagen y responde con este JSON:\n"
            '{"filas": [{"fila": 1, "nombre": "...", "documento": "...", '
            '"asistencia": {"etiqueta": "presente|ausente|dudoso"}, '
            '"confianza": 0.0, "candidato_padron": false, "ilegible": false}]}\n'
            "Incluye una entrada por cada fila dudosa, conservando su número de fila. "
            "Pon 'candidato_padron' en true solo si eliges uno de los candidatos ofrecidos. "
            "Si sigue siendo ilegible, deja el nombre como lo leíste, marca 'ilegible' "
            "en true y usa confianza 0. No añadas texto fuera del JSON."
        )
        return "\n".join(lineas)

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

    def transcribir_hoja(
        self, imagen: np.ndarray, cfg: Config, padron: Sequence[str] = ()
    ) -> Dict[str, Any]:
        contenido: List[Dict[str, Any]] = [
            _bloque_imagen(imagen, cfg.bytes_maximos_imagen),
            {"type": "text", "text": self._instruccion_hoja(cfg, padron)},
        ]
        datos = self._preguntar_json(SISTEMA_HOJA, contenido)
        if isinstance(datos, list):
            datos = {"columnas": [], "filas": datos}
        if not isinstance(datos, dict):
            raise ValueError("Respuesta inesperada del modelo al transcribir la hoja")
        datos.setdefault("columnas", [])
        datos.setdefault("filas", [])
        return datos

    def _instruccion_hoja(self, cfg: Config, padron: Sequence[str] = ()) -> str:
        pista = ""
        if cfg.columnas:
            pista = "Las columnas de la hoja, en orden, son: " + ", ".join(cfg.columnas) + ". "
        return (
            "Transcribe esta hoja de asistencia completa. "
            + pista
            + _contexto_padron(padron, cfg)
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


def _contexto_padron(padron: Sequence[str], cfg: Config) -> str:
    """Lista de nombres esperados que se envía junto con la hoja."""
    nombres = [n for n in padron if n][: cfg.padron_en_contexto]
    if not nombres:
        return ""
    return (
        "Estas personas figuran en el padrón y es probable que sean las que aparecen "
        "en la hoja: " + "; ".join(nombres) + ". "
        "Úsalas solo como referencia de grafía: si lo escrito coincide claramente con "
        "una de ellas, escríbela igual que en el padrón; si no coincide, transcribe lo "
        "que ves. Nunca sustituyas un nombre por otro parecido de la lista sin que los "
        "trazos lo respalden, y nunca añadas filas que no estén en la hoja. "
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
