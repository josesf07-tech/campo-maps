//
//  RoomCaptureCoordinator.swift
//  JoseScan
//
//  Coordinador de la sesión de RoomPlan: traduce las instrucciones del sistema
//  a mensajes en español, publica el estado de la captura y entrega el
//  `CapturedRoom` ya procesado a la interfaz.
//
//  Todo el contenido depende de RoomPlan (iOS 17+); fuera de ese contexto el
//  archivo queda vacío y `RoomCaptureScreen` muestra la pantalla explicativa.
//

import Foundation
import UIKit

#if canImport(RoomPlan)
import RoomPlan

// MARK: - Traducción de instrucciones

/// Convierte una instrucción de RoomPlan en un texto guía en español (es-CO).
@available(iOS 17.0, *)
func textoInstruccionRoomPlan(_ instruccion: RoomCaptureSession.Instruction) -> String {
    switch instruccion {
    case .moveCloseToWall:
        return "Acércate más a la pared"
    case .moveAwayFromWall:
        return "Aléjate un poco de la pared"
    case .slowDown:
        return "Muévete más despacio"
    case .turnOnLight:
        return "Necesitas más luz en el ambiente"
    case .normal:
        return "Vas bien: sigue recorriendo el interior"
    case .lowTexture:
        return "Poca textura: apunta a zonas con más detalle"
    @unknown default:
        return "Sigue recorriendo el interior con calma"
    }
}

// MARK: - Coordinador

/// Estado publicado de la captura de interiores.
///
/// Hereda de `NSObject` porque `RoomCaptureViewDelegate` refina `NSObjectProtocol`.
/// Los métodos de los delegados se declaran `nonisolated` y saltan al hilo
/// principal con `Task { @MainActor ... }` para no depender del aislamiento que
/// declare el framework.
@available(iOS 17.0, *)
@MainActor
public final class RoomCaptureCoordinator: NSObject, ObservableObject,
                                           RoomCaptureSessionDelegate,
                                           RoomCaptureViewDelegate {

    /// Texto guía que se muestra en la HUD.
    @Published public private(set) var estado: String = "Apunta a una pared y comienza a recorrer el interior"
    /// Verdadero mientras la sesión de RoomPlan está corriendo.
    @Published public private(set) var capturando: Bool = false
    /// Verdadero desde que se pide terminar hasta que llega el resultado.
    @Published public private(set) var procesando: Bool = false
    /// Habitación reconstruida y procesada por RoomPlan.
    @Published public private(set) var resultado: CapturedRoom?
    /// Último error traducido al español, si lo hubo.
    @Published public private(set) var error: String?
    /// Número de superficies detectadas hasta el momento (muros + vanos).
    @Published public private(set) var superficiesDetectadas: Int = 0
    /// Número de objetos detectados hasta el momento.
    @Published public private(set) var objetosDetectados: Int = 0

    /// Instante en que arrancó la captura, para calcular la duración.
    private var inicio: Date?
    /// Duración acumulada de la última captura, en segundos.
    public private(set) var duracionSegundos: Double = 0

    /// Vista de RoomPlan que posee la sesión (la crea `RoomCaptureViewContainer`).
    private weak var vista: RoomCaptureView?

    public override init() {
        super.init()
    }

    // MARK: Ciclo de vida

    /// Registra la vista creada por el contenedor y engancha los delegados.
    public func registrar(vista nueva: RoomCaptureView) {
        vista = nueva
        nueva.delegate = self
        nueva.captureSession.delegate = self
    }

    /// Arranca la sesión de captura con la configuración por defecto.
    public func iniciar() {
        guard let vista else {
            error = "La vista de captura todavía no está lista."
            return
        }
        guard !capturando else { return }
        error = nil
        resultado = nil
        procesando = false
        superficiesDetectadas = 0
        objetosDetectados = 0
        inicio = Date()
        duracionSegundos = 0
        capturando = true
        estado = "Apunta a una pared y comienza a recorrer el interior"
        vista.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    /// Detiene la sesión; RoomPlan procesará la habitación y avisará por el delegado.
    public func detener() {
        guard capturando else { return }
        capturando = false
        procesando = true
        estado = "Procesando el plano del interior…"
        if let inicio {
            duracionSegundos = Date().timeIntervalSince(inicio)
        }
        vista?.captureSession.stop()
    }

    /// Descarta el resultado anterior y vuelve a arrancar una captura limpia.
    public func reiniciar() {
        if capturando {
            capturando = false
            vista?.captureSession.stop()
        }
        resultado = nil
        error = nil
        procesando = false
        duracionSegundos = 0
        superficiesDetectadas = 0
        objetosDetectados = 0
        estado = "Reiniciando la captura…"
        iniciar()
    }

    /// Limpia sólo el resultado (por ejemplo al cerrar la hoja de resumen).
    public func limpiarResultado() {
        resultado = nil
        procesando = false
    }

    // MARK: Actualizaciones internas (hilo principal)

    private func actualizarEstado(_ texto: String) {
        guard capturando || procesando else { return }
        estado = texto
    }

    private func actualizarConteos(superficies: Int, objetos: Int) {
        superficiesDetectadas = superficies
        objetosDetectados = objetos
    }

    private func aplicarResultado(_ habitacion: CapturedRoom, mensaje: String?) {
        procesando = false
        capturando = false
        if let mensaje {
            error = "RoomPlan reportó un problema: \(mensaje)"
        }
        resultado = habitacion
        estado = "Plano listo: revisa el resumen"
    }

    private func aplicarError(_ mensaje: String) {
        capturando = false
        procesando = false
        error = mensaje
        estado = "La captura se interrumpió"
    }

    // MARK: - RoomCaptureSessionDelegate

    nonisolated public func captureSession(_ session: RoomCaptureSession,
                                           didProvide instruction: RoomCaptureSession.Instruction) {
        let texto = textoInstruccionRoomPlan(instruction)
        Task { @MainActor [weak self] in
            self?.actualizarEstado(texto)
        }
    }

    nonisolated public func captureSession(_ session: RoomCaptureSession,
                                           didStartWith configuration: RoomCaptureSession.Configuration) {
        Task { @MainActor [weak self] in
            self?.actualizarEstado("Captura iniciada: recorre el perímetro sin prisa")
        }
    }

    nonisolated public func captureSession(_ session: RoomCaptureSession,
                                           didUpdate room: CapturedRoom) {
        let superficies = room.walls.count + room.doors.count + room.windows.count + room.openings.count
        let objetos = room.objects.count
        Task { @MainActor [weak self] in
            self?.actualizarConteos(superficies: superficies, objetos: objetos)
        }
    }

    nonisolated public func captureSession(_ session: RoomCaptureSession,
                                           didEndWith data: CapturedRoomData,
                                           error: Error?) {
        let mensaje = error?.localizedDescription
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let mensaje {
                self.aplicarError("No se pudo terminar la captura: \(mensaje)")
            }
        }
    }

    // MARK: - RoomCaptureViewDelegate

    /// Se autoriza siempre el procesamiento posterior a la captura.
    nonisolated public func captureView(shouldPresent roomDataForProcessing: CapturedRoomData,
                                        error: Error?) -> Bool {
        return true
    }

    /// Llega la habitación ya procesada por RoomPlan.
    nonisolated public func captureView(didPresent processedResult: CapturedRoom,
                                        error: Error?) {
        let mensaje = error?.localizedDescription
        let habitacion = processedResult
        Task { @MainActor [weak self] in
            self?.aplicarResultado(habitacion, mensaje: mensaje)
        }
    }
}

#endif
