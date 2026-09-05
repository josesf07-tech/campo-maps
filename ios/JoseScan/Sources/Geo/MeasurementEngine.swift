//
//  MeasurementEngine.swift
//  JoseScan
//
//  Mediciones sobre la geometría del escaneo: distancias, alturas, azimutes,
//  perímetros, áreas y volúmenes.
//
//  OJO CON LA VERTICAL: el eje vertical depende del marco.
//    · `.arkit` → vertical = Y   (plano horizontal: Z-X, en ese orden, porque
//                                 Z × X = Y y así el sentido de giro positivo
//                                 sigue siendo antihorario visto desde arriba).
//    · `.enu`   → vertical = Z   (plano horizontal: X-Y = Este-Norte).
//
//  Los cálculos se hacen en `Double` aunque la geometría venga en `Float`, para
//  no perder milímetros al acumular sobre miles de triángulos.
//

import Foundation
import simd

public enum MeasurementEngine {

    // MARK: - Distancias

    /// Distancia euclídea 3D entre dos puntos, en metros.
    public static func distancia(_ a: SIMD3<Float>, _ b: SIMD3<Float>) -> Double {
        let dx = Double(b.x) - Double(a.x)
        let dy = Double(b.y) - Double(a.y)
        let dz = Double(b.z) - Double(a.z)
        return (dx * dx + dy * dy + dz * dz).squareRoot()
    }

    /// Distancia horizontal (proyectada en planta) asumiendo marco `.arkit`,
    /// que es el marco de trabajo mientras se captura.
    public static func distanciaHorizontal(_ a: SIMD3<Float>, _ b: SIMD3<Float>) -> Double {
        return MeasurementEngine.distanciaHorizontal(a, b, marco: .arkit)
    }

    /// Distancia horizontal (proyectada en planta) en el marco indicado.
    public static func distanciaHorizontal(_ a: SIMD3<Float>, _ b: SIMD3<Float>,
                                           marco: ScanCoordinateFrame) -> Double {
        let pa = MeasurementEngine.componentes(a, marco: marco)
        let pb = MeasurementEngine.componentes(b, marco: marco)
        let du = pb.u - pa.u
        let dv = pb.v - pa.v
        return (du * du + dv * dv).squareRoot()
    }

    /// Diferencia de cota entre dos puntos (valor absoluto), en metros.
    public static func altura(_ a: SIMD3<Float>, _ b: SIMD3<Float>,
                              marco: ScanCoordinateFrame) -> Double {
        return abs(MeasurementEngine.vertical(b, marco: marco) - MeasurementEngine.vertical(a, marco: marco))
    }

    // MARK: - Azimut

    /// Azimut (rumbo verdadero) del segmento a→b, en grados [0, 360).
    ///
    /// En marco `.enu` el norte ya es +Y, así que `rumboGrados` se ignora. En
    /// marco `.arkit` los puntos se rotan primero con `GeoTransform.arkitAEnu`.
    public static func azimut(_ a: SIMD3<Float>, _ b: SIMD3<Float>,
                              marco: ScanCoordinateFrame, rumboGrados: Double) -> Double {
        let ae: SIMD3<Float>
        let be: SIMD3<Float>
        switch marco {
        case .enu:
            ae = a
            be = b
        case .arkit:
            ae = GeoTransform.arkitAEnu(a, rumboGrados: rumboGrados)
            be = GeoTransform.arkitAEnu(b, rumboGrados: rumboGrados)
        }
        let dEste = Double(be.x) - Double(ae.x)
        let dNorte = Double(be.y) - Double(ae.y)
        guard abs(dEste) > 1e-9 || abs(dNorte) > 1e-9 else { return 0 }
        var grados = atan2(dEste, dNorte) * 180.0 / Double.pi
        if grados < 0 { grados += 360.0 }
        if grados >= 360.0 { grados -= 360.0 }
        return grados
    }

    // MARK: - Perímetro

    /// Longitud de la polilínea. Con 3 o más puntos se cierra el anillo, es
    /// decir, devuelve el perímetro del polígono.
    public static func perimetro(_ puntos: [SIMD3<Float>]) -> Double {
        guard puntos.count >= 2 else { return 0 }
        var total = 0.0
        var i = 0
        while i < puntos.count - 1 {
            total += MeasurementEngine.distancia(puntos[i], puntos[i + 1])
            i += 1
        }
        if puntos.count >= 3 {
            total += MeasurementEngine.distancia(puntos[puntos.count - 1], puntos[0])
        }
        return total
    }

    // MARK: - Áreas

    /// Área 3D del polígono definido por los puntos, en m².
    ///
    /// Usa el área vectorial: se suman los productos cruzados de los lados
    /// respecto del centroide y se toma la mitad de la magnitud de la suma.
    /// Es exacta para polígonos planos y da el mejor plano medio cuando los
    /// vértices no son coplanares (caso habitual en terreno).
    public static func areaPoligono(_ puntos: [SIMD3<Float>]) -> Double {
        guard puntos.count >= 3 else { return 0 }
        let n = Double(puntos.count)

        var centroide = SIMD3<Double>(0, 0, 0)
        for p in puntos {
            centroide += SIMD3<Double>(Double(p.x), Double(p.y), Double(p.z))
        }
        centroide /= n

        var acumulado = SIMD3<Double>(0, 0, 0)
        var i = 0
        while i < puntos.count {
            let j = (i + 1) % puntos.count
            let a = SIMD3<Double>(Double(puntos[i].x), Double(puntos[i].y), Double(puntos[i].z)) - centroide
            let b = SIMD3<Double>(Double(puntos[j].x), Double(puntos[j].y), Double(puntos[j].z)) - centroide
            acumulado += simd_cross(a, b)
            i += 1
        }
        return 0.5 * simd_length(acumulado)
    }

    /// Área de la proyección horizontal (en planta) del polígono, en m².
    public static func areaProyectada(_ puntos: [SIMD3<Float>], marco: ScanCoordinateFrame) -> Double {
        guard puntos.count >= 3 else { return 0 }
        var suma = 0.0
        var i = 0
        while i < puntos.count {
            let j = (i + 1) % puntos.count
            let a = MeasurementEngine.componentes(puntos[i], marco: marco)
            let b = MeasurementEngine.componentes(puntos[j], marco: marco)
            suma += a.u * b.v - b.u * a.v
            i += 1
        }
        return abs(suma) * 0.5
    }

    // MARK: - Volumen

    /// Volumen entre la malla y un plano horizontal de referencia, en m³.
    ///
    /// Para cada triángulo se acumula el volumen firmado del prisma que va del
    /// triángulo al plano `nivelBase`: (área proyectada firmada) × (cota media
    /// respecto del nivel base). En una malla cerrada y coherente las caras
    /// superiores e inferiores se compensan y queda el volumen encerrado; en
    /// una superficie abierta (un talud, una cárcava) queda el volumen de corte
    /// o relleno respecto del nivel base. Se devuelve el valor absoluto.
    public static func volumen(malla: ScanMesh, nivelBase: Float, marco: ScanCoordinateFrame) -> Double {
        guard !malla.isEmpty, malla.indices.count >= 3 else { return 0 }
        let base = Double(nivelBase)
        let totalVertices = malla.vertices.count
        var total = 0.0
        var i = 0
        while i + 2 < malla.indices.count {
            let i0 = Int(malla.indices[i])
            let i1 = Int(malla.indices[i + 1])
            let i2 = Int(malla.indices[i + 2])
            i += 3
            guard i0 < totalVertices, i1 < totalVertices, i2 < totalVertices else { continue }

            let a = MeasurementEngine.componentes(malla.vertices[i0], marco: marco)
            let b = MeasurementEngine.componentes(malla.vertices[i1], marco: marco)
            let c = MeasurementEngine.componentes(malla.vertices[i2], marco: marco)

            // Área firmada del triángulo proyectado en planta.
            let areaFirmada = 0.5 * ((b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v))
            let cotaMedia = ((a.alto - base) + (b.alto - base) + (c.alto - base)) / 3.0
            total += areaFirmada * cotaMedia
        }
        return abs(total)
    }

    // MARK: - Fábrica de mediciones

    /// Crea el registro de una medición.
    ///
    /// Devuelve `nil` si no hay puntos suficientes: 2 para distancia, altura y
    /// azimut; 3 o más para área y volumen.
    ///
    /// - Note: para `.volumen` a partir de puntos sueltos se calcula el prisma
    ///   equivalente: área proyectada del polígono × altura media de sus
    ///   vértices sobre el más bajo. El volumen sobre una malla completa se
    ///   obtiene con `volumen(malla:nivelBase:marco:)`.
    public static func medir(_ tipo: MeasurementKind,
                             puntos: [SIMD3<Float>],
                             marco: ScanCoordinateFrame,
                             rumboGrados: Double,
                             etiqueta: String?) -> MeasurementRecord? {
        let coordenadas: [[Float]] = puntos.map { p in [p.x, p.y, p.z] }

        switch tipo {
        case .distancia:
            guard puntos.count >= 2 else { return nil }
            var valor = 0.0
            var i = 0
            while i < puntos.count - 1 {
                valor += MeasurementEngine.distancia(puntos[i], puntos[i + 1])
                i += 1
            }
            return MeasurementRecord(kind: .distancia, value: valor, unit: "m",
                                     points: coordenadas, label: etiqueta)

        case .altura:
            guard puntos.count >= 2 else { return nil }
            let valor = MeasurementEngine.altura(puntos[0], puntos[1], marco: marco)
            return MeasurementRecord(kind: .altura, value: valor, unit: "m",
                                     points: coordenadas, label: etiqueta)

        case .azimut:
            guard puntos.count >= 2 else { return nil }
            let valor = MeasurementEngine.azimut(puntos[0], puntos[1],
                                                 marco: marco, rumboGrados: rumboGrados)
            return MeasurementRecord(kind: .azimut, value: valor, unit: "°",
                                     points: coordenadas, label: etiqueta)

        case .area:
            guard puntos.count >= 3 else { return nil }
            let valor = MeasurementEngine.areaPoligono(puntos)
            return MeasurementRecord(kind: .area, value: valor, unit: "m²",
                                     points: coordenadas, label: etiqueta)

        case .volumen:
            guard puntos.count >= 3 else { return nil }
            var cotaMinima = Double.greatestFiniteMagnitude
            for p in puntos {
                cotaMinima = Swift.min(cotaMinima, MeasurementEngine.vertical(p, marco: marco))
            }
            var sumaAlturas = 0.0
            for p in puntos {
                sumaAlturas += MeasurementEngine.vertical(p, marco: marco) - cotaMinima
            }
            let alturaMedia = sumaAlturas / Double(puntos.count)
            let valor = MeasurementEngine.areaProyectada(puntos, marco: marco) * alturaMedia
            return MeasurementRecord(kind: .volumen, value: valor, unit: "m³",
                                     points: coordenadas, label: etiqueta)
        }
    }

    // MARK: - Formato

    /// Texto de una medición para la HUD: `3.42 m`, `128.7 m²`, `172°`.
    public static func formatear(_ registro: MeasurementRecord) -> String {
        switch registro.kind {
        case .azimut:
            return String(format: "%.0f%@", registro.value, registro.unit)
        case .distancia, .altura:
            return String(format: "%.2f %@", registro.value, registro.unit)
        case .area, .volumen:
            return String(format: "%.2f %@", registro.value, registro.unit)
        }
    }

    // MARK: - Internos

    /// Descompone un punto en (u, v) horizontales y `alto` vertical según el marco.
    /// · `.arkit`: (u, v) = (z, x) y alto = y  → Z × X = Y (vertical hacia arriba).
    /// · `.enu`:   (u, v) = (x, y) y alto = z  → X × Y = Z (vertical hacia arriba).
    internal static func componentes(_ p: SIMD3<Float>,
                                     marco: ScanCoordinateFrame) -> (u: Double, v: Double, alto: Double) {
        switch marco {
        case .arkit:
            return (u: Double(p.z), v: Double(p.x), alto: Double(p.y))
        case .enu:
            return (u: Double(p.x), v: Double(p.y), alto: Double(p.z))
        }
    }

    /// Coordenada vertical del punto según el marco.
    internal static func vertical(_ p: SIMD3<Float>, marco: ScanCoordinateFrame) -> Double {
        switch marco {
        case .arkit: return Double(p.y)
        case .enu: return Double(p.z)
        }
    }
}
