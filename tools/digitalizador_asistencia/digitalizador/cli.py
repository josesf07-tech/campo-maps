"""Interfaz de línea de comandos del digitalizador.

Ejemplos:
    python -m digitalizador hoja.jpg -s asistencia.csv
    python -m digitalizador escaneos/ --padron padron.csv --formato todos
    python -m digitalizador acta.pdf --motor tesseract --depuracion salida/debug
    python -m digitalizador --demo -s demo.csv --motor nulo
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional, Sequence

from .config import Config
from .exportacion import exportar, informe
from .modelos import Hoja
from .normalizacion import cargar_padron
from .ocr import crear_motor
from .pipeline import procesar_archivo, procesar_imagen
from .preprocesado import listar_entradas


def construir_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="digitalizador",
        description="Digitaliza listados de asistencia escritos a mano.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("entrada", nargs="?", help="imagen, PDF o carpeta con los listados")
    parser.add_argument("-s", "--salida", default="asistencia.csv", help="ruta del archivo de salida")
    parser.add_argument(
        "-f", "--formato", default="csv", choices=["csv", "json", "xlsx", "todos"],
        help="formato de salida",
    )
    parser.add_argument(
        "-m", "--motor", default=None,
        choices=["claude-hoja", "claude", "trocr", "tesseract", "nulo"],
        help="motor de reconocimiento",
    )
    parser.add_argument("--modelo", default=None, help="modelo de Claude a usar")
    parser.add_argument(
        "--esfuerzo", default=None, choices=["low", "medium", "high", "xhigh", "max"],
        help="esfuerzo de razonamiento del modelo",
    )
    parser.add_argument("--padron", default=None, help="CSV/TXT con la lista oficial de personas")
    parser.add_argument(
        "--columnas", default=None,
        help="roles de columna separados por comas, p.ej. numero,nombre,documento,firma",
    )
    parser.add_argument(
        "--encabezado", default=None, choices=["auto", "si", "no"],
        help="si la primera fila es un encabezado impreso",
    )
    parser.add_argument("--config", default=None, help="JSON con ajustes adicionales")
    parser.add_argument("--dpi", type=int, default=None,
                        help="resolución al rasterizar PDF (sube a 400 si la letra es pequeña)")
    parser.add_argument("--paginas", default=None,
                        help="páginas del PDF a procesar, p.ej. 1-3,7 (vacío = todas)")
    parser.add_argument("--max-paginas", type=int, default=None, help="límite de páginas (0 = todas)")
    parser.add_argument("--rotacion", default=None, choices=["auto", "0", "90", "180", "270"],
                        help="giro de la página; auto detecta escaneos de lado o del revés")
    parser.add_argument("--imagen-modelo", default=None, choices=["auto", "color", "realzada"],
                        help="qué versión de la página ve el modelo de visión")
    parser.add_argument("--sin-segunda-opinion", action="store_true",
                        help="no releer las filas dudosas (ahorra una petición por página)")
    parser.add_argument(
        "--umbral-confianza", type=float, default=None,
        help="por debajo de este valor la fila se marca para revisión",
    )
    parser.add_argument("--depuracion", default=None, help="carpeta donde guardar imágenes anotadas")
    parser.add_argument("--informe", default=None, help="ruta del informe de revisión (.txt)")
    parser.add_argument("--demo", action="store_true", help="procesa una hoja sintética de ejemplo")
    parser.add_argument("-q", "--silencioso", action="store_true", help="no imprime el informe")
    return parser


def construir_config(argumentos: argparse.Namespace) -> Config:
    cfg = Config.desde_json(argumentos.config) if argumentos.config else Config()
    if argumentos.motor:
        cfg.motor = argumentos.motor
    if argumentos.modelo:
        cfg.modelo_claude = argumentos.modelo
    if argumentos.esfuerzo:
        cfg.esfuerzo_claude = argumentos.esfuerzo
    if argumentos.columnas:
        cfg.columnas = [c.strip().lower() for c in argumentos.columnas.split(",") if c.strip()]
    if argumentos.encabezado:
        cfg.fila_encabezado = argumentos.encabezado
    if argumentos.dpi:
        cfg.dpi_pdf = argumentos.dpi
    if argumentos.paginas is not None:
        cfg.paginas = argumentos.paginas
    if argumentos.rotacion:
        cfg.rotacion = argumentos.rotacion
    if argumentos.imagen_modelo:
        cfg.imagen_modelo = argumentos.imagen_modelo
    if argumentos.sin_segunda_opinion:
        cfg.segunda_opinion = False
    if argumentos.max_paginas is not None:
        cfg.max_paginas = argumentos.max_paginas
    if argumentos.umbral_confianza is not None:
        cfg.umbral_confianza = argumentos.umbral_confianza
    if argumentos.depuracion:
        cfg.directorio_depuracion = argumentos.depuracion
    cfg.__post_init__()
    return cfg


def main(argv: Optional[Sequence[str]] = None) -> int:
    argumentos = construir_parser().parse_args(argv)
    if not argumentos.entrada and not argumentos.demo:
        construir_parser().error("indica una entrada o usa --demo")

    cfg = construir_config(argumentos)
    padron = cargar_padron(argumentos.padron) if argumentos.padron else []

    try:
        motor = crear_motor(cfg)
    except (RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    hojas: List[Hoja] = []
    if argumentos.demo:
        from .sintetico import crear_hoja

        imagen, _ = crear_hoja(inclinacion=1.2, ruido=0.01)
        hojas.append(procesar_imagen(imagen, cfg, padron, motor, "demo.png", 1))
    else:
        entradas = listar_entradas(argumentos.entrada)
        if not entradas:
            print(f"error: no hay archivos procesables en {argumentos.entrada}", file=sys.stderr)
            return 2
        for ruta in entradas:
            try:
                hojas.extend(procesar_archivo(ruta, cfg, padron, motor))
            except Exception as error:  # noqa: BLE001 - un archivo malo no aborta el lote
                print(f"error procesando {ruta.name}: {error}", file=sys.stderr)

    if not hojas:
        print("error: no se pudo digitalizar ninguna hoja", file=sys.stderr)
        return 1

    try:
        escritos = exportar(hojas, argumentos.salida, argumentos.formato)
    except (RuntimeError, ValueError, OSError) as error:
        print(f"error al escribir la salida: {error}", file=sys.stderr)
        return 3

    texto = informe(hojas)
    if argumentos.informe:
        ruta_informe = Path(argumentos.informe)
        ruta_informe.parent.mkdir(parents=True, exist_ok=True)
        ruta_informe.write_text(texto + "\n", encoding="utf-8")
    if not argumentos.silencioso:
        print(texto)
        for ruta in escritos:
            print(f"\nEscrito: {ruta}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
