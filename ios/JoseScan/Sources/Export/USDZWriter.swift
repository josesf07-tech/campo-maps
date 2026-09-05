//
//  USDZWriter.swift
//  JoseScan
//
//  Exporta la malla a USDZ usando ModelIO, para la Vista Rápida AR de iOS
//  (Quick Look). Construye un `MDLMesh` a partir de buffers propios con
//  `MDLMeshBufferDataAllocator` — vértices interleaved posición+normal — y lo
//  escribe con `MDLAsset.export(to:)`.
//
//  Si el sistema no puede exportar `usdz` se lanza `ScanError.escrituraFallida`
//  con un mensaje claro; nunca se deja un archivo a medias.
//

import Foundation
import ModelIO
import simd

public enum USDZWriter {

    /// Bytes por vértice del buffer interleaved: posición(3×Float) + normal(3×Float).
    public static let strideVertice = 24

    /// Color base del material generado (gris claro neutro).
    public static let colorBase = SIMD3<Float>(0.78, 0.78, 0.80)

    /// Verdadero si esta versión de iOS sabe escribir archivos `.usdz`.
    public static func puedeExportar() -> Bool {
        MDLAsset.canExportFileExtension("usdz")
    }

    // MARK: - Normales

    /// Normales por vértice calculadas acumulando las normales de cara
    /// (ponderadas por el área del triángulo) y normalizando al final.
    /// Se usa cuando la malla llega sin normales.
    public static func normalesCalculadas(de malla: ScanMesh) -> [SIMD3<Float>] {
        var acumulado = [SIMD3<Float>](repeating: SIMD3<Float>(0, 0, 0),
                                       count: malla.vertices.count)
        let n = UInt32(malla.vertices.count)

        var i = 0
        while i + 2 < malla.indices.count {
            let ia = malla.indices[i]
            let ib = malla.indices[i + 1]
            let ic = malla.indices[i + 2]
            i += 3
            guard ia < n, ib < n, ic < n else { continue }

            let a = malla.vertices[Int(ia)]
            let b = malla.vertices[Int(ib)]
            let c = malla.vertices[Int(ic)]
            // El producto cruz sin normalizar ya pondera por el doble del área.
            let cruz = simd_cross(b - a, c - a)
            acumulado[Int(ia)] += cruz
            acumulado[Int(ib)] += cruz
            acumulado[Int(ic)] += cruz
        }

        for k in acumulado.indices {
            let largo = simd_length(acumulado[k])
            acumulado[k] = largo > 1e-12 ? acumulado[k] / largo : SIMD3<Float>(0, 1, 0)
        }
        return acumulado
    }

    // MARK: - Construcción del asset

    /// Arma un `MDLAsset` con una única malla triangular lista para exportar.
    /// - Throws: `ScanError.sinMalla` si la geometría está vacía o es inconsistente.
    public static func asset(de malla: ScanMesh) throws -> MDLAsset {
        guard !malla.isEmpty else { throw ScanError.sinMalla }

        let vertices = malla.vertices
        let cantidad = vertices.count
        let normales = malla.hasNormals ? malla.normals : normalesCalculadas(de: malla)

        // Índices saneados: sólo triángulos completos y dentro de rango.
        let tope = UInt32(cantidad)
        var indices: [UInt32] = []
        indices.reserveCapacity(malla.indices.count)
        var i = 0
        while i + 2 < malla.indices.count {
            let ia = malla.indices[i]
            let ib = malla.indices[i + 1]
            let ic = malla.indices[i + 2]
            i += 3
            guard ia < tope, ib < tope, ic < tope else { continue }
            indices.append(ia)
            indices.append(ib)
            indices.append(ic)
        }
        guard indices.count >= 3 else { throw ScanError.sinMalla }

        // Buffer interleaved: [x, y, z, nx, ny, nz] por vértice.
        var interleaved = [Float]()
        interleaved.reserveCapacity(cantidad * 6)
        for k in 0..<cantidad {
            let p = vertices[k]
            let nrm = k < normales.count ? normales[k] : SIMD3<Float>(0, 1, 0)
            interleaved.append(p.x)
            interleaved.append(p.y)
            interleaved.append(p.z)
            interleaved.append(nrm.x)
            interleaved.append(nrm.y)
            interleaved.append(nrm.z)
        }

        let datosVertices = interleaved.withUnsafeBufferPointer { Data(buffer: $0) }
        let datosIndices = indices.withUnsafeBufferPointer { Data(buffer: $0) }

        let asignador = MDLMeshBufferDataAllocator()
        let bufferVertices = asignador.newBuffer(with: datosVertices, type: .vertex)
        let bufferIndices = asignador.newBuffer(with: datosIndices, type: .index)

        // Material PBR sencillo para que Quick Look lo sombree correctamente.
        let dispersion = MDLPhysicallyPlausibleScatteringFunction()
        let material = MDLMaterial(name: "JoseScanMalla", scatteringFunction: dispersion)
        material.setProperty(MDLMaterialProperty(name: "baseColor",
                                                 semantic: .baseColor,
                                                 float3: colorBase))
        material.setProperty(MDLMaterialProperty(name: "roughness",
                                                 semantic: .roughness,
                                                 float: 0.75))
        material.setProperty(MDLMaterialProperty(name: "metallic",
                                                 semantic: .metallic,
                                                 float: 0.0))

        let submalla = MDLSubmesh(indexBuffer: bufferIndices,
                                  indexCount: indices.count,
                                  indexType: .uInt32,
                                  geometryType: .triangles,
                                  material: material)

        let descriptor = MDLVertexDescriptor()
        descriptor.attributes[0] = MDLVertexAttribute(name: MDLVertexAttributePosition,
                                                      format: .float3,
                                                      offset: 0,
                                                      bufferIndex: 0)
        descriptor.attributes[1] = MDLVertexAttribute(name: MDLVertexAttributeNormal,
                                                      format: .float3,
                                                      offset: 12,
                                                      bufferIndex: 0)
        descriptor.layouts[0] = MDLVertexBufferLayout(stride: strideVertice)

        let mdlMesh = MDLMesh(vertexBuffer: bufferVertices,
                              vertexCount: cantidad,
                              descriptor: descriptor,
                              submeshes: [submalla])
        mdlMesh.name = "JoseScanMalla"

        let asset = MDLAsset(bufferAllocator: asignador)
        asset.add(mdlMesh)
        return asset
    }

    // MARK: - Escritura

    /// Escribe la malla como `.usdz` en la URL indicada.
    /// - Throws: `ScanError.sinMalla` si no hay geometría,
    ///   `ScanError.escrituraFallida` si el sistema no soporta USDZ o si
    ///   ModelIO falla al serializar.
    public static func escribir(_ malla: ScanMesh, a url: URL) throws {
        guard puedeExportar() else {
            throw ScanError.escrituraFallida(
                "Este sistema no puede escribir USDZ con ModelIO. Exporta la malla en OBJ o STL.")
        }
        guard url.pathExtension.lowercased() == "usdz" else {
            throw ScanError.escrituraFallida(
                "La ruta de destino debe terminar en .usdz (recibida: \(url.lastPathComponent)).")
        }

        let modelo = try asset(de: malla)
        do {
            try modelo.export(to: url)
        } catch {
            throw ScanError.escrituraFallida(
                "ModelIO no pudo generar el USDZ: \(error.localizedDescription)")
        }

        // Verificación explícita: ModelIO puede fallar en silencio en algunos casos.
        let gestor = FileManager.default
        guard gestor.fileExists(atPath: url.path),
              let atributos = try? gestor.attributesOfItem(atPath: url.path),
              let tamano = atributos[.size] as? NSNumber,
              tamano.intValue > 0 else {
            try? gestor.removeItem(at: url)
            throw ScanError.escrituraFallida("El USDZ generado quedó vacío.")
        }
    }

    /// Genera el `.usdz` en memoria escribiéndolo primero en un archivo temporal.
    /// ModelIO sólo sabe exportar a disco, así que se usa el directorio temporal.
    public static func datos(de malla: ScanMesh) throws -> Data {
        let temporal = FileManager.default.temporaryDirectory
            .appendingPathComponent("josescan-\(UUID().uuidString).usdz")
        try escribir(malla, a: temporal)
        defer { try? FileManager.default.removeItem(at: temporal) }
        do {
            return try Data(contentsOf: temporal)
        } catch {
            throw ScanError.escrituraFallida(
                "No se pudo leer el USDZ temporal: \(error.localizedDescription)")
        }
    }
}
