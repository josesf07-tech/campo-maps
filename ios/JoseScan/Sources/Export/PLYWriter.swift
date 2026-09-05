//
//  PLYWriter.swift
//  JoseScan
//
//  Serializa una `PointCloud` al formato PLY definido en docs/FORMATO-ESCANEO.md
//  (sección 4). Soporta las dos variantes del contrato:
//
//      format binary_little_endian 1.0   → 16 bytes por punto
//      format ascii 1.0                  → una línea de texto por punto
//
//  Orden de propiedades (idéntico en ambas variantes):
//      x, y, z (float32)  ·  red, green, blue (uchar)  ·  confidence (uchar)
//
//  Funciones puras: no dependen de ARKit ni del sistema de archivos, así que se
//  pueden comprobar directamente en pruebas unitarias.
//

import Foundation
import simd

public enum PLYWriter {

    // MARK: - Valores por omisión

    /// Color usado cuando la nube no trae color muestreado de la cámara.
    /// Gris neutro para que los visores no pinten los puntos de negro.
    public static let colorPorOmision = SIMD3<UInt8>(200, 200, 200)

    /// Confianza usada cuando la nube no trae el arreglo de confianzas.
    /// Se escribe 2 (alta) para que los filtros por confianza no descarten todo.
    public static let confianzaPorOmision: UInt8 = 2

    /// Bytes que ocupa cada punto en la variante binaria: 3×Float32 + 4×UInt8.
    public static let bytesPorPunto = 16

    // MARK: - Cabecera

    /// Construye la cabecera del PLY (terminada en `end_header\n`).
    ///
    /// - Parameters:
    ///   - cantidad: número de vértices declarado en `element vertex`.
    ///   - binario: `true` para `binary_little_endian 1.0`, `false` para `ascii 1.0`.
    ///   - marco: valor escrito en `comment marco` (`arkit` o `enu`).
    public static func encabezado(cantidad: Int,
                                  binario: Bool,
                                  marco: ScanCoordinateFrame) -> String {
        var lineas: [String] = []
        lineas.append("ply")
        lineas.append(binario ? "format binary_little_endian 1.0" : "format ascii 1.0")
        lineas.append("comment JoseScan \(ScanMetadata.formatoActual)")
        lineas.append("comment marco \(marco.rawValue)")
        lineas.append("element vertex \(cantidad)")
        lineas.append("property float x")
        lineas.append("property float y")
        lineas.append("property float z")
        lineas.append("property uchar red")
        lineas.append("property uchar green")
        lineas.append("property uchar blue")
        lineas.append("property uchar confidence")
        lineas.append("end_header")
        return lineas.joined(separator: "\n") + "\n"
    }

    // MARK: - Serialización

    /// Serializa la nube completa al formato PLY.
    ///
    /// El parámetro `marco` sólo determina la etiqueta `comment marco` de la
    /// cabecera: **no** transforma las coordenadas. La conversión ARKit → ENU
    /// se hace antes, en el módulo de georreferenciación.
    public static func datos(de nube: PointCloud,
                             binario: Bool,
                             marco: ScanCoordinateFrame) -> Data {
        let n = nube.positions.count
        let cabecera = encabezado(cantidad: n, binario: binario, marco: marco)

        if binario {
            return datosBinarios(de: nube, cabecera: cabecera)
        }
        return datosASCII(de: nube, cabecera: cabecera)
    }

    /// Variante que toma el marco de la propia nube.
    public static func datos(de nube: PointCloud, binario: Bool = true) -> Data {
        datos(de: nube, binario: binario, marco: nube.frame)
    }

    // MARK: - Cuerpo binario

    private static func datosBinarios(de nube: PointCloud, cabecera: String) -> Data {
        let n = nube.positions.count
        let cabeceraBytes = Data(cabecera.utf8)

        var salida = Data()
        // Se reserva todo de una vez para no fragmentar memoria con millones de puntos.
        salida.reserveCapacity(cabeceraBytes.count + n * bytesPorPunto)
        salida.append(cabeceraBytes)

        let hayColor = nube.colors.count == n && n > 0
        let hayConfianza = nube.confidences.count == n && n > 0

        for i in 0..<n {
            let p = nube.positions[i]
            agregarFloat(p.x, &salida)
            agregarFloat(p.y, &salida)
            agregarFloat(p.z, &salida)

            let c = hayColor ? nube.colors[i] : colorPorOmision
            salida.append(c.x)
            salida.append(c.y)
            salida.append(c.z)

            salida.append(hayConfianza ? nube.confidences[i] : confianzaPorOmision)
        }
        return salida
    }

    /// Añade un `Float` en little-endian (4 bytes) al buffer de salida.
    @inline(__always)
    private static func agregarFloat(_ valor: Float, _ salida: inout Data) {
        let patron = valor.bitPattern.littleEndian
        withUnsafeBytes(of: patron) { crudo in
            salida.append(contentsOf: crudo)
        }
    }

    // MARK: - Cuerpo ASCII

    private static func datosASCII(de nube: PointCloud, cabecera: String) -> Data {
        Data(textoASCII(de: nube, cabecera: cabecera).utf8)
    }

    /// Texto completo del PLY ascii (útil para inspección y pruebas).
    public static func texto(de nube: PointCloud, marco: ScanCoordinateFrame) -> String {
        textoASCII(de: nube,
                   cabecera: encabezado(cantidad: nube.positions.count,
                                        binario: false,
                                        marco: marco))
    }

    private static func textoASCII(de nube: PointCloud, cabecera: String) -> String {
        let n = nube.positions.count
        let hayColor = nube.colors.count == n && n > 0
        let hayConfianza = nube.confidences.count == n && n > 0

        var texto = cabecera
        // ~48 caracteres por línea en la práctica; se reserva con holgura.
        texto.reserveCapacity(cabecera.utf8.count + n * 56)

        for i in 0..<n {
            let p = nube.positions[i]
            let c = hayColor ? nube.colors[i] : colorPorOmision
            let conf = hayConfianza ? nube.confidences[i] : confianzaPorOmision
            texto += String(format: "%.6f %.6f %.6f %d %d %d %d\n",
                            p.x, p.y, p.z,
                            Int(c.x), Int(c.y), Int(c.z), Int(conf))
        }
        return texto
    }
}
