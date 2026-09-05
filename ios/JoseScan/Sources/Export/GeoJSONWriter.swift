//
//  GeoJSONWriter.swift
//  JoseScan
//
//  Genera `huella.geojson` según docs/FORMATO-ESCANEO.md (sección 6):
//  un `FeatureCollection` en WGS84 (EPSG:4326) con dos features —
//
//    1. `Point`   en el origen del escaneo, con las propiedades del escaneo
//                 (`id`, `nombre`, `puntos`, `triangulos`, `norte`, `este`).
//    2. `Polygon` con la proyección horizontal de la caja envolvente.
//
//  Es lo que la PWA JoseMaps superpone sobre el mapa Leaflet.
//
//  El JSON se construye a mano (no con `JSONSerialization`) para controlar
//  exactamente el número de decimales de cada coordenada y obtener una salida
//  determinista, byte a byte, entre ejecuciones.
//

import Foundation
import simd

public enum GeoJSONWriter {

    // MARK: - Elipsoide WGS84

    /// Semieje mayor del elipsoide WGS84, en metros.
    public static let semiejeMayor = 6_378_137.0
    /// Achatamiento del elipsoide WGS84.
    public static let achatamiento = 1.0 / 298.257223563

    /// Punto en el plano local ENU (metros respecto al origen del escaneo).
    public struct PuntoPlano: Equatable {
        public var este: Double
        public var norte: Double
        public init(este: Double, norte: Double) {
            self.este = este
            self.norte = norte
        }
    }

    /// Convierte un desplazamiento ENU (metros) a latitud/longitud WGS84 usando
    /// la aproximación local plana con los radios de curvatura del elipsoide en
    /// la latitud del origen. Suficiente para escaneos de decenas de metros.
    public static func wgs84(este: Double,
                             norte: Double,
                             origenLatitud: Double,
                             origenLongitud: Double) -> (latitud: Double, longitud: Double) {
        let e2 = achatamiento * (2.0 - achatamiento)
        let phi = origenLatitud * Double.pi / 180.0
        let senoPhi = sin(phi)
        let cosenoPhi = cos(phi)
        let w2 = 1.0 - e2 * senoPhi * senoPhi
        let w = w2.squareRoot()
        // Radio de curvatura del meridiano y de la primera vertical.
        let radioMeridiano = semiejeMayor * (1.0 - e2) / (w2 * w)
        let radioVertical = semiejeMayor / w

        let dLat = radioMeridiano > 0 ? norte / radioMeridiano : 0.0
        let dLon = abs(cosenoPhi) < 1e-12 ? 0.0 : este / (radioVertical * cosenoPhi)

        return (origenLatitud + dLat * 180.0 / Double.pi,
                origenLongitud + dLon * 180.0 / Double.pi)
    }

    // MARK: - Proyección horizontal de la caja envolvente

    /// Cuatro esquinas horizontales de la caja envolvente, ya expresadas en el
    /// plano ENU (Este, Norte) y ordenadas en sentido antihorario (regla de la
    /// mano derecha que exige RFC 7946 para el anillo exterior).
    ///
    /// - En marco `enu` el plano horizontal es X–Y (X = Este, Y = Norte).
    /// - En marco `arkit` el plano horizontal es X–Z y se rota con el rumbo:
    ///   `este = x·cos h − z·sin h`, `norte = −x·sin h − z·cos h`
    ///   (ver docs/FORMATO-ESCANEO.md §3; debe coincidir con GeoTransform).
    public static func esquinasHorizontales(bbox: BoundingBox,
                                            marco: ScanCoordinateFrame,
                                            rumboGrados: Double) -> [PuntoPlano] {
        guard !bbox.isEmpty else { return [] }

        var crudas: [PuntoPlano] = []
        switch marco {
        case .enu:
            let x0 = Double(bbox.min.x), x1 = Double(bbox.max.x)
            let y0 = Double(bbox.min.y), y1 = Double(bbox.max.y)
            crudas = [PuntoPlano(este: x0, norte: y0),
                      PuntoPlano(este: x1, norte: y0),
                      PuntoPlano(este: x1, norte: y1),
                      PuntoPlano(este: x0, norte: y1)]
        case .arkit:
            let h = rumboGrados * Double.pi / 180.0
            let cosH = cos(h), senH = sin(h)
            let x0 = Double(bbox.min.x), x1 = Double(bbox.max.x)
            let z0 = Double(bbox.min.z), z1 = Double(bbox.max.z)
            let pares: [(Double, Double)] = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
            crudas = pares.map { par in
                PuntoPlano(este: par.0 * cosH - par.1 * senH,
                           norte: -par.0 * senH - par.1 * cosH)
            }
        }

        // La rotación ARKit → ENU invierte la orientación del plano, así que el
        // sentido se comprueba siempre con el área con signo (fórmula del zapato).
        var area = 0.0
        for i in crudas.indices {
            let j = (i + 1) % crudas.count
            area += crudas[i].este * crudas[j].norte - crudas[j].este * crudas[i].norte
        }
        if area < 0 { crudas.reverse() }
        return crudas
    }

    /// Extensión vertical (metros) de la caja según el marco.
    public static func alturaCaja(_ bbox: BoundingBox, marco: ScanCoordinateFrame) -> Double {
        guard !bbox.isEmpty else { return 0 }
        switch marco {
        case .enu:   return Double(bbox.max.z - bbox.min.z)
        case .arkit: return Double(bbox.max.y - bbox.min.y)
        }
    }

    // MARK: - Salida principal

    /// Bytes UTF-8 del `FeatureCollection`.
    /// - Throws: `ScanError.sinGeorreferencia` si `meta.geo == nil`.
    public static func featureCollection(de meta: ScanMetadata) throws -> Data {
        let contenido = try texto(de: meta)
        return Data(contenido.utf8)
    }

    /// Texto del `FeatureCollection` (misma salida que `featureCollection`).
    /// - Throws: `ScanError.sinGeorreferencia` si `meta.geo == nil`.
    public static func texto(de meta: ScanMetadata) throws -> String {
        guard let geo = meta.geo else { throw ScanError.sinGeorreferencia }

        let esquinas: [PuntoPlano]
        if let caja = meta.bbox, !caja.isEmpty {
            esquinas = esquinasHorizontales(bbox: caja,
                                            marco: meta.marco,
                                            rumboGrados: geo.heading)
        } else {
            esquinas = []
        }

        // Esquinas proyectadas a WGS84.
        let geodesicas = esquinas.map {
            wgs84(este: $0.este, norte: $0.norte,
                  origenLatitud: geo.latitude, origenLongitud: geo.longitude)
        }

        var features: [String] = []
        features.append(featureOrigen(meta: meta, geo: geo))
        if geodesicas.count == 4 {
            features.append(featureHuella(meta: meta, geo: geo, anillo: geodesicas))
        }

        var texto = "{\n"
        texto += "  \"type\": \"FeatureCollection\",\n"
        texto += "  \"name\": \(escapar(meta.nombre)),\n"
        texto += "  \"crs\": {\n"
        texto += "    \"type\": \"name\",\n"
        texto += "    \"properties\": { \"name\": \"urn:ogc:def:crs:OGC:1.3:CRS84\" }\n"
        texto += "  },\n"
        if !geodesicas.isEmpty {
            let lons = geodesicas.map { $0.longitud }
            let lats = geodesicas.map { $0.latitud }
            let oeste = lons.min() ?? geo.longitude
            let este = lons.max() ?? geo.longitude
            let sur = lats.min() ?? geo.latitude
            let norte = lats.max() ?? geo.latitude
            texto += "  \"bbox\": [\(grados(oeste)), \(grados(sur)), \(grados(este)), \(grados(norte))],\n"
        }
        texto += "  \"features\": [\n"
        texto += features.joined(separator: ",\n")
        texto += "\n  ]\n"
        texto += "}\n"
        return texto
    }

    // MARK: - Features

    private static func featureOrigen(meta: ScanMetadata, geo: GeoReference) -> String {
        var propiedades: [(String, String)] = []
        propiedades.append(("tipo", escapar("origen")))
        propiedades.append(("formato", escapar(meta.formato)))
        propiedades.append(("id", escapar(meta.id.uuidString)))
        propiedades.append(("nombre", escapar(meta.nombre)))
        propiedades.append(("creado", escapar(iso8601(meta.creado))))
        propiedades.append(("sensor", escapar(meta.sensor)))
        propiedades.append(("marco", escapar(meta.marco.rawValue)))
        propiedades.append(("puntos", "\(meta.puntos)"))
        propiedades.append(("vertices", "\(meta.vertices)"))
        propiedades.append(("triangulos", "\(meta.triangulos)"))
        propiedades.append(("norte", opcional(geo.norte, decimales: 3)))
        propiedades.append(("este", opcional(geo.este, decimales: 3)))
        propiedades.append(("altitud", numero(geo.altitude, decimales: 3)))
        propiedades.append(("precisionHorizontal", numero(geo.horizontalAccuracy, decimales: 2)))
        propiedades.append(("precisionVertical", numero(geo.verticalAccuracy, decimales: 2)))
        propiedades.append(("rumbo", numero(geo.heading, decimales: 2)))
        propiedades.append(("precisionRumbo", numero(geo.headingAccuracy, decimales: 2)))
        propiedades.append(("duracionSegundos", numero(meta.duracionSegundos, decimales: 2)))
        propiedades.append(("mediciones", "\(meta.mediciones.count)"))
        propiedades.append(("proyecto", opcionalTexto(meta.proyecto)))
        propiedades.append(("notas", opcionalTexto(meta.notas)))

        var texto = "    {\n"
        texto += "      \"type\": \"Feature\",\n"
        texto += "      \"geometry\": {\n"
        texto += "        \"type\": \"Point\",\n"
        texto += "        \"coordinates\": [\(grados(geo.longitude)), \(grados(geo.latitude)), \(numero(geo.altitude, decimales: 3))]\n"
        texto += "      },\n"
        texto += "      \"properties\": {\n"
        texto += campos(propiedades, sangria: "        ")
        texto += "\n      }\n"
        texto += "    }"
        return texto
    }

    private static func featureHuella(meta: ScanMetadata,
                                      geo: GeoReference,
                                      anillo: [(latitud: Double, longitud: Double)]) -> String {
        let caja = meta.bbox ?? BoundingBox.empty
        let ancho = caja.isEmpty ? 0.0 : Double(caja.max.x - caja.min.x)
        let profundo: Double
        switch meta.marco {
        case .enu:   profundo = caja.isEmpty ? 0.0 : Double(caja.max.y - caja.min.y)
        case .arkit: profundo = caja.isEmpty ? 0.0 : Double(caja.max.z - caja.min.z)
        }
        let alto = alturaCaja(caja, marco: meta.marco)

        var propiedades: [(String, String)] = []
        propiedades.append(("tipo", escapar("huella")))
        propiedades.append(("id", escapar(meta.id.uuidString)))
        propiedades.append(("nombre", escapar(meta.nombre)))
        propiedades.append(("anchoMetros", numero(ancho, decimales: 3)))
        propiedades.append(("profundidadMetros", numero(profundo, decimales: 3)))
        propiedades.append(("alturaMetros", numero(alto, decimales: 3)))
        propiedades.append(("areaBaseMetrosCuadrados", numero(ancho * profundo, decimales: 3)))
        propiedades.append(("rumbo", numero(geo.heading, decimales: 2)))

        // Anillo exterior cerrado: la última coordenada repite la primera.
        var coordenadas = anillo.map { "          [\(grados($0.longitud)), \(grados($0.latitud))]" }
        if let primera = anillo.first {
            coordenadas.append("          [\(grados(primera.longitud)), \(grados(primera.latitud))]")
        }

        var texto = "    {\n"
        texto += "      \"type\": \"Feature\",\n"
        texto += "      \"geometry\": {\n"
        texto += "        \"type\": \"Polygon\",\n"
        texto += "        \"coordinates\": [\n"
        texto += "        [\n"
        texto += coordenadas.joined(separator: ",\n")
        texto += "\n        ]\n"
        texto += "        ]\n"
        texto += "      },\n"
        texto += "      \"properties\": {\n"
        texto += campos(propiedades, sangria: "        ")
        texto += "\n      }\n"
        texto += "    }"
        return texto
    }

    // MARK: - Utilidades de formato JSON

    private static func campos(_ pares: [(String, String)], sangria: String) -> String {
        pares.map { "\(sangria)\(escapar($0.0)): \($0.1)" }.joined(separator: ",\n")
    }

    /// Coordenada geográfica con 7 decimales (≈1 cm).
    private static func grados(_ v: Double) -> String {
        numero(v, decimales: 7)
    }

    /// Número JSON con decimales fijos; `null` si no es finito.
    private static func numero(_ v: Double, decimales: Int) -> String {
        guard v.isFinite else { return "null" }
        return String(format: "%.\(decimales)f", v)
    }

    private static func opcional(_ v: Double?, decimales: Int) -> String {
        guard let v = v else { return "null" }
        return numero(v, decimales: decimales)
    }

    private static func opcionalTexto(_ v: String?) -> String {
        guard let v = v else { return "null" }
        return escapar(v)
    }

    /// Cadena JSON entre comillas, con los escapes obligatorios de RFC 8259.
    public static func escapar(_ texto: String) -> String {
        var salida = "\""
        salida.reserveCapacity(texto.utf8.count + 2)
        for escalar in texto.unicodeScalars {
            switch escalar {
            case "\"":
                salida += "\\\""
            case "\\":
                salida += "\\\\"
            case "\n":
                salida += "\\n"
            case "\r":
                salida += "\\r"
            case "\t":
                salida += "\\t"
            default:
                if escalar.value < 0x20 {
                    salida += String(format: "\\u%04x", escalar.value)
                } else {
                    salida.unicodeScalars.append(escalar)
                }
            }
        }
        salida += "\""
        return salida
    }

    /// Fecha en ISO-8601 UTC, igual que `ScanMetadata.jsonEncoder()`.
    public static func iso8601(_ fecha: Date) -> String {
        formateadorISO.string(from: fecha)
    }

    private static let formateadorISO: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()
}
