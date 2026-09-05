//
//  GeoTransformTests.swift
//  JoseScanTests
//
//  Pruebas de la conversión ARKit → ENU y ENU ↔ WGS84.
//
//  Convenio (docs/FORMATO-ESCANEO.md §3 y GeoReference.heading):
//  `heading` es el RUMBO VERDADERO del eje −Z de ARKit. Por tanto, con
//  rumbo h (grados, horario desde el norte) y f = −z (avance de la cámara):
//
//      este   =  x·cos h + f·sin h
//      norte  = −x·sin h + f·cos h
//      arriba =  y
//
//  Con h = 0 el avance apunta al norte; con h = 90° apunta al este.
//

import XCTest
import Foundation
import simd
@testable import JoseScan

final class GeoTransformTests: XCTestCase {

    /// Eje de avance de ARKit (−Z) como vector unitario.
    private let avance = SIMD3<Float>(0, 0, -1)
    /// Eje derecho de ARKit (+X) como vector unitario.
    private let derecha = SIMD3<Float>(1, 0, 0)
    /// Eje vertical de ARKit (+Y) como vector unitario.
    private let arriba = SIMD3<Float>(0, 1, 0)

    // =====================================================================
    // MARK: - Rotación ARKit → ENU sobre un punto
    // =====================================================================

    func testConRumboCeroElPuntoUnoDosMenosTresVaATresEnEnu() {
        let p = GeoTransform.arkitAEnu(SIMD3<Float>(1, 2, -3), rumboGrados: 0)
        XCTAssertSIMD3Igual(p, SIMD3<Float>(1, 3, 2), exactitud: 1e-5,
                            "Con rumbo 0, ARKit (1, 2, −3) debe dar ENU (este 1, norte 3, arriba 2)")
    }

    func testConRumboCeroElAvanceApuntaAlNorte() {
        let p = GeoTransform.arkitAEnu(avance, rumboGrados: 0)
        XCTAssertSIMD3Igual(p, SIMD3<Float>(0, 1, 0), exactitud: 1e-5,
                            "Con rumbo 0 el eje −Z de ARKit debe apuntar al norte (0, 1, 0)")
    }

    func testConRumboNoventaElAvanceApuntaAlEste() {
        let p = GeoTransform.arkitAEnu(avance, rumboGrados: 90)
        XCTAssertSIMD3Igual(p, SIMD3<Float>(1, 0, 0), exactitud: 1e-5,
                            "Con rumbo 90° el eje −Z de ARKit debe apuntar al este (1, 0, 0)")
    }

    func testConRumboCientoOchentaElAvanceApuntaAlSur() {
        let p = GeoTransform.arkitAEnu(avance, rumboGrados: 180)
        XCTAssertSIMD3Igual(p, SIMD3<Float>(0, -1, 0), exactitud: 1e-5,
                            "Con rumbo 180° el eje −Z de ARKit debe apuntar al sur (0, −1, 0)")
    }

    func testConRumboDoscientosSetentaElAvanceApuntaAlOeste() {
        let p = GeoTransform.arkitAEnu(avance, rumboGrados: 270)
        XCTAssertSIMD3Igual(p, SIMD3<Float>(-1, 0, 0), exactitud: 1e-5,
                            "Con rumbo 270° el eje −Z de ARKit debe apuntar al oeste (−1, 0, 0)")
    }

    func testConRumboNoventaElEjeDerechoApuntaAlSur() {
        let p = GeoTransform.arkitAEnu(derecha, rumboGrados: 90)
        XCTAssertSIMD3Igual(p, SIMD3<Float>(0, -1, 0), exactitud: 1e-5,
                            "Con rumbo 90° el eje +X de ARKit (derecha) debe apuntar al sur (0, −1, 0)")
    }

    func testConRumboCeroElEjeDerechoApuntaAlEste() {
        let p = GeoTransform.arkitAEnu(derecha, rumboGrados: 0)
        XCTAssertSIMD3Igual(p, SIMD3<Float>(1, 0, 0), exactitud: 1e-5,
                            "Con rumbo 0 el eje +X de ARKit debe apuntar al este (1, 0, 0)")
    }

    func testElEjeVerticalSeConservaConCualquierRumbo() {
        for rumbo in [0.0, 30.0, 90.0, 172.5, 270.0, 359.9] {
            let p = GeoTransform.arkitAEnu(arriba, rumboGrados: rumbo)
            XCTAssertSIMD3Igual(p, SIMD3<Float>(0, 0, 1), exactitud: 1e-5,
                                "Con rumbo \(rumbo)° el eje +Y de ARKit debe seguir siendo el arriba de ENU")
        }
    }

    func testConRumboNoventaElPuntoUnoDosMenosTresVaATresMenosUnoDos() {
        let p = GeoTransform.arkitAEnu(SIMD3<Float>(1, 2, -3), rumboGrados: 90)
        XCTAssertSIMD3Igual(p, SIMD3<Float>(3, -1, 2), exactitud: 1e-5,
                            "Con rumbo 90°, ARKit (1, 2, −3) debe dar ENU (este 3, norte −1, arriba 2)")
    }

    func testLaRotacionConservaLaNormaDelVector() {
        let v = SIMD3<Float>(1.5, -2.25, 3.75)
        let norma = simd_length(v)
        for rumbo in [0.0, 45.0, 90.0, 137.4, 180.0, 233.0, 270.0, 359.0] {
            let p = GeoTransform.arkitAEnu(v, rumboGrados: rumbo)
            XCTAssertEqual(simd_length(p), norma, accuracy: 1e-4,
                           "La conversión ARKit → ENU es una rotación: debe conservar la norma (rumbo \(rumbo)°)")
        }
    }

    func testElOrigenSiempreSeMapeaAlOrigen() {
        for rumbo in [0.0, 90.0, 217.3] {
            let p = GeoTransform.arkitAEnu(SIMD3<Float>(0, 0, 0), rumboGrados: rumbo)
            XCTAssertSIMD3Igual(p, SIMD3<Float>(0, 0, 0), exactitud: 1e-6,
                                "El origen del marco ARKit es el origen del marco ENU (rumbo \(rumbo)°)")
        }
    }

    func testRumbosEquivalentesModuloTrescientosSesentaDanElMismoResultado() {
        let v = SIMD3<Float>(2, -1, 4)
        let a = GeoTransform.arkitAEnu(v, rumboGrados: 45)
        let b = GeoTransform.arkitAEnu(v, rumboGrados: 405)
        XCTAssertSIMD3Igual(a, b, exactitud: 1e-4,
                            "45° y 405° son el mismo rumbo y deben dar el mismo vector ENU")
    }

    // =====================================================================
    // MARK: - Rotación de nube y malla completas
    // =====================================================================

    func testLaNubeCompletaCambiaDeMarcoYSeRota() {
        let original = Fixtures.nubePlana()
        let convertida = GeoTransform.arkitAEnu(original, rumboGrados: 0)

        XCTAssertEqual(convertida.frame, .enu,
                       "Tras convertir, la nube debe declararse en el marco ENU")
        XCTAssertEqual(convertida.count, original.count,
                       "La conversión no debe perder ni añadir puntos")
        XCTAssertEqual(convertida.colors, original.colors,
                       "Los colores no cambian al rotar")
        XCTAssertEqual(convertida.confidences, original.confidences,
                       "Las confianzas no cambian al rotar")
        XCTAssertTrue(convertida.isConsistent,
                      "La nube convertida debe seguir siendo consistente")

        // Con rumbo 0: (x, 0, z) → (este x, norte −z, arriba 0)
        for i in [0, 1, 39, 40, 499, 999] {
            let esperado = SIMD3<Float>(original.positions[i].x,
                                        -original.positions[i].z,
                                        original.positions[i].y)
            XCTAssertSIMD3Igual(convertida.positions[i], esperado, exactitud: 1e-5,
                                "Con rumbo 0 el punto \(i) debe cumplir (x, y, z) → (x, −z, y)")
        }
        // La rejilla plana en y = 0 queda plana en arriba = 0 y con norte ≥ 0.
        XCTAssertEqual(convertida.bounds.min.z, 0, accuracy: 1e-5,
                       "La rejilla plana debe quedar a altura 0 en ENU")
        XCTAssertEqual(convertida.bounds.max.y, 2.4, accuracy: 1e-4,
                       "El extremo norte de la rejilla debe quedar en 2.4 m")
    }

    func testLaMallaCompletaCambiaDeMarcoYRotaVerticesYNormales() {
        let original = Fixtures.cubo()
        let convertida = GeoTransform.arkitAEnu(original, rumboGrados: 90)

        XCTAssertEqual(convertida.frame, .enu,
                       "Tras convertir, la malla debe declararse en el marco ENU")
        XCTAssertEqual(convertida.vertexCount, 8, "La conversión conserva los 8 vértices")
        XCTAssertEqual(convertida.triangleCount, 12, "La conversión conserva los 12 triángulos")
        XCTAssertEqual(convertida.indices, original.indices,
                       "La topología (índices) no debe cambiar al rotar")
        XCTAssertEqual(convertida.classifications, original.classifications,
                       "Las clasificaciones no deben cambiar al rotar")
        XCTAssertTrue(convertida.isConsistent, "La malla convertida debe seguir siendo consistente")

        for i in 0..<original.vertexCount {
            XCTAssertSIMD3Igual(convertida.vertices[i],
                                GeoTransform.arkitAEnu(original.vertices[i], rumboGrados: 90),
                                exactitud: 1e-5,
                                "El vértice \(i) debe rotarse igual que un punto suelto")
        }
        XCTAssertTrue(convertida.hasNormals, "La malla convertida debe conservar sus normales")
        for i in 0..<original.normals.count {
            XCTAssertSIMD3Igual(convertida.normals[i],
                                GeoTransform.arkitAEnu(original.normals[i], rumboGrados: 90),
                                exactitud: 1e-5,
                                "La normal \(i) es una dirección y debe rotarse igual que el vértice")
            XCTAssertEqual(simd_length(convertida.normals[i]), 1.0, accuracy: 1e-4,
                           "La normal \(i) debe seguir siendo unitaria tras rotar")
        }
        XCTAssertEqual(convertida.surfaceArea(), original.surfaceArea(), accuracy: 1e-4,
                       "Una rotación rígida no cambia el área de superficie (6 m²)")
    }

    // =====================================================================
    // MARK: - ENU ↔ WGS84
    // =====================================================================

    func testElOrigenEnuEsExactamenteElAncla() {
        let origen = Fixtures.anclaBogota()
        let g = GeoTransform.enuAWGS84(este: 0, norte: 0, arriba: 0, origen: origen)
        XCTAssertEqual(g.lat, Fixtures.latBogota, accuracy: 1e-12,
                       "Desplazamiento nulo debe devolver exactamente la latitud del ancla")
        XCTAssertEqual(g.lon, Fixtures.lonBogota, accuracy: 1e-12,
                       "Desplazamiento nulo debe devolver exactamente la longitud del ancla")
        XCTAssertEqual(g.alt, Fixtures.altBogota, accuracy: 1e-9,
                       "Desplazamiento nulo debe devolver exactamente la altitud del ancla")
    }

    func testCincuentaMetrosAlNorteAumentanLaLatitudUnosCuatroComaCincoDiezmilesimas() {
        let origen = Fixtures.anclaBogota()
        let g = GeoTransform.enuAWGS84(este: 0, norte: 50, arriba: 0, origen: origen)
        // Radio meridiano WGS84 a 4.60971° N: M = 6 335 850.3 m → 50/M = 4.52155e-4°
        XCTAssertEqual(g.lat - Fixtures.latBogota, 4.52155e-4, accuracy: 5e-6,
                       "50 m al norte deben subir la latitud ≈ 0.000452155°")
        XCTAssertEqual(g.lon, Fixtures.lonBogota, accuracy: 1e-9,
                       "Un desplazamiento puramente al norte no cambia la longitud")
    }

    func testCincuentaMetrosAlEsteAumentanLaLongitudUnosCuatroComaCincoDiezmilesimas() {
        let origen = Fixtures.anclaBogota()
        let g = GeoTransform.enuAWGS84(este: 50, norte: 0, arriba: 0, origen: origen)
        // Radio de la normal por el coseno de la latitud: N·cos φ = 6 357 642.9 m
        // → 50 / 6 357 642.9 = 4.50606e-4°
        XCTAssertEqual(g.lon - Fixtures.lonBogota, 4.50606e-4, accuracy: 5e-6,
                       "50 m al este deben subir la longitud ≈ 0.000450606°")
        XCTAssertEqual(g.lat, Fixtures.latBogota, accuracy: 1e-9,
                       "Un desplazamiento puramente al este no cambia la latitud")
    }

    func testDesplazamientosNegativosBajanLatitudYLongitud() {
        let origen = Fixtures.anclaBogota()
        let g = GeoTransform.enuAWGS84(este: -50, norte: -50, arriba: -10, origen: origen)
        XCTAssertLessThan(g.lat, Fixtures.latBogota,
                          "50 m al sur deben bajar la latitud")
        XCTAssertLessThan(g.lon, Fixtures.lonBogota,
                          "50 m al oeste deben bajar la longitud")
        XCTAssertEqual(g.alt, Fixtures.altBogota - 10, accuracy: 1e-6,
                       "10 m hacia abajo deben restar 10 m a la altitud")
    }

    func testLaAlturaSeSumaDirectamenteALaAltitud() {
        let origen = Fixtures.anclaBogota()
        let g = GeoTransform.enuAWGS84(este: 12, norte: -7, arriba: 12.5, origen: origen)
        XCTAssertEqual(g.alt, Fixtures.altBogota + 12.5, accuracy: 1e-6,
                       "La componente 'arriba' se suma tal cual a la altitud del ancla")
    }

    func testIdaYVueltaEnuWGS84ConErrorMenorAUnMilimetro() {
        let origen = Fixtures.anclaBogota()
        let casos: [(Double, Double, Double)] = [
            (0, 0, 0),
            (50, 0, 0),
            (0, 50, 0),
            (-50, -50, 0),
            (35.35, -35.35, 12.5),
            (50, 50, -3.2)
        ]
        for (e, n, u) in casos {
            let g = GeoTransform.enuAWGS84(este: e, norte: n, arriba: u, origen: origen)
            let v = GeoTransform.wgs84AEnu(lat: g.lat, lon: g.lon, alt: g.alt, origen: origen)
            XCTAssertEqual(v.este, e, accuracy: 1e-3,
                           "Ida y vuelta ENU→WGS84→ENU: el Este (\(e) m) debe volver con < 1 mm de error")
            XCTAssertEqual(v.norte, n, accuracy: 1e-3,
                           "Ida y vuelta ENU→WGS84→ENU: el Norte (\(n) m) debe volver con < 1 mm de error")
            XCTAssertEqual(v.arriba, u, accuracy: 1e-3,
                           "Ida y vuelta ENU→WGS84→ENU: el Arriba (\(u) m) debe volver con < 1 mm de error")
        }
    }

    func testIdaYVueltaWGS84EnuConErrorMenorAUnMilimetro() {
        let origen = Fixtures.anclaBogota()
        // ±0.0005° ≈ ±55 m alrededor del ancla.
        let deltas: [Double] = [-0.0005, -0.0002, 0, 0.0002, 0.0005]
        for dLat in deltas {
            for dLon in deltas {
                let lat = Fixtures.latBogota + dLat
                let lon = Fixtures.lonBogota + dLon
                let v = GeoTransform.wgs84AEnu(lat: lat, lon: lon, alt: Fixtures.altBogota + 4,
                                               origen: origen)
                let g = GeoTransform.enuAWGS84(este: v.este, norte: v.norte, arriba: v.arriba,
                                               origen: origen)
                XCTAssertEqual(g.lat, lat, accuracy: 1e-9,
                               "Ida y vuelta WGS84→ENU→WGS84: la latitud debe volver intacta")
                XCTAssertEqual(g.lon, lon, accuracy: 1e-9,
                               "Ida y vuelta WGS84→ENU→WGS84: la longitud debe volver intacta")
                XCTAssertEqual(g.alt, Fixtures.altBogota + 4, accuracy: 1e-6,
                               "Ida y vuelta WGS84→ENU→WGS84: la altitud debe volver intacta")
            }
        }
    }

    func testLaDistanciaEnuSeConservaAlPasarPorWGS84() {
        let origen = Fixtures.anclaBogota()
        let g = GeoTransform.enuAWGS84(este: 30, norte: 40, arriba: 0, origen: origen)
        let v = GeoTransform.wgs84AEnu(lat: g.lat, lon: g.lon, alt: g.alt, origen: origen)
        let distancia = (v.este * v.este + v.norte * v.norte).squareRoot()
        XCTAssertEqual(distancia, 50.0, accuracy: 1e-3,
                       "El punto (30 E, 40 N) está a 50 m del ancla también tras la ida y vuelta")
    }

    // =====================================================================
    // MARK: - georreferenciar(_:)
    // =====================================================================

    func testGeorreferenciarCambiaElMarcoARellenaNorteYEste() throws {
        let doc = Fixtures.documento(rumbo: 0)
        XCTAssertEqual(doc.metadata.marco, .arkit, "El documento nace en marco ARKit")
        XCTAssertNil(doc.metadata.geo?.norte, "El ancla nace sin coordenadas proyectadas")
        XCTAssertNil(doc.metadata.geo?.este, "El ancla nace sin coordenadas proyectadas")

        try GeoTransform.georreferenciar(doc)

        XCTAssertEqual(doc.metadata.marco, .enu,
                       "Tras georreferenciar, los metadatos deben declarar el marco ENU")
        XCTAssertEqual(doc.cloud.frame, .enu,
                       "Tras georreferenciar, la nube debe quedar en marco ENU")
        XCTAssertEqual(doc.mesh.frame, .enu,
                       "Tras georreferenciar, la malla debe quedar en marco ENU")

        let norte = try XCTUnwrap(doc.metadata.geo?.norte,
                                  "Tras georreferenciar, el ancla debe traer el Norte MAGNA-SIRGAS")
        let este = try XCTUnwrap(doc.metadata.geo?.este,
                                 "Tras georreferenciar, el ancla debe traer el Este MAGNA-SIRGAS")
        XCTAssertEqual(este, 4_880_056.016, accuracy: 1.0,
                       "El Este EPSG:9377 del ancla de Bogotá debe ser 4 880 056.0 m")
        XCTAssertEqual(norte, 2_067_459.132, accuracy: 1.0,
                       "El Norte EPSG:9377 del ancla de Bogotá debe ser 2 067 459.1 m")
    }

    func testGeorreferenciarRotaLaGeometriaSegunElRumbo() throws {
        let doc = Fixtures.documento(rumbo: 0)
        let cuboOriginal = Fixtures.cubo()
        try GeoTransform.georreferenciar(doc)

        for i in 0..<cuboOriginal.vertexCount {
            XCTAssertSIMD3Igual(doc.mesh.vertices[i],
                                GeoTransform.arkitAEnu(cuboOriginal.vertices[i], rumboGrados: 0),
                                exactitud: 1e-5,
                                "El vértice \(i) debe haber quedado rotado a ENU con rumbo 0")
        }
        XCTAssertEqual(doc.mesh.surfaceArea(), 6.0, accuracy: 1e-4,
                       "Georreferenciar es una rotación rígida: el cubo sigue midiendo 6 m² de superficie")
        XCTAssertEqual(doc.cloud.count, 1000,
                       "Georreferenciar no debe perder puntos")
    }

    func testGeorreferenciarSinAnclaLanzaSinGeorreferencia() {
        let doc = Fixtures.documento(conAncla: false)
        XCTAssertThrowsError(try GeoTransform.georreferenciar(doc),
                             "Sin ancla GPS georreferenciar debe fallar") { error in
            XCTAssertEqual(error as? ScanError, ScanError.sinGeorreferencia,
                           "El error debe ser ScanError.sinGeorreferencia y llegó: \(error)")
        }
        XCTAssertEqual(doc.metadata.marco, .arkit,
                       "Si georreferenciar falla, el marco debe seguir siendo ARKit")
        XCTAssertEqual(doc.cloud.frame, .arkit,
                       "Si georreferenciar falla, la nube no debe tocarse")
        XCTAssertEqual(doc.mesh.frame, .arkit,
                       "Si georreferenciar falla, la malla no debe tocarse")
    }

    func testGeorreferenciarDosVecesEsIdempotente() throws {
        let doc = Fixtures.documento(rumbo: 137.5)
        try GeoTransform.georreferenciar(doc)

        let verticesTrasPrimera = doc.mesh.vertices
        let puntosTrasPrimera = doc.cloud.positions
        let norteTrasPrimera = doc.metadata.geo?.norte
        let esteTrasPrimera = doc.metadata.geo?.este

        try GeoTransform.georreferenciar(doc)

        XCTAssertEqual(doc.mesh.vertices, verticesTrasPrimera,
                       "Georreferenciar dos veces no debe volver a rotar la malla")
        XCTAssertEqual(doc.cloud.positions, puntosTrasPrimera,
                       "Georreferenciar dos veces no debe volver a rotar la nube")
        XCTAssertEqual(doc.metadata.marco, .enu,
                       "El marco debe seguir siendo ENU tras la segunda llamada")
        XCTAssertEqual(doc.metadata.geo?.norte ?? .nan, norteTrasPrimera ?? .nan, accuracy: 1e-6,
                       "El Norte MAGNA-SIRGAS no debe cambiar en la segunda llamada")
        XCTAssertEqual(doc.metadata.geo?.este ?? .nan, esteTrasPrimera ?? .nan, accuracy: 1e-6,
                       "El Este MAGNA-SIRGAS no debe cambiar en la segunda llamada")
    }

    func testGeorreferenciarConDocumentoSoloNubeTambienFunciona() throws {
        let doc = ScanDocument(metadata: Fixtures.metadatos(),
                               cloud: Fixtures.nubePlana(),
                               mesh: ScanMesh())
        try GeoTransform.georreferenciar(doc)
        XCTAssertEqual(doc.cloud.frame, .enu,
                       "Un documento con sólo nube también debe quedar en ENU")
        XCTAssertEqual(doc.metadata.marco, .enu,
                       "Los metadatos deben declarar ENU aunque no haya malla")
    }
}
