//
//  ScanBundleWriter.swift
//  JoseScan
//
//  Arma el paquete `.josescan` descrito en docs/FORMATO-ESCANEO.md (sección 1):
//  un ZIP con
//
//      escaneo.json        Metadatos (obligatorio)
//      nube.ply            Nube de puntos, PLY binario little-endian (opcional)
//      malla.obj           Malla triangular Wavefront OBJ (opcional)
//      malla.mtl           Material del OBJ (opcional)
//      miniatura.jpg       Miniatura 512×512 para la galería (opcional)
//      huella.geojson      Huella georreferenciada WGS84 (opcional)
//
//  Debe existir `escaneo.json` y al menos `nube.ply` o `malla.obj`.
//

import Foundation

public enum ScanBundleWriter {

    // MARK: - Nombres internos del paquete

    public static let nombreMetadatos = "escaneo.json"
    public static let nombreNube = "nube.ply"
    public static let nombreMalla = "malla.obj"
    public static let nombreMaterial = "malla.mtl"
    public static let nombreMiniatura = "miniatura.jpg"
    public static let nombreHuella = "huella.geojson"

    // MARK: - Entradas

    /// Construye, en orden, las entradas que irán dentro del ZIP.
    ///
    /// Antes de serializar llama a `doc.refreshMetadata()` y rellena
    /// `archivoNube`, `archivoMalla` y `archivoMiniatura` con los nombres
    /// realmente incluidos (o `nil` si el componente no va en el paquete).
    ///
    /// - Throws: `ScanError.sinDatos` si el documento está vacío;
    ///   `ScanError.escrituraFallida` si falla la codificación del JSON.
    public static func entradas(de doc: ScanDocument,
                                miniatura: Data?) throws -> [(nombre: String, datos: Data)] {
        guard !doc.isEmpty else { throw ScanError.sinDatos }

        // 1. Sincronizar contadores, marco y caja envolvente con la geometría real.
        doc.refreshMetadata()

        let hayNube = !doc.cloud.isEmpty
        let hayMalla = !doc.mesh.isEmpty
        let hayMiniatura = (miniatura?.isEmpty == false)

        doc.metadata.archivoNube = hayNube ? nombreNube : nil
        doc.metadata.archivoMalla = hayMalla ? nombreMalla : nil
        doc.metadata.archivoMiniatura = hayMiniatura ? nombreMiniatura : nil

        // 2. Metadatos (obligatorio, siempre primero para que los lectores en
        //    streaming lo encuentren de inmediato).
        let json: Data
        do {
            json = try ScanMetadata.jsonEncoder().encode(doc.metadata)
        } catch {
            throw ScanError.escrituraFallida(
                "No se pudo codificar escaneo.json: \(error.localizedDescription)")
        }

        var lista: [(nombre: String, datos: Data)] = []
        lista.append((nombre: nombreMetadatos, datos: json))

        // 3. Geometría.
        if hayNube {
            let ply = PLYWriter.datos(de: doc.cloud, binario: true, marco: doc.metadata.marco)
            lista.append((nombre: nombreNube, datos: ply))
        }
        if hayMalla {
            let obj = OBJWriter.datos(de: doc.mesh, mtllib: nombreMaterial)
            lista.append((nombre: nombreMalla, datos: obj))
            lista.append((nombre: nombreMaterial, datos: OBJWriter.datosMTL()))
        }

        // 4. Huella georreferenciada: sólo si el escaneo tiene ancla GPS.
        if doc.metadata.geo != nil {
            if let huella = try? GeoJSONWriter.featureCollection(de: doc.metadata) {
                lista.append((nombre: nombreHuella, datos: huella))
            }
        }

        // 5. Miniatura opcional.
        if hayMiniatura, let jpg = miniatura {
            lista.append((nombre: nombreMiniatura, datos: jpg))
        }

        return lista
    }

    // MARK: - Paquete completo

    /// Bytes del archivo `.josescan`.
    /// - Throws: `ScanError.sinDatos`, `ScanError.escrituraFallida` o
    ///   `ScanError.formatoInvalido` según el punto de falla.
    public static func datos(de doc: ScanDocument, miniatura: Data? = nil) throws -> Data {
        let lista = try entradas(de: doc, miniatura: miniatura)
        // La marca de tiempo del ZIP usa la fecha de creación del escaneo para
        // que el paquete sea reproducible byte a byte.
        return try ZipArchive.crear(entradas: lista, fecha: doc.metadata.creado)
    }

    /// Escribe el `.josescan` en la URL indicada (escritura atómica).
    /// - Returns: la misma URL, por comodidad al encadenar.
    @discardableResult
    public static func escribir(_ doc: ScanDocument,
                                a url: URL,
                                miniatura: Data? = nil) throws -> URL {
        let paquete = try datos(de: doc, miniatura: miniatura)
        do {
            try paquete.write(to: url, options: [.atomic])
        } catch {
            throw ScanError.escrituraFallida(
                "No se pudo guardar \(url.lastPathComponent): \(error.localizedDescription)")
        }
        return url
    }
}
