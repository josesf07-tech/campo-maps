//
//  ExportFormatTests.swift
//  JoseScanTests
//
//  Pruebas de los escritores de formato (PLY, OBJ, STL, GeoJSON, CSV) contra
//  el contrato de docs/FORMATO-ESCANEO.md. Se verifican cabeceras exactas,
//  tamaños de cuerpo binario y contenidos concretos, no sólo "no está vacío".
//

import XCTest
import Foundation
import simd
@testable import JoseScan

final class ExportFormatTests: XCTestCase {

    // =====================================================================
    // MARK: - PLY binario
    // =====================================================================

    func testCabeceraDelPLYBinarioSigueElContrato() throws {
        let nube = Fixtures.nubePlana(marco: .enu)
        let datos = PLYWriter.datos(de: nube, binario: true, marco: .enu)
        let partes = try XCTUnwrap(Fixtures.partirPLY(datos),
                                   "El PLY debe contener la marca end_header")

        let esperada = [
            "ply",
            "format binary_little_endian 1.0",
            "comment JoseScan josescan/1.0",
            "comment marco enu",
            "element vertex 1000",
            "property float x",
            "property float y",
            "property float z",
            "property uchar red",
            "property uchar green",
            "property uchar blue",
            "property uchar confidence"
        ]
        XCTAssertEqual(partes.cabecera, esperada,
                       "La cabecera del PLY binario debe ser exactamente la del contrato")
    }

    func testCuerpoDelPLYBinarioMideDieciseisBytesPorPunto() throws {
        let nube = Fixtures.nubePlana(marco: .enu)
        let datos = PLYWriter.datos(de: nube, binario: true, marco: .enu)
        let partes = try XCTUnwrap(Fixtures.partirPLY(datos),
                                   "El PLY debe contener la marca end_header")
        XCTAssertEqual(partes.cuerpo.count, 16 * 1000,
                       "3 float (12 B) + 4 uchar (4 B) = 16 B por punto × 1000 puntos = 16 000 B")
    }

    func testValoresBinariosDelPLYCoincidenConLaNube() throws {
        let nube = Fixtures.nubePlana(marco: .enu)
        let datos = PLYWriter.datos(de: nube, binario: true, marco: .enu)
        let partes = try XCTUnwrap(Fixtures.partirPLY(datos),
                                   "El PLY debe contener la marca end_header")
        let cuerpo = partes.cuerpo

        // Punto 41 (fila 1, columna 1): (0.1, 0, −0.1), color (6, 10, 2), confianza 2.
        let base = 41 * 16
        XCTAssertEqual(Fixtures.floatLE(cuerpo, base + 0), 0.1, accuracy: 1e-6,
                       "La X del punto 41 debe ser 0.1 m")
        XCTAssertEqual(Fixtures.floatLE(cuerpo, base + 4), 0.0, accuracy: 1e-6,
                       "La Y del punto 41 debe ser 0 m")
        XCTAssertEqual(Fixtures.floatLE(cuerpo, base + 8), -0.1, accuracy: 1e-6,
                       "La Z del punto 41 debe ser −0.1 m")
        XCTAssertEqual(cuerpo[base + 12], 6, "El rojo del punto 41 debe ser 6")
        XCTAssertEqual(cuerpo[base + 13], 10, "El verde del punto 41 debe ser 10")
        XCTAssertEqual(cuerpo[base + 14], 2, "El azul del punto 41 debe ser 2")
        XCTAssertEqual(cuerpo[base + 15], 2, "La confianza del punto 41 debe ser 2 (alta)")

        // Primer punto: origen, color negro, confianza 0.
        XCTAssertEqual(Fixtures.floatLE(cuerpo, 0), 0.0, accuracy: 1e-6,
                       "La X del primer punto debe ser 0 m")
        XCTAssertEqual(cuerpo[15], 0, "La confianza del primer punto debe ser 0 (baja)")
    }

    func testElPLYDeclaraElMarcoARKitCuandoCorresponde() throws {
        let nube = Fixtures.nubePlana(marco: .arkit)
        let datos = PLYWriter.datos(de: nube, binario: true, marco: .arkit)
        let partes = try XCTUnwrap(Fixtures.partirPLY(datos),
                                   "El PLY debe contener la marca end_header")
        XCTAssertTrue(partes.cabecera.contains("comment marco arkit"),
                      "El PLY de una nube sin georreferenciar debe declarar 'comment marco arkit'")
        XCTAssertFalse(partes.cabecera.contains("comment marco enu"),
                       "No debe declararse el marco ENU en una nube ARKit")
    }

    func testElPLYBinarioEmpiezaPorLaPalabraPly() {
        let datos = PLYWriter.datos(de: Fixtures.nubeMinima(), binario: true, marco: .arkit)
        let b = Fixtures.bytes(datos)
        XCTAssertGreaterThan(b.count, 4, "El PLY no puede estar vacío")
        XCTAssertEqual(Array(b[0..<4]), Fixtures.ascii("ply\n"),
                       "Todo PLY debe empezar por la línea mágica 'ply'")
    }

    func testPLYDeNubeVaciaDeclaraCeroVertices() throws {
        let datos = PLYWriter.datos(de: PointCloud(), binario: true, marco: .arkit)
        let partes = try XCTUnwrap(Fixtures.partirPLY(datos),
                                   "Incluso vacío, el PLY debe traer cabecera")
        XCTAssertTrue(partes.cabecera.contains("element vertex 0"),
                      "Una nube vacía debe declarar 'element vertex 0'")
        XCTAssertEqual(partes.cuerpo.count, 0,
                       "Una nube vacía no debe escribir cuerpo binario")
    }

    // =====================================================================
    // MARK: - PLY ASCII
    // =====================================================================

    func testCabeceraDelPLYAsciiDeclaraFormatoAscii() throws {
        let nube = Fixtures.nubePlana(marco: .enu)
        let datos = PLYWriter.datos(de: nube, binario: false, marco: .enu)
        let partes = try XCTUnwrap(Fixtures.partirPLY(datos),
                                   "El PLY ascii debe contener la marca end_header")
        let esperada = [
            "ply",
            "format ascii 1.0",
            "comment JoseScan josescan/1.0",
            "comment marco enu",
            "element vertex 1000",
            "property float x",
            "property float y",
            "property float z",
            "property uchar red",
            "property uchar green",
            "property uchar blue",
            "property uchar confidence"
        ]
        XCTAssertEqual(partes.cabecera, esperada,
                       "La cabecera del PLY ascii sólo cambia la línea 'format'")
    }

    func testElPLYAsciiTieneUnaLineaDeDatosPorPunto() throws {
        let nube = Fixtures.nubePlana(marco: .enu)
        let datos = PLYWriter.datos(de: nube, binario: false, marco: .enu)
        let partes = try XCTUnwrap(Fixtures.partirPLY(datos),
                                   "El PLY ascii debe contener la marca end_header")
        let cuerpo = String(decoding: partes.cuerpo, as: UTF8.self)
        let filas = Fixtures.lineas(cuerpo)
        XCTAssertEqual(filas.count, 1000,
                       "El PLY ascii debe traer exactamente 1000 líneas de datos")

        let campos = filas[41].split(separator: " ").map { String($0) }
        XCTAssertEqual(campos.count, 7,
                       "Cada línea del PLY ascii debe traer x y z r g b confianza (7 campos)")
        XCTAssertEqual(Double(campos[0]) ?? .nan, 0.1, accuracy: 1e-4,
                       "La X de la línea 41 debe ser 0.1 m")
        XCTAssertEqual(Double(campos[2]) ?? .nan, -0.1, accuracy: 1e-4,
                       "La Z de la línea 41 debe ser −0.1 m")
        XCTAssertEqual(campos[3], "6", "El rojo de la línea 41 debe escribirse como entero 6")
        XCTAssertEqual(campos[6], "2", "La confianza de la línea 41 debe escribirse como entero 2")
    }

    // =====================================================================
    // MARK: - OBJ
    // =====================================================================

    func testElOBJDelCuboTieneOchoVerticesYDoceCaras() {
        let texto = OBJWriter.texto(de: Fixtures.cubo())
        XCTAssertEqual(Fixtures.lineas(conPrefijo: "v ", en: texto).count, 8,
                       "El cubo debe escribirse con 8 líneas 'v '")
        XCTAssertEqual(Fixtures.lineas(conPrefijo: "f ", en: texto).count, 12,
                       "El cubo debe escribirse con 12 líneas 'f '")
        XCTAssertEqual(Fixtures.lineas(conPrefijo: "vn ", en: texto).count, 8,
                       "El cubo trae una normal por vértice: 8 líneas 'vn '")
    }

    func testLasCarasDelOBJUsanLaFormaVerticeBarraBarraNormal() {
        let texto = OBJWriter.texto(de: Fixtures.cubo())
        let caras = Fixtures.lineas(conPrefijo: "f ", en: texto)
        XCTAssertFalse(caras.isEmpty, "Debe haber caras en el OBJ del cubo")
        for cara in caras {
            XCTAssertTrue(cara.contains("//"),
                          "Cada cara debe usar la forma 'v//vn' según el contrato: \(cara)")
            let tokens = cara.split(separator: " ").dropFirst()
            XCTAssertEqual(tokens.count, 3,
                           "Cada cara debe ser un triángulo (3 referencias): \(cara)")
            for token in tokens {
                let partes = token.split(separator: "/", omittingEmptySubsequences: true)
                let indice = Int(partes.first ?? "") ?? 0
                XCTAssertTrue(indice >= 1 && indice <= 8,
                              "Los índices OBJ son de base 1 y el cubo sólo tiene 8 vértices: \(cara)")
            }
        }
    }

    func testElOBJAgrupaLasCarasPorClasificacionSemantica() {
        let texto = OBJWriter.texto(de: Fixtures.cubo())
        XCTAssertTrue(texto.contains("g piso"),
                      "Las 2 caras clasificadas como piso deben agruparse con 'g piso'")
        XCTAssertTrue(texto.contains("g techo"),
                      "Las 2 caras clasificadas como techo deben agruparse con 'g techo'")
        XCTAssertTrue(texto.contains("g muro"),
                      "Las 8 caras clasificadas como muro deben agruparse con 'g muro'")
    }

    func testElOBJDeUnaMallaVaciaNoTieneGeometria() {
        let texto = OBJWriter.texto(de: ScanMesh())
        XCTAssertEqual(Fixtures.lineas(conPrefijo: "v ", en: texto).count, 0,
                       "Una malla vacía no debe producir vértices")
        XCTAssertEqual(Fixtures.lineas(conPrefijo: "f ", en: texto).count, 0,
                       "Una malla vacía no debe producir caras")
    }

    func testElMaterialMTLDeclaraUnMaterial() {
        let mtl = OBJWriter.materialMTL()
        XCTAssertTrue(mtl.contains("newmtl"),
                      "El .mtl debe declarar al menos un material con 'newmtl'")
        XCTAssertFalse(mtl.isEmpty, "El material no puede estar vacío")
    }

    // =====================================================================
    // MARK: - STL
    // =====================================================================

    func testElSTLBinarioMideOchentaYCuatroMasCincuentaPorTriangulo() {
        let datos = STLWriter.datos(de: Fixtures.cubo(), binario: true)
        XCTAssertEqual(datos.count, 84 + 50 * 12,
                       "STL binario = 80 B de cabecera + 4 B de contador + 50 B × 12 triángulos = 684 B")
    }

    func testElContadorDelSTLBinarioDeclaraDoceTriangulos() {
        let datos = STLWriter.datos(de: Fixtures.cubo(), binario: true)
        let b = Fixtures.bytes(datos)
        XCTAssertGreaterThanOrEqual(b.count, 84, "El STL binario debe traer al menos 84 B")
        XCTAssertEqual(Fixtures.uint32LE(b, 80), 12,
                       "El contador de triángulos (offset 80, UInt32 LE) debe valer 12")
    }

    func testLosVerticesDelSTLBinarioCaenEnElCuboUnitario() {
        let datos = STLWriter.datos(de: Fixtures.cubo(), binario: true)
        let b = Fixtures.bytes(datos)
        for triangulo in 0..<12 {
            let base = 84 + triangulo * 50
            for vertice in 0..<3 {
                for componente in 0..<3 {
                    let valor = Fixtures.floatLE(b, base + 12 + vertice * 12 + componente * 4)
                    XCTAssertTrue(valor > -1e-5 && valor < 1 + 1e-5,
                                  "Toda coordenada del cubo unitario debe caer en [0, 1] " +
                                  "(triángulo \(triangulo), vértice \(vertice)): \(valor)")
                }
            }
        }
    }

    func testElSTLBinarioDeUnaMallaVaciaSoloTraeLaCabecera() {
        let datos = STLWriter.datos(de: ScanMesh(), binario: true)
        XCTAssertEqual(datos.count, 84,
                       "Una malla vacía produce sólo los 84 B de cabecera y contador")
        XCTAssertEqual(Fixtures.uint32LE(Fixtures.bytes(datos), 80), 0,
                       "El contador de triángulos de una malla vacía debe ser 0")
    }

    func testElSTLAsciiTieneDoceCarasYTreintaYSeisVertices() {
        let datos = STLWriter.datos(de: Fixtures.cubo(), binario: false)
        let texto = String(decoding: datos, as: UTF8.self)
        XCTAssertTrue(texto.hasPrefix("solid"),
                      "El STL ascii debe empezar por 'solid'")
        XCTAssertTrue(texto.contains("endsolid"),
                      "El STL ascii debe cerrar con 'endsolid'")
        XCTAssertEqual(Fixtures.ocurrencias(de: "facet normal", en: texto), 12,
                       "El cubo tiene 12 caras: 12 bloques 'facet normal'")
        XCTAssertEqual(Fixtures.ocurrencias(de: "vertex ", en: texto), 36,
                       "12 triángulos × 3 vértices = 36 líneas 'vertex'")
        XCTAssertEqual(Fixtures.ocurrencias(de: "endfacet", en: texto), 12,
                       "Cada 'facet' debe cerrarse con su 'endfacet'")
    }

    // =====================================================================
    // MARK: - GeoJSON
    // =====================================================================

    /// Metadatos ya georreferenciados (marco ENU y ancla con Norte/Este).
    private func metadatosGeorreferenciados() -> ScanMetadata {
        var meta = Fixtures.metadatos()
        meta.marco = .enu
        meta.geo?.norte = 2_067_459.132
        meta.geo?.este = 4_880_056.016
        return meta
    }

    func testElGeoJSONEsUnFeatureCollectionConDosFeatures() throws {
        let datos = try GeoJSONWriter.featureCollection(de: metadatosGeorreferenciados())
        let raiz = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: datos) as? [String: Any],
            "El GeoJSON debe ser un objeto JSON")

        XCTAssertEqual(raiz["type"] as? String, "FeatureCollection",
                       "La raíz del GeoJSON debe declarar type = FeatureCollection")
        let features = try XCTUnwrap(raiz["features"] as? [[String: Any]],
                                     "La raíz debe traer el arreglo 'features'")
        XCTAssertEqual(features.count, 2,
                       "El contrato exige 2 features: el punto de origen y el polígono de la huella")
        for (i, feature) in features.enumerated() {
            XCTAssertEqual(feature["type"] as? String, "Feature",
                           "El elemento \(i) del arreglo debe ser un Feature")
        }
    }

    func testElPrimerFeatureEsElPuntoDeOrigenEnWGS84() throws {
        let datos = try GeoJSONWriter.featureCollection(de: metadatosGeorreferenciados())
        let raiz = try XCTUnwrap(try JSONSerialization.jsonObject(with: datos) as? [String: Any],
                                 "El GeoJSON debe ser un objeto JSON")
        let features = try XCTUnwrap(raiz["features"] as? [[String: Any]],
                                     "La raíz debe traer el arreglo 'features'")
        let punto = features[0]
        let geometria = try XCTUnwrap(punto["geometry"] as? [String: Any],
                                      "El primer feature debe traer geometría")
        XCTAssertEqual(geometria["type"] as? String, "Point",
                       "El primer feature debe ser un Point en el origen del escaneo")

        let coordenadas = try XCTUnwrap(geometria["coordinates"] as? [Double],
                                        "Un Point debe traer [lon, lat]")
        XCTAssertEqual(coordenadas.count, 2,
                       "GeoJSON usa el orden [longitud, latitud]")
        XCTAssertEqual(coordenadas[0], Fixtures.lonBogota, accuracy: 1e-6,
                       "La longitud del origen debe ser −74.08175")
        XCTAssertEqual(coordenadas[1], Fixtures.latBogota, accuracy: 1e-6,
                       "La latitud del origen debe ser 4.60971")

        let propiedades = try XCTUnwrap(punto["properties"] as? [String: Any],
                                        "El primer feature debe traer propiedades")
        XCTAssertEqual(propiedades["nombre"] as? String, "Cárcava K12+400",
                       "La propiedad 'nombre' debe traer el nombre del escaneo")
        XCTAssertEqual(propiedades["puntos"] as? Int, 1000,
                       "La propiedad 'puntos' debe traer los 1000 puntos capturados")
        XCTAssertEqual(propiedades["triangulos"] as? Int, 12,
                       "La propiedad 'triangulos' debe traer los 12 triángulos")
        XCTAssertEqual((propiedades["norte"] as? Double) ?? .nan, 2_067_459.132, accuracy: 0.01,
                       "La propiedad 'norte' debe traer el Norte MAGNA-SIRGAS del origen")
        XCTAssertEqual((propiedades["este"] as? Double) ?? .nan, 4_880_056.016, accuracy: 0.01,
                       "La propiedad 'este' debe traer el Este MAGNA-SIRGAS del origen")
        XCTAssertNotNil(propiedades["id"],
                        "La propiedad 'id' debe estar presente según el contrato")
    }

    func testElSegundoFeatureEsElPoligonoDeLaHuella() throws {
        let datos = try GeoJSONWriter.featureCollection(de: metadatosGeorreferenciados())
        let raiz = try XCTUnwrap(try JSONSerialization.jsonObject(with: datos) as? [String: Any],
                                 "El GeoJSON debe ser un objeto JSON")
        let features = try XCTUnwrap(raiz["features"] as? [[String: Any]],
                                     "La raíz debe traer el arreglo 'features'")
        let geometria = try XCTUnwrap(features[1]["geometry"] as? [String: Any],
                                      "El segundo feature debe traer geometría")
        XCTAssertEqual(geometria["type"] as? String, "Polygon",
                       "El segundo feature debe ser el Polygon de la caja envolvente")

        let anillos = try XCTUnwrap(geometria["coordinates"] as? [[[Double]]],
                                    "Un Polygon debe traer un arreglo de anillos")
        XCTAssertEqual(anillos.count, 1, "La huella es un polígono simple: un solo anillo")
        let anillo = anillos[0]
        XCTAssertGreaterThanOrEqual(anillo.count, 4,
                                    "Un anillo cerrado necesita al menos 4 posiciones")
        XCTAssertEqual(anillo.first ?? [], anillo.last ?? [],
                       "El anillo debe estar cerrado: la primera posición se repite al final")

        for (i, posicion) in anillo.enumerated() {
            XCTAssertEqual(posicion.count, 2,
                           "Cada posición del anillo debe ser [lon, lat] (posición \(i))")
            XCTAssertEqual(posicion[0], Fixtures.lonBogota, accuracy: 0.01,
                           "La huella de un escaneo de decenas de metros no puede alejarse " +
                           "más de 0.01° del origen (posición \(i))")
            XCTAssertEqual(posicion[1], Fixtures.latBogota, accuracy: 0.01,
                           "La huella de un escaneo de decenas de metros no puede alejarse " +
                           "más de 0.01° del origen (posición \(i))")
        }
    }

    func testElGeoJSONSinAnclaLanzaSinGeorreferencia() {
        let meta = Fixtures.metadatos(conAncla: false)
        XCTAssertThrowsError(try GeoJSONWriter.featureCollection(de: meta),
                             "Sin ancla GPS no puede escribirse la huella GeoJSON") { error in
            XCTAssertEqual(error as? ScanError, ScanError.sinGeorreferencia,
                           "El error debe ser ScanError.sinGeorreferencia y llegó: \(error)")
        }
    }

    // =====================================================================
    // MARK: - CSV
    // =====================================================================

    func testElCSVDePuntosRespetaElLimiteDeFilas() {
        let nube = Fixtures.nubePlana()
        let conDiez = Fixtures.lineas(CSVWriter.puntos(nube, limite: 10)).count
        let conMil = Fixtures.lineas(CSVWriter.puntos(nube, limite: 5000)).count

        XCTAssertEqual(conMil - conDiez, 990,
                       "Pasar de un límite de 10 a uno mayor que la nube debe añadir 990 filas")
        XCTAssertEqual(conDiez, 11,
                       "Con límite 10 el CSV debe traer 1 cabecera + 10 filas de datos")
        XCTAssertEqual(conMil, 1001,
                       "Con límite mayor que la nube el CSV debe traer 1 cabecera + 1000 filas")
    }

    func testLaCabeceraDelCSVDePuntosNombraLosEjes() {
        let texto = CSVWriter.puntos(Fixtures.nubeMinima(), limite: 10)
        let filas = Fixtures.lineas(texto)
        XCTAssertGreaterThanOrEqual(filas.count, 1, "El CSV debe traer al menos la cabecera")
        let cabecera = filas[0].lowercased()
        XCTAssertTrue(cabecera.contains("x"), "La cabecera del CSV debe nombrar la columna x: \(filas[0])")
        XCTAssertTrue(cabecera.contains("y"), "La cabecera del CSV debe nombrar la columna y: \(filas[0])")
        XCTAssertTrue(cabecera.contains("z"), "La cabecera del CSV debe nombrar la columna z: \(filas[0])")
        XCTAssertEqual(filas.count, 4,
                       "Con 3 puntos y límite 10 deben salir 1 cabecera + 3 filas")
    }

    func testElCSVDePuntosNoEscribeFilasSiLaNubeEstaVacia() {
        let filas = Fixtures.lineas(CSVWriter.puntos(PointCloud(), limite: 100))
        XCTAssertLessThanOrEqual(filas.count, 1,
                                 "Una nube vacía sólo puede producir la línea de cabecera")
    }

    func testElCSVDeMedicionesEscribeUnaFilaPorMedicion() {
        let texto = CSVWriter.mediciones(Fixtures.mediciones())
        let filas = Fixtures.lineas(texto)
        XCTAssertEqual(filas.count, 3,
                       "2 mediciones deben dar 1 cabecera + 2 filas de datos")
        XCTAssertTrue(texto.contains("3.42"),
                      "El valor 3.42 m de la primera medición debe aparecer en el CSV")
        XCTAssertTrue(texto.contains("Ancho"),
                      "La etiqueta 'Ancho' debe aparecer en el CSV")
        XCTAssertTrue(texto.contains("distancia"),
                      "El tipo 'distancia' debe aparecer en el CSV")
    }

    func testElCSVDeMedicionesEscapaLasComillasDobles() {
        let texto = CSVWriter.mediciones(Fixtures.mediciones())
        // Etiqueta original: Zona "crítica", borde  →  "Zona ""crítica"", borde"
        XCTAssertTrue(texto.contains("\"\"crítica\"\""),
                      "Las comillas dobles deben duplicarse según RFC 4180: \(texto)")
        XCTAssertTrue(texto.contains("\"Zona \"\"crítica\"\", borde\""),
                      "El campo con comillas y coma debe ir entrecomillado completo: \(texto)")
        XCTAssertEqual(Fixtures.lineas(texto).count, 3,
                       "La coma dentro del campo entrecomillado no debe romper la fila")
    }

    func testElCSVDeMedicionesVaciasSoloTraeCabecera() {
        let filas = Fixtures.lineas(CSVWriter.mediciones([]))
        XCTAssertLessThanOrEqual(filas.count, 1,
                                 "Sin mediciones el CSV sólo puede traer la cabecera")
    }

    // =====================================================================
    // MARK: - Nombres de archivo seguros
    // =====================================================================

    func testUnNombreYaSeguroNoSeModifica() {
        XCTAssertEqual(ScanExporter.nombreSeguro("Escaneo01"), "Escaneo01",
                       "Un nombre alfanumérico simple debe pasar sin cambios")
    }

    func testElNombreSeguroEliminaSeparadoresDeRuta() {
        let peligrosos = ["Cárcava K12+400 / v2",
                          "../../etc/passwd",
                          "nube:final",
                          "malla\\vieja",
                          "a\u{0000}b"]
        for entrada in peligrosos {
            let salida = ScanExporter.nombreSeguro(entrada)
            XCTAssertFalse(salida.contains("/"),
                           "El nombre seguro no puede contener '/': \(entrada) → \(salida)")
            XCTAssertFalse(salida.contains("\\"),
                           "El nombre seguro no puede contener '\\': \(entrada) → \(salida)")
            XCTAssertFalse(salida.contains(":"),
                           "El nombre seguro no puede contener ':': \(entrada) → \(salida)")
            XCTAssertFalse(salida.contains("\u{0000}"),
                           "El nombre seguro no puede contener el byte nulo: \(entrada) → \(salida)")
            XCTAssertFalse(salida.isEmpty,
                           "El nombre seguro nunca puede quedar vacío: \(entrada)")
        }
    }

    func testElNombreSeguroEsEstable() {
        let entrada = "Cárcava K12+400"
        XCTAssertEqual(ScanExporter.nombreSeguro(entrada),
                       ScanExporter.nombreSeguro(ScanExporter.nombreSeguro(entrada)),
                       "Aplicar dos veces el saneamiento debe dar el mismo resultado")
    }
}
