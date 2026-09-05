/**
 * Estado compartido de la aplicación.
 *
 * Hay UN solo objeto `state` en toda la app: los módulos de interfaz lo
 * importan desde aquí y escriben sobre la misma referencia. Duplicarlo (crear
 * una segunda copia en otro módulo) rompe la app en silencio, porque cada
 * mitad vería su propio GPS, su propio proyecto activo y su propio mapa.
 */

// ========== APP STATE ==========
export const state = {
    gpsActive: false,
    autoCenter: true,
    trackRecording: false,
    trackPaused: false,
    coordFormat: 'DD', // DD, DMS, DDM
    units: 'metric', // metric, imperial
    currentPanel: null,
    currentProjectId: null,
    currentProjectName: 'Proyecto General',
    placemarkEditId: null,
    selectedIcon: 'default',
    mapEngine: null,
    gps: null,
    trackRecorder: null,
    placemarkManager: null,
    calibrator: null,
    measurementTool: null,
    tileDownloader: null,
    trackTimer: null,
    trackStartTime: null,
    lastLoadedGeoPdfBounds: null,
    lastLoadedGeoPdfName: '',
};

/** Versión canónica publicada por `js/version.js` (script clásico). */
export const APP_VERSION = window.CAMPOMAPS_VERSION || 'v25';
