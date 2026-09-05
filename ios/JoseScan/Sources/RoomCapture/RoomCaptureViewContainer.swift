//
//  RoomCaptureViewContainer.swift
//  JoseScan
//
//  Puente SwiftUI ↔ UIKit para `RoomCaptureView` (RoomPlan). La vista de
//  RoomPlan es dueña de su propia `RoomCaptureSession`; aquí sólo la
//  enganchamos al coordinador, la arrancamos y la detenemos.
//

import Foundation
import SwiftUI
import UIKit

#if canImport(RoomPlan)
import RoomPlan

@available(iOS 17.0, *)
public struct RoomCaptureViewContainer: UIViewRepresentable {

    /// Coordinador que recibe los delegados de la sesión y de la vista.
    @ObservedObject public var coordinador: RoomCaptureCoordinator

    public init(coordinador: RoomCaptureCoordinator) {
        self.coordinador = coordinador
    }

    public func makeUIView(context: Context) -> RoomCaptureView {
        let vista = RoomCaptureView(frame: .zero)
        vista.backgroundColor = .black
        // El coordinador guarda la referencia y se registra como delegado de la
        // vista y de la sesión antes de arrancar.
        coordinador.registrar(vista: vista)
        // Arranque explícito de la sesión de RoomPlan.
        vista.captureSession.run(configuration: RoomCaptureSession.Configuration())
        coordinador.marcarSesionIniciada()
        return vista
    }

    public func updateUIView(_ uiView: RoomCaptureView, context: Context) {
        // El estado se controla desde el coordinador; no hay nada que reflejar aquí.
    }

    /// Al desmontar la vista se para la sesión para liberar cámara y LiDAR.
    public static func dismantleUIView(_ uiView: RoomCaptureView, coordinator: ()) {
        uiView.captureSession.stop()
    }
}

#endif
