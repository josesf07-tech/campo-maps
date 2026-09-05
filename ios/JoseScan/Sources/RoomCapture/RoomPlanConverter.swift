//
//  RoomPlanConverter.swift
//  JoseScan
//
//  Convierte una habitación reconstruida por RoomPlan (`CapturedRoom`) al
//  documento propio de JoseScan (`ScanDocument`), calcula mediciones
//  automáticas, dibuja una miniatura de planta y exporta USDZ.
//
//  Convenciones de RoomPlan usadas aquí:
//  - `Surface.dimensions` = (ancho, alto, espesor) en metros, en el sistema
//    local de la superficie; el plano local es XY y la normal es +Z.
//  - `Object.dimensions`  = (ancho, alto, fondo) de la caja envolvente.
//  - `transform` lleva del sistema local al sistema de ARKit (+Y arriba).
//

import Foundation
import CoreGraphics
import UIKit
import simd

#if canImport(RoomPlan)
import RoomPlan

// MARK: - Resumen para la interfaz

/// Un elemento del plano listo para mostrarse en una lista.
@available(iOS 17.0, *)
public struct RoomItemResumen: Identifiable {
    public let id: UUID
    /// "Muro", "Puerta", "Ventana", "Abertura", "Piso" o el nombre del objeto.
    public let tipo: String
    /// Nombre de un SF Symbol representativo.
    public let icono: String
    /// Dimensiones en metros.
    public let dimensiones: SIMD3<Float>
    /// Verdadero si el elemento es volumétrico (objeto) y no una superficie.
    public let esVolumen: Bool

    public init(id: UUID, tipo: String, icono: String, dimensiones: SIMD3<Float>, esVolumen: Bool) {
        self.id = id
        self.tipo = tipo
        self.icono = icono
        self.dimensiones = dimensiones
        self.esVolumen = esVolumen
    }

    /// Texto de dimensiones en metros, con dos decimales.
    public var descripcionDimensiones: String {
        if esVolumen {
            return String(format: "%.2f × %.2f × %.2f m",
                          Double(dimensiones.x), Double(dimensiones.y), Double(dimensiones.z))
        }
        return String(format: "%.2f × %.2f m", Double(dimensiones.x), Double(dimensiones.y))
    }
}

/// Agrupación de todos los elementos detectados en la habitación.
@available(iOS 17.0, *)
public struct RoomResumen {
    public var muros: [RoomItemResumen] = []
    public var puertas: [RoomItemResumen] = []
    public var ventanas: [RoomItemResumen] = []
    public var aberturas: [RoomItemResumen] = []
    public var pisos: [RoomItemResumen] = []
    public var objetos: [RoomItemResumen] = []
    /// Área de piso en m².
    public var areaPiso: Double = 0
    /// Perímetro sumando el ancho de todos los muros, en m.
    public var perimetro: Double = 0
    /// Altura media de los muros, en m.
    public var alturaMedia: Double = 0
    /// Verdadero si el área de piso se estimó con la huella de los muros.
    public var areaEstimada: Bool = false

    public init() {}

    public var totalElementos: Int {
        muros.count + puertas.count + ventanas.count + aberturas.count + pisos.count + objetos.count
    }
}

// MARK: - Conversor

@available(iOS 17.0, *)
public enum RoomPlanConverter {

    // MARK: Documento completo

    /// Convierte la habitación en un `ScanDocument` con malla, metadatos y
    /// mediciones automáticas listas para guardar o exportar.
    public static func convertir(_ room: CapturedRoom,
                                 nombre: String? = nil,
                                 geo: GeoReference? = nil,
                                 duracionSegundos: Double = 0,
                                 proyecto: String? = nil) -> ScanDocument {
        let malla = construirMalla(de: room)
        let resumenSala = resumen(de: room)

        let nombreFinal: String = {
            let propuesto = (nombre ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return propuesto.isEmpty ? nombrePorDefecto() : propuesto
        }()

        let metadata = ScanMetadata(nombre: nombreFinal,
                                    dispositivo: identificadorDispositivo(),
                                    sistema: versionSistema(),
                                    sensor: "lidar",
                                    marco: .arkit,
                                    geo: geo,
                                    duracionSegundos: duracionSegundos,
                                    mediciones: mediciones(de: room),
                                    proyecto: proyecto,
                                    notas: notas(de: room, resumen: resumenSala))

        let documento = ScanDocument(metadata: metadata, cloud: PointCloud(frame: .arkit), mesh: malla)
        // Sincroniza contadores y caja envolvente con la malla recién construida.
        documento.refreshMetadata()
        return documento
    }

    /// Nombre por defecto: "Interior 5 sep 2026 14:22".
    public static func nombrePorDefecto(fecha: Date = Date()) -> String {
        return "Interior " + formateadorFecha.string(from: fecha)
    }

    // MARK: Malla

    /// Construye una malla triangular con todas las superficies y objetos.
    public static func construirMalla(de room: CapturedRoom) -> ScanMesh {
        var malla = ScanMesh(frame: .arkit)

        for muro in room.walls {
            agregarSuperficie(muro, clase: .wall, en: &malla)
        }
        for piso in room.floors {
            agregarSuperficie(piso, clase: .floor, en: &malla)
        }
        for puerta in room.doors {
            agregarSuperficie(puerta, clase: .door, en: &malla)
        }
        for ventana in room.windows {
            agregarSuperficie(ventana, clase: .window, en: &malla)
        }
        // Las aberturas son vanos sin hoja; se agrupan con las puertas porque
        // representan un paso y así quedan juntas al exportar por clasificación.
        for abertura in room.openings {
            agregarSuperficie(abertura, clase: .door, en: &malla)
        }

        // Techo sintético: RoomPlan no lo entrega, se levanta el piso a la
        // altura media de los muros para cerrar el volumen.
        let altura = alturaMediaMuros(de: room)
        if altura > 0.1 {
            for piso in room.floors {
                var transformTecho = piso.transform
                transformTecho.columns.3.y += Float(altura)
                agregarSuperficiePlana(transform: transformTecho,
                                       ancho: abs(piso.dimensions.x),
                                       alto: abs(piso.dimensions.y),
                                       clase: .ceiling,
                                       en: &malla)
            }
        }

        for objeto in room.objects {
            agregarCaja(transform: objeto.transform,
                        tamano: objeto.dimensions,
                        clase: claseDe(objeto.category),
                        en: &malla)
        }

        return malla
    }

    /// Añade una superficie: caja si tiene espesor apreciable, plano si no.
    private static func agregarSuperficie(_ superficie: CapturedRoom.Surface,
                                          clase: ScanFaceClass,
                                          en malla: inout ScanMesh) {
        let d = superficie.dimensions
        let ancho = abs(d.x)
        let alto = abs(d.y)
        let espesor = abs(d.z)
        guard ancho > 0.001, alto > 0.001 else { return }
        if espesor > 0.01 {
            agregarCaja(transform: superficie.transform,
                        tamano: SIMD3<Float>(ancho, alto, espesor),
                        clase: clase,
                        en: &malla)
        } else {
            agregarSuperficiePlana(transform: superficie.transform,
                                   ancho: ancho,
                                   alto: alto,
                                   clase: clase,
                                   en: &malla)
        }
    }

    /// Dos triángulos en el plano local XY (normal +Z).
    private static func agregarSuperficiePlana(transform: simd_float4x4,
                                               ancho: Float,
                                               alto: Float,
                                               clase: ScanFaceClass,
                                               en malla: inout ScanMesh) {
        guard ancho > 0.001, alto > 0.001 else { return }
        let hx = ancho / 2
        let hy = alto / 2
        let esquinas = [
            SIMD3<Float>(-hx, -hy, 0),
            SIMD3<Float>(hx, -hy, 0),
            SIMD3<Float>(hx, hy, 0),
            SIMD3<Float>(-hx, hy, 0)
        ]
        agregarCara(esquinas, normal: SIMD3<Float>(0, 0, 1), transform: transform, clase: clase, en: &malla)
    }

    /// Doce triángulos (seis caras) para una caja centrada en el origen local.
    private static func agregarCaja(transform: simd_float4x4,
                                    tamano: SIMD3<Float>,
                                    clase: ScanFaceClass,
                                    en malla: inout ScanMesh) {
        let hx = abs(tamano.x) / 2
        let hy = abs(tamano.y) / 2
        let hz = abs(tamano.z) / 2
        guard hx > 0.0005, hy > 0.0005, hz > 0.0005 else { return }

        // Cada cara con sus cuatro esquinas en sentido antihorario vista desde fuera.
        let caras: [(esquinas: [SIMD3<Float>], normal: SIMD3<Float>)] = [
            ([SIMD3<Float>(hx, -hy, hz), SIMD3<Float>(hx, -hy, -hz),
              SIMD3<Float>(hx, hy, -hz), SIMD3<Float>(hx, hy, hz)], SIMD3<Float>(1, 0, 0)),
            ([SIMD3<Float>(-hx, -hy, -hz), SIMD3<Float>(-hx, -hy, hz),
              SIMD3<Float>(-hx, hy, hz), SIMD3<Float>(-hx, hy, -hz)], SIMD3<Float>(-1, 0, 0)),
            ([SIMD3<Float>(-hx, hy, hz), SIMD3<Float>(hx, hy, hz),
              SIMD3<Float>(hx, hy, -hz), SIMD3<Float>(-hx, hy, -hz)], SIMD3<Float>(0, 1, 0)),
            ([SIMD3<Float>(-hx, -hy, -hz), SIMD3<Float>(hx, -hy, -hz),
              SIMD3<Float>(hx, -hy, hz), SIMD3<Float>(-hx, -hy, hz)], SIMD3<Float>(0, -1, 0)),
            ([SIMD3<Float>(-hx, -hy, hz), SIMD3<Float>(hx, -hy, hz),
              SIMD3<Float>(hx, hy, hz), SIMD3<Float>(-hx, hy, hz)], SIMD3<Float>(0, 0, 1)),
            ([SIMD3<Float>(hx, -hy, -hz), SIMD3<Float>(-hx, -hy, -hz),
              SIMD3<Float>(-hx, hy, -hz), SIMD3<Float>(hx, hy, -hz)], SIMD3<Float>(0, 0, -1))
        ]

        for cara in caras {
            agregarCara(cara.esquinas, normal: cara.normal, transform: transform, clase: clase, en: &malla)
        }
    }

    /// Añade un cuadrilátero (dos triángulos) transformado al marco de ARKit.
    private static func agregarCara(_ esquinas: [SIMD3<Float>],
                                    normal: SIMD3<Float>,
                                    transform: simd_float4x4,
                                    clase: ScanFaceClass,
                                    en malla: inout ScanMesh) {
        guard esquinas.count == 4 else { return }
        let base = UInt32(malla.vertices.count)
        let normalMundo = rotar(normal, transform)
        for esquina in esquinas {
            malla.vertices.append(transformar(esquina, transform))
            malla.normals.append(normalMundo)
        }
        malla.indices.append(contentsOf: [base, base + 1, base + 2])
        malla.indices.append(contentsOf: [base, base + 2, base + 3])
        malla.classifications.append(clase)
        malla.classifications.append(clase)
    }

    // MARK: Mediciones automáticas

    /// Mediciones derivadas del plano: área de piso, perímetro, altura media y
    /// volumen aproximado. El conteo de puertas y ventanas no encaja en
    /// `MeasurementKind`, por eso viaja en `notas`.
    public static func mediciones(de room: CapturedRoom) -> [MeasurementRecord] {
        var lista: [MeasurementRecord] = []
        let ahora = Date()

        let huella = huellaHorizontal(de: room)
        let nivel = nivelPiso(de: room)
        let area = areaPiso(de: room)
        if area > 0.01 {
            let puntos: [[Float]]
            if let huella {
                puntos = [
                    [huella.minX, nivel, huella.minZ],
                    [huella.maxX, nivel, huella.minZ],
                    [huella.maxX, nivel, huella.maxZ],
                    [huella.minX, nivel, huella.maxZ]
                ]
            } else {
                puntos = []
            }
            lista.append(MeasurementRecord(kind: .area,
                                           value: area,
                                           unit: "m²",
                                           points: puntos,
                                           label: room.floors.isEmpty ? "Área de piso (estimada)" : "Área de piso",
                                           createdAt: ahora))
        }

        let perimetro = perimetroMuros(de: room)
        if perimetro > 0.01 {
            var puntos: [[Float]] = []
            for muro in room.walls {
                let mitad = abs(muro.dimensions.x) / 2
                let a = transformar(SIMD3<Float>(-mitad, 0, 0), muro.transform)
                let b = transformar(SIMD3<Float>(mitad, 0, 0), muro.transform)
                puntos.append([a.x, a.y, a.z])
                puntos.append([b.x, b.y, b.z])
            }
            lista.append(MeasurementRecord(kind: .distancia,
                                           value: perimetro,
                                           unit: "m",
                                           points: puntos,
                                           label: "Perímetro de muros",
                                           createdAt: ahora))
        }

        let altura = alturaMediaMuros(de: room)
        if altura > 0.01 {
            lista.append(MeasurementRecord(kind: .altura,
                                           value: altura,
                                           unit: "m",
                                           points: [[0, nivel, 0], [0, nivel + Float(altura), 0]],
                                           label: "Altura media de muros",
                                           createdAt: ahora))
        }

        if area > 0.01 && altura > 0.01 {
            lista.append(MeasurementRecord(kind: .volumen,
                                           value: area * altura,
                                           unit: "m³",
                                           points: [],
                                           label: "Volumen aproximado",
                                           createdAt: ahora))
        }

        return lista
    }

    /// Área de piso en m². Usa las superficies de piso; si no hay, estima con la
    /// huella rectangular de los muros.
    public static func areaPiso(de room: CapturedRoom) -> Double {
        if !room.floors.isEmpty {
            var total = 0.0
            for piso in room.floors {
                total += Double(abs(piso.dimensions.x) * abs(piso.dimensions.y))
            }
            if total > 0.01 { return total }
        }
        guard let huella = huellaHorizontal(de: room) else { return 0 }
        let ancho = Double(huella.maxX - huella.minX)
        let fondo = Double(huella.maxZ - huella.minZ)
        guard ancho > 0, fondo > 0 else { return 0 }
        return ancho * fondo
    }

    /// Suma del ancho de todos los muros, en metros.
    public static func perimetroMuros(de room: CapturedRoom) -> Double {
        var total = 0.0
        for muro in room.walls {
            total += Double(abs(muro.dimensions.x))
        }
        return total
    }

    /// Altura media de los muros, en metros.
    public static func alturaMediaMuros(de room: CapturedRoom) -> Double {
        guard !room.walls.isEmpty else { return 0 }
        var total = 0.0
        for muro in room.walls {
            total += Double(abs(muro.dimensions.y))
        }
        return total / Double(room.walls.count)
    }

    /// Altura (Y) del piso en el marco de ARKit.
    private static func nivelPiso(de room: CapturedRoom) -> Float {
        if let piso = room.floors.first {
            return piso.transform.columns.3.y
        }
        var minimo = Float.greatestFiniteMagnitude
        for muro in room.walls {
            let base = muro.transform.columns.3.y - abs(muro.dimensions.y) / 2
            minimo = Swift.min(minimo, base)
        }
        return minimo == Float.greatestFiniteMagnitude ? 0 : minimo
    }

    /// Rectángulo envolvente horizontal (plano XZ de ARKit) de muros y pisos.
    private static func huellaHorizontal(de room: CapturedRoom)
        -> (minX: Float, maxX: Float, minZ: Float, maxZ: Float)? {
        var minX = Float.greatestFiniteMagnitude
        var maxX = -Float.greatestFiniteMagnitude
        var minZ = Float.greatestFiniteMagnitude
        var maxZ = -Float.greatestFiniteMagnitude
        var hayPuntos = false

        func acumular(_ superficies: [CapturedRoom.Surface]) {
            for superficie in superficies {
                let hx = abs(superficie.dimensions.x) / 2
                let hy = abs(superficie.dimensions.y) / 2
                let locales = [
                    SIMD3<Float>(-hx, -hy, 0), SIMD3<Float>(hx, -hy, 0),
                    SIMD3<Float>(hx, hy, 0), SIMD3<Float>(-hx, hy, 0)
                ]
                for local in locales {
                    let p = transformar(local, superficie.transform)
                    minX = Swift.min(minX, p.x)
                    maxX = Swift.max(maxX, p.x)
                    minZ = Swift.min(minZ, p.z)
                    maxZ = Swift.max(maxZ, p.z)
                    hayPuntos = true
                }
            }
        }

        acumular(room.walls)
        acumular(room.floors)
        guard hayPuntos, maxX > minX, maxZ > minZ else { return nil }
        return (minX, maxX, minZ, maxZ)
    }

    // MARK: Resumen

    /// Arma las listas que muestra `RoomSummaryView`.
    public static func resumen(de room: CapturedRoom) -> RoomResumen {
        var salida = RoomResumen()
        salida.muros = room.walls.map {
            RoomItemResumen(id: $0.identifier, tipo: "Muro", icono: "rectangle.portrait",
                            dimensiones: $0.dimensions, esVolumen: false)
        }
        salida.puertas = room.doors.map {
            RoomItemResumen(id: $0.identifier, tipo: "Puerta", icono: "door.left.hand.closed",
                            dimensiones: $0.dimensions, esVolumen: false)
        }
        salida.ventanas = room.windows.map {
            RoomItemResumen(id: $0.identifier, tipo: "Ventana", icono: "window.casement",
                            dimensiones: $0.dimensions, esVolumen: false)
        }
        salida.aberturas = room.openings.map {
            RoomItemResumen(id: $0.identifier, tipo: "Abertura", icono: "rectangle.portrait.slash",
                            dimensiones: $0.dimensions, esVolumen: false)
        }
        salida.pisos = room.floors.map {
            RoomItemResumen(id: $0.identifier, tipo: "Piso", icono: "square.split.bottomrightquarter",
                            dimensiones: $0.dimensions, esVolumen: false)
        }
        salida.objetos = room.objects.map {
            RoomItemResumen(id: $0.identifier,
                            tipo: nombreObjeto($0.category),
                            icono: iconoObjeto($0.category),
                            dimensiones: $0.dimensions,
                            esVolumen: true)
        }
        salida.areaPiso = areaPiso(de: room)
        salida.perimetro = perimetroMuros(de: room)
        salida.alturaMedia = alturaMediaMuros(de: room)
        salida.areaEstimada = room.floors.isEmpty
        return salida
    }

    /// Notas descriptivas con los conteos que no encajan en `MeasurementKind`.
    public static func notas(de room: CapturedRoom, resumen salida: RoomResumen) -> String {
        var partes: [String] = []
        partes.append("Interior capturado con RoomPlan.")
        partes.append("Muros: \(room.walls.count).")
        partes.append("Puertas: \(room.doors.count).")
        partes.append("Ventanas: \(room.windows.count).")
        partes.append("Aberturas: \(room.openings.count).")
        partes.append("Pisos: \(room.floors.count).")
        partes.append("Objetos: \(room.objects.count).")
        if salida.areaEstimada {
            partes.append("El área de piso es una estimación a partir de la huella de los muros.")
        } else {
            partes.append("El área de piso es la suma de los rectángulos de piso detectados.")
        }
        partes.append("El techo se generó levantando el piso a la altura media de los muros.")
        return partes.joined(separator: " ")
    }

    // MARK: Exportación USDZ

    /// URL temporal con nombre seguro para compartir el USDZ.
    public static func urlTemporalUSDZ(nombre: String) -> URL {
        let limpio = ScanExporter.nombreSeguro(nombre.isEmpty ? nombrePorDefecto() : nombre)
        let carpeta = FileManager.default.temporaryDirectory
            .appendingPathComponent("JoseScanInteriores", isDirectory: true)
        try? FileManager.default.createDirectory(at: carpeta, withIntermediateDirectories: true)
        return carpeta.appendingPathComponent(limpio).appendingPathExtension("usdz")
    }

    /// Exporta la habitación a USDZ usando la API paramétrica de RoomPlan.
    public static func exportarUSDZ(_ room: CapturedRoom, a url: URL) throws {
        let carpeta = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: carpeta, withIntermediateDirectories: true)
        } catch {
            throw ScanError.escrituraFallida("No se pudo crear la carpeta de destino: \(error.localizedDescription)")
        }
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: url)
        }
        do {
            try room.export(to: url, exportOptions: .parametric)
        } catch {
            throw ScanError.escrituraFallida("RoomPlan no pudo exportar el USDZ: \(error.localizedDescription)")
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ScanError.escrituraFallida("El archivo USDZ no se generó.")
        }
    }

    // MARK: Miniatura de planta

    /// Dibuja una planta simple (muros, puertas y ventanas) para la galería.
    public static func miniatura(de room: CapturedRoom,
                                 tamano: CGSize = CGSize(width: 512, height: 512)) -> UIImage? {
        struct Segmento {
            let a: CGPoint
            let b: CGPoint
            let color: UIColor
            let grosor: CGFloat
        }

        var segmentos: [Segmento] = []

        func agregar(_ superficies: [CapturedRoom.Surface], color: UIColor, grosor: CGFloat) {
            for superficie in superficies {
                let mitad = abs(superficie.dimensions.x) / 2
                guard mitad > 0.001 else { continue }
                let a = transformar(SIMD3<Float>(-mitad, 0, 0), superficie.transform)
                let b = transformar(SIMD3<Float>(mitad, 0, 0), superficie.transform)
                segmentos.append(Segmento(a: CGPoint(x: CGFloat(a.x), y: CGFloat(a.z)),
                                          b: CGPoint(x: CGFloat(b.x), y: CGFloat(b.z)),
                                          color: color,
                                          grosor: grosor))
            }
        }

        agregar(room.walls, color: UIColor(white: 0.16, alpha: 1), grosor: 6)
        agregar(room.openings, color: UIColor(red: 0.55, green: 0.55, blue: 0.58, alpha: 1), grosor: 5)
        agregar(room.doors, color: UIColor(red: 0.95, green: 0.60, blue: 0.10, alpha: 1), grosor: 5)
        agregar(room.windows, color: UIColor(red: 0.13, green: 0.55, blue: 0.90, alpha: 1), grosor: 5)

        guard !segmentos.isEmpty else { return nil }

        var minX = CGFloat.greatestFiniteMagnitude
        var maxX = -CGFloat.greatestFiniteMagnitude
        var minY = CGFloat.greatestFiniteMagnitude
        var maxY = -CGFloat.greatestFiniteMagnitude
        for segmento in segmentos {
            for punto in [segmento.a, segmento.b] {
                minX = Swift.min(minX, punto.x)
                maxX = Swift.max(maxX, punto.x)
                minY = Swift.min(minY, punto.y)
                maxY = Swift.max(maxY, punto.y)
            }
        }
        let ancho = Swift.max(maxX - minX, 0.001)
        let alto = Swift.max(maxY - minY, 0.001)
        let margen: CGFloat = 32
        let escala = Swift.min((tamano.width - 2 * margen) / ancho,
                               (tamano.height - 2 * margen) / alto)
        let centroX = (minX + maxX) / 2
        let centroY = (minY + maxY) / 2

        func aPantalla(_ punto: CGPoint) -> CGPoint {
            // El eje Z de ARKit crece hacia el observador: se invierte para que
            // la planta quede con el norte del recorrido hacia arriba.
            return CGPoint(x: tamano.width / 2 + (punto.x - centroX) * escala,
                           y: tamano.height / 2 - (punto.y - centroY) * escala)
        }

        let renderizador = UIGraphicsImageRenderer(size: tamano)
        return renderizador.image { contexto in
            let cg = contexto.cgContext
            UIColor(white: 0.97, alpha: 1).setFill()
            cg.fill(CGRect(origin: .zero, size: tamano))
            cg.setLineCap(.round)
            for segmento in segmentos {
                cg.setStrokeColor(segmento.color.cgColor)
                cg.setLineWidth(segmento.grosor)
                cg.beginPath()
                cg.move(to: aPantalla(segmento.a))
                cg.addLine(to: aPantalla(segmento.b))
                cg.strokePath()
            }
        }
    }

    // MARK: Clasificación de objetos

    /// Equivalencia entre las categorías de RoomPlan y `ScanFaceClass`.
    /// Sólo mesa y asiento tienen equivalente directo; el resto va sin clasificar.
    public static func claseDe(_ categoria: CapturedRoom.Object.Category) -> ScanFaceClass {
        switch categoria {
        case .table:
            return .table
        case .chair, .sofa, .bed:
            return .seat
        default:
            return .none
        }
    }

    /// Nombre en español de la categoría del objeto.
    public static func nombreObjeto(_ categoria: CapturedRoom.Object.Category) -> String {
        switch categoria {
        case .storage: return "Almacenamiento"
        case .refrigerator: return "Nevera"
        case .stove: return "Estufa"
        case .bed: return "Cama"
        case .sink: return "Lavamanos"
        case .washerDryer: return "Lavadora / secadora"
        case .toilet: return "Sanitario"
        case .bathtub: return "Tina"
        case .oven: return "Horno"
        case .dishwasher: return "Lavavajillas"
        case .table: return "Mesa"
        case .sofa: return "Sofá"
        case .chair: return "Silla"
        case .fireplace: return "Chimenea"
        case .television: return "Televisor"
        case .stairs: return "Escalera"
        default: return "Objeto"
        }
    }

    /// SF Symbol representativo de la categoría del objeto.
    public static func iconoObjeto(_ categoria: CapturedRoom.Object.Category) -> String {
        switch categoria {
        case .storage: return "archivebox"
        case .refrigerator: return "refrigerator"
        case .stove: return "flame"
        case .bed: return "bed.double"
        case .sink: return "drop"
        case .washerDryer: return "washer"
        case .toilet: return "toilet"
        case .bathtub: return "bathtub"
        case .oven: return "oven"
        case .dishwasher: return "dishwasher"
        case .table: return "table.furniture"
        case .sofa: return "sofa"
        case .chair: return "chair"
        case .fireplace: return "fireplace"
        case .television: return "tv"
        case .stairs: return "stairs"
        default: return "cube"
        }
    }

    // MARK: Utilidades de álgebra

    /// Lleva un punto del sistema local de la superficie al marco de ARKit.
    static func transformar(_ punto: SIMD3<Float>, _ matriz: simd_float4x4) -> SIMD3<Float> {
        let resultado = matriz * SIMD4<Float>(punto.x, punto.y, punto.z, 1)
        return SIMD3<Float>(resultado.x, resultado.y, resultado.z)
    }

    /// Rota (sin trasladar) una normal y la normaliza.
    static func rotar(_ normal: SIMD3<Float>, _ matriz: simd_float4x4) -> SIMD3<Float> {
        let resultado = matriz * SIMD4<Float>(normal.x, normal.y, normal.z, 0)
        let vector = SIMD3<Float>(resultado.x, resultado.y, resultado.z)
        let longitud = simd_length(vector)
        return longitud > 0.00001 ? vector / longitud : SIMD3<Float>(0, 1, 0)
    }

    // MARK: Identificación del dispositivo

    private static let formateadorFecha: DateFormatter = {
        let formateador = DateFormatter()
        formateador.locale = Locale(identifier: "es_CO")
        formateador.dateFormat = "d MMM yyyy HH:mm"
        return formateador
    }()

    /// Identificador de hardware, p. ej. "iPhone16,1".
    private static func identificadorDispositivo() -> String {
        var informacion = utsname()
        uname(&informacion)
        let espejo = Mirror(reflecting: informacion.machine)
        var texto = ""
        for hijo in espejo.children {
            guard let byte = hijo.value as? Int8, byte != 0 else { continue }
            texto.append(Character(UnicodeScalar(UInt8(bitPattern: byte))))
        }
        return texto.isEmpty ? "iOS" : texto
    }

    /// Versión del sistema, p. ej. "iOS 18.2".
    private static func versionSistema() -> String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return "iOS \(version.majorVersion).\(version.minorVersion)"
    }
}

#endif
