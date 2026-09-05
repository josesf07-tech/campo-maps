//
//  ScanLibraryView.swift
//  JoseScan
//
//  Galería de escaneos guardados: búsqueda, orden, vista en grilla o lista,
//  borrado con confirmación y pie con el espacio ocupado en el dispositivo.
//

import SwiftUI
import UIKit

// MARK: - Formateadores compartidos por la biblioteca

/// Formateo de números, fechas y magnitudes en español de Colombia.
enum BibliotecaFormato {

    static let localeCO = Locale(identifier: "es_CO")

    private static let fechaMedia: DateFormatter = {
        let f = DateFormatter()
        f.locale = localeCO
        f.dateFormat = "d MMM yyyy, HH:mm"
        return f
    }()

    private static let fechaCompleta: DateFormatter = {
        let f = DateFormatter()
        f.locale = localeCO
        f.dateFormat = "EEEE d 'de' MMMM 'de' yyyy, HH:mm"
        return f
    }()

    private static let numeros: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = localeCO
        f.numberStyle = .decimal
        return f
    }()

    /// "5 sep 2026, 14:22"
    static func fecha(_ d: Date) -> String { fechaMedia.string(from: d) }

    /// "sábado 5 de septiembre de 2026, 14:22"
    static func fechaLarga(_ d: Date) -> String { fechaCompleta.string(from: d) }

    /// Entero con separador de miles: "812.344"
    static func entero(_ v: Int) -> String {
        numeros.maximumFractionDigits = 0
        numeros.minimumFractionDigits = 0
        return numeros.string(from: NSNumber(value: v)) ?? "\(v)"
    }

    /// Decimal con la cantidad de cifras indicada: "3,42"
    static func decimal(_ v: Double, _ decimales: Int = 2) -> String {
        guard v.isFinite else { return "—" }
        numeros.maximumFractionDigits = decimales
        numeros.minimumFractionDigits = decimales
        return numeros.string(from: NSNumber(value: v)) ?? String(format: "%.\(decimales)f", v)
    }

    /// Longitud en metros o pies según las preferencias.
    static func longitud(_ metros: Double, imperial: Bool) -> String {
        imperial ? "\(decimal(metros * 3.280839895, 2)) ft" : "\(decimal(metros, 2)) m"
    }

    /// Área en m² o ft².
    static func area(_ m2: Double, imperial: Bool) -> String {
        imperial ? "\(decimal(m2 * 10.763910417, 2)) ft²" : "\(decimal(m2, 2)) m²"
    }

    /// Volumen en m³ o ft³.
    static func volumen(_ m3: Double, imperial: Bool) -> String {
        imperial ? "\(decimal(m3 * 35.314666721, 2)) ft³" : "\(decimal(m3, 2)) m³"
    }

    /// Ángulo en grados: "172,5°"
    static func grados(_ g: Double) -> String { "\(decimal(g, 1))°" }

    /// Valor de una medición guardada, ya convertido a las unidades activas.
    static func medicion(_ m: MeasurementRecord, imperial: Bool) -> String {
        switch m.kind {
        case .distancia, .altura: return longitud(m.value, imperial: imperial)
        case .area: return area(m.value, imperial: imperial)
        case .volumen: return volumen(m.value, imperial: imperial)
        case .azimut: return grados(m.value)
        }
    }

    /// Nombre legible del tipo de medición.
    static func nombreMedicion(_ k: MeasurementKind) -> String {
        switch k {
        case .distancia: return "Distancia"
        case .area: return "Área"
        case .volumen: return "Volumen"
        case .altura: return "Altura"
        case .azimut: return "Azimut"
        }
    }

    /// Tamaño en disco: "12,4 MB"
    static func bytes(_ b: Int64) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        f.allowedUnits = [.useKB, .useMB, .useGB]
        return f.string(fromByteCount: max(0, b))
    }

    /// Duración de la captura: "1 min 32 s"
    static func duracion(_ segundos: Double) -> String {
        guard segundos.isFinite, segundos > 0 else { return "—" }
        let total = Int(segundos.rounded())
        let minutos = total / 60
        let resto = total % 60
        if minutos == 0 { return "\(resto) s" }
        return "\(minutos) min \(resto) s"
    }

    /// Coordenada geográfica con 6 decimales: "4,609710°"
    static func coordenada(_ v: Double) -> String { "\(decimal(v, 6))°" }

    /// Nombre legible del marco de coordenadas.
    static func marco(_ m: ScanCoordinateFrame) -> String {
        switch m {
        case .arkit: return "Local (ARKit)"
        case .enu: return "Este-Norte-Arriba (ENU)"
        }
    }
}

// MARK: - Criterio de ordenamiento

enum OrdenBiblioteca: String, CaseIterable, Identifiable {
    case fechaReciente
    case fechaAntigua
    case tamanoMayor
    case nombre

    var id: String { rawValue }

    var titulo: String {
        switch self {
        case .fechaReciente: return "Más recientes primero"
        case .fechaAntigua: return "Más antiguos primero"
        case .tamanoMayor: return "Mayor tamaño primero"
        case .nombre: return "Nombre (A–Z)"
        }
    }

    var icono: String {
        switch self {
        case .fechaReciente: return "arrow.down.circle"
        case .fechaAntigua: return "arrow.up.circle"
        case .tamanoMayor: return "internaldrive"
        case .nombre: return "textformat.abc"
        }
    }
}

// MARK: - Piezas reutilizables

/// Miniatura del escaneo leída del disco fuera del hilo principal.
@MainActor
struct BibliotecaMiniatura: View {
    @ObservedObject var store: ScanStore
    let id: UUID
    var alto: CGFloat = 112

    @State private var imagen: UIImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(JoseTheme.fondo)
            if let imagen {
                Image(uiImage: imagen)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "cube.transparent")
                    .font(.system(size: alto * 0.30, weight: .light))
                    .foregroundColor(JoseTheme.textoSecundario.opacity(0.55))
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: alto)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Etiqueta compacta de color (georreferenciado, malla, proyecto…).
struct BibliotecaChip: View {
    let texto: String
    let icono: String
    let color: Color

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icono)
                .font(.system(size: 9, weight: .semibold))
            Text(texto)
                .font(.system(size: 10, weight: .semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(color.opacity(0.18))
        .foregroundColor(color)
        .clipShape(Capsule())
    }
}

/// Tarjeta de la grilla.
@MainActor
struct BibliotecaTarjeta: View {
    @ObservedObject var store: ScanStore
    let meta: ScanMetadata

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            BibliotecaMiniatura(store: store, id: meta.id, alto: 112)

            Text(meta.nombre)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(JoseTheme.textoPrimario)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(BibliotecaFormato.fecha(meta.creado))
                .font(.caption2)
                .foregroundColor(JoseTheme.textoSecundario)

            HStack(spacing: 10) {
                Label(BibliotecaFormato.entero(meta.puntos), systemImage: "circle.grid.3x3.fill")
                Label(BibliotecaFormato.entero(meta.triangulos), systemImage: "triangle.fill")
            }
            .font(.system(size: 10))
            .foregroundColor(JoseTheme.textoSecundario)

            HStack(spacing: 5) {
                if meta.geo != nil || meta.marco == .enu {
                    BibliotecaChip(texto: "Georreferenciado", icono: "location.fill", color: JoseTheme.exito)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(10)
        .background(JoseTheme.superficie)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

/// Fila de la lista.
@MainActor
struct BibliotecaFila: View {
    @ObservedObject var store: ScanStore
    let meta: ScanMetadata

    var body: some View {
        HStack(spacing: 12) {
            BibliotecaMiniatura(store: store, id: meta.id, alto: 62)
                .frame(width: 82)

            VStack(alignment: .leading, spacing: 3) {
                Text(meta.nombre)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(JoseTheme.textoPrimario)
                    .lineLimit(1)

                Text(BibliotecaFormato.fecha(meta.creado))
                    .font(.caption2)
                    .foregroundColor(JoseTheme.textoSecundario)

                HStack(spacing: 8) {
                    Text("\(BibliotecaFormato.entero(meta.puntos)) pts")
                    Text("\(BibliotecaFormato.entero(meta.triangulos)) tri")
                    Text(BibliotecaFormato.bytes(store.tamanoBytes(de: meta.id)))
                }
                .font(.system(size: 10))
                .foregroundColor(JoseTheme.textoSecundario)

                if meta.geo != nil || meta.marco == .enu {
                    BibliotecaChip(texto: "Georreferenciado", icono: "location.fill", color: JoseTheme.exito)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Galería

@MainActor
public struct ScanLibraryView: View {

    @StateObject private var store: ScanStore
    @ObservedObject private var ajustes: AppSettings

    @State private var busqueda: String = ""
    @State private var orden: OrdenBiblioteca = .fechaReciente
    @State private var enGrilla: Bool = true
    @State private var mostrarAjustes: Bool = false
    @State private var candidatoEliminar: ScanMetadata?
    @State private var mensajeError: String?

    private let columnas = [GridItem(.adaptive(minimum: 158), spacing: 14)]

    /// Crea la galería con su propio almacén.
    public init() {
        _store = StateObject(wrappedValue: ScanStore())
        ajustes = AppSettings.compartido
    }

    /// Crea la galería sobre un almacén ya existente (el de la app).
    public init(store: ScanStore, ajustes: AppSettings = .compartido) {
        _store = StateObject(wrappedValue: store)
        self.ajustes = ajustes
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                JoseTheme.fondo.ignoresSafeArea()

                VStack(spacing: 0) {
                    contenido
                    pie
                }
            }
            .navigationTitle("Escaneos")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $busqueda, prompt: "Buscar por nombre o proyecto")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        mostrarAjustes = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Ajustes")
                }
                ToolbarItemGroup(placement: .navigationBarTrailing) {
                    Button {
                        withAnimation { enGrilla.toggle() }
                    } label: {
                        Image(systemName: enGrilla ? "list.bullet" : "square.grid.2x2")
                    }
                    .accessibilityLabel(enGrilla ? "Ver como lista" : "Ver como grilla")

                    Menu {
                        Picker("Ordenar", selection: $orden) {
                            ForEach(OrdenBiblioteca.allCases) { criterio in
                                Label(criterio.titulo, systemImage: criterio.icono).tag(criterio)
                            }
                        }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down")
                    }
                    .accessibilityLabel("Ordenar")
                }
            }
            .refreshable {
                store.cargar()
            }
            .sheet(isPresented: $mostrarAjustes) {
                SettingsView(ajustes: ajustes, store: store)
            }
            .confirmationDialog(tituloBorrado,
                                isPresented: enlaceCandidato,
                                titleVisibility: .visible) {
                Button("Eliminar escaneo", role: .destructive) { confirmarBorrado() }
                Button("Cancelar", role: .cancel) { candidatoEliminar = nil }
            } message: {
                Text("Se borrarán la nube de puntos, la malla y las mediciones. Esta acción no se puede deshacer.")
            }
            .alert("No se pudo completar la acción",
                   isPresented: enlaceError) {
                Button("Entendido", role: .cancel) { mensajeError = nil }
            } message: {
                Text(mensajeError ?? "")
            }
        }
        .tint(JoseTheme.acento)
    }

    // MARK: Contenido

    @ViewBuilder
    private var contenido: some View {
        if store.cargando && store.escaneos.isEmpty {
            Spacer()
            ProgressView("Cargando escaneos…")
                .tint(JoseTheme.acento)
                .foregroundColor(JoseTheme.textoSecundario)
            Spacer()
        } else if store.escaneos.isEmpty {
            vistaVacia
        } else if escaneosVisibles.isEmpty {
            vistaSinResultados
        } else if enGrilla {
            grilla
        } else {
            lista
        }
    }

    private var grilla: some View {
        ScrollView {
            LazyVGrid(columns: columnas, spacing: 14) {
                ForEach(escaneosVisibles) { meta in
                    NavigationLink {
                        ScanDetailView(store: store, meta: meta, ajustes: ajustes)
                    } label: {
                        BibliotecaTarjeta(store: store, meta: meta)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button(role: .destructive) {
                            candidatoEliminar = meta
                        } label: {
                            Label("Eliminar", systemImage: "trash")
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
    }

    private var lista: some View {
        List {
            ForEach(escaneosVisibles) { meta in
                ZStack {
                    NavigationLink {
                        ScanDetailView(store: store, meta: meta, ajustes: ajustes)
                    } label: {
                        EmptyView()
                    }
                    .opacity(0)

                    BibliotecaFila(store: store, meta: meta)
                }
                .listRowBackground(JoseTheme.superficie)
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        candidatoEliminar = meta
                    } label: {
                        Label("Eliminar", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    private var vistaVacia: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "cube.transparent")
                .font(.system(size: 62, weight: .thin))
                .foregroundColor(JoseTheme.acento.opacity(0.8))
            Text("Todavía no hay escaneos")
                .font(.title3.weight(.semibold))
                .foregroundColor(JoseTheme.textoPrimario)
            Text("Toca el botón de captura para levantar la primera nube de puntos con el LiDAR. Los escaneos quedan guardados en el dispositivo y se pueden exportar a JoseMaps.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundColor(JoseTheme.textoSecundario)
                .padding(.horizontal, 34)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var vistaSinResultados: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "magnifyingglass")
                .font(.system(size: 44, weight: .thin))
                .foregroundColor(JoseTheme.textoSecundario)
            Text("Sin resultados para “\(busqueda)”")
                .font(.headline)
                .foregroundColor(JoseTheme.textoPrimario)
            Text("Revisa el nombre del escaneo o el proyecto al que pertenece.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundColor(JoseTheme.textoSecundario)
                .padding(.horizontal, 34)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var pie: some View {
        HStack(spacing: 6) {
            Image(systemName: "internaldrive")
                .font(.system(size: 11))
            Text(textoPie)
                .font(.caption2)
            Spacer(minLength: 0)
            if store.cargando {
                ProgressView().scaleEffect(0.7)
            }
        }
        .foregroundColor(JoseTheme.textoSecundario)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(JoseTheme.superficie)
    }

    // MARK: Datos derivados

    private var escaneosVisibles: [ScanMetadata] {
        let filtrados = store.escaneos.filter { coincide($0, busqueda) }
        switch orden {
        case .fechaReciente:
            return filtrados.sorted { $0.creado > $1.creado }
        case .fechaAntigua:
            return filtrados.sorted { $0.creado < $1.creado }
        case .tamanoMayor:
            return filtrados.sorted { store.tamanoBytes(de: $0.id) > store.tamanoBytes(de: $1.id) }
        case .nombre:
            return filtrados.sorted {
                $0.nombre.compare($1.nombre, options: [.caseInsensitive, .diacriticInsensitive],
                                  range: nil, locale: BibliotecaFormato.localeCO) == .orderedAscending
            }
        }
    }

    private var textoPie: String {
        let n = store.escaneos.count
        let unidad = n == 1 ? "escaneo" : "escaneos"
        return "\(BibliotecaFormato.entero(n)) \(unidad) · \(BibliotecaFormato.bytes(store.espacioUsadoBytes())) en el dispositivo"
    }

    private var tituloBorrado: String {
        guard let meta = candidatoEliminar else { return "¿Eliminar el escaneo?" }
        return "¿Eliminar “\(meta.nombre)”?"
    }

    private var enlaceCandidato: Binding<Bool> {
        Binding(get: { candidatoEliminar != nil },
                set: { activo in if !activo { candidatoEliminar = nil } })
    }

    private var enlaceError: Binding<Bool> {
        Binding(get: { mensajeError != nil },
                set: { activo in if !activo { mensajeError = nil } })
    }

    private func coincide(_ meta: ScanMetadata, _ texto: String) -> Bool {
        let consulta = texto.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !consulta.isEmpty else { return true }
        let opciones: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        if meta.nombre.range(of: consulta, options: opciones) != nil { return true }
        if let proyecto = meta.proyecto, proyecto.range(of: consulta, options: opciones) != nil { return true }
        return false
    }

    private func confirmarBorrado() {
        guard let meta = candidatoEliminar else { return }
        candidatoEliminar = nil
        do {
            try store.eliminar(meta.id)
        } catch {
            mensajeError = error.localizedDescription
        }
    }
}
