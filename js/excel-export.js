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
 * con la estructura multi-cabecera oficial (ANLA / Corporaciones Ambientales)
 * e incrusta en la última columna la primer fotografía tomada por cada predio.
 * @param {Array} placemarks - Lista de puntos guardados en CampoMaps
 * @param {string} filename - Nombre del archivo de salida
 */
export async function exportUsoUsuariosToExcel(placemarks, filename = 'Censo_Uso_y_Usuarios_MAGNA.xlsx') {
    if (window.ExcelJS) {
        return await exportWithExcelJS(placemarks, filename);
    } else if (window.XLSX) {
        return await exportWithSheetJS(placemarks, filename);
    } else {
        throw new Error('No se encontró una librería para generar archivos Excel (ExcelJS o XLSX).');
    }
}

/**
 * Exportador enriquecido con ExcelJS (permite incrustar imágenes nativas en las celdas de Excel)
 */
async function exportWithExcelJS(placemarks, filename) {
    const ExcelJS = window.ExcelJS;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CampoMaps';
    wb.created = new Date();

    const ws = wb.addWorksheet('USO Y USUARIOS', {
        views: [{ showGridLines: true }]
    });

    // Fila 0: Nivel superior (101 columnas: 0 a 100)
    const row0 = new Array(101).fill('');
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
    row0[100] = 'FOTOGRAFÍA';

    // Fila 1: Nivel intermedio
    const row1 = new Array(101).fill('');
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
    const row2 = new Array(101).fill('');
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
    row2[89] = 'Otros Usos';

    const headerRow0 = ws.addRow(row0);
    const headerRow1 = ws.addRow(row1);
    const headerRow2 = ws.addRow(row2);

    headerRow0.height = 24;
    headerRow1.height = 22;
    headerRow2.height = 36;

    // Celdas combinadas (ExcelJS usa 1-based indexing: [top, left, bottom, right])
    const merges = [
        // Nivel 1:
        [1, 1, 3, 1],       // ID (Col 1, Fila 1-3)
        [1, 2, 1, 3],       // ID Campo (Cols 2-3, Fila 1)
        [1, 4, 1, 5],       // ID Final (Cols 4-5, Fila 1)
        [1, 6, 3, 6],       // Municipio (Col 6, Fila 1-3)
        [1, 7, 3, 7],       // Vereda (Col 7, Fila 1-3)
        [1, 8, 3, 8],       // Nombre del predio (Col 8, Fila 1-3)
        [1, 9, 3, 9],       // Habitantes (Col 9, Fila 1-3)
        [1, 10, 1, 90],     // Usos del recurso Hídrico (Cols 10-90, Fila 1)
        [1, 91, 1, 99],     // Manejo de residuos (Cols 91-99, Fila 1)
        [1, 100, 3, 100],   // Cota (Col 100, Fila 1-3)
        [1, 101, 3, 101],   // FOTOGRAFÍA (Col 101, Fila 1-3)

        // Nivel 2:
        [2, 2, 2, 3],       // Coordenadas Campo (Cols 2-3, Fila 2)
        [2, 4, 2, 5],       // Coordenadas Final (Cols 4-5, Fila 2)
        [2, 10, 2, 29],     // Primaria doméstica (Cols 10-29, Fila 2)
        [2, 30, 2, 49],     // Secundaria doméstica (Cols 30-49, Fila 2)
        [2, 50, 2, 69],     // Uso Pecuario (Cols 50-69, Fila 2)
        [2, 70, 2, 89],     // Uso Agrícola (Cols 70-89, Fila 2)
        [2, 90, 3, 90],     // Otros Usos (Col 90, Fila 2-3)
        [2, 91, 2, 94],     // Residuos Líquidos (Cols 91-94, Fila 2)
        [2, 95, 2, 99],     // Residuos Sólidos (Cols 95-99, Fila 2)
    ];

    merges.forEach(([top, left, bottom, right]) => {
        ws.mergeCells(top, left, bottom, right);
    });

    // Estilos de cabecera
    const headerBorder = {
        top: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        left: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        bottom: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        right: { style: 'thin', color: { argb: 'FFB0C4DE' } }
    };

    [headerRow0, headerRow1, headerRow2].forEach(hRow => {
        hRow.eachCell({ includeEmpty: true }, (cell) => {
            cell.font = { name: 'Century Gothic', size: 8, bold: true, color: { argb: 'FF1A365D' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFEBF5FB' }
            };
            cell.border = headerBorder;
        });
    });

    // Procesar cada marcador
    let itemIndex = 1;
    let currentRowNum = 4; // Fila inicial de datos en Excel (1-based)

    for (const pm of placemarks) {
        const censo = pm.censoAgua || {};
        const magna = toMagnaSirgas(pm.lat, pm.lng);
        const este = Math.round(magna.este);
        const norte = Math.round(magna.norte);

        const row = new Array(101).fill('');
        row[0] = itemIndex++;
        row[1] = este;
        row[2] = norte;
        // Coordenada final ignorada (columnas 3 y 4 vacías)
        row[3] = '';
        row[4] = '';
        row[5] = censo.municipio || '';
        row[6] = censo.vereda || '';
        row[7] = censo.predio || pm.name || '';
        row[8] = censo.habitantes !== undefined && censo.habitantes !== '' ? Number(censo.habitantes) : '';

        // Helper para marcar opciones con X
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

        // Marcar Fuentes (soporta selección múltiple)
        marcarOpciones(censo.fuentePrimaria, FUENTES_AGUA, 9);
        marcarOpciones(censo.fuenteSecundaria, FUENTES_AGUA, 29);
        marcarOpciones(censo.fuentePecuario, FUENTES_AGUA, 49);
        marcarOpciones(censo.fuenteAgricola, FUENTES_AGUA, 69);

        // Otros usos
        row[89] = censo.otrosUsos || '';

        // Residuos Líquidos y Sólidos
        marcarOpciones(censo.residuoLiquido, RESIDUOS_LIQUIDOS, 90);
        marcarOpciones(censo.residuoSolido, RESIDUOS_SOLIDOS, 94);

        // Cota
        row[99] = censo.cota !== undefined && censo.cota !== '' 
            ? censo.cota 
            : (pm.altitude !== null ? Math.round(pm.altitude) : '');

        // Columna 100: Fotografía
        row[100] = '';

        const dataRow = ws.addRow(row);
        dataRow.eachCell({ includeEmpty: true }, (cell) => {
            cell.font = { name: 'Century Gothic', size: 8 };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
            };
        });

        // Insertar la primer foto tomada en la última columna
        if (pm.photos && pm.photos.length > 0) {
            const firstPhoto = pm.photos[0];
            const dataUrl = typeof firstPhoto === 'string' ? firstPhoto : (firstPhoto.dataUrl || firstPhoto.url || '');
            
            if (dataUrl && dataUrl.startsWith('data:image')) {
                dataRow.height = 75; // Altura para ver la foto con claridad

                try {
                    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
                    if (match) {
                        const rawExt = match[1].toLowerCase();
                        const extension = (rawExt === 'png') ? 'png' : 'jpeg';
                        const base64 = match[2];

                        const imageId = wb.addImage({
                            base64: base64,
                            extension: extension
                        });

                        // Col 100 es la columna 101 (0-indexed en tl)
                        // currentRowNum - 1 es la fila (0-indexed en tl)
                        ws.addImage(imageId, {
                            tl: { col: 100 + 0.1, row: (currentRowNum - 1) + 0.1 },
                            ext: { width: 110, height: 70 },
                            editAs: 'oneCell'
                        });
                    }
                } catch (imgErr) {
                    console.warn('No se pudo incrustar la imagen en Excel para el predio:', pm.name, imgErr);
                }
            }
        }

        currentRowNum++;
    }

    // Configurar anchos de columna
    for (let c = 1; c <= 101; c++) {
        ws.getColumn(c).width = 10;
    }
    ws.getColumn(1).width = 6;   // ID
    ws.getColumn(2).width = 13;  // Este Campo
    ws.getColumn(3).width = 13;  // Norte Campo
    ws.getColumn(4).width = 11;  // Este Final
    ws.getColumn(5).width = 11;  // Norte Final
    ws.getColumn(6).width = 16;  // Municipio
    ws.getColumn(7).width = 16;  // Vereda
    ws.getColumn(8).width = 24;  // Nombre del predio
    ws.getColumn(9).width = 12;  // Habitantes
    ws.getColumn(90).width = 18; // Otros Usos
    ws.getColumn(100).width = 9; // Cota
    ws.getColumn(101).width = 24; // FOTOGRAFÍA

    // Generar buffer y descargar
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Fallback a SheetJS si ExcelJS no estuviera disponible
 */
async function exportWithSheetJS(placemarks, filename) {
    const XLSX = window.XLSX;

    const row0 = new Array(101).fill('');
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
    row0[100] = 'FOTOGRAFÍA';

    const row1 = new Array(101).fill('');
    row1[1] = 'COORDENADAS MAGNA ORIGEN NACIONAL';
    row1[3] = 'COORDENADAS MAGNA ORIGEN NACIONAL';
    row1[9] = 'Fuente primaria de uso doméstico';
    row1[29] = 'Fuente Secundaria de uso doméstico';
    row1[49] = 'Fuente uso Pecuario';
    row1[69] = 'Fuente uso Agrícolas';
    row1[89] = 'Otros Usos';
    row1[90] = 'Manejo de residuos Líquidos';
    row1[94] = 'Manejo de residuos Sólidos';

    const row2 = new Array(101).fill('');
    row2[1] = 'ESTE';
    row2[2] = 'NORTE';
    row2[3] = 'ESTE';
    row2[4] = 'NORTE';

    for (let i = 0; i < 20; i++) {
        row2[9 + i] = FUENTES_AGUA[i];
        row2[29 + i] = FUENTES_AGUA[i];
        row2[49 + i] = FUENTES_AGUA[i];
        row2[69 + i] = FUENTES_AGUA[i];
    }
    for (let i = 0; i < 4; i++) row2[90 + i] = RESIDUOS_LIQUIDOS[i];
    for (let i = 0; i < 5; i++) row2[94 + i] = RESIDUOS_SOLIDOS[i];
    row2[89] = 'Otros Usos';

    const dataRows = [row0, row1, row2];
    const merges = [
        { s: { r: 0, c: 0 }, e: { r: 2, c: 0 } },
        { s: { r: 0, c: 1 }, e: { r: 0, c: 2 } },
        { s: { r: 0, c: 3 }, e: { r: 0, c: 4 } },
        { s: { r: 0, c: 5 }, e: { r: 2, c: 5 } },
        { s: { r: 0, c: 6 }, e: { r: 2, c: 6 } },
        { s: { r: 0, c: 7 }, e: { r: 2, c: 7 } },
        { s: { r: 0, c: 8 }, e: { r: 2, c: 8 } },
        { s: { r: 0, c: 9 }, e: { r: 0, c: 89 } },
        { s: { r: 0, c: 90 }, e: { r: 0, c: 98 } },
        { s: { r: 0, c: 99 }, e: { r: 2, c: 99 } },
        { s: { r: 0, c: 100 }, e: { r: 2, c: 100 } },

        { s: { r: 1, c: 1 }, e: { r: 1, c: 2 } },
        { s: { r: 1, c: 3 }, e: { r: 1, c: 4 } },
        { s: { r: 1, c: 9 }, e: { r: 1, c: 28 } },
        { s: { r: 1, c: 29 }, e: { r: 1, c: 48 } },
        { s: { r: 1, c: 49 }, e: { r: 1, c: 68 } },
        { s: { r: 1, c: 69 }, e: { r: 1, c: 88 } },
        { s: { r: 1, c: 89 }, e: { r: 2, c: 89 } },
        { s: { r: 1, c: 90 }, e: { r: 1, c: 93 } },
        { s: { r: 1, c: 94 }, e: { r: 1, c: 98 } },
    ];

    let itemIndex = 1;
    for (const pm of placemarks) {
        const censo = pm.censoAgua || {};
        const magna = toMagnaSirgas(pm.lat, pm.lng);
        const row = new Array(101).fill('');
        row[0] = itemIndex++;
        row[1] = Math.round(magna.este);
        row[2] = Math.round(magna.norte);
        row[3] = '';
        row[4] = '';
        row[5] = censo.municipio || '';
        row[6] = censo.vereda || '';
        row[7] = censo.predio || pm.name || '';
        row[8] = censo.habitantes !== undefined && censo.habitantes !== '' ? Number(censo.habitantes) : '';

        const marcar = (sel, ref, col) => {
            if (!sel) return;
            const items = Array.isArray(sel) ? sel : [sel];
            items.forEach(it => {
                const idx = ref.indexOf(it);
                if (idx !== -1) row[col + idx] = 'X';
            });
        };

        marcar(censo.fuentePrimaria, FUENTES_AGUA, 9);
        marcar(censo.fuenteSecundaria, FUENTES_AGUA, 29);
        marcar(censo.fuentePecuario, FUENTES_AGUA, 49);
        marcar(censo.fuenteAgricola, FUENTES_AGUA, 69);
        row[89] = censo.otrosUsos || '';
        marcar(censo.residuoLiquido, RESIDUOS_LIQUIDOS, 90);
        marcar(censo.residuoSolido, RESIDUOS_SOLIDOS, 94);
        row[99] = censo.cota || (pm.altitude !== null ? Math.round(pm.altitude) : '');
        row[100] = (pm.photos && pm.photos.length > 0) ? '[Foto adjunta]' : '';

        dataRows.push(row);
    }

    const ws = XLSX.utils.aoa_to_sheet(dataRows);
    ws['!merges'] = merges;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'USO Y USUARIOS');
    XLSX.writeFile(wb, filename);
}
