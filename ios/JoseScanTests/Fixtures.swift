//
//  Fixtures.swift
//  JoseScanTests
//
//  Generadores DETERMINISTAS de datos de prueba y utilidades de bajo nivel
//  (lectura binaria little-endian, CRC-32, conteo de líneas) compartidas por
//  toda la suite. Todo lo que hay aquí es lógica pura: no toca ARKit, ni la
//  cámara, ni CoreLocation.
//
//  Contrato de referencia: docs/FORMATO-ESCANEO.md
//

import Foundation
import simd
import XCTest
@testable import JoseScan

// MARK: - Aserción auxiliar para vectores

/// Compara dos vectores componente a componente con tolerancia.
func XCTAssertSIMD3Igual(_ obtenido: SIMD3<Float>,
                         _ esperado: SIMD3<Float>,
                         exactitud: Float = 1e-5,
                         _ mensaje: String = "",
                         file: StaticString = #filePath,
                         line: UInt = #line) {
    XCTAssertEqual(obtenido.x, esperado.x, accuracy: exactitud,
                   "\(mensaje) — componente X (obtenido \(obtenido), esperado \(esperado))",
                   file: file, line: line)
    XCTAssertEqual(obtenido.y, esperado.y, accuracy: exactitud,
                   "\(mensaje) — componente Y (obtenido \(obtenido), esperado \(esperado))",
                   file: file, line: line)
    XCTAssertEqual(obtenido.z, esperado.z, accuracy: exactitud,
                   "\(mensaje) — componente Z (obtenido \(obtenido), esperado \(esperado))",
                   file: file, line: line)
}

// MARK: - Fábrica de datos deterministas

enum Fixtures {

    // ---------------------------------------------------------------------
    // Constantes fijas (para que las pruebas sean reproducibles bit a bit)
    // ---------------------------------------------------------------------

    /// 2026-09-05T14:22:31Z — la misma fecha del ejemplo de docs/FORMATO-ESCANEO.md.
    static let fechaFija = Date(timeIntervalSince1970: 1_788_618_151)
    static let fechaFijaISO = "2026-09-05T14:22:31Z"

    /// 2026-01-15T10:30:00Z — segunda fecha para distinguir campos.
    static let fechaSecundaria = Date(timeIntervalSince1970: 1_768_473_000)
    static let fechaSecundariaISO = "2026-01-15T10:30:00Z"

    static let uuidEscaneo = UUID(uuidString: "3F2504E0-4F89-41D3-9A0C-0305E82C3301")!
    static let uuidMedicionA = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    static let uuidMedicionB = UUID(uuidString: "66666666-7777-8888-9999-AAAAAAAAAAAA")!

    /// Ancla de Bogotá: 4.60971 N, −74.08175 W, 2570 m.
    static let latBogota: Double = 4.60971
    static let lonBogota: Double = -74.08175
    static let altBogota: Double = 2570

    // ---------------------------------------------------------------------
    // Malla: cubo de arista `lado` con 8 vértices, 12 triángulos y normales
    // ---------------------------------------------------------------------

    /// Cubo axial con esquina inferior en `origen` y arista `lado`.
    /// - 8 vértices compartidos, 12 triángulos con orientación saliente
    ///   (regla de la mano derecha), por lo que el volumen por divergencia
    ///   sale positivo.
    /// - Área de superficie exacta: 6·lado².  Volumen exacto: lado³.
    static func cubo(lado: Float = 1,
                     origen: SIMD3<Float> = SIMD3<Float>(0, 0, 0),
                     marco: ScanCoordinateFrame = .arkit) -> ScanMesh {
        let l = lado
        let o = origen
        let vertices: [SIMD3<Float>] = [
            SIMD3<Float>(o.x,     o.y,     o.z),        // 0
            SIMD3<Float>(o.x + l, o.y,     o.z),        // 1
            SIMD3<Float>(o.x + l, o.y + l, o.z),        // 2
            SIMD3<Float>(o.x,     o.y + l, o.z),        // 3
            SIMD3<Float>(o.x,     o.y,     o.z + l),    // 4
            SIMD3<Float>(o.x + l, o.y,     o.z + l),    // 5
            SIMD3<Float>(o.x + l, o.y + l, o.z + l),    // 6
            SIMD3<Float>(o.x,     o.y + l, o.z + l)     // 7
        ]
        let centro = SIMD3<Float>(o.x + l / 2, o.y + l / 2, o.z + l / 2)
        let normales = vertices.map { simd_normalize($0 - centro) }
        let indices: [UInt32] = [
            0, 3, 2,   0, 2, 1,     // cara z = 0   (normal −Z)
            4, 5, 6,   4, 6, 7,     // cara z = l   (normal +Z)
            0, 1, 5,   0, 5, 4,     // cara y = 0   (normal −Y)
            3, 7, 6,   3, 6, 2,     // cara y = l   (normal +Y)
            0, 4, 7,   0, 7, 3,     // cara x = 0   (normal −X)
            1, 2, 6,   1, 6, 5      // cara x = l   (normal +X)
        ]
        // 12 clasificaciones: 2 piso, 2 techo, 8 muro.
        let clasificaciones: [ScanFaceClass] = [
            .floor, .floor,
            .ceiling, .ceiling,
            .wall, .wall, .wall, .wall, .wall, .wall, .wall, .wall
        ]
        return ScanMesh(vertices: vertices,
                        normals: normales,
                        indices: indices,
                        classifications: clasificaciones,
                        frame: marco)
    }

    // ---------------------------------------------------------------------
    // Nube: rejilla plana de 1000 puntos
    // ---------------------------------------------------------------------

    static let filasNube = 25
    static let columnasNube = 40
    static let pasoNube: Float = 0.1
    /// 25 × 40 = 1000 puntos.
    static let puntosNube = 1000

    /// Rejilla plana en el plano y = 0: x ∈ [0, 3.9], z ∈ [−2.4, 0].
    /// Colores y confianzas deterministas; la confianza cicla 0, 1, 2.
    static func nubePlana(marco: ScanCoordinateFrame = .arkit) -> PointCloud {
        var posiciones: [SIMD3<Float>] = []
        var colores: [SIMD3<UInt8>] = []
        var confianzas: [UInt8] = []
        posiciones.reserveCapacity(puntosNube)
        colores.reserveCapacity(puntosNube)
        confianzas.reserveCapacity(puntosNube)
        for i in 0..<filasNube {
            for j in 0..<columnasNube {
                let x = Float(j) * pasoNube
                let z = -Float(i) * pasoNube
                posiciones.append(SIMD3<Float>(x, 0, z))
                colores.append(SIMD3<UInt8>(UInt8((j * 6) % 256),
                                            UInt8((i * 10) % 256),
                                            UInt8((i + j) % 256)))
                confianzas.append(UInt8((i + j) % 3))
            }
        }
        return PointCloud(positions: posiciones,
                          colors: colores,
                          confidences: confianzas,
                          frame: marco)
    }

    /// Nube mínima de 3 puntos, útil para pruebas de consistencia.
    static func nubeMinima() -> PointCloud {
        PointCloud(positions: [SIMD3<Float>(0, 0, 0),
                               SIMD3<Float>(1, 0, 0),
                               SIMD3<Float>(0, 0, 1)],
                   colors: [SIMD3<UInt8>(255, 0, 0),
                            SIMD3<UInt8>(0, 255, 0),
                            SIMD3<UInt8>(0, 0, 255)],
                   confidences: [2, 1, 0],
                   frame: .arkit)
    }

    // ---------------------------------------------------------------------
    // Georreferencia
    // ---------------------------------------------------------------------

    /// Ancla confiable de Bogotá (precisión 3 m horizontal, 5° de rumbo).
    static func anclaBogota(rumbo: Double = 0) -> GeoReference {
        GeoReference(latitude: latBogota,
                     longitude: lonBogota,
                     altitude: altBogota,
                     horizontalAccuracy: 3.0,
                     verticalAccuracy: 4.0,
                     heading: rumbo,
                     headingAccuracy: 5.0,
                     timestamp: fechaFija)
    }

    // ---------------------------------------------------------------------
    // Mediciones y metadatos
    // ---------------------------------------------------------------------

    /// Dos mediciones; la segunda lleva comillas y coma en la etiqueta para
    /// ejercitar el escapado CSV (RFC 4180).
    static func mediciones() -> [MeasurementRecord] {
        [
            MeasurementRecord(id: uuidMedicionA,
                              kind: .distancia,
                              value: 3.42,
                              unit: "m",
                              points: [[0, 0, 0], [3.42, 0, 0]],
                              label: "Ancho",
                              createdAt: fechaFija),
            MeasurementRecord(id: uuidMedicionB,
                              kind: .area,
                              value: 4.0,
                              unit: "m²",
                              points: [[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]],
                              label: "Zona \"crítica\", borde",
                              createdAt: fechaSecundaria)
        ]
    }

    /// Metadatos completos con todos los campos opcionales presentes.
    static func metadatos(conAncla: Bool = true, rumbo: Double = 0) -> ScanMetadata {
        ScanMetadata(id: uuidEscaneo,
                     nombre: "Cárcava K12+400",
                     creado: fechaFija,
                     dispositivo: "iPhone 15 Pro",
                     sistema: "iOS 18.2",
                     sensor: "lidar",
                     marco: .arkit,
                     geo: conAncla ? anclaBogota(rumbo: rumbo) : nil,
                     puntos: puntosNube,
                     vertices: 8,
                     triangulos: 12,
                     bbox: BoundingBox(min: SIMD3<Float>(0, 0, -2.4),
                                       max: SIMD3<Float>(3.9, 1, 1)),
                     duracionSegundos: 92.4,
                     mediciones: mediciones(),
                     proyecto: "Proyecto General",
                     notas: "Escaneo de prueba determinista",
                     archivoNube: "nube.ply",
                     archivoMalla: "malla.obj",
                     archivoMiniatura: "miniatura.jpg")
    }

    /// Documento completo: metadatos + nube de 1000 puntos + cubo de 1 m.
    /// Los contadores quedan ya sincronizados con `refreshMetadata()`.
    static func documento(conAncla: Bool = true, rumbo: Double = 0) -> ScanDocument {
        let doc = ScanDocument(metadata: metadatos(conAncla: conAncla, rumbo: rumbo),
                               cloud: nubePlana(),
                               mesh: cubo())
        doc.refreshMetadata()
        return doc
    }

    // ---------------------------------------------------------------------
    // Polígonos de referencia
    // ---------------------------------------------------------------------

    /// Cuadrado de 2 m de lado en el plano horizontal de ARKit (XZ, y = 0).
    /// Perímetro 8 m, área 4 m².
    static let cuadradoXZ: [SIMD3<Float>] = [
        SIMD3<Float>(0, 0, 0),
        SIMD3<Float>(2, 0, 0),
        SIMD3<Float>(2, 0, 2),
        SIMD3<Float>(0, 0, 2)
    ]

    /// Cuadrado de 2 m de lado en el plano horizontal ENU (XY, z = 0).
    /// Perímetro 8 m, área 4 m².
    static let cuadradoXY: [SIMD3<Float>] = [
        SIMD3<Float>(0, 0, 0),
        SIMD3<Float>(2, 0, 0),
        SIMD3<Float>(2, 2, 0),
        SIMD3<Float>(0, 2, 0)
    ]

    /// Rectángulo 4 × 3 en el plano XY (área 12 m², perímetro 14 m).
    static let rectanguloXY: [SIMD3<Float>] = [
        SIMD3<Float>(0, 0, 0),
        SIMD3<Float>(4, 0, 0),
        SIMD3<Float>(4, 3, 0),
        SIMD3<Float>(0, 3, 0)
    ]

    // ---------------------------------------------------------------------
    // Utilidades binarias
    // ---------------------------------------------------------------------

    static func bytes(_ datos: Data) -> [UInt8] { [UInt8](datos) }

    static func ascii(_ texto: String) -> [UInt8] { Array(texto.utf8) }

    static func uint16LE(_ b: [UInt8], _ desplazamiento: Int) -> UInt16 {
        UInt16(b[desplazamiento]) | (UInt16(b[desplazamiento + 1]) << 8)
    }

    static func uint32LE(_ b: [UInt8], _ desplazamiento: Int) -> UInt32 {
        UInt32(b[desplazamiento])
            | (UInt32(b[desplazamiento + 1]) << 8)
            | (UInt32(b[desplazamiento + 2]) << 16)
            | (UInt32(b[desplazamiento + 3]) << 24)
    }

    static func floatLE(_ b: [UInt8], _ desplazamiento: Int) -> Float {
        Float(bitPattern: uint32LE(b, desplazamiento))
    }

    /// Primer índice donde aparece `patron` dentro de `b`, o `nil`.
    static func indice(de patron: [UInt8], en b: [UInt8], desde: Int = 0) -> Int? {
        guard !patron.isEmpty, b.count >= patron.count, desde >= 0 else { return nil }
        var i = desde
        let limite = b.count - patron.count
        while i <= limite {
            var coincide = true
            var j = 0
            while j < patron.count {
                if b[i + j] != patron[j] {
                    coincide = false
                    break
                }
                j += 1
            }
            if coincide { return i }
            i += 1
        }
        return nil
    }

    /// Último índice donde aparece `patron` dentro de `b`, o `nil`.
    static func ultimoIndice(de patron: [UInt8], en b: [UInt8]) -> Int? {
        guard !patron.isEmpty, b.count >= patron.count else { return nil }
        var i = b.count - patron.count
        while i >= 0 {
            var coincide = true
            var j = 0
            while j < patron.count {
                if b[i + j] != patron[j] {
                    coincide = false
                    break
                }
                j += 1
            }
            if coincide { return i }
            i -= 1
        }
        return nil
    }

    /// Número de apariciones (sin solapamiento) de `patron` dentro de `b`.
    static func ocurrencias(de patron: [UInt8], en b: [UInt8]) -> Int {
        guard !patron.isEmpty else { return 0 }
        var total = 0
        var i = 0
        while let encontrado = indice(de: patron, en: b, desde: i) {
            total += 1
            i = encontrado + patron.count
        }
        return total
    }

    /// Número de apariciones (sin solapamiento) de `patron` dentro de `texto`.
    static func ocurrencias(de patron: String, en texto: String) -> Int {
        guard !patron.isEmpty else { return 0 }
        var total = 0
        var inicio = texto.startIndex
        while inicio < texto.endIndex,
              let rango = texto.range(of: patron, range: inicio..<texto.endIndex) {
            total += 1
            inicio = rango.upperBound
        }
        return total
    }

    // ---------------------------------------------------------------------
    // Utilidades de texto
    // ---------------------------------------------------------------------

    /// Divide en líneas, normaliza CRLF y descarta líneas vacías.
    static func lineas(_ texto: String) -> [String] {
        texto.split(separator: "\n", omittingEmptySubsequences: false)
            .map { linea -> String in
                let s = String(linea)
                return s.hasSuffix("\r") ? String(s.dropLast()) : s
            }
            .filter { !$0.isEmpty }
    }

    /// Líneas que empiezan por el prefijo dado (por ejemplo "v " o "f ").
    static func lineas(conPrefijo prefijo: String, en texto: String) -> [String] {
        lineas(texto).filter { $0.hasPrefix(prefijo) }
    }

    // ---------------------------------------------------------------------
    // PLY: separación cabecera / cuerpo
    // ---------------------------------------------------------------------

    /// Divide un PLY en (líneas de cabecera SIN "end_header", cuerpo tras el
    /// salto de línea que sigue a "end_header").
    static func partirPLY(_ datos: Data) -> (cabecera: [String], cuerpo: [UInt8])? {
        let b = bytes(datos)
        guard let fin = indice(de: ascii("end_header"), en: b) else { return nil }
        var inicioCuerpo = fin + "end_header".utf8.count
        // Saltar el fin de línea (soporta "\n" y "\r\n").
        if inicioCuerpo < b.count, b[inicioCuerpo] == 0x0D { inicioCuerpo += 1 }
        if inicioCuerpo < b.count, b[inicioCuerpo] == 0x0A { inicioCuerpo += 1 }
        let textoCabecera = String(decoding: b[0..<fin], as: UTF8.self)
        let cuerpo = Array(b[inicioCuerpo...])
        return (lineas(textoCabecera), cuerpo)
    }

    // ---------------------------------------------------------------------
    // CRC-32 (IEEE 802.3, polinomio reflejado 0xEDB88320) — el mismo que usa ZIP
    // ---------------------------------------------------------------------

    private static let tablaCRC32: [UInt32] = {
        var tabla = [UInt32](repeating: 0, count: 256)
        for i in 0..<256 {
            var c = UInt32(i)
            for _ in 0..<8 {
                c = (c & 1) == 1 ? (0xEDB8_8320 ^ (c >> 1)) : (c >> 1)
            }
            tabla[i] = c
        }
        return tabla
    }()

    /// CRC-32 de referencia calculado en la propia suite (implementación
    /// independiente de la del código de producción).
    static func crc32(_ datos: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in datos {
            let indice = Int((crc ^ UInt32(byte)) & 0xFF)
            crc = tablaCRC32[indice] ^ (crc >> 8)
        }
        return crc ^ 0xFFFF_FFFF
    }

    static func crc32(_ texto: String) -> UInt32 {
        crc32(Data(texto.utf8))
    }
}
