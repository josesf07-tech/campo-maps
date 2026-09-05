//
//  STLWriter.swift
//  JoseScan
//
//  Serializa una `ScanMesh` a STL, para impresión 3D y CAD.
//
//  Variante binaria (la de omisión):
//      80 bytes  cabecera de texto ("JoseScan …", rellenada con ceros)
//       4 bytes  UInt32 little-endian con el número de triángulos
//      50 bytes  por triángulo: normal (3×Float32) + 3 vértices (9×Float32)
//                + UInt16 "attribute byte count" (siempre 0)
//
//  Variante ascii: `solid` / `facet normal` / `outer loop` / `vertex` …
//
//  Si la malla no trae normales por vértice, la normal de cada cara se calcula
//  con el producto cruz de sus aristas (regla de la mano derecha).
//

import Foundation
import simd

public enum STLWriter {

    /// Bytes que ocupa cada triángulo en la variante binaria.
    public static let bytesPorTriangulo = 50

    /// Texto de la cabecera de 80 bytes del STL binario.
    public static let cabeceraBinaria = "JoseScan \(ScanMetadata.formatoActual) malla LiDAR"

    /// Nombre del sólido en la variante ascii.
    public static let nombreSolido = "JoseScan"

    // MARK: - Normal de cara

    /// Normal unitaria de un triángulo.
    ///
    /// Si se pasan las normales por vértice se promedian; si el promedio es
    /// degenerado (o no hay normales) se usa el producto cruz `(b-a) × (c-a)`.
    /// Devuelve `(0,0,0)` sólo cuando el triángulo es degenerado.
    public static func normal(a: SIMD3<Float>, b: SIMD3<Float>, c: SIMD3<Float>,
                              normalesVertice: (SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)? = nil) -> SIMD3<Float> {
        if let nv = normalesVertice {
            let suma = nv.0 + nv.1 + nv.2
            let largo = simd_length(suma)
            if largo > 1e-8 {
                return suma / largo
            }
        }
        let cruz = simd_cross(b - a, c - a)
        let largo = simd_length(cruz)
        guard largo > 1e-12 else { return SIMD3<Float>(0, 0, 0) }
        return cruz / largo
    }

    // MARK: - Serialización

    /// Serializa la malla al formato STL indicado.
    public static func datos(de malla: ScanMesh, binario: Bool) -> Data {
        binario ? datosBinarios(de: malla) : Data(texto(de: malla).utf8)
    }

    /// Variante binaria por omisión.
    public static func datos(de malla: ScanMesh) -> Data {
        datosBinarios(de: malla)
    }

    // MARK: - Binario

    private static func datosBinarios(de malla: ScanMesh) -> Data {
        let caras = carasValidas(de: malla)

        var salida = Data()
        salida.reserveCapacity(84 + caras.count * bytesPorTriangulo)

        // --- Cabecera de exactamente 80 bytes ---
        var cabecera = Array(cabeceraBinaria.utf8)
        if cabecera.count > 80 { cabecera = Array(cabecera[0..<80]) }
        while cabecera.count < 80 { cabecera.append(0) }
        salida.append(contentsOf: cabecera)

        // --- Número de triángulos (UInt32 little-endian) ---
        let cuantos = UInt32(caras.count)
        agregarUInt32(cuantos, &salida)

        // --- Triángulos ---
        for cara in caras {
            agregarVector(cara.normal, &salida)
            agregarVector(cara.a, &salida)
            agregarVector(cara.b, &salida)
            agregarVector(cara.c, &salida)
            // attribute byte count: siempre 0.
            salida.append(0)
            salida.append(0)
        }

        return salida
    }

    @inline(__always)
    private static func agregarVector(_ v: SIMD3<Float>, _ salida: inout Data) {
        agregarFloat(v.x, &salida)
        agregarFloat(v.y, &salida)
        agregarFloat(v.z, &salida)
    }

    @inline(__always)
    private static func agregarFloat(_ valor: Float, _ salida: inout Data) {
        let patron = valor.bitPattern.littleEndian
        withUnsafeBytes(of: patron) { crudo in
            salida.append(contentsOf: crudo)
        }
    }

    @inline(__always)
    private static func agregarUInt32(_ valor: UInt32, _ salida: inout Data) {
        let v = valor.littleEndian
        withUnsafeBytes(of: v) { crudo in
            salida.append(contentsOf: crudo)
        }
    }

    // MARK: - ASCII

    /// Texto completo del STL ascii.
    public static func texto(de malla: ScanMesh) -> String {
        let caras = carasValidas(de: malla)

        var texto = ""
        texto.reserveCapacity(64 + caras.count * 200)
        texto += "solid \(nombreSolido)\n"

        for cara in caras {
            texto += String(format: "  facet normal %.6e %.6e %.6e\n",
                            cara.normal.x, cara.normal.y, cara.normal.z)
            texto += "    outer loop\n"
            texto += String(format: "      vertex %.6e %.6e %.6e\n", cara.a.x, cara.a.y, cara.a.z)
            texto += String(format: "      vertex %.6e %.6e %.6e\n", cara.b.x, cara.b.y, cara.b.z)
            texto += String(format: "      vertex %.6e %.6e %.6e\n", cara.c.x, cara.c.y, cara.c.z)
            texto += "    endloop\n"
            texto += "  endfacet\n"
        }

        texto += "endsolid \(nombreSolido)\n"
        return texto
    }

    // MARK: - Extracción de caras

    /// Triángulo listo para escribir: tres vértices y su normal unitaria.
    public struct Cara {
        public var a: SIMD3<Float>
        public var b: SIMD3<Float>
        public var c: SIMD3<Float>
        public var normal: SIMD3<Float>
    }

    /// Recorre los índices y devuelve sólo los triángulos cuyos tres índices
    /// caen dentro del arreglo de vértices.
    public static func carasValidas(de malla: ScanMesh) -> [Cara] {
        let vertices = malla.vertices
        let normales = malla.normals
        let indices = malla.indices
        let hayNormales = malla.hasNormals
        let n = UInt32(vertices.count)

        var caras: [Cara] = []
        caras.reserveCapacity(indices.count / 3)

        var i = 0
        while i + 2 < indices.count {
            let ia = indices[i]
            let ib = indices[i + 1]
            let ic = indices[i + 2]
            i += 3
            guard ia < n, ib < n, ic < n else { continue }

            let a = vertices[Int(ia)]
            let b = vertices[Int(ib)]
            let c = vertices[Int(ic)]
            let nv: (SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)? = hayNormales
                ? (normales[Int(ia)], normales[Int(ib)], normales[Int(ic)])
                : nil
            caras.append(Cara(a: a, b: b, c: c,
                              normal: normal(a: a, b: b, c: c, normalesVertice: nv)))
        }
        return caras
    }
}
