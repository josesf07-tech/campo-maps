//
//  SettingsView.swift
//  JoseScan
//
//  Ajustes de la app: parámetros de captura, georreferenciación, unidades,
//  proyecto activo, mantenimiento del almacenamiento, consejos de campo y
//  ficha "Acerca de".
//

import SwiftUI
import UIKit

@MainActor
public struct SettingsView: View {

    @ObservedObject private var ajustes: AppSettings

    /// Almacén de escaneos: sólo se usa para mostrar y liberar espacio. Es
    /// opcional para poder abrir los ajustes sin biblioteca cargada.
    private let store: ScanStore?

    @Environment(\.dismiss) private var dismiss

    @State private var espacioUsado: Int64 = 0
    @State private var cantidadEscaneos: Int = 0
    @State private var primeraConfirmacion = false
    @State private var segundaConfirmacion = false
    @State private var confirmarRestaurar = false
    @State private var mensajeError: String?
    @State private var mensajeExito: String?

    public init(ajustes: AppSettings = .compartido, store: ScanStore? = nil) {
        _ajustes = ObservedObject(wrappedValue: ajustes)
        self.store = store
    }

    // MARK: - Cuerpo

    public var body: some View {
        NavigationStack {
            ZStack {
                JoseTheme.fondo.ignoresSafeArea()

                Form {
                    seccionCaptura
                    seccionGeorreferenciacion
                    seccionUnidades
                    seccionAlmacenamiento
                    seccionConsejos
                    seccionAcercaDe
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Ajustes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Listo") { dismiss() }
                        .fontWeight(.semibold)
                        .foregroundColor(JoseTheme.acento)
                }
            }
            .onAppear { actualizarEspacio() }
            .confirmationDialog("¿Borrar todos los escaneos?",
                                isPresented: $primeraConfirmacion,
                                titleVisibility: .visible) {
                Button("Continuar", role: .destructive) { pedirSegundaConfirmacion() }
                Button("Cancelar", role: .cancel) { }
            } message: {
                Text("Se eliminarán \(cantidadEscaneos) escaneo(s) y \(BibliotecaFormato.bytes(espacioUsado)) de datos guardados en este dispositivo.")
            }
            .alert("Confirmación final", isPresented: $segundaConfirmacion) {
                Button("Sí, borrar todo", role: .destructive) { vaciarEscaneos() }
                Button("Cancelar", role: .cancel) { }
            } message: {
                Text("Esta acción es definitiva. Exporta antes lo que necesites conservar: no hay forma de recuperar los escaneos.")
            }
            .alert("¿Restaurar los valores por defecto?", isPresented: $confirmarRestaurar) {
                Button("Restaurar", role: .destructive) {
                    ajustes.restaurarValoresPorDefecto()
                    mensajeExito = "Los ajustes volvieron a los valores de fábrica"
                }
                Button("Cancelar", role: .cancel) { }
            } message: {
                Text("Sólo se cambian las preferencias; los escaneos guardados no se tocan.")
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
        .tint(JoseTheme.acento)
    }

    // MARK: - Secciones

    private var seccionCaptura: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Confianza mínima del sensor")
                    .font(.subheadline)
                    .foregroundColor(JoseTheme.textoPrimario)
                Picker("Confianza mínima", selection: $ajustes.confianzaMinima) {
                    Text("Baja").tag(0)
                    Text("Media").tag(1)
                    Text("Alta").tag(2)
                }
                .pickerStyle(.segmented)
                Text("Con confianza alta se descartan más puntos, pero la nube queda más limpia.")
                    .font(.caption2)
                    .foregroundColor(JoseTheme.textoSecundario)
            }

            deslizador(titulo: "Tamaño del vóxel",
                       valor: $ajustes.tamanoVoxelCm,
                       rango: 1...10,
                       paso: 0.5,
                       texto: "\(BibliotecaFormato.decimal(ajustes.tamanoVoxelCm, 1)) cm",
                       ayuda: "Separación mínima entre puntos. Más grande = archivos más livianos.")

            deslizador(titulo: "Distancia máxima",
                       valor: $ajustes.distanciaMaximaM,
                       rango: 1...5,
                       paso: 0.5,
                       texto: BibliotecaFormato.longitud(ajustes.distanciaMaximaM, imperial: ajustes.esImperial),
                       ayuda: "El LiDAR pierde precisión más allá de 5 m; recorta lo que quede muy lejos.")

            Toggle(isOn: $ajustes.capturarColor) {
                etiqueta("Capturar color", "Toma el color de la cámara para cada punto.")
            }
            .tint(JoseTheme.exito)

            Toggle(isOn: $ajustes.capturarMalla) {
                etiqueta("Reconstruir malla", "Genera triángulos además de la nube (consume más batería).")
            }
            .tint(JoseTheme.exito)
        } header: {
            Text("Captura").foregroundColor(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    private var seccionGeorreferenciacion: some View {
        Section {
            Toggle(isOn: $ajustes.georreferenciarAlGuardar) {
                etiqueta("Georreferenciar al guardar",
                         "Ancla el escaneo al GPS y lo convierte al marco Este-Norte-Arriba.")
            }
            .tint(JoseTheme.exito)
        } header: {
            Text("Georreferenciación").foregroundColor(JoseTheme.textoSecundario)
        } footer: {
            Text("Si el GPS o la brújula no dan precisión suficiente, el escaneo se guarda igual en el marco local de ARKit. Las coordenadas Norte/Este se calculan en MAGNA-SIRGAS Origen Nacional (EPSG:9377), la misma referencia que usa JoseMaps.")
                .foregroundColor(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    private var seccionUnidades: some View {
        Section {
            Picker(selection: $ajustes.unidades) {
                Text("Métrico (m)").tag(AppSettings.unidadMetrico)
                Text("Imperial (ft)").tag(AppSettings.unidadImperial)
            } label: {
                Text("Unidades").foregroundColor(JoseTheme.textoPrimario)
            }
            .pickerStyle(.segmented)

            VStack(alignment: .leading, spacing: 5) {
                Text("Proyecto actual")
                    .font(.subheadline)
                    .foregroundColor(JoseTheme.textoPrimario)
                TextField(AppSettings.proyectoPorDefecto, text: $ajustes.proyectoActual)
                    .textFieldStyle(.plain)
                    .foregroundColor(JoseTheme.textoPrimario)
                    .padding(9)
                    .background(JoseTheme.fondo)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                Text("Los escaneos nuevos quedan asignados a este proyecto.")
                    .font(.caption2)
                    .foregroundColor(JoseTheme.textoSecundario)
            }
        } header: {
            Text("Unidades y proyecto").foregroundColor(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    private var seccionAlmacenamiento: some View {
        Section {
            HStack {
                Text("Escaneos guardados")
                    .foregroundColor(JoseTheme.textoPrimario)
                Spacer()
                Text(BibliotecaFormato.entero(cantidadEscaneos))
                    .foregroundColor(JoseTheme.textoSecundario)
            }
            HStack {
                Text("Espacio ocupado")
                    .foregroundColor(JoseTheme.textoPrimario)
                Spacer()
                Text(BibliotecaFormato.bytes(espacioUsado))
                    .foregroundColor(JoseTheme.textoSecundario)
            }
            Button(role: .destructive) {
                primeraConfirmacion = true
            } label: {
                Label("Vaciar la carpeta de escaneos", systemImage: "trash")
                    .foregroundColor(JoseTheme.peligro)
            }
            .disabled(store == nil || cantidadEscaneos == 0)
        } header: {
            Text("Almacenamiento").foregroundColor(JoseTheme.textoSecundario)
        } footer: {
            Text("Los escaneos viven en Documents/Escaneos dentro de la app y se respaldan con el dispositivo.")
                .foregroundColor(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    private var seccionConsejos: some View {
        Section {
            consejo(numero: 1,
                    titulo: "Camina despacio y en arco",
                    detalle: "Rodea el objeto describiendo un semicírculo, sin giros bruscos: ARKit necesita ver texturas repetidas para no perder el seguimiento.")
            consejo(numero: 2,
                    titulo: "Mantente entre 1 y 3 metros",
                    detalle: "Es el rango donde el LiDAR del iPhone entrega la mejor densidad. Más lejos, el ruido crece rápido.")
            consejo(numero: 3,
                    titulo: "Espera el ancla GPS antes de empezar",
                    detalle: "Con precisión menor a 5 m el escaneo queda bien georreferenciado y se puede llevar directo al mapa de JoseMaps.")
            consejo(numero: 4,
                    titulo: "Exporta apenas termines",
                    detalle: "En campo conviene sacar el paquete .josescan o el GeoJSON de una vez: así el trabajo queda respaldado aunque el equipo se quede sin batería.")
        } header: {
            Text("Cómo se usa").foregroundColor(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    private var seccionAcercaDe: some View {
        Section {
            HStack {
                Text("Versión").foregroundColor(JoseTheme.textoPrimario)
                Spacer()
                Text(versionCompleta).foregroundColor(JoseTheme.textoSecundario)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("JoseScan es el complemento nativo de la PWA de campo JoseMaps: captura con el LiDAR del iPhone o iPad y entrega nubes, mallas y huellas listas para el mapa.")
                    .font(.caption)
                    .foregroundColor(JoseTheme.textoSecundario)
                Text("Las coordenadas planas se calculan en MAGNA-SIRGAS Origen Nacional (EPSG:9377), el sistema oficial de Colombia, con la misma definición que usa JoseMaps.")
                    .font(.caption)
                    .foregroundColor(JoseTheme.textoSecundario)
                Text("Formato de intercambio: josescan/1.0")
                    .font(.caption2.monospaced())
                    .foregroundColor(JoseTheme.textoSecundario)
            }
            Button {
                confirmarRestaurar = true
            } label: {
                Label("Restaurar valores por defecto", systemImage: "arrow.counterclockwise")
                    .foregroundColor(JoseTheme.alerta)
            }
        } header: {
            Text("Acerca de").foregroundColor(JoseTheme.textoSecundario)
        }
        .listRowBackground(JoseTheme.superficie)
    }

    // MARK: - Piezas

    private func etiqueta(_ titulo: String, _ detalle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(titulo)
                .font(.subheadline)
                .foregroundColor(JoseTheme.textoPrimario)
            Text(detalle)
                .font(.caption2)
                .foregroundColor(JoseTheme.textoSecundario)
        }
    }

    private func deslizador(titulo: String,
                            valor: Binding<Double>,
                            rango: ClosedRange<Double>,
                            paso: Double,
                            texto: String,
                            ayuda: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(titulo)
                    .font(.subheadline)
                    .foregroundColor(JoseTheme.textoPrimario)
                Spacer()
                Text(texto)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(JoseTheme.acento)
            }
            Slider(value: valor, in: rango, step: paso)
                .tint(JoseTheme.acento)
            Text(ayuda)
                .font(.caption2)
                .foregroundColor(JoseTheme.textoSecundario)
        }
    }

    private func consejo(numero: Int, titulo: String, detalle: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(numero)")
                .font(.caption.weight(.bold))
                .foregroundColor(JoseTheme.fondo)
                .frame(width: 20, height: 20)
                .background(Circle().fill(JoseTheme.acento))

            VStack(alignment: .leading, spacing: 2) {
                Text(titulo)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(JoseTheme.textoPrimario)
                Text(detalle)
                    .font(.caption2)
                    .foregroundColor(JoseTheme.textoSecundario)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Datos y acciones

    private var versionCompleta: String {
        let corta = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let compilacion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(corta) (\(compilacion))"
    }

    private var enlaceError: Binding<Bool> {
        Binding(get: { mensajeError != nil },
                set: { activo in if !activo { mensajeError = nil } })
    }

    private var enlaceExito: Binding<Bool> {
        Binding(get: { mensajeExito != nil },
                set: { activo in if !activo { mensajeExito = nil } })
    }

    private func actualizarEspacio() {
        guard let store else {
            espacioUsado = 0
            cantidadEscaneos = 0
            return
        }
        espacioUsado = store.espacioUsadoBytes()
        cantidadEscaneos = store.escaneos.count
    }

    /// Segunda confirmación: se pide con un pequeño retraso para que la primera
    /// hoja termine de cerrarse antes de mostrar la alerta.
    private func pedirSegundaConfirmacion() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            segundaConfirmacion = true
        }
    }

    private func vaciarEscaneos() {
        guard let store else { return }
        do {
            try store.vaciarTodo()
            actualizarEspacio()
            mensajeExito = "La carpeta de escaneos quedó vacía"
        } catch {
            mensajeError = error.localizedDescription
        }
    }
}
