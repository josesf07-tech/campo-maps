/**
 * Exportación del proyecto activo: KMZ, registro fotográfico Word y censo Excel.
 *
 * `getActivePlacemarks()` aplica el mismo filtro por proyecto que la lista de
 * marcadores: sin proyecto o con 'default_proj' entran los marcadores sin
 * `projectId`. El botón principal genera los tres archivos seguidos.
 */

import { state } from './state.js';
import { showLoading, hideLoading, showToast } from './ui-utils.js';
import { getPlacemarks } from './storage.js';
import { exportPlacemarksToKMZ } from './kmz-export.js';
import { exportPlacemarksToDocx } from './docx-export.js';
import { exportUsoUsuariosToExcel } from './excel-export.js';

export function setupExports() {
    // Export Helpers
    async function getActivePlacemarks() {
        const allPms = await getPlacemarks();
        const filtered = allPms.filter(pm => {
            if (!state.currentProjectId || state.currentProjectId === 'default_proj') {
                return !pm.projectId || pm.projectId === 'default_proj';
            }
            return pm.projectId === state.currentProjectId;
        });
        return filtered;
    }

    async function handleExportKmz() {
        const pms = await getActivePlacemarks();
        if (!pms || pms.length === 0) return;
        const projName = (state.currentProjectName || 'JoseMaps').replace(/[\s\/\\:*?"<>|]/g, '_');
        const dateStr = new Date().toISOString().slice(0, 10);
        await exportPlacemarksToKMZ(pms, `${projName}_Puntos_MAGNA_${dateStr}.kmz`);
    }

    async function handleExportDocx() {
        const pms = await getActivePlacemarks();
        if (!pms || pms.length === 0) return;
        const projName = (state.currentProjectName || 'JoseMaps').replace(/[\s\/\\:*?"<>|]/g, '_');
        const dateStr = new Date().toISOString().slice(0, 10);
        await exportPlacemarksToDocx(pms, {
            filename: `Registro_Fotografico_${projName}_${dateStr}.docx`,
            etiquetaCoords: 'Coordenadas Magna Sirgas Origen Nacional '
        });
    }

    async function handleExportExcelUso() {
        const pms = await getActivePlacemarks();
        if (!pms || pms.length === 0) return;
        const projName = (state.currentProjectName || 'JoseMaps').replace(/[\s\/\\:*?"<>|]/g, '_');
        const dateStr = new Date().toISOString().slice(0, 10);
        await exportUsoUsuariosToExcel(pms, `Censo_Uso_y_Usuarios_${projName}_${dateStr}.xlsx`);
    }

    // Unified Export Handler (KMZ + Word + Excel simultaneously)
    async function handleExportAll() {
        try {
            const pms = await getActivePlacemarks();
            if (!pms || pms.length === 0) {
                showToast(`⚠️ El proyecto "${state.currentProjectName}" no tiene marcadores para exportar`);
                return;
            }
            showLoading('Generando KMZ...');
            await handleExportKmz();
            await new Promise(r => setTimeout(r, 600));
            showLoading('Generando registro fotográfico Word...');
            await handleExportDocx();
            await new Promise(r => setTimeout(r, 600));
            showLoading('Generando censo Excel...');
            await handleExportExcelUso();
            hideLoading();
            showToast('🎉 Paquete completo (KMZ + Word + Excel) descargado');
        } catch (err) {
            hideLoading();
            console.error('Error en exportación completa:', err);
            showToast('❌ Error en exportación: ' + (err.message || err));
        }
    }

    // Attach to UI buttons
    const btnExportAllMain = document.getElementById('btn-export-all-main');
    if (btnExportAllMain) btnExportAllMain.addEventListener('click', handleExportAll);
    const btnSettingsAll = document.getElementById('btn-settings-export-all');
    if (btnSettingsAll) btnSettingsAll.addEventListener('click', handleExportAll);
}
