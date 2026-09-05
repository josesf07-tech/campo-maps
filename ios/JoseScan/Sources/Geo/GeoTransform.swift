//
//  GeoTransform.swift
//  JoseScan
//
//  Conversión entre el marco local de ARKit, el marco geodésico local ENU y
//  coordenadas geográficas WGS84 / MAGNA-SIRGAS.
//
//  Ver docs/FORMATO-ESCANEO.md §3. Con `h` = rumbo verdadero (en radianes) del
//  eje −Z de ARKit en el instante del anclaje:
//
//      este   = x·cos h + z·sin h
//      norte  = x·sin h − z·cos h
//      arriba = y
//
//  Es una rotación propia (determinante +1) alrededor de la vertical, así que
//  conserva distancias, ángulos y el sentido de giro de los triángulos: los
//  índices de la malla no se tocan y las normales se rotan con la misma matriz.
//

import Foundation
import simd

public enum GeoTransform {

    // MARK: - Constantes del elipsoide WGS84
    //
    //  Se usa WGS84 (y no GRS80) porque los radios de curvatura sirven para
    //  convertir desplazamientos ENU en latitud/longitud reportadas por
    //  CoreLocation, que trabaja en WGS84. La diferencia entre ambos elipsoides
    //  (Δ(1/f) ≈ 1,5·10⁻⁹) es irrelevante a escala de un escaneo.

    /// Semieje mayor WGS84, en metros.
    public static let semiejeMayorWGS84: Double = 6_378_137.0
    /// Achatamiento WGS84 (1/f = 298,257223563).
    public static let achatamientoWGS84: Double = 1.0 / 298.257223563
    /// Primera excentricidad al cuadrado del WGS84.
    public static let excentricidadCuadradaWGS84: Double =
        GeoTransform.achatamientoWGS84 * (2.0 - GeoTransform.achatamientoWGS84)

    // MARK: - ARKit → ENU

    /// Convierte un punto del marco de ARKit al marco ENU.
    ///
    /// - Parameters:
    ///   - p: punto en metros, marco ARKit (+X derecha, +Y arriba, −Z hacia la cámara).
    ///   - rumboGrados: rumbo verdadero del eje −Z de ARKit, en grados desde el norte.
    /// - Returns: punto en metros, marco ENU (+X Este, +Y Norte, +Z Arriba).
    public static func arkitAEnu(_ p: SIMD3<Float>, rumboGrados: Double) -> SIMD3<Float> {
        let h = rumboGrados * Double.pi / 180.0
        return GeoTransform.rotar(p, senH: Float(sin(h)), cosH: Float(cos(h)))
    }

    /// Convierte una nube de puntos completa al marco ENU.
    /// Si la nube ya está en ENU se devuelve intacta.
    public static func arkitAEnu(_ nube: PointCloud, rumboGrados: Double) -> PointCloud {
        guard nube.frame == .arkit else { return nube }
        let h = rumboGrados * Double.pi / 180.0
        let senH = Float(sin(h))
        let cosH = Float(cos(h))

        var salida = nube
        salida.frame = .enu
        if !nube.positions.isEmpty {
            var convertidas = [SIMD3<Float>]()
            convertidas.reserveCapacity(nube.positions.count)
            for p in nube.positions {
                convertidas.append(GeoTransform.rotar(p, senH: senH, cosH: cosH))
            }
            salida.positions = convertidas
        }
        return salida
    }

    /// Convierte una malla completa al marco ENU (vértices y normales).
    /// Si la malla ya está en ENU se devuelve intacta.
    public static func arkitAEnu(_ malla: ScanMesh, rumboGrados: Double) -> ScanMesh {
        guard malla.frame == .arkit else { return malla }
        let h = rumboGrados * Double.pi / 180.0
        let senH = Float(sin(h))
        let cosH = Float(cos(h))

        var salida = malla
        salida.frame = .enu

        if !malla.vertices.isEmpty {
            var v = [SIMD3<Float>]()
            v.reserveCapacity(malla.vertices.count)
            for p in malla.vertices {
                v.append(GeoTransform.rotar(p, senH: senH, cosH: cosH))
            }
            salida.vertices = v
        }

        // Las normales son direcciones: la misma rotación, sin traslación.
        if !malla.normals.isEmpty {
            var n = [SIMD3<Float>]()
            n.reserveCapacity(malla.normals.count)
            for d in malla.normals {
                n.append(GeoTransform.rotar(d, senH: senH, cosH: cosH))
            }
            salida.normals = n
        }

        // La rotación tiene determinante +1: el orden de los índices se conserva.
        return salida
    }

    /// Rotación inversa ENU → ARKit (útil para dibujar en el visor un punto
    /// definido en coordenadas geodésicas).
    public static func enuAArkit(_ p: SIMD3<Float>, rumboGrados: Double) -> SIMD3<Float> {
        let h = rumboGrados * Double.pi / 180.0
        let senH = Float(sin(h))
        let cosH = Float(cos(h))
        // Transpuesta de la matriz directa:
        //   x =  e·cos h + n·sin h
        //   y =  u
        //   z =  e·sin h − n·cos h
        let x = p.x * cosH + p.y * senH
        let y = p.z
        let z = p.x * senH - p.y * cosH
        return SIMD3<Float>(x, y, z)
    }

    // MARK: - ENU ↔ WGS84 (aproximación plana local)

    /// Convierte un desplazamiento ENU respecto del ancla a coordenadas
    /// geográficas WGS84, usando los radios de curvatura del elipsoide
    /// evaluados en la latitud del origen (válido para decenas o centenares de
    /// metros, que es la escala de un escaneo LiDAR).
    public static func enuAWGS84(este: Double, norte: Double, arriba: Double,
                                 origen: GeoReference) -> (lat: Double, lon: Double, alt: Double) {
        let radios = GeoTransform.radiosDeCurvatura(latitudGrados: origen.latitude)
        let lat0 = origen.latitude * Double.pi / 180.0

        let dLat = norte / radios.meridiano
        let denominador = radios.primerVertical * cos(lat0)
        let dLon = abs(denominador) > 1e-9 ? (este / denominador) : 0.0

        let lat = origen.latitude + dLat * 180.0 / Double.pi
        let lon = origen.longitude + dLon * 180.0 / Double.pi
        let alt = origen.altitude + arriba
        return (lat: lat, lon: lon, alt: alt)
    }

    /// Operación inversa de `enuAWGS84`.
    public static func wgs84AEnu(lat: Double, lon: Double, alt: Double,
                                 origen: GeoReference) -> (este: Double, norte: Double, arriba: Double) {
        let radios = GeoTransform.radiosDeCurvatura(latitudGrados: origen.latitude)
        let lat0 = origen.latitude * Double.pi / 180.0

        var dLonGrados = lon - origen.longitude
        // Cruce del antimeridiano (por robustez; no ocurre en Colombia).
        while dLonGrados > 180.0 { dLonGrados -= 360.0 }
        while dLonGrados < -180.0 { dLonGrados += 360.0 }

        let dLat = (lat - origen.latitude) * Double.pi / 180.0
        let dLon = dLonGrados * Double.pi / 180.0

        let norte = dLat * radios.meridiano
        let este = dLon * radios.primerVertical * cos(lat0)
        let arriba = alt - origen.altitude
        return (este: este, norte: norte, arriba: arriba)
    }

    /// Radios de curvatura del elipsoide WGS84 en una latitud dada, en metros.
    /// - `meridiano` (M): usado para convertir metros hacia el norte en latitud.
    /// - `primerVertical` (N): usado, multiplicado por cos φ, para el este.
    public static func radiosDeCurvatura(latitudGrados: Double) -> (meridiano: Double, primerVertical: Double) {
        let a = GeoTransform.semiejeMayorWGS84
        let e2 = GeoTransform.excentricidadCuadradaWGS84
        let phi = latitudGrados * Double.pi / 180.0
        let sen = sin(phi)
        let W = 1.0 - e2 * sen * sen
        let raizW = sqrt(W)
        let primerVertical = a / raizW
        let meridiano = a * (1.0 - e2) / (W * raizW)
        return (meridiano: meridiano, primerVertical: primerVertical)
    }

    // MARK: - Georreferenciación del documento

    /// Lleva un `ScanDocument` completo al marco ENU usando su ancla GPS.
    ///
    /// - Lanza `ScanError.sinGeorreferencia` si el documento no tiene ancla.
    /// - No hace nada si el documento ya está en `.enu` (sólo completa el
    ///   Norte/Este MAGNA-SIRGAS del ancla si faltaba).
    /// - Al terminar, la nube, la malla y `metadata.marco` quedan en `.enu`,
    ///   `metadata.geo!.norte` / `.este` traen las coordenadas EPSG:9377 del
    ///   origen y los contadores/bbox se recalculan con `refreshMetadata()`.
    public static func georreferenciar(_ doc: ScanDocument) throws {
        guard var geo = doc.metadata.geo else {
            throw ScanError.sinGeorreferencia
        }

        let yaEnEnu = doc.metadata.marco == .enu
            && doc.cloud.frame == .enu
            && doc.mesh.frame == .enu

        if yaEnEnu {
            // Ya está georreferenciado: sólo se asegura el par MAGNA-SIRGAS.
            if geo.norte == nil || geo.este == nil {
                let magna = MagnaSirgas.desdeWGS84(lat: geo.latitude, lon: geo.longitude)
                geo.norte = magna.norte
                geo.este = magna.este
                doc.metadata.geo = geo
            }
            return
        }

        let rumbo = geo.heading

        if doc.cloud.frame == .arkit {
            doc.cloud = GeoTransform.arkitAEnu(doc.cloud, rumboGrados: rumbo)
        }
        if doc.mesh.frame == .arkit {
            doc.mesh = GeoTransform.arkitAEnu(doc.mesh, rumboGrados: rumbo)
        }

        // Las mediciones guardadas están expresadas en el marco anterior:
        // se rotan para que sigan coincidiendo con la geometría.
        if !doc.metadata.mediciones.isEmpty {
            doc.metadata.mediciones = doc.metadata.mediciones.map { registro in
                var copia = registro
                copia.points = registro.points.map { componentes -> [Float] in
                    guard componentes.count == 3 else { return componentes }
                    let p = SIMD3<Float>(componentes[0], componentes[1], componentes[2])
                    let e = GeoTransform.arkitAEnu(p, rumboGrados: rumbo)
                    return [e.x, e.y, e.z]
                }
                return copia
            }
        }

        // Coordenadas planas oficiales del origen (EPSG:9377).
        let magna = MagnaSirgas.desdeWGS84(lat: geo.latitude, lon: geo.longitude)
        geo.norte = magna.norte
        geo.este = magna.este
        doc.metadata.geo = geo

        doc.refreshMetadata()
        // `refreshMetadata()` deduce el marco de la geometría; si el documento
        // está vacío hay que dejarlo explícito.
        doc.metadata.marco = .enu
    }

    // MARK: - Internos

    /// Rotación ARKit → ENU con el seno y el coseno ya calculados.
    private static func rotar(_ p: SIMD3<Float>, senH: Float, cosH: Float) -> SIMD3<Float> {
        let este = p.x * cosH + p.z * senH
        let norte = p.x * senH - p.z * cosH
        let arriba = p.y
        return SIMD3<Float>(este, norte, arriba)
    }
}
