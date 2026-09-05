"""Digitalizador de listados de asistencia manuscritos.

Uso rápido:

    from digitalizador import Config, procesar_archivo, exportar

    cfg = Config(motor="claude-hoja")
    hojas = procesar_archivo("listado.jpg", cfg)
    exportar(hojas, "asistencia.xlsx", "xlsx")
"""

from .config import Config
from .exportacion import exportar, exportar_csv, exportar_json, exportar_xlsx, informe
from .modelos import AUSENTE, DUDOSO, PRESENTE, Campo, Hoja, Registro
from .normalizacion import cargar_padron, emparejar, normalizar_documento, normalizar_nombre
from .ocr import crear_motor
from .pipeline import procesar_archivo, procesar_imagen, validar

__all__ = [
    "AUSENTE",
    "Campo",
    "Config",
    "DUDOSO",
    "Hoja",
    "PRESENTE",
    "Registro",
    "cargar_padron",
    "crear_motor",
    "emparejar",
    "exportar",
    "exportar_csv",
    "exportar_json",
    "exportar_xlsx",
    "informe",
    "normalizar_documento",
    "normalizar_nombre",
    "procesar_archivo",
    "procesar_imagen",
    "validar",
]

__version__ = "1.0.0"
