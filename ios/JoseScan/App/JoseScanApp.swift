//
//  JoseScanApp.swift
//  JoseScan
//
//  Punto de entrada de la app. Crea una sola vez las tres dependencias
//  globales y las inyecta en el árbol de vistas mediante `environmentObject`:
//
//    · ScanStore      — biblioteca de escaneos en disco (Sources/Library)
//    · AppSettings    — preferencias del usuario (Sources/Library)
//    · Georeferencer  — GPS + rumbo + conversión MAGNA-SIRGAS (Sources/Geo)
//
//  La interfaz siempre se muestra en modo oscuro: se usa sobre la cámara y en
//  campo, donde el tema claro deslumbra y come batería.
//

import SwiftUI

@main
@MainActor
struct JoseScanApp: App {

    /// Biblioteca de escaneos guardados en el contenedor de la app.
    @StateObject private var almacen = ScanStore()

    /// Preferencias persistentes (unidades, calidad, proyecto por defecto…).
    @StateObject private var ajustes = AppSettings()

    /// Ancla geodésica: ubicación, rumbo y coordenadas MAGNA-SIRGAS.
    @StateObject private var georreferenciador = Georeferencer()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(almacen)
                .environmentObject(ajustes)
                .environmentObject(georreferenciador)
                .tint(JoseTheme.acento)
                .preferredColorScheme(.dark)
        }
    }
}
