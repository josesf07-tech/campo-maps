//
//  ScanStore.swift
//  JoseScan
//
//  Persistencia en disco de los escaneos (sin CoreData) y galería en memoria.
//
//  ── Estructura en disco ────────────────────────────────────────────────────
//
//      Documents/Escaneos/<UUID en mayúsculas>/
//          escaneo.json     metadatos (ScanMetadata, ver docs/FORMATO-ESCANEO.md)
//          nube.bin         nube de puntos en formato propio JSCN (lectura rápida)
//          malla.bin        malla triangular en formato propio JSCN
//          nube.ply         nube en PLY binario (interoperabilidad, best effort)
//          malla.obj        malla en Wavefront OBJ (interoperabilidad, best effort)
//          miniatura.jpg    miniatura 512 px para la galería
//
//  Los archivos `.ply` / `.obj` los escribe `ScanExporter` y existen para que el
//  usuario pueda sacar la carpeta tal cual. Para volver a cargar el escaneo en
//  la app NO se parsea texto: se usan `nube.bin` y `malla.bin`, cuyo formato se
//  define y documenta aquí mismo (ver `AlmacenJSCN`).
//

import Foundation
import Combine
import UIKit

// MARK: - Trabajo fuera del hilo principal

/// Cola serial propia donde ocurre todo el trabajo pesado de disco. Al ser
/// serial, dos escrituras nunca se pisan.
private let colaAlmacenJoseScan = DispatchQueue(label: "com.josemaps.josescan.almacen",
                                                qos: .userInitiated)

/// Puente entre la cola de disco y `async/await`.
public enum TrabajoEnSegundoPlano {

    /// Ejecuta `trabajo` en la cola de disco y devuelve su resultado o su error.
    public static func lanzando<T>(_ trabajo: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (continuacion: CheckedContinuation<T, Error>) in
            colaAlmacenJoseScan.async {
                do {
                    let valor = try trabajo()
                    continuacion.resume(returning: valor)
                } catch {
                    continuacion.resume(throwing: error)
                }
            }
        }
    }

    /// Igual que `lanzando`, para trabajos que no fallan.
    public static func simple<T>(_ trabajo: @escaping () -> T) async -> T {
        await withCheckedContinuation { (continuacion: CheckedContinuation<T, Never>) in
            colaAlmacenJoseScan.async {
                continuacion.resume(returning: trabajo())
            }
        }
    }
}

// MARK: - Escritura binaria little-endian

/// Acumulador de bytes en little-endian explícito (no depende de la máquina).
struct EscritorJSCN {

    private(set) var bytes: [UInt8] = []

    mutating func reservar(_ n: Int) {
        bytes.reserveCapacity(bytes.count + n)
    }

    mutating func u8(_ v: UInt8) {
        bytes.append(v)
    }

    mutating func u16(_ v: UInt16) {
        bytes.append(UInt8(truncatingIfNeeded: v))
        bytes.append(UInt8(truncatingIfNeeded: v >> 8))
    }

    mutating func u32(_ v: UInt32) {
        bytes.append(UInt8(truncatingIfNeeded: v))
        bytes.append(UInt8(truncatingIfNeeded: v >> 8))
        bytes.append(UInt8(truncatingIfNeeded: v >> 16))
        bytes.append(UInt8(truncatingIfNeeded: v >> 24))
    }

    /// Float de 32 bits IEEE-754 guardado por su patrón de bits.
    mutating func f32(_ v: Float) {
        u32(v.bitPattern)
    }

    mutating func crudos(_ v: [UInt8]) {
        bytes.append(contentsOf: v)
    }

    var datos: Data { Data(bytes) }
}

// MARK: - Lectura binaria little-endian

/// Lector secuencial con validación de tamaños. Cualquier lectura que se salga
/// del búfer lanza `ScanError.formatoInvalido`.
struct LectorJSCN {

    private let bytes: [UInt8]
    private var indice = 0

    init(_ datos: Data) {
        self.bytes = [UInt8](datos)
    }

    var restantes: Int { bytes.count - indice }
    var posicion: Int { indice }
    var total: Int { bytes.count }

    private func verificar(_ n: Int, _ que: String) throws {
        guard n >= 0, indice + n <= bytes.count else {
            throw ScanError.formatoInvalido("archivo JSCN truncado al leer \(que)")
        }
    }

    mutating func u8(_ que: String = "byte") throws -> UInt8 {
        try verificar(1, que)
        let v = bytes[indice]
        indice += 1
        return v
    }

    mutating func u16(_ que: String = "entero de 16 bits") throws -> UInt16 {
        try verificar(2, que)
        let v = UInt16(bytes[indice]) | (UInt16(bytes[indice + 1]) << 8)
        indice += 2
        return v
    }

    mutating func u32(_ que: String = "entero de 32 bits") throws -> UInt32 {
        try verificar(4, que)
        let b0 = UInt32(bytes[indice])
        let b1 = UInt32(bytes[indice + 1]) << 8
        let b2 = UInt32(bytes[indice + 2]) << 16
        let b3 = UInt32(bytes[indice + 3]) << 24
        indice += 4
        return b0 | b1 | b2 | b3
    }

    mutating func f32(_ que: String = "flotante") throws -> Float {
        Float(bitPattern: try u32(que))
    }

    mutating func firma(_ esperada: [UInt8]) throws {
        try verificar(esperada.count, "la firma del archivo")
        for (i, esperado) in esperada.enumerated() where bytes[indice + i] != esperado {
            throw ScanError.formatoInvalido("firma JSCN incorrecta")
        }
        indice += esperada.count
    }

    mutating func saltar(_ n: Int, _ que: String = "relleno") throws {
        try verificar(n, que)
        indice += n
    }
}

// MARK: - Formato binario propio "JSCN"

/// Codificador/decodificador del formato binario propio de JoseScan.
///
/// ── Cabecera común (32 bytes, todo little-endian) ─────────────────────────
///
///     offset  tamaño  contenido
///     0       4       firma mágica ASCII "JSCN" (0x4A 0x53 0x43 0x4E)
///     4       2       versión del formato (UInt16) — actualmente 1
///     6       2       tipo de bloque (UInt16): 1 = nube de puntos, 2 = malla
///     8       1       marco (UInt8): 0 = arkit, 1 = enu
///     9       1       reservado (0)
///     10      2       banderas (UInt16), ver abajo
///     12      4       reservado (0)
///     16      4       conteo A (UInt32)
///     20      4       conteo B (UInt32)
///     24      4       conteo C (UInt32)
///     28      4       conteo D (UInt32)
///
/// ── Bloque tipo 1 · nube de puntos ────────────────────────────────────────
///
///     banderas: bit0 = trae color, bit1 = trae confianza
///     conteo A = número de posiciones
///     conteo B = número de colores  (0 ó igual a A)
///     conteo C = número de confianzas (0 ó igual a A)
///     conteo D = 0 (reservado)
///
///     cuerpo:  A × 12 bytes  posiciones  (x, y, z como Float32)
///              B × 3  bytes  colores     (r, g, b como UInt8)
///              C × 1  byte   confianzas  (0 baja, 1 media, 2 alta)
///
/// ── Bloque tipo 2 · malla triangular ──────────────────────────────────────
///
///     banderas: bit0 = trae normales, bit1 = trae clasificaciones
///     conteo A = número de vértices
///     conteo B = número de normales (0 ó igual a A)
///     conteo C = número de índices  (múltiplo de 3)
///     conteo D = número de clasificaciones (0 ó igual a C/3)
///
///     cuerpo:  A × 12 bytes  vértices        (x, y, z como Float32)
///              B × 12 bytes  normales        (x, y, z como Float32)
///              C ×  4 bytes  índices         (UInt32)
///              D ×  1 byte   clasificaciones (ScanFaceClass.rawValue)
///
/// El tamaño total del archivo debe ser exactamente 32 + cuerpo; si sobra o
/// falta un solo byte se lanza `ScanError.formatoInvalido`.
enum AlmacenJSCN {

    static let magia: [UInt8] = [0x4A, 0x53, 0x43, 0x4E]   // "JSCN"
    static let version: UInt16 = 1
    static let tamanoCabecera = 32

    static let tipoNube: UInt16 = 1
    static let tipoMalla: UInt16 = 2

    /// Banderas del bloque de nube.
    static let banderaColor: UInt16 = 1 << 0
    static let banderaConfianza: UInt16 = 1 << 1
    /// Banderas del bloque de malla.
    static let banderaNormales: UInt16 = 1 << 0
    static let banderaClases: UInt16 = 1 << 1

    // MARK: Cabecera

    private static func escribirCabecera(en escritor: inout EscritorJSCN,
                                         tipo: UInt16,
                                         marco: ScanCoordinateFrame,
                                         banderas: UInt16,
                                         a: Int, b: Int, c: Int, d: Int) {
        escritor.crudos(magia)
        escritor.u16(version)
        escritor.u16(tipo)
        escritor.u8(marco == .enu ? 1 : 0)
        escritor.u8(0)
        escritor.u16(banderas)
        escritor.u32(0)
        escritor.u32(UInt32(a))
        escritor.u32(UInt32(b))
        escritor.u32(UInt32(c))
        escritor.u32(UInt32(d))
    }

    private struct Cabecera {
        var tipo: UInt16
        var marco: ScanCoordinateFrame
        var banderas: UInt16
        var a: Int
        var b: Int
        var c: Int
        var d: Int
    }

    private static func leerCabecera(_ lector: inout LectorJSCN, tipoEsperado: UInt16) throws -> Cabecera {
        try lector.firma(magia)
        let ver = try lector.u16("la versión")
        guard ver == version else {
            throw ScanError.formatoInvalido("versión JSCN \(ver) no soportada (se esperaba \(version))")
        }
        let tipo = try lector.u16("el tipo de bloque")
        guard tipo == tipoEsperado else {
            throw ScanError.formatoInvalido("tipo de bloque JSCN \(tipo) inesperado")
        }
        let marcoBruto = try lector.u8("el marco")
        guard marcoBruto <= 1 else {
            throw ScanError.formatoInvalido("marco de coordenadas desconocido (\(marcoBruto))")
        }
        try lector.saltar(1, "el byte reservado")
        let banderas = try lector.u16("las banderas")
        try lector.saltar(4, "el campo reservado")
        let a = Int(try lector.u32("el conteo A"))
        let b = Int(try lector.u32("el conteo B"))
        let c = Int(try lector.u32("el conteo C"))
        let d = Int(try lector.u32("el conteo D"))
        return Cabecera(tipo: tipo,
                        marco: marcoBruto == 1 ? .enu : .arkit,
                        banderas: banderas,
                        a: a, b: b, c: c, d: d)
    }

    // MARK: Nube de puntos

    static func escribirNube(_ nube: PointCloud) -> Data {
        let n = nube.positions.count
        let colores = nube.colors.count == n ? nube.colors : []
        let confianzas = nube.confidences.count == n ? nube.confidences : []
        var banderas: UInt16 = 0
        if !colores.isEmpty { banderas |= banderaColor }
        if !confianzas.isEmpty { banderas |= banderaConfianza }

        var escritor = EscritorJSCN()
        escritor.reservar(tamanoCabecera + n * 12 + colores.count * 3 + confianzas.count)
        escribirCabecera(en: &escritor, tipo: tipoNube, marco: nube.frame, banderas: banderas,
                         a: n, b: colores.count, c: confianzas.count, d: 0)
        for p in nube.positions {
            escritor.f32(p.x)
            escritor.f32(p.y)
            escritor.f32(p.z)
        }
        for c in colores {
            escritor.u8(c.x)
            escritor.u8(c.y)
            escritor.u8(c.z)
        }
        for c in confianzas {
            escritor.u8(c)
        }
        return escritor.datos
    }

    static func leerNube(_ datos: Data) throws -> PointCloud {
        var lector = LectorJSCN(datos)
        let cab = try leerCabecera(&lector, tipoEsperado: tipoNube)

        guard cab.b == 0 || cab.b == cab.a else {
            throw ScanError.formatoInvalido("la nube trae \(cab.b) colores para \(cab.a) puntos")
        }
        guard cab.c == 0 || cab.c == cab.a else {
            throw ScanError.formatoInvalido("la nube trae \(cab.c) confianzas para \(cab.a) puntos")
        }
        let esperado = cab.a * 12 + cab.b * 3 + cab.c
        guard lector.restantes == esperado else {
            throw ScanError.formatoInvalido("la nube declara \(esperado) bytes de datos y trae \(lector.restantes)")
        }

        var posiciones = [SIMD3<Float>]()
        posiciones.reserveCapacity(cab.a)
        for _ in 0..<cab.a {
            let x = try lector.f32("una posición")
            let y = try lector.f32("una posición")
            let z = try lector.f32("una posición")
            posiciones.append(SIMD3<Float>(x, y, z))
        }

        var colores = [SIMD3<UInt8>]()
        colores.reserveCapacity(cab.b)
        for _ in 0..<cab.b {
            let r = try lector.u8("un color")
            let g = try lector.u8("un color")
            let b = try lector.u8("un color")
            colores.append(SIMD3<UInt8>(r, g, b))
        }

        var confianzas = [UInt8]()
        confianzas.reserveCapacity(cab.c)
        for _ in 0..<cab.c {
            confianzas.append(try lector.u8("una confianza"))
        }

        let nube = PointCloud(positions: posiciones, colors: colores,
                              confidences: confianzas, frame: cab.marco)
        guard nube.isConsistent else {
            throw ScanError.formatoInvalido("los arreglos de la nube no son paralelos")
        }
        return nube
    }

    // MARK: Malla

    static func escribirMalla(_ malla: ScanMesh) -> Data {
        let nv = malla.vertices.count
        let normales = malla.normals.count == nv ? malla.normals : []
        let indices = malla.indices
        let clases = malla.classifications.count == indices.count / 3 ? malla.classifications : []
        var banderas: UInt16 = 0
        if !normales.isEmpty { banderas |= banderaNormales }
        if !clases.isEmpty { banderas |= banderaClases }

        var escritor = EscritorJSCN()
        escritor.reservar(tamanoCabecera + nv * 12 + normales.count * 12 + indices.count * 4 + clases.count)
        escribirCabecera(en: &escritor, tipo: tipoMalla, marco: malla.frame, banderas: banderas,
                         a: nv, b: normales.count, c: indices.count, d: clases.count)
        for v in malla.vertices {
            escritor.f32(v.x)
            escritor.f32(v.y)
            escritor.f32(v.z)
        }
        for n in normales {
            escritor.f32(n.x)
            escritor.f32(n.y)
            escritor.f32(n.z)
        }
        for i in indices {
            escritor.u32(i)
        }
        for c in clases {
            escritor.u8(c.rawValue)
        }
        return escritor.datos
    }

    static func leerMalla(_ datos: Data) throws -> ScanMesh {
        var lector = LectorJSCN(datos)
        let cab = try leerCabecera(&lector, tipoEsperado: tipoMalla)

        guard cab.b == 0 || cab.b == cab.a else {
            throw ScanError.formatoInvalido("la malla trae \(cab.b) normales para \(cab.a) vértices")
        }
        guard cab.c % 3 == 0 else {
            throw ScanError.formatoInvalido("la malla trae \(cab.c) índices, que no es múltiplo de 3")
        }
        guard cab.d == 0 || cab.d == cab.c / 3 else {
            throw ScanError.formatoInvalido("la malla trae \(cab.d) clasificaciones para \(cab.c / 3) caras")
        }
        let esperado = cab.a * 12 + cab.b * 12 + cab.c * 4 + cab.d
        guard lector.restantes == esperado else {
            throw ScanError.formatoInvalido("la malla declara \(esperado) bytes de datos y trae \(lector.restantes)")
        }

        var vertices = [SIMD3<Float>]()
        vertices.reserveCapacity(cab.a)
        for _ in 0..<cab.a {
            let x = try lector.f32("un vértice")
            let y = try lector.f32("un vértice")
            let z = try lector.f32("un vértice")
            vertices.append(SIMD3<Float>(x, y, z))
        }

        var normales = [SIMD3<Float>]()
        normales.reserveCapacity(cab.b)
        for _ in 0..<cab.b {
            let x = try lector.f32("una normal")
            let y = try lector.f32("una normal")
            let z = try lector.f32("una normal")
            normales.append(SIMD3<Float>(x, y, z))
        }

        let limite = UInt32(cab.a)
        var indices = [UInt32]()
        indices.reserveCapacity(cab.c)
        for _ in 0..<cab.c {
            let i = try lector.u32("un índice")
            guard i < limite else {
                throw ScanError.formatoInvalido("índice \(i) fuera de rango (\(cab.a) vértices)")
            }
            indices.append(i)
        }

        var clases = [ScanFaceClass]()
        clases.reserveCapacity(cab.d)
        for _ in 0..<cab.d {
            let bruto = try lector.u8("una clasificación")
            clases.append(ScanFaceClass(rawValue: bruto) ?? .none)
        }

        let malla = ScanMesh(vertices: vertices, normals: normales, indices: indices,
                             classifications: clases, frame: cab.marco)
        guard malla.isConsistent else {
            throw ScanError.formatoInvalido("la malla leída no es consistente")
        }
        return malla
    }
}

// MARK: - Acceso al sistema de archivos

/// Todas las operaciones de disco de la biblioteca. Es un tipo sin estado y sin
/// aislamiento de actor: se ejecuta siempre dentro de `TrabajoEnSegundoPlano`
/// salvo las lecturas puntuales y baratas.
enum AlmacenEnDisco {

    static let nombreRaiz = "Escaneos"
    static let archivoJSON = "escaneo.json"
    static let archivoNubeBin = "nube.bin"
    static let archivoMallaBin = "malla.bin"
    static let archivoNubePLY = "nube.ply"
    static let archivoMallaOBJ = "malla.obj"
    static let archivoMiniatura = "miniatura.jpg"

    // MARK: Rutas

    static var documentos: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
    }

    static var raiz: URL {
        documentos.appendingPathComponent(nombreRaiz, isDirectory: true)
    }

    static func carpeta(de id: UUID) -> URL {
        raiz.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    @discardableResult
    static func crearCarpeta(_ url: URL) throws -> URL {
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return url
        } catch {
            throw ScanError.escrituraFallida("no se pudo crear \(url.lastPathComponent): \(error.localizedDescription)")
        }
    }

    // MARK: Metadatos

    static func leerMetadatos(en carpeta: URL) throws -> ScanMetadata {
        let url = carpeta.appendingPathComponent(archivoJSON)
        guard let datos = FileManager.default.contents(atPath: url.path) else {
            throw ScanError.formatoInvalido("falta \(archivoJSON) en \(carpeta.lastPathComponent)")
        }
        do {
            return try ScanMetadata.jsonDecoder().decode(ScanMetadata.self, from: datos)
        } catch {
            throw ScanError.formatoInvalido("\(archivoJSON) ilegible: \(error.localizedDescription)")
        }
    }

    static func escribirMetadatos(_ meta: ScanMetadata, en carpeta: URL) throws {
        try crearCarpeta(carpeta)
        let url = carpeta.appendingPathComponent(archivoJSON)
        do {
            let datos = try ScanMetadata.jsonEncoder().encode(meta)
            try datos.write(to: url, options: [.atomic])
        } catch let error as ScanError {
            throw error
        } catch {
            throw ScanError.escrituraFallida("\(archivoJSON): \(error.localizedDescription)")
        }
    }

    // MARK: Listado

    static func listar() -> (metas: [ScanMetadata], tamanos: [UUID: Int64]) {
        var metas: [ScanMetadata] = []
        var tamanos: [UUID: Int64] = [:]
        let fm = FileManager.default
        guard let contenido = try? fm.contentsOfDirectory(at: raiz,
                                                          includingPropertiesForKeys: [.isDirectoryKey],
                                                          options: [.skipsHiddenFiles]) else {
            return ([], [:])
        }
        for url in contenido {
            var esDirectorio: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &esDirectorio), esDirectorio.boolValue else { continue }
            guard let meta = try? leerMetadatos(en: url) else { continue }
            metas.append(meta)
            tamanos[meta.id] = tamanoCarpeta(url)
        }
        metas.sort { $0.creado > $1.creado }
        return (metas, tamanos)
    }

    static func tamanoCarpeta(_ url: URL) -> Int64 {
        let fm = FileManager.default
        guard let enumerador = fm.enumerator(at: url,
                                             includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .fileSizeKey],
                                             options: []) else { return 0 }
        var total: Int64 = 0
        for elemento in enumerador {
            guard let archivo = elemento as? URL else { continue }
            let valores = try? archivo.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .fileSizeKey])
            let bytes = valores?.totalFileAllocatedSize ?? valores?.fileSize ?? 0
            total += Int64(bytes)
        }
        return total
    }

    // MARK: Guardado

    /// Escribe el escaneo completo en su carpeta y devuelve los metadatos ya
    /// actualizados (contadores, caja envolvente y nombres de archivo).
    static func guardar(_ doc: ScanDocument,
                        georreferenciar: Bool,
                        miniaturaJPEG: Data?) throws -> ScanMetadata {

        guard !doc.isEmpty || doc.metadata.puntos > 0 || doc.metadata.triangulos > 0 else {
            throw ScanError.sinDatos
        }

        // Georreferenciación opcional: si falla, el escaneo se guarda igual en
        // el marco de ARKit.
        if georreferenciar {
            try? GeoTransform.georreferenciar(doc)
        }
        doc.refreshMetadata()

        var meta = doc.metadata
        let carpetaEscaneo = try crearCarpeta(carpeta(de: meta.id))

        // 1. Geometría en formato propio (es la que se vuelve a leer).
        if !doc.cloud.isEmpty {
            let datos = AlmacenJSCN.escribirNube(doc.cloud)
            try escribirDatos(datos, en: carpetaEscaneo.appendingPathComponent(archivoNubeBin))
        } else {
            borrarSiExiste(carpetaEscaneo.appendingPathComponent(archivoNubeBin))
        }

        if !doc.mesh.isEmpty {
            let datos = AlmacenJSCN.escribirMalla(doc.mesh)
            try escribirDatos(datos, en: carpetaEscaneo.appendingPathComponent(archivoMallaBin))
        } else {
            borrarSiExiste(carpetaEscaneo.appendingPathComponent(archivoMallaBin))
        }

        // 2. Copias interoperables (PLY/OBJ). Si el exportador falla no se
        //    interrumpe el guardado: la geometría propia ya está en disco.
        var nombreNube: String? = doc.cloud.isEmpty ? nil : archivoNubeBin
        var nombreMalla: String? = doc.mesh.isEmpty ? nil : archivoMallaBin

        if !doc.cloud.isEmpty,
           let url = try? ScanExporter.exportar(doc, formato: .ply, a: carpetaEscaneo, nombreBase: "nube") {
            nombreNube = url.lastPathComponent
        }
        if !doc.mesh.isEmpty,
           let url = try? ScanExporter.exportar(doc, formato: .obj, a: carpetaEscaneo, nombreBase: "malla") {
            nombreMalla = url.lastPathComponent
        }

        // 3. Miniatura.
        var nombreMiniatura: String? = meta.archivoMiniatura
        if let jpeg = miniaturaJPEG {
            try escribirDatos(jpeg, en: carpetaEscaneo.appendingPathComponent(archivoMiniatura))
            nombreMiniatura = archivoMiniatura
        } else if FileManager.default.fileExists(atPath: carpetaEscaneo.appendingPathComponent(archivoMiniatura).path) {
            nombreMiniatura = archivoMiniatura
        }

        // 4. Metadatos.
        meta.archivoNube = nombreNube
        meta.archivoMalla = nombreMalla
        meta.archivoMiniatura = nombreMiniatura
        try escribirMetadatos(meta, en: carpetaEscaneo)
        doc.metadata = meta
        return meta
    }

    private static func escribirDatos(_ datos: Data, en url: URL) throws {
        do {
            try datos.write(to: url, options: [.atomic])
        } catch {
            throw ScanError.escrituraFallida("\(url.lastPathComponent): \(error.localizedDescription)")
        }
    }

    private static func borrarSiExiste(_ url: URL) {
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: Lectura del documento completo

    static func leerDocumento(id: UUID) throws -> ScanDocument {
        let carpetaEscaneo = carpeta(de: id)
        let meta = try leerMetadatos(en: carpetaEscaneo)

        let urlNube = carpetaEscaneo.appendingPathComponent(archivoNubeBin)
        let urlMalla = carpetaEscaneo.appendingPathComponent(archivoMallaBin)
        let fm = FileManager.default
        let hayNube = fm.fileExists(atPath: urlNube.path)
        let hayMalla = fm.fileExists(atPath: urlMalla.path)

        guard hayNube || hayMalla || (meta.puntos == 0 && meta.triangulos == 0) else {
            throw ScanError.formatoInvalido("no se encontró geometría binaria (\(archivoNubeBin) / \(archivoMallaBin))")
        }

        var nube = PointCloud(frame: meta.marco)
        if hayNube {
            guard let datos = fm.contents(atPath: urlNube.path) else {
                throw ScanError.formatoInvalido("no se pudo leer \(archivoNubeBin)")
            }
            nube = try AlmacenJSCN.leerNube(datos)
        }

        var malla = ScanMesh(frame: meta.marco)
        if hayMalla {
            guard let datos = fm.contents(atPath: urlMalla.path) else {
                throw ScanError.formatoInvalido("no se pudo leer \(archivoMallaBin)")
            }
            malla = try AlmacenJSCN.leerMalla(datos)
        }

        return ScanDocument(metadata: meta, cloud: nube, mesh: malla)
    }

    // MARK: Borrado

    static func eliminar(id: UUID) throws {
        let url = carpeta(de: id)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            throw ScanError.escrituraFallida("no se pudo eliminar el escaneo: \(error.localizedDescription)")
        }
    }

    static func vaciar() throws {
        let fm = FileManager.default
        guard let contenido = try? fm.contentsOfDirectory(at: raiz,
                                                          includingPropertiesForKeys: nil,
                                                          options: []) else { return }
        var fallo: String?
        for url in contenido {
            do {
                try fm.removeItem(at: url)
            } catch {
                fallo = error.localizedDescription
            }
        }
        if let fallo {
            throw ScanError.escrituraFallida("no se pudo vaciar la carpeta de escaneos: \(fallo)")
        }
    }

    // MARK: Miniaturas

    static func leerMiniatura(id: UUID) -> UIImage? {
        let url = carpeta(de: id).appendingPathComponent(archivoMiniatura)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }

    /// Reduce la imagen a un cuadro de `lado` puntos y la codifica en JPEG.
    static func miniaturaJPEG(_ imagen: UIImage, lado: CGFloat = 512, calidad: CGFloat = 0.82) -> Data? {
        let tamano = imagen.size
        guard tamano.width > 0, tamano.height > 0 else { return nil }
        let escala = min(lado / tamano.width, lado / tamano.height, 1)
        let destino = CGSize(width: max(1, (tamano.width * escala).rounded()),
                             height: max(1, (tamano.height * escala).rounded()))
        let formato = UIGraphicsImageRendererFormat.default()
        formato.scale = 1
        formato.opaque = true
        let render = UIGraphicsImageRenderer(size: destino, format: formato)
        let reducida = render.image { _ in
            imagen.draw(in: CGRect(origin: .zero, size: destino))
        }
        return reducida.jpegData(compressionQuality: calidad)
    }
}

// MARK: - Galería en memoria

/// Fuente de verdad de la biblioteca de escaneos para toda la interfaz.
@MainActor
public final class ScanStore: ObservableObject {

    /// Escaneos disponibles, del más reciente al más antiguo.
    @Published public private(set) var escaneos: [ScanMetadata] = []

    /// Verdadero mientras se recorre la carpeta de escaneos.
    @Published public private(set) var cargando: Bool = false

    /// Tamaño en disco de cada escaneo, en bytes.
    private var tamanos: [UUID: Int64] = [:]

    private let cacheMiniaturas: NSCache<NSString, UIImage>

    /// El inicializador no toca estado aislado al actor principal: puede
    /// llamarse desde cualquier contexto (por ejemplo dentro de un
    /// `@StateObject` o de una propiedad de la escena).
    public nonisolated init() {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 120
        self.cacheMiniaturas = cache
        // La primera lectura del disco se agenda en el hilo principal.
        Task { @MainActor in
            self.cargar()
        }
    }

    // MARK: Carga

    /// Relee la carpeta de escaneos en segundo plano y publica el resultado.
    public func cargar() {
        guard !cargando else { return }
        cargando = true
        Task { [weak self] in
            let resultado = await TrabajoEnSegundoPlano.simple { AlmacenEnDisco.listar() }
            guard let self else { return }
            self.escaneos = resultado.metas
            self.tamanos = resultado.tamanos
            self.cargando = false
        }
    }

    // MARK: Guardado

    /// Guarda el documento en `Documents/Escaneos/<id>/` fuera del hilo
    /// principal y devuelve los metadatos definitivos.
    @discardableResult
    public func guardar(_ doc: ScanDocument, miniatura: UIImage?) async throws -> ScanMetadata {
        doc.refreshMetadata()

        var meta = doc.metadata
        if meta.nombre.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            meta.nombre = ScanStore.nombrePorDefecto(fecha: meta.creado)
        }
        if meta.dispositivo.isEmpty { meta.dispositivo = ScanStore.modeloDispositivo() }
        if meta.sistema.isEmpty { meta.sistema = "iOS " + UIDevice.current.systemVersion }
        if (meta.proyecto ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            meta.proyecto = AppSettings.proyectoActualGuardado()
        }

        // Se trabaja sobre una copia por valor de la geometría para no exponer
        // el documento original al hilo de disco.
        let copia = ScanDocument(metadata: meta, cloud: doc.cloud, mesh: doc.mesh)
        let jpeg = miniatura.flatMap { AlmacenEnDisco.miniaturaJPEG($0) }
        let georreferenciar = AppSettings.georreferenciarAlGuardarActivo()

        let guardada = try await TrabajoEnSegundoPlano.lanzando {
            try AlmacenEnDisco.guardar(copia, georreferenciar: georreferenciar, miniaturaJPEG: jpeg)
        }

        // El documento en memoria queda igual al de disco (marco ENU incluido).
        doc.metadata = guardada
        doc.cloud = copia.cloud
        doc.mesh = copia.mesh

        escaneos.removeAll { $0.id == guardada.id }
        escaneos.append(guardada)
        escaneos.sort { $0.creado > $1.creado }
        tamanos[guardada.id] = AlmacenEnDisco.tamanoCarpeta(AlmacenEnDisco.carpeta(de: guardada.id))
        if let jpeg, let imagen = UIImage(data: jpeg) {
            cacheMiniaturas.setObject(imagen, forKey: guardada.id.uuidString as NSString)
        }
        return guardada
    }

    // MARK: Lectura

    /// Reconstruye el `ScanDocument` completo desde disco.
    public func documento(de id: UUID) throws -> ScanDocument {
        try AlmacenEnDisco.leerDocumento(id: id)
    }

    /// Igual que `documento(de:)` pero sin bloquear el hilo principal.
    public func documentoEnSegundoPlano(de id: UUID) async throws -> ScanDocument {
        try await TrabajoEnSegundoPlano.lanzando {
            try AlmacenEnDisco.leerDocumento(id: id)
        }
    }

    /// Metadatos en memoria del escaneo indicado.
    public func metadatos(de id: UUID) -> ScanMetadata? {
        escaneos.first { $0.id == id }
    }

    // MARK: Mutaciones

    public func eliminar(_ id: UUID) throws {
        try AlmacenEnDisco.eliminar(id: id)
        escaneos.removeAll { $0.id == id }
        tamanos.removeValue(forKey: id)
        cacheMiniaturas.removeObject(forKey: id.uuidString as NSString)
    }

    public func renombrar(_ id: UUID, a nombre: String) throws {
        guard var meta = escaneos.first(where: { $0.id == id }) ?? (try? AlmacenEnDisco.leerMetadatos(en: AlmacenEnDisco.carpeta(de: id))) else {
            throw ScanError.formatoInvalido("el escaneo indicado ya no existe")
        }
        let limpio = nombre.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !limpio.isEmpty else {
            throw ScanError.formatoInvalido("el nombre no puede quedar vacío")
        }
        meta.nombre = limpio
        try actualizar(meta)
    }

    public func actualizar(_ meta: ScanMetadata) throws {
        try AlmacenEnDisco.escribirMetadatos(meta, en: AlmacenEnDisco.carpeta(de: meta.id))
        if let indice = escaneos.firstIndex(where: { $0.id == meta.id }) {
            escaneos[indice] = meta
        } else {
            escaneos.append(meta)
        }
        escaneos.sort { $0.creado > $1.creado }
        tamanos[meta.id] = AlmacenEnDisco.tamanoCarpeta(AlmacenEnDisco.carpeta(de: meta.id))
    }

    /// Borra todos los escaneos del dispositivo.
    public func vaciarTodo() throws {
        try AlmacenEnDisco.vaciar()
        escaneos.removeAll()
        tamanos.removeAll()
        cacheMiniaturas.removeAllObjects()
    }

    // MARK: Rutas y recursos

    public func carpeta(de id: UUID) -> URL {
        let url = AlmacenEnDisco.carpeta(de: id)
        try? AlmacenEnDisco.crearCarpeta(url)
        return url
    }

    public func miniatura(de id: UUID) -> UIImage? {
        let clave = id.uuidString as NSString
        if let cacheada = cacheMiniaturas.object(forKey: clave) { return cacheada }
        guard let imagen = AlmacenEnDisco.leerMiniatura(id: id) else { return nil }
        cacheMiniaturas.setObject(imagen, forKey: clave)
        return imagen
    }

    /// Miniatura leída fuera del hilo principal (para listas y grillas).
    public func miniaturaEnSegundoPlano(de id: UUID) async -> UIImage? {
        let clave = id.uuidString as NSString
        if let cacheada = cacheMiniaturas.object(forKey: clave) { return cacheada }
        let imagen = await TrabajoEnSegundoPlano.simple { AlmacenEnDisco.leerMiniatura(id: id) }
        if let imagen { cacheMiniaturas.setObject(imagen, forKey: clave) }
        return imagen
    }

    // MARK: Espacio

    public func espacioUsadoBytes() -> Int64 {
        tamanos.values.reduce(Int64(0)) { $0 + $1 }
    }

    public func tamanoBytes(de id: UUID) -> Int64 {
        tamanos[id] ?? 0
    }

    // MARK: Ayudas estáticas

    static func nombrePorDefecto(fecha: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "es_CO")
        f.dateFormat = "dd/MM/yyyy HH:mm"
        return "Escaneo " + f.string(from: fecha)
    }

    static func modeloDispositivo() -> String {
        var info = utsname()
        uname(&info)
        let capacidad = MemoryLayout.size(ofValue: info.machine)
        let identificador = withUnsafePointer(to: &info.machine) { puntero -> String in
            puntero.withMemoryRebound(to: CChar.self, capacity: capacidad) {
                String(cString: $0)
            }
        }
        return identificador.isEmpty ? UIDevice.current.model : identificador
    }
}
