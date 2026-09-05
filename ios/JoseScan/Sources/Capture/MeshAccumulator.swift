//
//  MeshAccumulator.swift
//  JoseScan
//
//  Mantiene vivos los ARMeshAnchor de la reconstrucción de escena y produce,
//  bajo demanda, una única ScanMesh en coordenadas mundo.
//
//  ARKit entrega cada trozo de malla en el marco local de su anchor; aquí se
//  aplica `anchor.transform` a vértices y normales y se desplazan los índices
//  por el offset acumulado de vértices.
//

#if canImport(ARKit)

import Foundation
import ARKit
import Metal
import simd

public final class MeshAccumulator {

    /// Conteos cacheados por anchor para no recorrer la geometría cada vez que
    /// la HUD pide métricas (hasta 4 veces por segundo).
    private struct Resumen {
        var vertices: Int
        var triangulos: Int
        var area: Double
    }

    private var anclas: [UUID: ARMeshAnchor] = [:]
    private var resumenes: [UUID: Resumen] = [:]

    /// Marco declarado en la malla resultante.
    public var frame: ScanCoordinateFrame = .arkit

    public init() {}

    // MARK: - Ciclo de vida de los anchors

    /// Registra o reemplaza un anchor de malla.
    public func actualizar(_ anchor: ARMeshAnchor) {
        anclas[anchor.identifier] = anchor
        resumenes[anchor.identifier] = MeshAccumulator.resumir(anchor)
    }

    /// Olvida un anchor que ARKit ya eliminó o fusionó.
    public func eliminar(_ anchor: ARMeshAnchor) {
        anclas.removeValue(forKey: anchor.identifier)
        resumenes.removeValue(forKey: anchor.identifier)
    }

    /// Olvida un anchor por identificador.
    public func eliminar(identificador: UUID) {
        anclas.removeValue(forKey: identificador)
        resumenes.removeValue(forKey: identificador)
    }

    /// Descarta toda la malla acumulada.
    public func reiniciar() {
        anclas.removeAll(keepingCapacity: false)
        resumenes.removeAll(keepingCapacity: false)
    }

    // MARK: - Métricas baratas

    public var conteoAnclas: Int { anclas.count }

    public var conteoTriangulos: Int {
        var total = 0
        for (_, r) in resumenes { total += r.triangulos }
        return total
    }

    public var conteoVertices: Int {
        var total = 0
        for (_, r) in resumenes { total += r.vertices }
        return total
    }

    /// Área reconstruida en m², sumando la de cada anchor (las transformadas de
    /// ARKit son rígidas, así que el área local coincide con la del mundo).
    public var areaSuperficie: Double {
        var total = 0.0
        for (_, r) in resumenes { total += r.area }
        return total
    }

    public var isEmpty: Bool { anclas.isEmpty }

    // MARK: - Malla unificada

    /// Construye la malla completa en coordenadas mundo.
    public func malla() -> ScanMesh {
        var salida = ScanMesh(frame: frame)
        guard !anclas.isEmpty else { return salida }

        salida.vertices.reserveCapacity(conteoVertices)
        salida.normals.reserveCapacity(conteoVertices)
        salida.indices.reserveCapacity(conteoTriangulos * 3)
        salida.classifications.reserveCapacity(conteoTriangulos)

        var hayClasificacion = false

        for (_, anchor) in anclas {
            let geometria = anchor.geometry
            let fuenteVertices = geometria.vertices
            let caras = geometria.faces
            guard fuenteVertices.format == .float3,
                  fuenteVertices.count > 0,
                  caras.indexCountPerPrimitive == 3,
                  caras.bytesPerIndex == 2 || caras.bytesPerIndex == 4 else { continue }

            let transformada = anchor.transform
            let base = UInt32(salida.vertices.count)
            let numVertices = fuenteVertices.count

            // 1) Vértices llevados a mundo (punto homogéneo, w = 1).
            let contenidoVertices = fuenteVertices.buffer.contents()
            for i in 0..<numVertices {
                let local = MeshAccumulator.vector3(contenidoVertices,
                                                    fuenteVertices.offset,
                                                    fuenteVertices.stride,
                                                    i)
                let mundo = transformada * SIMD4<Float>(local.x, local.y, local.z, 1)
                salida.vertices.append(SIMD3<Float>(mundo.x, mundo.y, mundo.z))
            }

            // 2) Normales rotadas (vector, w = 0: sin traslación).
            let fuenteNormales = geometria.normals
            let normalesUsables = fuenteNormales.format == .float3
                && fuenteNormales.count == numVertices
            if normalesUsables {
                let contenidoNormales = fuenteNormales.buffer.contents()
                for i in 0..<numVertices {
                    let local = MeshAccumulator.vector3(contenidoNormales,
                                                        fuenteNormales.offset,
                                                        fuenteNormales.stride,
                                                        i)
                    let mundo = transformada * SIMD4<Float>(local.x, local.y, local.z, 0)
                    var n = SIMD3<Float>(mundo.x, mundo.y, mundo.z)
                    let largo = simd_length(n)
                    n = largo > 1e-6 ? n / largo : SIMD3<Float>(0, 1, 0)
                    salida.normals.append(n)
                }
            } else {
                // Se rellenan en blanco y se calculan desde las caras más abajo.
                for _ in 0..<numVertices {
                    salida.normals.append(SIMD3<Float>(repeating: 0))
                }
            }

            // 3) Caras, desplazadas por el offset de vértices acumulado.
            let contenidoCaras = caras.buffer.contents()
            let fuenteClases = geometria.classification
            let clasesUsables = fuenteClases != nil && fuenteClases!.count == caras.count
            var contenidoClases: UnsafeMutableRawPointer?
            if clasesUsables, let fuente = fuenteClases {
                contenidoClases = fuente.buffer.contents()
            }

            for f in 0..<caras.count {
                let i0 = MeshAccumulator.indice(contenidoCaras, caras.bytesPerIndex, f * 3)
                let i1 = MeshAccumulator.indice(contenidoCaras, caras.bytesPerIndex, f * 3 + 1)
                let i2 = MeshAccumulator.indice(contenidoCaras, caras.bytesPerIndex, f * 3 + 2)
                let n32 = UInt32(numVertices)
                guard i0 < n32, i1 < n32, i2 < n32 else { continue }
                salida.indices.append(base + i0)
                salida.indices.append(base + i1)
                salida.indices.append(base + i2)

                if let contenido = contenidoClases, let fuente = fuenteClases {
                    let bruto = contenido
                        .advanced(by: fuente.offset + fuente.stride * f)
                        .bindMemory(to: UInt8.self, capacity: 1)
                        .pointee
                    let clase = ARMeshClassification(rawValue: Int(bruto)) ?? .none
                    let traducida = MeshAccumulator.clasificar(clase)
                    if traducida != .none { hayClasificacion = true }
                    salida.classifications.append(traducida)
                } else {
                    salida.classifications.append(.none)
                }
            }

            // 4) Normales calculadas desde las caras cuando ARKit no las dio.
            if !normalesUsables {
                MeshAccumulator.calcularNormales(&salida,
                                                 desdeVertice: Int(base),
                                                 cantidad: numVertices)
            }
        }

        if !hayClasificacion {
            salida.classifications.removeAll(keepingCapacity: false)
        }
        return salida
    }

    // MARK: - Traducción de clases semánticas

    /// Traduce la clasificación de ARKit a la del formato `josescan`.
    /// El mapeo es explícito para que un cambio de ARKit no corrompa el archivo.
    public static func clasificar(_ clase: ARMeshClassification) -> ScanFaceClass {
        switch clase {
        case .none: return .none
        case .wall: return .wall
        case .floor: return .floor
        case .ceiling: return .ceiling
        case .table: return .table
        case .seat: return .seat
        case .window: return .window
        case .door: return .door
        @unknown default: return .none
        }
    }

    // MARK: - Lectura de buffers de Metal

    /// Lee un `float3` del buffer de un `ARGeometrySource`.
    @inline(__always)
    private static func vector3(_ contenido: UnsafeMutableRawPointer,
                                _ offset: Int,
                                _ stride: Int,
                                _ i: Int) -> SIMD3<Float> {
        let p = contenido.advanced(by: offset + stride * i)
            .bindMemory(to: Float.self, capacity: 3)
        return SIMD3<Float>(p[0], p[1], p[2])
    }

    /// Lee el índice `i` (global, no por primitiva) de un `ARGeometryElement`.
    @inline(__always)
    private static func indice(_ contenido: UnsafeMutableRawPointer,
                               _ bytesPorIndice: Int,
                               _ i: Int) -> UInt32 {
        let p = contenido.advanced(by: bytesPorIndice * i)
        if bytesPorIndice == 2 {
            return UInt32(p.bindMemory(to: UInt16.self, capacity: 1).pointee)
        }
        return p.bindMemory(to: UInt32.self, capacity: 1).pointee
    }

    /// Normales por vértice acumulando las de cada cara del rango indicado.
    private static func calcularNormales(_ malla: inout ScanMesh,
                                         desdeVertice inicio: Int,
                                         cantidad: Int) {
        guard cantidad > 0, inicio + cantidad <= malla.vertices.count else { return }
        let fin = UInt32(inicio + cantidad)
        let desde = UInt32(inicio)
        var i = 0
        while i + 2 < malla.indices.count {
            let a = malla.indices[i]
            let b = malla.indices[i + 1]
            let c = malla.indices[i + 2]
            i += 3
            guard a >= desde, a < fin, b >= desde, b < fin, c >= desde, c < fin else { continue }
            let va = malla.vertices[Int(a)]
            let vb = malla.vertices[Int(b)]
            let vc = malla.vertices[Int(c)]
            let n = simd_cross(vb - va, vc - va)
            malla.normals[Int(a)] += n
            malla.normals[Int(b)] += n
            malla.normals[Int(c)] += n
        }
        for j in inicio..<(inicio + cantidad) {
            let largo = simd_length(malla.normals[j])
            malla.normals[j] = largo > 1e-9 ? malla.normals[j] / largo : SIMD3<Float>(0, 1, 0)
        }
    }

    // MARK: - Resumen por anchor

    private static func resumir(_ anchor: ARMeshAnchor) -> Resumen {
        let geometria = anchor.geometry
        let fuenteVertices = geometria.vertices
        let caras = geometria.faces
        guard fuenteVertices.format == .float3,
              caras.indexCountPerPrimitive == 3,
              caras.bytesPerIndex == 2 || caras.bytesPerIndex == 4 else {
            return Resumen(vertices: 0, triangulos: 0, area: 0)
        }

        let contenidoVertices = fuenteVertices.buffer.contents()
        let contenidoCaras = caras.buffer.contents()
        let numVertices = UInt32(fuenteVertices.count)
        var area = 0.0
        for f in 0..<caras.count {
            let i0 = indice(contenidoCaras, caras.bytesPerIndex, f * 3)
            let i1 = indice(contenidoCaras, caras.bytesPerIndex, f * 3 + 1)
            let i2 = indice(contenidoCaras, caras.bytesPerIndex, f * 3 + 2)
            guard i0 < numVertices, i1 < numVertices, i2 < numVertices else { continue }
            let a = vector3(contenidoVertices, fuenteVertices.offset, fuenteVertices.stride, Int(i0))
            let b = vector3(contenidoVertices, fuenteVertices.offset, fuenteVertices.stride, Int(i1))
            let c = vector3(contenidoVertices, fuenteVertices.offset, fuenteVertices.stride, Int(i2))
            area += Double(simd_length(simd_cross(b - a, c - a)) * 0.5)
        }
        return Resumen(vertices: fuenteVertices.count,
                       triangulos: caras.count,
                       area: area.isFinite ? area : 0)
    }
}

#endif
