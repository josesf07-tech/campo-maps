//
//  MeasurementEngineTests.swift
//  JoseScanTests
//
//  Pruebas del motor de medición: distancias, azimut, perímetro, área,
//  área proyectada y volumen. Todo con geometría analítica exacta.
//
//  Recordatorio de marcos (docs/FORMATO-ESCANEO.md §3):
//    .arkit → +X derecha, +Y ARRIBA, −Z avance  ⇒ plano horizontal = XZ
//    .enu   → +X este,    +Y norte, +Z ARRIBA   ⇒ plano horizontal = XY
//

import XCTest
import Foundation
import simd
@testable import JoseScan

final class MeasurementEngineTests: XCTestCase {

    // Triángulo rectángulo 3-4-5 en el plano horizontal de ARKit (XZ).
    private let triangulo345: [SIMD3<Float>] = [
        SIMD3<Float>(0, 0, 0),
        SIMD3<Float>(3, 0, 0),
        SIMD3<Float>(0, 0, 4)
    ]

    // Rectángulo inclinado 45°: lados 2 y 2·√2 → área 4·√2 ≈ 5.656854 m²,
    // pero su proyección horizontal es un cuadrado de 2 × 2 = 4 m²
    // tanto en XZ como en XY.
    private let rectanguloInclinado: [SIMD3<Float>] = [
        SIMD3<Float>(0, 0, 0),
        SIMD3<Float>(2, 0, 0),
        SIMD3<Float>(2, 2, 2),
        SIMD3<Float>(0, 2, 2)
    ]

    // =====================================================================
    // MARK: - Distancia
    // =====================================================================

    func testDistanciaEntreDosPuntosDelTrianguloTresCuatroCinco() {
        let d = MeasurementEngine.distancia(SIMD3<Float>(0, 0, 0), SIMD3<Float>(3, 4, 0))
        XCTAssertEqual(d, 5.0, accuracy: 1e-6,
                       "La distancia entre (0,0,0) y (3,4,0) debe ser 5 m")
    }

    func testDistanciaEnLasTresDimensiones() {
        let d = MeasurementEngine.distancia(SIMD3<Float>(1, 2, 3), SIMD3<Float>(4, 6, 15))
        // sqrt(3² + 4² + 12²) = sqrt(169) = 13
        XCTAssertEqual(d, 13.0, accuracy: 1e-5,
                       "La distancia entre (1,2,3) y (4,6,15) debe ser 13 m")
    }

    func testDistanciaDeUnPuntoASiMismoEsCero() {
        let p = SIMD3<Float>(-2.5, 7.25, 0.125)
        XCTAssertEqual(MeasurementEngine.distancia(p, p), 0.0, accuracy: 1e-9,
                       "La distancia de un punto a sí mismo debe ser 0 m")
    }

    func testLaDistanciaEsSimetrica() {
        let a = SIMD3<Float>(1, -2, 3)
        let b = SIMD3<Float>(-4, 5, -6)
        XCTAssertEqual(MeasurementEngine.distancia(a, b),
                       MeasurementEngine.distancia(b, a),
                       accuracy: 1e-9,
                       "d(a,b) debe ser igual a d(b,a)")
    }

    func testDistanciaHorizontalIgnoraLaComponenteVerticalDeARKit() {
        // CONVENIO: la firma no recibe marco, así que se asume el marco de
        // captura (ARKit): el plano horizontal es XZ y se descarta la Y.
        let a = SIMD3<Float>(0, 0, 0)
        let b = SIMD3<Float>(3, 10, 4)
        XCTAssertEqual(MeasurementEngine.distanciaHorizontal(a, b), 5.0, accuracy: 1e-5,
                       "distanciaHorizontal debe descartar el eje vertical de ARKit (Y): sqrt(3²+4²) = 5 m")
    }

    func testDistanciaHorizontalSobreElEjeEsteEsIndependienteDelConvenio() {
        let a = SIMD3<Float>(0, 0, 0)
        let b = SIMD3<Float>(3, 0, 0)
        XCTAssertEqual(MeasurementEngine.distanciaHorizontal(a, b), 3.0, accuracy: 1e-6,
                       "Un desplazamiento puro en X mide 3 m en horizontal")
        XCTAssertEqual(MeasurementEngine.distanciaHorizontal(a, a), 0.0, accuracy: 1e-9,
                       "La distancia horizontal de un punto a sí mismo es 0 m")
    }

    func testLaDistanciaHorizontalNuncaSuperaLaDistanciaTridimensional() {
        let casos: [(SIMD3<Float>, SIMD3<Float>)] = [
            (SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 1, 1)),
            (SIMD3<Float>(-3, 2, 7), SIMD3<Float>(4, -8, 1)),
            (SIMD3<Float>(0, 0, 0), SIMD3<Float>(0, 9, 0))
        ]
        for (a, b) in casos {
            XCTAssertLessThanOrEqual(MeasurementEngine.distanciaHorizontal(a, b),
                                     MeasurementEngine.distancia(a, b) + 1e-6,
                                     "La proyección horizontal nunca puede ser mayor que la distancia 3D")
        }
    }

    // =====================================================================
    // MARK: - Azimut
    // =====================================================================

    func testAzimutHaciaElEsteEnMarcoEnuEsNoventaGrados() {
        let az = MeasurementEngine.azimut(SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0),
                                          marco: .enu, rumboGrados: 0)
        XCTAssertEqual(az, 90.0, accuracy: 1e-4,
                       "En ENU, avanzar en +X (este) debe dar azimut 90°")
    }

    func testAzimutDeLosCuatroRumbosCardinalesEnMarcoEnu() {
        let origen = SIMD3<Float>(0, 0, 0)
        let esperados: [(SIMD3<Float>, Double, String)] = [
            (SIMD3<Float>(0, 1, 0), 0.0, "norte"),
            (SIMD3<Float>(1, 0, 0), 90.0, "este"),
            (SIMD3<Float>(0, -1, 0), 180.0, "sur"),
            (SIMD3<Float>(-1, 0, 0), 270.0, "oeste")
        ]
        for (destino, esperado, nombre) in esperados {
            let az = MeasurementEngine.azimut(origen, destino, marco: .enu, rumboGrados: 0)
            XCTAssertEqual(az, esperado, accuracy: 1e-4,
                           "En ENU el rumbo hacia el \(nombre) debe ser \(esperado)°")
        }
    }

    func testAzimutNoresteEnMarcoEnuEsCuarentaYCincoGrados() {
        let az = MeasurementEngine.azimut(SIMD3<Float>(0, 0, 0), SIMD3<Float>(5, 5, 0),
                                          marco: .enu, rumboGrados: 0)
        XCTAssertEqual(az, 45.0, accuracy: 1e-4,
                       "En ENU, (5 este, 5 norte) debe dar azimut 45° (noreste)")
    }

    func testElAzimutEnMarcoEnuIgnoraElRumboDelDispositivo() {
        let a = MeasurementEngine.azimut(SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0),
                                         marco: .enu, rumboGrados: 0)
        let b = MeasurementEngine.azimut(SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0),
                                         marco: .enu, rumboGrados: 137.5)
        XCTAssertEqual(a, b, accuracy: 1e-6,
                       "En ENU los datos ya están orientados al norte: el rumbo no debe influir")
    }

    func testAzimutEnMarcoARKitConRumboCero() {
        let origen = SIMD3<Float>(0, 0, 0)
        let esperados: [(SIMD3<Float>, Double, String)] = [
            (SIMD3<Float>(0, 0, -1), 0.0, "norte (avance −Z)"),
            (SIMD3<Float>(1, 0, 0), 90.0, "este (+X)"),
            (SIMD3<Float>(0, 0, 1), 180.0, "sur (+Z)"),
            (SIMD3<Float>(-1, 0, 0), 270.0, "oeste (−X)")
        ]
        for (destino, esperado, nombre) in esperados {
            let az = MeasurementEngine.azimut(origen, destino, marco: .arkit, rumboGrados: 0)
            XCTAssertEqual(az, esperado, accuracy: 1e-4,
                           "En ARKit con rumbo 0 el azimut hacia \(nombre) debe ser \(esperado)°")
        }
    }

    func testAzimutEnMarcoARKitConRumboNoventaGiraTodoNoventaGrados() {
        // Con rumbo 90° el eje de avance (−Z) mira al este.
        let az = MeasurementEngine.azimut(SIMD3<Float>(0, 0, 0), SIMD3<Float>(0, 0, -1),
                                          marco: .arkit, rumboGrados: 90)
        XCTAssertEqual(az, 90.0, accuracy: 1e-4,
                       "En ARKit con rumbo 90° el avance −Z debe dar azimut 90° (este)")

        let az2 = MeasurementEngine.azimut(SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0),
                                           marco: .arkit, rumboGrados: 90)
        XCTAssertEqual(az2, 180.0, accuracy: 1e-4,
                       "En ARKit con rumbo 90° el eje +X debe dar azimut 180° (sur)")
    }

    func testElAzimutIgnoraLaDiferenciaDeAltura() {
        let az = MeasurementEngine.azimut(SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 25),
                                          marco: .enu, rumboGrados: 0)
        XCTAssertEqual(az, 90.0, accuracy: 1e-4,
                       "En ENU la componente vertical (+Z) no debe alterar el azimut al este")
    }

    func testElAzimutSiempreQuedaEntreCeroYTrescientosSesenta() {
        let origen = SIMD3<Float>(0, 0, 0)
        for grado in stride(from: 0, to: 360, by: 15) {
            let radianes = Float(Double(grado) * .pi / 180.0)
            let destino = SIMD3<Float>(sin(radianes), cos(radianes), 0)
            let az = MeasurementEngine.azimut(origen, destino, marco: .enu, rumboGrados: 0)
            XCTAssertGreaterThanOrEqual(az, 0.0,
                                        "El azimut nunca puede ser negativo (dirección \(grado)°)")
            XCTAssertLessThan(az, 360.0,
                              "El azimut debe normalizarse por debajo de 360° (dirección \(grado)°)")
        }
    }

    // =====================================================================
    // MARK: - Perímetro
    // =====================================================================

    func testPerimetroDelCuadradoDeDosMetrosEsOchoMetros() {
        XCTAssertEqual(MeasurementEngine.perimetro(Fixtures.cuadradoXZ), 8.0, accuracy: 1e-5,
                       "El perímetro cerrado de un cuadrado de 2 m de lado es 8 m")
        XCTAssertEqual(MeasurementEngine.perimetro(Fixtures.cuadradoXY), 8.0, accuracy: 1e-5,
                       "El perímetro no depende del plano en el que esté el cuadrado")
    }

    func testPerimetroDelRectanguloCuatroPorTresEsCatorceMetros() {
        XCTAssertEqual(MeasurementEngine.perimetro(Fixtures.rectanguloXY), 14.0, accuracy: 1e-5,
                       "El perímetro de un rectángulo 4 × 3 es 2·(4+3) = 14 m")
    }

    func testPerimetroDelTrianguloTresCuatroCincoEsDoceMetros() {
        XCTAssertEqual(MeasurementEngine.perimetro(triangulo345), 12.0, accuracy: 1e-5,
                       "El perímetro del triángulo 3-4-5 es 3 + 4 + 5 = 12 m")
    }

    func testPerimetroConMenosDeDosPuntosEsCero() {
        XCTAssertEqual(MeasurementEngine.perimetro([]), 0.0, accuracy: 1e-9,
                       "Sin puntos el perímetro debe ser 0 m")
        XCTAssertEqual(MeasurementEngine.perimetro([SIMD3<Float>(1, 2, 3)]), 0.0, accuracy: 1e-9,
                       "Con un solo punto el perímetro debe ser 0 m")
    }

    // =====================================================================
    // MARK: - Área del polígono
    // =====================================================================

    func testAreaDelCuadradoDeDosMetrosEsCuatroMetrosCuadrados() {
        XCTAssertEqual(MeasurementEngine.areaPoligono(Fixtures.cuadradoXZ), 4.0, accuracy: 1e-5,
                       "El área de un cuadrado de 2 m de lado es 4 m² (plano XZ)")
        XCTAssertEqual(MeasurementEngine.areaPoligono(Fixtures.cuadradoXY), 4.0, accuracy: 1e-5,
                       "El área de un cuadrado de 2 m de lado es 4 m² (plano XY)")
    }

    func testAreaDelRectanguloCuatroPorTresEsDoceMetrosCuadrados() {
        XCTAssertEqual(MeasurementEngine.areaPoligono(Fixtures.rectanguloXY), 12.0, accuracy: 1e-5,
                       "El área de un rectángulo 4 × 3 es 12 m²")
    }

    func testAreaDelTrianguloTresCuatroCincoEsSeisMetrosCuadrados() {
        XCTAssertEqual(MeasurementEngine.areaPoligono(triangulo345), 6.0, accuracy: 1e-5,
                       "El área del triángulo rectángulo de catetos 3 y 4 es 6 m²")
    }

    func testAreaDeUnPoligonoInclinadoUsaSuPlanoReal() {
        // Rectángulo de 2 × 2·√2 inclinado 45° → 4·√2 = 5.6568542 m²
        XCTAssertEqual(MeasurementEngine.areaPoligono(rectanguloInclinado), 5.6568542, accuracy: 1e-4,
                       "El área de un rectángulo inclinado 45° de 2 × 2√2 es 4·√2 ≈ 5.65685 m²")
    }

    func testAreaConMenosDeTresPuntosEsCero() {
        XCTAssertEqual(MeasurementEngine.areaPoligono([]), 0.0, accuracy: 1e-9,
                       "Sin puntos el área debe ser 0 m²")
        XCTAssertEqual(MeasurementEngine.areaPoligono([SIMD3<Float>(0, 0, 0),
                                                       SIMD3<Float>(1, 0, 0)]),
                       0.0, accuracy: 1e-9,
                       "Con dos puntos no hay superficie: el área debe ser 0 m²")
    }

    func testAreaDeUnPoligonoDegeneradoEsCero() {
        // Tres puntos colineales no encierran superficie.
        let colineales = [SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0), SIMD3<Float>(2, 0, 0)]
        XCTAssertEqual(MeasurementEngine.areaPoligono(colineales), 0.0, accuracy: 1e-6,
                       "Tres puntos colineales tienen área 0 m²")
    }

    // =====================================================================
    // MARK: - Área proyectada
    // =====================================================================

    func testAreaProyectadaDelCuadradoHorizontalDeARKit() {
        XCTAssertEqual(MeasurementEngine.areaProyectada(Fixtures.cuadradoXZ, marco: .arkit),
                       4.0, accuracy: 1e-5,
                       "En ARKit el plano horizontal es XZ: el cuadrado en XZ proyecta 4 m²")
        XCTAssertEqual(MeasurementEngine.areaProyectada(Fixtures.cuadradoXZ, marco: .enu),
                       0.0, accuracy: 1e-5,
                       "En ENU el plano horizontal es XY: un cuadrado contenido en XZ (y = 0) proyecta 0 m²")
    }

    func testAreaProyectadaDelCuadradoHorizontalDeEnu() {
        XCTAssertEqual(MeasurementEngine.areaProyectada(Fixtures.cuadradoXY, marco: .enu),
                       4.0, accuracy: 1e-5,
                       "En ENU el plano horizontal es XY: el cuadrado en XY proyecta 4 m²")
        XCTAssertEqual(MeasurementEngine.areaProyectada(Fixtures.cuadradoXY, marco: .arkit),
                       0.0, accuracy: 1e-5,
                       "En ARKit un cuadrado contenido en XY (z = 0) proyecta 0 m²")
    }

    func testAreaProyectadaDelRectanguloEnEnuEsDoceMetrosCuadrados() {
        XCTAssertEqual(MeasurementEngine.areaProyectada(Fixtures.rectanguloXY, marco: .enu),
                       12.0, accuracy: 1e-5,
                       "El rectángulo 4 × 3 en el plano XY proyecta 12 m² en ENU")
    }

    func testAreaProyectadaDeUnPoligonoInclinadoEsMenorQueSuAreaReal() {
        let real = MeasurementEngine.areaPoligono(rectanguloInclinado)
        let enArkit = MeasurementEngine.areaProyectada(rectanguloInclinado, marco: .arkit)
        let enEnu = MeasurementEngine.areaProyectada(rectanguloInclinado, marco: .enu)
        XCTAssertEqual(enArkit, 4.0, accuracy: 1e-4,
                       "La sombra en XZ del rectángulo inclinado es un cuadrado de 2 × 2 = 4 m²")
        XCTAssertEqual(enEnu, 4.0, accuracy: 1e-4,
                       "La sombra en XY del rectángulo inclinado es un cuadrado de 2 × 2 = 4 m²")
        XCTAssertLessThan(enArkit, real,
                          "La proyección horizontal de una superficie inclinada es menor que su área real")
    }

    func testAreaProyectadaConMenosDeTresPuntosEsCero() {
        for marco in [ScanCoordinateFrame.arkit, ScanCoordinateFrame.enu] {
            XCTAssertEqual(MeasurementEngine.areaProyectada([], marco: marco), 0.0, accuracy: 1e-9,
                           "Sin puntos el área proyectada debe ser 0 m² (marco \(marco.rawValue))")
        }
    }

    // =====================================================================
    // MARK: - Volumen
    // =====================================================================

    func testVolumenDelCuboUnitarioSobreNivelBaseCeroEsUnMetroCubico() {
        let cubo = Fixtures.cubo(lado: 1)
        XCTAssertEqual(MeasurementEngine.volumen(malla: cubo, nivelBase: 0, marco: .arkit),
                       1.0, accuracy: 1e-3,
                       "Un cubo de 1 m apoyado en el nivel 0 encierra 1 m³ (marco ARKit)")
        XCTAssertEqual(MeasurementEngine.volumen(malla: cubo, nivelBase: 0, marco: .enu),
                       1.0, accuracy: 1e-3,
                       "Un cubo de 1 m apoyado en el nivel 0 encierra 1 m³ (marco ENU)")
    }

    func testVolumenDelCuboDeDosMetrosEsOchoMetrosCubicos() {
        let cubo = Fixtures.cubo(lado: 2)
        XCTAssertEqual(MeasurementEngine.volumen(malla: cubo, nivelBase: 0, marco: .arkit),
                       8.0, accuracy: 1e-3,
                       "Un cubo de 2 m de arista encierra 8 m³")
    }

    func testVolumenDeUnCuboElevadoSobreSuPropioNivelBase() {
        // Cubo de 1 m cuya cara inferior está a 2 m de altura en ARKit (+Y).
        let cubo = Fixtures.cubo(lado: 1, origen: SIMD3<Float>(0, 2, 0))
        XCTAssertEqual(MeasurementEngine.volumen(malla: cubo, nivelBase: 2, marco: .arkit),
                       1.0, accuracy: 1e-3,
                       "El cubo sigue encerrando 1 m³ medido desde su propio nivel base (y = 2)")
    }

    func testVolumenDeUnaMallaVaciaEsCero() {
        XCTAssertEqual(MeasurementEngine.volumen(malla: ScanMesh(), nivelBase: 0, marco: .arkit),
                       0.0, accuracy: 1e-9,
                       "Una malla vacía no encierra volumen")
    }

    func testElVolumenNuncaEsNegativo() {
        for nivel in [Float(-5), 0, 0.5, 5] {
            for marco in [ScanCoordinateFrame.arkit, ScanCoordinateFrame.enu] {
                let v = MeasurementEngine.volumen(malla: Fixtures.cubo(), nivelBase: nivel, marco: marco)
                XCTAssertGreaterThanOrEqual(v, 0.0,
                    "El volumen reportado no puede ser negativo (nivel \(nivel), marco \(marco.rawValue))")
            }
        }
    }

    // =====================================================================
    // MARK: - medir(_:puntos:marco:rumboGrados:etiqueta:)
    // =====================================================================

    func testMedirDistanciaDevuelveUnRegistroCompleto() throws {
        let puntos = [SIMD3<Float>(0, 0, 0), SIMD3<Float>(3, 4, 0)]
        let registro = try XCTUnwrap(
            MeasurementEngine.medir(.distancia, puntos: puntos, marco: .arkit,
                                    rumboGrados: 0, etiqueta: "Ancho"),
            "Con dos puntos debe poder medirse una distancia")

        XCTAssertEqual(registro.kind, .distancia, "El tipo del registro debe ser .distancia")
        XCTAssertEqual(registro.value, 5.0, accuracy: 1e-5, "La distancia medida debe ser 5 m")
        XCTAssertEqual(registro.unit, "m", "La unidad de una distancia es el metro")
        XCTAssertEqual(registro.label, "Ancho", "La etiqueta debe conservarse tal cual")
        XCTAssertEqual(registro.points.count, 2, "Deben guardarse los 2 puntos de la medición")
        XCTAssertEqual(registro.points[0].count, 3, "Cada punto se guarda como [x, y, z]")
        XCTAssertEqual(registro.points[1][0], 3.0, accuracy: 1e-6,
                       "La coordenada X del segundo punto debe ser 3")
        XCTAssertEqual(registro.points[1][1], 4.0, accuracy: 1e-6,
                       "La coordenada Y del segundo punto debe ser 4")
    }

    func testMedirAreaDevuelveCuatroMetrosCuadrados() throws {
        let registro = try XCTUnwrap(
            MeasurementEngine.medir(.area, puntos: Fixtures.cuadradoXZ, marco: .arkit,
                                    rumboGrados: 0, etiqueta: nil),
            "Con cuatro puntos debe poder medirse un área")
        XCTAssertEqual(registro.kind, .area, "El tipo del registro debe ser .area")
        XCTAssertEqual(registro.value, 4.0, accuracy: 1e-5,
                       "El área del cuadrado de 2 m es 4 m²")
        XCTAssertEqual(registro.unit, "m²", "La unidad de un área es el metro cuadrado")
        XCTAssertNil(registro.label, "Sin etiqueta el registro no debe inventarse una")
        XCTAssertEqual(registro.points.count, 4, "Deben guardarse los 4 vértices")
    }

    func testMedirAzimutHaciaElEsteDevuelveNoventaGrados() throws {
        let puntos = [SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0)]
        let registro = try XCTUnwrap(
            MeasurementEngine.medir(.azimut, puntos: puntos, marco: .enu,
                                    rumboGrados: 0, etiqueta: "Eje vía"),
            "Con dos puntos debe poder medirse un azimut")
        XCTAssertEqual(registro.kind, .azimut, "El tipo del registro debe ser .azimut")
        XCTAssertEqual(registro.value, 90.0, accuracy: 1e-4,
                       "El azimut hacia el este debe ser 90°")
    }

    func testMedirDevuelveNilConPuntosInsuficientes() {
        XCTAssertNil(MeasurementEngine.medir(.distancia, puntos: [], marco: .arkit,
                                             rumboGrados: 0, etiqueta: nil),
                     "Una distancia sin puntos no puede medirse")
        XCTAssertNil(MeasurementEngine.medir(.distancia, puntos: [SIMD3<Float>(0, 0, 0)],
                                             marco: .arkit, rumboGrados: 0, etiqueta: nil),
                     "Una distancia necesita 2 puntos, con 1 debe devolver nil")
        XCTAssertNil(MeasurementEngine.medir(.azimut, puntos: [SIMD3<Float>(1, 1, 1)],
                                             marco: .enu, rumboGrados: 0, etiqueta: nil),
                     "Un azimut necesita 2 puntos, con 1 debe devolver nil")
        XCTAssertNil(MeasurementEngine.medir(.altura, puntos: [SIMD3<Float>(1, 1, 1)],
                                             marco: .arkit, rumboGrados: 0, etiqueta: nil),
                     "Una altura necesita 2 puntos, con 1 debe devolver nil")
        XCTAssertNil(MeasurementEngine.medir(.area, puntos: [SIMD3<Float>(0, 0, 0),
                                                             SIMD3<Float>(1, 0, 0)],
                                             marco: .arkit, rumboGrados: 0, etiqueta: nil),
                     "Un área necesita al menos 3 puntos, con 2 debe devolver nil")
        XCTAssertNil(MeasurementEngine.medir(.volumen, puntos: [], marco: .arkit,
                                             rumboGrados: 0, etiqueta: nil),
                     "Un volumen sin puntos no puede medirse")
    }

    func testCadaMedicionRecibeUnIdentificadorPropio() throws {
        let puntos = [SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0)]
        let a = try XCTUnwrap(MeasurementEngine.medir(.distancia, puntos: puntos, marco: .arkit,
                                                      rumboGrados: 0, etiqueta: nil),
                              "La primera medición debe crearse")
        let b = try XCTUnwrap(MeasurementEngine.medir(.distancia, puntos: puntos, marco: .arkit,
                                                      rumboGrados: 0, etiqueta: nil),
                              "La segunda medición debe crearse")
        XCTAssertNotEqual(a.id, b.id, "Cada medición debe llevar su propio UUID")
        XCTAssertEqual(a.value, b.value, accuracy: 1e-9,
                       "Dos mediciones con los mismos puntos deben dar el mismo valor")
    }

    func testMedicionCreadaEsSerializable() throws {
        let puntos = [SIMD3<Float>(0, 0, 0), SIMD3<Float>(3, 4, 0)]
        let registro = try XCTUnwrap(
            MeasurementEngine.medir(.distancia, puntos: puntos, marco: .arkit,
                                    rumboGrados: 0, etiqueta: "Ancho"),
            "La medición debe crearse")
        let datos = try ScanMetadata.jsonEncoder().encode(registro)
        let vuelta = try ScanMetadata.jsonDecoder().decode(MeasurementRecord.self, from: datos)
        XCTAssertEqual(vuelta, registro,
                       "Una medición recién creada debe sobrevivir la ida y vuelta JSON")
    }
}
