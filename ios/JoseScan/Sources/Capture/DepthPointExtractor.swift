//
//  DepthPointExtractor.swift
//  JoseScan
//
//  Convierte el mapa de profundidad de un ARFrame en una nube de puntos en
//  coordenadas mundo, muestreando el color de la imagen de la cámara.
//
//  El recorrido es por punteros crudos (sin arreglos temporales por píxel) para
//  poder ejecutarse varias veces por segundo en la cola de captura.
//

#if canImport(ARKit)

import Foundation
import ARKit
import CoreVideo
import simd

public final class DepthPointExtractor {

    /// Nube reutilizada entre llamadas para evitar realojar memoria en cada frame.
    private var reserva: Int = 0

    public init() {}

    /// Extrae los puntos válidos de `frame` según `configuracion`.
    /// Devuelve una nube vacía si el frame no trae profundidad utilizable.
    public func extraer(desde frame: ARFrame, configuracion: ScanConfiguration) -> PointCloud {
        let cfg = configuracion.saneada()
        guard cfg.capturarNube else { return PointCloud() }
        guard let profundidad = frame.sceneDepth ?? frame.smoothedSceneDepth else {
            return PointCloud()
        }

        let mapaProfundidad = profundidad.depthMap
        guard CVPixelBufferGetPixelFormatType(mapaProfundidad) == kCVPixelFormatType_DepthFloat32 else {
            return PointCloud()
        }
        guard CVPixelBufferLockBaseAddress(mapaProfundidad, .readOnly) == kCVReturnSuccess else {
            return PointCloud()
        }
        defer { CVPixelBufferUnlockBaseAddress(mapaProfundidad, .readOnly) }

        guard let baseProfundidad = CVPixelBufferGetBaseAddress(mapaProfundidad) else {
            return PointCloud()
        }
        let ancho = CVPixelBufferGetWidth(mapaProfundidad)
        let alto = CVPixelBufferGetHeight(mapaProfundidad)
        let filaProfundidad = CVPixelBufferGetBytesPerRow(mapaProfundidad)
        guard ancho > 0, alto > 0 else { return PointCloud() }

        // --- Mapa de confianza (opcional) -----------------------------------
        var mapaConfianza: CVPixelBuffer? = profundidad.confidenceMap
        var confianzaBloqueada = false
        if let m = mapaConfianza {
            if CVPixelBufferGetPixelFormatType(m) == kCVPixelFormatType_OneComponent8,
               CVPixelBufferLockBaseAddress(m, .readOnly) == kCVReturnSuccess {
                confianzaBloqueada = true
            } else {
                mapaConfianza = nil
            }
        }
        defer {
            if confianzaBloqueada, let m = mapaConfianza {
                CVPixelBufferUnlockBaseAddress(m, .readOnly)
            }
        }

        var baseConfianza: UnsafeMutableRawPointer?
        var filaConfianza = 0
        var anchoConfianza = 0
        var altoConfianza = 0
        if let m = mapaConfianza, confianzaBloqueada {
            baseConfianza = CVPixelBufferGetBaseAddress(m)
            filaConfianza = CVPixelBufferGetBytesPerRow(m)
            anchoConfianza = CVPixelBufferGetWidth(m)
            altoConfianza = CVPixelBufferGetHeight(m)
            if baseConfianza == nil || anchoConfianza <= 0 || altoConfianza <= 0 {
                baseConfianza = nil
            }
        }

        // --- Imagen de la cámara para el color (opcional) --------------------
        let imagen = frame.capturedImage
        let formatoImagen = CVPixelBufferGetPixelFormatType(imagen)
        let rangoCompleto = formatoImagen == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        var colorActivo = cfg.capturarColor
            && (rangoCompleto || formatoImagen == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            && CVPixelBufferGetPlaneCount(imagen) >= 2
        var colorBloqueado = false
        if colorActivo {
            if CVPixelBufferLockBaseAddress(imagen, .readOnly) == kCVReturnSuccess {
                colorBloqueado = true
            } else {
                colorActivo = false
            }
        }
        defer {
            if colorBloqueado { CVPixelBufferUnlockBaseAddress(imagen, .readOnly) }
        }

        var baseLuma: UnsafeMutableRawPointer?
        var baseCroma: UnsafeMutableRawPointer?
        var filaLuma = 0
        var filaCroma = 0
        var anchoLuma = 0
        var altoLuma = 0
        var anchoCroma = 0
        var altoCroma = 0
        if colorActivo {
            baseLuma = CVPixelBufferGetBaseAddressOfPlane(imagen, 0)
            baseCroma = CVPixelBufferGetBaseAddressOfPlane(imagen, 1)
            filaLuma = CVPixelBufferGetBytesPerRowOfPlane(imagen, 0)
            filaCroma = CVPixelBufferGetBytesPerRowOfPlane(imagen, 1)
            anchoLuma = CVPixelBufferGetWidthOfPlane(imagen, 0)
            altoLuma = CVPixelBufferGetHeightOfPlane(imagen, 0)
            anchoCroma = CVPixelBufferGetWidthOfPlane(imagen, 1)
            altoCroma = CVPixelBufferGetHeightOfPlane(imagen, 1)
            if baseLuma == nil || baseCroma == nil || anchoLuma <= 0 || altoLuma <= 0
                || anchoCroma <= 0 || altoCroma <= 0 {
                colorActivo = false
            }
        }

        // --- Intrínsecos escalados al tamaño del mapa de profundidad ---------
        // Los intrínsecos de ARKit corresponden a `imageResolution`; el mapa de
        // profundidad es una versión reducida con la misma relación de aspecto.
        let resolucion = frame.camera.imageResolution
        guard resolucion.width > 0, resolucion.height > 0 else { return PointCloud() }
        let escalaX = Float(ancho) / Float(resolucion.width)
        let escalaY = Float(alto) / Float(resolucion.height)

        var K = frame.camera.intrinsics
        K[0][0] *= escalaX      // fx
        K[1][1] *= escalaY      // fy
        K[2][0] *= escalaX      // cx
        K[2][1] *= escalaY      // cy
        let Kinv = K.inverse
        let transformada = frame.camera.transform

        // Relación píxel de profundidad -> píxel de luma.
        let lumaPorX = colorActivo ? Float(anchoLuma) / Float(ancho) : 0
        let lumaPorY = colorActivo ? Float(altoLuma) / Float(alto) : 0

        let paso = Swift.max(1, cfg.submuestreoImagen)
        let distanciaMaxima = cfg.distanciaMaxima
        let confianzaMinima = cfg.confianzaMinima
        let grisPorDefecto = SIMD3<UInt8>(160, 160, 160)

        var nube = PointCloud(frame: .arkit)
        let estimado = (ancho / paso + 1) * (alto / paso + 1)
        reserva = Swift.max(reserva, estimado)
        nube.reserveCapacity(reserva)

        var v = 0
        while v < alto {
            let filaProf = baseProfundidad.advanced(by: v * filaProfundidad)
                .bindMemory(to: Float32.self, capacity: ancho)

            // Fila equivalente en el mapa de confianza.
            var filaConf: UnsafeMutablePointer<UInt8>?
            if let bc = baseConfianza {
                let vc = Swift.min(altoConfianza - 1, v * altoConfianza / alto)
                filaConf = bc.advanced(by: vc * filaConfianza)
                    .bindMemory(to: UInt8.self, capacity: anchoConfianza)
            }

            // Filas equivalentes en luma y croma.
            var filaY: UnsafeMutablePointer<UInt8>?
            var filaCbCr: UnsafeMutablePointer<UInt8>?
            if colorActivo, let bl = baseLuma, let bc = baseCroma {
                let yLuma = Swift.min(altoLuma - 1, Int(Float(v) * lumaPorY))
                let yCroma = Swift.min(altoCroma - 1, yLuma / 2)
                filaY = bl.advanced(by: yLuma * filaLuma)
                    .bindMemory(to: UInt8.self, capacity: anchoLuma)
                filaCbCr = bc.advanced(by: yCroma * filaCroma)
                    .bindMemory(to: UInt8.self, capacity: anchoCroma * 2)
            }

            var u = 0
            while u < ancho {
                let d = Float(filaProf[u])
                if !d.isFinite || d <= 0.01 || d > distanciaMaxima {
                    u += paso
                    continue
                }

                var confianza: UInt8 = 2
                if let fc = filaConf {
                    let uc = Swift.min(anchoConfianza - 1, u * anchoConfianza / ancho)
                    confianza = fc[uc]
                    if confianza > 2 { confianza = 2 }
                    if confianza < confianzaMinima {
                        u += paso
                        continue
                    }
                }

                // Retroproyección: (u, v, 1) -> rayo en el marco de la imagen.
                let rayo = Kinv * SIMD3<Float>(Float(u), Float(v), 1)
                // El marco de la imagen tiene +Y hacia abajo y +Z hacia la escena;
                // el de ARKit tiene +Y arriba y mira hacia -Z.
                let punto = SIMD4<Float>(rayo.x * d, -rayo.y * d, -d, 1)
                let mundo = transformada * punto
                if !mundo.x.isFinite || !mundo.y.isFinite || !mundo.z.isFinite {
                    u += paso
                    continue
                }

                var color = grisPorDefecto
                if colorActivo, let fy = filaY, let fc = filaCbCr {
                    let xLuma = Swift.min(anchoLuma - 1, Int(Float(u) * lumaPorX))
                    let xCroma = Swift.min(anchoCroma - 1, xLuma / 2)
                    color = DepthPointExtractor.yuvARGB(y: fy[xLuma],
                                                       cb: fc[xCroma * 2],
                                                       cr: fc[xCroma * 2 + 1],
                                                       rangoCompleto: rangoCompleto)
                }

                nube.positions.append(SIMD3<Float>(mundo.x, mundo.y, mundo.z))
                nube.colors.append(color)
                nube.confidences.append(confianza)
                u += paso
            }
            v += paso
        }

        return nube
    }

    // MARK: - Color

    /// Conversión BT.601 de YCbCr (biplanar 4:2:0) a RGB de 8 bits.
    @inline(__always)
    static func yuvARGB(y: UInt8, cb: UInt8, cr: UInt8, rangoCompleto: Bool) -> SIMD3<UInt8> {
        var luma = Float(y)
        var azul = Float(cb) - 128
        var rojo = Float(cr) - 128
        if !rangoCompleto {
            luma = (luma - 16) * (255.0 / 219.0)
            azul *= 255.0 / 224.0
            rojo *= 255.0 / 224.0
        }
        let r = luma + 1.402 * rojo
        let g = luma - 0.344136 * azul - 0.714136 * rojo
        let b = luma + 1.772 * azul
        return SIMD3<UInt8>(recortar(r), recortar(g), recortar(b))
    }

    @inline(__always)
    private static func recortar(_ valor: Float) -> UInt8 {
        if !valor.isFinite { return 0 }
        if valor <= 0 { return 0 }
        if valor >= 255 { return 255 }
        return UInt8(valor)
    }
}

#endif
