//
//  VoxelDownsampler.swift
//  JoseScan
//
//  Submuestreo por rejilla de vóxeles con tabla hash. Cada vóxel guarda el
//  promedio de posición y color de los puntos que cayeron dentro, de modo que
//  la nube acumulada no crece sin control aunque el usuario pase varias veces
//  por la misma superficie.
//
//  No depende de ARKit: se puede usar en pruebas unitarias y en macOS.
//

import Foundation
import simd

public final class VoxelDownsampler {

    /// Acumulador de un vóxel. Se guardan sumas en `Float` y el conteo aparte
    /// para poder promediar sin recorrer los puntos originales.
    private struct Celda {
        var sumaX: Float
        var sumaY: Float
        var sumaZ: Float
        var sumaR: Float
        var sumaG: Float
        var sumaB: Float
        var confianza: UInt8
        var n: Int32
    }

    private var celdas: [SIMD3<Int32>: Celda]

    /// Arista actual del vóxel en metros. Puede crecer respecto a la
    /// configuración si se alcanzó el tope de puntos.
    public private(set) var tamanoVoxel: Float

    /// Tope de puntos (vóxeles ocupados) antes de recompactar.
    public private(set) var maxPuntos: Int

    /// Arista solicitada por la configuración, antes de cualquier recompactación.
    public private(set) var tamanoVoxelSolicitado: Float

    /// Número de vóxeles cuya confianza acumulada es alta (2).
    private var conteoAlta: Int = 0

    /// Marco de coordenadas de la nube acumulada.
    public var frame: ScanCoordinateFrame

    public init(tamanoVoxel: Float = 0.02,
                maxPuntos: Int = 3_000_000,
                frame: ScanCoordinateFrame = .arkit) {
        let arista = (tamanoVoxel.isFinite && tamanoVoxel > 0) ? tamanoVoxel : 0.02
        self.tamanoVoxel = arista
        self.tamanoVoxelSolicitado = arista
        self.maxPuntos = Swift.max(1_000, maxPuntos)
        self.frame = frame
        self.celdas = [:]
    }

    // MARK: - Estado

    /// Número de puntos resultantes (uno por vóxel ocupado).
    public var count: Int { celdas.count }

    public var isEmpty: Bool { celdas.isEmpty }

    /// Fracción de puntos con confianza alta, entre 0 y 1.
    public var proporcionAltaConfianza: Double {
        celdas.isEmpty ? 0 : Double(conteoAlta) / Double(celdas.count)
    }

    /// Vacía la rejilla y restaura la arista solicitada.
    public func reiniciar() {
        celdas.removeAll(keepingCapacity: false)
        conteoAlta = 0
        tamanoVoxel = tamanoVoxelSolicitado
    }

    /// Aplica una configuración nueva. Si cambian la arista o el tope, la
    /// rejilla se reconstruye con los centroides ya acumulados.
    public func aplicar(_ configuracion: ScanConfiguration) {
        let c = configuracion.saneada()
        let cambiaArista = abs(c.tamanoVoxel - tamanoVoxelSolicitado) > 1e-6
        maxPuntos = Swift.max(1_000, c.maxPuntos)
        tamanoVoxelSolicitado = c.tamanoVoxel
        if cambiaArista {
            reconstruir(con: c.tamanoVoxel)
        }
        while celdas.count > maxPuntos {
            reconstruir(con: tamanoVoxel * 1.25)
        }
    }

    // MARK: - Inserción

    /// Inserta una nube completa en la rejilla.
    public func insertar(_ puntos: PointCloud) {
        guard !puntos.isEmpty else { return }
        let conColor = puntos.hasColor
        let conConfianza = puntos.confidences.count == puntos.positions.count
        celdas.reserveCapacity(celdas.count + puntos.count)
        let inv = 1.0 / tamanoVoxel
        for i in 0..<puntos.positions.count {
            let p = puntos.positions[i]
            let color = conColor ? puntos.colors[i] : SIMD3<UInt8>(160, 160, 160)
            let conf = conConfianza ? puntos.confidences[i] : 2
            agregar(p, color, conf, inv)
        }
        compactarSiSobrepasa()
    }

    /// Inserta un único punto ya expresado en coordenadas mundo.
    public func insertar(posicion: SIMD3<Float>, color: SIMD3<UInt8>, confianza: UInt8) {
        agregar(posicion, color, confianza, 1.0 / tamanoVoxel)
        compactarSiSobrepasa()
    }

    @inline(__always)
    private func agregar(_ p: SIMD3<Float>,
                         _ color: SIMD3<UInt8>,
                         _ confianza: UInt8,
                         _ inv: Float) {
        guard let k = clave(p, inv) else { return }
        if var celda = celdas[k] {
            celda.sumaX += p.x
            celda.sumaY += p.y
            celda.sumaZ += p.z
            celda.sumaR += Float(color.x)
            celda.sumaG += Float(color.y)
            celda.sumaB += Float(color.z)
            celda.n &+= 1
            if confianza > celda.confianza {
                if confianza >= 2 && celda.confianza < 2 { conteoAlta += 1 }
                celda.confianza = confianza
            }
            celdas[k] = celda
        } else {
            celdas[k] = Celda(sumaX: p.x, sumaY: p.y, sumaZ: p.z,
                              sumaR: Float(color.x), sumaG: Float(color.y), sumaB: Float(color.z),
                              confianza: confianza, n: 1)
            if confianza >= 2 { conteoAlta += 1 }
        }
    }

    /// Índice entero del vóxel que contiene a `p`. Devuelve nil si el punto no
    /// es finito o cae fuera del rango representable en Int32.
    @inline(__always)
    private func clave(_ p: SIMD3<Float>, _ inv: Float) -> SIMD3<Int32>? {
        guard p.x.isFinite, p.y.isFinite, p.z.isFinite else { return nil }
        let fx = (p.x * inv).rounded(.down)
        let fy = (p.y * inv).rounded(.down)
        let fz = (p.z * inv).rounded(.down)
        let limite: Float = 1_000_000_000
        guard fx > -limite, fx < limite,
              fy > -limite, fy < limite,
              fz > -limite, fz < limite else { return nil }
        return SIMD3<Int32>(Int32(fx), Int32(fy), Int32(fz))
    }

    // MARK: - Recompactación

    @inline(__always)
    private func compactarSiSobrepasa() {
        var vueltas = 0
        while celdas.count > maxPuntos && vueltas < 32 {
            reconstruir(con: tamanoVoxel * 1.25)
            vueltas += 1
        }
    }

    /// Reconstruye la rejilla con otra arista partiendo de los centroides
    /// actuales, conservando el peso (`n`) de cada vóxel.
    private func reconstruir(con nuevaArista: Float) {
        let arista = (nuevaArista.isFinite && nuevaArista > 0) ? Swift.min(nuevaArista, 10.0) : tamanoVoxel
        guard abs(arista - tamanoVoxel) > 1e-7 else { return }
        let anteriores = celdas
        celdas.removeAll(keepingCapacity: true)
        conteoAlta = 0
        tamanoVoxel = arista
        let inv = 1.0 / arista
        for (_, vieja) in anteriores {
            let n = Float(Swift.max(vieja.n, 1))
            let centro = SIMD3<Float>(vieja.sumaX / n, vieja.sumaY / n, vieja.sumaZ / n)
            guard let k = clave(centro, inv) else { continue }
            if var celda = celdas[k] {
                celda.sumaX += vieja.sumaX
                celda.sumaY += vieja.sumaY
                celda.sumaZ += vieja.sumaZ
                celda.sumaR += vieja.sumaR
                celda.sumaG += vieja.sumaG
                celda.sumaB += vieja.sumaB
                celda.n = celda.n &+ vieja.n
                if vieja.confianza > celda.confianza {
                    if vieja.confianza >= 2 && celda.confianza < 2 { conteoAlta += 1 }
                    celda.confianza = vieja.confianza
                }
                celdas[k] = celda
            } else {
                celdas[k] = vieja
                if vieja.confianza >= 2 { conteoAlta += 1 }
            }
        }
    }

    // MARK: - Salida

    /// Nube resultante: un punto por vóxel ocupado, con posición y color promedio.
    public func nube() -> PointCloud {
        var salida = PointCloud(frame: frame)
        salida.reserveCapacity(celdas.count)
        for (_, celda) in celdas {
            let n = Float(Swift.max(celda.n, 1))
            salida.positions.append(SIMD3<Float>(celda.sumaX / n, celda.sumaY / n, celda.sumaZ / n))
            let r = Swift.min(255, Swift.max(0, Int((celda.sumaR / n).rounded())))
            let g = Swift.min(255, Swift.max(0, Int((celda.sumaG / n).rounded())))
            let b = Swift.min(255, Swift.max(0, Int((celda.sumaB / n).rounded())))
            salida.colors.append(SIMD3<UInt8>(UInt8(r), UInt8(g), UInt8(b)))
            salida.confidences.append(celda.confianza)
        }
        return salida
    }

    /// Caja envolvente de los centroides acumulados.
    public func bounds() -> BoundingBox {
        var caja = BoundingBox.empty
        for (_, celda) in celdas {
            let n = Float(Swift.max(celda.n, 1))
            caja.expand(SIMD3<Float>(celda.sumaX / n, celda.sumaY / n, celda.sumaZ / n))
        }
        return caja
    }
}
