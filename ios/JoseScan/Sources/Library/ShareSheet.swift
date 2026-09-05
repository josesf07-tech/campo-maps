//
//  ShareSheet.swift
//  JoseScan
//
//  Envoltura de `UIActivityViewController` para SwiftUI. Se usa para compartir
//  los archivos exportados (PLY, OBJ, GeoJSON, paquete .josescan…) con
//  AirDrop, Archivos, Correo o la PWA JoseMaps.
//
//  En iPad el controlador se presenta como popover: si no se le asigna un
//  `sourceView` la app termina cayéndose, así que aquí se ancla siempre a la
//  vista del propio controlador.
//

import SwiftUI
import UIKit

@MainActor
public struct ShareSheet: UIViewControllerRepresentable {

    /// Elementos a compartir: `URL`, `String`, `UIImage`…
    public let items: [Any]

    /// Actividades que no deben ofrecerse (por ejemplo `.assignToContact`).
    public let excluidas: [UIActivity.ActivityType]?

    /// Se llama al cerrar la hoja: `true` si el usuario completó la acción.
    public let alCompletar: ((Bool) -> Void)?

    public init(items: [Any],
                excluidas: [UIActivity.ActivityType]? = nil,
                alCompletar: ((Bool) -> Void)? = nil) {
        self.items = items
        self.excluidas = excluidas
        self.alCompletar = alCompletar
    }

    public func makeUIViewController(context: Context) -> UIActivityViewController {
        let controlador = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controlador.excludedActivityTypes = excluidas
        let terminado = alCompletar
        controlador.completionWithItemsHandler = { _, completado, _, _ in
            terminado?(completado)
        }
        // iPad: popover sin flecha, anclado al centro de la vista presentadora.
        if let popover = controlador.popoverPresentationController {
            popover.permittedArrowDirections = []
            popover.sourceView = controlador.view
            popover.sourceRect = ShareSheet.rectanguloCentral(de: controlador.view)
        }
        return controlador
    }

    public func updateUIViewController(_ controlador: UIActivityViewController, context: Context) {
        // La vista sólo tiene tamaño real después del primer diseño; se vuelve a
        // anclar el popover para que quede centrado y no descuadrado.
        guard let popover = controlador.popoverPresentationController else { return }
        if popover.sourceView == nil {
            popover.sourceView = controlador.view
        }
        popover.sourceRect = ShareSheet.rectanguloCentral(de: popover.sourceView ?? controlador.view)
    }

    private static func rectanguloCentral(de vista: UIView?) -> CGRect {
        let limites = vista?.bounds ?? CGRect(x: 0, y: 0, width: 320, height: 480)
        return CGRect(x: limites.midX, y: limites.midY, width: 0, height: 0)
    }
}
