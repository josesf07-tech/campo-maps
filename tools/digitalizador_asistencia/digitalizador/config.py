"""Configuración del digitalizador.

Todos los umbrales viven aquí para poder ajustarlos sin tocar el código
y para poder cargarlos desde un JSON (`--config ajustes.json`).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, Dict, List, Optional

# Roles de columna que entiende el pipeline.
ROL_NUMERO = "numero"
ROL_NOMBRE = "nombre"
ROL_DOCUMENTO = "documento"
ROL_CARGO = "cargo"
ROL_CONTACTO = "contacto"
ROL_FIRMA = "firma"
ROL_ASISTENCIA = "asistencia"
ROL_IGNORAR = "ignorar"

ROLES_TEXTO = {ROL_NUMERO, ROL_NOMBRE, ROL_DOCUMENTO, ROL_CARGO, ROL_CONTACTO}
ROLES_MARCA = {ROL_FIRMA, ROL_ASISTENCIA}

# Palabras clave para deducir el rol de cada columna a partir del encabezado.
PALABRAS_ROL: Dict[str, List[str]] = {
    ROL_NUMERO: ["n", "no", "nro", "num", "numero", "orden", "item", "#"],
    ROL_NOMBRE: [
        "nombre", "nombres", "apellido", "apellidos", "participante",
        "asistente", "alumno", "estudiante", "trabajador", "integrante",
        "personal", "docente", "socio", "vecino",
    ],
    ROL_DOCUMENTO: [
        "dni", "cedula", "ci", "doc", "documento", "identificacion",
        "identidad", "rut", "curp", "nif", "nie", "id", "matricula",
    ],
    ROL_CARGO: [
        "cargo", "puesto", "empresa", "area", "dependencia", "institucion",
        "grado", "seccion", "curso", "obra", "cuadrilla", "grupo",
    ],
    ROL_CONTACTO: ["telefono", "celular", "cel", "movil", "contacto", "correo", "email", "mail"],
    ROL_FIRMA: ["firma", "firmas", "huella", "rubrica", "sello"],
    ROL_ASISTENCIA: [
        "asistencia", "asiste", "presente", "marca", "dia", "fecha",
        "turno", "entrada", "salida", "manana", "tarde", "x",
    ],
}


@dataclass
class Config:
    """Parámetros del proceso completo."""

    # --- Entrada / imagen ---
    dpi_pdf: int = 300
    paginas: str = ""                   # selección tipo "1-3,7" (vacío = todas)
    ancho_objetivo: int = 2200          # se reescala la página a este ancho
    ancho_minimo: int = 1200
    recortar_documento: bool = True     # corregir perspectiva de fotos de móvil
    enderezar: bool = True
    angulo_maximo: float = 15.0
    corregir_rotacion: bool = True      # escaneos de lado o del revés
    rotacion: str = "auto"              # auto | 0 | 90 | 180 | 270
    margen_orientacion: float = 0.004   # señal mínima para arriesgar un giro de 180°
    umbral_pagina_blanco: float = 0.0015
    bloque_umbral: int = 41             # blockSize del umbral adaptativo (impar)
    constante_umbral: int = 15
    imagen_modelo: str = "auto"         # auto | color | realzada
    bytes_maximos_imagen: int = 4_500_000

    # --- Detección de la tabla ---
    cobertura_linea_h: float = 0.35     # fracción del ancho que debe cubrir una línea
    cobertura_linea_v: float = 0.30
    separacion_minima: int = 12         # px entre dos líneas para no fusionarlas
    alto_minimo_fila: int = 18
    ancho_minimo_columna: int = 22
    margen_celda: int = 4               # px que se recortan hacia dentro de la celda
    divisor_kernel_lineas: int = 30

    # --- Detección de marcas (firma / asistencia) ---
    umbral_marca_bajo: float = 0.012    # ratio de tinta: por debajo => ausente
    umbral_marca_alto: float = 0.045    # por encima => presente
    calibrar_marcas: bool = True        # umbral por columna con Otsu 1-D

    # --- OCR ---
    motor: str = "claude-hoja"          # claude-hoja | claude | trocr | tesseract | nulo
    modelo_claude: str = "claude-opus-5"
    esfuerzo_claude: str = "medium"     # low | medium | high | xhigh | max
    lote_claude: int = 12               # recortes por petición en el motor "claude"
    max_tokens_claude: int = 8000
    idioma_tesseract: str = "spa"
    modelo_trocr: str = "microsoft/trocr-base-handwritten"

    # --- Segunda lectura de las filas dudosas ---
    segunda_opinion: bool = True        # relee las filas marcadas con más contexto
    max_filas_segunda_opinion: int = 25
    candidatos_padron: int = 6          # cuántos nombres del padrón se ofrecen por fila
    padron_en_contexto: int = 250       # nombres del padrón que se envían con la hoja

    # --- Post-proceso ---
    umbral_confianza: float = 0.60      # por debajo, la fila se marca para revisión
    umbral_padron_auto: float = 0.90    # corrige el nombre automáticamente
    umbral_padron_sugerencia: float = 0.72  # sugiere y marca para revisión
    formato_nombre: str = "titulo"      # titulo | mayusculas | crudo

    # --- Estructura ---
    columnas: Optional[List[str]] = None   # roles forzados, p.ej. ["numero","nombre","documento","firma"]
    fila_encabezado: str = "auto"          # auto | si | no
    max_paginas: int = 0                   # 0 = todas

    # --- Depuración ---
    directorio_depuracion: Optional[str] = None

    extra: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.bloque_umbral % 2 == 0:
            self.bloque_umbral += 1
        self.rotacion = str(self.rotacion).strip().lower()
        if self.rotacion not in {"auto", "0", "90", "180", "270"}:
            raise ValueError("rotacion debe ser auto, 0, 90, 180 o 270")
        if self.imagen_modelo not in {"auto", "color", "realzada"}:
            raise ValueError("imagen_modelo debe ser auto, color o realzada")
        if self.fila_encabezado not in {"auto", "si", "no"}:
            raise ValueError("fila_encabezado debe ser auto, si o no")
        if self.umbral_marca_alto <= self.umbral_marca_bajo:
            raise ValueError("umbral_marca_alto debe ser mayor que umbral_marca_bajo")
        if self.umbral_padron_auto < self.umbral_padron_sugerencia:
            raise ValueError("umbral_padron_auto debe ser >= umbral_padron_sugerencia")

    # -- serialización ------------------------------------------------
    @classmethod
    def desde_json(cls, ruta: Path | str) -> "Config":
        datos = json.loads(Path(ruta).read_text(encoding="utf-8"))
        return cls.desde_dict(datos)

    @classmethod
    def desde_dict(cls, datos: Dict[str, Any]) -> "Config":
        validos = {f.name for f in fields(cls)}
        conocidos = {k: v for k, v in datos.items() if k in validos}
        extra = {k: v for k, v in datos.items() if k not in validos}
        cfg = cls(**conocidos)
        cfg.extra.update(extra)
        return cfg

    def a_dict(self) -> Dict[str, Any]:
        return asdict(self)
