//
//  OBJWriter.swift
//  JoseScan
//
//  Serializa una `ScanMesh` a Wavefront OBJ + MTL, según docs/FORMATO-ESCANEO.md
//  (sección 5): unidades en metros, `v`, `vn` y caras `f v//vn` con índices
//  base 1, agrupadas por clasificación semántica (`g muro`, `g piso`, …).
//
//  Si la malla no trae normales se omiten las líneas `vn` y las caras se
//  escriben como `f v v v`.
//

import Foundation
import simd

public enum OBJWriter {

    /// Nombre del material/grupo por omisión del paquete `.josescan`.
    public static let nombreMTLPorOmision = "malla.mtl"

    // MARK: - Clasificación → grupo

    /// Nombre en español (es-CO) del grupo/material de cada clasificación.
    public static func grupo(_ clase: ScanFaceClass) -> String {
        switch clase {
        case .none:    return "sin_clasificar"
        case .wall:    return "muro"
        case .floor:   return "piso"
        case .ceiling: return "techo"
        case .table:   return "mesa"
        case .seat:    return "asiento"
        case .window:  return "ventana"
        case .door:    return "puerta"
        }
    }

    /// Color difuso (RGB 0…1) asignado a cada clasificación. Todos distintos
    /// para poder distinguir muros, pisos y techos de un vistazo en el visor.
    public static func color(_ clase: ScanFaceClass) -> SIMD3<Float> {
        switch clase {
        case .none:    return SIMD3<Float>(0.650, 0.650, 0.650) // gris
        case .wall:    return SIMD3<Float>(0.820, 0.780, 0.700) // beige
        case .floor:   return SIMD3<Float>(0.350, 0.550, 0.300) // verde oliva
        case .ceiling: return SIMD3<Float>(0.550, 0.650, 0.850) // azul claro
        case .table:   return SIMD3<Float>(0.800, 0.500, 0.200) // naranja
        case .seat:    return SIMD3<Float>(0.750, 0.250, 0.300) // rojo
        case .window:  return SIMD3<Float>(0.300, 0.750, 0.850) // cian
        case .door:    return SIMD3<Float>(0.550, 0.350, 0.200) // marrón
        }
    }

    /// Orden canónico en el que se emiten los grupos dentro del OBJ.
    public static var ordenGrupos: [ScanFaceClass] {
        [.none, .wall, .floor, .ceiling, .table, .seat, .window, .door]
    }

    // MARK: - OBJ

    /// Texto completo del archivo `.obj`.
    ///
    /// - Parameters:
    ///   - malla: geometría a serializar.
    ///   - mtllib: nombre del `.mtl` acompañante referenciado con `mtllib`.
    public static func texto(de malla: ScanMesh,
                             mtllib: String = nombreMTLPorOmision) -> String {
        let vertices = malla.vertices
        let normales = malla.normals
        let indices = malla.indices
        let hayNormales = malla.hasNormals
        let triangulos = indices.count / 3

        var texto = ""
        // Estimación: ~34 bytes por `v`/`vn` y ~30 por cara.
        texto.reserveCapacity(256 + vertices.count * 68 + triangulos * 34)

        texto += "# JoseScan \(ScanMetadata.formatoActual)\n"
        texto += "# malla triangular en metros, marco: \(malla.frame.rawValue)\n"
        texto += "# vertices: \(vertices.count)  triangulos: \(triangulos)\n"
        if !mtllib.isEmpty {
            texto += "mtllib \(mtllib)\n"
        }

        // --- Vértices ---
        for v in vertices {
            texto += String(format: "v %.6f %.6f %.6f\n", v.x, v.y, v.z)
        }

        // --- Normales por vértice ---
        if hayNormales {
            for n in normales {
                texto += String(format: "vn %.6f %.6f %.6f\n", n.x, n.y, n.z)
            }
        }

        guard triangulos > 0 else { return texto }

        // --- Agrupación de caras por clasificación ---
        let clasificaciones = malla.classifications
        let hayClases = clasificaciones.count == triangulos && !clasificaciones.isEmpty

        var porClase: [ScanFaceClass: [Int]] = [:]
        if hayClases {
            for t in 0..<triangulos {
                porClase[clasificaciones[t], default: []].append(t)
            }
        } else {
            porClase[.none] = Array(0..<triangulos)
        }

        let cantidadVertices = UInt32(vertices.count)

        for clase in ordenGrupos {
            guard let caras = porClase[clase], !caras.isEmpty else { continue }
            let nombre = grupo(clase)
            texto += "g \(nombre)\n"
            texto += "usemtl \(nombre)\n"

            for t in caras {
                let base = t * 3
                let a = indices[base]
                let b = indices[base + 1]
                let c = indices[base + 2]
                // Índice fuera de rango: se omite la cara en vez de generar un OBJ roto.
                guard a < cantidadVertices, b < cantidadVertices, c < cantidadVertices else { continue }
                let i1 = Int(a) + 1
                let i2 = Int(b) + 1
                let i3 = Int(c) + 1
                if hayNormales {
                    texto += "f \(i1)//\(i1) \(i2)//\(i2) \(i3)//\(i3)\n"
                } else {
                    texto += "f \(i1) \(i2) \(i3)\n"
                }
            }
        }

        return texto
    }

    // MARK: - MTL

    /// Texto completo del archivo `.mtl` acompañante: un material por
    /// clasificación semántica, con colores distintos entre sí.
    public static func materialMTL() -> String {
        var texto = "# JoseScan \(ScanMetadata.formatoActual)\n"
        texto += "# Materiales por clasificación semántica (ARKit scene reconstruction)\n"

        for clase in ordenGrupos {
            let nombre = grupo(clase)
            let c = color(clase)
            texto += "\n"
            texto += "newmtl \(nombre)\n"
            texto += "# \(clase.nombre)\n"
            texto += String(format: "Ka %.4f %.4f %.4f\n", c.x * 0.25, c.y * 0.25, c.z * 0.25)
            texto += String(format: "Kd %.4f %.4f %.4f\n", c.x, c.y, c.z)
            texto += "Ks 0.0000 0.0000 0.0000\n"
            texto += "Ns 8.0000\n"
            texto += "d 1.0000\n"
            texto += "illum 1\n"
        }
        return texto
    }

    /// Bytes UTF-8 del `.obj`.
    public static func datos(de malla: ScanMesh,
                             mtllib: String = nombreMTLPorOmision) -> Data {
        Data(texto(de: malla, mtllib: mtllib).utf8)
    }

    /// Bytes UTF-8 del `.mtl`.
    public static func datosMTL() -> Data {
        Data(materialMTL().utf8)
    }
}
