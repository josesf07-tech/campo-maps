//
//  RootView.swift
//  JoseScan
//
//  Contenedor principal: cuatro pestañas (Escanear, Interiores, Escaneos y
//  Ajustes). Si el dispositivo no tiene sensor LiDAR, las dos pestañas de
//  captura siguen visibles pero muestran una explicación en lugar de la
//  cámara, y un aviso permanente encabeza la pantalla.
//

import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

#if canImport(ARKit)
import ARKit
#endif

/// Pestañas de la barra inferior.
private enum Pestana: Hashable {
    case escanear, interiores, escaneos, ajustes
}

@MainActor
struct RootView: View {

    /// Verdadero si ARKit puede reconstruir la escena con malla (requiere LiDAR).
    private let hayLiDAR: Bool

    @State private var seleccion: Pestana

    init() {
        let soporta = RootView.dispositivoSoportaLiDAR()
        self.hayLiDAR = soporta
        // Sin LiDAR se arranca en la biblioteca, que sí es utilizable.
        _seleccion = State(initialValue: soporta ? Pestana.escanear : Pestana.escaneos)
        RootView.configurarApariencia()
    }

    // MARK: - Cuerpo

    var body: some View {
        VStack(spacing: 0) {
            if !hayLiDAR {
                AvisoSinLiDAR()
            }

            TabView(selection: $seleccion) {
                contenidoCaptura(
                    titulo: "Escanear",
                    icono: "viewfinder",
                    detalle: "El escaneo del terreno con LiDAR necesita un iPhone Pro o un iPad Pro con sensor LiDAR."
                ) {
                    ScanScreen()
                }
                .tabItem { Label("Escanear", systemImage: "viewfinder") }
                .tag(Pestana.escanear)

                contenidoCaptura(
                    titulo: "Interiores",
                    icono: "house",
                    detalle: "El levantamiento de interiores usa RoomPlan, que también depende del sensor LiDAR."
                ) {
                    RoomCaptureScreen()
                }
                .tabItem { Label("Interiores", systemImage: "house") }
                .tag(Pestana.interiores)

                ScanLibraryView()
                    .tabItem { Label("Escaneos", systemImage: "square.stack.3d.up") }
                    .tag(Pestana.escaneos)

                SettingsView()
                    .tabItem { Label("Ajustes", systemImage: "gearshape") }
                    .tag(Pestana.ajustes)
            }
            .tint(JoseTheme.acento)
        }
        .background(JoseTheme.fondo.ignoresSafeArea())
    }

    /// Devuelve la pantalla de captura real cuando hay LiDAR, o el sustituto
    /// deshabilitado cuando el dispositivo no puede capturar.
    @ViewBuilder
    private func contenidoCaptura<Contenido: View>(titulo: String,
                                                   icono: String,
                                                   detalle: String,
                                                   @ViewBuilder vista: () -> Contenido) -> some View {
        if hayLiDAR {
            vista()
        } else {
            PantallaSinLiDAR(titulo: titulo, icono: icono, detalle: detalle)
        }
    }

    // MARK: - Capacidades del dispositivo

    /// Comprueba si el equipo admite reconstrucción de escena con malla.
    /// Se consulta una sola vez al construir la vista: no cambia en ejecución.
    static func dispositivoSoportaLiDAR() -> Bool {
        #if canImport(ARKit)
        guard ARWorldTrackingConfiguration.isSupported else { return false }
        return ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        #else
        return false
        #endif
    }

    // MARK: - Apariencia de la barra de pestañas

    private static var aparienciaLista = false

    /// Deja la barra inferior opaca y en el color de superficie de la marca,
    /// para que no cambie de tono al desplazar el contenido.
    private static func configurarApariencia() {
        #if canImport(UIKit)
        guard !aparienciaLista else { return }
        aparienciaLista = true

        let apariencia = UITabBarAppearance()
        apariencia.configureWithOpaqueBackground()
        apariencia.backgroundColor = UIColor(JoseTheme.superficie)
        apariencia.shadowColor = UIColor(JoseTheme.borde)
        UITabBar.appearance().standardAppearance = apariencia
        UITabBar.appearance().scrollEdgeAppearance = apariencia
        #endif
    }
}

// MARK: - Aviso permanente

/// Franja fija que explica por qué la captura está bloqueada en este equipo.
private struct AvisoSinLiDAR: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(JoseTheme.alerta)

            VStack(alignment: .leading, spacing: 3) {
                Text("Este dispositivo no tiene sensor LiDAR")
                    .font(JoseTheme.tipoEncabezado)
                    .foregroundColor(JoseTheme.textoPrimario)
                Text("Sólo están disponibles Escaneos y Ajustes: puedes abrir, revisar y exportar escaneos capturados en otro equipo.")
                    .font(JoseTheme.tipoPie)
                    .foregroundColor(JoseTheme.textoSecundario)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JoseTheme.superficie)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(JoseTheme.alerta.opacity(0.5))
                .frame(height: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Sustituto de las pestañas de captura

/// Se muestra en lugar de la cámara cuando no hay LiDAR. Todo el contenido va
/// atenuado y deshabilitado para dejar claro que la pestaña no es utilizable.
private struct PantallaSinLiDAR: View {
    let titulo: String
    let icono: String
    let detalle: String

    var body: some View {
        VStack(spacing: 20) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: icono)
                    .font(.system(size: 68, weight: .light))
                    .foregroundColor(JoseTheme.textoTerciario)
                Image(systemName: "lock.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(JoseTheme.alerta)
                    .offset(x: 12, y: 8)
            }
            .padding(.bottom, 4)

            Text("\(titulo) no disponible")
                .font(JoseTheme.tipoTitulo)
                .foregroundColor(JoseTheme.textoSecundario)
                .multilineTextAlignment(.center)

            Text(detalle)
                .font(JoseTheme.tipoCuerpo)
                .foregroundColor(JoseTheme.textoTerciario)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Text("Abre la pestaña Escaneos para consultar y exportar los escaneos guardados.")
                .font(JoseTheme.tipoPie)
                .foregroundColor(JoseTheme.textoTerciario)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .tarjetaJoseScan()
        }
        .padding(24)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JoseTheme.degradadoFondo.ignoresSafeArea())
        .opacity(0.75)
        .disabled(true)
    }
}
