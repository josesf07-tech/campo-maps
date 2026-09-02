/**
 * CampoMaps - Descargador de Mosaicos de Mapa Base Offline (Pre-caching de Mapas)
 */

export class TileDownloader {
    constructor(mapEngine) {
        this.mapEngine = mapEngine;
        this.isDownloading = false;
        this.abortController = null;
        this.modalEl = null;
    }

    latLngToTile(lat, lng, zoom) {
        const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
        const latRad = lat * Math.PI / 180;
        const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
        return { x, y, z: zoom };
    }

    getTilesInBounds(bounds, minZoom, maxZoom) {
        const tiles = [];
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();

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

    showDownloadDialog(currentLayerType = 'satellite') {
        const map = this.mapEngine?.map;
        if (!map) return;

        const bounds = map.getBounds();
        const curZoom = map.getZoom();
        const minZ = curZoom;
        const maxZ = Math.min(curZoom + 2, 18);

        const tiles = this.getTilesInBounds(bounds, minZ, maxZ);
        const estMb = ((tiles.length * 18) / 1024).toFixed(1);

        let modal = document.getElementById('modal-offline-download');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-offline-download';
            modal.className = 'modal';
            document.getElementById('app-container').appendChild(modal);
        }

        modal.classList.remove('hidden');
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 380px;">
                <header class="modal-header">
                    <h2>Descargar Mapa Offline</h2>
                    <button class="btn-close-modal" id="btn-close-offline-modal"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                </header>
                <div class="modal-body">
                    <p style="font-size: 13px; margin-bottom: 12px;">
                        Guarda el mapa base del área que ves en pantalla para usarlo <strong>100% sin internet</strong> en campo.
                    </p>
                    <div style="background: rgba(0,0,0,0.25); padding: 12px; border-radius: 8px; font-size: 12px; line-height: 1.6; border: 1px solid var(--border-color);">
                        <div><strong>Tipo de mapa:</strong> ${currentLayerType === 'satellite' ? '🛰️ Google Satélite' : '🗺️ OpenStreetMap'}</div>
                        <div><strong>Niveles de Zoom:</strong> ${minZ} a ${maxZ}</div>
                        <div><strong>Mosaicos a descargar:</strong> ~${tiles.length} cuadros</div>
                        <div><strong>Peso estimado:</strong> ~${estMb} MB</div>
                    </div>
                    
                    <div id="download-progress-box" class="hidden" style="margin-top: 14px;">
                        <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                            <span id="dl-status-text">Descargando...</span>
                            <span id="dl-percent-text">0%</span>
                        </div>
                        <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">
                            <div id="dl-progress-bar" style="width: 0%; height: 100%; background: var(--accent-primary); transition: width 0.15s ease;"></div>
                        </div>
                    </div>
                </div>
                <footer class="modal-footer" style="display: flex; gap: 8px;">
                    <button type="button" class="btn-secondary" id="btn-cancel-dl" style="flex:1;">Cancelar</button>
                    <button type="button" class="btn-primary" id="btn-start-dl" style="flex:1.5;">Descargar Área</button>
                </footer>
            </div>
        `;

        const btnClose = modal.querySelector('#btn-close-offline-modal');
        const btnCancel = modal.querySelector('#btn-cancel-dl');
        const btnStart = modal.querySelector('#btn-start-dl');

        const closeModal = () => {
            if (this.isDownloading) {
                if (confirm('¿Deseas cancelar la descarga en curso?')) {
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
                await this.downloadTiles(tiles, currentLayerType, (done, total) => {
                    const pct = Math.round((done / total) * 100);
                    pBar.style.width = `${pct}%`;
                    pPercent.textContent = `${pct}%`;
                    pStatus.textContent = `Descargado: ${done} / ${total} mosaicos`;
                });

                pStatus.textContent = '✅ ¡Descarga completada con éxito!';
                btnStart.textContent = 'Listo';
                btnStart.disabled = false;
                setTimeout(() => {
                    modal.classList.add('hidden');
                }, 1200);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    pStatus.textContent = '⚠️ Error en descarga: ' + err.message;
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

        let cache = null;
        if ('caches' in window) {
            cache = await caches.open('campo-maps-tiles-v7');
        }

        let completed = 0;
        const total = tiles.length;

        // Process in batches of 6 parallel requests
        const batchSize = 6;
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
                    // Ignore single tile errors (network flakiness)
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
