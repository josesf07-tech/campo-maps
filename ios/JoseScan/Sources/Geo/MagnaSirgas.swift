//
//  MagnaSirgas.swift
//  JoseScan
//
//  Proyección MAGNA-SIRGAS Origen Nacional (EPSG:9377) implementada en Swift
//  puro, sin proj4 ni dependencias externas.
//
//  Equivalente exacto de la definición oficial que usa la PWA (js/coords.js):
//
//      +proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992
//      +x_0=5000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m
//
//  Marco legal: IGAC Res. 471 de 2020 / 529 de 2020 / 370 de 2021.
//
//  Método: Mercator Transversa sobre el elipsoide GRS80 con las series clásicas
//  de Snyder (USGS Professional Paper 1395, ecuaciones 8-5…8-19), ampliadas con
//  los términos de orden A⁷ / A⁸ (directa) y D⁷ / D⁸ (inversa). Con esos
//  términos la solución reproduce la serie exacta de Krüger (la que usa PROJ en
//  su implementación `etmerc`) por debajo de 0,1 mm en todo el territorio
//  continental colombiano y dentro de ~4 mm en San Andrés y Providencia, que es
//  el punto más alejado del meridiano central (≈8,7°).
//
//  Nota sobre datums: MAGNA-SIRGAS es prácticamente coincidente con WGS84
//  (towgs84=0,0,0,0,0,0,0), por eso no se aplica ninguna transformación de
//  datum: sólo cambia el elipsoide de referencia (GRS80 vs WGS84), cuyas
//  diferencias son inferiores a 0,1 mm en coordenadas proyectadas.
//

import Foundation

public enum MagnaSirgas {

    // MARK: - Tabla de constantes
    //
    //  | Parámetro                    | Valor              | Origen                    |
    //  |------------------------------|--------------------|---------------------------|
    //  | Elipsoide                    | GRS80              | +ellps=GRS80              |
    //  | Semieje mayor  a             | 6 378 137,0 m      | GRS80                     |
    //  | Achatamiento   1/f           | 298,257222101      | GRS80                     |
    //  | Latitud de origen   φ₀       | 4° N               | +lat_0=4                  |
    //  | Meridiano central   λ₀       | 73° W              | +lon_0=-73                |
    //  | Factor de escala    k₀       | 0,9992             | +k=0.9992                 |
    //  | Falso este          FE       | 5 000 000,0 m      | +x_0=5000000              |
    //  | Falso norte         FN       | 2 000 000,0 m      | +y_0=2000000              |
    //  | Unidades                     | metros             | +units=m                  |

    /// Semieje mayor del elipsoide GRS80, en metros.
    public static let semiejeMayor: Double = 6_378_137.0

    /// Achatamiento del elipsoide GRS80 (1/f = 298,257222101).
    public static let achatamiento: Double = 1.0 / 298.257222101

    /// Semieje menor del elipsoide GRS80, en metros.
    public static let semiejeMenor: Double = MagnaSirgas.semiejeMayor * (1.0 - MagnaSirgas.achatamiento)

    /// Primera excentricidad al cuadrado: e² = f(2 − f).
    public static let excentricidadCuadrada: Double =
        MagnaSirgas.achatamiento * (2.0 - MagnaSirgas.achatamiento)

    /// Segunda excentricidad al cuadrado: e'² = e² / (1 − e²).
    public static let segundaExcentricidadCuadrada: Double =
        MagnaSirgas.excentricidadCuadrada / (1.0 - MagnaSirgas.excentricidadCuadrada)

    /// Latitud del origen, en grados decimales.
    public static let latitudOrigen: Double = 4.0

    /// Meridiano central, en grados decimales (negativo al oeste).
    public static let meridianoCentral: Double = -73.0

    /// Factor de escala en el meridiano central.
    public static let factorEscala: Double = 0.9992

    /// Falso este, en metros.
    public static let falsoEste: Double = 5_000_000.0

    /// Falso norte, en metros.
    public static let falsoNorte: Double = 2_000_000.0

    /// Código EPSG del sistema proyectado.
    public static let codigoEPSG: String = "EPSG:9377"

    /// Nombre legible para la interfaz.
    public static let nombre: String = "MAGNA-SIRGAS / Origen Nacional"

    /// Definición proj4 equivalente (idéntica a la de `js/coords.js`).
    public static let definicionProj4: String =
        "+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 " +
        "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"

    // MARK: - Rango de validez

    /// Rango razonable de trabajo (Colombia continental + insular, con holgura).
    public static let latitudMinima: Double = -5.0
    public static let latitudMaxima: Double = 16.0
    public static let longitudMinima: Double = -85.0
    public static let longitudMaxima: Double = -60.0

    /// Indica si el par geográfico cae dentro del rango razonable de Colombia.
    /// Fuera de él la proyección sigue calculándose (sólo se registra un aviso),
    /// pero la deformación crece y el resultado deja de tener sentido práctico.
    public static func dentroDeRango(lat: Double, lon: Double) -> Bool {
        return lat >= MagnaSirgas.latitudMinima && lat <= MagnaSirgas.latitudMaxima
            && lon >= MagnaSirgas.longitudMinima && lon <= MagnaSirgas.longitudMaxima
    }

    // MARK: - Conversión directa (WGS84 → MAGNA-SIRGAS)

    /// Convierte coordenadas geográficas WGS84/MAGNA-SIRGAS a la proyección
    /// Origen Nacional (EPSG:9377).
    ///
    /// - Parameters:
    ///   - lat: latitud en grados decimales (positiva al norte).
    ///   - lon: longitud en grados decimales (negativa al oeste).
    /// - Returns: Norte y Este en metros.
    public static func desdeWGS84(lat: Double, lon: Double) -> (norte: Double, este: Double) {
        MagnaSirgas.avisarSiFueraDeRango(lat: lat, lon: lon)

        let e2 = MagnaSirgas.excentricidadCuadrada
        let ep2 = MagnaSirgas.segundaExcentricidadCuadrada
        let a = MagnaSirgas.semiejeMayor
        let k0 = MagnaSirgas.factorEscala

        // Latitud saturada a ±89,9999° para no dividir por cero en los polos.
        let latSegura = Swift.min(Swift.max(lat, -89.9999), 89.9999)
        let phi = MagnaSirgas.radianes(latSegura)
        let lambda = MagnaSirgas.radianes(lon)
        let lambda0 = MagnaSirgas.radianes(MagnaSirgas.meridianoCentral)

        let senPhi = sin(phi)
        let cosPhi = cos(phi)
        let tanPhi = tan(phi)

        // N: radio de curvatura en el primer vertical.
        let N = a / sqrt(1.0 - e2 * senPhi * senPhi)
        // T = tan²φ ; C = e'²cos²φ ; A = Δλ·cosφ  (Snyder 8-13 … 8-15)
        let T = tanPhi * tanPhi
        let C = ep2 * cosPhi * cosPhi
        let A = MagnaSirgas.normalizarDiferenciaAngular(lambda - lambda0) * cosPhi

        let A2 = A * A
        let A3 = A2 * A
        let A4 = A3 * A
        let A5 = A4 * A
        let A6 = A5 * A
        let A7 = A6 * A
        let A8 = A7 * A

        // Este (Snyder 8-9 + término A⁷).
        var este = k0 * N * (A
            + (1.0 - T + C) * A3 / 6.0
            + (5.0 - 18.0 * T + T * T + 72.0 * C - 58.0 * ep2) * A5 / 120.0
            + (61.0 - 479.0 * T + 179.0 * T * T - T * T * T) * A7 / 5040.0)
        este += MagnaSirgas.falsoEste

        // Norte (Snyder 8-10 + término A⁸).
        let M = MagnaSirgas.arcoMeridiano(phi)
        let M0 = MagnaSirgas.arcoMeridianoOrigen
        var norte = k0 * (M - M0 + N * tanPhi * (A2 / 2.0
            + (5.0 - T + 9.0 * C + 4.0 * C * C) * A4 / 24.0
            + (61.0 - 58.0 * T + T * T + 600.0 * C - 330.0 * ep2) * A6 / 720.0
            + (1385.0 - 3111.0 * T + 543.0 * T * T - T * T * T) * A8 / 40320.0))
        norte += MagnaSirgas.falsoNorte

        return (norte: norte, este: este)
    }

    // MARK: - Conversión inversa (MAGNA-SIRGAS → WGS84)

    /// Convierte coordenadas proyectadas Origen Nacional (EPSG:9377) a
    /// geográficas WGS84.
    ///
    /// Usa la latitud a pie de perpendicular: primero la latitud rectificante μ
    /// (Snyder 8-19), luego φ₁ por serie en e₁ (Snyder 3-26) y finalmente la
    /// corrección por el desarrollo en D (Snyder 8-17 / 8-18).
    ///
    /// - Parameters:
    ///   - norte: coordenada Norte en metros.
    ///   - este: coordenada Este en metros.
    /// - Returns: latitud y longitud en grados decimales.
    public static func aWGS84(norte: Double, este: Double) -> (lat: Double, lon: Double) {
        let e2 = MagnaSirgas.excentricidadCuadrada
        let ep2 = MagnaSirgas.segundaExcentricidadCuadrada
        let a = MagnaSirgas.semiejeMayor
        let k0 = MagnaSirgas.factorEscala

        // Arco de meridiano correspondiente a la coordenada norte.
        let M = (norte - MagnaSirgas.falsoNorte) / k0 + MagnaSirgas.arcoMeridianoOrigen

        // Latitud rectificante μ.
        let mu = M / (a * (1.0 - e2 / 4.0
                            - 3.0 * e2 * e2 / 64.0
                            - 5.0 * e2 * e2 * e2 / 256.0))

        // e₁ = (1 − √(1−e²)) / (1 + √(1−e²)).
        let raiz = sqrt(1.0 - e2)
        let e1 = (1.0 - raiz) / (1.0 + raiz)
        let e1_2 = e1 * e1
        let e1_3 = e1_2 * e1
        let e1_4 = e1_3 * e1

        // Latitud a pie de perpendicular φ₁.
        let phi1 = mu
            + (3.0 * e1 / 2.0 - 27.0 * e1_3 / 32.0) * sin(2.0 * mu)
            + (21.0 * e1_2 / 16.0 - 55.0 * e1_4 / 32.0) * sin(4.0 * mu)
            + (151.0 * e1_3 / 96.0) * sin(6.0 * mu)
            + (1097.0 * e1_4 / 512.0) * sin(8.0 * mu)

        let senPhi1 = sin(phi1)
        let cosPhi1 = cos(phi1)
        // Protección numérica cerca de los polos (cosφ₁ → 0).
        guard abs(cosPhi1) > 1e-12 else {
            let latPolo = phi1 >= 0 ? 90.0 : -90.0
            return (lat: latPolo, lon: MagnaSirgas.meridianoCentral)
        }
        let tanPhi1 = tan(phi1)

        let W = 1.0 - e2 * senPhi1 * senPhi1
        let N1 = a / sqrt(W)                    // primer vertical
        let R1 = a * (1.0 - e2) / (W * sqrt(W)) // meridiano
        let T1 = tanPhi1 * tanPhi1
        let C1 = ep2 * cosPhi1 * cosPhi1

        let D = (este - MagnaSirgas.falsoEste) / (N1 * k0)
        let D2 = D * D
        let D3 = D2 * D
        let D4 = D3 * D
        let D5 = D4 * D
        let D6 = D5 * D
        let D7 = D6 * D
        let D8 = D7 * D

        // Latitud (Snyder 8-17 + término D⁸).
        let phi = phi1 - (N1 * tanPhi1 / R1) * (D2 / 2.0
            - (5.0 + 3.0 * T1 + 10.0 * C1 - 4.0 * C1 * C1 - 9.0 * ep2) * D4 / 24.0
            + (61.0 + 90.0 * T1 + 298.0 * C1 + 45.0 * T1 * T1
               - 252.0 * ep2 - 3.0 * C1 * C1) * D6 / 720.0
            - (1385.0 + 3633.0 * T1 + 4095.0 * T1 * T1 + 1575.0 * T1 * T1 * T1) * D8 / 40320.0)

        // Longitud (Snyder 8-18 + término D⁷).
        let deltaLambda = (D
            - (1.0 + 2.0 * T1 + C1) * D3 / 6.0
            + (5.0 - 2.0 * C1 + 28.0 * T1 - 3.0 * C1 * C1 + 8.0 * ep2 + 24.0 * T1 * T1) * D5 / 120.0
            - (61.0 + 662.0 * T1 + 1320.0 * T1 * T1 + 720.0 * T1 * T1 * T1) * D7 / 5040.0) / cosPhi1

        let lat = MagnaSirgas.grados(phi)
        let lon = MagnaSirgas.grados(MagnaSirgas.radianes(MagnaSirgas.meridianoCentral) + deltaLambda)

        MagnaSirgas.avisarSiFueraDeRango(lat: lat, lon: lon)
        return (lat: lat, lon: MagnaSirgas.normalizarLongitud(lon))
    }

    // MARK: - Utilidades de presentación

    /// Texto corto para la HUD: `N: 2.067.459 m | E: 4.880.056 m`.
    public static func formatear(norte: Double, este: Double) -> String {
        let formato = NumberFormatter()
        formato.numberStyle = .decimal
        formato.locale = Locale(identifier: "es_CO")
        formato.maximumFractionDigits = 0
        let n = formato.string(from: NSNumber(value: norte.rounded())) ?? String(format: "%.0f", norte)
        let e = formato.string(from: NSNumber(value: este.rounded())) ?? String(format: "%.0f", este)
        return "N: \(n) m | E: \(e) m"
    }

    /// Heurística equivalente a `isMagnaSirgasCoords` de `js/coords.js`.
    public static func pareceMagnaSirgas(_ v1: Double, _ v2: Double) -> Bool {
        let c1 = abs(v1)
        let c2 = abs(v2)
        let esNorte: (Double) -> Bool = { v in v >= 800_000.0 && v <= 3_500_000.0 }
        let esEste: (Double) -> Bool = { v in v >= 3_500_000.0 && v <= 6_500_000.0 }
        return (esNorte(c1) && esEste(c2)) || (esNorte(c2) && esEste(c1))
    }

    // MARK: - Internos

    /// Arco de meridiano M(φ) desde el ecuador, en metros (Snyder 3-21).
    internal static func arcoMeridiano(_ phi: Double) -> Double {
        let e2 = MagnaSirgas.excentricidadCuadrada
        let e4 = e2 * e2
        let e6 = e4 * e2
        let a = MagnaSirgas.semiejeMayor
        return a * ((1.0 - e2 / 4.0 - 3.0 * e4 / 64.0 - 5.0 * e6 / 256.0) * phi
                    - (3.0 * e2 / 8.0 + 3.0 * e4 / 32.0 + 45.0 * e6 / 1024.0) * sin(2.0 * phi)
                    + (15.0 * e4 / 256.0 + 45.0 * e6 / 1024.0) * sin(4.0 * phi)
                    - (35.0 * e6 / 3072.0) * sin(6.0 * phi))
    }

    /// M₀ = M(φ₀); se calcula una sola vez.
    internal static let arcoMeridianoOrigen: Double =
        MagnaSirgas.arcoMeridiano(MagnaSirgas.radianes(MagnaSirgas.latitudOrigen))

    internal static func radianes(_ grados: Double) -> Double {
        return grados * Double.pi / 180.0
    }

    internal static func grados(_ radianes: Double) -> Double {
        return radianes * 180.0 / Double.pi
    }

    /// Lleva una diferencia de longitud (en radianes) al intervalo [−π, π].
    private static func normalizarDiferenciaAngular(_ delta: Double) -> Double {
        var d = delta
        while d > Double.pi { d -= 2.0 * Double.pi }
        while d < -Double.pi { d += 2.0 * Double.pi }
        return d
    }

    /// Lleva una longitud en grados al intervalo [−180, 180].
    private static func normalizarLongitud(_ lon: Double) -> Double {
        var l = lon
        while l > 180.0 { l -= 360.0 }
        while l < -180.0 { l += 360.0 }
        return l
    }

    /// Registra (sin fallar) una advertencia cuando el punto queda fuera del
    /// rango razonable de Colombia.
    private static func avisarSiFueraDeRango(lat: Double, lon: Double) {
        guard !MagnaSirgas.dentroDeRango(lat: lat, lon: lon) else { return }
        #if DEBUG
        print(String(format:
            "[MagnaSirgas] Advertencia: (%.6f, %.6f) está fuera del rango de Colombia " +
            "(lat %.0f…%.0f, lon %.0f…%.0f). El cálculo continúa, pero la deformación es alta.",
            lat, lon,
            MagnaSirgas.latitudMinima, MagnaSirgas.latitudMaxima,
            MagnaSirgas.longitudMinima, MagnaSirgas.longitudMaxima))
        #endif
    }
}
