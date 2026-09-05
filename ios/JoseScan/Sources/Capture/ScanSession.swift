//
//  ScanSession.swift
//  JoseScan
//
//  Motor de captura LiDAR: envuelve la ARSession, acumula la nube de puntos y
//  la malla, y publica estado, mensajes y métricas para la HUD.
//
//  Arquitectura de hilos:
//    · `ScanSession` vive en el hilo principal (@MainActor) y sólo publica.
//    · `MotorCapturaAR` es el delegado de ARKit y trabaja íntegramente en la
//      cola serial `captura`, donde también viven el extractor de profundidad,
//      el submuestreador de vóxeles y el acumulador de malla.
//    · La comunicación motor -> sesión va por cierres que saltan al hilo
//      principal; la comunicación sesión -> motor va por `async`/`sync` sobre
//      la misma cola serial, así que nunca hay acceso concurrente al estado.
//

import Foundation

#if canImport(ARKit)
import ARKit
import UIKit
import CoreImage
import simd
#endif

/// Estado del ciclo de vida de un escaneo.
public enum EstadoEscaneo: String, CaseIterable, Codable {
    case inactivo, preparando, capturando, pausado, finalizado

    /// Texto para mostrar en la interfaz (es-CO).
    public var titulo: String {
        switch self {
        case .inactivo: return "Sin iniciar"
        case .preparando: return "Preparando"
        case .capturando: return "Capturando"
        case .pausado: return "En pausa"
        case .finalizado: return "Finalizado"
        }
    }

    /// Verdadero si la sesión de ARKit está corriendo.
    public var activo: Bool {
        self == .preparando || self == .capturando
    }
}

#if canImport(ARKit)

// MARK: - Sesión de escaneo

@MainActor public final class ScanSession: NSObject, ObservableObject {

    // MARK: Estado publicado

    @Published public private(set) var estado: EstadoEscaneo = .inactivo
    @Published public private(set) var metrics: ScanQualityMetrics = ScanQualityMetrics()
    @Published public private(set) var mensaje: String = "Listo para escanear."

    /// Ajustes del escaneo. Al cambiarlos se propagan al motor en caliente; si
    /// se activa o desactiva la malla, se relanza la configuración de ARKit.
    @Published public var configuration: ScanConfiguration = .porDefecto {
        didSet { aplicarConfiguracion(anterior: oldValue) }
    }

    /// Sesión de ARKit compartida con la capa de render.
    public let session: ARSession = ARSession()

    // MARK: Internos

    private let cola = DispatchQueue(label: "co.josemaps.josescan.captura", qos: .userInitiated)
    private let motor: MotorCapturaAR
    private var inicioTramo: Date?
    private var acumuladoSegundos: TimeInterval = 0
    private var anclaGeo: GeoReference?
    private var estabaCapturandoAlInterrumpir = false
    private lazy var contextoImagen: CIContext = CIContext(options: nil)

    // MARK: Disponibilidad

    /// Verdadero si el dispositivo puede reconstruir la escena con LiDAR.
    nonisolated public static var lidarDisponible: Bool {
        ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    /// Verdadero si ARKit puede entregar mapa de profundidad denso.
    nonisolated public static var profundidadDisponible: Bool {
        ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    // MARK: Ciclo de vida

    public override init() {
        motor = MotorCapturaAR(configuracion: ScanConfiguration.porDefecto)
        super.init()
        session.delegateQueue = cola
        session.delegate = motor
        conectarMotor()
        if !ScanSession.lidarDisponible {
            mensaje = ScanError.sensorNoDisponible.errorDescription ?? "Sensor no disponible."
        } else {
            mensaje = "Listo para escanear. Pulsa iniciar."
        }
    }

    private func conectarMotor() {
        motor.alActualizarMetricas = { [weak self] m in
            Task { @MainActor in self?.recibir(metricas: m) }
        }
        motor.alCambiarSeguimiento = { [weak self] texto, ok in
            Task { @MainActor in self?.recibirSeguimiento(texto: texto, correcto: ok) }
        }
        motor.alRecibirPrimerFrame = { [weak self] in
            Task { @MainActor in self?.recibirPrimerFrame() }
        }
        motor.alFallar = { [weak self] texto in
            Task { @MainActor in self?.recibirError(texto) }
        }
        motor.alInterrumpir = { [weak self] interrumpida in
            Task { @MainActor in self?.recibirInterrupcion(interrumpida) }
        }
    }

    // MARK: - Control del escaneo

    /// Arranca la ARSession con reconstrucción de escena y profundidad.
    /// Si el dispositivo no es apto publica el error en `mensaje` y no lanza.
    public func iniciar() {
        guard estado != .capturando && estado != .preparando else { return }
        guard ARWorldTrackingConfiguration.isSupported else {
            estado = .inactivo
            mensaje = ScanError.sensorNoDisponible.errorDescription ?? "ARKit no está disponible."
            return
        }
        guard ScanSession.lidarDisponible else {
            estado = .inactivo
            mensaje = "Este dispositivo no tiene sensor LiDAR: no se puede escanear en 3D."
            return
        }

        let cfg = configuration.saneada()
        anclaGeo = nil
        acumuladoSegundos = 0
        inicioTramo = Date()
        metrics = ScanQualityMetrics()
        estado = .preparando
        mensaje = "Inicializando… mueve el dispositivo despacio."

        cola.async { [motor] in
            motor.configurar(cfg)
            motor.reiniciarDatos()
            motor.comenzar()
        }
        session.run(configuracionAR(con: cfg), options: [.resetTracking, .removeExistingAnchors])
    }

    /// Detiene temporalmente la captura conservando lo acumulado.
    public func pausar() {
        guard estado == .capturando || estado == .preparando else { return }
        acumularTiempo()
        cola.async { [motor] in motor.pausar() }
        session.pause()
        estado = .pausado
        mensaje = "Escaneo en pausa."
    }

    /// Reanuda la captura tras una pausa.
    public func reanudar() {
        guard estado == .pausado else { return }
        let cfg = configuration.saneada()
        inicioTramo = Date()
        cola.async { [motor] in
            motor.configurar(cfg)
            motor.comenzar()
        }
        session.run(configuracionAR(con: cfg))
        estado = .capturando
        mensaje = "Reanudando… apunta a una zona ya escaneada."
    }

    /// Borra todo lo capturado y vuelve a empezar de cero.
    public func reiniciar() {
        let cfg = configuration.saneada()
        anclaGeo = nil
        acumuladoSegundos = 0
        inicioTramo = Date()
        metrics = ScanQualityMetrics()
        estado = .preparando
        mensaje = "Escaneo reiniciado. Inicializando…"

        cola.async { [motor] in
            motor.configurar(cfg)
            motor.reiniciarDatos()
            motor.comenzar()
        }
        session.run(configuracionAR(con: cfg), options: [.resetTracking, .removeExistingAnchors])
    }

    /// Cierra el escaneo, consolida nube y malla y devuelve el documento listo
    /// para guardar o exportar.
    @discardableResult
    public func detener() -> ScanDocument {
        acumularTiempo()

        var nube = PointCloud()
        var malla = ScanMesh()
        cola.sync { [motor] in
            motor.pausar()
            nube = motor.nube()
            malla = motor.mallaUnificada()
        }
        session.pause()
        estado = .finalizado

        let metadatos = ScanMetadata(nombre: ScanSession.nombrePorDefecto(),
                                     creado: Date(),
                                     dispositivo: ScanSession.modeloDispositivo(),
                                     sistema: ScanSession.versionSistema(),
                                     sensor: "lidar",
                                     marco: .arkit,
                                     geo: anclaGeo,
                                     duracionSegundos: acumuladoSegundos)
        let documento = ScanDocument(metadata: metadatos, cloud: nube, mesh: malla)
        documento.refreshMetadata()

        var finales = metrics
        finales.pointCount = nube.count
        finales.triangleCount = malla.triangleCount
        metrics = finales
        mensaje = documento.isEmpty
            ? "El escaneo quedó vacío. Intenta de nuevo acercándote más."
            : "Escaneo finalizado: \(nube.count) puntos y \(malla.triangleCount) triángulos."
        return documento
    }

    /// Guarda el ancla geodésica que aporta el módulo Geo. Pasar `nil` la borra.
    public func anclarGeo(_ ref: GeoReference?) {
        anclaGeo = ref
        if let ref = ref {
            mensaje = ref.esConfiable
                ? "Ancla GPS registrada (±\(String(format: "%.1f", ref.horizontalAccuracy)) m)."
                : "Ancla GPS registrada con precisión baja; revísala antes de exportar."
        }
    }

    /// Ancla geodésica vigente, si el módulo Geo ya la aportó.
    public var georreferencia: GeoReference? { anclaGeo }

    /// Duración acumulada de captura en segundos (sin contar las pausas).
    public var duracionSegundos: TimeInterval {
        acumuladoSegundos + tramoEnCurso()
    }

    // MARK: - Datos en vivo

    /// Nube submuestreada acumulada hasta el momento.
    public var nubeActual: PointCloud {
        var salida = PointCloud()
        cola.sync { [motor] in salida = motor.nube() }
        return salida
    }

    /// Malla unificada en coordenadas mundo hasta el momento.
    public var mallaActual: ScanMesh {
        var salida = ScanMesh()
        cola.sync { [motor] in salida = motor.mallaUnificada() }
        return salida
    }

    /// Frame actual de la cámara convertido a imagen, con la orientación del
    /// dispositivo aplicada. Devuelve nil si aún no hay frames.
    public func capturarMiniatura() -> UIImage? {
        guard let frame = session.currentFrame else { return nil }
        let imagen = CIImage(cvPixelBuffer: frame.capturedImage)
        guard let cg = contextoImagen.createCGImage(imagen, from: imagen.extent) else { return nil }
        return UIImage(cgImage: cg, scale: 1, orientation: ScanSession.orientacionImagen())
    }

    // MARK: - Configuración de ARKit

    /// Arma la `ARWorldTrackingConfiguration` según los ajustes y lo que
    /// realmente soporte el dispositivo.
    private func configuracionAR(con cfg: ScanConfiguration) -> ARWorldTrackingConfiguration {
        let configuracion = ARWorldTrackingConfiguration()
        configuracion.worldAlignment = .gravity
        configuracion.planeDetection = [.horizontal, .vertical]
        configuracion.environmentTexturing = .automatic
        configuracion.isAutoFocusEnabled = true
        configuracion.isLightEstimationEnabled = true

        if cfg.capturarMalla {
            if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
                configuracion.sceneReconstruction = .meshWithClassification
            } else if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
                configuracion.sceneReconstruction = .mesh
            }
        }

        var semantica: ARConfiguration.FrameSemantics = []
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            semantica.insert(.sceneDepth)
        }
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            semantica.insert(.smoothedSceneDepth)
        }
        if !semantica.isEmpty {
            configuracion.frameSemantics = semantica
        }
        return configuracion
    }

    private func aplicarConfiguracion(anterior: ScanConfiguration) {
        let nueva = configuration.saneada()
        cola.async { [motor] in motor.configurar(nueva) }
        if nueva.requiereReinicioAR(respectoA: anterior.saneada()), estado.activo {
            session.run(configuracionAR(con: nueva))
        }
    }

    // MARK: - Recepción de eventos del motor

    private func recibir(metricas nuevas: ScanQualityMetrics) {
        var copia = nuevas
        copia.thermalWarning = ScanSession.avisoTermico()
        metrics = copia
    }

    private func recibirPrimerFrame() {
        if estado == .preparando {
            estado = .capturando
            mensaje = "Escaneando. Muévete despacio y cubre la superficie completa."
        }
    }

    private func recibirSeguimiento(texto: String, correcto: Bool) {
        mensaje = texto
        var copia = metrics
        copia.trackingOK = correcto
        copia.trackingMessage = texto
        metrics = copia
    }

    private func recibirError(_ texto: String) {
        mensaje = texto
        if estado.activo {
            acumularTiempo()
            estado = .pausado
        }
    }

    private func recibirInterrupcion(_ interrumpida: Bool) {
        if interrumpida {
            estabaCapturandoAlInterrumpir = estado.activo
            if estado.activo {
                acumularTiempo()
                cola.async { [motor] in motor.pausar() }
                estado = .pausado
            }
            mensaje = "Escaneo interrumpido: la cámara dejó de estar disponible."
        } else {
            mensaje = "Cámara disponible otra vez. Apunta a una zona ya escaneada."
            if estabaCapturandoAlInterrumpir {
                estabaCapturandoAlInterrumpir = false
                reanudar()
            }
        }
    }

    // MARK: - Tiempo

    private func tramoEnCurso() -> TimeInterval {
        guard estado.activo, let inicio = inicioTramo else { return 0 }
        return Swift.max(0, Date().timeIntervalSince(inicio))
    }

    private func acumularTiempo() {
        if let inicio = inicioTramo {
            acumuladoSegundos += Swift.max(0, Date().timeIntervalSince(inicio))
        }
        inicioTramo = nil
    }

    // MARK: - Utilidades del dispositivo

    /// Aviso térmico en español, o nil si la temperatura es normal.
    nonisolated public static func avisoTermico() -> String? {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal, .fair:
            return nil
        case .serious:
            return "El dispositivo se está calentando: la captura puede ralentizarse."
        case .critical:
            return "Temperatura crítica: guarda el escaneo y deja enfriar el dispositivo."
        @unknown default:
            return nil
        }
    }

    /// Nombre comercial del dispositivo (o el identificador crudo si no está en
    /// la tabla), leído del kernel con `uname`.
    nonisolated public static func modeloDispositivo() -> String {
        var info = utsname()
        uname(&info)
        var identificador = withUnsafePointer(to: &info.machine) { puntero -> String in
            puntero.withMemoryRebound(to: CChar.self,
                                      capacity: MemoryLayout.size(ofValue: info.machine)) { cadena in
                String(cString: cadena)
            }
        }
        // En el simulador `machine` es la arquitectura del Mac anfitrión.
        if identificador == "x86_64" || identificador == "arm64" || identificador == "i386" {
            if let simulado = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
                identificador = simulado
            }
        }
        return nombreComercial(identificador)
    }

    /// Sistema operativo en el formato del contrato: "iOS 18.2".
    nonisolated public static func versionSistema() -> String {
        let dispositivo = UIDevice.current
        return "\(dispositivo.systemName) \(dispositivo.systemVersion)"
    }

    /// Nombre por defecto del escaneo: "Escaneo aaaa-MM-dd HH:mm".
    nonisolated public static func nombrePorDefecto(_ fecha: Date = Date()) -> String {
        let formato = DateFormatter()
        formato.locale = Locale(identifier: "es_CO")
        formato.dateFormat = "yyyy-MM-dd HH:mm"
        return "Escaneo \(formato.string(from: fecha))"
    }

    /// Orientación con la que hay que presentar `capturedImage`, que ARKit
    /// entrega siempre en horizontal con el botón de inicio a la derecha.
    nonisolated private static func orientacionImagen() -> UIImage.Orientation {
        switch UIDevice.current.orientation {
        case .portrait: return .right
        case .portraitUpsideDown: return .left
        case .landscapeLeft: return .up
        case .landscapeRight: return .down
        default: return .right
        }
    }

    /// Tabla de modelos con LiDAR; para el resto se devuelve el identificador.
    nonisolated private static func nombreComercial(_ id: String) -> String {
        switch id {
        case "iPhone13,2": return "iPhone 12"
        case "iPhone13,3": return "iPhone 12 Pro"
        case "iPhone13,4": return "iPhone 12 Pro Max"
        case "iPhone14,2": return "iPhone 13 Pro"
        case "iPhone14,3": return "iPhone 13 Pro Max"
        case "iPhone15,2": return "iPhone 14 Pro"
        case "iPhone15,3": return "iPhone 14 Pro Max"
        case "iPhone16,1": return "iPhone 15 Pro"
        case "iPhone16,2": return "iPhone 15 Pro Max"
        case "iPhone17,1": return "iPhone 16 Pro"
        case "iPhone17,2": return "iPhone 16 Pro Max"
        case "iPad8,9", "iPad8,10": return "iPad Pro 11 (2.ª gen)"
        case "iPad8,11", "iPad8,12": return "iPad Pro 12.9 (4.ª gen)"
        case "iPad13,4", "iPad13,5", "iPad13,6", "iPad13,7": return "iPad Pro 11 (3.ª gen)"
        case "iPad13,8", "iPad13,9", "iPad13,10", "iPad13,11": return "iPad Pro 12.9 (5.ª gen)"
        case "iPad14,3", "iPad14,4": return "iPad Pro 11 (4.ª gen)"
        case "iPad14,5", "iPad14,6": return "iPad Pro 12.9 (6.ª gen)"
        case "iPad16,3", "iPad16,4": return "iPad Pro 11 (M4)"
        case "iPad16,5", "iPad16,6": return "iPad Pro 13 (M4)"
        default: return id
        }
    }
}

// MARK: - Motor: delegado de ARKit confinado a la cola de captura

/// Todo el estado de esta clase se toca únicamente en la cola serial que se
/// asigna a `ARSession.delegateQueue`, así que no necesita cerrojos.
final class MotorCapturaAR: NSObject, ARSessionDelegate {

    private let extractor = DepthPointExtractor()
    private let acumuladorMalla = MeshAccumulator()
    private let submuestreador: VoxelDownsampler
    private var configuracion: ScanConfiguration

    private var capturando = false
    private var primerFrameVisto = false
    private var ultimaExtraccion: TimeInterval = 0
    private var ultimaMetrica: TimeInterval = 0
    private var inicioVentanaFPS: TimeInterval = 0
    private var framesVentana = 0
    private var fps: Double = 0
    private var seguimientoOK = true
    private var mensajeSeguimiento = "Inicializando…"

    /// Métricas listas para la HUD (máximo 4 veces por segundo).
    var alActualizarMetricas: ((ScanQualityMetrics) -> Void)?
    /// Cambio de calidad de seguimiento: texto en español y si está OK.
    var alCambiarSeguimiento: ((String, Bool) -> Void)?
    /// Primer frame recibido tras arrancar la sesión.
    var alRecibirPrimerFrame: (() -> Void)?
    /// Error irrecuperable de ARKit, ya traducido.
    var alFallar: ((String) -> Void)?
    /// Interrupción de la sesión (true) y su fin (false).
    var alInterrumpir: ((Bool) -> Void)?

    init(configuracion: ScanConfiguration) {
        let saneada = configuracion.saneada()
        self.configuracion = saneada
        self.submuestreador = VoxelDownsampler(tamanoVoxel: saneada.tamanoVoxel,
                                               maxPuntos: saneada.maxPuntos)
        super.init()
    }

    // MARK: Control (llamado desde la cola de captura)

    func configurar(_ nueva: ScanConfiguration) {
        configuracion = nueva.saneada()
        submuestreador.aplicar(configuracion)
        if !configuracion.capturarMalla {
            acumuladorMalla.reiniciar()
        }
    }

    func comenzar() {
        capturando = true
        primerFrameVisto = false
        ultimaExtraccion = 0
        ultimaMetrica = 0
        inicioVentanaFPS = 0
        framesVentana = 0
    }

    func pausar() {
        capturando = false
    }

    func reiniciarDatos() {
        submuestreador.reiniciar()
        acumuladorMalla.reiniciar()
        fps = 0
        seguimientoOK = true
        mensajeSeguimiento = "Inicializando…"
    }

    func nube() -> PointCloud {
        submuestreador.nube()
    }

    func mallaUnificada() -> ScanMesh {
        acumuladorMalla.malla()
    }

    func metricas() -> ScanQualityMetrics {
        var m = ScanQualityMetrics()
        m.pointCount = submuestreador.count
        m.triangleCount = acumuladorMalla.conteoTriangulos
        m.highConfidenceRatio = submuestreador.proporcionAltaConfianza
        m.coveredArea = acumuladorMalla.areaSuperficie
        m.trackingOK = seguimientoOK
        m.trackingMessage = mensajeSeguimiento
        m.fps = fps
        return m
    }

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let ahora = frame.timestamp

        // Framerate real de ARKit, promediado en ventanas de un segundo.
        if inicioVentanaFPS == 0 { inicioVentanaFPS = ahora }
        framesVentana += 1
        let ventana = ahora - inicioVentanaFPS
        if ventana >= 1.0 {
            fps = Double(framesVentana) / ventana
            framesVentana = 0
            inicioVentanaFPS = ahora
        }

        if !primerFrameVisto {
            primerFrameVisto = true
            alRecibirPrimerFrame?()
        }

        guard capturando else { return }

        // Extracción de puntos a la cadencia pedida, no a la de render.
        if configuracion.capturarNube {
            let intervalo = configuracion.intervaloCaptura
            if ultimaExtraccion == 0 || ahora - ultimaExtraccion >= intervalo {
                ultimaExtraccion = ahora
                let nuevos = extractor.extraer(desde: frame, configuracion: configuracion)
                if !nuevos.isEmpty {
                    submuestreador.insertar(nuevos)
                }
            }
        }

        // La HUD se refresca como mucho 4 veces por segundo.
        if ultimaMetrica == 0 || ahora - ultimaMetrica >= 0.25 {
            ultimaMetrica = ahora
            alActualizarMetricas?(metricas())
        }
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        registrar(anchors)
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        registrar(anchors)
    }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for anchor in anchors {
            if let malla = anchor as? ARMeshAnchor {
                acumuladorMalla.eliminar(malla)
            }
        }
    }

    private func registrar(_ anchors: [ARAnchor]) {
        guard capturando, configuracion.capturarMalla else { return }
        for anchor in anchors {
            if let malla = anchor as? ARMeshAnchor {
                acumuladorMalla.actualizar(malla)
            }
        }
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let resultado = MotorCapturaAR.describir(camera.trackingState)
        mensajeSeguimiento = resultado.texto
        seguimientoOK = resultado.correcto
        alCambiarSeguimiento?(resultado.texto, resultado.correcto)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        capturando = false
        alFallar?(MotorCapturaAR.describir(error))
    }

    func sessionWasInterrupted(_ session: ARSession) {
        capturando = false
        alInterrumpir?(true)
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        alInterrumpir?(false)
    }

    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool {
        true
    }

    // MARK: Traducciones

    /// Traduce el estado de seguimiento a un mensaje guía en español.
    static func describir(_ estado: ARCamera.TrackingState) -> (texto: String, correcto: Bool) {
        switch estado {
        case .notAvailable:
            return ("Inicializando…", false)
        case .normal:
            return ("Seguimiento correcto. Escanea con movimientos lentos.", true)
        case .limited(let razon):
            switch razon {
            case .initializing:
                return ("Inicializando… mueve el dispositivo despacio.", false)
            case .excessiveMotion:
                return ("Mueve el dispositivo más despacio", false)
            case .insufficientFeatures:
                return ("Necesitas más luz o una superficie con más textura", false)
            case .relocalizing:
                return ("Recuperando la posición… vuelve a una zona ya escaneada.", false)
            @unknown default:
                return ("Seguimiento limitado. Mueve el dispositivo despacio.", false)
            }
        }
    }

    /// Traduce los errores de ARKit a mensajes accionables en español.
    static func describir(_ error: Error) -> String {
        let ns = error as NSError
        guard ns.domain == ARErrorDomain, let codigo = ARError.Code(rawValue: ns.code) else {
            return "Error de la sesión de realidad aumentada: \(error.localizedDescription)"
        }
        switch codigo {
        case .cameraUnauthorized:
            return "Permiso de cámara denegado. Actívalo en Ajustes para poder escanear."
        case .unsupportedConfiguration:
            return "Este dispositivo no soporta la configuración de escaneo solicitada."
        case .sensorUnavailable:
            return "Los sensores no están disponibles. Cierra otras apps que usen la cámara."
        case .sensorFailed:
            return "Fallo de los sensores. Sal a un sitio con mejor luz e inténtalo de nuevo."
        case .worldTrackingFailed:
            return "Se perdió el seguimiento del mundo. Reinicia el escaneo."
        case .insufficientFeatures:
            return "No hay suficientes detalles en la escena. Busca superficies con textura."
        case .invalidReferenceImage, .invalidReferenceObject, .invalidConfiguration:
            return "Configuración de escaneo inválida."
        default:
            return "Error de la sesión de realidad aumentada: \(ns.localizedDescription)"
        }
    }
}

#endif
