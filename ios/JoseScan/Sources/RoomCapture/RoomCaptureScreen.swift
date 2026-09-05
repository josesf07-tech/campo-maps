//
//  RoomCaptureScreen.swift
//  JoseScan
//
//  Pestaña "Interiores": captura de planos de habitaciones con RoomPlan.
//  Es complementaria al escaneo libre con LiDAR de la pestaña "Escanear".
//
//  La disponibilidad se comprueba en tres niveles:
//    1. RoomPlan compilado + iOS 17 + hardware compatible → captura completa.
//    2. RoomPlan compilado pero hardware sin soporte      → aviso.
//    3. Sistema anterior a iOS 17                          → aviso de actualización.
//

import Foundation
import SwiftUI

#if canImport(RoomPlan)
import RoomPlan
#endif

// MARK: - Pantalla principal

public struct RoomCaptureScreen: View {

    public init() {}

    public var body: some View {
        contenido
    }

    @ViewBuilder
    private var contenido: some View {
        #if canImport(RoomPlan)
        contenidoConRoomPlan
        #else
        RoomAvisoView(icono: "questionmark.square.dashed",
                      color: JoseTheme.textoSecundario,
                      titulo: "Módulo de interiores no incluido",
                      mensaje: "Esta versión de JoseScan se compiló sin RoomPlan. Usa la pestaña Escanear para capturar con LiDAR libre.")
        #endif
    }

    #if canImport(RoomPlan)
    @ViewBuilder
    private var contenidoConRoomPlan: some View {
        if #available(iOS 17.0, *) {
            if RoomCaptureSession.isSupported {
                RoomCaptureFlowView()
            } else {
                RoomAvisoView(icono: "exclamationmark.triangle.fill",
                              color: JoseTheme.alerta,
                              titulo: "Escaneo de interiores no disponible",
                              mensaje: "Este dispositivo no admite el escaneo de interiores; usa la pestaña Escanear para capturar con LiDAR libre.")
            }
        } else {
            RoomAvisoView(icono: "arrow.down.circle.fill",
                          color: JoseTheme.acento,
                          titulo: "Actualiza tu iPhone",
                          mensaje: "El escaneo de interiores necesita iOS 17 o superior. Actualízalo en Ajustes › General › Actualización de software y vuelve a esta pestaña.")
        }
    }
    #endif
}

// MARK: - Aviso reutilizable

/// Pantalla explicativa con icono, título y texto. Nunca deja la vista vacía.
struct RoomAvisoView: View {
    let icono: String
    let color: Color
    let titulo: String
    let mensaje: String

    var body: some View {
        ZStack {
            JoseTheme.fondo.ignoresSafeArea()
            VStack(spacing: 18) {
                Image(systemName: icono)
                    .font(.system(size: 64, weight: .regular))
                    .foregroundStyle(color)
                Text(titulo)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(JoseTheme.textoPrimario)
                    .multilineTextAlignment(.center)
                Text(mensaje)
                    .font(.callout)
                    .foregroundStyle(JoseTheme.textoSecundario)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 32)
        }
    }
}

// MARK: - Flujo de captura (iOS 17 + RoomPlan)

#if canImport(RoomPlan)

@available(iOS 17.0, *)
@MainActor
struct RoomCaptureFlowView: View {

    @EnvironmentObject private var store: ScanStore
    @StateObject private var coordinador = RoomCaptureCoordinator()

    var body: some View {
        ZStack(alignment: .top) {
            JoseTheme.fondo.ignoresSafeArea()

            RoomCaptureViewContainer(coordinador: coordinador)
                .ignoresSafeArea()

            panelGuia
                .padding(.horizontal, 16)
                .padding(.top, 12)

            VStack {
                Spacer()
                controles
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
            }
        }
        .sheet(isPresented: bindingResumen) {
            if let sala = coordinador.resultado {
                RoomSummaryView(habitacion: sala,
                                duracionSegundos: coordinador.duracionSegundos,
                                store: store)
            }
        }
        .onDisappear {
            coordinador.detener()
        }
    }

    // MARK: HUD

    private var panelGuia: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: coordinador.procesando ? "gearshape.2" : "viewfinder")
                    .foregroundStyle(JoseTheme.acento)
                Text(coordinador.estado)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(JoseTheme.textoPrimario)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }

            HStack(spacing: 16) {
                etiqueta(icono: "square.split.bottomrightquarter",
                         texto: "\(coordinador.superficiesDetectadas) superficies")
                etiqueta(icono: "cube", texto: "\(coordinador.objetosDetectados) objetos")
                Spacer(minLength: 0)
            }

            if let error = coordinador.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(JoseTheme.peligro)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(JoseTheme.superficie.opacity(0.92), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func etiqueta(icono: String, texto: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icono)
            Text(texto)
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(JoseTheme.textoSecundario)
    }

    // MARK: Controles

    private var controles: some View {
        HStack(spacing: 12) {
            Button {
                coordinador.reiniciar()
            } label: {
                Label("Reiniciar", systemImage: "arrow.counterclockwise")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .background(JoseTheme.superficie, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .foregroundStyle(JoseTheme.textoPrimario)

            Button {
                coordinador.detener()
            } label: {
                Label(coordinador.procesando ? "Procesando…" : "Terminar",
                      systemImage: coordinador.procesando ? "hourglass" : "checkmark.circle.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .background(JoseTheme.exito, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .foregroundStyle(JoseTheme.fondo)
            .disabled(!coordinador.capturando)
            .opacity(coordinador.capturando ? 1 : 0.55)
        }
    }

    // MARK: Presentación del resumen

    private var bindingResumen: Binding<Bool> {
        Binding(get: {
            coordinador.resultado != nil
        }, set: { visible in
            if !visible {
                coordinador.limpiarResultado()
            }
        })
    }
}

#endif
