import { toMagnaSirgas } from './coords.js';

export const FUENTES_AGUA = [
    'Río', 'Quebrada', 'Arroyo', 'Caño', 'Cañada', 
    'Lago', 'Laguna', 'Ciénaga', 'Pantano', 'Embalse', 
    'Estero', 'Jagüey', 'Estuario', 'Manantial', 'Aljibe', 
    'Pozo Profundo', 'Compra de agua', 'Nacedero', 'Agua Lluvia', 'N.A.'
];

export const RESIDUOS_LIQUIDOS = [
    'Pozo Séptico', 'Cuerpo de agua', 'Directo a suelos', 'Otro'
];

export const RESIDUOS_SOLIDOS = [
    'Quema', 'Entierro', 'Recolección de residuos', 'Alimentación de animales', 'Otro'
];

/**
 * Exporta el censo de "Uso y Usuarios del Recurso Hídrico" a un archivo Excel (.xlsx)
 * con la estructura multi-cabecera oficial (ANLA / Corporaciones Ambientales).
 * @param {Array} placemarks - Lista de puntos guardados en CampoMaps
 * @param {string} filename - Nombre del archivo de salida
 */
export async function exportUsoUsuariosToExcel(placemarks, filename = 'Censo_Uso_y_Usuarios_MAGNA.xlsx') {
    if (!window.XLSX) {
        throw new Error('La librería SheetJS (XLSX) no está cargada.');
    }

    const XLSX = window.XLSX;

    // Fila 0: Nivel superior
    const row0 = new Array(100).fill('');
    row0[0] = 'ID';
    row0[1] = 'ID Campo';
    row0[3] = 'ID Final';
    row0[5] = 'Municipio';
    row0[6] = 'Vereda';
    row0[7] = 'Nombre del predio';
    row0[8] = 'Número de personas que habitan en el predio';
    row0[9] = 'Usos del recurso Hídrico';
    row0[90] = 'Manejo de residuos';
    row0[99] = 'Cota';

    // Fila 1: Nivel intermedio
    const row1 = new Array(100).fill('');
    row1[1] = 'COORDENADAS MAGNA ORIGEN NACIONAL';
    row1[3] = 'COORDENADAS MAGNA ORIGEN NACIONAL';
    row1[9] = 'Fuente primaria de uso doméstico';
    row1[29] = 'Fuente Secundaria de uso doméstico';
    row1[49] = 'Fuente uso Pecuario';
    row1[69] = 'Fuente uso Agrícolas';
    row1[89] = 'Otros Usos';
    row1[90] = 'Manejo de residuos Líquidos';
    row1[94] = 'Manejo de residuos Sólidos';

    // Fila 2: Nivel detallado de columnas
    const row2 = new Array(100).fill('');
    row2[1] = 'ESTE';
    row2[2] = 'NORTE';
    row2[3] = 'ESTE';
    row2[4] = 'NORTE';

    // Rellenar fuentes para primaria, secundaria, pecuario, agrícola
    for (let i = 0; i < 20; i++) {
        row2[9 + i] = FUENTES_AGUA[i];
        row2[29 + i] = FUENTES_AGUA[i];
        row2[49 + i] = FUENTES_AGUA[i];
        row2[69 + i] = FUENTES_AGUA[i];
    }

    // Rellenar residuos
    for (let i = 0; i < 4; i++) {
        row2[90 + i] = RESIDUOS_LIQUIDOS[i];
    }
    for (let i = 0; i < 5; i++) {
        row2[94 + i] = RESIDUOS_SOLIDOS[i];
    }

    const dataRows = [row0, row1, row2];

    // Celdas combinadas (Merges)
    const merges = [
        // ID (Cols 0, Rows 0-2)
        { s: { r: 0, c: 0 }, e: { r: 2, c: 0 } },
        // ID Campo (Cols 1-2, Row 0)
        { s: { r: 0, c: 1 }, e: { r: 0, c: 2 } },
        // ID Final (Cols 3-4, Row 0)
        { s: { r: 0, c: 3 }, e: { r: 0, c: 4 } },
        // Municipio (Col 5, Rows 0-2)
        { s: { r: 0, c: 5 }, e: { r: 2, c: 5 } },
        // Vereda (Col 6, Rows 0-2)
        { s: { r: 0, c: 6 }, e: { r: 2, c: 6 } },
        // Nombre del predio (Col 7, Rows 0-2)
        { s: { r: 0, c: 7 }, e: { r: 2, c: 7 } },
        // Personas que habitan (Col 8, Rows 0-2)
        { s: { r: 0, c: 8 }, e: { r: 2, c: 8 } },
        // Usos del recurso Hídrico (Cols 9-89, Row 0)
        { s: { r: 0, c: 9 }, e: { r: 0, c: 89 } },
        // Manejo de residuos (Cols 90-98, Row 0)
        { s: { r: 0, c: 90 }, e: { r: 0, c: 98 } },
        // Cota (Col 99, Rows 0-2)
        { s: { r: 0, c: 99 }, e: { r: 2, c: 99 } },

        // Nivel 2:
        // COORDENADAS MAGNA ORIGEN NACIONAL (Cols 1-2, Row 1)
        { s: { r: 1, c: 1 }, e: { r: 1, c: 2 } },
        // COORDENADAS MAGNA ORIGEN NACIONAL (Cols 3-4, Row 1)
        { s: { r: 1, c: 3 }, e: { r: 1, c: 4 } },
        // Fuente primaria doméstica (Cols 9-28, Row 1)
        { s: { r: 1, c: 9 }, e: { r: 1, c: 28 } },
        // Fuente secundaria doméstica (Cols 29-48, Row 1)
        { s: { r: 1, c: 29 }, e: { r: 1, c: 48 } },
        // Fuente pecuario (Cols 49-68, Row 1)
        { s: { r: 1, c: 49 }, e: { r: 1, c: 68 } },
        // Fuente agrícola (Cols 69-88, Row 1)
        { s: { r: 1, c: 69 }, e: { r: 1, c: 88 } },
        // Otros usos (Col 89, Rows 1-2)
        { s: { r: 1, c: 89 }, e: { r: 2, c: 89 } },
        // Manejo residuos Líquidos (Cols 90-93, Row 1)
        { s: { r: 1, c: 90 }, e: { r: 1, c: 93 } },
        // Manejo residuos Sólidos (Cols 94-98, Row 1)
        { s: { r: 1, c: 94 }, e: { r: 1, c: 98 } },
    ];

    // Procesar cada marcador
    let itemIndex = 1;
    for (const pm of placemarks) {
        const censo = pm.censoAgua || {};
        const magna = toMagnaSirgas(pm.lat, pm.lng);
        const este = Math.round(magna.este);
        const norte = Math.round(magna.norte);

        const row = new Array(100).fill('');
        row[0] = itemIndex++;
        row[1] = este;
        row[2] = norte;
        // Ignorar coordenada final: columnas 3 y 4 se dejan vacías
        row[3] = '';
        row[4] = '';
        row[5] = censo.municipio || '';
        row[6] = censo.vereda || '';
        row[7] = censo.predio || pm.name || '';
        row[8] = censo.habitantes !== undefined && censo.habitantes !== '' ? Number(censo.habitantes) : '';

        // Helper para marcar opciones (soporta array múltiple o string único)
        const marcarOpciones = (seleccion, listaRef, offsetCol) => {
            if (!seleccion) return;
            const items = Array.isArray(seleccion) ? seleccion : [seleccion];
            for (const item of items) {
                if (!item) continue;
                const idx = listaRef.indexOf(item);
                if (idx !== -1) {
                    row[offsetCol + idx] = 'X';
                }
            }
        };

        // Marcar Fuentes (soporta múltiples selecciones)
        marcarOpciones(censo.fuentePrimaria, FUENTES_AGUA, 9);
        marcarOpciones(censo.fuenteSecundaria, FUENTES_AGUA, 29);
        marcarOpciones(censo.fuentePecuario, FUENTES_AGUA, 49);
        marcarOpciones(censo.fuenteAgricola, FUENTES_AGUA, 69);

        // Otros usos
        row[89] = censo.otrosUsos || '';

        // Residuos Líquidos y Sólidos (soporta múltiples selecciones)
        marcarOpciones(censo.residuoLiquido, RESIDUOS_LIQUIDOS, 90);
        marcarOpciones(censo.residuoSolido, RESIDUOS_SOLIDOS, 94);

        // Cota
        row[99] = censo.cota !== undefined && censo.cota !== '' 
            ? censo.cota 
            : (pm.altitude !== null ? Math.round(pm.altitude) : '');

        dataRows.push(row);
    }

    // Crear hoja y libro
    const ws = XLSX.utils.aoa_to_sheet(dataRows);
    ws['!merges'] = merges;

    // Configurar anchos de columna
    const colWidths = new Array(100).fill({ wch: 10 });
    colWidths[0] = { wch: 6 };  // ID
    colWidths[1] = { wch: 12 }; // Este Campo
    colWidths[2] = { wch: 12 }; // Norte Campo
    colWidths[3] = { wch: 12 }; // Este Final
    colWidths[4] = { wch: 12 }; // Norte Final
    colWidths[5] = { wch: 16 }; // Municipio
    colWidths[6] = { wch: 16 }; // Vereda
    colWidths[7] = { wch: 22 }; // Predio
    colWidths[8] = { wch: 12 }; // Habitantes
    colWidths[89] = { wch: 18 }; // Otros Usos
    colWidths[99] = { wch: 8 }; // Cota
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'USO Y USUARIOS');

    // Descargar archivo .xlsx
    XLSX.writeFile(wb, filename);
}
