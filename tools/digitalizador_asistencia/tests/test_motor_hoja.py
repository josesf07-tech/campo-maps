"""Pruebas de la ruta 'hoja completa' (modelo de visión) con un cliente falso.

No se llama a ninguna API: se sustituye el cliente por uno que devuelve una
respuesta fija, para comprobar el parseo, el cotejo y el marcado de dudas.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from digitalizador.cli import main  # noqa: E402
from digitalizador.config import Config  # noqa: E402
from digitalizador.modelos import AUSENTE, DUDOSO, PRESENTE  # noqa: E402
from digitalizador.normalizacion import EntradaPadron, clave_comparacion  # noqa: E402
from digitalizador.ocr import MotorClaudeHoja  # noqa: E402
from digitalizador.pipeline import procesar_imagen  # noqa: E402
from digitalizador.sintetico import crear_hoja  # noqa: E402

RESPUESTA = {
    "columnas": [
        {"etiqueta": "N", "rol": "numero"},
        {"etiqueta": "Nombre y apellidos", "rol": "nombre"},
        {"etiqueta": "DNI", "rol": "documento"},
        {"etiqueta": "Firma", "rol": "firma"},
    ],
    "filas": [
        {"numero": 1, "nombre": "Maria Fernandez Ruiz", "documento": "12345678Z",
         "asistencia": {"Firma": "presente"}, "confianza": 0.88},
        {"numero": 2, "nombre": "José Antonio Pérez", "documento": "",
         "asistencia": {"Firma": "ausente"}, "confianza": 0.91},
        {"numero": 3, "nombre": "Ilegible", "documento": "",
         "asistencia": {"Firma": "dudoso"}, "confianza": 0.25},
    ],
}


class ClienteFalso:
    """Sustituto de `_ClienteClaude`: devuelve siempre la misma respuesta."""

    def __init__(self, carga=None):
        self.carga = carga if carga is not None else RESPUESTA
        self.peticiones = []

    def preguntar(self, sistema, contenido):
        self.peticiones.append((sistema, contenido))
        return "```json\n" + json.dumps(self.carga, ensure_ascii=False) + "\n```"


def _motor(carga=None) -> MotorClaudeHoja:
    cfg = Config(motor="claude-hoja")
    return MotorClaudeHoja(cfg, cliente=ClienteFalso(carga))


def test_hoja_completa_construye_registros():
    imagen, _ = crear_hoja()
    motor = _motor()
    cfg = Config(motor="claude-hoja", recortar_documento=False)
    hoja = procesar_imagen(imagen, cfg, [], motor, "hoja.jpg", 1)

    assert hoja.total == 3
    assert [r.numero for r in hoja.registros] == [1, 2, 3]
    assert hoja.registros[0].asistencia["Firma"] == PRESENTE
    assert hoja.registros[1].asistencia["Firma"] == AUSENTE
    assert hoja.registros[2].asistencia["Firma"] == DUDOSO
    assert hoja.columnas == ["Firma"]


def test_hoja_completa_envia_una_sola_imagen():
    imagen, _ = crear_hoja()
    motor = _motor()
    procesar_imagen(imagen, Config(motor="claude-hoja", recortar_documento=False),
                    [], motor, "hoja.jpg", 1)
    _, contenido = motor.cliente.peticiones[0]
    assert sum(1 for bloque in contenido if bloque["type"] == "image") == 1


def test_hoja_completa_corrige_con_padron_y_marca_dudas():
    imagen, _ = crear_hoja()
    padron = [
        EntradaPadron(nombre=n, clave=clave_comparacion(n))
        for n in ("María Fernández Ruiz", "José Antonio Pérez")
    ]
    cfg = Config(motor="claude-hoja", recortar_documento=False, umbral_confianza=0.6)
    hoja = procesar_imagen(imagen, cfg, padron, _motor(), "hoja.jpg", 1)

    assert hoja.registros[0].nombre.texto == "María Fernández Ruiz"
    assert hoja.registros[0].revisar is False
    # La tercera fila no está en el padrón, es poco fiable y su marca es dudosa.
    tercero = hoja.registros[2]
    assert tercero.revisar is True
    assert len(tercero.motivos) >= 2


def test_hoja_completa_ignora_filas_vacias():
    carga = {"columnas": RESPUESTA["columnas"],
             "filas": RESPUESTA["filas"] + [{"nombre": "", "documento": "", "asistencia": {}}]}
    imagen, _ = crear_hoja()
    hoja = procesar_imagen(imagen, Config(motor="claude-hoja", recortar_documento=False),
                           [], _motor(carga), "hoja.jpg", 1)
    assert hoja.total == 3


def test_hoja_completa_acepta_array_suelto():
    carga = RESPUESTA["filas"]
    imagen, _ = crear_hoja()
    hoja = procesar_imagen(imagen, Config(motor="claude-hoja", recortar_documento=False),
                           [], _motor(carga), "hoja.jpg", 1)
    assert hoja.total == 3
    assert hoja.registros[0].asistencia["Firma"] == PRESENTE


def test_cli_demo(tmp_path: Path, capsys):
    salida = tmp_path / "demo.csv"
    codigo = main([
        "--demo", "--motor", "nulo", "--encabezado", "si",
        "--columnas", "numero,nombre,documento,firma",
        "-s", str(salida), "--informe", str(tmp_path / "informe.txt"),
    ])
    assert codigo == 0
    assert salida.exists()
    assert (tmp_path / "informe.txt").exists()
    assert "Digitalización" in capsys.readouterr().out


def test_cli_motor_desconocido(capsys):
    with pytest.raises(SystemExit):
        main(["--demo", "--motor", "inexistente"])
