"""Limpieza de texto, validación de documentos y cotejo contra el padrón.

Es la parte que convierte una transcripción "casi correcta" en un dato
utilizable: corrige confusiones típicas de lectura manuscrita, normaliza
mayúsculas y partículas, valida el documento y, si se aporta un padrón
(la lista oficial de personas), corrige el nombre contra él.
"""

from __future__ import annotations

import csv
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

from .modelos import Coincidencia

try:  # opcional: mejora notablemente el cotejo
    from rapidfuzz import fuzz as _fuzz  # type: ignore
except ImportError:  # pragma: no cover - depende del entorno
    _fuzz = None

# Partículas que se escriben en minúscula dentro de un nombre.
PARTICULAS = {"de", "del", "la", "las", "los", "y", "da", "das", "do", "dos", "van", "von", "di", "der", "el"}

# Confusiones frecuentes al leer manuscrita.
DIGITO_A_LETRA = {"0": "O", "1": "I", "2": "Z", "4": "A", "5": "S", "6": "G", "8": "B"}
LETRA_A_DIGITO = {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2", "S": "5", "B": "8", "G": "6"}

LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE"

# Etiquetas que la gente escribe delante del número de documento.
PREFIJOS_DOCUMENTO = re.compile(
    r"^(DOCUMENTO|IDENTIDAD|CEDULA|CURP|DNI|NIF|NIE|RUC|RUT|DOC|CI|CC|ID)(?=\d)"
)


@dataclass
class EntradaPadron:
    nombre: str
    documento: str = ""
    clave: str = ""


# --------------------------------------------------------------------------
# Texto
# --------------------------------------------------------------------------
def sin_tildes(texto: str) -> str:
    descompuesto = unicodedata.normalize("NFKD", texto)
    return "".join(c for c in descompuesto if not unicodedata.combining(c))


def normalizar_espacios(texto: str) -> str:
    return re.sub(r"\s+", " ", (texto or "").replace("\n", " ")).strip()


def clave_comparacion(texto: str) -> str:
    """Forma canónica para comparar dos nombres."""
    limpio = sin_tildes(normalizar_espacios(texto)).upper()
    limpio = re.sub(r"[^A-Z0-9ÑÜ ]+", " ", limpio.replace("Ñ", "Ñ"))
    return normalizar_espacios(limpio)


def a_titulo(texto: str) -> str:
    """Capitaliza respetando partículas y apóstrofos ('de la Cruz', "O'Higgins")."""
    palabras = normalizar_espacios(texto).split(" ")
    salida: List[str] = []
    for indice, palabra in enumerate(palabras):
        minuscula = palabra.lower()
        if indice > 0 and minuscula in PARTICULAS:
            salida.append(minuscula)
            continue
        partes = re.split(r"([´'\-])", minuscula)
        salida.append("".join(p.capitalize() if p.isalpha() else p for p in partes))
    return " ".join(salida)


def normalizar_nombre(texto: str, formato: str = "titulo") -> str:
    """Limpia un nombre leído: símbolos sueltos, dígitos confundidos, formato."""
    limpio = normalizar_espacios(texto).replace("|", "I").replace("_", " ")
    limpio = re.sub(r"^[\W]+|[\W]+$", "", limpio)
    # Un dígito dentro de una palabra alfabética es casi siempre una letra.
    limpio = re.sub(
        r"(?<=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])([0-9])|([0-9])(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])",
        lambda m: DIGITO_A_LETRA.get(m.group(0), m.group(0)),
        limpio,
    )
    limpio = normalizar_espacios(re.sub(r"[^\wÁÉÍÓÚÜÑáéíóúüñ'´\-. ]+", " ", limpio))
    limpio = re.sub(r"\s*,\s*", ", ", limpio)
    if formato == "mayusculas":
        return limpio.upper()
    if formato == "crudo":
        return limpio
    return a_titulo(limpio)


def normalizar_documento(texto: str) -> str:
    """Deja solo caracteres válidos de un documento y corrige confusiones."""
    limpio = sin_tildes(normalizar_espacios(texto)).upper()
    limpio = re.sub(r"[^A-Z0-9]", "", limpio)
    if not limpio:
        return ""
    # "DNI12345678" -> "12345678": la etiqueta escrita delante no es el dato.
    sin_etiqueta = PREFIJOS_DOCUMENTO.sub("", limpio, count=1)
    if len(sin_etiqueta) >= 6:
        limpio = sin_etiqueta
    # Los documentos son mayoritariamente numéricos: las letras dentro de un
    # bloque de dígitos suelen ser lecturas erróneas.
    if sum(c.isdigit() for c in limpio) >= max(3, len(limpio) - 2):
        cuerpo = limpio[:-1] if limpio[-1].isalpha() and len(limpio) >= 8 else limpio
        sufijo = limpio[len(cuerpo):]
        cuerpo = "".join(LETRA_A_DIGITO.get(c, c) for c in cuerpo)
        limpio = cuerpo + sufijo
    return limpio


def solo_digitos(texto: str) -> str:
    return re.sub(r"\D", "", texto or "")


def leer_numero(texto: str) -> Optional[int]:
    digitos = solo_digitos(texto)
    if not digitos:
        return None
    try:
        return int(digitos[:6])
    except ValueError:  # pragma: no cover
        return None


def validar_dni_es(documento: str) -> Optional[bool]:
    """Valida la letra de control de un DNI/NIE español.

    Devuelve None si el formato no corresponde a un DNI/NIE (no se puede
    afirmar nada), True/False si sí corresponde.
    """
    doc = normalizar_documento(documento)
    if re.fullmatch(r"\d{7,8}[A-Z]", doc):
        numero = int(doc[:-1])
        return LETRAS_DNI[numero % 23] == doc[-1]
    if re.fullmatch(r"[XYZ]\d{7}[A-Z]", doc):
        numero = int(str("XYZ".index(doc[0])) + doc[1:-1])
        return LETRAS_DNI[numero % 23] == doc[-1]
    return None


# --------------------------------------------------------------------------
# Padrón
# --------------------------------------------------------------------------
def cargar_padron(ruta: Path | str) -> List[EntradaPadron]:
    """Lee el padrón desde CSV (columnas nombre[,documento]) o TXT (un nombre por línea)."""
    ruta = Path(ruta)
    if not ruta.exists():
        raise FileNotFoundError(f"No existe el padrón: {ruta}")
    entradas: List[EntradaPadron] = []

    if ruta.suffix.lower() in {".csv", ".tsv"}:
        delimitador = "\t" if ruta.suffix.lower() == ".tsv" else ","
        with ruta.open(encoding="utf-8-sig", newline="") as manejador:
            filas = list(csv.reader(manejador, delimiter=delimitador))
        indice_nombre, indice_doc = 0, 1
        if filas and _es_cabecera(filas[0]):
            cabecera = [clave_comparacion(c) for c in filas[0]]
            for i, titulo in enumerate(cabecera):
                if any(p in titulo for p in ("NOMBRE", "APELLIDO")):
                    indice_nombre = i
                if any(p in titulo for p in ("DNI", "DOC", "CEDULA", "CI", "RUT", "CURP", "ID")):
                    indice_doc = i
            filas = filas[1:]
        for fila in filas:
            if not fila or not fila[indice_nombre].strip():
                continue
            documento = fila[indice_doc].strip() if len(fila) > indice_doc else ""
            entradas.append(_entrada(fila[indice_nombre], documento))
    else:
        for linea in ruta.read_text(encoding="utf-8").splitlines():
            if linea.strip():
                entradas.append(_entrada(linea, ""))
    return entradas


def _es_cabecera(fila: Sequence[str]) -> bool:
    """La primera fila es cabecera si alguna celda es un título de columna.

    `csv.Sniffer` no sirve aquí: un padrón es todo texto, y entonces no
    distingue la cabecera de la primera persona de la lista.
    """
    titulos = {
        "NOMBRE", "NOMBRES", "APELLIDO", "APELLIDOS", "PERSONA", "PARTICIPANTE",
        "DNI", "NIF", "NIE", "DOC", "DOCUMENTO", "CEDULA", "CI", "RUT", "CURP", "ID",
    }
    for celda in fila:
        palabras = set(clave_comparacion(celda).split())
        if palabras & titulos:
            return True
    return False


def _entrada(nombre: str, documento: str) -> EntradaPadron:
    limpio = normalizar_espacios(nombre)
    return EntradaPadron(
        nombre=limpio,
        documento=normalizar_documento(documento),
        clave=clave_comparacion(limpio),
    )


# --------------------------------------------------------------------------
# Similitud y cotejo
# --------------------------------------------------------------------------
def similitud(a: str, b: str) -> float:
    """Similitud [0..1] insensible al orden de nombres y apellidos."""
    clave_a, clave_b = clave_comparacion(a), clave_comparacion(b)
    if not clave_a or not clave_b:
        return 0.0
    if clave_a == clave_b:
        return 1.0
    if _fuzz is not None:
        directo = _fuzz.ratio(clave_a, clave_b) / 100.0
        ordenado = _fuzz.token_sort_ratio(clave_a, clave_b) / 100.0
        conjunto = _fuzz.token_set_ratio(clave_a, clave_b) / 100.0
        return max(directo, ordenado, 0.97 * conjunto)

    directo = SequenceMatcher(None, clave_a, clave_b).ratio()
    ordenado = SequenceMatcher(
        None, " ".join(sorted(clave_a.split())), " ".join(sorted(clave_b.split()))
    ).ratio()
    tokens_a, tokens_b = set(clave_a.split()), set(clave_b.split())
    jaccard = len(tokens_a & tokens_b) / float(len(tokens_a | tokens_b) or 1)
    return max(directo, ordenado, 0.97 * jaccard)


def emparejar(
    nombre: str,
    padron: Sequence[EntradaPadron],
    umbral_auto: float,
    umbral_sugerencia: float,
    documento: str = "",
) -> Coincidencia:
    """Coteja un nombre leído contra el padrón.

    Si el documento coincide de forma exacta con una entrada, esa entrada
    gana: un número es mucho más fiable que un trazo manuscrito.
    """
    if not padron:
        return Coincidencia(estado="sin_padron")
    if not clave_comparacion(nombre) and not documento:
        return Coincidencia(estado="sin_coincidencia")

    documento = normalizar_documento(documento)
    if documento:
        for entrada in padron:
            if entrada.documento and entrada.documento == documento:
                return Coincidencia(
                    nombre=entrada.nombre,
                    puntaje=max(similitud(nombre, entrada.nombre), umbral_auto),
                    estado="corregida" if clave_comparacion(nombre) != entrada.clave else "exacta",
                    documento=entrada.documento,
                )

    mejor: Optional[EntradaPadron] = None
    mejor_puntaje = 0.0
    for entrada in padron:
        puntaje = similitud(nombre, entrada.nombre)
        if puntaje > mejor_puntaje:
            mejor, mejor_puntaje = entrada, puntaje

    if mejor is None:
        return Coincidencia(estado="sin_coincidencia")
    if mejor_puntaje >= 0.999:
        estado = "exacta"
    elif mejor_puntaje >= umbral_auto:
        estado = "corregida"
    elif mejor_puntaje >= umbral_sugerencia:
        estado = "sugerida"
    else:
        return Coincidencia(nombre="", puntaje=mejor_puntaje, estado="sin_coincidencia")
    return Coincidencia(
        nombre=mejor.nombre,
        puntaje=mejor_puntaje,
        estado=estado,
        documento=mejor.documento,
    )


def detectar_duplicados(nombres: Iterable[str], umbral: float = 0.94) -> Dict[int, int]:
    """Índice de fila -> índice de la primera fila con la misma persona."""
    lista = list(nombres)
    duplicados: Dict[int, int] = {}
    claves = [clave_comparacion(n) for n in lista]
    for i in range(len(lista)):
        if not claves[i]:
            continue
        for j in range(i):
            if not claves[j] or j in duplicados:
                continue
            if claves[i] == claves[j] or similitud(lista[i], lista[j]) >= umbral:
                duplicados[i] = j
                break
    return duplicados
