//
//  ScanConfiguration.swift
//  JoseScan
//
//  Parámetros del motor de captura LiDAR. Es un tipo de valor puro (sin ARKit)
//  para poder guardarse en ajustes, enviarse a pruebas y compartirse entre
//  hilos sin sorpresas.
//

import Foundation

/// Ajustes del escaneo. Todos los valores están en unidades del SI (metros,
/// segundos) salvo `submuestreoImagen`, que es un factor entero de píxeles.
public struct ScanConfiguration: Codable, Equatable {

    /// Reconstruir la malla de la escena (scene reconstruction de ARKit).
    public var capturarMalla: Bool
    /// Acumular la nube de puntos densa a partir del mapa de profundidad.
    public var capturarNube: Bool
    /// Muestrear el color de la cámara para cada punto. Si es falso se usa gris.
    public var capturarColor: Bool
    /// Confianza mínima aceptada por punto: 0 = baja, 1 = media, 2 = alta.
    public var confianzaMinima: UInt8
    /// Arista del vóxel de submuestreo, en metros.
    public var tamanoVoxel: Float
    /// Tope duro de puntos acumulados; al superarlo se recompacta con vóxeles mayores.
    public var maxPuntos: Int
    /// Distancia máxima aceptada desde la cámara, en metros.
    public var distanciaMaxima: Float
    /// Se toma 1 de cada N píxeles del mapa de profundidad (en X y en Y).
    public var submuestreoImagen: Int
    /// Veces por segundo que se extraen puntos, independiente del framerate de render.
    public var fpsCaptura: Double

    public init(capturarMalla: Bool = true,
                capturarNube: Bool = true,
                capturarColor: Bool = true,
                confianzaMinima: UInt8 = 1,
                tamanoVoxel: Float = 0.02,
                maxPuntos: Int = 3_000_000,
                distanciaMaxima: Float = 5.0,
                submuestreoImagen: Int = 2,
                fpsCaptura: Double = 10) {
        self.capturarMalla = capturarMalla
        self.capturarNube = capturarNube
        self.capturarColor = capturarColor
        self.confianzaMinima = confianzaMinima
        self.tamanoVoxel = tamanoVoxel
        self.maxPuntos = maxPuntos
        self.distanciaMaxima = distanciaMaxima
        self.submuestreoImagen = submuestreoImagen
        self.fpsCaptura = fpsCaptura
    }

    /// Configuración recomendada para trabajo de campo.
    public static let porDefecto = ScanConfiguration()

    /// Intervalo entre extracciones de puntos, en segundos.
    public var intervaloCaptura: TimeInterval {
        fpsCaptura > 0 ? 1.0 / fpsCaptura : 0
    }

    /// Devuelve una copia con todos los valores dentro de rangos seguros.
    /// El motor de captura sólo trabaja con configuraciones saneadas.
    public func saneada() -> ScanConfiguration {
        var c = self
        c.confianzaMinima = Swift.min(2, c.confianzaMinima)
        if !c.tamanoVoxel.isFinite || c.tamanoVoxel <= 0 { c.tamanoVoxel = 0.02 }
        c.tamanoVoxel = Swift.min(Swift.max(c.tamanoVoxel, 0.002), 1.0)
        c.maxPuntos = Swift.min(Swift.max(c.maxPuntos, 10_000), 20_000_000)
        if !c.distanciaMaxima.isFinite || c.distanciaMaxima <= 0 { c.distanciaMaxima = 5.0 }
        c.distanciaMaxima = Swift.min(Swift.max(c.distanciaMaxima, 0.1), 100.0)
        c.submuestreoImagen = Swift.min(Swift.max(c.submuestreoImagen, 1), 16)
        if !c.fpsCaptura.isFinite { c.fpsCaptura = 10 }
        c.fpsCaptura = Swift.min(Swift.max(c.fpsCaptura, 0.5), 60)
        return c
    }

    /// Verdadero si el cambio a `otra` obliga a reiniciar la sesión de ARKit
    /// (la reconstrucción de escena sólo se puede activar al arrancar).
    public func requiereReinicioAR(respectoA otra: ScanConfiguration) -> Bool {
        capturarMalla != otra.capturarMalla
    }

    // MARK: - Codable tolerante

    private enum CodingKeys: String, CodingKey {
        case capturarMalla, capturarNube, capturarColor, confianzaMinima
        case tamanoVoxel, maxPuntos, distanciaMaxima, submuestreoImagen, fpsCaptura
    }

    /// Decodifica tolerando claves ausentes: cualquier campo que falte toma el
    /// valor por defecto en lugar de fallar.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = ScanConfiguration()
        capturarMalla = try c.decodeIfPresent(Bool.self, forKey: .capturarMalla) ?? d.capturarMalla
        capturarNube = try c.decodeIfPresent(Bool.self, forKey: .capturarNube) ?? d.capturarNube
        capturarColor = try c.decodeIfPresent(Bool.self, forKey: .capturarColor) ?? d.capturarColor
        confianzaMinima = try c.decodeIfPresent(UInt8.self, forKey: .confianzaMinima) ?? d.confianzaMinima
        tamanoVoxel = try c.decodeIfPresent(Float.self, forKey: .tamanoVoxel) ?? d.tamanoVoxel
        maxPuntos = try c.decodeIfPresent(Int.self, forKey: .maxPuntos) ?? d.maxPuntos
        distanciaMaxima = try c.decodeIfPresent(Float.self, forKey: .distanciaMaxima) ?? d.distanciaMaxima
        submuestreoImagen = try c.decodeIfPresent(Int.self, forKey: .submuestreoImagen) ?? d.submuestreoImagen
        fpsCaptura = try c.decodeIfPresent(Double.self, forKey: .fpsCaptura) ?? d.fpsCaptura
    }
}
