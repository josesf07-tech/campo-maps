import { toMagnaSirgas } from './coords.js';

/**
 * Generador de Registro Fotográfico en Microsoft Word (.docx)
 * Formato y tipografía idénticos a la plantilla de referencia (Century Gothic 8pt, 2 fotos por fila, MAGNA-SIRGAS Origen Nacional)
 */
export async function exportPlacemarksToDocx(placemarks, options = {}) {
    if (!window.JSZip) {
        throw new Error('Librería JSZip no cargada. No es posible generar el documento Word.');
    }

    const capitulo = options.capitulo || 5;
    const filename = options.filename || `Registro_Fotografico_MAGNA_Cap${capitulo}.docx`;
    const etiquetaCoords = options.etiquetaCoords || 'Coordenadas Magna Sirgas Origen Nacional ';

    // 1. Extraer todas las fotos asociadas a los placemarks
    const fotosItems = [];
    for (const pm of placemarks) {
        if (!pm.photos || pm.photos.length === 0) continue;
        const magna = toMagnaSirgas(pm.lat, pm.lng);
        const este = Math.round(magna.este);
        const norte = Math.round(magna.norte);
        const fecha = pm.createdAt ? new Date(pm.createdAt) : new Date();

        for (const photo of pm.photos) {
            const dataUrl = typeof photo === 'string' ? photo : (photo.url || photo.dataUrl);
            const headingLabel = typeof photo === 'object' && photo.headingLabel ? photo.headingLabel : null;
            if (dataUrl && dataUrl.startsWith('data:image')) {
                fotosItems.push({
                    dataUrl,
                    name: pm.name || 'Punto de muestreo',
                    description: pm.description || '',
                    headingLabel,
                    este,
                    norte,
                    fecha
                });
            }
        }
    }

    if (fotosItems.length === 0) {
        throw new Error('No hay fotos en los marcadores seleccionados para exportar.');
    }

    const zip = new window.JSZip();

    // 2. [Content_Types].xml
    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
    zip.file('[Content_Types].xml', contentTypesXml);

    // 3. _rels/.rels
    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    zip.folder('_rels').file('.rels', rootRelsXml);

    // 4. Procesar imágenes y construir media + document.xml.rels
    const mediaFolder = zip.folder('word').folder('media');
    let relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n`;

    fotosItems.forEach((item, index) => {
        const imgIndex = index + 1;
        const relId = `rId${imgIndex + 1}`; // rId1 is reserved or standard
        item.relId = relId;
        item.imgIndex = imgIndex;

        const matches = item.dataUrl.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (matches) {
            const base64Data = matches[2];
            mediaFolder.file(`image${imgIndex}.jpeg`, base64Data, { base64: true });
            relsXml += `  <Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imgIndex}.jpeg"/>\n`;
        }
    });
    relsXml += `</Relationships>`;
    zip.folder('word').folder('_rels').file('document.xml.rels', relsXml);

    // 5. Construir word/document.xml con tablas de 2 fotos por fila
    let tablesXml = '';
    const totalFotos = fotosItems.length;

    function escapeXml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function formatDate(d) {
        return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
    }

    for (let i = 0; i < totalFotos; i += 2) {
        const fotoIzq = fotosItems[i];
        const fotoDer = (i + 1 < totalFotos) ? fotosItems[i + 1] : null;

        const seqIzq = i + 1;
        const seqDer = i + 2;

        const descIzq = escapeXml(fotoIzq.name + (fotoIzq.description ? ` - ${fotoIzq.description}` : '') + (fotoIzq.headingLabel ? ` (${fotoIzq.headingLabel})` : ''));
        const fechaIzq = formatDate(fotoIzq.fecha);

        // Fila 1: Imagen izquierda + Separador + Imagen derecha
        const cellImgIzq = `
          <w:tc>
            <w:tcPr>
              <w:tcW w:w="4015" w:type="dxa"/>
              <w:vAlign w:val="center"/>
            </w:tcPr>
            <w:p>
              <w:pPr><w:jc w:val="center"/></w:pPr>
              <w:r>
                <w:drawing>
                  <wp:inline distT="0" distB="0" distL="0" distR="0">
                    <wp:extent cx="2412000" cy="1800000"/>
                    <wp:effectExtent l="0" t="0" r="0" b="0"/>
                    <wp:docPr id="${seqIzq}" name="Foto ${seqIzq}"/>
                    <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
                    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                          <pic:nvPicPr><pic:cNvPr id="${seqIzq}" name="Imagen ${seqIzq}"/><pic:cNvPicPr/></pic:nvPicPr>
                          <pic:blipFill><a:blip r:embed="${fotoIzq.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2412000" cy="1800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
                        </pic:pic>
                      </a:graphicData>
                    </a:graphic>
                  </wp:inline>
                </w:drawing>
              </w:r>
            </w:p>
          </w:tc>`;

        const cellSep = `
          <w:tc>
            <w:tcPr><w:tcW w:w="481" w:type="dxa"/></w:tcPr>
            <w:p/>
          </w:tc>`;

        let cellImgDer = `
          <w:tc>
            <w:tcPr><w:tcW w:w="4015" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>
            <w:p/>
          </w:tc>`;

        if (fotoDer) {
            cellImgDer = `
          <w:tc>
            <w:tcPr>
              <w:tcW w:w="4015" w:type="dxa"/>
              <w:vAlign w:val="center"/>
            </w:tcPr>
            <w:p>
              <w:pPr><w:jc w:val="center"/></w:pPr>
              <w:r>
                <w:drawing>
                  <wp:inline distT="0" distB="0" distL="0" distR="0">
                    <wp:extent cx="2412000" cy="1800000"/>
                    <wp:effectExtent l="0" t="0" r="0" b="0"/>
                    <wp:docPr id="${seqDer}" name="Foto ${seqDer}"/>
                    <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
                    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                          <pic:nvPicPr><pic:cNvPr id="${seqDer}" name="Imagen ${seqDer}"/><pic:cNvPicPr/></pic:nvPicPr>
                          <pic:blipFill><a:blip r:embed="${fotoDer.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2412000" cy="1800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
                        </pic:pic>
                      </a:graphicData>
                    </a:graphic>
                  </wp:inline>
                </w:drawing>
              </w:r>
            </w:p>
          </w:tc>`;
        }

        // Fila 2: Leyenda izquierda + Separador + Leyenda derecha
        const cellTextIzq = `
          <w:tc>
            <w:tcPr><w:tcW w:w="4015" w:type="dxa"/></w:tcPr>
            <w:p>
              <w:pPr><w:pStyle w:val="Descripcin"/><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr>
              <w:r><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">Fotografía ${seqIzq}: ${descIzq} </w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:b/><w:bCs/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr>
              <w:r><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:b/><w:bCs/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>Fecha: ${fechaIzq}</w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr>
              <w:r><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">${escapeXml(etiquetaCoords)}</w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr>
              <w:r><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>E: ${fotoIzq.este} N: ${fotoIzq.norte}</w:t></w:r>
            </w:p>
          </w:tc>`;

        let cellTextDer = `
          <w:tc>
            <w:tcPr><w:tcW w:w="4015" w:type="dxa"/></w:tcPr>
            <w:p/>
          </w:tc>`;

        if (fotoDer) {
            const descDer = escapeXml(fotoDer.name + (fotoDer.description ? ` - ${fotoDer.description}` : '') + (fotoDer.headingLabel ? ` (${fotoDer.headingLabel})` : ''));
            const fechaDer = formatDate(fotoDer.fecha);

            cellTextDer = `
          <w:tc>
            <w:tcPr><w:tcW w:w="4015" w:type="dxa"/></w:tcPr>
            <w:p>
              <w:pPr><w:pStyle w:val="Descripcin"/><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr>
              <w:r><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">Fotografía ${seqDer}: ${descDer} </w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:b/><w:bCs/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr>
              <w:r><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:b/><w:bCs/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>Fecha: ${fechaDer}</w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr>
              <w:r><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">${escapeXml(etiquetaCoords)}</w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr>
              <w:r><w:rPr><w:rFonts w:ascii="Century Gothic" w:hAnsi="Century Gothic" w:cs="Century Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>E: ${fotoDer.este} N: ${fotoDer.norte}</w:t></w:r>
            </w:p>
          </w:tc>`;
        }

        tablesXml += `
        <w:tbl>
          <w:tblPr>
            <w:tblW w:w="8838" w:type="dxa"/>
            <w:jc w:val="center"/>
            <w:tblBorders>
              <w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/>
            </w:tblBorders>
          </w:tblPr>
          <w:tblGrid>
            <w:gridCol w:w="4015"/>
            <w:gridCol w:w="481"/>
            <w:gridCol w:w="4015"/>
          </w:tblGrid>
          <w:tr>
            ${cellImgIzq}
            ${cellSep}
            ${cellImgDer}
          </w:tr>
          <w:tr>
            ${cellTextIzq}
            ${cellSep}
            ${cellTextDer}
          </w:tr>
        </w:tbl>
        <w:p><w:pPr><w:spacing w:after="240"/></w:pPr></w:p>
        `;
    }

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
            xmlns:v="urn:schemas-microsoft-com:vml"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:w10="urn:schemas-microsoft-com:office:word"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${tablesXml}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1701" w:bottom="1440" w:left="1701"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    zip.folder('word').file('document.xml', documentXml);

    // 6. Generar Blob y descargar
    const blob = await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}
