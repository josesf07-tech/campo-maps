//
//  MagnaSirgasTests.swift
//  JoseScanTests
//
//  Pruebas de la proyección MAGNA-SIRGAS Origen Nacional (EPSG:9377):
//
//      Transversa de Mercator
//      Latitud de origen ....... 4° N
//      Meridiano central ....... −73°
//      Factor de escala ........ 0.9992
//      Falso Este .............. 5 000 000 m
//      Falso Norte ............. 2 000 000 m
//      Elipsoide ............... GRS80
//
//  Misma definición que usa js/coords.js en la PWA (IGAC Res. 471/2020).
//  Los valores esperados absolutos se calcularon con PROJ (pyproj 3.7.2)
//  sobre esa misma definición.
//

import XCTest
import Foundation
@testable import JoseScan

final class MagnaSirgasTests: XCTestCase {

    /// Punto de control: ciudad, WGS84 y su EPSG:9377 de referencia.
    private struct Control {
        let nombre: String
        let lat: Double
        let lon: Double
        let este: Double
        let norte: Double
    }

    /// Seis puntos repartidos por Colombia (incluye Leticia, al sur del
    /// ecuador de la proyección, y Riohacha, al este del meridiano central).
    private let controles: [Control] = [
        Control(nombre: "Bogotá",       lat:  4.60971, lon: -74.08175, este: 4_880_056.016, norte: 2_067_459.132),
        Control(nombre: "Medellín",     lat:  6.25184, lon: -75.56359, este: 4_716_442.340, norte: 2_249_507.803),
        Control(nombre: "Cali",         lat:  3.43722, lon: -76.52250, este: 4_608_644.427, norte: 1_938_540.116),
        Control(nombre: "Barranquilla", lat: 10.96854, lon: -74.78132, este: 4_805_429.758, norte: 2_770_640.853),
        Control(nombre: "Leticia",      lat: -4.21528, lon: -69.94056, este: 5_339_549.158, norte: 1_091_645.617),
        Control(nombre: "Riohacha",     lat: 11.54444, lon: -72.90722, este: 5_010_112.545, norte: 2_833_720.006)
    ]

    // =====================================================================
    // MARK: - Origen de la proyección
    // =====================================================================

    func testElOrigenNacionalDaExactamenteElFalsoEsteYElFalsoNorte() {
        let r = MagnaSirgas.desdeWGS84(lat: 4.0, lon: -73.0)
        XCTAssertEqual(r.este, 5_000_000.0, accuracy: 1e-3,
                       "En (4° N, −73°) el Este debe ser exactamente el falso Este 5 000 000 m")
        XCTAssertEqual(r.norte, 2_000_000.0, accuracy: 1e-3,
                       "En (4° N, −73°) el Norte debe ser exactamente el falso Norte 2 000 000 m")
    }

    func testElOrigenNacionalSeRecuperaDesdeLasCoordenadasProyectadas() {
        let r = MagnaSirgas.aWGS84(norte: 2_000_000.0, este: 5_000_000.0)
        XCTAssertEqual(r.lat, 4.0, accuracy: 1e-9,
                       "El falso origen debe devolver latitud 4° exacta")
        XCTAssertEqual(r.lon, -73.0, accuracy: 1e-9,
                       "El falso origen debe devolver longitud −73° exacta")
    }

    // =====================================================================
    // MARK: - Ida y vuelta
    // =====================================================================

    func testIdaYVueltaWGS84EnSeisPuntosDeColombia() {
        for c in controles {
            let p = MagnaSirgas.desdeWGS84(lat: c.lat, lon: c.lon)
            let v = MagnaSirgas.aWGS84(norte: p.norte, este: p.este)
            XCTAssertEqual(v.lat, c.lat, accuracy: 1e-6,
                           "\(c.nombre): la latitud debe volver con menos de 1e-6° de error")
            XCTAssertEqual(v.lon, c.lon, accuracy: 1e-6,
                           "\(c.nombre): la longitud debe volver con menos de 1e-6° de error")
        }
    }

    func testIdaYVueltaDesdeCoordenadasProyectadas() {
        // Malla de control dentro del rango útil de la proyección en Colombia.
        let nortes: [Double] = [1_100_000, 1_900_000, 2_000_000, 2_500_000, 2_900_000]
        let estes: [Double] = [4_600_000, 4_900_000, 5_000_000, 5_200_000, 5_400_000]
        for n in nortes {
            for e in estes {
                let g = MagnaSirgas.aWGS84(norte: n, este: e)
                let p = MagnaSirgas.desdeWGS84(lat: g.lat, lon: g.lon)
                XCTAssertEqual(p.norte, n, accuracy: 1e-3,
                               "Norte \(n) / Este \(e): el Norte debe volver con menos de 1 mm de error")
                XCTAssertEqual(p.este, e, accuracy: 1e-3,
                               "Norte \(n) / Este \(e): el Este debe volver con menos de 1 mm de error")
            }
        }
    }

    // =====================================================================
    // MARK: - Valores absolutos de referencia (PROJ)
    // =====================================================================

    func testCoordenadasProyectadasDeLasSeisCiudades() {
        for c in controles {
            let p = MagnaSirgas.desdeWGS84(lat: c.lat, lon: c.lon)
            XCTAssertEqual(p.este, c.este, accuracy: 1.0,
                           "\(c.nombre): el Este debe ser \(c.este) m (± 1 m)")
            XCTAssertEqual(p.norte, c.norte, accuracy: 1.0,
                           "\(c.nombre): el Norte debe ser \(c.norte) m (± 1 m)")
        }
    }

    func testNorteSobreElMeridianoCentralACincoGrados() {
        // Arco meridiano 4° → 5° multiplicado por k0 = 0.9992 → 110 492.674 m
        let p = MagnaSirgas.desdeWGS84(lat: 5.0, lon: -73.0)
        XCTAssertEqual(p.este, 5_000_000.0, accuracy: 1e-3,
                       "Sobre el meridiano central el Este siempre es 5 000 000 m")
        XCTAssertEqual(p.norte, 2_110_492.674, accuracy: 0.05,
                       "A 5° N sobre el meridiano central el Norte debe ser 2 110 492.674 m")
    }

    func testNorteSobreElMeridianoCentralATresGrados() {
        let p = MagnaSirgas.desdeWGS84(lat: 3.0, lon: -73.0)
        XCTAssertEqual(p.este, 5_000_000.0, accuracy: 1e-3,
                       "Sobre el meridiano central el Este siempre es 5 000 000 m")
        XCTAssertEqual(p.norte, 1_889_510.021, accuracy: 0.05,
                       "A 3° N sobre el meridiano central el Norte debe ser 1 889 510.021 m")
    }

    func testSimetriaRespectoAlMeridianoCentral() {
        // (4.6°, −72°) y (4.6°, −74°) están a 1° a cada lado del meridiano −73°.
        let este = MagnaSirgas.desdeWGS84(lat: 4.6, lon: -72.0)
        let oeste = MagnaSirgas.desdeWGS84(lat: 4.6, lon: -74.0)
        XCTAssertEqual(este.este + oeste.este, 10_000_000.0, accuracy: 1e-2,
                       "Dos puntos simétricos respecto al meridiano central suman 2 × 5 000 000 m de Este")
        XCTAssertEqual(este.norte, oeste.norte, accuracy: 1e-3,
                       "Dos puntos simétricos respecto al meridiano central tienen el mismo Norte")
        XCTAssertEqual(este.este, 5_110_880.130, accuracy: 0.05,
                       "(4.6°, −72°) debe proyectar a Este 5 110 880.130 m")
        XCTAssertEqual(este.norte, 2_066_372.846, accuracy: 0.05,
                       "(4.6°, −72°) debe proyectar a Norte 2 066 372.846 m")
    }

    // =====================================================================
    // MARK: - Monotonía
    // =====================================================================

    func testMasAlEsteImplicaMayorCoordenadaEste() {
        let lat = 4.6
        let longitudes: [Double] = [-77.0, -76.0, -75.0, -74.0, -73.0, -72.0, -71.0, -70.0]
        var anterior = -Double.greatestFiniteMagnitude
        for lon in longitudes {
            let e = MagnaSirgas.desdeWGS84(lat: lat, lon: lon).este
            XCTAssertGreaterThan(e, anterior,
                                 "A latitud \(lat)°, la longitud \(lon)° debe dar un Este mayor que la anterior")
            anterior = e
        }
    }

    func testMasAlNorteImplicaMayorCoordenadaNorte() {
        let lon = -74.0
        let latitudes: [Double] = [-4.0, 0.0, 2.0, 4.0, 6.0, 8.0, 11.0, 12.5]
        var anterior = -Double.greatestFiniteMagnitude
        for lat in latitudes {
            let n = MagnaSirgas.desdeWGS84(lat: lat, lon: lon).norte
            XCTAssertGreaterThan(n, anterior,
                                 "A longitud \(lon)°, la latitud \(lat)° debe dar un Norte mayor que la anterior")
            anterior = n
        }
    }

    func testPuntosAlOesteDelMeridianoCentralTienenEsteMenorACincoMillones() {
        for c in controles where c.lon < -73.0 {
            let p = MagnaSirgas.desdeWGS84(lat: c.lat, lon: c.lon)
            XCTAssertLessThan(p.este, 5_000_000.0,
                              "\(c.nombre) está al oeste de −73°, su Este debe ser menor que 5 000 000 m")
        }
    }

    func testPuntosAlEsteDelMeridianoCentralTienenEsteMayorACincoMillones() {
        for c in controles where c.lon > -73.0 {
            let p = MagnaSirgas.desdeWGS84(lat: c.lat, lon: c.lon)
            XCTAssertGreaterThan(p.este, 5_000_000.0,
                                 "\(c.nombre) está al este de −73°, su Este debe ser mayor que 5 000 000 m")
        }
    }

    func testPuntosAlSurDeCuatroGradosTienenNorteMenorADosMillones() {
        for c in controles where c.lat < 4.0 {
            let p = MagnaSirgas.desdeWGS84(lat: c.lat, lon: c.lon)
            XCTAssertLessThan(p.norte, 2_000_000.0,
                              "\(c.nombre) está al sur de 4° N, su Norte debe ser menor que 2 000 000 m")
        }
    }

    // =====================================================================
    // MARK: - Escala y coherencia métrica
    // =====================================================================

    func testUnMinutoDeLatitudSobreElMeridianoCentralMideCercaDeMilOchocientosMetros() {
        // 1' de latitud ≈ 1852 m de arco meridiano; con k0 = 0.9992 → ≈ 1850.5 m.
        let a = MagnaSirgas.desdeWGS84(lat: 4.0, lon: -73.0)
        let b = MagnaSirgas.desdeWGS84(lat: 4.0 + 1.0 / 60.0, lon: -73.0)
        XCTAssertEqual(b.norte - a.norte, 1841.5, accuracy: 2.0,
                       "Un minuto de latitud sobre el meridiano central debe medir ≈ 1841.5 m proyectados")
    }

    func testLasCoordenadasDeBogotaCaenEnElRangoTipicoDeMagnaSirgas() {
        let p = MagnaSirgas.desdeWGS84(lat: Fixtures.latBogota, lon: Fixtures.lonBogota)
        XCTAssertTrue(p.este > 3_500_000 && p.este < 6_500_000,
                      "El Este de Bogotá (\(p.este)) debe caer en el rango 3.5 M … 6.5 M de EPSG:9377")
        XCTAssertTrue(p.norte > 800_000 && p.norte < 3_500_000,
                      "El Norte de Bogotá (\(p.norte)) debe caer en el rango 0.8 M … 3.5 M de EPSG:9377")
    }

    func testLaProyeccionEsEstableAnteLlamadasRepetidas() {
        let a = MagnaSirgas.desdeWGS84(lat: Fixtures.latBogota, lon: Fixtures.lonBogota)
        let b = MagnaSirgas.desdeWGS84(lat: Fixtures.latBogota, lon: Fixtures.lonBogota)
        XCTAssertEqual(a.este, b.este, accuracy: 0,
                       "La proyección debe ser determinista en el Este")
        XCTAssertEqual(a.norte, b.norte, accuracy: 0,
                       "La proyección debe ser determinista en el Norte")
    }
}
