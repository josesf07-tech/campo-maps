/**
 * Panel de Ajustes.
 *
 * Cablea los interruptores de ajustes (modo claro, estampado de fotos, nombre
 * de proyecto, buffer satelital, frecuencia del GPS), el borrado total de datos
 * locales y los botones de respaldo/restauración en .zip. El empaquetado del
 * respaldo vive en js/backup.js.
 */

import { state, APP_VERSION } from './state.js';
import { showLoading, hideLoading, showToast } from './ui-utils.js';
import { stopGPS } from './ui-gps.js';
import { saveSetting, getSetting, clearAllData } from './storage.js';
import { openBackupDialog, openRestoreDialog } from './backup.js';

// ========== SETTINGS ==========
export function setupSettings() {
    // Light mode toggle
    const toggleLight = document.getElementById('toggle-light-mode');
    if (toggleLight) {
        toggleLight.addEventListener('change', async () => {
            document.body.classList.toggle('light-mode', toggleLight.checked);
            applyThemeColor();
            await saveSetting('lightMode', toggleLight.checked);
        });
    }
    applyThemeColor();

    // Photo stamping toggle & Project Name
    const toggleStamp = document.getElementById('toggle-stamp-photos');
    const pmStampToggle = document.getElementById('pm-stamp-toggle');
    const inputProjectName = document.getElementById('input-project-name');

    if (toggleStamp) {
        toggleStamp.addEventListener('change', async () => {
            if (pmStampToggle) pmStampToggle.checked = toggleStamp.checked;
            await saveSetting('stampPhotos', toggleStamp.checked);
        });
    }

    if (inputProjectName) {
        inputProjectName.addEventListener('change', async () => {
            await saveSetting('projectName', inputProjectName.value.trim());
        });
    }

    // Auto download 2km satellite buffer on GeoPDF load
    const toggleAutoDl = document.getElementById('toggle-auto-dl-geopdf');
    if (toggleAutoDl) {
        toggleAutoDl.addEventListener('change', async () => {
            await saveSetting('autoDownloadSatelliteBuffer', toggleAutoDl.checked);
            showToast(toggleAutoDl.checked ? '🛰️ Auto-descarga de 2 km satélite activada' : 'Auto-descarga satelital desactivada');
        });
    }

    // Frecuencia de actualización GPS
    const selectGpsFreq = document.getElementById('select-gps-freq');
    if (selectGpsFreq) {
        selectGpsFreq.addEventListener('change', async () => {
            const ms = parseInt(selectGpsFreq.value, 10) || 1000;
            state.gps.setMinInterval(ms);
            await saveSetting('gpsFrequency', ms);
            showToast(`📡 GPS cada ${ms / 1000} s`);
        });
    }

    // Expose saveSetting globally for modal quick toggles
    window.__campoMapsSaveSetting = saveSetting;

    // Load saved settings
    (async () => {
        try {
            const savedStamp = await getSetting('stampPhotos');
            if (savedStamp && savedStamp.value !== undefined) {
                if (toggleStamp) toggleStamp.checked = savedStamp.value;
                if (pmStampToggle) pmStampToggle.checked = savedStamp.value;
            }
            const savedProject = await getSetting('projectName');
            if (savedProject && savedProject.value && inputProjectName) {
                inputProjectName.value = savedProject.value;
            }
            const savedAutoDl = await getSetting('autoDownloadSatelliteBuffer');
            if (savedAutoDl && savedAutoDl.value !== undefined && toggleAutoDl) {
                toggleAutoDl.checked = !!savedAutoDl.value;
            }
        } catch (e) {
            console.warn('Error cargando ajustes:', e);
        }
    })();
}

export function applyThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', document.body.classList.contains('light-mode') ? '#ffffff' : '#0d1424');
}

// ========== BORRADO DE DATOS ==========
export function setupDataReset() {
    const btn = document.getElementById('btn-clear-all-data');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const ok = confirm('Se borrarán TODOS los proyectos, marcadores, fotos, rutas, planos y mapas offline guardados en este dispositivo.\n\nEsta acción no se puede deshacer. ¿Continuar?');
        if (!ok) return;
        const ok2 = confirm('Última confirmación: ¿borrar todos los datos locales de JoseMaps?');
        if (!ok2) return;
        try {
            showLoading('Borrando datos locales...');
            if (state.gpsActive) stopGPS();
            await clearAllData();
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.filter(k => k.startsWith('campo-maps-tiles')).map(k => caches.delete(k)));
            }
            hideLoading();
            showToast('🧹 Datos borrados. Reiniciando...');
            setTimeout(() => window.location.reload(), 900);
        } catch (err) {
            hideLoading();
            console.error('Error borrando datos:', err);
            showToast('❌ No se pudieron borrar los datos: ' + (err.message || err));
        }
    });
}

// ========== RESPALDO Y RESTAURACION ==========
/**
 * Cablea los botones de respaldo (.zip) del panel de Ajustes.
 * La lógica de empaquetado y restauración vive en js/backup.js.
 */
export function setupBackup() {
    const btnExport = document.getElementById('btn-backup-export');
    const btnImport = document.getElementById('btn-backup-import');
    const inputFile = document.getElementById('input-backup-file');

    if (btnExport) {
        btnExport.addEventListener('click', () => {
            openBackupDialog({
                appVersion: APP_VERSION,
                projectId: state.currentProjectId,
                projectName: state.currentProjectName,
                showToast
            });
        });
    }

    if (btnImport && inputFile) {
        btnImport.addEventListener('click', () => {
            inputFile.value = '';
            inputFile.click();
        });

        inputFile.addEventListener('change', async () => {
            const file = inputFile.files && inputFile.files[0];
            if (!file) return;
            inputFile.value = '';

            await openRestoreDialog(file, {
                appVersion: APP_VERSION,
                showToast,
                // Tras restaurar se recarga la app: es la forma más segura de
                // dejar mapa, marcadores y proyecto activo coherentes con la
                // base recién escrita.
                onRestored: () => {
                    showToast('🔄 Recargando con los datos restaurados...');
                    setTimeout(() => window.location.reload(), 900);
                }
            });
        });
    }
}
