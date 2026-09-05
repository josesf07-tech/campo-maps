//
//  ZipArchive.swift
//  JoseScan
//
//  Escritor ZIP autocontenido (sin dependencias externas) usado para armar el
//  paquete `.josescan`. Sólo implementa el método de almacenamiento **store**
//  (compresión 0): el contenido se copia tal cual, de modo que el archivo
//  resultante es válido para `unzip`, para `JSZip` en el navegador y para el
//  Finder de macOS sin arrastrar ninguna librería de compresión.
//
//  Estructura generada (todos los enteros en little-endian):
//
//      [local file header + nombre + datos] × N
//      [central directory file header + nombre] × N
//      [end of central directory]
//
//  Referencia: APPNOTE.TXT 6.3.x (PKWARE).
//

import Foundation

public enum ZipArchive {

    // MARK: - Constantes del formato

    /// Firma del encabezado local de archivo.
    public static let firmaLocal: UInt32 = 0x0403_4b50
    /// Firma de la entrada del directorio central.
    public static let firmaCentral: UInt32 = 0x0201_4b50
    /// Firma del fin del directorio central (EOCD).
    public static let firmaFin: UInt32 = 0x0605_4b50

    /// Versión necesaria para extraer: 2.0 (soporta directorios y store/deflate).
    public static let version: UInt16 = 20
    /// Método de compresión 0 = store (sin comprimir).
    public static let metodoStore: UInt16 = 0

    /// Bandera "nombre de archivo en UTF-8" (bit 11). Sólo se activa cuando el
    /// nombre no es ASCII puro; para los nombres del paquete `.josescan`
    /// (`escaneo.json`, `nube.ply`, …) las banderas quedan en 0.
    public static let banderaUTF8: UInt16 = 0x0800

    /// Máximo de entradas representables en el EOCD clásico (sin ZIP64).
    public static let maximoEntradas = 0xFFFF
    /// Máximo tamaño representable en los campos de 32 bits (sin ZIP64).
    public static let maximoBytes = Int(UInt32.max)

    // MARK: - CRC-32

    /// Tabla precalculada del CRC-32 (IEEE 802.3, polinomio reflejado 0xEDB88320).
    private static let tablaCRC: [UInt32] = {
        var tabla = [UInt32](repeating: 0, count: 256)
        for i in 0..<256 {
            var c = UInt32(i)
            for _ in 0..<8 {
                if (c & 1) != 0 {
                    c = 0xEDB8_8320 ^ (c >> 1)
                } else {
                    c = c >> 1
                }
            }
            tabla[i] = c
        }
        return tabla
    }()

    /// CRC-32 estándar (init 0xFFFFFFFF, xor final 0xFFFFFFFF) de un bloque.
    public static func crc32(_ datos: Data) -> UInt32 {
        let tabla = tablaCRC
        var c: UInt32 = 0xFFFF_FFFF
        datos.withUnsafeBytes { (crudo: UnsafeRawBufferPointer) in
            for byte in crudo {
                let indice = Int((c ^ UInt32(byte)) & 0xFF)
                c = tabla[indice] ^ (c >> 8)
            }
        }
        return c ^ 0xFFFF_FFFF
    }

    // MARK: - Enteros little-endian

    /// Dos bytes little-endian.
    private static func le16(_ v: UInt16) -> Data {
        Data([UInt8(truncatingIfNeeded: v),
              UInt8(truncatingIfNeeded: v >> 8)])
    }

    /// Cuatro bytes little-endian.
    private static func le32(_ v: UInt32) -> Data {
        Data([UInt8(truncatingIfNeeded: v),
              UInt8(truncatingIfNeeded: v >> 8),
              UInt8(truncatingIfNeeded: v >> 16),
              UInt8(truncatingIfNeeded: v >> 24)])
    }

    // MARK: - Fecha MS-DOS

    /// Convierte una fecha al par (hora, día) empaquetado del formato MS-DOS.
    ///
    /// - hora: `(hh << 11) | (mm << 5) | (ss / 2)`
    /// - día:  `((año - 1980) << 9) | (mes << 5) | día`
    ///
    /// El rango representable es 1980…2107; valores fuera de rango se recortan.
    public static func fechaMSDOS(_ instante: Date,
                                  zonaHoraria: TimeZone = TimeZone.current) -> (hora: UInt16, dia: UInt16) {
        var calendario = Calendar(identifier: .gregorian)
        calendario.timeZone = zonaHoraria
        let c = calendario.dateComponents([.year, .month, .day, .hour, .minute, .second],
                                          from: instante)
        let anio = Swift.max(1980, Swift.min(2107, c.year ?? 1980))
        let mes = Swift.max(1, Swift.min(12, c.month ?? 1))
        let dia = Swift.max(1, Swift.min(31, c.day ?? 1))
        let hh = Swift.max(0, Swift.min(23, c.hour ?? 0))
        let mm = Swift.max(0, Swift.min(59, c.minute ?? 0))
        let ss = Swift.max(0, Swift.min(59, c.second ?? 0))

        let hora = UInt16((hh << 11) | (mm << 5) | (ss / 2))
        let fecha = UInt16(((anio - 1980) << 9) | (mes << 5) | dia)
        return (hora, fecha)
    }

    // MARK: - Nombres de entrada

    /// Normaliza el nombre interno de una entrada: separadores `/`, sin `\`,
    /// sin prefijo absoluto y sin componentes `..`.
    public static func nombreNormalizado(_ nombre: String) -> String {
        var texto = nombre.replacingOccurrences(of: "\\", with: "/")
        while texto.hasPrefix("/") { texto.removeFirst() }
        let partes = texto.split(separator: "/", omittingEmptySubsequences: true)
            .filter { $0 != "." && $0 != ".." }
            .map(String.init)
        return partes.joined(separator: "/")
    }

    // MARK: - Construcción del archivo

    /// Arma un ZIP en memoria con las entradas dadas, en el mismo orden.
    ///
    /// - Parameters:
    ///   - entradas: pares (nombre interno, contenido). El nombre se normaliza.
    ///   - fecha: marca de tiempo MS-DOS aplicada a todas las entradas.
    ///   - zonaHoraria: zona usada para convertir `fecha` (los ZIP guardan hora local).
    /// - Returns: los bytes completos del archivo `.zip`.
    /// - Throws: `ScanError.formatoInvalido` si hay nombres vacíos o repetidos,
    ///   `ScanError.escrituraFallida` si se excede el límite de 4 GiB o de 65535 entradas.
    public static func crear(entradas: [(nombre: String, datos: Data)],
                             fecha: Date,
                             zonaHoraria: TimeZone = TimeZone.current) throws -> Data {
        guard !entradas.isEmpty else {
            throw ScanError.formatoInvalido("El ZIP no puede quedar vacío")
        }
        guard entradas.count <= maximoEntradas else {
            throw ScanError.escrituraFallida("El ZIP admite máximo \(maximoEntradas) entradas")
        }

        let marca = fechaMSDOS(fecha, zonaHoraria: zonaHoraria)

        // Validación y preparación previa de cada entrada.
        struct Preparada {
            var nombreBytes: Data
            var banderas: UInt16
            var datos: Data
            var crc: UInt32
            var offset: UInt32
        }

        var vistos = Set<String>()
        var preparadas: [Preparada] = []
        preparadas.reserveCapacity(entradas.count)

        var pesoTotal = 0
        for entrada in entradas {
            let nombre = nombreNormalizado(entrada.nombre)
            guard !nombre.isEmpty else {
                throw ScanError.formatoInvalido("Nombre de entrada vacío en el ZIP")
            }
            guard !vistos.contains(nombre) else {
                throw ScanError.formatoInvalido("Entrada repetida en el ZIP: \(nombre)")
            }
            vistos.insert(nombre)

            guard let nombreBytes = nombre.data(using: .utf8) else {
                throw ScanError.formatoInvalido("Nombre no representable en UTF-8: \(nombre)")
            }
            guard nombreBytes.count <= Int(UInt16.max) else {
                throw ScanError.formatoInvalido("Nombre demasiado largo: \(nombre)")
            }
            guard entrada.datos.count <= maximoBytes else {
                throw ScanError.escrituraFallida("La entrada \(nombre) supera los 4 GiB")
            }

            let esASCII = nombre.unicodeScalars.allSatisfy { $0.isASCII }
            preparadas.append(Preparada(nombreBytes: nombreBytes,
                                        banderas: esASCII ? 0 : banderaUTF8,
                                        datos: entrada.datos,
                                        crc: crc32(entrada.datos),
                                        offset: 0))
            // 30 = tamaño fijo del local file header; 46 = el del directorio central.
            pesoTotal += 30 + nombreBytes.count + entrada.datos.count
            pesoTotal += 46 + nombreBytes.count
        }
        pesoTotal += 22 // EOCD

        guard pesoTotal <= maximoBytes else {
            throw ScanError.escrituraFallida("El ZIP resultante supera los 4 GiB")
        }

        var salida = Data()
        salida.reserveCapacity(pesoTotal)

        // --- Encabezados locales + datos ---
        for i in preparadas.indices {
            let offset = salida.count
            preparadas[i].offset = UInt32(offset)

            let p = preparadas[i]
            let tamano = UInt32(p.datos.count)

            salida.append(le32(firmaLocal))                     // firma 0x04034b50
            salida.append(le16(version))                        // versión necesaria: 20
            salida.append(le16(p.banderas))                     // banderas
            salida.append(le16(metodoStore))                    // método: 0 (store)
            salida.append(le16(marca.hora))                     // hora MS-DOS
            salida.append(le16(marca.dia))                      // fecha MS-DOS
            salida.append(le32(p.crc))                          // CRC-32
            salida.append(le32(tamano))                         // tamaño comprimido
            salida.append(le32(tamano))                         // tamaño sin comprimir
            salida.append(le16(UInt16(p.nombreBytes.count)))    // longitud del nombre
            salida.append(le16(0))                              // longitud del campo extra
            salida.append(p.nombreBytes)
            salida.append(p.datos)
        }

        // --- Directorio central ---
        let offsetCentral = salida.count
        for p in preparadas {
            let tamano = UInt32(p.datos.count)

            salida.append(le32(firmaCentral))                   // firma 0x02014b50
            salida.append(le16(version))                        // versión del creador
            salida.append(le16(version))                        // versión necesaria
            salida.append(le16(p.banderas))                     // banderas
            salida.append(le16(metodoStore))                    // método: 0 (store)
            salida.append(le16(marca.hora))                     // hora MS-DOS
            salida.append(le16(marca.dia))                      // fecha MS-DOS
            salida.append(le32(p.crc))                          // CRC-32
            salida.append(le32(tamano))                         // tamaño comprimido
            salida.append(le32(tamano))                         // tamaño sin comprimir
            salida.append(le16(UInt16(p.nombreBytes.count)))    // longitud del nombre
            salida.append(le16(0))                              // longitud del campo extra
            salida.append(le16(0))                              // longitud del comentario
            salida.append(le16(0))                              // disco inicial
            salida.append(le16(0))                              // atributos internos
            salida.append(le32(0))                              // atributos externos
            salida.append(le32(p.offset))                       // offset del encabezado local
            salida.append(p.nombreBytes)
        }
        let tamanoCentral = salida.count - offsetCentral

        // --- Fin del directorio central ---
        let cuantas = UInt16(preparadas.count)
        salida.append(le32(firmaFin))                           // firma 0x06054b50
        salida.append(le16(0))                                  // número de este disco
        salida.append(le16(0))                                  // disco del directorio central
        salida.append(le16(cuantas))                            // entradas en este disco
        salida.append(le16(cuantas))                            // entradas totales
        salida.append(le32(UInt32(tamanoCentral)))              // tamaño del directorio central
        salida.append(le32(UInt32(offsetCentral)))              // offset del directorio central
        salida.append(le16(0))                                  // longitud del comentario

        return salida
    }

    /// Variante que usa la fecha actual para la marca MS-DOS.
    public static func crear(entradas: [(nombre: String, datos: Data)]) throws -> Data {
        try crear(entradas: entradas, fecha: Date())
    }
}
