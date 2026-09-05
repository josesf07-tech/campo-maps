//
//  AppSettings.swift
//  JoseScan
//
//  Preferencias de la aplicación persistidas en `UserDefaults` con claves
//  prefijadas `josescan.`. Cada propiedad publicada se guarda sola mediante
//  `didSet`, de modo que cualquier vista que edite el objeto deja el valor
//  en disco sin trabajo adicional.
//
//  Los valores por defecto se registran con `UserDefaults.register(defaults:)`
//  para que una instalación limpia arranque con una configuración sensata de
//  trabajo en campo.
//

import Foundation
import Combine

public final class AppSettings: ObservableObject {

    // MARK: - Claves de UserDefaults

    /// Claves usadas en `UserDefaults`. Son públicas para que otros módulos
    /// puedan leer una preferencia puntual sin instanciar la clase.
    public enum Clave {
        public static let confianzaMinima = "josescan.confianzaMinima"
        public static let tamanoVoxelCm = "josescan.tamanoVoxelCm"
        public static let distanciaMaximaM = "josescan.distanciaMaximaM"
        public static let capturarColor = "josescan.capturarColor"
        public static let capturarMalla = "josescan.capturarMalla"
        public static let georreferenciarAlGuardar = "josescan.georreferenciarAlGuardar"
        public static let unidades = "josescan.unidades"
        public static let proyectoActual = "josescan.proyectoActual"
    }

    // MARK: - Constantes

    public static let unidadMetrico = "metrico"
    public static let unidadImperial = "imperial"

    /// Valores por defecto de fábrica.
    public static let confianzaMinimaPorDefecto = 1
    public static let tamanoVoxelCmPorDefecto = 3.0
    public static let distanciaMaximaMPorDefecto = 3.0
    public static let proyectoPorDefecto = "Proyecto General"

    /// Instancia compartida para las vistas que no reciben el objeto por
    /// inyección. Todas las instancias leen y escriben el mismo `UserDefaults`,
    /// así que los valores siempre coinciden en disco.
    public static let compartido = AppSettings()

    // MARK: - Almacén

    private let defaults: UserDefaults

    // MARK: - Preferencias publicadas

    /// Confianza mínima del sensor aceptada al capturar: 0 baja, 1 media, 2 alta.
    @Published public var confianzaMinima: Int {
        didSet {
            let v = AppSettings.limitar(confianzaMinima, 0, 2)
            if v != confianzaMinima { confianzaMinima = v }
            defaults.set(v, forKey: Clave.confianzaMinima)
        }
    }

    /// Arista del vóxel de submuestreo, en centímetros (1…10).
    @Published public var tamanoVoxelCm: Double {
        didSet {
            let v = AppSettings.limitar(tamanoVoxelCm, 1, 10)
            if v != tamanoVoxelCm { tamanoVoxelCm = v }
            defaults.set(v, forKey: Clave.tamanoVoxelCm)
        }
    }

    /// Distancia máxima aceptada desde la cámara, en metros (1…5).
    @Published public var distanciaMaximaM: Double {
        didSet {
            let v = AppSettings.limitar(distanciaMaximaM, 1, 5)
            if v != distanciaMaximaM { distanciaMaximaM = v }
            defaults.set(v, forKey: Clave.distanciaMaximaM)
        }
    }

    /// Muestrear el color de la cámara para cada punto.
    @Published public var capturarColor: Bool {
        didSet { defaults.set(capturarColor, forKey: Clave.capturarColor) }
    }

    /// Reconstruir la malla triangular además de la nube de puntos.
    @Published public var capturarMalla: Bool {
        didSet { defaults.set(capturarMalla, forKey: Clave.capturarMalla) }
    }

    /// Anclar el escaneo al GPS y convertirlo al marco ENU al guardarlo.
    @Published public var georreferenciarAlGuardar: Bool {
        didSet { defaults.set(georreferenciarAlGuardar, forKey: Clave.georreferenciarAlGuardar) }
    }

    /// "metrico" o "imperial".
    @Published public var unidades: String {
        didSet {
            let v = AppSettings.normalizarUnidades(unidades)
            if v != unidades { unidades = v }
            defaults.set(v, forKey: Clave.unidades)
        }
    }

    /// Proyecto que se asigna a los escaneos nuevos.
    @Published public var proyectoActual: String {
        didSet { defaults.set(proyectoActual, forKey: Clave.proyectoActual) }
    }

    // MARK: - Inicialización

    public init(defaults: UserDefaults = .standard) {
        AppSettings.registrarValoresPorDefecto(en: defaults)
        self.defaults = defaults
        self.confianzaMinima = AppSettings.limitar(defaults.integer(forKey: Clave.confianzaMinima), 0, 2)
        self.tamanoVoxelCm = AppSettings.limitar(defaults.double(forKey: Clave.tamanoVoxelCm), 1, 10)
        self.distanciaMaximaM = AppSettings.limitar(defaults.double(forKey: Clave.distanciaMaximaM), 1, 5)
        self.capturarColor = defaults.bool(forKey: Clave.capturarColor)
        self.capturarMalla = defaults.bool(forKey: Clave.capturarMalla)
        self.georreferenciarAlGuardar = defaults.bool(forKey: Clave.georreferenciarAlGuardar)
        self.unidades = AppSettings.normalizarUnidades(defaults.string(forKey: Clave.unidades))
        let proyecto = defaults.string(forKey: Clave.proyectoActual) ?? AppSettings.proyectoPorDefecto
        self.proyectoActual = proyecto.isEmpty ? AppSettings.proyectoPorDefecto : proyecto
    }

    // MARK: - Utilidades públicas

    /// Verdadero si el usuario trabaja en pies en lugar de metros.
    public var esImperial: Bool { unidades == AppSettings.unidadImperial }

    /// Nombre legible de la confianza mínima configurada.
    public var nombreConfianzaMinima: String {
        switch confianzaMinima {
        case 0: return "Baja"
        case 1: return "Media"
        default: return "Alta"
        }
    }

    /// Proyecto listo para guardar (sin espacios sobrantes, nunca vacío).
    public var proyectoLimpio: String {
        let t = proyectoActual.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? AppSettings.proyectoPorDefecto : t
    }

    /// Devuelve todas las preferencias a sus valores de fábrica.
    public func restaurarValoresPorDefecto() {
        confianzaMinima = AppSettings.confianzaMinimaPorDefecto
        tamanoVoxelCm = AppSettings.tamanoVoxelCmPorDefecto
        distanciaMaximaM = AppSettings.distanciaMaximaMPorDefecto
        capturarColor = true
        capturarMalla = true
        georreferenciarAlGuardar = true
        unidades = AppSettings.unidadMetrico
        proyectoActual = AppSettings.proyectoPorDefecto
    }

    // MARK: - Lectura directa (sin instancia)

    /// Registra los valores por defecto. Es idempotente y barato.
    public static func registrarValoresPorDefecto(en defaults: UserDefaults = .standard) {
        defaults.register(defaults: [
            Clave.confianzaMinima: confianzaMinimaPorDefecto,
            Clave.tamanoVoxelCm: tamanoVoxelCmPorDefecto,
            Clave.distanciaMaximaM: distanciaMaximaMPorDefecto,
            Clave.capturarColor: true,
            Clave.capturarMalla: true,
            Clave.georreferenciarAlGuardar: true,
            Clave.unidades: unidadMetrico,
            Clave.proyectoActual: proyectoPorDefecto
        ])
    }

    /// Lee la preferencia de georreferenciación sin crear un `AppSettings`.
    /// La usa `ScanStore` al guardar, para no depender de una instancia viva.
    public static func georreferenciarAlGuardarActivo(_ defaults: UserDefaults = .standard) -> Bool {
        registrarValoresPorDefecto(en: defaults)
        return defaults.bool(forKey: Clave.georreferenciarAlGuardar)
    }

    /// Proyecto actual guardado en disco, nunca vacío.
    public static func proyectoActualGuardado(_ defaults: UserDefaults = .standard) -> String {
        registrarValoresPorDefecto(en: defaults)
        let p = (defaults.string(forKey: Clave.proyectoActual) ?? proyectoPorDefecto)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return p.isEmpty ? proyectoPorDefecto : p
    }

    /// Confianza mínima guardada en disco (0…2).
    public static func confianzaMinimaGuardada(_ defaults: UserDefaults = .standard) -> Int {
        registrarValoresPorDefecto(en: defaults)
        return limitar(defaults.integer(forKey: Clave.confianzaMinima), 0, 2)
    }

    /// Verdadero si el usuario configuró unidades imperiales.
    public static func unidadesImperiales(_ defaults: UserDefaults = .standard) -> Bool {
        registrarValoresPorDefecto(en: defaults)
        return normalizarUnidades(defaults.string(forKey: Clave.unidades)) == unidadImperial
    }

    // MARK: - Ayudas privadas

    private static func limitar(_ v: Int, _ minimo: Int, _ maximo: Int) -> Int {
        if v < minimo { return minimo }
        if v > maximo { return maximo }
        return v
    }

    private static func limitar(_ v: Double, _ minimo: Double, _ maximo: Double) -> Double {
        if !v.isFinite { return minimo }
        if v < minimo { return minimo }
        if v > maximo { return maximo }
        return v
    }

    private static func normalizarUnidades(_ valor: String?) -> String {
        valor == unidadImperial ? unidadImperial : unidadMetrico
    }
}
