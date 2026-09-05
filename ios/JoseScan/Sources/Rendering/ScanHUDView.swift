//
//  ScanHUDView.swift
//  JoseScan
//
//  Superposición de control sobre la vista de cámara: estado del seguimiento,
//  métricas en vivo, calidad y botonera de captura.
//
//  Diseñada para trabajo de campo: botones grandes (aptos con guantes), alto
//  contraste bajo el sol y etiquetas de accesibilidad en español.
//

import Foundation
import SwiftUI
import UIKit

public struct ScanHUDView: View {

    @ObservedObject public var sesion: ScanSession
    @ObservedObject public var geo: Georeferencer
    @Binding public var modoVisualizacion: ModoVisualizacion

    /// Se invoca cuando el usuario decide cerrar el escaneo y revisarlo.
    public var onFinalizar: () -> Void
    /// Se invoca cuando el usuario abandona la pantalla sin guardar.
    public var onCancelar: () -> Void

    @State private var mostrarConfirmacionReinicio = false
    @State private var mostrarConfirmacionCancelar = false

    public init(sesion: ScanSession,
                geo: Georeferencer,
                modoVisualizacion: Binding<ModoVisualizacion>,
                onFinalizar: @escaping () -> Void,
                onCancelar: @escaping () -> Void) {
        self.sesion = sesion
        self.geo = geo
        self._modoVisualizacion = modoVisualizacion
        self.onFinalizar = onFinalizar
        self.onCancelar = onCancelar
    }

    // MARK: - Formateadores

    private static let formateadorEntero: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "es_CO")
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        f.groupingSeparator = "."
        f.usesGroupingSeparator = true
        return f
    }()

    private static let formateadorDecimal: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "es_CO")
        f.numberStyle = .decimal
        f.minimumFractionDigits = 1
        f.maximumFractionDigits = 1
        f.groupingSeparator = "."
        f.decimalSeparator = ","
        f.usesGroupingSeparator = true
        return f
    }()

    /// Entero con separador de miles es-CO (1.234.567).
    public static func entero(_ valor: Int) -> String {
        formateadorEntero.string(from: NSNumber(value: valor)) ?? "\(valor)"
    }

    /// Decimal con una cifra y coma decimal es-CO (12,3).
    public static func decimal(_ valor: Double) -> String {
        guard valor.isFinite else { return "—" }
        return formateadorDecimal.string(from: NSNumber(value: valor)) ?? "0,0"
    }

    // MARK: - Cuerpo

    public var body: some View {
        VStack(spacing: 10) {
            barraSuperior
            avisoTermico
            chipsMetricas
            Spacer(minLength: 0)
            HStack(alignment: .bottom) {
                QualityGauge(valor: sesion.metrics.score, diametro: 92, grosor: 9)
                Spacer(minLength: 0)
                botonModo
            }
            barraInferior
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .confirmationDialog("¿Reiniciar el escaneo?",
                            isPresented: $mostrarConfirmacionReinicio,
                            titleVisibility: .visible) {
            Button("Reiniciar", role: .destructive) { sesion.reiniciar() }
            Button("Seguir capturando", role: .cancel) { }
        } message: {
            Text("Se perderán los puntos y la malla capturados hasta ahora.")
        }
    }

    // MARK: - Barra superior

    private var barraSuperior: some View {
        HStack(alignment: .top, spacing: 10) {
            Button {
                if sesion.estado == .inactivo {
                    onCancelar()
                } else {
                    mostrarConfirmacionCancelar = true
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 42, height: 42)
                    .background(Circle().fill(Color.black.opacity(0.55)))
            }
            .accessibilityLabel("Salir del escaneo")

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(sesion.metrics.trackingOK ? JoseTheme.exito : JoseTheme.alerta)
                        .frame(width: 9, height: 9)
                    Text(sesion.mensaje.isEmpty ? textoEstado : sesion.mensaje)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                }
                Text(textoEstado)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.white.opacity(0.7))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(fondoPanel)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Estado del seguimiento")
            .accessibilityValue(sesion.mensaje.isEmpty ? textoEstado : sesion.mensaje)

            Spacer(minLength: 0)

            chipGPS
        }
        // El diálogo de salida vive aquí y no en el contenedor para no competir
        // con el de reinicio (SwiftUI sólo atiende una presentación por vista).
        .confirmationDialog("¿Salir sin guardar?",
                            isPresented: $mostrarConfirmacionCancelar,
                            titleVisibility: .visible) {
            Button("Salir y descartar", role: .destructive) { onCancelar() }
            Button("Seguir capturando", role: .cancel) { }
        } message: {
            Text("El escaneo en curso no se guardará en la galería.")
        }
    }

    /// Texto legible del estado de la sesión.
    private var textoEstado: String {
        switch sesion.estado {
        case .inactivo: return "Listo para iniciar"
        case .preparando: return "Preparando sensores…"
        case .capturando: return "Capturando"
        case .pausado: return "En pausa"
        case .finalizado: return "Escaneo finalizado"
        }
    }

    /// Chip con precisión GPS y rumbo del ancla.
    private var chipGPS: some View {
        VStack(alignment: .trailing, spacing: 3) {
            HStack(spacing: 5) {
                Image(systemName: "location.fill")
                    .font(.system(size: 11, weight: .bold))
                Text(textoPrecision)
                    .font(.system(size: 13, weight: .bold))
                    .monospacedDigit()
            }
            .foregroundColor(colorPrecision)

            HStack(spacing: 5) {
                Image(systemName: "safari")
                    .font(.system(size: 10, weight: .semibold))
                Text(textoRumbo)
                    .font(.system(size: 11, weight: .semibold))
                    .monospacedDigit()
            }
            .foregroundColor(.white.opacity(0.75))
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(fondoPanel)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Precisión del GPS")
        .accessibilityValue("\(textoPrecision), rumbo \(textoRumbo). \(geo.estado)")
    }

    private var textoPrecision: String {
        let p = geo.precisionMetros
        guard p.isFinite, p > 0 else { return "GPS —" }
        return "±" + ScanHUDView.decimal(p) + " m"
    }

    /// Verde por debajo de 5 m, ámbar por debajo de 15 m, rojo en el resto.
    private var colorPrecision: Color {
        let p = geo.precisionMetros
        guard p.isFinite, p > 0 else { return JoseTheme.peligro }
        if p < 5 { return JoseTheme.exito }
        if p < 15 { return JoseTheme.alerta }
        return JoseTheme.peligro
    }

    private var textoRumbo: String {
        guard let rumbo = geo.reference?.heading, rumbo.isFinite else { return "rumbo —" }
        let grados = Int(rumbo.rounded())
        return "\(grados)° \(ScanHUDView.puntoCardinal(rumbo))"
    }

    /// Punto cardinal abreviado en español para un rumbo en grados.
    public static func puntoCardinal(_ grados: Double) -> String {
        let nombres = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
        var g = grados.truncatingRemainder(dividingBy: 360)
        if g < 0 { g += 360 }
        let indice = Int((g / 45).rounded()) % 8
        return nombres[indice]
    }

    // MARK: - Aviso térmico

    @ViewBuilder
    private var avisoTermico: some View {
        if let aviso = sesion.metrics.thermalWarning, !aviso.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "thermometer.sun.fill")
                    .font(.system(size: 13, weight: .bold))
                Text(aviso)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .foregroundColor(JoseTheme.alerta)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fondoPanel)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Aviso térmico")
            .accessibilityValue(aviso)
        }
    }

    // MARK: - Chips de métricas

    private var chipsMetricas: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(icono: "circle.grid.3x3.fill",
                     valor: ScanHUDView.entero(sesion.metrics.pointCount),
                     titulo: "puntos",
                     etiquetaVoz: "Puntos capturados")
                chip(icono: "triangle.fill",
                     valor: ScanHUDView.entero(sesion.metrics.triangleCount),
                     titulo: "triángulos",
                     etiquetaVoz: "Triángulos de la malla")
                chip(icono: "square.dashed",
                     valor: ScanHUDView.decimal(sesion.metrics.coveredArea) + " m²",
                     titulo: "área",
                     etiquetaVoz: "Área cubierta en metros cuadrados")
                chip(icono: "speedometer",
                     valor: String(Int(sesion.metrics.fps.rounded())),
                     titulo: "fps",
                     etiquetaVoz: "Cuadros por segundo")
                chip(icono: "checkmark.seal.fill",
                     valor: "\(Int((sesion.metrics.highConfidenceRatio * 100).rounded()))%",
                     titulo: "confianza",
                     etiquetaVoz: "Porcentaje de puntos de alta confianza")
            }
            .padding(.vertical, 1)
        }
        .frame(height: 54)
    }

    private func chip(icono: String, valor: String, titulo: String, etiquetaVoz: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icono)
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(JoseTheme.acento)
            VStack(alignment: .leading, spacing: 0) {
                Text(valor)
                    .font(.system(size: 14, weight: .bold))
                    .monospacedDigit()
                    .foregroundColor(.white)
                Text(titulo)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.white.opacity(0.7))
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(fondoPanel)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(etiquetaVoz)
        .accessibilityValue(valor)
    }

    // MARK: - Botón de modo de visualización

    private var botonModo: some View {
        Button {
            modoVisualizacion = modoVisualizacion.siguiente
        } label: {
            VStack(spacing: 3) {
                Image(systemName: modoVisualizacion.iconoSistema)
                    .font(.system(size: 18, weight: .bold))
                Text(modoVisualizacion.nombre)
                    .font(.system(size: 9, weight: .semibold))
            }
            .foregroundColor(.white)
            .frame(width: 62, height: 58)
            .background(fondoPanel)
        }
        .accessibilityLabel("Modo de visualización")
        .accessibilityValue(modoVisualizacion.nombre)
        .accessibilityHint("Cambia entre alambre, sólido y sólo cámara")
    }

    // MARK: - Barra inferior

    private var barraInferior: some View {
        HStack(spacing: 14) {
            botonSecundario(icono: "arrow.counterclockwise",
                            titulo: "Reiniciar",
                            color: JoseTheme.alerta,
                            habilitado: sesion.estado != .inactivo) {
                mostrarConfirmacionReinicio = true
            }

            Spacer(minLength: 0)

            botonPrincipal

            Spacer(minLength: 0)

            botonSecundario(icono: "checkmark",
                            titulo: "Finalizar",
                            color: JoseTheme.exito,
                            habilitado: puedeFinalizar) {
                onFinalizar()
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.black.opacity(0.55))
        )
    }

    private var puedeFinalizar: Bool {
        (sesion.estado == .capturando || sesion.estado == .pausado) && sesion.metrics.pointCount > 0
    }

    private var botonPrincipal: some View {
        Button {
            switch sesion.estado {
            case .inactivo, .finalizado: sesion.iniciar()
            case .capturando: sesion.pausar()
            case .pausado: sesion.reanudar()
            case .preparando: break
            }
        } label: {
            ZStack {
                Circle()
                    .fill(colorBotonPrincipal)
                    .frame(width: 78, height: 78)
                    .shadow(color: Color.black.opacity(0.45), radius: 6, y: 2)
                Circle()
                    .stroke(Color.white.opacity(0.9), lineWidth: 3)
                    .frame(width: 88, height: 88)
                Image(systemName: iconoBotonPrincipal)
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(.white)
            }
            .frame(width: 92, height: 92)
        }
        .disabled(sesion.estado == .preparando)
        .accessibilityLabel(tituloBotonPrincipal)
        .accessibilityHint("Botón principal de captura")
    }

    private var tituloBotonPrincipal: String {
        switch sesion.estado {
        case .inactivo, .finalizado: return "Iniciar captura"
        case .preparando: return "Preparando sensores"
        case .capturando: return "Pausar captura"
        case .pausado: return "Reanudar captura"
        }
    }

    private var iconoBotonPrincipal: String {
        switch sesion.estado {
        case .inactivo, .finalizado: return "play.fill"
        case .preparando: return "hourglass"
        case .capturando: return "pause.fill"
        case .pausado: return "play.fill"
        }
    }

    private var colorBotonPrincipal: Color {
        switch sesion.estado {
        case .inactivo, .finalizado: return JoseTheme.acento
        case .preparando: return Color.gray
        case .capturando: return JoseTheme.peligro
        case .pausado: return JoseTheme.acento
        }
    }

    private func botonSecundario(icono: String,
                                 titulo: String,
                                 color: Color,
                                 habilitado: Bool,
                                 accion: @escaping () -> Void) -> some View {
        Button(action: accion) {
            VStack(spacing: 4) {
                Image(systemName: icono)
                    .font(.system(size: 22, weight: .bold))
                Text(titulo)
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundColor(habilitado ? .white : Color.white.opacity(0.35))
            .frame(width: 84, height: 66)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(habilitado ? color.opacity(0.9) : Color.white.opacity(0.10))
            )
        }
        .disabled(!habilitado)
        .accessibilityLabel(titulo)
    }

    // MARK: - Estilo común

    /// Fondo translúcido de alto contraste para los paneles de la HUD.
    private var fondoPanel: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(.ultraThinMaterial)
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.black.opacity(0.35))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.white.opacity(0.14), lineWidth: 1)
            )
    }
}
