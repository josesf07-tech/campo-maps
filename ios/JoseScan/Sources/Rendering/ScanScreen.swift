//
//  ScanScreen.swift
//  JoseScan
//
//  Pantalla principal de captura: cámara con la malla en vivo, HUD de control y
//  hoja de resumen al finalizar. Si el equipo no tiene LiDAR muestra una
//  explicación en lugar de la vista de realidad aumentada.
//

import Foundation
import SwiftUI
import UIKit

public struct ScanScreen: View {

    /// Sesión de captura; vive mientras la pantalla esté en pantalla.
    @StateObject private var sesion = ScanSession()

    /// Servicios compartidos inyectados por la app.
    @EnvironmentObject private var geo: Georeferencer
    @EnvironmentObject private var store: ScanStore

    @Environment(\.dismiss) private var cerrar

    @State private var modoVisualizacion: ModoVisualizacion = .malla
    @State private var documento: ScanDocument?
    @State private var miniatura: UIImage?
    @State private var mostrarResultado = false

    public init() { }

    // MARK: - Cuerpo

    public var body: some View {
        ZStack {
            JoseTheme.fondo
                .ignoresSafeArea()

            if ScanSession.lidarDisponible {
                contenidoAR
            } else {
                vistaSinLiDAR
            }
        }
        .task {
            geo.iniciar()
        }
        .onDisappear {
            geo.detener()
            UIApplication.shared.isIdleTimerDisabled = false
            if sesion.estado == .capturando {
                sesion.pausar()
            }
        }
        .onChange(of: sesion.estado) { nuevo in
            // La pantalla se mantiene encendida sólo mientras se captura.
            UIApplication.shared.isIdleTimerDisabled = (nuevo == .capturando || nuevo == .preparando)
        }
        .sheet(isPresented: $mostrarResultado, onDismiss: limpiarResultado) {
            hojaResultado
        }
    }

    // MARK: - Escaneo con LiDAR

    private var contenidoAR: some View {
        ZStack {
            ScanARViewContainer(sesion: sesion, modoVisualizacion: $modoVisualizacion)
                .ignoresSafeArea()

            ScanHUDView(sesion: sesion,
                        geo: geo,
                        modoVisualizacion: $modoVisualizacion,
                        onFinalizar: finalizar,
                        onCancelar: cancelar)
        }
        .statusBarHidden(true)
    }

    @ViewBuilder
    private var hojaResultado: some View {
        if let doc = documento {
            ScanResultSheet(documento: doc,
                            miniatura: miniatura,
                            store: store,
                            onGuardado: { _ in mostrarResultado = false },
                            onDescartar: { mostrarResultado = false })
                .environmentObject(store)
                .environmentObject(geo)
        } else {
            // Salvaguarda: nunca debería presentarse la hoja sin documento.
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 34))
                    .foregroundColor(JoseTheme.alerta)
                Text("No hay ningún escaneo para mostrar.")
                    .font(.headline)
                Button("Cerrar") { mostrarResultado = false }
                    .buttonStyle(.borderedProminent)
            }
            .padding()
        }
    }

    // MARK: - Equipo sin LiDAR

    private var vistaSinLiDAR: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "cube.transparent")
                    .font(.system(size: 62, weight: .light))
                    .foregroundColor(JoseTheme.acento)
                    .padding(.top, 40)
                    .accessibilityHidden(true)

                Text("Sin sensor LiDAR")
                    .font(.title2.bold())
                    .foregroundColor(JoseTheme.textoPrimario)

                Text("Este equipo no tiene escáner LiDAR o ARKit no está disponible, así que no se puede capturar geometría en tres dimensiones.")
                    .font(.body)
                    .foregroundColor(JoseTheme.textoSecundario)
                    .multilineTextAlignment(.center)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Equipos con LiDAR")
                        .font(.headline)
                        .foregroundColor(JoseTheme.textoPrimario)
                    Text("• iPhone 12 Pro y Pro Max, y todos los modelos Pro posteriores (13 Pro, 14 Pro, 15 Pro, 16 Pro y sus versiones Max).\n• iPad Pro de 11\" y 12,9\" desde la generación de 2020.")
                        .font(.subheadline)
                        .foregroundColor(JoseTheme.textoSecundario)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(JoseTheme.superficie)
                )

                Label("Puedes seguir usando la galería para abrir, medir y exportar escaneos hechos con otro equipo.",
                      systemImage: "photo.on.rectangle.angled")
                    .font(.subheadline)
                    .foregroundColor(JoseTheme.textoSecundario)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(JoseTheme.superficie)
                    )

                Spacer(minLength: 20)
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 30)
        }
        .accessibilityLabel("Este dispositivo no tiene sensor LiDAR")
    }

    // MARK: - Acciones

    /// Ancla la georreferencia, toma la miniatura y cierra la captura.
    private func finalizar() {
        // El orden importa: la miniatura se toma con la sesión todavía viva.
        sesion.anclarGeo(geo.anclar())
        miniatura = sesion.capturarMiniatura()

        let doc = sesion.detener()
        doc.refreshMetadata()
        documento = doc

        UIApplication.shared.isIdleTimerDisabled = false
        mostrarResultado = true
    }

    /// Abandona la captura sin guardar.
    private func cancelar() {
        if sesion.estado != .inactivo {
            sesion.reiniciar()
        }
        UIApplication.shared.isIdleTimerDisabled = false
        cerrar()
    }

    /// Limpia el estado tras cerrar la hoja de resumen (se guarde o no).
    private func limpiarResultado() {
        documento = nil
        miniatura = nil
        sesion.reiniciar()
    }
}
