//
//  ScanResultSheet.swift
//  JoseScan
//
//  Hoja de resumen que aparece al finalizar una captura: permite nombrar el
//  escaneo, revisar sus métricas y guardarlo en la galería o descartarlo.
//

import Foundation
import SwiftUI
import UIKit
import simd

public struct ScanResultSheet: View {

    /// Documento recién capturado. Es una clase: se edita en sitio antes de guardar.
    private let documento: ScanDocument
    /// Miniatura tomada de la cámara al finalizar (puede no existir).
    private let miniatura: UIImage?
    @ObservedObject private var store: ScanStore

    /// Se llama tras guardar correctamente, con los metadatos persistidos.
    private let onGuardado: (ScanMetadata) -> Void
    /// Se llama cuando el usuario confirma que descarta el escaneo.
    private let onDescartar: () -> Void

    @State private var nombre: String
    @State private var proyecto: String
    @State private var notas: String
    @State private var guardando = false
    @State private var mensajeError: String?
    @State private var mostrarConfirmacionDescartar = false

    public init(documento: ScanDocument,
                miniatura: UIImage?,
                store: ScanStore,
                onGuardado: @escaping (ScanMetadata) -> Void,
                onDescartar: @escaping () -> Void) {
        self.documento = documento
        self.miniatura = miniatura
        self._store = ObservedObject(wrappedValue: store)
        self.onGuardado = onGuardado
        self.onDescartar = onDescartar
        _nombre = State(initialValue: documento.metadata.nombre)
        _proyecto = State(initialValue: documento.metadata.proyecto ?? "")
        _notas = State(initialValue: documento.metadata.notas ?? "")
    }

    // MARK: - Cuerpo

    public var body: some View {
        NavigationStack {
            Form {
                seccionEncabezado
                seccionIdentificacion
                seccionResumen
                seccionCaja
                seccionAncla
                seccionAcciones
            }
            .navigationTitle("Escaneo listo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Descartar") { mostrarConfirmacionDescartar = true }
                        .foregroundColor(JoseTheme.peligro)
                        .disabled(guardando)
                        .accessibilityLabel("Descartar el escaneo")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Guardar") { guardar() }
                        .fontWeight(.semibold)
                        .disabled(guardando)
                        .accessibilityLabel("Guardar el escaneo en la galería")
                }
            }
            // El diálogo de descarte se ancla al formulario y la alerta de error
            // al contenedor: SwiftUI sólo atiende una presentación por vista.
            .confirmationDialog("¿Descartar este escaneo?",
                                isPresented: $mostrarConfirmacionDescartar,
                                titleVisibility: .visible) {
                Button("Descartar", role: .destructive) { onDescartar() }
                Button("Volver", role: .cancel) { }
            } message: {
                Text("Los puntos y la malla capturados se perderán definitivamente.")
            }
        }
        .interactiveDismissDisabled(guardando)
        .alert("No se pudo guardar",
               isPresented: Binding(get: { mensajeError != nil },
                                    set: { activo in if !activo { mensajeError = nil } })) {
            Button("Entendido", role: .cancel) { mensajeError = nil }
        } message: {
            Text(mensajeError ?? "Error desconocido.")
        }
    }

    // MARK: - Secciones

    @ViewBuilder
    private var seccionEncabezado: some View {
        Section {
            HStack(spacing: 14) {
                if let imagen = miniatura {
                    Image(uiImage: imagen)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 84, height: 84)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityLabel("Miniatura del escaneo")
                } else {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.gray.opacity(0.25))
                        .frame(width: 84, height: 84)
                        .overlay(
                            Image(systemName: "cube.transparent")
                                .font(.system(size: 26, weight: .light))
                                .foregroundColor(.secondary)
                        )
                        .accessibilityLabel("Sin miniatura")
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(nombre.isEmpty ? "Escaneo sin nombre" : nombre)
                        .font(.headline)
                        .lineLimit(2)
                    Text(ScanResultSheet.textoDuracion(documento.metadata.duracionSegundos))
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    Text(documento.metadata.marco == .enu
                         ? "Georreferenciado (Este/Norte/Arriba)"
                         : "Marco local de ARKit")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer(minLength: 0)
                QualityGauge(valor: puntajeCalidad, diametro: 62, grosor: 7, conMarcas: false)
                    .padding(6)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color.black.opacity(0.75))
                    )
            }
            .padding(.vertical, 4)
        }
    }

    private var seccionIdentificacion: some View {
        Section("Identificación") {
            TextField("Nombre del escaneo", text: $nombre)
                .textInputAutocapitalization(.sentences)
                .disableAutocorrection(false)
                .accessibilityLabel("Nombre del escaneo")
            TextField("Proyecto", text: $proyecto)
                .textInputAutocapitalization(.words)
                .accessibilityLabel("Proyecto")
            TextField("Notas de campo", text: $notas, axis: .vertical)
                .lineLimit(3...6)
                .accessibilityLabel("Notas de campo")
        }
    }

    private var seccionResumen: some View {
        Section("Resumen") {
            fila("Puntos", ScanHUDView.entero(documento.metadata.puntos))
            fila("Vértices", ScanHUDView.entero(documento.metadata.vertices))
            fila("Triángulos", ScanHUDView.entero(documento.metadata.triangulos))
            fila("Área de la malla", ScanHUDView.decimal(documento.mesh.surfaceArea()) + " m²")
            fila("Duración", ScanResultSheet.textoDuracion(documento.metadata.duracionSegundos))
            fila("Sensor", documento.metadata.sensor.uppercased())
            if !documento.metadata.dispositivo.isEmpty {
                fila("Dispositivo", documento.metadata.dispositivo)
            }
        }
    }

    @ViewBuilder
    private var seccionCaja: some View {
        Section("Caja envolvente") {
            if let caja = documento.metadata.bbox, !caja.isEmpty {
                let tam = caja.size
                fila("Ancho (X)", ScanHUDView.decimal(Double(tam.x)) + " m")
                fila("Alto (Y)", ScanHUDView.decimal(Double(tam.y)) + " m")
                fila("Fondo (Z)", ScanHUDView.decimal(Double(tam.z)) + " m")
                fila("Diagonal", ScanHUDView.decimal(Double(caja.diagonal)) + " m")
                fila("Mínimo", ScanResultSheet.textoVector(caja.min))
                fila("Máximo", ScanResultSheet.textoVector(caja.max))
            } else {
                Text("El escaneo no tiene geometría suficiente para calcular la caja envolvente.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
    }

    @ViewBuilder
    private var seccionAncla: some View {
        Section("Ancla geográfica") {
            if let geo = documento.metadata.geo {
                fila("Latitud", String(format: "%.6f°", geo.latitude))
                fila("Longitud", String(format: "%.6f°", geo.longitude))
                fila("Altitud", ScanHUDView.decimal(geo.altitude) + " m")
                fila("Precisión horizontal",
                     geo.horizontalAccuracy >= 0
                     ? "±" + ScanHUDView.decimal(geo.horizontalAccuracy) + " m"
                     : "desconocida")
                fila("Rumbo",
                     geo.headingAccuracy >= 0
                     ? "\(Int(geo.heading.rounded()))° \(ScanHUDView.puntoCardinal(geo.heading))"
                     : "desconocido")
                if let norte = geo.norte, let este = geo.este {
                    fila("Norte (EPSG:9377)", String(format: "%.2f m", norte))
                    fila("Este (EPSG:9377)", String(format: "%.2f m", este))
                }
                if !geo.esConfiable {
                    Label("La precisión del ancla es baja; revisa antes de exportar en coordenadas.",
                          systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundColor(JoseTheme.alerta)
                }
            } else {
                Label("Sin ancla GPS. El escaneo queda en el marco local de ARKit.",
                      systemImage: "location.slash")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
    }

    private var seccionAcciones: some View {
        Section {
            Button {
                guardar()
            } label: {
                HStack {
                    Spacer(minLength: 0)
                    if guardando {
                        ProgressView()
                            .padding(.trailing, 8)
                    } else {
                        Image(systemName: "square.and.arrow.down.fill")
                            .padding(.trailing, 4)
                    }
                    Text(guardando ? "Guardando…" : "Guardar en la galería")
                        .fontWeight(.semibold)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 6)
            }
            .disabled(guardando)
            .accessibilityLabel("Guardar en la galería")

            Button(role: .destructive) {
                mostrarConfirmacionDescartar = true
            } label: {
                HStack {
                    Spacer(minLength: 0)
                    Image(systemName: "trash")
                        .padding(.trailing, 4)
                    Text("Descartar")
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 6)
            }
            .disabled(guardando)
            .accessibilityLabel("Descartar el escaneo")
        } footer: {
            Text("Al guardar se crea un paquete .josescan con los metadatos, la nube de puntos y la malla.")
        }
    }

    // MARK: - Auxiliares de presentación

    private func fila(_ titulo: String, _ valor: String) -> some View {
        HStack {
            Text(titulo)
                .foregroundColor(.secondary)
            Spacer(minLength: 12)
            Text(valor)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(titulo)
        .accessibilityValue(valor)
    }

    /// Puntuación aproximada del documento, sólo para la vista previa.
    private var puntajeCalidad: Int {
        var metricas = ScanQualityMetrics()
        metricas.pointCount = documento.cloud.count
        metricas.triangleCount = documento.mesh.triangleCount
        let altos = documento.cloud.confidences.filter { $0 >= 2 }.count
        metricas.highConfidenceRatio = documento.cloud.count > 0
            ? Double(altos) / Double(documento.cloud.count)
            : 0
        metricas.trackingOK = true
        return metricas.score
    }

    /// "1 min 32 s" a partir de segundos.
    public static func textoDuracion(_ segundos: Double) -> String {
        guard segundos.isFinite, segundos > 0 else { return "0 s" }
        let total = Int(segundos.rounded())
        let minutos = total / 60
        let resto = total % 60
        if minutos > 0 {
            return "\(minutos) min \(resto) s"
        }
        return "\(resto) s"
    }

    /// Vector en metros con dos decimales. Se usa punto decimal por tratarse de
    /// coordenadas técnicas, igual que en los archivos exportados.
    public static func textoVector(_ v: SIMD3<Float>) -> String {
        String(format: "%.2f; %.2f; %.2f", v.x, v.y, v.z)
    }

    // MARK: - Guardado

    private func guardar() {
        guard !guardando else { return }

        let limpio = nombre.trimmingCharacters(in: .whitespacesAndNewlines)
        documento.metadata.nombre = limpio.isEmpty ? "Escaneo sin nombre" : limpio
        let proyectoLimpio = proyecto.trimmingCharacters(in: .whitespacesAndNewlines)
        documento.metadata.proyecto = proyectoLimpio.isEmpty ? nil : proyectoLimpio
        let notasLimpias = notas.trimmingCharacters(in: .whitespacesAndNewlines)
        documento.metadata.notas = notasLimpias.isEmpty ? nil : notasLimpias
        documento.refreshMetadata()

        guardando = true
        let doc = documento
        let imagen = miniatura

        Task {
            do {
                let metadatos = try await store.guardar(doc, miniatura: imagen)
                guardando = false
                onGuardado(metadatos)
            } catch {
                guardando = false
                mensajeError = error.localizedDescription
            }
        }
    }
}
