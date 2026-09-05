"""Pruebas de limpieza de texto, validación de documento y cotejo con el padrón."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from digitalizador.modelos import Campo  # noqa: E402
from digitalizador.normalizacion import (  # noqa: E402
    EntradaPadron,
    cargar_padron,
    clave_comparacion,
    detectar_duplicados,
    emparejar,
    leer_numero,
    normalizar_documento,
    normalizar_nombre,
    similitud,
    validar_dni_es,
)


def _padron(*nombres) -> list:
    return [EntradaPadron(nombre=n, clave=clave_comparacion(n)) for n in nombres]


@pytest.mark.parametrize(
    "crudo, esperado",
    [
        ("  maría   fernández  ruiz ", "María Fernández Ruiz"),
        ("JOSE ANTONIO PEREZ", "Jose Antonio Perez"),
        ("ana de la cruz", "Ana de la Cruz"),
        ("|uc1a gomez", "Iucia Gomez"),          # | -> I y 1 interior -> I
        ("*Pedro Ruiz*", "Pedro Ruiz"),
    ],
)
def test_normalizar_nombre(crudo, esperado):
    assert normalizar_nombre(crudo) == esperado


def test_normalizar_nombre_mayusculas():
    assert normalizar_nombre("maría ruiz", "mayusculas") == "MARÍA RUIZ"


@pytest.mark.parametrize(
    "crudo, esperado",
    [
        ("12.345.678-Z", "12345678Z"),
        ("O5 O1 2345", "05012345"),   # O leída por 0 dentro de un bloque numérico
        ("dni 1234S678", "12345678"),
        ("", ""),
    ],
)
def test_normalizar_documento(crudo, esperado):
    assert normalizar_documento(crudo) == esperado


def test_validar_dni_espanol():
    assert validar_dni_es("12345678Z") is True
    assert validar_dni_es("12345678A") is False
    assert validar_dni_es("X1234567L") is True
    assert validar_dni_es("987654") is None      # no es formato DNI: no se opina


def test_leer_numero():
    assert leer_numero(" 12 ") == 12
    assert leer_numero("nº 7.") == 7
    assert leer_numero("") is None


def test_similitud_insensible_al_orden():
    assert similitud("Pérez Ruiz, Juan", "Juan Pérez Ruiz") > 0.9
    assert similitud("Juan Pérez", "Marta Solís") < 0.6


def test_emparejar_corrige_errores_de_lectura():
    padron = _padron("María Fernández Ruiz", "Carlos Iván Ramírez")
    resultado = emparejar("Maria Fernandez Ruíz", padron, 0.90, 0.72)
    assert resultado.estado in {"exacta", "corregida"}
    assert resultado.nombre == "María Fernández Ruiz"


def test_emparejar_sugiere_cuando_hay_dudas():
    padron = _padron("Ana Belén Ortega")
    resultado = emparejar("Ana Belen Ort", padron, 0.95, 0.70)
    assert resultado.estado == "sugerida"
    assert 0.70 <= resultado.puntaje < 0.95


def test_emparejar_sin_coincidencia():
    resultado = emparejar("Nombre Inventado", _padron("Ana Belén Ortega"), 0.90, 0.72)
    assert resultado.estado == "sin_coincidencia"
    assert resultado.nombre == ""


def test_emparejar_prioriza_el_documento():
    padron = [
        EntradaPadron(nombre="Lucía Gómez Salinas", documento="12345678Z",
                      clave=clave_comparacion("Lucía Gómez Salinas")),
    ]
    resultado = emparejar("Lucla G0mez", padron, 0.90, 0.72, documento="12345678Z")
    assert resultado.nombre == "Lucía Gómez Salinas"
    assert resultado.estado == "corregida"


def test_detectar_duplicados():
    duplicados = detectar_duplicados(["Ana Ruiz", "Luis Paz", "ana ruiz"])
    assert duplicados == {2: 0}


def test_cargar_padron_csv(tmp_path: Path):
    ruta = tmp_path / "padron.csv"
    ruta.write_text(
        "nombre,dni\nMaría Fernández Ruiz,12345678Z\nJosé Antonio Pérez,87654321X\n",
        encoding="utf-8",
    )
    padron = cargar_padron(ruta)
    assert [e.nombre for e in padron] == ["María Fernández Ruiz", "José Antonio Pérez"]
    assert padron[0].documento == "12345678Z"


def test_cargar_padron_sin_cabecera(tmp_path: Path):
    """Un CSV de solo nombres no debe perder la primera persona."""
    ruta = tmp_path / "padron.csv"
    ruta.write_text("Ana Ruiz,11111111H\nLuis Paz,22222222J\n", encoding="utf-8")
    padron = cargar_padron(ruta)
    assert [e.nombre for e in padron] == ["Ana Ruiz", "Luis Paz"]


def test_cargar_padron_txt(tmp_path: Path):
    ruta = tmp_path / "padron.txt"
    ruta.write_text("Ana Ruiz\n\nLuis Paz\n", encoding="utf-8")
    assert [e.nombre for e in cargar_padron(ruta)] == ["Ana Ruiz", "Luis Paz"]


def test_campo_vacio():
    assert Campo(texto="   ").vacio is True
    assert Campo(texto="Ana").vacio is False
