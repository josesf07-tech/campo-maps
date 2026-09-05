//
//  ScanDetailView.swift
//  JoseScan
//
//  Ficha de un escaneo: edición de nombre, proyecto y notas; métricas de la
//  captura; caja envolvente; coordenadas geográficas y MAGNA-SIRGAS; mediciones
//  guardadas; exportación y borrado.
//

import SwiftUI
import UIKit

@MainActor
public struct ScanDetailView: View {

    @ObservedObject private var store: ScanStore
    @ObservedObject private var ajustes: AppSettings

    /// Metadatos con los que se abrió la ficha (respaldo si el almacén ya no
    /// tiene el escaneo, por ejemplo justo después de borrarlo).
    private let metaInicial: ScanMetadata

    @Environment(\.dismiss) private var dismiss

    @State private var nombre: String
    @State private var proyecto: String
    @State private var notas: String

    @State private var documento: ScanDocument?
    @State private var cargandoDocumento = false
    @State private var mostrarExportar = false
    @State private var mostrarBorrado = false
    @State private var mensajeError: String?
    @State private var mensajeExito: String?

    public init(store: ScanStore, meta: ScanMetadata, ajustes: AppSettings = .compartido) {
        _store = ObservedObject(wrappedValue: store)
        _ajustes = ObservedObject(wrappedValue: ajustes)
        self.metaInicial = meta
        _nombre = State(initialValue: meta.nombre)
        _proyecto = State(initialValue: meta.proyecto ?? "")
        _notas = State(initialValue: meta.notas ?? "")
    }

    // MARK: - Cuerpo

    public var body: some View {
        ZStack {
            JoseTheme.fondo.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 14) {
                    cabecera
                    tarjetaEdicion
                    tarjetaMetricas
                    tarjetaCaja
                    tarjetaCoordenadas
                    tarjetaMediciones
                    acciones
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
            }
        }
        .navigationTitle(meta.nombre)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Guardar") { guardarCambios() }
                    .disabled(!hayCambios)
                    .foregroundColor(hayCambios ? JoseTheme.acento : JoseTheme.textoSecundario)
            }
        }
        .sheet(isPresented: $mostrarExportar) {
            if let documento {
                ScanExportSheet(documento: documento,
                                nombreBase: ScanExporter.nombreSeguro(meta.nombre))
            }
        }
        .confirmationDialog("¿Eliminar “\(meta.nombre)”?",
                            isPresented: $mostrarBorrado,
                            titleVisibility: .visible) {
            Button("Eliminar escaneo", role: .destructive) { eliminar() }
            Button("Cancelar", role: .cancel) { }
        } message: {
            Text("Se borrarán la nube de puntos, la malla, la miniatura y las mediciones guardadas.")
        }
        .alert("No se pudo completar la acción", isPresented: enlaceError) {
            Button("Entendido", role: .cancel) { mensajeError = nil }
        } message: {
            Text(mensajeError ?? "")
        }
        .alert("Listo", isPresented: enlaceExito) {
            Button("Cerrar", role: .cancel) { mensajeExito = nil }
        } message: {
            Text(mensajeExito ?? "")
        }
    }

    // MARK: - Secciones

    private var cabecera: some View {
        VStack(alignment: .leading, spacing: 10) {
            BibliotecaMiniatura(store: store, id: meta.id, alto: 190)

            HStack(spacing: 6) {
                if meta.geo != nil || meta.marco == .enu {
                    BibliotecaChip(texto: "Georreferenciado", icono: "location.fill", color: JoseTheme.exito)
                } else {
                    BibliotecaChip(texto: "Sin ancla GPS", icono: "location.slash", color: JoseTheme.alerta)
                }
                if meta.triangulos > 0 {
                    BibliotecaChip(texto: "Con malla", icono: "square.grid.3x3", color: JoseTheme.acento)
                }
                BibliotecaChip(texto: meta.sensor.uppercased(), icono: "sensor.tag.radiowaves.forward", color: JoseTheme.acento)
                Spacer(minLength: 0)
            }

            Text(BibliotecaFormato.fechaLarga(meta.creado))
                .font(.caption)
                .foregroundColor(JoseTheme.textoSecundario)
        }
        .padding(12)
        .background(JoseTheme.superficie)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var tarjetaEdicion: some View {
        tarjeta("Identificación", icono: "square.and.pencil") {
            VStack(alignment: .leading, spacing: 10) {
                campoTexto("Nombre", texto: $nombre, sugerencia: "Nombre del escaneo")
                campoTexto("Proyecto", texto: $proyecto, sugerencia: AppSettings.proyectoPorDefecto)

                Text("Notas")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(JoseTheme.textoSecundario)
                TextField("Observaciones de campo", text: $notas, axis: .vertical)
                    .lineLimit(3...6)
                    .textFieldStyle(.plain)
                    .foregroundColor(JoseTheme.textoPrimario)
                    .padding(9)
                    .background(JoseTheme.fondo)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                if hayCambios {
                    Text("Hay cambios sin guardar.")
                        .font(.caption2)
                        .foregroundColor(JoseTheme.alerta)
                }
            }
        }
    }

    private var tarjetaMetricas: some View {
        tarjeta("Métricas de la captura", icono: "chart.bar.doc.horizontal") {
            VStack(spacing: 0) {
                fila("Puntos", BibliotecaFormato.entero(meta.puntos))
                fila("Vértices de malla", BibliotecaFormato.entero(meta.vertices))
                fila("Triángulos", BibliotecaFormato.entero(meta.triangulos))
                fila("Duración", BibliotecaFormato.duracion(meta.duracionSegundos))
                fila("Tamaño en disco", BibliotecaFormato.bytes(store.tamanoBytes(de: meta.id)))
                fila("Marco de coordenadas", BibliotecaFormato.marco(meta.marco))
                fila("Sensor", meta.sensor)
                fila("Dispositivo", meta.dispositivo.isEmpty ? "—" : meta.dispositivo)
                fila("Sistema", meta.sistema.isEmpty ? "—" : meta.sistema)
                fila("Formato", meta.formato, ultima: true)
            }
        }
    }

    @ViewBuilder
    private var tarjetaCaja: some View {
        tarjeta("Caja envolvente", icono: "cube") {
            if let caja = meta.bbox, !caja.isEmpty {
                VStack(spacing: 0) {
                    fila("Ancho (X)", BibliotecaFormato.longitud(Double(caja.size.x), imperial: ajustes.esImperial))
                    fila("Alto (Y)", BibliotecaFormato.longitud(Double(caja.size.y), imperial: ajustes.esImperial))
                    fila("Fondo (Z)", BibliotecaFormato.longitud(Double(caja.size.z), imperial: ajustes.esImperial))
                    fila("Diagonal", BibliotecaFormato.longitud(Double(caja.diagonal), imperial: ajustes.esImperial))
                    fila("Mínimo", vector(caja.min))
                    fila("Máximo", vector(caja.max), ultima: true)
                }
            } else {
                textoVacio("Este escaneo no tiene caja envolvente calculada.")
            }
        }
    }

    @ViewBuilder
    private var tarjetaCoordenadas: some View {
        tarjeta("Coordenadas", icono: "location.viewfinder") {
            if let geo = meta.geo {
                VStack(spacing: 0) {
                    fila("Latitud", BibliotecaFormato.coordenada(geo.latitude))
                    fila("Longitud", BibliotecaFormato.coordenada(geo.longitude))
                    fila("Altitud", BibliotecaFormato.longitud(geo.altitude, imperial: ajustes.esImperial))
                    fila("Norte (MAGNA-SIRGAS)", geo.norte.map { BibliotecaFormato.decimal($0, 2) + " m" } ?? "—")
                    fila("Este (MAGNA-SIRGAS)", geo.este.map { BibliotecaFormato.decimal($0, 2) + " m" } ?? "—")
                    fila("Precisión horizontal", geo.horizontalAccuracy >= 0 ? "± " + BibliotecaFormato.decimal(geo.horizontalAccuracy, 1) + " m" : "—")
                    fila("Precisión vertical", geo.verticalAccuracy >= 0 ? "± " + BibliotecaFormato.decimal(geo.verticalAccuracy, 1) + " m" : "—")
                    fila("Rumbo", BibliotecaFormato.grados(geo.heading))
                    fila("Ancla tomada", BibliotecaFormato.fecha(geo.timestamp))
                    fila("Confiable para exportar", geo.esConfiable ? "Sí" : "No", ultima: true)
                }
                Text("Origen Nacional EPSG:9377 · las coordenadas corresponden al origen del escaneo, no a cada punto.")
                    .font(.caption2)
                    .foregroundColor(JoseTheme.textoSecundario)
                    .padding(.top, 6)
            } else {
                textoVacio("El escaneo no tiene ancla GPS. Actívala en Ajustes antes de capturar para poder exportarlo en coordenadas.")
            }
        }
    }

    @ViewBuilder
    private var tarjetaMediciones: some View {
        tarjeta("Mediciones guardadas (\(meta.mediciones.count))", icono: "ruler") {
            if meta.mediciones.isEmpty {
                textoVacio("Aún no hay mediciones en este escaneo.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(meta.mediciones.enumerated()), id: \.element.id) { indice, medicion in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(medicion.label?.isEmpty == false
                                     ? (medicion.label ?? "")
                                     : BibliotecaFormato.nombreMedicion(medicion.kind))
                                    .font(.subheadline.weight(.medium))
                                    .foregroundColor(JoseTheme.textoPrimario)
                                Spacer(minLength: 8)
                                Text(BibliotecaFormato.medicion(medicion, imperial: ajustes.esImperial))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundColor(JoseTheme.acento)
                            }
                            Text("\(BibliotecaFormato.nombreMedicion(medicion.kind)) · \(medicion.points.count) puntos · \(BibliotecaFormato.fecha(medicion.createdAt))")
                                .font(.caption2)
                                .foregroundColor(JoseTheme.textoSecundario)
                        }
                        .padding(.vertical, 7)

                        if indice < meta.mediciones.count - 1 {
                            Divider().overlay(JoseTheme.fondo)
                        }
                    }
                }
            }
        }
    }

    private var acciones: some View {
        VStack(spacing: 10) {
            Button {
                prepararExportacion()
            } label: {
                HStack {
                    if cargandoDocumento {
                        ProgressView().tint(JoseTheme.fondo)
                    } else {
                        Image(systemName: "square.and.arrow.up")
                    }
                    Text(cargandoDocumento ? "Preparando…" : "Exportar")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(JoseTheme.acento)
                .foregroundColor(JoseTheme.fondo)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .disabled(cargandoDocumento)

            Button {
                mostrarBorrado = true
            } label: {
                HStack {
                    Image(systemName: "trash")
                    Text("Eliminar escaneo").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(JoseTheme.peligro.opacity(0.16))
                .foregroundColor(JoseTheme.peligro)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
        }
        .padding(.top, 2)
    }

    // MARK: - Piezas de presentación

    private func tarjeta<Contenido: View>(_ titulo: String,
                                          icono: String,
                                          @ViewBuilder contenido: () -> Contenido) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: icono)
                    .font(.system(size: 12, weight: .semibold))
                Text(titulo)
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundColor(JoseTheme.acento)

            contenido()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(JoseTheme.superficie)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func fila(_ titulo: String, _ valor: String, ultima: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(titulo)
                    .font(.caption)
                    .foregroundColor(JoseTheme.textoSecundario)
                Spacer(minLength: 10)
                Text(valor)
                    .font(.caption.weight(.medium))
                    .foregroundColor(JoseTheme.textoPrimario)
                    .multilineTextAlignment(.trailing)
            }
            .padding(.vertical, 6)

            if !ultima {
                Divider().overlay(JoseTheme.fondo)
            }
        }
    }

    private func campoTexto(_ titulo: String, texto: Binding<String>, sugerencia: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(titulo)
                .font(.caption.weight(.semibold))
                .foregroundColor(JoseTheme.textoSecundario)
            TextField(sugerencia, text: texto)
                .textFieldStyle(.plain)
                .foregroundColor(JoseTheme.textoPrimario)
                .padding(9)
                .background(JoseTheme.fondo)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private func textoVacio(_ texto: String) -> some View {
        Text(texto)
            .font(.caption)
            .foregroundColor(JoseTheme.textoSecundario)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func vector(_ v: SIMD3<Float>) -> String {
        let imperial = ajustes.esImperial
        let x = BibliotecaFormato.decimal(Double(v.x) * (imperial ? 3.280839895 : 1), 2)
        let y = BibliotecaFormato.decimal(Double(v.y) * (imperial ? 3.280839895 : 1), 2)
        let z = BibliotecaFormato.decimal(Double(v.z) * (imperial ? 3.280839895 : 1), 2)
        return "(\(x); \(y); \(z)) \(imperial ? "ft" : "m")"
    }

    // MARK: - Datos derivados

    /// Metadatos vigentes: los del almacén si siguen ahí, si no los iniciales.
    private var meta: ScanMetadata {
        store.metadatos(de: metaInicial.id) ?? metaInicial
    }

    private var hayCambios: Bool {
        let actual = meta
        let n = nombre.trimmingCharacters(in: .whitespacesAndNewlines)
        let p = proyecto.trimmingCharacters(in: .whitespacesAndNewlines)
        let o = notas.trimmingCharacters(in: .whitespacesAndNewlines)
        if n != actual.nombre { return true }
        if p != (actual.proyecto ?? "") { return true }
        if o != (actual.notas ?? "") { return true }
        return false
    }

    private var enlaceError: Binding<Bool> {
        Binding(get: { mensajeError != nil },
                set: { activo in if !activo { mensajeError = nil } })
    }

    private var enlaceExito: Binding<Bool> {
        Binding(get: { mensajeExito != nil },
                set: { activo in if !activo { mensajeExito = nil } })
    }

    // MARK: - Acciones

    private func guardarCambios() {
        var actualizado = meta
        let n = nombre.trimmingCharacters(in: .whitespacesAndNewlines)
        let p = proyecto.trimmingCharacters(in: .whitespacesAndNewlines)
        let o = notas.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !n.isEmpty else {
            mensajeError = "El nombre del escaneo no puede quedar vacío."
            return
        }
        actualizado.nombre = n
        actualizado.proyecto = p.isEmpty ? nil : p
        actualizado.notas = o.isEmpty ? nil : o

        do {
            try store.actualizar(actualizado)
            nombre = actualizado.nombre
            proyecto = actualizado.proyecto ?? ""
            notas = actualizado.notas ?? ""
            mensajeExito = "Los datos del escaneo quedaron guardados en el dispositivo"
        } catch {
            mensajeError = error.localizedDescription
        }
    }

    private func eliminar() {
        do {
            try store.eliminar(metaInicial.id)
            dismiss()
        } catch {
            mensajeError = error.localizedDescription
        }
    }

    private func prepararExportacion() {
        guard !cargandoDocumento else { return }
        cargandoDocumento = true
        let identificador = metaInicial.id
        Task {
            do {
                let doc = try await store.documentoEnSegundoPlano(de: identificador)
                documento = doc
                cargandoDocumento = false
                mostrarExportar = true
            } catch {
                cargandoDocumento = false
                mensajeError = error.localizedDescription
            }
        }
    }
}
