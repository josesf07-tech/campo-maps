/**
 * CampoMaps - Descargador de mosaicos de mapa base para uso offline.
 * Incluye el cálculo del buffer de 2 km alrededor de planos GeoPDF.
 *
 * Las URLs se construyen con MapEngine.buildTileUrl para que coincidan
 * exactamente con las que pide Leaflet (misma capa, mismo subdominio) y
 * así el Service Worker las sirva desde la caché sin conexión.
 */

const ICON_X = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export class TileDownloader {
    constructor(mapEngine) {
        this.mapEngine = mapEngine;
        this.isDownloading = false;
        this.abortController = null;
        this.activeGeoPdfBounds = null;
        this.activeGeoPdfName = '';
        this.avgTileKb = 18;
    }

    /**
     * Expande un cuadro delimitador por N kilómetros en todas las direcciones.
     */
    expandBoundsByKm(bounds, km = 2) {
        const { sw, ne } = this._normalizeBounds(bounds);
        if (!sw || !ne) return bounds;

        const centerLat = (sw.lat + ne.lat) / 2;
        const deltaLat = km / 111.32;
        const deltaLng = km / (111.32 * Math.max(0.05, Math.cos(centerLat * Math.PI / 180)));

        const expanded = [
            [sw.lat - deltaLat, sw.lng - deltaLng],
            [ne.lat + deltaLat, ne.lng + deltaLng]
        ];
        return (typeof window.L !== 'undefined') ? window.L.latLngBounds(expanded[0], expanded[1]) : expanded;
    }

    _normalizeBounds(bounds) {
        if (Array.isArray(bounds)) {
            return { sw: { lat: bounds[0][0], lng: bounds[0][1] }, ne: { lat: bounds[1][0], lng: bounds[1][1] } };
        }
        if (bounds && bounds.getSouthWest && bounds.getNorthEast) {
            return { sw: bounds.getSouthWest(), ne: bounds.getNorthEast() };
        }
        return { sw: null, ne: null };
    }

    latLngToTile(lat, lng, zoom) {
        const n = Math.pow(2, zoom);
        const x = Math.floor((lng + 180) / 360 * n);
        const latRad = lat * Math.PI / 180;
        const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
        return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1), z: zoom };
    }

    getTilesInBounds(bounds, minZoom, maxZoom) {
        const tiles = [];
        const { sw, ne } = this._normalizeBounds(bounds);
        if (!sw || !ne) return tiles;

        for (let z = minZoom; z <= maxZoom; z++) {
            const nwTile = this.latLngToTile(ne.lat, sw.lng, z);
            const seTile = this.latLngToTile(sw.lat, ne.lng, z);
            const minX = Math.min(nwTile.x, seTile.x), maxX = Math.max(nwTile.x, seTile.x);
            const minY = Math.min(nwTile.y, seTile.y), maxY = Math.max(nwTile.y, seTile.y);
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) tiles.push({ x, y, z });
            }
        }
        return tiles;
    }

    getTileUrl(tile, layerType = 'satellite') {
        return this.mapEngine.buildTileUrl(layerType, tile.x, tile.y, tile.z);
    }

    estimateMb(tileCount) {
        return ((tileCount * this.avgTileKb) / 1024).toFixed(1);
    }

    /**
     * Caché de mosaicos activa de la PWA (misma que usa el Service Worker).
     */
    async getActiveTileCache() {
        if (!('caches' in window)) return null;
        try {
            // Nombre fijo (sin versión): coincide con TILE_CACHE_NAME del Service Worker
            return await caches.open('campo-maps-tiles');
        } catch (e) {
            console.warn('No se pudo abrir la caché de mosaicos:', e);
            return null;
        }
    }

    _ensureModal(id) {
        let modal = document.getElementById(id);
        if (!modal) {
            modal = document.createElement('div');
            modal.id = id;
            modal.className = 'modal';
            modal.setAttribute('data-no-dismiss', '');
            document.getElementById('app-container').appendChild(modal);
        }
        return modal;
    }

    _progressMarkup(prefix) {
        return `
            <div id="${prefix}-progress-box" class="progress-box hidden">
                <div class="progress-meta">
                    <span id="${prefix}-status-text" class="status">Descargando...</span>
                    <span id="${prefix}-percent-text" class="pct">0%</span>
                </div>
                <div class="progress-track"><div id="${prefix}-progress-bar" class="progress-fill"></div></div>
            </div>`;
    }

    _wireDownload(modal, prefix, btnStart, tiles, layerType, onDone) {
        btnStart.addEventListener('click', async () => {
            if (this.isDownloading) return;
            btnStart.disabled = true;
            btnStart.textContent = 'Descargando...';
            modal.querySelector(`#${prefix}-progress-box`).classList.remove('hidden');

            const pBar = modal.querySelector(`#${prefix}-progress-bar`);
            const pStatus = modal.querySelector(`#${prefix}-status-text`);
            const pPercent = modal.querySelector(`#${prefix}-percent-text`);

            try {
                const result = await this.downloadTiles(tiles, layerType, (done, total, failed) => {
                    const pct = Math.round((done / total) * 100);
                    pBar.style.width = `${pct}%`;
                    pPercent.textContent = `${pct}%`;
                    pStatus.textContent = failed > 0
                        ? `${done} de ${total} mosaicos (${failed} fallidos)`
                        : `${done} de ${total} mosaicos`;
                });

                pBar.style.width = '100%';
                pPercent.textContent = '100%';
                if (result.aborted) {
                    pStatus.textContent = 'Descarga cancelada';
                    btnStart.textContent = 'Reintentar';
                    btnStart.disabled = false;
                    return;
                }
                const okCount = result.cached;
                if (result.failed === 0) {
                    pStatus.textContent = `✅ ${okCount} mosaicos guardados para uso offline`;
                } else if (okCount > 0) {
                    pStatus.textContent = `⚠️ ${okCount} guardados, ${result.failed} no se pudieron descargar`;
                } else {
                    pStatus.textContent = '❌ No se pudo descargar ningún mosaico. Revisa la conexión.';
                }
                btnStart.textContent = okCount > 0 ? 'Listo' : 'Reintentar';
                btnStart.disabled = false;
                if (okCount > 0) {
                    setTimeout(() => modal.classList.add('hidden'), 1600);
                    if (onDone) onDone(result);
                }
            } catch (err) {
                if (err && err.name !== 'AbortError') {
                    pStatus.textContent = '⚠️ Error en descarga: ' + (err.message || err);
                    btnStart.textContent = 'Reintentar';
                    btnStart.disabled = false;
                }
            }
        });
    }

    /**
     * Diálogo general de descarga offline: pantalla actual o GeoPDF + 2 km.
     */
    showDownloadDialog(currentLayerType = 'satellite', geoPdfBounds = null, geoPdfName = '') {
        const map = this.mapEngine?.map;
        if (!map) return;

        const layerType = currentLayerType || this.mapEngine.baseLayerType || 'satellite';
        const layerDef = this.mapEngine.getBaseLayerDef(layerType);
        const layerMaxZ = Math.min(layerDef.maxNativeZoom || 18, 18);

        const activeBounds = geoPdfBounds || this.activeGeoPdfBounds;
        const activeName = geoPdfName || this.activeGeoPdfName || 'Plano activo';

        const screenBounds = map.getBounds();
        const curZoom = Math.min(Math.round(map.getZoom()), layerMaxZ);
        const screenMinZ = curZoom;
        const screenMaxZ = Math.min(curZoom + 2, layerMaxZ);
        const screenTiles = this.getTilesInBounds(screenBounds, screenMinZ, screenMaxZ);

        let bufferBounds = null;
        let bufferTiles = [];
        const bufMinZ = 13;
        const bufMaxZ = Math.min(17, layerMaxZ);
        if (activeBounds) {
            bufferBounds = this.expandBoundsByKm(activeBounds, 2);
            bufferTiles = this.getTilesInBounds(bufferBounds, bufMinZ, bufMaxZ);
        }

        let selectedMode = bufferBounds ? 'geopdf' : 'screen';
        const modal = this._ensureModal('modal-offline-download');

        const render = () => {
            const isGeoPdfMode = selectedMode === 'geopdf' && bufferBounds;
            const targetTiles = isGeoPdfMode ? bufferTiles : screenTiles;
            const estMb = this.estimateMb(targetTiles.length);
            const zoomText = isGeoPdfMode ? `${bufMinZ} a ${bufMaxZ}` : `${screenMinZ} a ${screenMaxZ}`;

            modal.innerHTML = `
                <div class="modal-content">
                    <header class="modal-header">
                        <h2>Descargar mapa offline</h2>
                        <button class="btn-close-modal" id="btn-close-offline-modal" aria-label="Cerrar">${ICON_X}</button>
                    </header>
                    <div class="modal-body">
                        <p class="text-xs mb-12">Guarda mosaicos de la capa actual para navegar en campo <strong>sin conexión</strong>.</p>

                        ${bufferBounds ? `
                        <div class="card mb-12">
                            <div class="label mb-8">Área de cobertura</div>
                            <label class="dl-mode ${selectedMode === 'geopdf' ? 'selected' : ''}">
                                <input type="radio" name="dl-mode" value="geopdf" ${selectedMode === 'geopdf' ? 'checked' : ''}>
                                <div>
                                    <div class="dl-mode-title">${escapeHtml(activeName)} + buffer de 2 km</div>
                                    <div class="dl-mode-desc">2 km alrededor del perímetro del plano para caminos y accesos.</div>
                                </div>
                            </label>
                            <label class="dl-mode sky ${selectedMode === 'screen' ? 'selected' : ''}">
                                <input type="radio" name="dl-mode" value="screen" ${selectedMode === 'screen' ? 'checked' : ''}>
                                <div>
                                    <div class="dl-mode-title">Pantalla actual del mapa</div>
                                    <div class="dl-mode-desc">El encuadre visible ahora mismo y dos niveles de acercamiento.</div>
                                </div>
                            </label>
                        </div>` : ''}

                        <div class="card spec-list">
                            <div><span>Capa</span><strong class="text-sky">${escapeHtml(layerDef.label)}</strong></div>
                            <div><span>Niveles de zoom</span><strong>${zoomText}</strong></div>
                            <div><span>Mosaicos</span><strong class="text-accent">${targetTiles.length.toLocaleString('es-CO')}</strong></div>
                            <div><span>Espacio estimado</span><strong class="text-warn">~${estMb} MB</strong></div>
                        </div>

                        ${this._progressMarkup('dl')}
                    </div>
                    <footer class="modal-footer">
                        <button type="button" class="btn-secondary" id="btn-cancel-dl">Cancelar</button>
                        <button type="button" class="btn-primary" id="btn-start-dl">Descargar (~${estMb} MB)</button>
                    </footer>
                </div>`;

            modal.querySelectorAll('input[name="dl-mode"]').forEach(r => {
                r.addEventListener('change', (e) => {
                    selectedMode = e.target.value;
                    render();
                });
            });

            const closeModal = () => {
                if (this.isDownloading) {
                    if (confirm('¿Cancelar la descarga en curso?')) {
                        this.cancel();
                        modal.classList.add('hidden');
                    }
                } else {
                    modal.classList.add('hidden');
                }
            };
            modal.querySelector('#btn-close-offline-modal').addEventListener('click', closeModal);
            modal.querySelector('#btn-cancel-dl').addEventListener('click', closeModal);

            this._wireDownload(modal, 'dl', modal.querySelector('#btn-start-dl'), targetTiles, layerType);
        };

        render();
        modal.classList.remove('hidden');
    }

    /**
     * Pregunta y descarga el buffer de 2 km alrededor de un GeoPDF recién cargado.
     */
    async promptAndDownloadGeoPdfBuffer(geoPdfBounds, mapName = 'Plano GeoPDF', { auto = false } = {}) {
        this.activeGeoPdfBounds = geoPdfBounds;
        this.activeGeoPdfName = mapName;

        const layerType = this.mapEngine.baseLayerType || 'satellite';
        const layerDef = this.mapEngine.getBaseLayerDef(layerType);
        const bufMaxZ = Math.min(17, layerDef.maxNativeZoom || 17);
        const bufferBounds = this.expandBoundsByKm(geoPdfBounds, 2);
        const tiles = this.getTilesInBounds(bufferBounds, 13, bufMaxZ);
        const estMb = this.estimateMb(tiles.length);

        const modal = this._ensureModal('modal-geopdf-buffer-prompt');
        modal.innerHTML = `
            <div class="modal-content">
                <header class="modal-header">
                    <h2>Descarga satelital automática</h2>
                    <button class="btn-close-modal" id="btn-close-buffer-prompt" aria-label="Cerrar">${ICON_X}</button>
                </header>
                <div class="modal-body">
                    <p class="text-sm mb-12" style="color: var(--text-1);">
                        Has agregado <strong>${escapeHtml(mapName)}</strong>. ¿Quieres guardar la imagen de
                        <strong>${escapeHtml(layerDef.label)}</strong> en un perímetro de <strong>2 km</strong> para trabajar sin internet?
                    </p>

                    <div class="card card-accent spec-list mb-12">
                        <div><span>Buffer</span><strong class="text-accent">2 km alrededor del plano</strong></div>
                        <div><span>Niveles de zoom</span><strong>13 a ${bufMaxZ}</strong></div>
                        <div><span>Mosaicos</span><strong>${tiles.length.toLocaleString('es-CO')}</strong></div>
                        <div><span>Descarga estimada</span><strong class="text-warn">~${estMb} MB</strong></div>
                    </div>

                    <label class="checkbox-row">
                        <input type="checkbox" id="check-remember-auto-dl">
                        <span>Descargar siempre automáticamente en futuros planos</span>
                    </label>

                    ${this._progressMarkup('buf')}
                </div>
                <footer class="modal-footer">
                    <button type="button" class="btn-secondary" id="btn-skip-buffer-dl">Omitir</button>
                    <button type="button" class="btn-primary" id="btn-start-buffer-dl">Descargar 2 km</button>
                </footer>
            </div>`;

        const closePrompt = () => modal.classList.add('hidden');
        modal.querySelector('#btn-close-buffer-prompt').addEventListener('click', closePrompt);
        modal.querySelector('#btn-skip-buffer-dl').addEventListener('click', closePrompt);

        const btnStart = modal.querySelector('#btn-start-buffer-dl');
        const checkRemember = modal.querySelector('#check-remember-auto-dl');
        btnStart.addEventListener('click', async () => {
            if (checkRemember && checkRemember.checked && window.__campoMapsSaveSetting) {
                await window.__campoMapsSaveSetting('autoDownloadSatelliteBuffer', true);
                const toggleSetting = document.getElementById('toggle-auto-dl-geopdf');
                if (toggleSetting) toggleSetting.checked = true;
            }
        }, { once: true });

        this._wireDownload(modal, 'buf', btnStart, tiles, layerType);
        modal.classList.remove('hidden');

        // Ajuste "descargar siempre": arranca sin preguntar
        if (auto) {
            const p = modal.querySelector('.modal-body > p');
            if (p) p.textContent = `Descargando automáticamente ${layerDef.label} en 2 km alrededor de "${mapName}" (ajuste activado).`;
            btnStart.click();
        }
    }

    /**
     * Descarga y guarda mosaicos en la caché. Devuelve {cached, failed, skipped, aborted}.
     * Intenta CORS y, si el servidor no lo permite, guarda la respuesta opaca (no-cors),
     * que el Service Worker puede servir igualmente.
     */
    /** Marca teselas como fijadas en la base LRU del Service Worker para que nunca se desalojen. */
    async _pinTiles(urls) {
        if (!urls.length || !('indexedDB' in window)) return;
        try {
            const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open('CampoMaps_SW_DB', 1);
                req.onupgradeneeded = (ev) => {
                    const d = ev.target.result;
                    if (!d.objectStoreNames.contains('tile_metadata')) {
                        const store = d.createObjectStore('tile_metadata', { keyPath: 'url' });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                        store.createIndex('size', 'size', { unique: false });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            const tx = db.transaction('tile_metadata', 'readwrite');
            const store = tx.objectStore('tile_metadata');
            const now = Date.now();
            urls.forEach((url) => store.put({ url, timestamp: now, size: this.avgTileKb * 1024, pinned: 1 }));
            await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
            db.close();
        } catch (e) {
            console.warn('No se pudieron fijar las teselas en la base LRU:', e);
        }
    }

    async downloadTiles(tiles, layerType, onProgress) {
        this.isDownloading = true;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        const cache = await this.getActiveTileCache();
        if (!cache) {
            this.isDownloading = false;
            throw new Error('El almacenamiento de caché no está disponible en este navegador.');
        }

        let completed = 0, cached = 0, failed = 0, skipped = 0;
        const total = tiles.length;
        const batchSize = 6;
        const pinned = [];

        const fetchTile = async (url) => {
            try {
                const res = await fetch(url, { signal, mode: 'cors', cache: 'no-store' });
                if (res.ok) return res;
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;
            }
            // Fallback: respuesta opaca (servidores sin cabeceras CORS, ej. Google)
            const res2 = await fetch(url, { signal, mode: 'no-cors', cache: 'no-store' });
            if (res2.type === 'opaque' || res2.ok) return res2;
            throw new Error('HTTP ' + res2.status);
        };

        try {
            for (let i = 0; i < tiles.length; i += batchSize) {
                if (signal.aborted) break;
                const batch = tiles.slice(i, i + batchSize);
                await Promise.all(batch.map(async (tile) => {
                    const url = this.getTileUrl(tile, layerType);
                    try {
                        const existing = await cache.match(url);
                        if (existing) {
                            skipped++;
                            cached++;
                        } else {
                            const res = await fetchTile(url);
                            await cache.put(url, res);
                            cached++;
                        }
                        pinned.push(url);
                    } catch (e) {
                        if (e && e.name === 'AbortError') return;
                        failed++;
                    } finally {
                        completed++;
                        if (onProgress) onProgress(completed, total, failed);
                    }
                }));
            }
        } finally {
            this.isDownloading = false;
        }

        if (pinned.length > 0) await this._pinTiles(pinned);
        return { cached, failed, skipped, total, aborted: signal.aborted };
    }

    cancel() {
        if (this.abortController) {
            this.abortController.abort();
            this.isDownloading = false;
        }
    }
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
