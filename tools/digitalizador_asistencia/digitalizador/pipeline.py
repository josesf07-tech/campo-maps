"""Orquestación: de la imagen del listado a los registros validados."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import cv2
import numpy as np

from .config import (
    ROLES_MARCA,
    ROLES_TEXTO,
    ROL_CARGO,
    ROL_CONTACTO,
    ROL_DOCUMENTO,
    ROL_IGNORAR,
    ROL_NOMBRE,
    ROL_NUMERO,
    Config,
)
from .marcas import clasificar_columna, quitar_lineas, ratio_tinta
from .modelos import AUSENTE, DUDOSO, PRESENTE, Campo, Hoja, Registro
from .normalizacion import (
    EntradaPadron,
    detectar_duplicados,
    emparejar,
    leer_numero,
    normalizar_documento,
    normalizar_espacios,
    normalizar_nombre,
    validar_dni_es,
)
from .ocr import (
    TIPO_DOCUMENTO,
    TIPO_NOMBRE,
    TIPO_NUMERO,
    TIPO_TEXTO,
    MotorOCR,
    crear_motor,
)
from .preprocesado import Pagina, cargar_paginas, preparar, recortar
from .revision import aplicar_segunda_opinion
from .tabla import Rejilla, detectar_fila_encabezado, detectar_rejilla, inferir_roles, nombre_columna

TIPO_POR_ROL = {
    ROL_NOMBRE: TIPO_NOMBRE,
    ROL_NUMERO: TIPO_NUMERO,
    ROL_DOCUMENTO: TIPO_DOCUMENTO,
    ROL_CARGO: TIPO_TEXTO,
    ROL_CONTACTO: TIPO_TEXTO,
}


# --------------------------------------------------------------------------
# API principal
# --------------------------------------------------------------------------
def procesar_archivo(
    ruta: Path | str,
    cfg: Optional[Config] = None,
    padron: Optional[Sequence[EntradaPadron]] = None,
    motor: Optional[MotorOCR] = None,
) -> List[Hoja]:
    """Digitaliza todas las páginas de una imagen o PDF.

    Un PDF escaneado trae páginas de calidad desigual: si una falla, se anota
    el error en esa hoja y se sigue con el resto en lugar de perder el lote.
    """
    cfg = cfg or Config()
    motor = motor or crear_motor(cfg)
    ruta = Path(ruta)

    paginas = cargar_paginas(ruta, cfg.dpi_pdf, cfg.paginas)
    if cfg.max_paginas:
        paginas = paginas[: cfg.max_paginas]

    hojas: List[Hoja] = []
    for numero, imagen in paginas:
        try:
            hojas.append(procesar_imagen(imagen, cfg, padron, motor, ruta.name, numero))
        except Exception as error:  # noqa: BLE001 - una página mala no tumba el PDF
            hoja = Hoja(origen=ruta.name, pagina=numero)
            hoja.metadatos["error"] = f"{type(error).__name__}: {error}"
            hojas.append(hoja)
    return hojas


def procesar_imagen(
    imagen: np.ndarray,
    cfg: Config,
    padron: Optional[Sequence[EntradaPadron]],
    motor: MotorOCR,
    origen: str = "",
    numero_pagina: int = 1,
) -> Hoja:
    """Digitaliza una única página ya cargada en memoria."""
    pagina = preparar(imagen, cfg)
    padron = list(padron or [])

    if pagina.en_blanco:
        # Ni una petición a la API ni un falso positivo: la página está vacía.
        hoja = Hoja(origen=origen, pagina=numero_pagina)
        hoja.metadatos["aviso"] = "Página en blanco: se omite"
    elif motor.hoja_completa:
        hoja = _hoja_desde_modelo(pagina, cfg, motor, padron, origen, numero_pagina)
    else:
        hoja = _hoja_desde_rejilla(pagina, cfg, motor, origen, numero_pagina)

    hoja.metadatos.update(
        {
            "motor": motor.nombre,
            "angulo_corregido": round(pagina.angulo, 2),
            "rotacion_corregida": pagina.rotacion,
            "perspectiva_corregida": pagina.recortada,
            "escala": round(pagina.escala, 3),
            "tinta": round(pagina.tinta, 5),
            "tamano": [int(pagina.color.shape[1]), int(pagina.color.shape[0])],
        }
    )
    validar(hoja, cfg, padron)

    if cfg.segunda_opinion and motor.soporta_relectura and hoja.a_revisar:
        resumen = aplicar_segunda_opinion(hoja, pagina.modelo, cfg, motor, padron)
        if resumen.get("consultadas"):
            hoja.metadatos["segunda_opinion"] = resumen
            validar(hoja, cfg, padron)

    if cfg.directorio_depuracion:
        tallo = Path(origen or "hoja").stem or "hoja"
        destino = Path(cfg.directorio_depuracion) / f"{tallo}_p{numero_pagina}_depuracion.png"
        hoja.metadatos["depuracion"] = str(guardar_depuracion(hoja, pagina.color, destino))
    return hoja


# --------------------------------------------------------------------------
# Ruta A: segmentación local + OCR por celda
# --------------------------------------------------------------------------
def _hoja_desde_rejilla(
    pagina: Pagina,
    cfg: Config,
    motor: MotorOCR,
    origen: str,
    numero_pagina: int,
) -> Hoja:
    rejilla = detectar_rejilla(pagina.binaria, cfg)
    hoja = Hoja(origen=origen, pagina=numero_pagina)
    if rejilla.n_filas == 0 or rejilla.n_columnas == 0:
        hoja.metadatos["aviso"] = "No se detectaron filas en la página"
        return hoja

    encabezados = _leer_encabezados(pagina, rejilla, cfg, motor)
    hay_encabezado = detectar_fila_encabezado(rejilla, encabezados, cfg)
    roles = inferir_roles(rejilla, encabezados if hay_encabezado else [], cfg)
    etiquetas = [
        nombre_columna(i, rol, encabezados[i] if hay_encabezado and i < len(encabezados) else "")
        for i, rol in enumerate(roles)
    ]

    primera = 1 if hay_encabezado else 0
    filas = list(range(primera, rejilla.n_filas))
    if not filas:
        hoja.metadatos["aviso"] = "La tabla solo contiene el encabezado"
        return hoja

    registros = [Registro(fila=indice, bbox=rejilla.fila_bbox(fila))
                 for indice, fila in enumerate(filas, start=1)]

    # --- columnas de texto ---
    for columna, rol in enumerate(roles):
        if rol not in ROLES_TEXTO:
            continue
        recortes = [
            recortar(pagina.gris, rejilla.celda(fila, columna), cfg.margen_celda)
            for fila in filas
        ]
        campos = motor.reconocer(recortes, TIPO_POR_ROL.get(rol, TIPO_TEXTO))
        _asignar_campos(registros, rol, etiquetas[columna], campos)

    # --- columnas de marcas ---
    tinta = quitar_lineas(pagina.binaria, cfg)
    for columna, rol in enumerate(roles):
        if rol not in ROLES_MARCA:
            continue
        ratios = [
            ratio_tinta(tinta, rejilla.celda(fila, columna), cfg.margen_celda)
            for fila in filas
        ]
        estados, umbrales = clasificar_columna(ratios, cfg)
        etiqueta = etiquetas[columna]
        for registro, estado, ratio in zip(registros, estados, ratios):
            registro.asistencia[etiqueta] = estado
            registro.ratios_tinta[etiqueta] = round(ratio, 5)
        hoja.metadatos.setdefault("umbrales_marcas", {})[etiqueta] = {
            k: (round(v, 5) if np.isfinite(v) else None) for k, v in umbrales.items()
        }

    hoja.registros = registros
    hoja.encabezados = etiquetas
    hoja.columnas = _columnas_salida(roles, etiquetas)
    hoja.metadatos["roles"] = roles
    hoja.metadatos["rejilla"] = {
        "detectada": rejilla.con_rejilla,
        "filas": rejilla.n_filas,
        "columnas": rejilla.n_columnas,
        "encabezado": hay_encabezado,
    }
    return hoja


def _leer_encabezados(
    pagina: Pagina, rejilla: Rejilla, cfg: Config, motor: MotorOCR
) -> List[str]:
    """Transcribe la primera fila para deducir los roles y detectar el encabezado.

    Se lee incluso cuando los roles vienen forzados por configuración, porque
    también sirve para saber si esa primera fila es un encabezado impreso.
    """
    if cfg.fila_encabezado == "no" or not rejilla.con_rejilla:
        return []
    if motor.nombre == "nulo" or rejilla.n_filas < 2:
        return []
    recortes = [
        recortar(pagina.gris, rejilla.celda(0, columna), cfg.margen_celda)
        for columna in range(rejilla.n_columnas)
    ]
    return [campo.texto for campo in motor.reconocer(recortes, TIPO_TEXTO)]


def _asignar_campos(
    registros: Sequence[Registro], rol: str, etiqueta: str, campos: Sequence[Campo]
) -> None:
    for registro, campo in zip(registros, campos):
        if rol == ROL_NOMBRE:
            registro.nombre = campo
        elif rol == ROL_DOCUMENTO:
            registro.documento = campo
        elif rol == ROL_NUMERO:
            registro.numero = leer_numero(campo.texto)
        else:
            registro.extras[etiqueta] = campo


def _columnas_salida(roles: Sequence[str], etiquetas: Sequence[str]) -> List[str]:
    columnas: List[str] = []
    for rol, etiqueta in zip(roles, etiquetas):
        if rol in (ROL_NOMBRE, ROL_NUMERO, ROL_DOCUMENTO, ROL_IGNORAR):
            continue
        columnas.append(etiqueta)
    return columnas


# --------------------------------------------------------------------------
# Ruta B: transcripción de la hoja completa con el modelo de visión
# --------------------------------------------------------------------------
def _hoja_desde_modelo(
    pagina: Pagina,
    cfg: Config,
    motor: MotorOCR,
    padron: Sequence[EntradaPadron],
    origen: str,
    numero_pagina: int,
) -> Hoja:
    nombres = [entrada.nombre for entrada in padron]
    datos = motor.transcribir_hoja(pagina.modelo, cfg, nombres)
    hoja = Hoja(origen=origen, pagina=numero_pagina)

    columnas_modelo = [c for c in datos.get("columnas", []) if isinstance(c, dict)]
    etiquetas_marca = [
        str(c.get("etiqueta", "")).strip()
        for c in columnas_modelo
        if str(c.get("rol", "")).lower() in ROLES_MARCA
    ]
    hoja.encabezados = [str(c.get("etiqueta", "")).strip() for c in columnas_modelo]

    columnas: List[str] = []
    registros: List[Registro] = []
    for indice, fila in enumerate(datos.get("filas", []), start=1):
        if not isinstance(fila, dict):
            continue
        registro = _registro_desde_dict(fila, indice, etiquetas_marca)
        if registro is None:
            continue
        registros.append(registro)
        for clave in list(registro.extras) + list(registro.asistencia):
            if clave not in columnas:
                columnas.append(clave)

    hoja.registros = registros
    hoja.columnas = columnas
    hoja.metadatos["columnas_modelo"] = columnas_modelo
    return hoja


def _registro_desde_dict(
    fila: Dict[str, Any], indice: int, etiquetas_marca: Sequence[str]
) -> Optional[Registro]:
    nombre = normalizar_espacios(str(fila.get("nombre", "") or ""))
    documento = normalizar_espacios(str(fila.get("documento", "") or ""))
    extras_crudos = fila.get("extras") if isinstance(fila.get("extras"), dict) else {}
    asistencia_cruda = fila.get("asistencia") if isinstance(fila.get("asistencia"), dict) else {}
    if not nombre and not documento and not asistencia_cruda:
        return None

    confianza = fila.get("confianza")
    try:
        confianza = float(confianza)
    except (TypeError, ValueError):
        confianza = 0.5
    confianza = min(max(confianza if confianza <= 1 else confianza / 100.0, 0.0), 1.0)

    registro = Registro(
        fila=indice,
        numero=leer_numero(str(fila.get("numero", "") or "")),
        nombre=Campo(texto=nombre, confianza=confianza, texto_crudo=nombre, motor="claude-hoja"),
    )
    if documento:
        registro.documento = Campo(
            texto=documento, confianza=confianza, texto_crudo=documento, motor="claude-hoja"
        )
    for clave, valor in extras_crudos.items():
        registro.extras[str(clave)] = Campo(
            texto=normalizar_espacios(str(valor or "")),
            confianza=confianza,
            texto_crudo=str(valor or ""),
            motor="claude-hoja",
        )
    for clave in etiquetas_marca or list(asistencia_cruda):
        registro.asistencia[str(clave)] = _estado_marca(asistencia_cruda.get(clave))
    return registro


def _estado_marca(valor: Any) -> str:
    texto = str(valor or "").strip().lower()
    if texto in {"presente", "si", "sí", "x", "true", "1", "asistio", "asistió", "p"}:
        return PRESENTE
    if texto in {"ausente", "no", "false", "0", "vacio", "vacío", "a", ""}:
        return AUSENTE
    return DUDOSO


# --------------------------------------------------------------------------
# Validación y normalización final
# --------------------------------------------------------------------------
def validar(hoja: Hoja, cfg: Config, padron: Optional[Sequence[EntradaPadron]]) -> None:
    """Normaliza los campos, coteja con el padrón y marca lo que hay que revisar."""
    padron = list(padron or [])

    for registro in hoja.registros:
        registro.reiniciar_revision()
        crudo = registro.nombre.texto
        registro.nombre.texto_crudo = registro.nombre.texto_crudo or crudo
        registro.nombre.texto = normalizar_nombre(crudo, cfg.formato_nombre)

        if registro.documento is not None:
            registro.documento.texto_crudo = registro.documento.texto_crudo or registro.documento.texto
            registro.documento.texto = normalizar_documento(registro.documento.texto)

        documento = registro.documento.texto if registro.documento else ""
        registro.coincidencia = emparejar(
            registro.nombre.texto,
            padron,
            cfg.umbral_padron_auto,
            cfg.umbral_padron_sugerencia,
            documento,
        )
        _aplicar_coincidencia(registro, cfg)
        _calcular_confianza(registro, cfg)

    _revisar_numeracion(hoja)
    _revisar_duplicados(hoja)


def _aplicar_coincidencia(registro: Registro, cfg: Config) -> None:
    estado = registro.coincidencia.estado
    if estado in {"exacta", "corregida"}:
        # El padrón manda: fija la grafía oficial (tildes, guiones, orden).
        registro.nombre.texto = normalizar_nombre(registro.coincidencia.nombre, cfg.formato_nombre)
    elif estado == "sugerida":
        registro.marcar_revision(
            f"posible '{registro.coincidencia.nombre}' "
            f"({registro.coincidencia.puntaje:.0%} de parecido)"
        )
    elif estado == "sin_coincidencia":
        registro.marcar_revision("no figura en el padrón")


def _calcular_confianza(registro: Registro, cfg: Config) -> None:
    confianza = registro.nombre.confianza
    estado = registro.coincidencia.estado
    if estado in {"exacta", "corregida"}:
        confianza = max(confianza, registro.coincidencia.puntaje)
    elif estado == "sugerida":
        confianza = min(confianza, registro.coincidencia.puntaje)

    if not registro.nombre.texto.strip():
        confianza = 0.0
        registro.marcar_revision("nombre vacío o ilegible")
    elif confianza < cfg.umbral_confianza:
        registro.marcar_revision(f"lectura poco fiable ({confianza:.0%})")

    if registro.documento is not None and registro.documento.texto:
        valido = validar_dni_es(registro.documento.texto)
        if valido is False:
            registro.marcar_revision("documento con dígito de control incorrecto")
        elif valido is None and len(registro.documento.texto) < 6:
            registro.marcar_revision("documento demasiado corto")

    for etiqueta, estado_marca in registro.asistencia.items():
        if estado_marca == DUDOSO:
            registro.marcar_revision(f"marca ambigua en '{etiqueta}'")

    registro.confianza = float(min(max(confianza, 0.0), 1.0))


def _revisar_numeracion(hoja: Hoja) -> None:
    numeros = [r.numero for r in hoja.registros if r.numero is not None]
    if len(numeros) < 3:
        return
    esperado = numeros[0]
    for registro in hoja.registros:
        if registro.numero is None:
            continue
        if registro.numero != esperado:
            registro.marcar_revision(
                f"numeración inesperada (se leyó {registro.numero}, se esperaba {esperado})"
            )
            esperado = registro.numero
        esperado += 1


def _revisar_duplicados(hoja: Hoja) -> None:
    duplicados = detectar_duplicados([r.nombre.texto for r in hoja.registros])
    for indice, original in duplicados.items():
        hoja.registros[indice].marcar_revision(
            f"posible duplicado de la fila {hoja.registros[original].fila}"
        )


# --------------------------------------------------------------------------
# Depuración visual
# --------------------------------------------------------------------------
def guardar_depuracion(hoja: Hoja, imagen: np.ndarray, destino: Path | str) -> Path:
    """Guarda la página con las filas detectadas y su estado dibujados encima."""
    destino = Path(destino)
    destino.parent.mkdir(parents=True, exist_ok=True)
    lienzo = imagen.copy()
    for registro in hoja.registros:
        if not registro.bbox:
            continue
        x, y, ancho, alto = registro.bbox
        color = (0, 0, 220) if registro.revisar else (0, 170, 0)
        cv2.rectangle(lienzo, (x, y), (x + ancho, y + alto), color, 2)
        etiqueta = f"{registro.fila}. {registro.nombre.texto[:28]} ({registro.confianza:.0%})"
        cv2.putText(
            lienzo, etiqueta, (x + 6, max(14, y + 18)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA,
        )
    cv2.imwrite(str(destino), lienzo)
    return destino
