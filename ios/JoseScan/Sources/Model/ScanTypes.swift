//
//  ScanTypes.swift
//  JoseScan
//
//  CONTRATO COMPARTIDO — tipos base usados por todos los módulos de la app.
//  Sólo depende de Foundation y simd (no importa ARKit) para poder usarse en
//  pruebas unitarias y en cualquier capa (captura, render, exportación, geo).
//

import Foundation
import simd

// MARK: - Geometría básica

/// Caja envolvente alineada a los ejes, en metros.
public struct BoundingBox: Codable, Equatable {
    public var min: SIMD3<Float>
    public var max: SIMD3<Float>

    public init(min: SIMD3<Float>, max: SIMD3<Float>) {
        self.min = min
        self.max = max
    }

    /// Caja "vacía" preparada para acumular puntos con `expand(_:)`.
    public static var empty: BoundingBox {
        BoundingBox(min: SIMD3<Float>(repeating: .greatestFiniteMagnitude),
                    max: SIMD3<Float>(repeating: -.greatestFiniteMagnitude))
    }

    public var isEmpty: Bool { min.x > max.x || min.y > max.y || min.z > max.z }

    public var center: SIMD3<Float> { isEmpty ? .zero : (min + max) / 2 }

    public var size: SIMD3<Float> { isEmpty ? .zero : max - min }

    /// Diagonal en metros (0 si la caja está vacía).
    public var diagonal: Float { isEmpty ? 0 : simd_length(size) }

    public mutating func expand(_ p: SIMD3<Float>) {
        min = simd_min(min, p)
        max = simd_max(max, p)
    }

    public mutating func expand(_ other: BoundingBox) {
        guard !other.isEmpty else { return }
        expand(other.min)
        expand(other.max)
    }

    // Codable manual: SIMD3<Float> se serializa como [x, y, z].
    private enum CodingKeys: String, CodingKey { case min, max }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let mn = try c.decode([Float].self, forKey: .min)
        let mx = try c.decode([Float].self, forKey: .max)
        guard mn.count == 3, mx.count == 3 else {
            throw ScanError.formatoInvalido("BoundingBox requiere 3 componentes")
        }
        self.min = SIMD3<Float>(mn[0], mn[1], mn[2])
        self.max = SIMD3<Float>(mx[0], mx[1], mx[2])
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode([min.x, min.y, min.z], forKey: .min)
        try c.encode([max.x, max.y, max.z], forKey: .max)
    }
}

/// Sistema de referencia en el que están expresadas las coordenadas del escaneo.
public enum ScanCoordinateFrame: String, Codable {
    /// Marco local de ARKit: +X derecha, +Y arriba, -Z hacia donde mira la cámara.
    case arkit
    /// Marco geodésico local ENU: +X Este, +Y Norte, +Z Arriba (metros).
    case enu
}

// MARK: - Nube de puntos

/// Nube de puntos densa capturada desde el sensor LiDAR.
/// Los tres arreglos son paralelos y deben tener siempre el mismo tamaño.
public struct PointCloud {
    /// Posiciones en metros, en el marco indicado por `frame`.
    public var positions: [SIMD3<Float>]
    /// Color RGB por punto (muestreado de la cámara). Vacío si no hay color.
    public var colors: [SIMD3<UInt8>]
    /// Confianza del sensor por punto: 0 = baja, 1 = media, 2 = alta.
    public var confidences: [UInt8]
    public var frame: ScanCoordinateFrame

    public init(positions: [SIMD3<Float>] = [],
                colors: [SIMD3<UInt8>] = [],
                confidences: [UInt8] = [],
                frame: ScanCoordinateFrame = .arkit) {
        self.positions = positions
        self.colors = colors
        self.confidences = confidences
        self.frame = frame
    }

    public var count: Int { positions.count }
    public var isEmpty: Bool { positions.isEmpty }
    public var hasColor: Bool { colors.count == positions.count && !colors.isEmpty }

    public var bounds: BoundingBox {
        var box = BoundingBox.empty
        for p in positions { box.expand(p) }
        return box
    }

    public mutating func append(_ other: PointCloud) {
        positions.append(contentsOf: other.positions)
        colors.append(contentsOf: other.colors)
        confidences.append(contentsOf: other.confidences)
    }

    public mutating func reserveCapacity(_ n: Int) {
        positions.reserveCapacity(n)
        colors.reserveCapacity(n)
        confidences.reserveCapacity(n)
    }

    /// Verdadero si los arreglos paralelos son consistentes.
    public var isConsistent: Bool {
        (colors.isEmpty || colors.count == positions.count) &&
        (confidences.isEmpty || confidences.count == positions.count)
    }
}

// MARK: - Malla

/// Clasificación semántica de una cara, equivalente a ARMeshClassification.
public enum ScanFaceClass: UInt8, Codable, CaseIterable {
    case none = 0, wall = 1, floor = 2, ceiling = 3, table = 4, seat = 5, window = 6, door = 7

    public var nombre: String {
        switch self {
        case .none: return "Sin clasificar"
        case .wall: return "Muro"
        case .floor: return "Piso"
        case .ceiling: return "Techo"
        case .table: return "Mesa"
        case .seat: return "Asiento"
        case .window: return "Ventana"
        case .door: return "Puerta"
        }
    }
}

/// Malla triangular reconstruida (scene reconstruction).
public struct ScanMesh {
    public var vertices: [SIMD3<Float>]
    public var normals: [SIMD3<Float>]
    /// Índices de triángulos: 3 por cara.
    public var indices: [UInt32]
    /// Clasificación por cara (`indices.count / 3` elementos) o vacío.
    public var classifications: [ScanFaceClass]
    public var frame: ScanCoordinateFrame

    public init(vertices: [SIMD3<Float>] = [],
                normals: [SIMD3<Float>] = [],
                indices: [UInt32] = [],
                classifications: [ScanFaceClass] = [],
                frame: ScanCoordinateFrame = .arkit) {
        self.vertices = vertices
        self.normals = normals
        self.indices = indices
        self.classifications = classifications
        self.frame = frame
    }

    public var vertexCount: Int { vertices.count }
    public var triangleCount: Int { indices.count / 3 }
    public var isEmpty: Bool { vertices.isEmpty || indices.count < 3 }
    public var hasNormals: Bool { normals.count == vertices.count && !normals.isEmpty }

    public var bounds: BoundingBox {
        var box = BoundingBox.empty
        for v in vertices { box.expand(v) }
        return box
    }

    /// Verdadero si todos los índices caen dentro del arreglo de vértices y
    /// el número de índices es múltiplo de 3.
    public var isConsistent: Bool {
        guard indices.count % 3 == 0 else { return false }
        let n = UInt32(vertices.count)
        for i in indices where i >= n { return false }
        return classifications.isEmpty || classifications.count == triangleCount
    }

    /// Área total de la superficie en m².
    public func surfaceArea() -> Double {
        var total = 0.0
        var i = 0
        while i + 2 < indices.count {
            let a = vertices[Int(indices[i])]
            let b = vertices[Int(indices[i + 1])]
            let c = vertices[Int(indices[i + 2])]
            total += Double(simd_length(simd_cross(b - a, c - a)) * 0.5)
            i += 3
        }
        return total
    }
}

// MARK: - Georreferenciación

/// Ancla geodésica del origen del marco local del escaneo.
public struct GeoReference: Codable, Equatable {
    public var latitude: Double
    public var longitude: Double
    /// Altitud elipsoidal/ortométrica reportada por CoreLocation, en metros.
    public var altitude: Double
    public var horizontalAccuracy: Double
    public var verticalAccuracy: Double
    /// Rumbo verdadero (grados desde el norte geográfico) del eje -Z de ARKit
    /// en el instante del anclaje.
    public var heading: Double
    public var headingAccuracy: Double
    public var timestamp: Date
    /// Norte MAGNA-SIRGAS Origen Nacional (EPSG:9377), metros.
    public var norte: Double?
    /// Este MAGNA-SIRGAS Origen Nacional (EPSG:9377), metros.
    public var este: Double?

    public init(latitude: Double, longitude: Double, altitude: Double = 0,
                horizontalAccuracy: Double = -1, verticalAccuracy: Double = -1,
                heading: Double = 0, headingAccuracy: Double = -1,
                timestamp: Date = Date(), norte: Double? = nil, este: Double? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.altitude = altitude
        self.horizontalAccuracy = horizontalAccuracy
        self.verticalAccuracy = verticalAccuracy
        self.heading = heading
        self.headingAccuracy = headingAccuracy
        self.timestamp = timestamp
        self.norte = norte
        self.este = este
    }

    /// Verdadero si la precisión permite usar el ancla para exportar en ENU.
    public var esConfiable: Bool {
        horizontalAccuracy >= 0 && horizontalAccuracy <= 20 &&
        headingAccuracy >= 0 && headingAccuracy <= 15
    }
}

// MARK: - Mediciones

public enum MeasurementKind: String, Codable {
    case distancia, area, volumen, altura, azimut
}

public struct MeasurementRecord: Codable, Identifiable, Equatable {
    public var id: UUID
    public var kind: MeasurementKind
    /// Valor en la unidad base del SI: m, m², m³ o grados para azimut.
    public var value: Double
    public var unit: String
    /// Puntos que definen la medición, en el marco del escaneo ([x, y, z] cada uno).
    public var points: [[Float]]
    public var label: String?
    public var createdAt: Date

    public init(id: UUID = UUID(), kind: MeasurementKind, value: Double, unit: String,
                points: [[Float]], label: String? = nil, createdAt: Date = Date()) {
        self.id = id
        self.kind = kind
        self.value = value
        self.unit = unit
        self.points = points
        self.label = label
        self.createdAt = createdAt
    }
}

// MARK: - Calidad del escaneo

public struct ScanQualityMetrics: Equatable {
    public var pointCount: Int = 0
    public var triangleCount: Int = 0
    /// Fracción de puntos con confianza alta (0…1).
    public var highConfidenceRatio: Double = 0
    /// Área reconstruida en m².
    public var coveredArea: Double = 0
    public var trackingOK: Bool = true
    public var trackingMessage: String = ""
    public var fps: Double = 0
    /// Temperatura/limitación térmica reportada por el sistema.
    public var thermalWarning: String?

    public init() {}

    /// Puntuación 0…100 para mostrar en la HUD.
    public var score: Int {
        guard pointCount > 0 else { return 0 }
        let densidad = Swift.min(1.0, Double(pointCount) / 400_000.0)
        let confianza = highConfidenceRatio
        let seguimiento = trackingOK ? 1.0 : 0.4
        return Int(((densidad * 0.4 + confianza * 0.4 + seguimiento * 0.2) * 100).rounded())
    }
}

// MARK: - Metadatos persistidos

/// Metadatos serializados en `escaneo.json` dentro del paquete `.josescan`.
/// Ver docs/FORMATO-ESCANEO.md — este contrato lo comparten la app iOS y la PWA.
public struct ScanMetadata: Codable, Identifiable, Equatable {
    public static let formatoActual = "josescan/1.0"

    public var formato: String
    public var id: UUID
    public var nombre: String
    public var creado: Date
    public var dispositivo: String
    public var sistema: String
    /// "lidar", "webxr" o "manual".
    public var sensor: String
    public var marco: ScanCoordinateFrame
    public var geo: GeoReference?
    public var puntos: Int
    public var vertices: Int
    public var triangulos: Int
    public var bbox: BoundingBox?
    public var duracionSegundos: Double
    public var mediciones: [MeasurementRecord]
    public var proyecto: String?
    public var notas: String?
    public var archivoNube: String?
    public var archivoMalla: String?
    public var archivoMiniatura: String?

    public init(id: UUID = UUID(),
                nombre: String,
                creado: Date = Date(),
                dispositivo: String = "",
                sistema: String = "",
                sensor: String = "lidar",
                marco: ScanCoordinateFrame = .arkit,
                geo: GeoReference? = nil,
                puntos: Int = 0,
                vertices: Int = 0,
                triangulos: Int = 0,
                bbox: BoundingBox? = nil,
                duracionSegundos: Double = 0,
                mediciones: [MeasurementRecord] = [],
                proyecto: String? = nil,
                notas: String? = nil,
                archivoNube: String? = nil,
                archivoMalla: String? = nil,
                archivoMiniatura: String? = nil) {
        self.formato = ScanMetadata.formatoActual
        self.id = id
        self.nombre = nombre
        self.creado = creado
        self.dispositivo = dispositivo
        self.sistema = sistema
        self.sensor = sensor
        self.marco = marco
        self.geo = geo
        self.puntos = puntos
        self.vertices = vertices
        self.triangulos = triangulos
        self.bbox = bbox
        self.duracionSegundos = duracionSegundos
        self.mediciones = mediciones
        self.proyecto = proyecto
        self.notas = notas
        self.archivoNube = archivoNube
        self.archivoMalla = archivoMalla
        self.archivoMiniatura = archivoMiniatura
    }

    /// Codificador/decodificador JSON con fechas ISO-8601, igual que la PWA.
    public static func jsonEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }

    public static func jsonDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

// MARK: - Documento en memoria

/// Escaneo completo: metadatos + geometría. Es una clase para poder pasarse
/// por referencia entre la sesión de captura, el visor y los exportadores.
public final class ScanDocument {
    public var metadata: ScanMetadata
    public var cloud: PointCloud
    public var mesh: ScanMesh

    public init(metadata: ScanMetadata, cloud: PointCloud = PointCloud(), mesh: ScanMesh = ScanMesh()) {
        self.metadata = metadata
        self.cloud = cloud
        self.mesh = mesh
    }

    /// Sincroniza los contadores y la caja envolvente de los metadatos con la
    /// geometría actual. Llamar antes de guardar o exportar.
    public func refreshMetadata() {
        metadata.puntos = cloud.count
        metadata.vertices = mesh.vertexCount
        metadata.triangulos = mesh.triangleCount
        metadata.marco = mesh.isEmpty ? cloud.frame : mesh.frame
        var box = BoundingBox.empty
        box.expand(cloud.bounds)
        box.expand(mesh.bounds)
        metadata.bbox = box.isEmpty ? nil : box
    }

    public var isEmpty: Bool { cloud.isEmpty && mesh.isEmpty }
}

// MARK: - Formatos de exportación

public enum ScanExportFormat: String, Codable, CaseIterable, Identifiable {
    case ply          // nube de puntos binaria
    case plyAscii     // nube de puntos en texto
    case obj          // malla + material
    case stl          // malla para impresión / CAD
    case usdz         // vista rápida AR en iOS
    case xyz          // texto plano para software topográfico
    case geojson      // huella georreferenciada para JoseMaps
    case csv          // listado de puntos/mediciones
    case bundle       // paquete .josescan (ZIP con todo)

    public var id: String { rawValue }

    public var extensionArchivo: String {
        switch self {
        case .ply, .plyAscii: return "ply"
        case .obj: return "obj"
        case .stl: return "stl"
        case .usdz: return "usdz"
        case .xyz: return "xyz"
        case .geojson: return "geojson"
        case .csv: return "csv"
        case .bundle: return "josescan"
        }
    }

    public var nombre: String {
        switch self {
        case .ply: return "PLY binario (nube de puntos)"
        case .plyAscii: return "PLY texto (nube de puntos)"
        case .obj: return "OBJ (malla)"
        case .stl: return "STL (malla)"
        case .usdz: return "USDZ (vista rápida AR)"
        case .xyz: return "XYZ (texto topográfico)"
        case .geojson: return "GeoJSON (huella para JoseMaps)"
        case .csv: return "CSV (puntos y mediciones)"
        case .bundle: return "Paquete .josescan (todo)"
        }
    }

    /// Verdadero si el formato describe una malla y no una nube de puntos.
    public var requiereMalla: Bool {
        switch self {
        case .obj, .stl, .usdz: return true
        default: return false
        }
    }
}

// MARK: - Errores

public enum ScanError: LocalizedError, Equatable {
    case sensorNoDisponible
    case sinDatos
    case sinMalla
    case sinGeorreferencia
    case formatoInvalido(String)
    case escrituraFallida(String)
    case permisoDenegado(String)
    case cancelado

    public var errorDescription: String? {
        switch self {
        case .sensorNoDisponible:
            return "Este dispositivo no tiene sensor LiDAR o ARKit no está disponible."
        case .sinDatos:
            return "El escaneo está vacío. Captura algo antes de continuar."
        case .sinMalla:
            return "Este formato requiere una malla reconstruida."
        case .sinGeorreferencia:
            return "El escaneo no tiene ancla GPS; actívala antes de exportar en coordenadas."
        case .formatoInvalido(let detalle):
            return "Formato inválido: \(detalle)"
        case .escrituraFallida(let detalle):
            return "No se pudo escribir el archivo: \(detalle)"
        case .permisoDenegado(let permiso):
            return "Permiso denegado: \(permiso)"
        case .cancelado:
            return "Operación cancelada."
        }
    }
}
