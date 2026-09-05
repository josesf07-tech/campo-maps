//
//  RoomSummaryView.swift
//  JoseScan
//
//  Resumen del interior capturado con RoomPlan: elementos detectados con sus
//  dimensiones, mediciones automáticas, nombre editable y acciones para
//  guardar en la galería o exportar el USDZ.
//

import Foundation
import SwiftUI
import UIKit

#if canImport(RoomPlan)
import RoomPlan

// MARK: - Hoja de compartir propia del módulo

/// Envoltorio local de `UIActivityViewController`. Se llama `RoomShareSheet`
/// para no chocar con la hoja de compartir de otros módulos.
public struct RoomShareSheet: UIViewControllerRepresentable {
    public let elementos: [Any]

    public init(elementos: [Any]) {
        self.elementos = elementos
    }

    public func makeUIViewController(context: Context) -> UIActivityViewController {
        return UIActivityViewController(activityItems: elementos, applicationActivities: nil)
    }

    public func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {
        // No hay estado que actualizar.
    }
}

// MARK: - Resumen

@available(iOS 17.0, *)
public struct RoomSummaryView: View {

    private let habitacion: CapturedRoom
    private let duracionSegundos: Double
    private let geo: GeoReference?
    private let datos: RoomResumen

    @ObservedObject private var store: ScanStore

    @Environment(\.dismiss) private var cerrar

    @State private var nombre: String
    @State private var notas: String = ""
    @State private var guardando: Bool = false
    @State private var guardado: Bool = false
    @State private var mensaje: String?
    @State private var urlExportada: URL?
    @State private var mostrarCompartir: Bool = false

    public init(habitacion: CapturedRoom,
                duracionSegundos: Double,
                store: ScanStore,
                geo: GeoReference? = nil) {
        self.habitacion = habitacion
        self.duracionSegundos = duracionSegundos
        self.geo = geo
        self.datos = RoomPlanConverter.resumen(de: habitacion)
        _store = ObservedObject(wrappedValue: store)
        _nombre = State(initialValue: RoomPlanConverter.nombrePorDefecto())
    }

    public var body: some View {
        NavigationStack {
            List {
                seccionNombre
                seccionMediciones
                seccionElementos(titulo: "Muros", elementos: datos.muros)
                seccionElementos(titulo: "Puertas", elementos: datos.puertas)
                seccionElementos(titulo: "Ventanas", elementos: datos.ventanas)
                seccionElementos(titulo: "Aberturas", elementos: datos.aberturas)
                seccionElementos(titulo: "Pisos", elementos: datos.pisos)
                seccionElementos(titulo: "Objetos", elementos: datos.objetos)
                seccionAcciones
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(JoseTheme.fondo.ignoresSafeArea())
            .navigationTitle("Resumen del interior")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { cerrar() }
                        .foregroundStyle(JoseTheme.acento)
                }
            }
            .sheet(isPresented: $mostrarCompartir) {
                if let urlExportada {
                    RoomShareSheet(elementos: [urlExportada])
                }
            }
        }
    }

    // MARK: Secciones

    private var seccionNombre: some View {
        Section {
            TextField("Nombre del escaneo", text: $nombre)
                .textInputAutocapitalization(.sentences)
                .foregroundStyle(JoseTheme.textoPrimario)
            TextField("Notas (opcional)", text: $notas, axis: .vertical)
                .lineLimit(1...4)
                .foregroundStyle(JoseTheme.textoPrimario)
        } header: {
            Text("Identificación")
                .foregroundStyle(JoseTheme.textoSecundario)
        } footer: {
            Text("Duración de la captura: \(textoDuracion)")
                .foregroundStyle(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    private var seccionMediciones: some View {
        Section {
            filaMedicion(titulo: datos.areaEstimada ? "Área de piso (estimada)" : "Área de piso",
                         valor: String(format: "%.2f m²", datos.areaPiso),
                         icono: "square.dashed")
            filaMedicion(titulo: "Perímetro de muros",
                         valor: String(format: "%.2f m", datos.perimetro),
                         icono: "ruler")
            filaMedicion(titulo: "Altura media de muros",
                         valor: String(format: "%.2f m", datos.alturaMedia),
                         icono: "arrow.up.and.down")
            filaMedicion(titulo: "Volumen aproximado",
                         valor: String(format: "%.2f m³", datos.areaPiso * datos.alturaMedia),
                         icono: "cube.transparent")
            filaMedicion(titulo: "Puertas y ventanas",
                         valor: "\(datos.puertas.count) / \(datos.ventanas.count)",
                         icono: "door.left.hand.open")
        } header: {
            Text("Mediciones automáticas")
                .foregroundStyle(JoseTheme.textoSecundario)
        } footer: {
            Text("El conteo de puertas y ventanas se guarda en las notas del escaneo; el resto queda como mediciones del documento.")
                .foregroundStyle(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    @ViewBuilder
    private func seccionElementos(titulo: String, elementos: [RoomItemResumen]) -> some View {
        if !elementos.isEmpty {
            Section {
                ForEach(elementos) { elemento in
                    HStack(spacing: 12) {
                        Image(systemName: elemento.icono)
                            .frame(width: 24)
                            .foregroundStyle(JoseTheme.acento)
                        Text(elemento.tipo)
                            .foregroundStyle(JoseTheme.textoPrimario)
                        Spacer(minLength: 8)
                        Text(elemento.descripcionDimensiones)
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(JoseTheme.textoSecundario)
                    }
                }
            } header: {
                Text("\(titulo) (\(elementos.count))")
                    .foregroundStyle(JoseTheme.textoSecundario)
            }
            .listRowBackground(JoseTheme.superficie)
        }
    }

    private var seccionAcciones: some View {
        Section {
            Button {
                Task { await guardarEnGaleria() }
            } label: {
                HStack(spacing: 10) {
                    if guardando {
                        ProgressView()
                    } else {
                        Image(systemName: guardado ? "checkmark.circle.fill" : "square.and.arrow.down")
                    }
                    Text(guardado ? "Guardado en la galería" : "Guardar en la galería")
                    Spacer()
                }
                .foregroundStyle(guardado ? JoseTheme.exito : JoseTheme.acento)
            }
            .disabled(guardando)

            Button {
                exportarUSDZ()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.up.doc")
                    Text("Exportar USDZ")
                    Spacer()
                }
                .foregroundStyle(JoseTheme.acento)
            }

            if let mensaje {
                Text(mensaje)
                    .font(.footnote)
                    .foregroundStyle(mensaje.hasPrefix("No se pudo") ? JoseTheme.peligro : JoseTheme.exito)
            }
        } header: {
            Text("Acciones")
                .foregroundStyle(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    private func filaMedicion(titulo: String, valor: String, icono: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icono)
                .frame(width: 24)
                .foregroundStyle(JoseTheme.acento)
            Text(titulo)
                .foregroundStyle(JoseTheme.textoPrimario)
            Spacer(minLength: 8)
            Text(valor)
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(JoseTheme.textoSecundario)
        }
    }

    // MARK: Textos

    private var textoDuracion: String {
        let total = Int(duracionSegundos.rounded())
        let minutos = total / 60
        let segundos = total % 60
        if minutos > 0 {
            return "\(minutos) min \(segundos) s"
        }
        return "\(segundos) s"
    }

    // MARK: Acciones

    @MainActor
    private func guardarEnGaleria() async {
        guardando = true
        mensaje = nil
        let documento = RoomPlanConverter.convertir(habitacion,
                                                    nombre: nombre,
                                                    geo: geo,
                                                    duracionSegundos: duracionSegundos)
        let extra = notas.trimmingCharacters(in: .whitespacesAndNewlines)
        if !extra.isEmpty {
            let previas = documento.metadata.notas ?? ""
            documento.metadata.notas = previas.isEmpty ? extra : previas + " " + extra
        }
        let miniatura = RoomPlanConverter.miniatura(de: habitacion)
        do {
            _ = try await store.guardar(documento, miniatura: miniatura)
            guardado = true
            mensaje = "Escaneo guardado en la galería."
        } catch {
            mensaje = "No se pudo guardar: \(error.localizedDescription)"
        }
        guardando = false
    }

    @MainActor
    private func exportarUSDZ() {
        mensaje = nil
        let destino = RoomPlanConverter.urlTemporalUSDZ(nombre: nombre)
        do {
            try RoomPlanConverter.exportarUSDZ(habitacion, a: destino)
            urlExportada = destino
            mostrarCompartir = true
        } catch {
            mensaje = "No se pudo exportar: \(error.localizedDescription)"
        }
    }
}

#endif
