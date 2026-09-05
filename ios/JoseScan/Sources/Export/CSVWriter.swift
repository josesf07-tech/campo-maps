//
//  CSVWriter.swift
//  JoseScan
//
//  Exportadores de texto tabular: CSV (puntos y mediciones) y XYZ para
//  software topográfico. Encabezados en español (es-CO), separador coma y
//  punto decimal, terminación de línea CRLF según RFC 4180 para que Excel y
//  QGIS los abran sin ajustes.
//

import Foundation
import simd

public enum CSVWriter {

    /// Terminación de línea RFC 4180.
    public static let finLinea = "\r\n"

    // MARK: - Puntos

    /// CSV de la nube de puntos: `x,y,z,r,g,b,confianza`.
    ///
    /// - Parameters:
    ///   - nube: nube a exportar.
    ///   - limite: máximo de filas. Si es `<= 0` o mayor que la nube, se
    ///     escriben todos los puntos; si no, se submuestrea de forma uniforme
    ///     a lo largo de toda la nube (no se recorta sólo el principio).
    public static func puntos(_ nube: PointCloud, limite: Int) -> String {
        let indices = indicesMuestreados(total: nube.positions.count, limite: limite)
        let hayColor = nube.colors.count == nube.positions.count && !nube.colors.isEmpty
        let hayConfianza = nube.confidences.count == nube.positions.count && !nube.confidences.isEmpty

        var texto = "x,y,z,r,g,b,confianza" + finLinea
        texto.reserveCapacity(32 + indices.count * 48)

        for i in indices {
            let p = nube.positions[i]
            let c = hayColor ? nube.colors[i] : PLYWriter.colorPorOmision
            let conf = hayConfianza ? nube.confidences[i] : PLYWriter.confianzaPorOmision
            texto += String(format: "%.4f,%.4f,%.4f,%d,%d,%d,%d",
                            p.x, p.y, p.z,
                            Int(c.x), Int(c.y), Int(c.z), Int(conf))
            texto += finLinea
        }
        return texto
    }

    /// Variante sin límite (todos los puntos).
    public static func puntos(_ nube: PointCloud) -> String {
        puntos(nube, limite: 0)
    }

    // MARK: - Mediciones

    /// CSV de las mediciones tomadas sobre el escaneo.
    /// Columnas: `id,tipo,valor,unidad,etiqueta,creado,puntos`.
    /// La columna `puntos` lleva los vértices separados por `;`, cada uno con
    /// sus componentes separadas por espacio, entrecomillada por contener comas.
    public static func mediciones(_ meds: [MeasurementRecord]) -> String {
        var texto = "id,tipo,valor,unidad,etiqueta,creado,puntos" + finLinea
        texto.reserveCapacity(64 + meds.count * 128)

        for m in meds {
            let vertices = m.points.map { componentes in
                componentes.map { String(format: "%.4f", $0) }.joined(separator: " ")
            }.joined(separator: "; ")

            let columnas = [
                m.id.uuidString,
                m.kind.rawValue,
                String(format: "%.4f", m.value),
                m.unit,
                m.label ?? "",
                GeoJSONWriter.iso8601(m.createdAt),
                vertices
            ]
            texto += columnas.map(escapar).joined(separator: ",")
            texto += finLinea
        }
        return texto
    }

    // MARK: - XYZ

    /// Texto plano `x y z r g b` (separado por espacios) para software
    /// topográfico. Sin encabezado, tal como esperan la mayoría de lectores XYZ.
    public static func xyz(_ nube: PointCloud, limite: Int = 0) -> String {
        let indices = indicesMuestreados(total: nube.positions.count, limite: limite)
        let hayColor = nube.colors.count == nube.positions.count && !nube.colors.isEmpty

        var texto = ""
        texto.reserveCapacity(indices.count * 40)
        for i in indices {
            let p = nube.positions[i]
            if hayColor {
                let c = nube.colors[i]
                texto += String(format: "%.4f %.4f %.4f %d %d %d\n",
                                p.x, p.y, p.z, Int(c.x), Int(c.y), Int(c.z))
            } else {
                texto += String(format: "%.4f %.4f %.4f\n", p.x, p.y, p.z)
            }
        }
        return texto
    }

    // MARK: - Utilidades

    /// Índices a exportar: todos, o un submuestreo uniforme hasta `limite`.
    public static func indicesMuestreados(total: Int, limite: Int) -> [Int] {
        guard total > 0 else { return [] }
        guard limite > 0, limite < total else { return Array(0..<total) }

        var salida: [Int] = []
        salida.reserveCapacity(limite)
        // Paso fraccionario para repartir las muestras por toda la nube.
        for k in 0..<limite {
            let indice = Int((Double(k) * Double(total) / Double(limite)).rounded(.down))
            salida.append(Swift.min(indice, total - 1))
        }
        return salida
    }

    /// Entrecomilla un campo CSV si contiene coma, comillas o salto de línea.
    public static func escapar(_ campo: String) -> String {
        let necesita = campo.contains(",") || campo.contains("\"")
            || campo.contains("\n") || campo.contains("\r")
        guard necesita else { return campo }
        return "\"" + campo.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    // MARK: - Bytes

    /// Bytes UTF-8 del CSV de puntos.
    public static func datosPuntos(_ nube: PointCloud, limite: Int = 0) -> Data {
        Data(puntos(nube, limite: limite).utf8)
    }

    /// Bytes UTF-8 del CSV de mediciones.
    public static func datosMediciones(_ meds: [MeasurementRecord]) -> Data {
        Data(mediciones(meds).utf8)
    }

    /// Bytes UTF-8 del archivo XYZ.
    public static func datosXYZ(_ nube: PointCloud, limite: Int = 0) -> Data {
        Data(xyz(nube, limite: limite).utf8)
    }
}
