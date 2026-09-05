//
//  Theme.swift
//  JoseScan
//
//  Paleta, tipografías y estilos compartidos por toda la app.
//  Los valores replican los tokens del sistema de diseño de la PWA JoseMaps
//  (css/style.css, tema "Campo GIS"): superficies de vidrio oscuro, un acento
//  esmeralda y un secundario cielo.
//
//  Todo se define con literales `Color(red:green:blue:)` para no depender de
//  ningún catálogo de assets: así los colores funcionan igual en vistas SwiftUI,
//  en previsualizaciones y en pruebas.
//

import SwiftUI

// MARK: - Paleta y tipografías

/// Sistema de diseño de JoseScan.
public enum JoseTheme {

    // MARK: Superficies

    /// Fondo general de la app (#0d1424).
    public static let fondo = Color(red: 0.051, green: 0.078, blue: 0.141)

    /// Fondo más profundo, para zonas bajo el contenido (#070b14).
    public static let fondoProfundo = Color(red: 0.027, green: 0.043, blue: 0.078)

    /// Superficie de tarjetas y paneles (#131c30).
    public static let superficie = Color(red: 0.075, green: 0.110, blue: 0.188)

    /// Superficie elevada: controles dentro de una tarjeta (#1a2540).
    public static let superficieAlta = Color(red: 0.102, green: 0.145, blue: 0.251)

    /// Velo oscuro para superponer sobre la cámara.
    public static let velo = Color(red: 0.012, green: 0.024, blue: 0.047).opacity(0.72)

    // MARK: Líneas

    /// Borde sutil de tarjetas y separadores.
    public static let borde = Color.white.opacity(0.08)

    /// Borde marcado (foco, selección).
    public static let bordeFuerte = Color.white.opacity(0.16)

    // MARK: Acento y semánticos

    /// Acento principal, esmeralda (#10b981).
    public static let acento = Color(red: 0.063, green: 0.725, blue: 0.506)

    /// Acento claro para resaltes y brillos (#34d399).
    public static let acentoClaro = Color(red: 0.204, green: 0.827, blue: 0.600)

    /// Acento oscuro para bordes y presionados (#059669).
    public static let acentoOscuro = Color(red: 0.020, green: 0.588, blue: 0.412)

    /// Texto que va encima del acento (#04110b).
    public static let textoSobreAcento = Color(red: 0.016, green: 0.067, blue: 0.043)

    /// Secundario cielo, para datos de GPS y enlaces (#38bdf8).
    public static let cielo = Color(red: 0.220, green: 0.741, blue: 0.973)

    /// Estado correcto / escaneo con buena calidad (#34d399).
    public static let exito = Color(red: 0.204, green: 0.827, blue: 0.600)

    /// Advertencia: seguimiento pobre, precisión GPS baja (#f59e0b).
    public static let alerta = Color(red: 0.961, green: 0.620, blue: 0.043)

    /// Error o acción destructiva (#ef4444).
    public static let peligro = Color(red: 0.937, green: 0.267, blue: 0.267)

    // MARK: Texto

    /// Texto principal (#f1f5f9).
    public static let textoPrimario = Color(red: 0.945, green: 0.961, blue: 0.976)

    /// Texto secundario / descripciones (#a5afc4).
    public static let textoSecundario = Color(red: 0.647, green: 0.686, blue: 0.769)

    /// Texto terciario / pistas y marcas de agua (#6f7a94).
    public static let textoTerciario = Color(red: 0.435, green: 0.478, blue: 0.580)

    // MARK: Degradados

    /// Degradado de marca para botones principales y encabezados.
    public static let degradadoAcento = LinearGradient(
        colors: [acentoClaro, acento],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Degradado de fondo de las pantallas de contenido.
    public static let degradadoFondo = LinearGradient(
        colors: [fondo, fondoProfundo],
        startPoint: .top,
        endPoint: .bottom
    )

    // MARK: Métricas

    /// Radio de esquina de tarjetas y paneles.
    public static let radioTarjeta: CGFloat = 16

    /// Radio de esquina de controles pequeños (chips, botones).
    public static let radioControl: CGFloat = 10

    /// Relleno interior estándar de una tarjeta.
    public static let rellenoTarjeta: CGFloat = 16

    /// Separación vertical estándar entre bloques.
    public static let separacion: CGFloat = 12

    // MARK: Tipografías

    /// Título de portada de una pantalla.
    public static let tipoTituloGrande = Font.system(.largeTitle, design: .rounded).weight(.bold)

    /// Título de sección.
    public static let tipoTitulo = Font.system(.title2, design: .rounded).weight(.semibold)

    /// Encabezado de tarjeta.
    public static let tipoEncabezado = Font.system(.headline, design: .rounded)

    /// Texto corrido.
    public static let tipoCuerpo = Font.system(.body, design: .default)

    /// Texto corrido destacado.
    public static let tipoCuerpoFuerte = Font.system(.body, design: .default).weight(.semibold)

    /// Texto auxiliar bajo un control.
    public static let tipoPie = Font.system(.footnote, design: .default)

    /// Etiqueta corta en mayúsculas (encabezados de columna, unidades).
    public static let tipoEtiqueta = Font.system(.caption, design: .rounded).weight(.semibold)

    /// Cifras del HUD: ancho fijo para que no bailen al actualizarse.
    public static let tipoNumero = Font.system(.title3, design: .monospaced).weight(.semibold)

    /// Cifras pequeñas de ancho fijo (contadores, coordenadas).
    public static let tipoNumeroPequeno = Font.system(.caption, design: .monospaced)
}

// MARK: - Tarjeta reutilizable

/// Aspecto estándar de una tarjeta de JoseScan: superficie oscura, esquinas
/// redondeadas, borde sutil y sombra suave. Cuando `resaltada` es verdadero el
/// borde toma el color de acento (selección, elemento activo).
public struct TarjetaJoseScan: ViewModifier {
    public var relleno: CGFloat
    public var radio: CGFloat
    public var resaltada: Bool

    public init(relleno: CGFloat = JoseTheme.rellenoTarjeta,
                radio: CGFloat = JoseTheme.radioTarjeta,
                resaltada: Bool = false) {
        self.relleno = relleno
        self.radio = radio
        self.resaltada = resaltada
    }

    public func body(content: Content) -> some View {
        content
            .padding(relleno)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: radio, style: .continuous)
                    .fill(JoseTheme.superficie)
            )
            .overlay(
                RoundedRectangle(cornerRadius: radio, style: .continuous)
                    .strokeBorder(resaltada ? JoseTheme.acento.opacity(0.55) : JoseTheme.borde,
                                  lineWidth: resaltada ? 1.5 : 1)
            )
            .shadow(color: Color.black.opacity(0.35), radius: 10, x: 0, y: 4)
    }
}

public extension View {
    /// Aplica el aspecto de tarjeta de JoseScan.
    /// - Parameters:
    ///   - relleno: relleno interior en puntos.
    ///   - radio: radio de las esquinas.
    ///   - resaltada: dibuja el borde en color de acento.
    func tarjetaJoseScan(relleno: CGFloat = JoseTheme.rellenoTarjeta,
                         radio: CGFloat = JoseTheme.radioTarjeta,
                         resaltada: Bool = false) -> some View {
        modifier(TarjetaJoseScan(relleno: relleno, radio: radio, resaltada: resaltada))
    }

    /// Pinta el fondo de marca detrás de una pantalla completa.
    func fondoJoseScan() -> some View {
        background(JoseTheme.degradadoFondo.ignoresSafeArea())
    }
}

#if DEBUG
struct TarjetaJoseScan_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: JoseTheme.separacion) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Cárcava K12+400")
                    .font(JoseTheme.tipoEncabezado)
                    .foregroundColor(JoseTheme.textoPrimario)
                Text("812.344 puntos · 98.120 triángulos")
                    .font(JoseTheme.tipoPie)
                    .foregroundColor(JoseTheme.textoSecundario)
            }
            .tarjetaJoseScan()

            Text("Escaneo seleccionado")
                .font(JoseTheme.tipoCuerpoFuerte)
                .foregroundColor(JoseTheme.textoPrimario)
                .tarjetaJoseScan(resaltada: true)
        }
        .padding()
        .fondoJoseScan()
        .preferredColorScheme(.dark)
    }
}
#endif
