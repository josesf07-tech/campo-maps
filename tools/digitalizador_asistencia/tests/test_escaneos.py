"""Pruebas del caso real: PDF escaneados, páginas torcidas y letra dudosa."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from digitalizador.config import Config  # noqa: E402
from digitalizador.modelos import DUDOSO, PRESENTE  # noqa: E402
from digitalizador.normalizacion import EntradaPadron, clave_comparacion  # noqa: E402
from digitalizador.ocr import MotorClaudeHoja, MotorNulo, codificar_imagen  # noqa: E402
from digitalizador.pipeline import procesar_archivo, procesar_imagen  # noqa: E402
from digitalizador.preprocesado import (  # noqa: E402
    analizar_seleccion,
    aplicar_rotacion,
    cargar_paginas,
    contar_paginas,
    es_gris,
    preparar,
)
from digitalizador.revision import candidatos_padron, recopilar_dudas  # noqa: E402
from digitalizador.sintetico import NOMBRES, crear_hoja, crear_pdf, simular_escaneo  # noqa: E402
from digitalizador.tabla import detectar_rejilla  # noqa: E402

CFG_BASE = dict(motor="nulo", recortar_documento=False, fila_encabezado="si",
                columnas=["numero", "nombre", "documento", "firma"])


class ClienteGuion:
    """Cliente falso que devuelve respuestas preparadas, una por petición."""

    def __init__(self, respuestas: Sequence[Any]):
        self.respuestas = list(respuestas)
        self.peticiones: List[Any] = []

    def preguntar(self, sistema, contenido):
        self.peticiones.append((sistema, contenido))
        carga = self.respuestas.pop(0) if self.respuestas else {}
        return carga if isinstance(carga, str) else json.dumps(carga, ensure_ascii=False)


def _hoja_transcrita(nombre: str, confianza: float) -> Dict[str, Any]:
    return {
        "columnas": [
            {"etiqueta": "N", "rol": "numero"},
            {"etiqueta": "Nombre y apellidos", "rol": "nombre"},
            {"etiqueta": "Firma", "rol": "firma"},
        ],
        "filas": [
            {"numero": 1, "nombre": "Ana Belén Ortega", "asistencia": {"Firma": "presente"},
             "confianza": 0.95},
            {"numero": 2, "nombre": nombre, "asistencia": {"Firma": "dudoso"},
             "confianza": confianza},
        ],
    }


# --------------------------------------------------------------------------
# Escaneos: rotación, páginas en blanco, realce
# --------------------------------------------------------------------------
@pytest.mark.parametrize("giro", [0, 90, 180, 270])
def test_endereza_escaneos_girados(giro):
    """Una hoja escaneada de lado o del revés se recoloca antes de segmentar."""
    imagen, verdad = crear_hoja()
    girada = aplicar_rotacion(simular_escaneo(imagen), giro)
    cfg = Config(**CFG_BASE)

    pagina = preparar(girada, cfg)
    rejilla = detectar_rejilla(pagina.binaria, cfg)
    assert rejilla.con_rejilla
    assert rejilla.n_columnas == 4
    assert rejilla.n_filas == len(verdad) + 1


def test_pagina_en_blanco_no_consulta_al_modelo():
    blanca = np.full((1400, 1000, 3), 252, dtype=np.uint8)
    cliente = ClienteGuion([])
    motor = MotorClaudeHoja(Config(motor="claude-hoja"), cliente=cliente)

    hoja = procesar_imagen(blanca, Config(motor="claude-hoja"), [], motor, "escaneo.pdf", 4)

    assert hoja.registros == []
    assert "blanco" in hoja.metadatos["aviso"]
    assert cliente.peticiones == []          # no se gastó ninguna petición


def test_escaneo_gris_se_envia_realzado():
    imagen, _ = crear_hoja()
    escaneo = simular_escaneo(imagen)
    assert es_gris(escaneo)

    cfg = Config(motor="claude-hoja", recortar_documento=False)
    pagina = preparar(escaneo, cfg)
    assert pagina.modelo.ndim == 2                       # gris realzado
    assert pagina.modelo.std() > pagina.gris.std() * 0.9  # el realce no aplana el contraste


def test_foto_a_color_se_envia_en_color():
    imagen, _ = crear_hoja()
    pagina = preparar(imagen, Config(motor="claude-hoja", recortar_documento=False))
    assert pagina.modelo.ndim == 3


def test_codificar_imagen_respeta_el_limite():
    imagen, _ = crear_hoja()
    tipo, datos = codificar_imagen(imagen, bytes_maximos=120_000)
    assert tipo == "image/jpeg"
    assert len(datos) * 3 // 4 <= 120_000


# --------------------------------------------------------------------------
# PDF de varias páginas
# --------------------------------------------------------------------------
def test_carga_pdf_multipagina(tmp_path: Path):
    ruta = crear_pdf(tmp_path / "escaneos.pdf", paginas=3)
    assert contar_paginas(ruta) == 3

    paginas = cargar_paginas(ruta, dpi=150)
    assert [numero for numero, _ in paginas] == [1, 2, 3]
    assert all(imagen.ndim == 3 for _, imagen in paginas)


def test_procesa_pdf_completo(tmp_path: Path):
    ruta = crear_pdf(tmp_path / "escaneos.pdf", paginas=2)
    cfg = Config(**CFG_BASE, dpi_pdf=200)
    hojas = procesar_archivo(ruta, cfg, [], MotorNulo())

    assert [hoja.pagina for hoja in hojas] == [1, 2]
    assert all(hoja.total == len(NOMBRES) for hoja in hojas)


def test_seleccion_de_paginas(tmp_path: Path):
    ruta = crear_pdf(tmp_path / "escaneos.pdf", paginas=4)
    cfg = Config(**CFG_BASE, dpi_pdf=150, paginas="2,4")
    hojas = procesar_archivo(ruta, cfg, [], MotorNulo())
    # El número de página que se exporta es el real dentro del PDF.
    assert [hoja.pagina for hoja in hojas] == [2, 4]


@pytest.mark.parametrize(
    "especificacion, esperado",
    [
        ("", [0, 1, 2, 3, 4]),
        ("1", [0]),
        ("2-4", [1, 2, 3]),
        ("1,3,5", [0, 2, 4]),
        ("3-", [2, 3, 4]),
        ("4-2", [3, 2, 1]),
        ("9", []),                 # fuera de rango: se ignora
        ("2,2,2", [1]),            # sin repetidos
    ],
)
def test_analizar_seleccion(especificacion, esperado):
    assert analizar_seleccion(especificacion, 5) == esperado


def test_analizar_seleccion_invalida():
    with pytest.raises(ValueError):
        analizar_seleccion("uno-dos", 5)


def test_una_pagina_rota_no_tumba_el_lote(tmp_path: Path):
    class MotorRompe(MotorNulo):
        hoja_completa = True

        def transcribir_hoja(self, imagen, cfg, padron=()):
            raise RuntimeError("timeout de la API")

    ruta = crear_pdf(tmp_path / "escaneos.pdf", paginas=2)
    hojas = procesar_archivo(ruta, Config(motor="nulo", dpi_pdf=150), [], MotorRompe())

    assert len(hojas) == 2                       # ninguna página se pierde
    assert all("timeout" in hoja.metadatos["error"] for hoja in hojas)


# --------------------------------------------------------------------------
# Letra dudosa: segunda lectura
# --------------------------------------------------------------------------
def _padron(*nombres) -> List[EntradaPadron]:
    return [EntradaPadron(nombre=n, clave=clave_comparacion(n)) for n in nombres]


def test_candidatos_padron_ordena_por_parecido():
    padron = _padron("Ana Belén Ortega", "Miguel Ángel Soto", "Paula Núñez Cabrera")
    candidatos = candidatos_padron("Migel Angel Sto", padron, 2)
    assert candidatos[0] == "Miguel Ángel Soto"


def test_recopilar_dudas_describe_el_motivo():
    imagen, _ = crear_hoja()
    cliente = ClienteGuion([_hoja_transcrita("Rbto Grcia", 0.30)])
    motor = MotorClaudeHoja(Config(motor="claude-hoja"), cliente=cliente)
    cfg = Config(motor="claude-hoja", recortar_documento=False, segunda_opinion=False)
    padron = _padron("Ana Belén Ortega", "Roberto García Nieto")

    hoja = procesar_imagen(imagen, cfg, padron, motor, "hoja.pdf", 1)
    dudas = recopilar_dudas(hoja, cfg, padron)

    assert len(dudas) == 1
    assert dudas[0]["fila"] == 2
    assert "Roberto García Nieto" in dudas[0]["candidatos"]
    assert dudas[0]["marcas_dudosas"] == ["Firma"]


def test_segunda_lectura_corrige_la_fila_dudosa():
    imagen, _ = crear_hoja()
    relectura = {
        "filas": [
            {"fila": 2, "nombre": "Roberto García Nieto", "confianza": 0.86,
             "candidato_padron": True, "asistencia": {"Firma": "presente"}},
        ]
    }
    cliente = ClienteGuion([_hoja_transcrita("Rbto Grcia", 0.30), relectura])
    motor = MotorClaudeHoja(Config(motor="claude-hoja"), cliente=cliente)
    cfg = Config(motor="claude-hoja", recortar_documento=False)
    padron = _padron("Ana Belén Ortega", "Roberto García Nieto")

    hoja = procesar_imagen(imagen, cfg, padron, motor, "hoja.pdf", 1)

    segundo = hoja.registros[1]
    assert len(cliente.peticiones) == 2                  # transcripción + relectura
    assert segundo.nombre.texto == "Roberto García Nieto"
    assert segundo.nombre.texto_crudo == "Rbto Grcia"    # se conserva lo leído primero
    assert segundo.asistencia["Firma"] == PRESENTE
    assert segundo.relectura is True
    assert segundo.revisar is False
    assert hoja.metadatos["segunda_opinion"]["actualizadas"] == 1


def test_segunda_lectura_no_pisa_una_lectura_mejor():
    imagen, _ = crear_hoja()
    relectura = {"filas": [{"fila": 2, "nombre": "Otro Nombre Distinto", "confianza": 0.10}]}
    cliente = ClienteGuion([_hoja_transcrita("Rbto Grcia", 0.55), relectura])
    motor = MotorClaudeHoja(Config(motor="claude-hoja"), cliente=cliente)
    cfg = Config(motor="claude-hoja", recortar_documento=False)

    hoja = procesar_imagen(imagen, cfg, [], motor, "hoja.pdf", 1)

    assert hoja.registros[1].nombre.texto == "Rbto Grcia"
    assert hoja.registros[1].revisar is True


def test_lo_ilegible_se_queda_marcado():
    imagen, _ = crear_hoja()
    relectura = {"filas": [{"fila": 2, "nombre": "", "confianza": 0.0, "ilegible": True}]}
    cliente = ClienteGuion([_hoja_transcrita("", 0.05), relectura])
    motor = MotorClaudeHoja(Config(motor="claude-hoja"), cliente=cliente)

    hoja = procesar_imagen(imagen, Config(motor="claude-hoja", recortar_documento=False),
                           [], motor, "hoja.pdf", 1)

    fila = hoja.registros[1]
    assert fila.revisar is True
    assert fila.nombre.texto == ""
    assert fila.asistencia["Firma"] == DUDOSO
    assert hoja.metadatos["segunda_opinion"]["ilegibles"] == 1


def test_sin_segunda_opinion_no_hay_peticion_extra():
    imagen, _ = crear_hoja()
    cliente = ClienteGuion([_hoja_transcrita("Rbto Grcia", 0.30)])
    motor = MotorClaudeHoja(Config(motor="claude-hoja"), cliente=cliente)
    cfg = Config(motor="claude-hoja", recortar_documento=False, segunda_opinion=False)

    procesar_imagen(imagen, cfg, [], motor, "hoja.pdf", 1)
    assert len(cliente.peticiones) == 1


def test_el_padron_viaja_como_contexto():
    imagen, _ = crear_hoja()
    cliente = ClienteGuion([_hoja_transcrita("Ana Belén Ortega", 0.9)])
    motor = MotorClaudeHoja(Config(motor="claude-hoja"), cliente=cliente)
    padron = _padron("Ana Belén Ortega", "Roberto García Nieto")

    procesar_imagen(imagen, Config(motor="claude-hoja", recortar_documento=False),
                    padron, motor, "hoja.pdf", 1)

    _, contenido = cliente.peticiones[0]
    texto = " ".join(b["text"] for b in contenido if b["type"] == "text")
    assert "Roberto García Nieto" in texto
    assert "padrón" in texto


def test_reintento_cuando_la_respuesta_no_es_json():
    imagen, _ = crear_hoja()
    cliente = ClienteGuion(["lo siento, no puedo", _hoja_transcrita("Ana Belén Ortega", 0.9)])
    motor = MotorClaudeHoja(Config(motor="claude-hoja"), cliente=cliente)
    cfg = Config(motor="claude-hoja", recortar_documento=False, segunda_opinion=False)

    hoja = procesar_imagen(imagen, cfg, [], motor, "hoja.pdf", 1)

    assert len(cliente.peticiones) == 2
    assert hoja.total == 2
