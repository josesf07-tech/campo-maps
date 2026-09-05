//
//  ScanTypesTests.swift
//  JoseScanTests
//
//  Pruebas del contrato compartido (ScanTypes.swift): geometría básica,
//  serialización JSON, consistencia de nube y malla, métricas de calidad y
//  formatos de exportación. Lógica pura, sin ARKit.
//

import XCTest
import Foundation
import simd
@testable import JoseScan

final class ScanTypesTests: XCTestCase {

    // =====================================================================
    // MARK: - BoundingBox
    // =====================================================================

    func testCajaVaciaReportaMetricasEnCero() {
        let caja = BoundingBox.empty
        XCTAssertTrue(caja.isEmpty, "BoundingBox.empty debe reportarse como vacía")
        XCTAssertEqual(caja.center, SIMD3<Float>(0, 0, 0),
                       "El centro de una caja vacía debe ser el origen (0,0,0)")
        XCTAssertEqual(caja.size, SIMD3<Float>(0, 0, 0),
                       "El tamaño de una caja vacía debe ser (0,0,0)")
        XCTAssertEqual(caja.diagonal, 0, accuracy: 1e-6,
                       "La diagonal de una caja vacía debe ser 0 m")
    }

    func testExpandirConDosPuntosDefineCentroTamanoYDiagonal() {
        var caja = BoundingBox.empty
        caja.expand(SIMD3<Float>(-1, -2, -3))
        caja.expand(SIMD3<Float>(4, 5, 6))

        XCTAssertFalse(caja.isEmpty, "Tras expandir con dos puntos la caja ya no está vacía")
        XCTAssertSIMD3Igual(caja.min, SIMD3<Float>(-1, -2, -3),
                            "El mínimo debe ser (-1,-2,-3)")
        XCTAssertSIMD3Igual(caja.max, SIMD3<Float>(4, 5, 6),
                            "El máximo debe ser (4,5,6)")
        XCTAssertSIMD3Igual(caja.center, SIMD3<Float>(1.5, 1.5, 1.5),
                            "El centro debe ser (1.5,1.5,1.5)")
        XCTAssertSIMD3Igual(caja.size, SIMD3<Float>(5, 7, 9),
                            "El tamaño debe ser (5,7,9) m")
        // sqrt(5² + 7² + 9²) = sqrt(155) = 12.449899597988733
        XCTAssertEqual(caja.diagonal, 12.4498996, accuracy: 1e-4,
                       "La diagonal debe ser sqrt(155) ≈ 12.4499 m")
    }

    func testExpandirUnSoloPuntoDaCajaDegenerada() {
        var caja = BoundingBox.empty
        caja.expand(SIMD3<Float>(2, 3, 4))
        XCTAssertFalse(caja.isEmpty, "Una caja con un punto no debe considerarse vacía")
        XCTAssertSIMD3Igual(caja.center, SIMD3<Float>(2, 3, 4),
                            "El centro de una caja de un punto es ese punto")
        XCTAssertSIMD3Igual(caja.size, SIMD3<Float>(0, 0, 0),
                            "El tamaño de una caja de un punto es (0,0,0)")
        XCTAssertEqual(caja.diagonal, 0, accuracy: 1e-6,
                       "La diagonal de una caja de un punto es 0 m")
    }

    func testExpandirConOtraCajaVaciaNoModificaNada() {
        var caja = BoundingBox(min: SIMD3<Float>(0, 0, 0), max: SIMD3<Float>(1, 1, 1))
        caja.expand(BoundingBox.empty)
        XCTAssertSIMD3Igual(caja.min, SIMD3<Float>(0, 0, 0),
                            "Expandir con una caja vacía no debe tocar el mínimo")
        XCTAssertSIMD3Igual(caja.max, SIMD3<Float>(1, 1, 1),
                            "Expandir con una caja vacía no debe tocar el máximo")
    }

    func testExpandirConOtraCajaUneAmbasCajas() {
        var caja = BoundingBox(min: SIMD3<Float>(0, 0, 0), max: SIMD3<Float>(1, 1, 1))
        caja.expand(BoundingBox(min: SIMD3<Float>(-2, 0.5, 3), max: SIMD3<Float>(0.5, 4, 5)))
        XCTAssertSIMD3Igual(caja.min, SIMD3<Float>(-2, 0, 0),
                            "La unión debe tomar el mínimo componente a componente")
        XCTAssertSIMD3Igual(caja.max, SIMD3<Float>(1, 4, 5),
                            "La unión debe tomar el máximo componente a componente")
        XCTAssertSIMD3Igual(caja.size, SIMD3<Float>(3, 4, 5),
                            "El tamaño de la unión debe ser (3,4,5) m")
    }

    func testIdaYVueltaCodableDeBoundingBox() throws {
        let original = BoundingBox(min: SIMD3<Float>(-4.2, -3.1, -1.0),
                                   max: SIMD3<Float>(5.9, 6.0, 2.4))
        let datos = try JSONEncoder().encode(original)
        let texto = String(decoding: datos, as: UTF8.self)
        XCTAssertTrue(texto.contains("\"min\""),
                      "El JSON de BoundingBox debe traer la clave 'min': \(texto)")
        XCTAssertTrue(texto.contains("\"max\""),
                      "El JSON de BoundingBox debe traer la clave 'max': \(texto)")

        let vuelta = try JSONDecoder().decode(BoundingBox.self, from: datos)
        XCTAssertEqual(vuelta, original,
                       "La caja decodificada debe ser idéntica a la original")
    }

    func testDecodificarBoundingBoxConComponentesInsuficientesLanzaFormatoInvalido() {
        let json = Data("{\"min\":[0,0],\"max\":[1,1,1]}".utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(BoundingBox.self, from: json),
                             "Una caja con 2 componentes en 'min' debe fallar al decodificar") { error in
            guard let scanError = error as? ScanError, case .formatoInvalido = scanError else {
                XCTFail("Se esperaba ScanError.formatoInvalido y llegó: \(error)")
                return
            }
        }
    }

    // =====================================================================
    // MARK: - ScanMesh
    // =====================================================================

    func testMallaDelCuboTieneOchoVerticesYDoceTriangulos() {
        let cubo = Fixtures.cubo()
        XCTAssertEqual(cubo.vertexCount, 8, "El cubo de referencia tiene 8 vértices")
        XCTAssertEqual(cubo.triangleCount, 12, "El cubo de referencia tiene 12 triángulos")
        XCTAssertEqual(cubo.indices.count, 36, "12 triángulos son 36 índices")
        XCTAssertFalse(cubo.isEmpty, "El cubo de referencia no está vacío")
        XCTAssertTrue(cubo.hasNormals, "El cubo de referencia trae normales por vértice")
        XCTAssertEqual(cubo.classifications.count, 12,
                       "Debe haber una clasificación por triángulo")
    }

    func testMallaDelCuboEsConsistente() {
        XCTAssertTrue(Fixtures.cubo().isConsistent,
                      "La malla del cubo de referencia debe ser consistente")
    }

    func testMallaConIndiceFueraDeRangoNoEsConsistente() {
        var cubo = Fixtures.cubo()
        cubo.indices[0] = 99   // sólo hay 8 vértices (0…7)
        XCTAssertFalse(cubo.isConsistent,
                       "Un índice 99 con sólo 8 vértices debe romper la consistencia")
    }

    func testMallaConIndicesNoMultiplosDeTresNoEsConsistente() {
        var cubo = Fixtures.cubo()
        cubo.indices.append(0)   // 37 índices
        XCTAssertFalse(cubo.isConsistent,
                       "37 índices no son múltiplo de 3, la malla no es consistente")
    }

    func testMallaConClasificacionesDesajustadasNoEsConsistente() {
        var cubo = Fixtures.cubo()
        cubo.classifications = [.wall]
        XCTAssertFalse(cubo.isConsistent,
                       "1 clasificación para 12 triángulos debe romper la consistencia")
    }

    func testMallaSinClasificacionesSigueSiendoConsistente() {
        var cubo = Fixtures.cubo()
        cubo.classifications = []
        XCTAssertTrue(cubo.isConsistent,
                      "La clasificación es opcional: vacía debe seguir siendo consistente")
    }

    func testAreaDeSuperficieDelCuboUnitarioEsSeisMetrosCuadrados() {
        XCTAssertEqual(Fixtures.cubo(lado: 1).surfaceArea(), 6.0, accuracy: 1e-4,
                       "6 caras de 1 m² dan 6 m² de superficie")
    }

    func testAreaDeSuperficieDelCuboDeDosMetrosEsVeinticuatro() {
        XCTAssertEqual(Fixtures.cubo(lado: 2).surfaceArea(), 24.0, accuracy: 1e-3,
                       "6 caras de 4 m² dan 24 m² de superficie")
    }

    func testMallaVaciaNoTieneGeometriaNiArea() {
        let vacia = ScanMesh()
        XCTAssertTrue(vacia.isEmpty, "Una malla recién creada está vacía")
        XCTAssertEqual(vacia.triangleCount, 0, "Una malla vacía tiene 0 triángulos")
        XCTAssertFalse(vacia.hasNormals, "Una malla vacía no tiene normales")
        XCTAssertEqual(vacia.surfaceArea(), 0.0, accuracy: 1e-9,
                       "El área de una malla vacía es 0 m²")
        XCTAssertTrue(vacia.bounds.isEmpty, "La caja de una malla vacía está vacía")
    }

    func testCajaEnvolventeDelCuboUnitario() {
        let caja = Fixtures.cubo(lado: 1).bounds
        XCTAssertSIMD3Igual(caja.min, SIMD3<Float>(0, 0, 0),
                            "El mínimo del cubo unitario en el origen es (0,0,0)")
        XCTAssertSIMD3Igual(caja.max, SIMD3<Float>(1, 1, 1),
                            "El máximo del cubo unitario en el origen es (1,1,1)")
        // sqrt(3) = 1.7320508
        XCTAssertEqual(caja.diagonal, 1.7320508, accuracy: 1e-5,
                       "La diagonal del cubo unitario es sqrt(3) ≈ 1.73205 m")
    }

    func testNormalesDelCuboSonUnitarias() {
        let cubo = Fixtures.cubo()
        for (i, n) in cubo.normals.enumerated() {
            XCTAssertEqual(simd_length(n), 1.0, accuracy: 1e-5,
                           "La normal del vértice \(i) debe ser unitaria")
        }
    }

    // =====================================================================
    // MARK: - PointCloud
    // =====================================================================

    func testNubeSinteticaTieneMilPuntosConsistentes() {
        let nube = Fixtures.nubePlana()
        XCTAssertEqual(nube.count, 1000, "La rejilla 25×40 debe producir 1000 puntos")
        XCTAssertFalse(nube.isEmpty, "La nube sintética no está vacía")
        XCTAssertTrue(nube.isConsistent, "Los tres arreglos paralelos deben ser consistentes")
        XCTAssertTrue(nube.hasColor, "La nube sintética trae color por punto")
        XCTAssertEqual(nube.colors.count, 1000, "Debe haber un color por punto")
        XCTAssertEqual(nube.confidences.count, 1000, "Debe haber una confianza por punto")
        XCTAssertEqual(nube.frame, .arkit, "La nube sintética nace en el marco ARKit")
    }

    func testCajaEnvolventeDeLaNubeSintetica() {
        let caja = Fixtures.nubePlana().bounds
        XCTAssertEqual(caja.min.x, 0.0, accuracy: 1e-5, "x mínimo de la rejilla es 0 m")
        XCTAssertEqual(caja.max.x, 3.9, accuracy: 1e-4, "x máximo de la rejilla es 3.9 m")
        XCTAssertEqual(caja.min.y, 0.0, accuracy: 1e-5, "la rejilla es plana en y = 0")
        XCTAssertEqual(caja.max.y, 0.0, accuracy: 1e-5, "la rejilla es plana en y = 0")
        XCTAssertEqual(caja.min.z, -2.4, accuracy: 1e-4, "z mínimo de la rejilla es −2.4 m")
        XCTAssertEqual(caja.max.z, 0.0, accuracy: 1e-5, "z máximo de la rejilla es 0 m")
    }

    func testNubeVaciaEsConsistenteYSinColor() {
        let nube = PointCloud()
        XCTAssertTrue(nube.isEmpty, "Una nube recién creada está vacía")
        XCTAssertEqual(nube.count, 0, "Una nube vacía tiene 0 puntos")
        XCTAssertTrue(nube.isConsistent, "Una nube vacía es trivialmente consistente")
        XCTAssertFalse(nube.hasColor, "Una nube vacía no tiene color")
    }

    func testNubeConColoresDesajustadosNoEsConsistente() {
        var nube = Fixtures.nubeMinima()
        nube.colors.removeLast()           // 3 posiciones, 2 colores
        XCTAssertFalse(nube.isConsistent,
                       "3 posiciones con 2 colores no es una nube consistente")
    }

    func testNubeConConfianzasDesajustadasNoEsConsistente() {
        var nube = Fixtures.nubeMinima()
        nube.confidences.append(2)         // 3 posiciones, 4 confianzas
        XCTAssertFalse(nube.isConsistent,
                       "3 posiciones con 4 confianzas no es una nube consistente")
    }

    func testNubeSinColorSigueSiendoConsistente() {
        var nube = Fixtures.nubeMinima()
        nube.colors = []
        XCTAssertTrue(nube.isConsistent,
                      "El color es opcional: sin colores la nube sigue siendo consistente")
        XCTAssertFalse(nube.hasColor, "Sin arreglo de colores hasColor debe ser falso")
    }

    func testAnexarNubesSumaLosTresArreglos() {
        var a = Fixtures.nubeMinima()
        let b = Fixtures.nubeMinima()
        a.append(b)
        XCTAssertEqual(a.count, 6, "3 + 3 puntos deben dar 6")
        XCTAssertEqual(a.colors.count, 6, "3 + 3 colores deben dar 6")
        XCTAssertEqual(a.confidences.count, 6, "3 + 3 confianzas deben dar 6")
        XCTAssertTrue(a.isConsistent, "La nube resultante debe seguir siendo consistente")
    }

    // =====================================================================
    // MARK: - ScanMetadata (Codable + ISO-8601)
    // =====================================================================

    func testIdaYVueltaCodableDeScanMetadataConFechasISO8601() throws {
        let original = Fixtures.metadatos()
        let datos = try ScanMetadata.jsonEncoder().encode(original)
        let texto = String(decoding: datos, as: UTF8.self)

        XCTAssertTrue(texto.contains(Fixtures.fechaFijaISO),
                      "La fecha de creación debe serializarse como \(Fixtures.fechaFijaISO)")
        XCTAssertTrue(texto.contains(Fixtures.fechaSecundariaISO),
                      "La fecha de la segunda medición debe ser \(Fixtures.fechaSecundariaISO)")
        XCTAssertTrue(texto.contains("josescan/1.0"),
                      "El JSON debe declarar el formato josescan/1.0")
        XCTAssertTrue(texto.contains("3F2504E0-4F89-41D3-9A0C-0305E82C3301"),
                      "El UUID debe ir en mayúsculas, como lo emite Foundation.UUID")

        let vuelta = try ScanMetadata.jsonDecoder().decode(ScanMetadata.self, from: datos)
        XCTAssertEqual(vuelta, original,
                       "Los metadatos decodificados deben ser idénticos a los originales")
        XCTAssertEqual(vuelta.creado.timeIntervalSince1970,
                       Fixtures.fechaFija.timeIntervalSince1970,
                       accuracy: 0.001,
                       "La fecha debe sobrevivir la ida y vuelta ISO-8601 al milisegundo")
        XCTAssertEqual(vuelta.mediciones.count, 2, "Deben conservarse las 2 mediciones")
        XCTAssertEqual(vuelta.marco, .arkit, "El marco debe conservarse")
        XCTAssertEqual(vuelta.geo?.latitude ?? 0, Fixtures.latBogota, accuracy: 1e-9,
                       "La latitud del ancla debe conservarse exactamente")
        XCTAssertEqual(vuelta.geo?.longitude ?? 0, Fixtures.lonBogota, accuracy: 1e-9,
                       "La longitud del ancla debe conservarse exactamente")
        XCTAssertEqual(vuelta.bbox?.max.x ?? 0, 3.9, accuracy: 1e-5,
                       "La caja envolvente debe conservarse")
    }

    func testMetadatosSinAnclaSerializanGeoAusente() throws {
        let original = Fixtures.metadatos(conAncla: false)
        let datos = try ScanMetadata.jsonEncoder().encode(original)
        let vuelta = try ScanMetadata.jsonDecoder().decode(ScanMetadata.self, from: datos)
        XCTAssertNil(vuelta.geo, "Sin ancla, 'geo' debe quedar nulo tras la ida y vuelta")
        XCTAssertEqual(vuelta, original, "El resto de campos debe conservarse")
    }

    func testFormatoActualEsJoseScanUnoPuntoCero() {
        XCTAssertEqual(ScanMetadata.formatoActual, "josescan/1.0",
                       "El contrato vigente es josescan/1.0")
        XCTAssertEqual(Fixtures.metadatos().formato, "josescan/1.0",
                       "Todo metadato nuevo nace con el formato vigente")
    }

    func testMedicionRoundTripCodable() throws {
        let original = Fixtures.mediciones()
        let datos = try ScanMetadata.jsonEncoder().encode(original)
        let vuelta = try ScanMetadata.jsonDecoder().decode([MeasurementRecord].self, from: datos)
        XCTAssertEqual(vuelta, original, "Las mediciones deben sobrevivir la ida y vuelta")
        XCTAssertEqual(vuelta[0].kind, .distancia, "La primera medición es una distancia")
        XCTAssertEqual(vuelta[0].value, 3.42, accuracy: 1e-9, "El valor debe ser 3.42 m")
        XCTAssertEqual(vuelta[0].unit, "m", "La unidad de una distancia es el metro")
        XCTAssertEqual(vuelta[1].points.count, 4, "El área guarda sus 4 vértices")
    }

    // =====================================================================
    // MARK: - GeoReference
    // =====================================================================

    func testAnclaDeBogotaEsConfiable() {
        XCTAssertTrue(Fixtures.anclaBogota().esConfiable,
                      "3 m horizontal y 5° de rumbo son precisiones aceptables")
    }

    func testAnclaSinPrecisionNoEsConfiable() {
        let ancla = GeoReference(latitude: 4.6, longitude: -74.1)
        XCTAssertFalse(ancla.esConfiable,
                       "Las precisiones por omisión (−1) marcan el ancla como no confiable")
    }

    func testAnclaConPrecisionPobreNoEsConfiable() {
        var ancla = Fixtures.anclaBogota()
        ancla.horizontalAccuracy = 25
        XCTAssertFalse(ancla.esConfiable,
                       "25 m de error horizontal supera el umbral de 20 m")
        ancla.horizontalAccuracy = 3
        ancla.headingAccuracy = 20
        XCTAssertFalse(ancla.esConfiable,
                       "20° de error de rumbo supera el umbral de 15°")
    }

    // =====================================================================
    // MARK: - ScanDocument
    // =====================================================================

    func testRefrescarMetadatosSincronizaContadoresYCajaEnvolvente() {
        let doc = ScanDocument(metadata: ScanMetadata(nombre: "Prueba"),
                               cloud: Fixtures.nubePlana(),
                               mesh: Fixtures.cubo())
        doc.refreshMetadata()

        XCTAssertEqual(doc.metadata.puntos, 1000, "Deben registrarse los 1000 puntos")
        XCTAssertEqual(doc.metadata.vertices, 8, "Deben registrarse los 8 vértices del cubo")
        XCTAssertEqual(doc.metadata.triangulos, 12, "Deben registrarse los 12 triángulos")
        XCTAssertEqual(doc.metadata.marco, .arkit,
                       "Con malla presente el marco se toma de la malla (.arkit)")

        XCTAssertNotNil(doc.metadata.bbox,
                        "Con geometría cargada debe existir una caja envolvente")
        if let caja = doc.metadata.bbox {
            // Unión de la rejilla [0…3.9] × 0 × [−2.4…0] con el cubo [0…1]³.
            XCTAssertSIMD3Igual(caja.min, SIMD3<Float>(0, 0, -2.4), exactitud: 1e-4,
                                "El mínimo de la unión debe ser (0, 0, −2.4)")
            XCTAssertSIMD3Igual(caja.max, SIMD3<Float>(3.9, 1, 1), exactitud: 1e-4,
                                "El máximo de la unión debe ser (3.9, 1, 1)")
        }
    }

    func testRefrescarMetadatosSinMallaTomaElMarcoDeLaNube() {
        let doc = ScanDocument(metadata: ScanMetadata(nombre: "Sólo nube"),
                               cloud: Fixtures.nubePlana(marco: .enu),
                               mesh: ScanMesh())
        doc.refreshMetadata()
        XCTAssertEqual(doc.metadata.marco, .enu,
                       "Sin malla el marco debe tomarse de la nube (.enu)")
        XCTAssertEqual(doc.metadata.triangulos, 0, "Sin malla no hay triángulos")
        XCTAssertEqual(doc.metadata.puntos, 1000, "Los puntos de la nube sí se cuentan")
    }

    func testDocumentoVacioNoProduceCajaEnvolvente() {
        let doc = ScanDocument(metadata: ScanMetadata(nombre: "Vacío"))
        doc.refreshMetadata()
        XCTAssertTrue(doc.isEmpty, "Un documento sin nube ni malla está vacío")
        XCTAssertNil(doc.metadata.bbox, "Sin geometría no debe haber caja envolvente")
        XCTAssertEqual(doc.metadata.puntos, 0, "Sin geometría hay 0 puntos")
        XCTAssertEqual(doc.metadata.vertices, 0, "Sin geometría hay 0 vértices")
    }

    // =====================================================================
    // MARK: - ScanQualityMetrics
    // =====================================================================

    func testPuntuacionDeCalidadEsCeroSinPuntos() {
        let m = ScanQualityMetrics()
        XCTAssertEqual(m.score, 0, "Sin puntos capturados la puntuación debe ser 0")
    }

    func testPuntuacionDeCalidadPerfectaEsCien() {
        var m = ScanQualityMetrics()
        m.pointCount = 400_000
        m.highConfidenceRatio = 1.0
        m.trackingOK = true
        XCTAssertEqual(m.score, 100,
                       "400k puntos, 100 % de confianza alta y seguimiento OK dan 100")
    }

    func testPuntuacionDeCalidadIntermediaEsCuarentaYOcho() {
        var m = ScanQualityMetrics()
        m.pointCount = 200_000          // densidad 0.5 → 0.20
        m.highConfidenceRatio = 0.5     // confianza 0.5 → 0.20
        m.trackingOK = false            // seguimiento 0.4 → 0.08
        XCTAssertEqual(m.score, 48,
                       "0.5·0.4 + 0.5·0.4 + 0.4·0.2 = 0.48 → 48 puntos")
    }

    func testPuntuacionDeCalidadSaturaPorEncimaDeCuatrocientosMilPuntos() {
        var m = ScanQualityMetrics()
        m.pointCount = 5_000_000
        m.highConfidenceRatio = 1.0
        m.trackingOK = true
        XCTAssertEqual(m.score, 100,
                       "La densidad satura en 1.0: más de 400k puntos no supera 100")
    }

    func testPuntuacionDeCalidadSiempreEntreCeroYCien() {
        let densidades = [0, 1, 1_000, 50_000, 399_999, 400_000, 2_000_000]
        let confianzas = [0.0, 0.25, 0.5, 0.75, 1.0]
        for puntos in densidades {
            for confianza in confianzas {
                for seguimiento in [true, false] {
                    var m = ScanQualityMetrics()
                    m.pointCount = puntos
                    m.highConfidenceRatio = confianza
                    m.trackingOK = seguimiento
                    XCTAssertGreaterThanOrEqual(m.score, 0,
                        "La puntuación nunca puede ser negativa (puntos=\(puntos), conf=\(confianza))")
                    XCTAssertLessThanOrEqual(m.score, 100,
                        "La puntuación nunca puede pasar de 100 (puntos=\(puntos), conf=\(confianza))")
                }
            }
        }
    }

    // =====================================================================
    // MARK: - ScanExportFormat
    // =====================================================================

    func testExtensionDeArchivoDeTodosLosFormatos() {
        let esperadas: [ScanExportFormat: String] = [
            .ply: "ply",
            .plyAscii: "ply",
            .obj: "obj",
            .stl: "stl",
            .usdz: "usdz",
            .xyz: "xyz",
            .geojson: "geojson",
            .csv: "csv",
            .bundle: "josescan"
        ]
        XCTAssertEqual(ScanExportFormat.allCases.count, 9,
                       "El contrato define exactamente 9 formatos de exportación")
        for formato in ScanExportFormat.allCases {
            XCTAssertEqual(formato.extensionArchivo, esperadas[formato] ?? "<sin definir>",
                           "Extensión inesperada para el formato \(formato.rawValue)")
        }
    }

    func testRequiereMallaSoloEnFormatosDeMalla() {
        let conMalla: Set<ScanExportFormat> = [.obj, .stl, .usdz]
        for formato in ScanExportFormat.allCases {
            XCTAssertEqual(formato.requiereMalla, conMalla.contains(formato),
                           "requiereMalla incorrecto para \(formato.rawValue): sólo obj, stl y usdz necesitan malla")
        }
    }

    func testIdentificadorYNombreDeCadaFormato() {
        for formato in ScanExportFormat.allCases {
            XCTAssertEqual(formato.id, formato.rawValue,
                           "El id de \(formato.rawValue) debe coincidir con su rawValue")
            XCTAssertFalse(formato.nombre.isEmpty,
                           "El formato \(formato.rawValue) debe tener nombre legible")
        }
    }

    func testIdaYVueltaCodableDeFormatoDeExportacion() throws {
        for formato in ScanExportFormat.allCases {
            let datos = try JSONEncoder().encode([formato])
            let vuelta = try JSONDecoder().decode([ScanExportFormat].self, from: datos)
            XCTAssertEqual(vuelta, [formato],
                           "El formato \(formato.rawValue) debe sobrevivir la ida y vuelta JSON")
        }
    }

    // =====================================================================
    // MARK: - ScanFaceClass y ScanError
    // =====================================================================

    func testNombresDeClasificacionSemanticaEnEspanol() {
        XCTAssertEqual(ScanFaceClass.allCases.count, 8,
                       "ARKit expone 8 clasificaciones semánticas")
        XCTAssertEqual(ScanFaceClass.none.nombre, "Sin clasificar", "Nombre de .none")
        XCTAssertEqual(ScanFaceClass.wall.nombre, "Muro", "Nombre de .wall")
        XCTAssertEqual(ScanFaceClass.floor.nombre, "Piso", "Nombre de .floor")
        XCTAssertEqual(ScanFaceClass.ceiling.nombre, "Techo", "Nombre de .ceiling")
        XCTAssertEqual(ScanFaceClass.table.nombre, "Mesa", "Nombre de .table")
        XCTAssertEqual(ScanFaceClass.seat.nombre, "Asiento", "Nombre de .seat")
        XCTAssertEqual(ScanFaceClass.window.nombre, "Ventana", "Nombre de .window")
        XCTAssertEqual(ScanFaceClass.door.nombre, "Puerta", "Nombre de .door")
        XCTAssertEqual(ScanFaceClass.floor.rawValue, 2,
                       "El valor bruto de .floor debe ser 2, igual que ARMeshClassification")
    }

    func testDescripcionesDeErrorEnEspanol() {
        XCTAssertNotEqual(ScanError.sinGeorreferencia, ScanError.sinDatos,
                          "Dos casos distintos de ScanError no pueden ser iguales")
        XCTAssertEqual(ScanError.escrituraFallida("disco lleno"),
                       ScanError.escrituraFallida("disco lleno"),
                       "Dos errores con el mismo detalle deben ser iguales")
        XCTAssertNotEqual(ScanError.formatoInvalido("a"),
                          ScanError.formatoInvalido("b"),
                          "Dos formatos inválidos con distinto detalle no son iguales")
        XCTAssertNotNil(ScanError.sinDatos.errorDescription,
                        "Todo error debe traer descripción localizada")
        XCTAssertTrue(ScanError.formatoInvalido("PLY sin cabecera")
                        .errorDescription?.contains("PLY sin cabecera") ?? false,
                      "La descripción debe incluir el detalle del formato inválido")
    }
}
