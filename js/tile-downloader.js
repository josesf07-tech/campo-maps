/**
 * CampoMaps - Descargador de Mosaicos de Mapa Base Offline (Pre-caching de Mapas)
 * Incluye cálculo de Buffer de 2 km alrededor de planos GeoPDF georreferenciados.
 */

export class TileDownloader {
    constructor(mapEngine) {
        this.mapEngine = mapEngine;
        this.isDownloading = false;
        this.abortController = null;
        this.activeGeoPdfBounds = null;
        this.activeGeoPdfName = '';
    }

    /**
     * Expande un cuadro delimitador (bounds) por N kilómetros en todas las direcciones
     * @param {L.LatLngBounds|Array} bounds 
     * @param {number} km - Distancia en kilómetros (default: 2 km)
     * @returns {L.LatLngBounds|Array}
     */
    expandBoundsByKm(bounds, km = 2) {
        let sw, ne;
        if (Array.isArray(bounds)) {
            sw = { lat: bounds[0][0], lng: bounds[0][1] };
            ne = { lat: bounds[1][0], lng: bounds[1][1] };
        } else if (bounds && bounds.getSouthWest && bounds.getNorthEast) {
            sw = bounds.getSouthWest();
            ne = bounds.getNorthEast();
        } else {
            return bounds;
        }

        const centerLat = (sw.lat + ne.lat) / 2;
        // 1 grado latitud ≈ 111.32 km
        const deltaLat = km / 111.32;
        // 1 grado longitud ≈ 111.32 * cos(lat) km
        const deltaLng = km / (111.32 * Math.max(0.05, Math.cos(centerLat * Math.PI / 180)));

        if (typeof window.L !== 'undefined') {
            return window.L.latLngBounds(
                [sw.lat - deltaLat, sw.lng - deltaLng],
                [ne.lat + deltaLat, ne.lng + deltaLng]
            );
        }
        return [
            [sw.lat - deltaLat, sw.lng - deltaLng],
            [ne.lat + deltaLat, ne.lng + deltaLng]
        ];
    }

    latLngToTile(lat, lng, zoom) {
        const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
        const latRad = lat * Math.PI / 180;
        const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
        return { x, y, z: zoom };
    }

    getTilesInBounds(bounds, minZoom, maxZoom) {
        const tiles = [];
        let sw, ne;

        if (Array.isArray(bounds)) {
            sw = { lat: bounds[0][0], lng: bounds[0][1] };
            ne = { lat: bounds[1][0], lng: bounds[1][1] };
        } else if (bounds && bounds.getSouthWest && bounds.getNorthEast) {
            sw = bounds.getSouthWest();
            ne = bounds.getNorthEast();
        } else {
            return tiles;
        }

        for (let z = minZoom; z <= maxZoom; z++) {
            const nwTile = this.latLngToTile(ne.lat, sw.lng, z);
            const seTile = this.latLngToTile(sw.lat, ne.lng, z);

            const minX = Math.min(nwTile.x, seTile.x);
            const maxX = Math.max(nwTile.x, seTile.x);
            const minY = Math.min(nwTile.y, seTile.y);
            const maxY = Math.max(nwTile.y, seTile.y);

            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    tiles.push({ x, y, z });
                }
            }
        }
        return tiles;
    }

    getTileUrl(tile, layerType = 'satellite') {
        const s = ['a', 'b', 'c'][Math.floor(Math.random() * 3)];
        if (layerType === 'satellite') {
            return `https://mt1.google.com/vt/lyrs=s&x=${tile.x}&y=${tile.y}&z=${tile.z}`;
        } else if (layerType === 'topo') {
            return `https://${s}.tile.opentopomap.org/${tile.z}/${tile.x}/${tile.y}.png`;
        } else {
            return `https://${s}.tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`;
        }
    }

    /**
     * Obtiene dinámicamente la caché de tiles activa de la PWA
     */
    async getActiveTileCache() {
        if (!('caches' in window)) return null;
        try {
            const keys = await caches.keys();
            const tileCacheKey = keys.find(k => k.startsWith('campo-maps-tiles-'));
            return await caches.open(tileCacheKey || 'campo-maps-tiles-v21');
        } catch (e) {
            console.warn('No se pudo abrir caché de mosaicos:', e);
            return null;
        }
    }

    /**
     * Muestra el diálogo general de descarga offline con opción de pantalla o GeoPDF + 2km
     */
    showDownloadDialog(currentLayerType = 'satellite', geoPdfBounds = null, geoPdfName = '') {
        const map = this.mapEngine?.map;
        if (!map) return;

        const activeBounds = geoPdfBounds || this.activeGeoPdfBounds;
        const activeName = geoPdfName || this.activeGeoPdfName || 'Plano GeoPDF Activo';

        // 1. Pantalla visible
        const screenBounds = map.getBounds();
        const curZoom = map.getZoom();
        const screenMinZ = curZoom;
        const screenMaxZ = Math.min(curZoom + 2, 18);
        const screenTiles = this.getTilesInBounds(screenBounds, screenMinZ, screenMaxZ);

        // 2. Buffer 2 km GeoPDF (si existe)
        let bufferBounds = null;
        let bufferTiles = [];
        if (activeBounds) {
            bufferBounds = this.expandBoundsByKm(activeBounds, 2);
            // Para campo: zooms 13 a 17 brindan excelente detalle de vías, ríos y predios
            const bufMinZ = 13;
            const bufMaxZ = 17;
            bufferTiles = this.getTilesInBounds(bufferBounds, bufMinZ, bufMaxZ);
        }

        let selectedMode = bufferBounds ? 'geopdf' : 'screen';

        let modal = document.getElementById('modal-offline-download');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-offline-download';
            modal.className = 'modal';
            document.getElementById('app-container').appendChild(modal);
        }

        const renderModalContent = () => {
            const isGeoPdfMode = selectedMode === 'geopdf' && bufferBounds;
            const targetTiles = isGeoPdfMode ? bufferTiles : screenTiles;
            const estMb = ((targetTiles.length * 18) / 1024).toFixed(1);
            const zoomText = isGeoPdfMode ? 'Zoom 13 a 17 (Nivel Ingeniería)' : `${screenMinZ} a ${screenMaxZ}`;

            modal.innerHTML = `
                <div class="modal-content" style="max-width: 440px;">
                    <header class="modal-header">
                        <h2>Descargar Imagen Satelital Offline</h2>
                        <button class="btn-close-modal" id="btn-close-offline-modal"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                    </header>
                    <div class="modal-body">
                        <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.4;">
                            Descarga mosaicos satelitales de alta resolución para navegar en campo <strong>100% sin conexión a internet</strong>.
                        </p>

                        ${bufferBounds ? `
                        <!-- Selector de Modo de Descarga -->
                        <div style="margin-bottom: 14px; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 10px; border: 1px solid var(--border-color);">
                            <label style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 6px; display: block;">Área de Cobertura:</label>
                            
                            <label style="display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer; background: ${selectedMode === 'geopdf' ? 'rgba(16, 185, 129, 0.15)' : 'transparent'}; border: 1px solid ${selectedMode === 'geopdf' ? 'var(--accent-primary)' : 'transparent'}; margin-bottom: 6px;">
                                <input type="radio" name="dl-mode" value="geopdf" ${selectedMode === 'geopdf' ? 'checked' : ''} style="accent-color: var(--accent-primary); margin-top: 2px;">
                                <div>
                                    <div style="font-size: 12.5px; font-weight: 700; color: #fff;">🎯 ${activeName} + Buffer de 2 km</div>
                                    <div style="font-size: 11px; color: var(--text-secondary);">Descarga 2 km a la redonda del perímetro del plano para caminos y accesos.</div>
                                </div>
                            </label>

                            <label style="display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer; background: ${selectedMode === 'screen' ? 'rgba(14, 165, 233, 0.15)' : 'transparent'}; border: 1px solid ${selectedMode === 'screen' ? 'var(--accent-azure)' : 'transparent'};">
                                <input type="radio" name="dl-mode" value="screen" ${selectedMode === 'screen' ? 'checked' : ''} style="accent-color: var(--accent-azure); margin-top: 2px;">
                                <div>
                                    <div style="font-size: 12.5px; font-weight: 700; color: #fff;">🖥️ Pantalla actual del mapa</div>
                                    <div style="font-size: 11px; color: var(--text-secondary);">Descarga el encuadre exacto que tienes en pantalla ahora mismo.</div>
                                </div>
                            </label>
                        </div>
                        ` : ''}

                        <!-- Ficha de Datos Técnicos -->
                        <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 10px; font-size: 12px; line-height: 1.6; border: 1px solid var(--border-color);">
                            <div style="display: flex; justify-content: space-between;">
                                <span>Capa satelital:</span>
                                <strong style="color: #38bdf8;">🛰️ Google Satélite HD</strong>
                            </div>
                            <div style="display: flex; justify-content: space-between;">
                                <span>Niveles de Zoom:</span>
                                <strong>${zoomText}</strong>
                            </div>
                            <div style="display: flex; justify-content: space-between;">
                                <span>Total Mosaicos:</span>
                                <strong style="color: #34d399;">${targetTiles.length} cuadros</strong>
                            </div>
                            <div style="display: flex; justify-content: space-between;">
                                <span>Espacio requerido:</span>
                                <strong style="color: #f59e0b;">~${estMb} MB</strong>
                            </div>
                        </div>
                        
                        <div id="download-progress-box" class="hidden" style="margin-top: 14px;">
                            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 6px;">
                                <span id="dl-status-text" style="color: var(--accent-primary); font-weight: 700;">Descargando...</span>
                                <span id="dl-percent-text" style="font-weight: 700;">0%</span>
                            </div>
                            <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">
                                <div id="dl-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981, #0ea5e9); transition: width 0.15s ease;"></div>
                            </div>
                        </div>
                    </div>
                    <footer class="modal-footer" style="display: flex; gap: 8px;">
                        <button type="button" class="btn-secondary" id="btn-cancel-dl" style="flex:1;">Cancelar</button>
                        <button type="button" class="btn-primary" id="btn-start-dl" style="flex:1.8;">
                            📥 Descargar (${estMb} MB)
                        </button>
                    </footer>
                </div>
            `;

            const btnClose = modal.querySelector('#btn-close-offline-modal');
            const btnCancel = modal.querySelector('#btn-cancel-dl');
            const btnStart = modal.querySelector('#btn-start-dl');

            modal.querySelectorAll('input[name="dl-mode"]').forEach(r => {
                r.addEventListener('change', (e) => {
                    selectedMode = e.target.value;
                    renderModalContent();
                });
            });

            const closeModal = () => {
                if (this.isDownloading) {
                    if (confirm('¿Deseas cancelar la descarga satelital en curso?')) {
                        this.cancel();
                        modal.classList.add('hidden');
                    }
                } else {
                    modal.classList.add('hidden');
                }
            };

            btnClose.addEventListener('click', closeModal);
            btnCancel.addEventListener('click', closeModal);

            btnStart.addEventListener('click', async () => {
                btnStart.disabled = true;
                btnStart.textContent = 'Descargando...';
                modal.querySelector('#download-progress-box').classList.remove('hidden');

                const pBar = modal.querySelector('#dl-progress-bar');
                const pStatus = modal.querySelector('#dl-status-text');
                const pPercent = modal.querySelector('#dl-percent-text');

                try {
                    await this.downloadTiles(targetTiles, 'satellite', (done, total) => {
                        const pct = Math.round((done / total) * 100);
                        pBar.style.width = `${pct}%`;
                        pPercent.textContent = `${pct}%`;
                        pStatus.textContent = `Descargando: ${done} de ${total} mosaicos`;
                    });

                    pStatus.textContent = '✅ ¡Descarga completada con éxito!';
                    pBar.style.width = '100%';
                    pPercent.textContent = '100%';
                    btnStart.textContent = 'Listo';
                    btnStart.disabled = false;
                    setTimeout(() => {
                        modal.classList.add('hidden');
                    }, 1400);
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        pStatus.textContent = '⚠️ Error en descarga: ' + err.message;
                        btnStart.textContent = 'Reintentar';
                        btnStart.disabled = false;
                    }
                }
            });
        };

        modal.classList.remove('hidden');
        renderModalContent();
    }

    /**
     * Pregunta inteligente y descarga de 2 km de satélite al cargar un GeoPDF
     */
    async promptAndDownloadGeoPdfBuffer(geoPdfBounds, mapName = 'Plano GeoPDF') {
        this.activeGeoPdfBounds = geoPdfBounds;
        this.activeGeoPdfName = mapName;

        const bufferBounds = this.expandBoundsByKm(geoPdfBounds, 2);
        const tiles = this.getTilesInBounds(bufferBounds, 13, 17);
        const estMb = ((tiles.length * 18) / 1024).toFixed(1);

        let modal = document.getElementById('modal-geopdf-buffer-prompt');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-geopdf-buffer-prompt';
            modal.className = 'modal';
            document.getElementById('app-container').appendChild(modal);
        }

        modal.classList.remove('hidden');
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 420px;">
                <header class="modal-header">
                    <h2>🛰️ Descarga Satelital Automática</h2>
                    <button class="btn-close-modal" id="btn-close-buffer-prompt"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                </header>
                <div class="modal-body">
                    <p style="font-size: 13px; color: var(--text-primary); margin-bottom: 12px; line-height: 1.4;">
                        Has agregado <strong>"${mapName}"</strong>. ¿Deseas descargar la imagen satelital de alta resolución en un <strong>perímetro de 2 km a la redonda</strong> para que funcione sin internet?
                    </p>

                    <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.35); padding: 12px; border-radius: 10px; font-size: 12px; line-height: 1.6; margin-bottom: 14px;">
                        <div style="display: flex; justify-content: space-between;">
                            <span>Buffer de seguridad:</span>
                            <strong style="color: #34d399;">2 km alrededor del plano</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>Niveles de Zoom:</span>
                            <strong>13 a 17 (Alta resolución)</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>Mosaicos a guardar:</span>
                            <strong style="color: #fff;">${tiles.length} cuadros</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span>Descarga estimada:</span>
                            <strong style="color: #f59e0b;">~${estMb} MB</strong>
                        </div>
                    </div>

                    <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); cursor: pointer;">
                        <input type="checkbox" id="check-remember-auto-dl" style="accent-color: var(--accent-primary); width: 16px; height: 16px;">
                        <span>Descargar siempre automáticamente en futuros planos</span>
                    </label>

                    <div id="buffer-dl-progress-box" class="hidden" style="margin-top: 14px;">
                        <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                            <span id="buf-status-text" style="color: var(--accent-primary); font-weight: 700;">Descargando...</span>
                            <span id="buf-percent-text" style="font-weight: 700;">0%</span>
                        </div>
                        <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">
                            <div id="buf-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981, #0ea5e9); transition: width 0.15s ease;"></div>
                        </div>
                    </div>
                </div>
                <footer class="modal-footer" style="display: flex; gap: 8px;">
                    <button type="button" class="btn-secondary" id="btn-skip-buffer-dl" style="flex:1;">Omitir</button>
                    <button type="button" class="btn-primary" id="btn-start-buffer-dl" style="flex:1.8;">
                        📥 Descargar 2 km Satélite
                    </button>
                </footer>
            </div>
        `;

        const btnClose = modal.querySelector('#btn-close-buffer-prompt');
        const btnSkip = modal.querySelector('#btn-skip-buffer-dl');
        const btnStart = modal.querySelector('#btn-start-buffer-dl');
        const checkRemember = modal.querySelector('#check-remember-auto-dl');

        const closePrompt = () => {
            modal.classList.add('hidden');
        };

        btnClose.addEventListener('click', closePrompt);
        btnSkip.addEventListener('click', closePrompt);

        btnStart.addEventListener('click', async () => {
            if (checkRemember && checkRemember.checked && window.__campoMapsSaveSetting) {
                await window.__campoMapsSaveSetting('autoDownloadSatelliteBuffer', true);
                const toggleSetting = document.getElementById('toggle-auto-dl-geopdf');
                if (toggleSetting) toggleSetting.checked = true;
            }

            btnStart.disabled = true;
            btnStart.textContent = 'Descargando...';
            modal.querySelector('#buffer-dl-progress-box').classList.remove('hidden');

            const pBar = modal.querySelector('#buf-progress-bar');
            const pStatus = modal.querySelector('#buf-status-text');
            const pPercent = modal.querySelector('#buf-percent-text');

            try {
                await this.downloadTiles(tiles, 'satellite', (done, total) => {
                    const pct = Math.round((done / total) * 100);
                    pBar.style.width = `${pct}%`;
                    pPercent.textContent = `${pct}%`;
                    pStatus.textContent = `Descargando: ${done} de ${total} mosaicos`;
                });

                pStatus.textContent = '✅ ¡Satélite 2 km descargado con éxito!';
                pBar.style.width = '100%';
                pPercent.textContent = '100%';
                btnStart.textContent = 'Listo';
                btnStart.disabled = false;
                setTimeout(() => {
                    modal.classList.add('hidden');
                }, 1500);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    pStatus.textContent = '⚠️ Error: ' + err.message;
                    btnStart.textContent = 'Reintentar';
                    btnStart.disabled = false;
                }
            }
        });
    }

    async downloadTiles(tiles, layerType, onProgress) {
        this.isDownloading = true;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        const cache = await this.getActiveTileCache();

        let completed = 0;
        const total = tiles.length;

        // Lotes de 8 peticiones paralelas para máxima velocidad
        const batchSize = 8;
        for (let i = 0; i < tiles.length; i += batchSize) {
            if (signal.aborted) break;

            const batch = tiles.slice(i, i + batchSize);
            await Promise.all(batch.map(async (tile) => {
                const url = this.getTileUrl(tile, layerType);
                try {
                    const res = await fetch(url, { signal, mode: 'cors' });
                    if (res.ok && cache) {
                        await cache.put(url, res.clone());
                    }
                } catch (e) {
                    // Ignora fallos transitorios de mosaicos individuales
                } finally {
                    completed++;
                    if (onProgress) onProgress(completed, total);
                }
            }));
        }

        this.isDownloading = false;
    }

    cancel() {
        if (this.abortController) {
            this.abortController.abort();
            this.isDownloading = false;
        }
    }
}

