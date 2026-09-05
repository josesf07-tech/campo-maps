//
//  Georeferencer.swift
//  JoseScan
//
//  Construye el ancla geodésica (`GeoReference`) del escaneo a partir de las
//  lecturas de `LocationProvider`.
//
//  Criterios de calidad (ver docs/FORMATO-ESCANEO.md §3):
//   · se mantiene una ventana con las últimas 20 lecturas aceptadas;
//   · se descarta toda lectura con precisión horizontal peor que 30 m;
//   · se descarta toda lectura con más de 10 s de antigüedad;
//   · el rumbo se promedia de forma circular (media de senos y cosenos), nunca
//     aritmética, para no equivocarse al cruzar el norte (359° ↔ 1°).
//

import Foundation
import Combine
import CoreLocation

@MainActor public final class Georeferencer: NSObject, ObservableObject {

    // MARK: - Estado publicado

    /// Ancla fijada por `anclar()` o `promediar(muestras:)`. `nil` si aún no hay.
    @Published public private(set) var reference: GeoReference?
    /// Texto listo para la HUD, en español.
    @Published public private(set) var estado: String = "Ubicación inactiva"
    /// Precisión horizontal de la última lectura aceptada; −1 si se desconoce.
    @Published public private(set) var precisionMetros: Double = -1
    /// Rumbo verdadero actual, en grados desde el norte geográfico.
    @Published public private(set) var rumboGrados: Double = 0

    // MARK: - Parámetros de filtrado

    /// Número de lecturas conservadas en la ventana.
    public static let tamanoVentana: Int = 20
    /// Precisión horizontal máxima aceptada, en metros.
    public static let precisionMaximaMetros: Double = 30.0
    /// Antigüedad máxima aceptada de una lectura, en segundos.
    public static let antiguedadMaximaSegundos: TimeInterval = 10.0
    /// Antigüedad a partir de la cual se considera que se perdió la señal.
    public static let caducidadSenalSegundos: TimeInterval = 30.0

    // MARK: - Interno

    /// Proveedor de CoreLocation. Público para que la vista pueda consultar
    /// el estado de autorización o la disponibilidad de brújula.
    public let proveedor: LocationProvider

    /// Una lectura ya validada de la ventana.
    private struct Lectura {
        let latitud: Double
        let longitud: Double
        let altitud: Double
        let precisionHorizontal: Double
        let precisionVertical: Double
        let rumbo: Double
        let precisionRumbo: Double
        let fecha: Date
    }

    private var lecturas: [Lectura] = []
    private var precisionRumbo: Double = -1
    private var mensajeError: String?
    private var hayRumbo: Bool = false

    public override init() {
        self.proveedor = LocationProvider()
        super.init()
        conectarCallbacks()
    }

    // MARK: - Control

    /// Pide permiso de ubicación y arranca GPS + brújula.
    public func iniciar() {
        mensajeError = nil
        lecturas.removeAll()
        precisionMetros = -1
        estado = "Buscando señal GPS…"
        proveedor.iniciar()
    }

    /// Detiene GPS y brújula. El ancla ya fijada se conserva.
    public func detener() {
        proveedor.detener()
        estado = reference == nil ? "Ubicación inactiva" : "Ancla fijada (ubicación detenida)"
    }

    /// Borra el ancla fijada (no detiene la ubicación).
    public func limpiarAncla() {
        reference = nil
        actualizarEstado()
    }

    // MARK: - Anclaje

    /// Fija el ancla con la mejor lectura disponible en la ventana.
    /// - Returns: el `GeoReference` creado, o `nil` si no hay ninguna lectura
    ///   utilizable (sin permiso, sin señal o todas caducadas).
    @discardableResult
    public func anclar() -> GeoReference? {
        let vigentes = lecturasVigentes()
        guard let mejor = vigentes.min(by: { $0.precisionHorizontal < $1.precisionHorizontal }) else {
            actualizarEstado()
            return nil
        }
        let geo = construirReferencia(
            latitud: mejor.latitud,
            longitud: mejor.longitud,
            altitud: mejor.altitud,
            precisionHorizontal: mejor.precisionHorizontal,
            precisionVertical: mejor.precisionVertical,
            rumbo: mejor.rumbo,
            precisionRumbo: mejor.precisionRumbo,
            fecha: mejor.fecha)
        reference = geo
        estado = textoAncla(geo, muestras: 1)
        return geo
    }

    /// Promedia varias lecturas para mejorar la precisión del ancla.
    ///
    /// Espera hasta reunir `muestras` lecturas nuevas (o hasta agotar el tiempo
    /// máximo). La latitud y la longitud se promedian aritméticamente —válido a
    /// escala de decenas de metros— y el rumbo con media circular.
    ///
    /// - Returns: el `GeoReference` promediado, o `nil` si no llegó ninguna
    ///   lectura utilizable.
    public func promediar(muestras: Int) async -> GeoReference? {
        let objetivo = Swift.max(1, Swift.min(muestras, 60))
        if !proveedor.activo {
            proveedor.iniciar()
        }

        let inicio = Date()
        let limiteSegundos = TimeInterval(objetivo) * 2.0 + 8.0

        while true {
            let nuevas = lecturas.filter { $0.fecha >= inicio }.count
            if nuevas >= objetivo { break }
            if Date().timeIntervalSince(inicio) >= limiteSegundos { break }
            if proveedor.autorizacion == .denied || proveedor.autorizacion == .restricted { break }
            estado = "Promediando \(nuevas)/\(objetivo) lecturas…"
            try? await Task.sleep(nanoseconds: 250_000_000)
        }

        // Se usan las lecturas llegadas durante la espera; si no alcanzaron, se
        // completan con las más recientes de la ventana anterior.
        var usadas = lecturas.filter { $0.fecha >= inicio }
        if usadas.count < objetivo {
            let faltan = objetivo - usadas.count
            let previas = lecturas.filter { $0.fecha < inicio }
            usadas = Array(previas.suffix(faltan)) + usadas
        }
        if usadas.count > objetivo {
            usadas = Array(usadas.suffix(objetivo))
        }

        guard !usadas.isEmpty else {
            actualizarEstado()
            return nil
        }

        let n = Double(usadas.count)
        var sumaLat = 0.0, sumaLon = 0.0, sumaAlt = 0.0
        var sumaPrecH = 0.0, sumaPrecV = 0.0
        var sumaSen = 0.0, sumaCos = 0.0, sumaPrecRumbo = 0.0
        var conRumbo = 0.0
        var mejorPrecH = Double.greatestFiniteMagnitude

        for l in usadas {
            sumaLat += l.latitud
            sumaLon += l.longitud
            sumaAlt += l.altitud
            sumaPrecH += l.precisionHorizontal
            sumaPrecV += Swift.max(l.precisionVertical, 0)
            mejorPrecH = Swift.min(mejorPrecH, l.precisionHorizontal)
            if l.precisionRumbo >= 0 {
                let r = l.rumbo * Double.pi / 180.0
                sumaSen += sin(r)
                sumaCos += cos(r)
                sumaPrecRumbo += l.precisionRumbo
                conRumbo += 1
            }
        }

        // La media de N lecturas reduce el ruido aleatorio ~√N, pero nunca por
        // debajo de la mitad de la mejor lectura individual (el sesgo del GPS
        // no se promedia).
        let precisionPromedio = Swift.max((sumaPrecH / n) / n.squareRoot(), mejorPrecH * 0.5)

        var rumboPromedio = rumboGrados
        var precisionRumboPromedio = precisionRumbo
        if conRumbo > 0 {
            let rad = atan2(sumaSen / conRumbo, sumaCos / conRumbo)
            rumboPromedio = Georeferencer.normalizarGrados(rad * 180.0 / Double.pi)
            // El error de brújula es sistemático: se promedia sin mejora por √N.
            precisionRumboPromedio = sumaPrecRumbo / conRumbo
        }

        let geo = construirReferencia(
            latitud: sumaLat / n,
            longitud: sumaLon / n,
            altitud: sumaAlt / n,
            precisionHorizontal: precisionPromedio,
            precisionVertical: sumaPrecV / n,
            rumbo: rumboPromedio,
            precisionRumbo: precisionRumboPromedio,
            fecha: Date())

        reference = geo
        estado = textoAncla(geo, muestras: usadas.count)
        return geo
    }

    // MARK: - Consultas

    /// Verdadero si el ancla actual cumple los umbrales de `GeoReference.esConfiable`.
    public var anclaConfiable: Bool {
        return reference?.esConfiable ?? false
    }

    /// Número de lecturas válidas acumuladas en la ventana.
    public var lecturasAcumuladas: Int {
        return lecturas.count
    }

    /// Coordenadas MAGNA-SIRGAS del ancla, listas para mostrar.
    public var textoMagnaSirgas: String? {
        guard let geo = reference, let norte = geo.norte, let este = geo.este else { return nil }
        return MagnaSirgas.formatear(norte: norte, este: este)
    }

    // MARK: - Callbacks del proveedor

    private func conectarCallbacks() {
        proveedor.alRecibirUbicacion = { [weak self] ubicacion in
            Task { @MainActor in
                self?.registrar(ubicacion: ubicacion)
            }
        }
        proveedor.alRecibirRumbo = { [weak self] rumbo in
            Task { @MainActor in
                self?.registrar(rumbo: rumbo)
            }
        }
        proveedor.alCambiarAutorizacion = { [weak self] estadoAutorizacion in
            Task { @MainActor in
                guard let self = self else { return }
                if estadoAutorizacion == .authorizedAlways || estadoAutorizacion == .authorizedWhenInUse {
                    self.mensajeError = nil
                }
                self.actualizarEstado()
            }
        }
        proveedor.alFallar = { [weak self] mensaje in
            Task { @MainActor in
                guard let self = self else { return }
                self.mensajeError = mensaje
                self.actualizarEstado()
            }
        }
    }

    private func registrar(ubicacion: CLLocation) {
        let precision = ubicacion.horizontalAccuracy
        let antiguedad = Date().timeIntervalSince(ubicacion.timestamp)

        guard precision >= 0 else { return }
        guard precision <= Georeferencer.precisionMaximaMetros else {
            estado = String(format: "GPS impreciso (±%.0f m); espera a cielo abierto", precision)
            return
        }
        guard antiguedad <= Georeferencer.antiguedadMaximaSegundos else { return }

        let lectura = Lectura(latitud: ubicacion.coordinate.latitude,
                              longitud: ubicacion.coordinate.longitude,
                              altitud: ubicacion.altitude,
                              precisionHorizontal: precision,
                              precisionVertical: ubicacion.verticalAccuracy,
                              rumbo: rumboGrados,
                              precisionRumbo: hayRumbo ? precisionRumbo : -1,
                              fecha: ubicacion.timestamp)

        lecturas.append(lectura)
        if lecturas.count > Georeferencer.tamanoVentana {
            lecturas.removeFirst(lecturas.count - Georeferencer.tamanoVentana)
        }

        precisionMetros = precision
        mensajeError = nil
        actualizarEstado()
    }

    private func registrar(rumbo: CLHeading) {
        let valor = rumbo.trueHeading >= 0 ? rumbo.trueHeading : rumbo.magneticHeading
        guard valor >= 0 else { return }
        rumboGrados = Georeferencer.normalizarGrados(valor)
        precisionRumbo = rumbo.headingAccuracy
        hayRumbo = true
        actualizarEstado()
    }

    // MARK: - Construcción del ancla

    private func construirReferencia(latitud: Double,
                                     longitud: Double,
                                     altitud: Double,
                                     precisionHorizontal: Double,
                                     precisionVertical: Double,
                                     rumbo: Double,
                                     precisionRumbo: Double,
                                     fecha: Date) -> GeoReference {
        let magna = MagnaSirgas.desdeWGS84(lat: latitud, lon: longitud)
        return GeoReference(latitude: latitud,
                            longitude: longitud,
                            altitude: altitud,
                            horizontalAccuracy: precisionHorizontal,
                            verticalAccuracy: precisionVertical,
                            heading: Georeferencer.normalizarGrados(rumbo),
                            headingAccuracy: precisionRumbo,
                            timestamp: fecha,
                            norte: magna.norte,
                            este: magna.este)
    }

    /// Lecturas todavía útiles para anclar (no caducadas).
    private func lecturasVigentes() -> [Lectura] {
        let ahora = Date()
        return lecturas.filter { ahora.timeIntervalSince($0.fecha) <= Georeferencer.caducidadSenalSegundos }
    }

    // MARK: - Textos para la HUD

    private func actualizarEstado() {
        if proveedor.autorizacion == .denied {
            estado = "Permiso de ubicación denegado"
            return
        }
        if proveedor.autorizacion == .restricted {
            estado = "Ubicación restringida en este dispositivo"
            return
        }
        guard let ultima = lecturasVigentes().last else {
            if let error = mensajeError {
                estado = error
            } else if proveedor.autorizacion == .notDetermined {
                estado = "Esperando permiso de ubicación…"
            } else {
                estado = "Sin señal GPS"
            }
            return
        }
        estado = textoGPS(precision: ultima.precisionHorizontal)
    }

    /// Ejemplo: `GPS ±3.2 m · rumbo 172° (±8°)`.
    private func textoGPS(precision: Double) -> String {
        var texto = String(format: "GPS ±%.1f m", precision)
        if !proveedor.brujulaDisponible {
            texto += " · sin brújula"
        } else if hayRumbo && precisionRumbo >= 0 {
            texto += String(format: " · rumbo %.0f° (±%.0f°)", rumboGrados, precisionRumbo)
        } else if hayRumbo {
            texto += String(format: " · rumbo %.0f° (sin calibrar)", rumboGrados)
        } else {
            texto += " · calibrando brújula…"
        }
        return texto
    }

    private func textoAncla(_ geo: GeoReference, muestras: Int) -> String {
        var texto = String(format: "Ancla fijada ±%.1f m", geo.horizontalAccuracy)
        if muestras > 1 {
            texto += " (\(muestras) lecturas)"
        }
        if geo.headingAccuracy >= 0 {
            texto += String(format: " · rumbo %.0f° (±%.0f°)", geo.heading, geo.headingAccuracy)
        } else {
            texto += String(format: " · rumbo %.0f°", geo.heading)
        }
        return texto
    }

    // MARK: - Utilidades

    /// Lleva un ángulo a [0, 360).
    internal static func normalizarGrados(_ grados: Double) -> Double {
        var g = grados.truncatingRemainder(dividingBy: 360.0)
        if g < 0 { g += 360.0 }
        return g
    }
}
