"""Estructuras de datos del digitalizador de listados de asistencia."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# (x, y, ancho, alto) en píxeles sobre la imagen ya preprocesada.
BBox = Tuple[int, int, int, int]

PRESENTE = "presente"
AUSENTE = "ausente"
DUDOSO = "dudoso"


@dataclass
class Campo:
    """Texto reconocido en una celda, con su confianza [0..1]."""

    texto: str = ""
    confianza: float = 0.0
    texto_crudo: str = ""
    motor: str = ""

    @property
    def vacio(self) -> bool:
        return not self.texto.strip()


@dataclass
class Coincidencia:
    """Resultado de comparar un nombre leído contra el padrón."""

    nombre: str = ""
    puntaje: float = 0.0
    estado: str = "sin_padron"  # sin_padron | exacta | corregida | sugerida | sin_coincidencia
    documento: str = ""


@dataclass
class Registro:
    """Una fila del listado: una persona."""

    fila: int
    numero: Optional[int] = None
    nombre: Campo = field(default_factory=Campo)
    documento: Optional[Campo] = None
    extras: Dict[str, Campo] = field(default_factory=dict)
    asistencia: Dict[str, str] = field(default_factory=dict)
    ratios_tinta: Dict[str, float] = field(default_factory=dict)
    coincidencia: Coincidencia = field(default_factory=Coincidencia)
    confianza: float = 0.0
    revisar: bool = False
    motivos: List[str] = field(default_factory=list)
    bbox: Optional[BBox] = None

    def marcar_revision(self, motivo: str) -> None:
        self.revisar = True
        if motivo not in self.motivos:
            self.motivos.append(motivo)

    def a_dict(self) -> Dict[str, Any]:
        datos: Dict[str, Any] = {
            "fila": self.fila,
            "numero": self.numero,
            "nombre": self.nombre.texto,
            "nombre_leido": self.nombre.texto_crudo,
            "confianza_nombre": round(self.nombre.confianza, 3),
            "documento": self.documento.texto if self.documento else "",
            "padron_estado": self.coincidencia.estado,
            "padron_puntaje": round(self.coincidencia.puntaje, 3),
        }
        for clave, campo in self.extras.items():
            datos[clave] = campo.texto
        for clave, estado in self.asistencia.items():
            datos[clave] = estado
        datos["confianza"] = round(self.confianza, 3)
        datos["revisar"] = self.revisar
        datos["motivos"] = "; ".join(self.motivos)
        return datos


@dataclass
class Hoja:
    """Una página digitalizada."""

    origen: str
    pagina: int
    registros: List[Registro] = field(default_factory=list)
    columnas: List[str] = field(default_factory=list)
    encabezados: List[str] = field(default_factory=list)
    metadatos: Dict[str, Any] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return len(self.registros)

    @property
    def a_revisar(self) -> List[Registro]:
        return [r for r in self.registros if r.revisar]

    def resumen(self) -> Dict[str, Any]:
        presentes = ausentes = dudosos = 0
        for registro in self.registros:
            for estado in registro.asistencia.values():
                if estado == PRESENTE:
                    presentes += 1
                elif estado == AUSENTE:
                    ausentes += 1
                else:
                    dudosos += 1
        return {
            "origen": self.origen,
            "pagina": self.pagina,
            "filas": self.total,
            "presentes": presentes,
            "ausentes": ausentes,
            "marcas_dudosas": dudosos,
            "a_revisar": len(self.a_revisar),
            "columnas": list(self.columnas),
        }
