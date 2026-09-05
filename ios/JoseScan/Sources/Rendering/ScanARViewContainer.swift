//
//  ScanARViewContainer.swift
//  JoseScan
//
//  Envoltura SwiftUI de un `ARSCNView` que muestra en vivo la malla
//  reconstruida por el LiDAR.
//
//  IMPORTANTE: esta vista NO administra el ciclo de vida de ARKit. Reutiliza la
//  `ARSession` que expone `ScanSession` y nunca llama a `run(_:options:)` ni a
//  `pause()`; de eso se encarga exclusivamente `ScanSession`.
//

import ARKit
import Foundation
import SceneKit
import SwiftUI
import UIKit

// MARK: - Modo de visualización

/// Cómo se dibuja la malla reconstruida sobre la imagen de la cámara.
public enum ModoVisualizacion: String, CaseIterable, Identifiable {
    /// Alambre translúcido (por defecto): deja ver el terreno bajo la malla.
    case malla
    /// Superficie rellena semitransparente coloreada por clasificación.
    case solido
    /// Sin malla: sólo la cámara.
    case oculto

    public var id: String { rawValue }

    public var nombre: String {
        switch self {
        case .malla: return "Alambre"
        case .solido: return "Sólido"
        case .oculto: return "Sólo cámara"
        }
    }

    public var iconoSistema: String {
        switch self {
        case .malla: return "grid"
        case .solido: return "cube.fill"
        case .oculto: return "eye.slash"
        }
    }

    /// Siguiente modo al pulsar el botón de conmutación de la HUD.
    public var siguiente: ModoVisualizacion {
        switch self {
        case .malla: return .solido
        case .solido: return .oculto
        case .oculto: return .malla
        }
    }
}

// MARK: - Contenedor

/// Vista de cámara con la malla del escaneo superpuesta.
public struct ScanARViewContainer: UIViewRepresentable {

    /// Sesión de captura dueña del `ARSession`.
    @ObservedObject public var sesion: ScanSession
    /// Modo de dibujo, controlado desde la HUD.
    @Binding public var modoVisualizacion: ModoVisualizacion

    public init(sesion: ScanSession, modoVisualizacion: Binding<ModoVisualizacion>) {
        self.sesion = sesion
        self._modoVisualizacion = modoVisualizacion
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(modo: modoVisualizacion)
    }

    public func makeUIView(context: Context) -> ARSCNView {
        let vista = ARSCNView(frame: .zero)

        // Se adopta la sesión existente; jamás se arranca desde aquí.
        vista.session = sesion.session
        vista.delegate = context.coordinator

        vista.scene = SCNScene()
        vista.backgroundColor = UIColor.black
        vista.showsStatistics = false
        vista.debugOptions = []
        vista.automaticallyUpdatesLighting = true
        vista.autoenablesDefaultLighting = true
        vista.antialiasingMode = .multisampling2X
        vista.preferredFramesPerSecond = 30
        vista.rendersContinuously = false
        vista.isUserInteractionEnabled = false
        vista.isAccessibilityElement = true
        vista.accessibilityLabel = "Vista de cámara con la malla del escaneo"

        context.coordinator.vista = vista
        return vista
    }

    public func updateUIView(_ vista: ARSCNView, context: Context) {
        // El modo lo lee el coordinador tanto al construir nodos nuevos como al
        // repintar los existentes.
        if context.coordinator.modo != modoVisualizacion {
            context.coordinator.modo = modoVisualizacion
            context.coordinator.aplicarModoATodo()
        }

        // Sólo se fuerza el bucle de dibujado mientras se captura, para no
        // gastar batería cuando la sesión está pausada o finalizada.
        let capturando = (sesion.estado == .capturando)
        vista.rendersContinuously = capturando
        vista.preferredFramesPerSecond = capturando ? 30 : 15
    }

    public static func dismantleUIView(_ vista: ARSCNView, coordinator: Coordinator) {
        vista.delegate = nil
        vista.rendersContinuously = false
        vista.isPlaying = false
        for hijo in vista.scene.rootNode.childNodes {
            hijo.removeFromParentNode()
        }
        coordinator.limpiar()
    }

    // MARK: - Coordinador

    /// Traduce cada `ARMeshAnchor` a geometría de SceneKit.
    public final class Coordinator: NSObject, ARSCNViewDelegate {

        /// Vista asociada (débil: la posee SwiftUI).
        fileprivate weak var vista: ARSCNView?

        /// Modo de dibujo vigente. Se lee desde el hilo de render, por eso el
        /// acceso va protegido por `candado`.
        fileprivate var modo: ModoVisualizacion {
            get {
                candado.lock()
                let valor = modoInterno
                candado.unlock()
                return valor
            }
            set {
                candado.lock()
                modoInterno = newValue
                candado.unlock()
            }
        }

        private var modoInterno: ModoVisualizacion
        private let candado = NSRecursiveLock()
        /// Nodos de malla vivos, indexados por el identificador del ancla.
        private var nodos: [UUID: SCNNode] = [:]

        fileprivate init(modo: ModoVisualizacion) {
            self.modoInterno = modo
            super.init()
        }

        // MARK: Delegado de ARSCNView

        public func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
            // Sólo se atienden las anclas de malla; el resto las maneja ARKit.
            guard anchor is ARMeshAnchor else { return nil }
            // Nodo contenedor vacío: ARSCNView le aplica la transformada del ancla.
            return SCNNode()
        }

        public func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
            guard let ancla = anchor as? ARMeshAnchor else { return }
            reconstruir(node, ancla: ancla)
        }

        public func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
            guard let ancla = anchor as? ARMeshAnchor else { return }
            reconstruir(node, ancla: ancla)
        }

        public func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
            candado.lock()
            nodos.removeValue(forKey: anchor.identifier)
            candado.unlock()
        }

        // MARK: Construcción de nodos

        /// Rehace por completo el nodo hijo de un ancla. ARKit refresca cada
        /// ancla pocas veces por segundo, así que reconstruir es más simple y
        /// seguro que mutar los búferes en caliente.
        private func reconstruir(_ contenedor: SCNNode, ancla: ARMeshAnchor) {
            guard let geometria = Coordinator.geometria(desde: ancla.geometry) else { return }

            let clase = Coordinator.clasificacionDominante(ancla.geometry)
            geometria.materials = [Coordinator.material(para: clase, modo: modo)]

            let nodo = SCNNode(geometry: geometria)
            nodo.name = "malla-" + ancla.identifier.uuidString
            nodo.castsShadow = false
            nodo.isHidden = (modo == .oculto)
            nodo.renderingOrder = 10

            SCNTransaction.begin()
            SCNTransaction.animationDuration = 0
            for hijo in contenedor.childNodes {
                hijo.removeFromParentNode()
            }
            contenedor.addChildNode(nodo)
            SCNTransaction.commit()

            candado.lock()
            nodos[ancla.identifier] = nodo
            candado.unlock()
        }

        /// Reaplica el modo vigente a todos los nodos ya construidos.
        fileprivate func aplicarModoATodo() {
            let modoActual = modo
            candado.lock()
            let vivos = Array(nodos.values)
            candado.unlock()

            SCNTransaction.begin()
            SCNTransaction.animationDuration = 0.15
            for nodo in vivos {
                nodo.isHidden = (modoActual == .oculto)
                guard let material = nodo.geometry?.firstMaterial else { continue }
                Coordinator.configurar(material, modo: modoActual)
            }
            SCNTransaction.commit()
        }

        /// Suelta las referencias al desmontar la vista.
        fileprivate func limpiar() {
            candado.lock()
            nodos.removeAll()
            candado.unlock()
            vista = nil
        }

        // MARK: Conversión ARMeshGeometry → SCNGeometry

        /// Crea la geometría de SceneKit a partir de los búferes Metal de ARKit.
        /// Devuelve `nil` si el ancla todavía no tiene caras utilizables.
        fileprivate static func geometria(desde malla: ARMeshGeometry) -> SCNGeometry? {
            let vertices = malla.vertices
            let normales = malla.normals
            let caras = malla.faces

            guard vertices.count > 0, caras.count > 0, caras.indexCountPerPrimitive == 3 else {
                return nil
            }

            let fuenteVertices = SCNGeometrySource(buffer: vertices.buffer,
                                                   vertexFormat: vertices.format,
                                                   semantic: .vertex,
                                                   vertexCount: vertices.count,
                                                   dataOffset: vertices.offset,
                                                   dataStride: vertices.stride)

            var fuentes: [SCNGeometrySource] = [fuenteVertices]
            if normales.count == vertices.count {
                let fuenteNormales = SCNGeometrySource(buffer: normales.buffer,
                                                       vertexFormat: normales.format,
                                                       semantic: .normal,
                                                       vertexCount: normales.count,
                                                       dataOffset: normales.offset,
                                                       dataStride: normales.stride)
                fuentes.append(fuenteNormales)
            }

            // Se copian los índices: el búfer de ARKit puede recircularse.
            let bytesIndices = caras.count * caras.indexCountPerPrimitive * caras.bytesPerIndex
            guard bytesIndices > 0, bytesIndices <= caras.buffer.length else { return nil }
            let datos = Data(bytes: caras.buffer.contents(), count: bytesIndices)

            let elemento = SCNGeometryElement(data: datos,
                                              primitiveType: .triangles,
                                              primitiveCount: caras.count,
                                              bytesPerIndex: caras.bytesPerIndex)

            return SCNGeometry(sources: fuentes, elements: [elemento])
        }

        /// Clasificación semántica mayoritaria del ancla.
        ///
        /// ARKit clasifica cara por cara, pero pintar cada triángulo por separado
        /// obligaría a partir la geometría en decenas de elementos por ancla. Como
        /// las anclas de ARKit son parches pequeños y bastante homogéneos, se usa
        /// la clase dominante para colorear todo el parche.
        fileprivate static func clasificacionDominante(_ malla: ARMeshGeometry) -> ScanFaceClass {
            guard let fuente = malla.classification else { return .none }
            let total = malla.faces.count
            guard total > 0 else { return .none }

            var histograma = [Int](repeating: 0, count: ScanFaceClass.allCases.count)
            let puntero = fuente.buffer.contents()
            let longitud = fuente.buffer.length
            var indice = 0
            while indice < total {
                let desplazamiento = fuente.offset + fuente.stride * indice
                if desplazamiento + MemoryLayout<UInt8>.size > longitud { break }
                let bruto = puntero.load(fromByteOffset: desplazamiento, as: UInt8.self)
                if Int(bruto) < histograma.count {
                    histograma[Int(bruto)] += 1
                }
                indice += 1
            }

            var mejorIndice = 0
            var mejorConteo = 0
            for (i, conteo) in histograma.enumerated() where conteo > mejorConteo {
                mejorConteo = conteo
                mejorIndice = i
            }
            guard mejorConteo > 0 else { return .none }
            return ScanFaceClass(rawValue: UInt8(mejorIndice)) ?? .none
        }

        // MARK: Materiales

        /// Color de dibujo asociado a cada clasificación semántica.
        fileprivate static func color(para clase: ScanFaceClass) -> UIColor {
            switch clase {
            case .none:    return UIColor(red: 0.94, green: 0.95, blue: 0.97, alpha: 1.0)
            case .wall:    return UIColor(red: 0.36, green: 0.72, blue: 1.00, alpha: 1.0)
            case .floor:   return UIColor(red: 0.34, green: 0.90, blue: 0.55, alpha: 1.0)
            case .ceiling: return UIColor(red: 0.80, green: 0.68, blue: 1.00, alpha: 1.0)
            case .table:   return UIColor(red: 1.00, green: 0.80, blue: 0.33, alpha: 1.0)
            case .seat:    return UIColor(red: 1.00, green: 0.56, blue: 0.33, alpha: 1.0)
            case .window:  return UIColor(red: 0.45, green: 0.95, blue: 0.95, alpha: 1.0)
            case .door:    return UIColor(red: 1.00, green: 0.45, blue: 0.66, alpha: 1.0)
            }
        }

        fileprivate static func material(para clase: ScanFaceClass, modo: ModoVisualizacion) -> SCNMaterial {
            let material = SCNMaterial()
            material.diffuse.contents = color(para: clase)
            material.emission.contents = color(para: clase).withAlphaComponent(0.35)
            material.isDoubleSided = true
            material.lightingModel = .constant
            material.writesToDepthBuffer = false
            material.readsFromDepthBuffer = true
            configurar(material, modo: modo)
            return material
        }

        /// Ajusta relleno y transparencia según el modo, conservando el color.
        fileprivate static func configurar(_ material: SCNMaterial, modo: ModoVisualizacion) {
            switch modo {
            case .malla, .oculto:
                material.fillMode = .lines
                material.transparency = 0.85
            case .solido:
                material.fillMode = .fill
                material.transparency = 0.45
            }
        }
    }
}
