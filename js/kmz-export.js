import { toMagnaSirgas } from './coords.js';

/**
 * Exporta un listado de marcadores (con nombres, fotos y coordenadas MAGNA-SIRGAS Origen Nacional) a un archivo KMZ
 * @param {Array} placemarks - Array de objetos placemark de CampoMaps
 * @param {string} filename - Nombre del archivo de salida
 */
export async function exportPlacemarksToKMZ(placemarks, filename = 'CampoMaps_Puntos_MAGNA.kmz') {
    if (!window.JSZip) {
        throw new Error('Librería JSZip no cargada. No es posible generar KMZ.');
    }

    if (!placemarks || placemarks.length === 0) {
        throw new Error('No hay marcadores para exportar.');
    }

    const zip = new window.JSZip();
    const filesFolder = zip.folder('files');

    let kmlPlacemarks = '';
    let photoCounter = 1;

    for (const pm of placemarks) {
        const magna = toMagnaSirgas(pm.lat, pm.lng);
        let photoHtml = '';

        if (pm.photos && pm.photos.length > 0) {
            for (const item of pm.photos) {
                const photoDataUrl = typeof item === 'string' ? item : (item.url || item.dataUrl);
                const headingLabel = typeof item === 'object' ? (item.headingLabel || (item.heading !== null && item.heading !== undefined ? `${Math.round(item.heading)}°` : '')) : '';

                if (photoDataUrl && photoDataUrl.startsWith('data:image')) {
                    const matches = photoDataUrl.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
                    if (matches) {
                        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
                        const base64Data = matches[2];
                        const photoName = `photo_${photoCounter}.${ext}`;
                        filesFolder.file(photoName, base64Data, { base64: true });
                        photoHtml += `
                            <div style="margin-top:10px;">
                                ${headingLabel ? `<div style="font-size:11px; color:#1e824c; font-weight:bold; margin-bottom:2px;">🧭 Sentido de foto: ${headingLabel}</div>` : ''}
                                <img src="files/${photoName}" style="max-width:350px; max-height:260px; border-radius:6px; border:1px solid #ccc;"/>
                            </div>
                        `;
                        photoCounter++;
                    }
                }
            }
        }

        const dateStr = pm.createdAt ? new Date(pm.createdAt).toLocaleString('es-CO') : '';
        const descContent = `<![CDATA[
            <div style="font-family:sans-serif; font-size:13px; color:#222; padding:4px;">
                <h3 style="color:#1a5276; margin:0 0 6px 0;">${pm.name || 'Marcador'}</h3>
                ${pm.description ? `<p style="margin:4px 0 8px 0;"><b>Notas:</b> ${pm.description}</p>` : ''}
                <div style="background:#eaf2f8; padding:8px; border-radius:6px; margin:8px 0; border-left:4px solid #2980b9;">
                    <b>Coordenadas MAGNA-SIRGAS Origen Nacional (EPSG:9377):</b><br/>
                    <span style="font-size:14px; font-weight:bold; color:#1a5276;">${magna.formatted}</span><br/>
                    <span style="font-size:11px; color:#555;">WGS84: ${pm.lat.toFixed(6)}, ${pm.lng.toFixed(6)}</span>
                </div>
                ${dateStr ? `<small style="color:#888;">Fecha de captura: ${dateStr}</small><br/>` : ''}
                ${photoHtml}
            </div>
        ]]>`;

        kmlPlacemarks += `
        <Placemark id="pm_${pm.id || Math.random().toString(36).substr(2, 9)}">
            <name>${escapeXml(pm.name || 'Punto')}</name>
            <description>${descContent}</description>
            <Point>
                <coordinates>${pm.lng},${pm.lat},${pm.altitude || 0}</coordinates>
            </Point>
        </Placemark>
        `;
    }

    const docKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(filename.replace(/\.kmz$/i, ''))}</name>
    <description>Generado por CampoMaps - Sistema MAGNA-SIRGAS Origen Nacional (EPSG:9377)</description>
    <open>1</open>
    ${kmlPlacemarks}
  </Document>
</kml>`;

    zip.file('doc.kml', docKml);

    const blob = await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.google-earth.kmz',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });

    const file = new File([blob], filename, { type: 'application/vnd.google-earth.kmz' });

    // En iOS / Android: usar el menú nativo Compartir (AirDrop, Guardar en Archivos, WhatsApp)
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                title: 'CampoMaps - Exportación de Puntos',
                text: 'Puntos de campo con fotos y coordenadas MAGNA-SIRGAS Origen Nacional',
                files: [file]
            });
            return blob;
        } catch (err) {
            if (err.name === 'AbortError') return blob; // Usuario canceló el diálogo
            console.warn('Share falló, usando descarga estándar:', err);
        }
    }

    // Descargar directamente en el dispositivo (navegador / PC)
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 2500);

    return blob;
}

function escapeXml(unsafe) {
    return String(unsafe).replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}
