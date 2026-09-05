//
//  ScanExportSheet.swift
//  JoseScan
//
//  Hoja de exportación: el usuario escoge uno o varios formatos, los archivos
//  se escriben en la carpeta temporal y se entregan a la hoja de compartir de
//  iOS (AirDrop, Archivos, correo, la PWA JoseMaps…).
//

import SwiftUI
import UIKit

@MainActor
public struct ScanExportSheet: View {

    private let documento: ScanDocument
    private let nombreBase: String

    @Environment(\.dismiss) private var dismiss

    @State private var seleccion: Set<ScanExportFormat>
    @State private var exportando = false
    @State private var mensajeError: String?
    @State private var generadas: [URL] = []
    @State private var mostrarCompartir = false

    public init(documento: ScanDocument, nombreBase: String) {
        self.documento = documento
        self.nombreBase = nombreBase.isEmpty ? "escaneo" : nombreBase

        // Preselección sensata según lo que trae el escaneo.
        var inicial: Set<ScanExportFormat> = []
        if !documento.cloud.isEmpty { inicial.insert(.ply) }
        if !documento.mesh.isEmpty { inicial.insert(.obj) }
        if inicial.isEmpty { inicial.insert(.bundle) }
        _seleccion = State(initialValue: inicial)
    }

    // MARK: - Cuerpo

    public var body: some View {
        NavigationStack {
            ZStack {
                JoseTheme.fondo.ignoresSafeArea()

                VStack(spacing: 0) {
                    lista
                    barraInferior
                }

                if exportando {
                    capaProgreso
                }
            }
            .navigationTitle("Exportar escaneo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cerrar") { dismiss() }
                        .foregroundColor(JoseTheme.acento)
                }
            }
            .alert("No se pudo exportar", isPresented: enlaceError) {
                Button("Entendido", role: .cancel) { mensajeError = nil }
            } message: {
                Text(mensajeError ?? "")
            }
            .sheet(isPresented: $mostrarCompartir) {
                ShareSheet(items: generadas)
            }
        }
        .tint(JoseTheme.acento)
    }

    private var lista: some View {
        List {
            Section {
                ForEach(ScanExportFormat.allCases) { formato in
                    fila(formato)
                }
            } header: {
                Text("Formatos disponibles")
                    .foregroundColor(JoseTheme.textoSecundario)
            } footer: {
                Text("Puedes escoger varios formatos a la vez; se comparten juntos en un solo envío.")
                    .foregroundColor(JoseTheme.textoSecundario)
            }
            .listRowBackground(JoseTheme.superficie)

            Section {
                filaResumen("Puntos", BibliotecaFormato.entero(documento.cloud.count))
                filaResumen("Triángulos", BibliotecaFormato.entero(documento.mesh.triangleCount))
                filaResumen("Marco", BibliotecaFormato.marco(documento.metadata.marco))
                filaResumen("Ancla GPS", documento.metadata.geo == nil ? "No" : "Sí")
            } header: {
                Text("Contenido del escaneo")
                    .foregroundColor(JoseTheme.textoSecundario)
            }
            .listRowBackground(JoseTheme.superficie)

            if !generadas.isEmpty {
                Section {
                    ForEach(generadas, id: \.self) { url in
                        HStack {
                            Image(systemName: "doc")
                                .foregroundColor(JoseTheme.acento)
                            Text(url.lastPathComponent)
                                .font(.caption)
                                .foregroundColor(JoseTheme.textoPrimario)
                            Spacer(minLength: 6)
                            Text(BibliotecaFormato.bytes(ScanExportSheet.tamano(de: url)))
                                .font(.caption2)
                                .foregroundColor(JoseTheme.textoSecundario)
                        }
                    }
                    Button {
                        mostrarCompartir = true
                    } label: {
                        Label("Compartir de nuevo", systemImage: "square.and.arrow.up")
                            .foregroundColor(JoseTheme.acento)
                    }
                } header: {
                    Text("Archivos generados")
                        .foregroundColor(JoseTheme.textoSecundario)
                }
                .listRowBackground(JoseTheme.superficie)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private func fila(_ formato: ScanExportFormat) -> some View {
        let habilitado = disponible(formato)
        let marcado = seleccion.contains(formato)
        return Button {
            alternar(formato)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: marcado ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18))
                    .foregroundColor(marcado ? JoseTheme.exito : JoseTheme.textoSecundario)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: 2) {
                    Text(formato.nombre)
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(habilitado ? JoseTheme.textoPrimario : JoseTheme.textoSecundario)
                    Text(descripcion(formato))
                        .font(.caption2)
                        .foregroundColor(JoseTheme.textoSecundario)
                    if let motivo = motivoNoDisponible(formato) {
                        Text(motivo)
                            .font(.caption2.weight(.semibold))
                            .foregroundColor(JoseTheme.alerta)
                    }
                }

                Spacer(minLength: 4)

                Text("." + formato.extensionArchivo)
                    .font(.caption2.monospaced())
                    .foregroundColor(JoseTheme.textoSecundario)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!habilitado || exportando)
    }

    private func filaResumen(_ titulo: String, _ valor: String) -> some View {
        HStack {
            Text(titulo)
                .font(.caption)
                .foregroundColor(JoseTheme.textoSecundario)
            Spacer(minLength: 8)
            Text(valor)
                .font(.caption.weight(.medium))
                .foregroundColor(JoseTheme.textoPrimario)
        }
    }

    private var barraInferior: some View {
        VStack(spacing: 8) {
            Text(seleccion.isEmpty
                 ? "Escoge al menos un formato"
                 : "\(seleccion.count) formato(s) seleccionado(s)")
                .font(.caption2)
                .foregroundColor(JoseTheme.textoSecundario)

            Button {
                exportar()
            } label: {
                HStack {
                    Image(systemName: "square.and.arrow.up")
                    Text("Exportar y compartir").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(seleccionValida.isEmpty ? JoseTheme.acento.opacity(0.35) : JoseTheme.acento)
                .foregroundColor(JoseTheme.fondo)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .disabled(seleccionValida.isEmpty || exportando)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(JoseTheme.superficie)
    }

    private var capaProgreso: some View {
        ZStack {
            JoseTheme.fondo.opacity(0.75).ignoresSafeArea()
            VStack(spacing: 12) {
                ProgressView()
                    .tint(JoseTheme.acento)
                    .scaleEffect(1.3)
                Text("Escribiendo archivos…")
                    .font(.subheadline)
                    .foregroundColor(JoseTheme.textoPrimario)
                Text("Los escaneos grandes pueden tardar unos segundos.")
                    .font(.caption2)
                    .foregroundColor(JoseTheme.textoSecundario)
            }
            .padding(22)
            .background(JoseTheme.superficie)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    // MARK: - Reglas de disponibilidad

    private var seleccionValida: [ScanExportFormat] {
        ScanExportFormat.allCases.filter { seleccion.contains($0) && disponible($0) }
    }

    private func disponible(_ formato: ScanExportFormat) -> Bool {
        motivoNoDisponible(formato) == nil
    }

    private func motivoNoDisponible(_ formato: ScanExportFormat) -> String? {
        if formato.requiereMalla && documento.mesh.isEmpty {
            return "Requiere malla reconstruida"
        }
        switch formato {
        case .ply, .plyAscii, .xyz:
            return documento.cloud.isEmpty ? "Requiere nube de puntos" : nil
        case .geojson:
            return documento.metadata.geo == nil ? "Requiere ancla GPS" : nil
        case .csv:
            return (documento.cloud.isEmpty && documento.metadata.mediciones.isEmpty)
                ? "Requiere puntos o mediciones" : nil
        default:
            return nil
        }
    }

    private func descripcion(_ formato: ScanExportFormat) -> String {
        switch formato {
        case .ply: return "Nube completa con color y confianza. La opción más liviana para CAD."
        case .plyAscii: return "Igual que el anterior pero en texto: pesa más y se puede revisar a mano."
        case .obj: return "Malla con normales y grupos por clasificación (muro, piso, techo…)."
        case .stl: return "Sólo triángulos, ideal para impresión 3D o modelado."
        case .usdz: return "Vista rápida en AR desde Archivos o Mensajes en iPhone y iPad."
        case .xyz: return "Lista de coordenadas en texto plano para software topográfico."
        case .geojson: return "Huella en WGS84 para superponerla en el mapa de JoseMaps."
        case .csv: return "Tabla de puntos y mediciones para Excel o QGIS."
        case .bundle: return "Todo junto: metadatos, nube, malla y miniatura en un solo archivo."
        }
    }

    private var enlaceError: Binding<Bool> {
        Binding(get: { mensajeError != nil },
                set: { activo in if !activo { mensajeError = nil } })
    }

    // MARK: - Acciones

    private func alternar(_ formato: ScanExportFormat) {
        guard disponible(formato) else { return }
        if seleccion.contains(formato) {
            seleccion.remove(formato)
        } else {
            seleccion.insert(formato)
        }
    }

    private func exportar() {
        let formatos = seleccionValida
        guard !formatos.isEmpty else {
            mensajeError = "Escoge al menos un formato disponible para este escaneo."
            return
        }
        guard !exportando else { return }
        exportando = true

        let doc = documento
        let base = nombreBase

        Task {
            do {
                let archivos = try await TrabajoEnSegundoPlano.lanzando { () -> [URL] in
                    let carpeta = FileManager.default.temporaryDirectory
                        .appendingPathComponent("JoseScan-Exportacion", isDirectory: true)
                        .appendingPathComponent(UUID().uuidString, isDirectory: true)
                    do {
                        try FileManager.default.createDirectory(at: carpeta, withIntermediateDirectories: true)
                    } catch {
                        throw ScanError.escrituraFallida("carpeta temporal: \(error.localizedDescription)")
                    }
                    return try ScanExporter.exportar(doc, formatos: formatos, a: carpeta, nombreBase: base)
                }
                exportando = false
                generadas = archivos
                if archivos.isEmpty {
                    mensajeError = "El exportador no generó ningún archivo."
                } else {
                    mostrarCompartir = true
                }
            } catch {
                exportando = false
                mensajeError = error.localizedDescription
            }
        }
    }

    private static func tamano(de url: URL) -> Int64 {
        let valores = try? url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(valores?.fileSize ?? 0)
    }
}
