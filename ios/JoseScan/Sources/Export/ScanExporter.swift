//
//  ScanExporter.swift
//  JoseScan
//
//  Punto de entrada único de la exportación: valida el documento, elige el
//  writer adecuado y deja el archivo en disco de forma segura (se escribe a un
//  archivo temporal del mismo directorio y luego se reemplaza el destino, de
//  modo que nunca queda un archivo a medias si la app se interrumpe).
//
//  Todos los formatos de `ScanExportFormat` están cubiertos.
//

import Foundation

public enum ScanExporter {

    // MARK: - Ajustes

    /// Tope de filas del CSV de puntos. Evita generar archivos de varios GB;
    /// cuando la nube lo supera se submuestrea de forma uniforme.
    public static let limitePuntosCSV = 1_000_000

    /// Nombre usado cuando `nombreSeguro` se queda sin caracteres válidos.
    public static let nombrePorOmision = "escaneo"

    /// Longitud máxima del nombre base saneado.
    public static let largoMaximoNombre = 80

    // MARK: - Nombres de archivo

    /// Nombre de archivo saneado: sin componentes de ruta, sin caracteres
    /// inválidos y con las tildes convertidas a su equivalente ASCII.
    ///
    /// Reglas: se conserva sólo `[A-Za-z0-9-_ ]`, el resto pasa a `_`; los
    /// espacios repetidos se colapsan; se recorta a 80 caracteres; nunca
    /// devuelve una cadena vacía.
    public static func nombreSeguro(_ texto: String) -> String {
        // 1. Descartar cualquier componente de ruta (POSIX, Windows y HFS).
        let separadores = CharacterSet(charactersIn: "/\\:")
        let sinRuta = texto.components(separatedBy: separadores).last ?? texto

        // 2. Tildes y diacríticos a ASCII: "Cárcava" → "Carcava", "Ñ" → "N".
        let plano = sinRuta.folding(options: [.diacriticInsensitive, .widthInsensitive],
                                    locale: Locale(identifier: "en_US_POSIX"))

        // 3. Reemplazar por "_" todo lo que no esté permitido.
        var filtrado = ""
        filtrado.reserveCapacity(plano.unicodeScalars.count)
        for escalar in plano.unicodeScalars {
            if caracteresPermitidos.contains(escalar) {
                filtrado.unicodeScalars.append(escalar)
            } else {
                filtrado += "_"
            }
        }

        // 4. Colapsar espacios repetidos y recortar los de los extremos.
        var limpio = filtrado.split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")

        // 5. Recortar a la longitud máxima (y volver a limpiar los bordes).
        if limpio.count > largoMaximoNombre {
            limpio = String(limpio.prefix(largoMaximoNombre))
        }
        limpio = limpio.trimmingCharacters(in: .whitespaces)

        return limpio.isEmpty ? nombrePorOmision : limpio
    }

    /// Conjunto `[A-Za-z0-9-_ ]`.
    private static let caracteresPermitidos: CharacterSet = {
        CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz")
            .union(CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
            .union(CharacterSet(charactersIn: "0123456789"))
            .union(CharacterSet(charactersIn: "-_ "))
    }()

    /// Nombre final del archivo para un formato dado.
    /// `plyAscii` lleva el sufijo `-ascii` para no chocar con el PLY binario,
    /// que comparte la extensión `.ply`.
    public static func nombreArchivo(base: String, formato: ScanExportFormat) -> String {
        switch formato {
        case .plyAscii:
            return "\(base)-ascii.ply"
        default:
            return "\(base).\(formato.extensionArchivo)"
        }
    }

    // MARK: - Exportación

    /// Exporta y devuelve la URL del archivo generado dentro de `directorio`.
    ///
    /// - Parameters:
    ///   - doc: documento a exportar (se le llama `refreshMetadata()`).
    ///   - formato: formato de salida.
    ///   - directorio: carpeta destino; se crea si no existe.
    ///   - nombreBase: nombre deseado, se sanea con `nombreSeguro(_:)`.
    ///   - miniatura: JPEG opcional, sólo se usa en el formato `.bundle`.
    /// - Throws: `ScanError.sinDatos`, `ScanError.sinMalla`,
    ///   `ScanError.sinGeorreferencia` o `ScanError.escrituraFallida`.
    @discardableResult
    public static func exportar(_ doc: ScanDocument,
                                formato: ScanExportFormat,
                                a directorio: URL,
                                nombreBase: String,
                                miniatura: Data? = nil) throws -> URL {
        try validar(doc, formato: formato)
        try prepararDirectorio(directorio)

        doc.refreshMetadata()

        let base = nombreSeguro(nombreBase)
        let destino = directorio.appendingPathComponent(nombreArchivo(base: base, formato: formato))

        if formato == .usdz {
            // ModelIO sólo sabe escribir a disco: se genera en un temporal del
            // mismo directorio y se instala al final.
            let temporal = urlTemporal(en: directorio, extension: "usdz")
            do {
                try USDZWriter.escribir(doc.mesh, a: temporal)
            } catch {
                try? FileManager.default.removeItem(at: temporal)
                throw error
            }
            try instalar(temporal, en: destino)
            return destino
        }

        let contenido = try datos(de: doc, formato: formato, nombreBase: base, miniatura: miniatura)
        try escribirSeguro(contenido, en: destino, dentroDe: directorio)

        // Archivos acompañantes.
        switch formato {
        case .obj:
            let mtl = directorio.appendingPathComponent("\(base).mtl")
            try escribirSeguro(OBJWriter.datosMTL(), en: mtl, dentroDe: directorio)
        case .csv:
            // Si además hay mediciones, se deja un CSV aparte con ellas.
            if !doc.cloud.isEmpty && !doc.metadata.mediciones.isEmpty {
                let extra = directorio.appendingPathComponent("\(base)-mediciones.csv")
                let filas = CSVWriter.datosMediciones(doc.metadata.mediciones)
                try escribirSeguro(filas, en: extra, dentroDe: directorio)
            }
        default:
            break
        }

        return destino
    }

    /// Exporta varios formatos de una vez. Los duplicados se ignoran.
    /// Si alguno falla se lanza su error y se detiene la operación; los
    /// archivos ya escritos se conservan.
    @discardableResult
    public static func exportar(_ doc: ScanDocument,
                                formatos: [ScanExportFormat],
                                a directorio: URL,
                                nombreBase: String,
                                miniatura: Data? = nil) throws -> [URL] {
        var salida: [URL] = []
        salida.reserveCapacity(formatos.count)
        var vistos = Set<String>()

        for formato in formatos {
            guard !vistos.contains(formato.rawValue) else { continue }
            vistos.insert(formato.rawValue)
            let url = try exportar(doc,
                                   formato: formato,
                                   a: directorio,
                                   nombreBase: nombreBase,
                                   miniatura: miniatura)
            salida.append(url)
        }
        return salida
    }

    // MARK: - Serialización en memoria

    /// Bytes del archivo correspondiente al formato, sin tocar el disco.
    ///
    /// `nombreBase` se usa únicamente para la línea `mtllib` del OBJ; se espera
    /// ya saneado. El formato `.usdz` sí necesita un temporal en disco porque
    /// ModelIO no expone serialización en memoria.
    public static func datos(de doc: ScanDocument,
                             formato: ScanExportFormat,
                             nombreBase: String,
                             miniatura: Data? = nil) throws -> Data {
        try validar(doc, formato: formato)
        doc.refreshMetadata()
        let base = nombreSeguro(nombreBase)

        switch formato {
        case .ply:
            return PLYWriter.datos(de: doc.cloud, binario: true, marco: doc.metadata.marco)
        case .plyAscii:
            return PLYWriter.datos(de: doc.cloud, binario: false, marco: doc.metadata.marco)
        case .obj:
            return OBJWriter.datos(de: doc.mesh, mtllib: "\(base).mtl")
        case .stl:
            return STLWriter.datos(de: doc.mesh, binario: true)
        case .usdz:
            return try USDZWriter.datos(de: doc.mesh)
        case .xyz:
            return CSVWriter.datosXYZ(doc.cloud, limite: 0)
        case .geojson:
            return try GeoJSONWriter.featureCollection(de: doc.metadata)
        case .csv:
            if !doc.cloud.isEmpty {
                return CSVWriter.datosPuntos(doc.cloud, limite: limitePuntosCSV)
            }
            return CSVWriter.datosMediciones(doc.metadata.mediciones)
        case .bundle:
            return try ScanBundleWriter.datos(de: doc, miniatura: miniatura)
        }
    }

    // MARK: - Validación

    /// Comprueba que el documento tenga lo que el formato necesita.
    public static func validar(_ doc: ScanDocument, formato: ScanExportFormat) throws {
        guard !doc.isEmpty else { throw ScanError.sinDatos }

        if formato.requiereMalla && doc.mesh.isEmpty {
            throw ScanError.sinMalla
        }

        switch formato {
        case .ply, .plyAscii, .xyz:
            guard !doc.cloud.isEmpty else { throw ScanError.sinDatos }
        case .csv:
            guard !doc.cloud.isEmpty || !doc.metadata.mediciones.isEmpty else {
                throw ScanError.sinDatos
            }
        case .geojson:
            guard doc.metadata.geo != nil else { throw ScanError.sinGeorreferencia }
        case .obj, .stl, .usdz, .bundle:
            break
        }
    }

    // MARK: - Sistema de archivos

    /// Crea el directorio destino si hace falta y verifica que sea una carpeta.
    public static func prepararDirectorio(_ directorio: URL) throws {
        let gestor = FileManager.default
        var esCarpeta: ObjCBool = false
        if gestor.fileExists(atPath: directorio.path, isDirectory: &esCarpeta) {
            guard esCarpeta.boolValue else {
                throw ScanError.escrituraFallida(
                    "La ruta destino no es una carpeta: \(directorio.path)")
            }
            return
        }
        do {
            try gestor.createDirectory(at: directorio, withIntermediateDirectories: true)
        } catch {
            throw ScanError.escrituraFallida(
                "No se pudo crear la carpeta \(directorio.lastPathComponent): \(error.localizedDescription)")
        }
    }

    /// URL de trabajo oculta dentro del mismo directorio (mismo volumen, para
    /// que el reemplazo posterior sea atómico).
    private static func urlTemporal(en directorio: URL, extension ext: String) -> URL {
        let sufijo = ext.isEmpty ? "tmp" : ext
        return directorio.appendingPathComponent(".josescan-\(UUID().uuidString).\(sufijo)")
    }

    /// Escribe los bytes en un temporal y reemplaza el destino.
    private static func escribirSeguro(_ contenido: Data,
                                       en destino: URL,
                                       dentroDe directorio: URL) throws {
        let temporal = urlTemporal(en: directorio, extension: destino.pathExtension)
        do {
            try contenido.write(to: temporal, options: [.atomic])
        } catch {
            try? FileManager.default.removeItem(at: temporal)
            throw ScanError.escrituraFallida(
                "No se pudo escribir \(destino.lastPathComponent): \(error.localizedDescription)")
        }
        try instalar(temporal, en: destino)
    }

    /// Mueve el temporal sobre el destino, sobrescribiendo si ya existía.
    private static func instalar(_ temporal: URL, en destino: URL) throws {
        let gestor = FileManager.default
        do {
            if gestor.fileExists(atPath: destino.path) {
                _ = try gestor.replaceItemAt(destino, withItemAt: temporal)
            } else {
                try gestor.moveItem(at: temporal, to: destino)
            }
        } catch {
            try? gestor.removeItem(at: temporal)
            throw ScanError.escrituraFallida(
                "No se pudo reemplazar \(destino.lastPathComponent): \(error.localizedDescription)")
        }
    }
}
