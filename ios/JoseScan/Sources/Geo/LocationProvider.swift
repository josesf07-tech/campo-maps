//
//  LocationProvider.swift
//  JoseScan
//
//  Envoltura delgada de CLLocationManager: publica la última ubicación y el
//  último rumbo, expone el estado de autorización y traduce los errores de
//  CoreLocation a mensajes en español (es-CO).
//
//  Todas las propiedades publicadas se actualizan en el hilo principal, así que
//  pueden observarse directamente desde SwiftUI. Además de `@Published`, la
//  clase ofrece callbacks (`alRecibirUbicacion`, `alRecibirRumbo`, …) para que
//  `Georeferencer` pueda acumular lecturas sin depender de Combine.
//
//  Requiere en Info.plist:
//    NSLocationWhenInUseUsageDescription
//  y, si se quiere precisión completa cuando el usuario concede precisión
//  reducida, NSLocationTemporaryUsageDescriptionDictionary.
//

import Foundation
import Combine
import CoreLocation

public final class LocationProvider: NSObject, ObservableObject, CLLocationManagerDelegate {

    // MARK: - Estado publicado

    /// Última ubicación válida recibida (sin filtrar por precisión).
    @Published public private(set) var ubicacion: CLLocation?
    /// Último rumbo recibido. Es `nil` si el dispositivo no tiene brújula.
    @Published public private(set) var rumbo: CLHeading?
    /// Estado de autorización actual.
    @Published public private(set) var autorizacion: CLAuthorizationStatus = .notDetermined
    /// Último error traducido al español, o `nil` si todo va bien.
    @Published public private(set) var ultimoError: String?
    /// Verdadero mientras el proveedor está entregando actualizaciones.
    @Published public private(set) var activo: Bool = false
    /// Verdadero si el dispositivo puede entregar rumbo (brújula disponible).
    @Published public private(set) var brujulaDisponible: Bool = false

    // MARK: - Callbacks

    /// Se invoca en el hilo principal con cada ubicación nueva.
    public var alRecibirUbicacion: ((CLLocation) -> Void)?
    /// Se invoca en el hilo principal con cada rumbo nuevo.
    public var alRecibirRumbo: ((CLHeading) -> Void)?
    /// Se invoca cuando cambia la autorización de ubicación.
    public var alCambiarAutorizacion: ((CLAuthorizationStatus) -> Void)?
    /// Se invoca con el mensaje en español de cada fallo.
    public var alFallar: ((String) -> Void)?

    // MARK: - Interno

    private let gestor = CLLocationManager()

    public override init() {
        super.init()
        gestor.delegate = self
        gestor.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        gestor.distanceFilter = kCLDistanceFilterNone
        gestor.headingFilter = 1.0
        gestor.headingOrientation = .portrait
        gestor.pausesLocationUpdatesAutomatically = false
        autorizacion = gestor.authorizationStatus
        brujulaDisponible = CLLocationManager.headingAvailable()
    }

    deinit {
        gestor.stopUpdatingLocation()
        gestor.stopUpdatingHeading()
    }

    // MARK: - Control

    /// Pide permiso (si hace falta) y arranca ubicación y brújula.
    public func iniciar() {
        ultimoError = nil
        brujulaDisponible = CLLocationManager.headingAvailable()

        let estado = gestor.authorizationStatus
        autorizacion = estado

        switch estado {
        case .notDetermined:
            gestor.requestWhenInUseAuthorization()
            // Se arranca igualmente: CoreLocation entrega los datos en cuanto
            // el usuario concede el permiso.
        case .denied:
            reportar("Permiso de ubicación denegado. Actívalo en Ajustes › Privacidad › Localización.")
        case .restricted:
            reportar("El acceso a la ubicación está restringido en este dispositivo.")
        default:
            break
        }

        gestor.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            gestor.startUpdatingHeading()
        } else {
            reportar("Este dispositivo no tiene brújula; el rumbo deberá indicarse a mano.")
        }
        activo = true
    }

    /// Detiene ubicación y brújula.
    public func detener() {
        gestor.stopUpdatingLocation()
        gestor.stopUpdatingHeading()
        activo = false
    }

    /// Solicita una única actualización de ubicación (ahorra batería).
    public func solicitarUnaLectura() {
        gestor.requestLocation()
    }

    // MARK: - Consultas

    /// Verdadero si hay permiso para usar la ubicación.
    public var estaAutorizado: Bool {
        return autorizacion == .authorizedWhenInUse || autorizacion == .authorizedAlways
    }

    /// Verdadero si el usuario concedió sólo precisión reducida (~1…3 km).
    public var precisionReducida: Bool {
        return gestor.accuracyAuthorization == .reducedAccuracy
    }

    /// Precisión horizontal de la última lectura, o −1 si se desconoce.
    public var precisionHorizontal: Double {
        guard let u = ubicacion, u.horizontalAccuracy >= 0 else { return -1 }
        return u.horizontalAccuracy
    }

    /// Rumbo verdadero en grados, o `nil` si no hay lectura confiable.
    /// Si el rumbo verdadero no está disponible (sin calibrar o sin GPS) se
    /// devuelve el magnético como respaldo.
    public var rumboVerdadero: Double? {
        guard let h = rumbo else { return nil }
        if h.trueHeading >= 0 { return h.trueHeading }
        if h.magneticHeading >= 0 { return h.magneticHeading }
        return nil
    }

    /// Texto en español del estado de autorización.
    public var textoAutorizacion: String {
        switch autorizacion {
        case .notDetermined: return "Permiso de ubicación pendiente"
        case .restricted: return "Ubicación restringida"
        case .denied: return "Permiso de ubicación denegado"
        case .authorizedAlways: return "Ubicación autorizada (siempre)"
        case .authorizedWhenInUse: return "Ubicación autorizada"
        default: return "Estado de ubicación desconocido"
        }
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let ultima = locations.last else { return }
        enPrincipal { [weak self] in
            guard let self = self else { return }
            self.ubicacion = ultima
            self.ultimoError = nil
            self.alRecibirUbicacion?(ultima)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        // headingAccuracy negativo = lectura no confiable (brújula sin calibrar).
        enPrincipal { [weak self] in
            guard let self = self else { return }
            self.rumbo = newHeading
            self.alRecibirRumbo?(newHeading)
        }
    }

    public func locationManagerShouldDisplayHeadingCalibration(_ manager: CLLocationManager) -> Bool {
        // Deja que el sistema muestre el aro de calibración cuando haga falta.
        return true
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let mensaje = LocationProvider.mensajeEnEspanol(para: error)
        enPrincipal { [weak self] in
            self?.reportar(mensaje)
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let estado = manager.authorizationStatus
        enPrincipal { [weak self] in
            guard let self = self else { return }
            self.autorizacion = estado
            switch estado {
            case .denied:
                self.reportar("Permiso de ubicación denegado. Actívalo en Ajustes › Privacidad › Localización.")
            case .restricted:
                self.reportar("El acceso a la ubicación está restringido en este dispositivo.")
            case .authorizedAlways, .authorizedWhenInUse:
                self.ultimoError = nil
                if self.activo {
                    self.gestor.startUpdatingLocation()
                    if CLLocationManager.headingAvailable() {
                        self.gestor.startUpdatingHeading()
                    }
                }
            default:
                break
            }
            self.alCambiarAutorizacion?(estado)
        }
    }

    // MARK: - Traducción de errores

    /// Convierte un error de CoreLocation en un mensaje para el usuario.
    public static func mensajeEnEspanol(para error: Error) -> String {
        guard let clError = error as? CLError else {
            return "Error de ubicación: \(error.localizedDescription)"
        }
        switch clError.code {
        case .locationUnknown:
            return "Sin señal GPS por ahora; sal a cielo abierto y espera unos segundos."
        case .denied:
            return "Permiso de ubicación denegado. Actívalo en Ajustes › Privacidad › Localización."
        case .network:
            return "Error de red al ubicar el dispositivo."
        case .headingFailure:
            return "La brújula está interferida; aléjate de metales o imanes y calíbrala."
        case .deferredFailed, .deferredNotUpdatingLocation, .deferredAccuracyTooLow, .deferredDistanceFiltered:
            return "No se pudieron aplazar las actualizaciones de ubicación."
        case .rangingUnavailable, .rangingFailure:
            return "El posicionamiento por proximidad no está disponible."
        default:
            return "Error de ubicación (código \(clError.code.rawValue))."
        }
    }

    // MARK: - Utilidades

    private func reportar(_ mensaje: String) {
        ultimoError = mensaje
        alFallar?(mensaje)
    }

    /// Ejecuta el bloque en el hilo principal sin volver a encolar si ya lo está.
    private func enPrincipal(_ bloque: @escaping () -> Void) {
        if Thread.isMainThread {
            bloque()
        } else {
            DispatchQueue.main.async(execute: bloque)
        }
    }
}
