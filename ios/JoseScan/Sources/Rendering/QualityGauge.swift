//
//  QualityGauge.swift
//  JoseScan
//
//  Anillo de calidad reutilizable (0…100). No depende de ningún otro módulo:
//  se dibuja sólo con primitivas de SwiftUI (`Circle().trim` y `Path`) para
//  poder usarse tanto sobre la cámara como dentro de listas y hojas.
//

import Foundation
import SwiftUI

/// Indicador circular de calidad del escaneo.
///
/// Muestra un anillo de progreso de 0 a 100 con el color interpolado de rojo a
/// ámbar y de ámbar a verde, el número en el centro y una etiqueta debajo.
public struct QualityGauge: View {

    /// Puntuación a mostrar; se recorta al rango 0…100.
    public var valor: Int
    /// Texto bajo el número. Por defecto "Calidad".
    public var etiqueta: String
    /// Diámetro exterior del anillo en puntos.
    public var diametro: CGFloat
    /// Grosor del trazo del anillo en puntos.
    public var grosor: CGFloat
    /// Si es `true` dibuja las marcas de 0, 25, 50, 75 y 100.
    public var conMarcas: Bool

    public init(valor: Int,
                etiqueta: String = "Calidad",
                diametro: CGFloat = 96,
                grosor: CGFloat = 10,
                conMarcas: Bool = true) {
        self.valor = valor
        self.etiqueta = etiqueta
        self.diametro = diametro
        self.grosor = grosor
        self.conMarcas = conMarcas
    }

    // MARK: - Cálculos

    /// Puntuación recortada al rango válido.
    private var valorAcotado: Int {
        Swift.min(Swift.max(valor, 0), 100)
    }

    /// Fracción 0…1 usada por el recorte del anillo.
    private var fraccion: Double {
        Double(valorAcotado) / 100.0
    }

    /// Color actual del anillo.
    private var color: Color {
        QualityGauge.color(para: valorAcotado)
    }

    /// Descripción corta del nivel, usada en accesibilidad.
    private var nivel: String {
        switch valorAcotado {
        case 0..<35: return "baja"
        case 35..<70: return "aceptable"
        default: return "buena"
        }
    }

    /// Interpola rojo → ámbar → verde según la puntuación 0…100.
    public static func color(para puntaje: Int) -> Color {
        let t = Swift.min(Swift.max(Double(puntaje), 0), 100) / 100.0
        let rojo: (r: Double, g: Double, b: Double) = (0.86, 0.20, 0.18)
        let ambar: (r: Double, g: Double, b: Double) = (0.98, 0.68, 0.12)
        let verde: (r: Double, g: Double, b: Double) = (0.16, 0.72, 0.36)

        let inicio: (r: Double, g: Double, b: Double)
        let fin: (r: Double, g: Double, b: Double)
        let u: Double
        if t < 0.5 {
            inicio = rojo
            fin = ambar
            u = t / 0.5
        } else {
            inicio = ambar
            fin = verde
            u = (t - 0.5) / 0.5
        }
        return Color(red: inicio.r + (fin.r - inicio.r) * u,
                     green: inicio.g + (fin.g - inicio.g) * u,
                     blue: inicio.b + (fin.b - inicio.b) * u)
    }

    // MARK: - Cuerpo

    public var body: some View {
        ZStack {
            // Pista de fondo del anillo.
            Circle()
                .stroke(Color.white.opacity(0.22), lineWidth: grosor)

            // Marcas cada 25 puntos, dibujadas con Path.
            if conMarcas {
                marcas
            }

            // Progreso.
            Circle()
                .trim(from: 0, to: fraccion)
                .stroke(color, style: StrokeStyle(lineWidth: grosor, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .shadow(color: color.opacity(0.55), radius: 4)

            // Número y etiqueta.
            VStack(spacing: 0) {
                Text("\(valorAcotado)")
                    .font(.system(size: diametro * 0.32, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(.white)
                Text(etiqueta)
                    .font(.system(size: Swift.max(9, diametro * 0.13), weight: .semibold))
                    .foregroundColor(.white.opacity(0.75))
            }
        }
        .frame(width: diametro, height: diametro)
        .animation(.easeInOut(duration: 0.35), value: valorAcotado)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(etiqueta) del escaneo"))
        .accessibilityValue(Text("\(valorAcotado) de 100, calidad \(nivel)"))
    }

    /// Cuatro marcas radiales que dividen el anillo en cuartos.
    private var marcas: some View {
        let radioExterno = diametro / 2 - grosor * 0.05
        let radioInterno = diametro / 2 - grosor * 0.95
        return Path { trazo in
            let centro = CGPoint(x: diametro / 2, y: diametro / 2)
            for i in 0..<4 {
                let angulo = Double(i) * (Double.pi / 2) - Double.pi / 2
                let dx = CGFloat(cos(angulo))
                let dy = CGFloat(sin(angulo))
                trazo.move(to: CGPoint(x: centro.x + dx * radioInterno,
                                       y: centro.y + dy * radioInterno))
                trazo.addLine(to: CGPoint(x: centro.x + dx * radioExterno,
                                          y: centro.y + dy * radioExterno))
            }
        }
        .stroke(Color.black.opacity(0.35), lineWidth: 1.5)
        .frame(width: diametro, height: diametro)
    }
}
