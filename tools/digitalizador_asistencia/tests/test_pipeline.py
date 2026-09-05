"""Pruebas del pipeline sobre hojas sintéticas: rejilla, marcas y exportación.

No requieren API ni motores de OCR externos: se usa un motor simulado.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import List, Sequence

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from digitalizador.config import Config  # noqa: E402
from digitalizador.exportacion import exportar_csv, exportar_json, informe  # noqa: E402
from digitalizador.marcas import umbral_otsu_1d  # noqa: E402
from digitalizador.modelos import AUSENTE, PRESENTE, Campo  # noqa: E402
from digitalizador.normalizacion import EntradaPadron, clave_comparacion  # noqa: E402
from digitalizador.ocr import MotorNulo, MotorOCR, extraer_json  # noqa: E402
from digitalizador.pipeline import procesar_imagen  # noqa: E402
from digitalizador.preprocesado import preparar  # noqa: E402
from digitalizador.sintetico import ENCABEZADOS, NOMBRES, crear_hoja  # noqa: E402
from digitalizador.tabla import detectar_rejilla, rol_por_encabezado  # noqa: E402


class MotorSimulado(MotorOCR):
    """Devuelve textos predefinidos, en el orden en que se piden las columnas."""

    nombre = "simulado"

    def __init__(self, encabezados: Sequence[str], columnas: Sequence[Sequence[str]]):
        self.encabezados = list(encabezados)
        self.columnas = [list(c) for c in columnas]
        self.llamadas: List[str] = []

    def reconocer(self, recortes, tipo="texto"):
        self.llamadas.append(tipo)
        if len(recortes) == len(self.encabezados) and not self.llamadas[:-1]:
            textos = self.encabezados
        elif self.columnas:
            textos = self.columnas.pop(0)
        else:
            textos = [""] * len(recortes)
        textos = list(textos)[: len(recortes)]
        textos += [""] * (len(recortes) - len(textos))
        return [Campo(texto=t, confianza=0.93, texto_crudo=t, motor=self.nombre) for t in textos]


CONFIG_PRUEBA = dict(
    motor="nulo",
    recortar_documento=False,
    # El motor "nulo" no lee texto: hay que declarar el encabezado a mano.
    fila_encabezado="si",
)


def test_detecta_rejilla_completa():
    imagen, verdad = crear_hoja()
    cfg = Config(**CONFIG_PRUEBA)
    pagina = preparar(imagen, cfg)
    rejilla = detectar_rejilla(pagina.binaria, cfg)
    assert rejilla.con_rejilla
    assert rejilla.n_columnas == 4
    assert rejilla.n_filas == len(verdad) + 1  # + encabezado


def test_detecta_rejilla_con_inclinacion_y_ruido():
    imagen, verdad = crear_hoja(inclinacion=2.5, ruido=0.02)
    cfg = Config(**CONFIG_PRUEBA)
    pagina = preparar(imagen, cfg)
    assert abs(pagina.angulo) > 1.0          # se detectó y corrigió la inclinación
    rejilla = detectar_rejilla(pagina.binaria, cfg)
    assert rejilla.con_rejilla
    assert rejilla.n_filas == len(verdad) + 1


def test_marcas_de_asistencia_coinciden_con_la_verdad():
    presentes = [True, False, True, True, False, True, False, True, True, False]
    imagen, verdad = crear_hoja(presentes=presentes)
    cfg = Config(**CONFIG_PRUEBA, columnas=["numero", "nombre", "documento", "firma"])
    hoja = procesar_imagen(imagen, cfg, [], MotorNulo(), "sintetica.png", 1)

    assert hoja.total == len(verdad)
    leidas = [list(r.asistencia.values())[0] for r in hoja.registros]
    esperadas = [PRESENTE if p else AUSENTE for p in presentes]
    assert leidas == esperadas


def test_transcripcion_y_cotejo_con_padron():
    imagen, verdad = crear_hoja()
    leidos = list(NOMBRES)
    leidos[0] = "Maria Fernandez Ruíz"      # error de lectura típico
    leidos[3] = "Carlos lvan Ramirez"
    motor = MotorSimulado(
        encabezados=ENCABEZADOS,
        columnas=[
            [str(i + 1) for i in range(len(NOMBRES))],   # columna N
            leidos,                                       # columna Nombre
            [v["documento"] for v in verdad],             # columna DNI
        ],
    )
    padron = [EntradaPadron(nombre=n, clave=clave_comparacion(n)) for n in NOMBRES]
    cfg = Config(motor="nulo", recortar_documento=False)
    hoja = procesar_imagen(imagen, cfg, padron, motor, "sintetica.png", 1)

    assert hoja.total == len(NOMBRES)
    assert [r.nombre.texto for r in hoja.registros] == NOMBRES
    assert [r.numero for r in hoja.registros] == [v["numero"] for v in verdad]
    assert hoja.metadatos["roles"] == ["numero", "nombre", "documento", "firma"]
    assert all(r.coincidencia.estado in {"exacta", "corregida"} for r in hoja.registros)


def test_nombre_fuera_del_padron_se_marca_para_revision():
    imagen, _ = crear_hoja(nombres=["Ana Belén Ortega", "Nombre Que No Existe"],
                           presentes=[True, True])
    motor = MotorSimulado(
        encabezados=ENCABEZADOS,
        columnas=[["1", "2"], ["Ana Belén Ortega", "Nombre Que No Existe"], ["", ""]],
    )
    padron = [EntradaPadron(nombre="Ana Belén Ortega", clave=clave_comparacion("Ana Belén Ortega"))]
    hoja = procesar_imagen(imagen, Config(motor="nulo", recortar_documento=False),
                           padron, motor, "sintetica.png", 1)

    assert hoja.registros[0].revisar is False
    assert hoja.registros[1].revisar is True
    assert "padrón" in " ".join(hoja.registros[1].motivos)


def test_documento_invalido_se_marca():
    imagen, _ = crear_hoja(nombres=["Ana Belén Ortega"], presentes=[True],
                           documentos=["12345678A"])
    motor = MotorSimulado(
        encabezados=ENCABEZADOS,
        columnas=[["1"], ["Ana Belén Ortega"], ["12345678A"]],   # letra de control incorrecta
    )
    hoja = procesar_imagen(imagen, Config(motor="nulo", recortar_documento=False),
                           [], motor, "sintetica.png", 1)
    assert hoja.registros[0].revisar is True
    assert any("control" in m for m in hoja.registros[0].motivos)


def test_exportacion_csv_y_json(tmp_path: Path):
    imagen, verdad = crear_hoja()
    cfg = Config(**CONFIG_PRUEBA, columnas=["numero", "nombre", "documento", "firma"])
    hoja = procesar_imagen(imagen, cfg, [], MotorNulo(), "sintetica.png", 1)

    ruta_csv = exportar_csv([hoja], tmp_path / "salida.csv")
    with ruta_csv.open(encoding="utf-8-sig") as manejador:
        filas = list(csv.DictReader(manejador))
    assert len(filas) == len(verdad)
    assert {"archivo", "pagina", "fila", "nombre", "confianza", "revisar"} <= set(filas[0])

    ruta_json = exportar_json([hoja], tmp_path / "salida.json")
    datos = json.loads(ruta_json.read_text(encoding="utf-8"))
    assert datos["resumen"][0]["filas"] == len(verdad)
    assert len(datos["hojas"][0]["registros"]) == len(verdad)

    assert "revisión" in informe([hoja])


def test_depuracion_guarda_imagen(tmp_path: Path):
    imagen, _ = crear_hoja()
    cfg = Config(**CONFIG_PRUEBA, columnas=["numero", "nombre", "documento", "firma"],
                 directorio_depuracion=str(tmp_path))
    hoja = procesar_imagen(imagen, cfg, [], MotorNulo(), "sintetica.png", 1)
    assert Path(hoja.metadatos["depuracion"]).exists()


def test_roles_por_encabezado():
    assert rol_por_encabezado("Nombre y apellidos") == "nombre"
    assert rol_por_encabezado("D.N.I.") == "documento"
    assert rol_por_encabezado("Firma") == "firma"
    assert rol_por_encabezado("") is None


def test_umbral_otsu_1d_separa_dos_grupos():
    valores = [0.001, 0.002, 0.0015, 0.09, 0.11, 0.10]
    corte = umbral_otsu_1d(valores)
    assert 0.002 < corte < 0.09
    assert np.isnan(umbral_otsu_1d([0.1, 0.2]))


@pytest.mark.parametrize(
    "respuesta",
    [
        '[{"celda": 0, "texto": "Ana"}]',
        '```json\n[{"celda": 0, "texto": "Ana"}]\n```',
        'Aquí tienes:\n[{"celda": 0, "texto": "Ana"}]\nEso es todo.',
    ],
)
def test_extraer_json_tolera_ruido(respuesta):
    assert extraer_json(respuesta) == [{"celda": 0, "texto": "Ana"}]


def test_extraer_json_falla_con_texto_libre():
    with pytest.raises(ValueError):
        extraer_json("no hay json aquí")
