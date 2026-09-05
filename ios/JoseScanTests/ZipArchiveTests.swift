//
//  ZipArchiveTests.swift
//  JoseScanTests
//
//  Pruebas del empaquetador ZIP usado para el paquete `.josescan`.
//  Se valida la estructura binaria real (PKZIP, APPNOTE 6.3.x):
//
//    Cabecera local            PK\x03\x04   offsets: 6 banderas, 14 CRC-32,
//                                           18 tam. comprimido, 22 tam. real,
//                                           26 long. nombre, 30 nombre
//    Directorio central        PK\x01\x02   offset 16 CRC-32
//    Fin del directorio (EOCD) PK\x05\x06   offsets: 10 nº de entradas,
//                                           12 tam. directorio, 16 offset,
//                                           20 long. comentario
//
//  El CRC-32 esperado se calcula en la propia suite (Fixtures.crc32), con una
//  implementación independiente de la del código de producción.
//

import XCTest
import Foundation
@testable import JoseScan

final class ZipArchiveTests: XCTestCase {

    private let firmaLocal: [UInt8] = [0x50, 0x4B, 0x03, 0x04]   // "PK\u{03}\u{04}"
    private let firmaCentral: [UInt8] = [0x50, 0x4B, 0x01, 0x02] // "PK\u{01}\u{02}"
    private let firmaEOCD: [UInt8] = [0x50, 0x4B, 0x05, 0x06]    // "PK\u{05}\u{06}"

    private let contenidoJSON = Data("{\"formato\":\"josescan/1.0\"}".utf8)
    private let contenidoPLY = Data("ply\nformat ascii 1.0\nend_header\n".utf8)

    private func entradasDeReferencia() -> [(nombre: String, datos: Data)] {
        [(nombre: "escaneo.json", datos: contenidoJSON),
         (nombre: "nube.ply", datos: contenidoPLY)]
    }

    // =====================================================================
    // MARK: - CRC-32 de referencia (auto-verificación de la suite)
    // =====================================================================

    func testElCRC32DeReferenciaDeLaSuiteEsCorrecto() {
        // Valores canónicos del CRC-32 IEEE (polinomio reflejado 0xEDB88320).
        XCTAssertEqual(Fixtures.crc32("hola"), 0x6FA0_F988,
                       "El CRC-32 de \"hola\" debe ser 0x6FA0F988")
        XCTAssertEqual(Fixtures.crc32(""), 0x0000_0000,
                       "El CRC-32 de la cadena vacía debe ser 0x00000000")
        XCTAssertEqual(Fixtures.crc32("JoseScan"), 0x3920_799E,
                       "El CRC-32 de \"JoseScan\" debe ser 0x3920799E")
        XCTAssertEqual(Fixtures.crc32("escaneo.json"), 0x0CD3_C469,
                       "El CRC-32 de \"escaneo.json\" debe ser 0x0CD3C469")
    }

    // =====================================================================
    // MARK: - Firmas y estructura general
    // =====================================================================

    func testElZipEmpiezaPorLaFirmaDeCabeceraLocal() throws {
        let datos = try ZipArchive.crear(entradas: entradasDeReferencia())
        let b = Fixtures.bytes(datos)
        guard b.count > 22 else {
            XCTFail("Un ZIP con entradas no puede medir menos de 22 B y midió \(b.count) B")
            return
        }
        XCTAssertEqual(Array(b[0..<4]), firmaLocal,
                       "Todo ZIP debe empezar por la firma PK\\u{03}\\u{04} de cabecera local")
    }

    func testElZipTerminaConLaFirmaEOCD() throws {
        let datos = try ZipArchive.crear(entradas: entradasDeReferencia())
        let b = Fixtures.bytes(datos)
        let eocd = try XCTUnwrap(Fixtures.ultimoIndice(de: firmaEOCD, en: b),
                                 "El ZIP debe traer el registro EOCD (PK\\u{05}\\u{06})")
        XCTAssertEqual(Fixtures.uint16LE(b, eocd + 20), 0,
                       "El EOCD no debe llevar comentario de archivo")
        XCTAssertEqual(eocd, b.count - 22,
                       "Sin comentario, el EOCD ocupa exactamente los últimos 22 B del ZIP")
    }

    func testElEOCDDeclaraElNumeroDeEntradas() throws {
        let datos = try ZipArchive.crear(entradas: entradasDeReferencia())
        let b = Fixtures.bytes(datos)
        let eocd = try XCTUnwrap(Fixtures.ultimoIndice(de: firmaEOCD, en: b),
                                 "El ZIP debe traer el registro EOCD")
        XCTAssertEqual(Fixtures.uint16LE(b, eocd + 8), 2,
                       "El EOCD debe declarar 2 entradas en este disco")
        XCTAssertEqual(Fixtures.uint16LE(b, eocd + 10), 2,
                       "El EOCD debe declarar 2 entradas en total")
        XCTAssertEqual(Fixtures.uint16LE(b, eocd + 4), 0,
                       "El ZIP no está dividido en volúmenes: número de disco 0")
        XCTAssertEqual(Fixtures.uint16LE(b, eocd + 6), 0,
                       "El directorio central vive en el disco 0")
    }

    func testElEOCDApuntaAlDirectorioCentral() throws {
        let datos = try ZipArchive.crear(entradas: entradasDeReferencia())
        let b = Fixtures.bytes(datos)
        let eocd = try XCTUnwrap(Fixtures.ultimoIndice(de: firmaEOCD, en: b),
                                 "El ZIP debe traer el registro EOCD")
        let tamanoDirectorio = Int(Fixtures.uint32LE(b, eocd + 12))
        let offsetDirectorio = Int(Fixtures.uint32LE(b, eocd + 16))

        guard offsetDirectorio > 0, offsetDirectorio + 4 <= eocd else {
            XCTFail("El offset del directorio central (\(offsetDirectorio)) debe caer dentro del ZIP")
            return
        }
        XCTAssertEqual(offsetDirectorio + tamanoDirectorio, eocd,
                       "El directorio central debe terminar justo donde empieza el EOCD")
        XCTAssertEqual(Array(b[offsetDirectorio..<(offsetDirectorio + 4)]), firmaCentral,
                       "En el offset declarado debe estar la firma PK\\u{01}\\u{02}")

        let region = Array(b[offsetDirectorio..<eocd])
        XCTAssertEqual(Fixtures.ocurrencias(de: firmaCentral, en: region), 2,
                       "El directorio central debe traer una cabecera por cada una de las 2 entradas")
    }

    func testElZipDeDiezEntradasDeclaraDiezEnElEOCD() throws {
        var entradas: [(nombre: String, datos: Data)] = []
        for i in 0..<10 {
            entradas.append((nombre: "archivo\(i).txt", datos: Data("contenido \(i)".utf8)))
        }
        let datos = try ZipArchive.crear(entradas: entradas)
        let b = Fixtures.bytes(datos)
        let eocd = try XCTUnwrap(Fixtures.ultimoIndice(de: firmaEOCD, en: b),
                                 "El ZIP debe traer el registro EOCD")
        XCTAssertEqual(Fixtures.uint16LE(b, eocd + 10), 10,
                       "El EOCD debe declarar las 10 entradas creadas")
    }

    // =====================================================================
    // MARK: - CRC-32 de las entradas
    // =====================================================================

    func testElCRCDeLaCabeceraLocalCoincideConElCRCDeReferencia() throws {
        let datos = try ZipArchive.crear(entradas: [(nombre: "hola.txt", datos: Data("hola".utf8))])
        let b = Fixtures.bytes(datos)
        XCTAssertEqual(Array(b[0..<4]), firmaLocal,
                       "El ZIP debe empezar por la cabecera local de la única entrada")
        XCTAssertEqual(Fixtures.uint32LE(b, 14), 0x6FA0_F988,
                       "El CRC-32 de \"hola\" almacenado en la cabecera local debe ser 0x6FA0F988")
    }

    func testElCRCDelDirectorioCentralCoincideConElDeLaCabeceraLocal() throws {
        let datos = try ZipArchive.crear(entradas: [(nombre: "hola.txt", datos: Data("hola".utf8))])
        let b = Fixtures.bytes(datos)
        let eocd = try XCTUnwrap(Fixtures.ultimoIndice(de: firmaEOCD, en: b),
                                 "El ZIP debe traer el registro EOCD")
        let offsetDirectorio = Int(Fixtures.uint32LE(b, eocd + 16))
        guard offsetDirectorio >= 0, offsetDirectorio + 20 <= b.count else {
            XCTFail("El offset del directorio central (\(offsetDirectorio)) debe caer dentro del ZIP")
            return
        }
        XCTAssertEqual(Fixtures.uint32LE(b, offsetDirectorio + 16), 0x6FA0_F988,
                       "El directorio central debe repetir el CRC-32 0x6FA0F988 de \"hola\"")
        XCTAssertEqual(Fixtures.uint32LE(b, offsetDirectorio + 16),
                       Fixtures.uint32LE(b, 14),
                       "El CRC del directorio central y el de la cabecera local deben coincidir")
    }

    func testElCRCDeCadaEntradaCoincideConElCalculadoEnLaSuite() throws {
        let entradas = entradasDeReferencia()
        let datos = try ZipArchive.crear(entradas: entradas)
        let b = Fixtures.bytes(datos)
        // La primera entrada arranca siempre en el offset 0.
        XCTAssertEqual(Fixtures.uint32LE(b, 14), Fixtures.crc32(entradas[0].datos),
                       "El CRC-32 de escaneo.json debe coincidir con el calculado por la suite")

        // La segunda se localiza por su cabecera central.
        let eocd = try XCTUnwrap(Fixtures.ultimoIndice(de: firmaEOCD, en: b),
                                 "El ZIP debe traer el registro EOCD")
        let offsetDirectorio = Int(Fixtures.uint32LE(b, eocd + 16))
        let segunda = try XCTUnwrap(
            Fixtures.indice(de: firmaCentral, en: b, desde: offsetDirectorio + 4),
            "El directorio central debe traer la cabecera de la segunda entrada")
        guard segunda + 20 <= b.count else {
            XCTFail("La segunda cabecera central (\(segunda)) se sale del archivo")
            return
        }
        XCTAssertEqual(Fixtures.uint32LE(b, segunda + 16), Fixtures.crc32(entradas[1].datos),
                       "El CRC-32 de nube.ply debe coincidir con el calculado por la suite")
    }

    // =====================================================================
    // MARK: - Nombres y tamaños
    // =====================================================================

    func testLaCabeceraLocalGuardaElNombreYLosTamanos() throws {
        let entradas = entradasDeReferencia()
        let datos = try ZipArchive.crear(entradas: entradas)
        let b = Fixtures.bytes(datos)

        let longitudNombre = Int(Fixtures.uint16LE(b, 26))
        let longitudExtra = Int(Fixtures.uint16LE(b, 28))
        guard 30 + longitudNombre <= b.count else {
            XCTFail("La longitud de nombre declarada (\(longitudNombre)) se sale del archivo")
            return
        }
        XCTAssertEqual(longitudNombre, "escaneo.json".utf8.count,
                       "La cabecera local debe declarar los 12 caracteres de 'escaneo.json'")
        XCTAssertGreaterThanOrEqual(longitudExtra, 0, "La longitud del campo extra no puede ser negativa")

        let nombre = String(decoding: b[30..<(30 + longitudNombre)], as: UTF8.self)
        XCTAssertEqual(nombre, "escaneo.json",
                       "La primera entrada del paquete .josescan debe llamarse escaneo.json")

        // El tamaño sin comprimir sólo va en la cabecera si NO se usa
        // descriptor de datos (bit 3 de las banderas generales).
        let banderas = Fixtures.uint16LE(b, 6)
        if (banderas & 0x0008) == 0 {
            XCTAssertEqual(Int(Fixtures.uint32LE(b, 22)), entradas[0].datos.count,
                           "La cabecera local debe declarar el tamaño real de escaneo.json")
        }
    }

    func testTodosLosNombresDeEntradaAparecenEnElArchivo() throws {
        let entradas = entradasDeReferencia()
        let datos = try ZipArchive.crear(entradas: entradas)
        let b = Fixtures.bytes(datos)
        for entrada in entradas {
            let patron = Fixtures.ascii(entrada.nombre)
            // Cada nombre aparece dos veces: cabecera local y directorio central.
            XCTAssertEqual(Fixtures.ocurrencias(de: patron, en: b), 2,
                           "El nombre '\(entrada.nombre)' debe aparecer en la cabecera local y en el directorio central")
        }
    }

    func testElNombreConAcentosSeGuardaEnUTF8() throws {
        let nombre = "Cárcava K12+400.json"
        let datos = try ZipArchive.crear(entradas: [(nombre: nombre, datos: Data("x".utf8))])
        let b = Fixtures.bytes(datos)
        let longitudNombre = Int(Fixtures.uint16LE(b, 26))
        guard 30 + longitudNombre <= b.count else {
            XCTFail("La longitud de nombre declarada (\(longitudNombre)) se sale del archivo")
            return
        }
        XCTAssertEqual(longitudNombre, nombre.utf8.count,
                       "La longitud declarada debe contarse en BYTES UTF-8 (\(nombre.utf8.count)), no en caracteres")
        let leido = String(decoding: b[30..<(30 + longitudNombre)], as: UTF8.self)
        XCTAssertEqual(leido, nombre,
                       "El nombre con tilde debe recuperarse tal cual desde el ZIP")
    }

    // =====================================================================
    // MARK: - Casos límite
    // =====================================================================

    func testUnaEntradaVaciaTieneCRCCero() throws {
        let datos = try ZipArchive.crear(entradas: [(nombre: "vacio.txt", datos: Data())])
        let b = Fixtures.bytes(datos)
        XCTAssertEqual(Fixtures.uint32LE(b, 14), 0,
                       "El CRC-32 de un archivo vacío debe ser 0x00000000")
        let eocd = try XCTUnwrap(Fixtures.ultimoIndice(de: firmaEOCD, en: b),
                                 "El ZIP debe traer el registro EOCD")
        XCTAssertEqual(Fixtures.uint16LE(b, eocd + 10), 1,
                       "Un ZIP con una sola entrada vacía sigue declarando 1 entrada")
    }

    func testUnZipSinEntradasSoloTraeElEOCD() {
        guard let datos = try? ZipArchive.crear(entradas: []) else {
            // Rechazar un paquete sin entradas también es un comportamiento válido.
            return
        }
        let b = Fixtures.bytes(datos)
        guard b.count == 22 else {
            XCTFail("Un ZIP sin entradas se reduce al registro EOCD de 22 B y llegaron \(b.count) B")
            return
        }
        XCTAssertEqual(Array(b[0..<4]), firmaEOCD,
                       "Un ZIP sin entradas empieza directamente por la firma EOCD")
        XCTAssertEqual(Fixtures.uint16LE(b, 10), 0,
                       "Un ZIP sin entradas debe declarar 0 entradas")
    }

    func testUnPaqueteJoseScanCompletoEsCoherente() throws {
        let doc = Fixtures.documento()
        let json = try ScanMetadata.jsonEncoder().encode(doc.metadata)
        let ply = PLYWriter.datos(de: doc.cloud, binario: true, marco: .arkit)
        let obj = Data(OBJWriter.texto(de: doc.mesh).utf8)
        let mtl = Data(OBJWriter.materialMTL().utf8)

        let entradas: [(nombre: String, datos: Data)] = [
            (nombre: "escaneo.json", datos: json),
            (nombre: "nube.ply", datos: ply),
            (nombre: "malla.obj", datos: obj),
            (nombre: "malla.mtl", datos: mtl)
        ]
        let paquete = try ZipArchive.crear(entradas: entradas)
        let b = Fixtures.bytes(paquete)

        XCTAssertEqual(Array(b[0..<4]), firmaLocal,
                       "El paquete .josescan debe empezar por una cabecera local")
        let eocd = try XCTUnwrap(Fixtures.ultimoIndice(de: firmaEOCD, en: b),
                                 "El paquete .josescan debe traer EOCD")
        XCTAssertEqual(Fixtures.uint16LE(b, eocd + 10), 4,
                       "El paquete debe declarar sus 4 entradas (json, ply, obj, mtl)")
        XCTAssertEqual(Fixtures.uint32LE(b, 14), Fixtures.crc32(json),
                       "El CRC de escaneo.json dentro del paquete debe cuadrar")
        XCTAssertGreaterThan(paquete.count, json.count,
                             "El paquete debe pesar más que su propio escaneo.json")
    }
}
