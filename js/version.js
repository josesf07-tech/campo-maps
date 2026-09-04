/**
 * CampoMaps - Versión única de la aplicación.
 *
 * Este archivo es un script clásico (no módulo ES) para que pueda ser usado
 * tanto por la página (window.CAMPOMAPS_VERSION) como por el Service Worker
 * (importScripts + self.CAMPOMAPS_VERSION).
 *
 * Al publicar una nueva versión, cambiar SOLO este valor y los sufijos ?v=
 * de index.html. El Service Worker y las cachés se renombran automáticamente.
 */
(function (root) {
    root.CAMPOMAPS_VERSION = 'v24';
})(typeof self !== 'undefined' ? self : window);
