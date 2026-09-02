/**
 * CampoMaps - Service Worker
 * Version: 1.0.0
 * 
 * Offline-first PWA Service Worker for CampoMaps field mapping application.
 * Handles app shell caching, dynamic map tile caching with LRU eviction,
 * offline fallbacks, and cache management messaging.
 */

const CACHE_VERSION = 'v17';
const APP_CACHE_NAME = `campo-maps-${CACHE_VERSION}`;
const TILE_CACHE_NAME = `campo-maps-tiles-${CACHE_VERSION}`;
const MAX_TILES = 5000;
const DB_NAME = 'CampoMaps_SW_DB';
const DB_STORE_NAME = 'tile_metadata';

// Core Application Shell assets to precache on install
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  
  // JavaScript Modules
  './js/app.js',
  './js/map-engine.js',
  './js/gps-tracker.js',
  './js/storage.js',
  './js/placemarks.js',
  './js/calibration.js',
  './js/track-recorder.js',
  './js/coords.js',
  './js/kmz-export.js',
  './js/docx-export.js',
  './js/excel-export.js',
  './js/measurement.js',
  './js/tile-downloader.js',

  // PWA Icons
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon.svg',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/favicon.png',
  './favicon.ico',

  // Third-party CDN Dependencies
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.2/proj4.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
];

// Offline fallback tile SVG (256x256 dark themed grid)
const OFFLINE_TILE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="#16213e" stroke="#0f3460" stroke-width="2"/>
  <path d="M0 64 H256 M0 128 H256 M0 192 H256 M64 0 V256 M128 0 V256 M192 0 V256" stroke="#1f2d5a" stroke-width="1" stroke-dasharray="4 4"/>
  <circle cx="128" cy="128" r="18" fill="#0f3460" stroke="#e94560" stroke-width="1.5"/>
  <path d="M122 122 L134 134 M134 122 L122 134" stroke="#e94560" stroke-width="2" stroke-linecap="round"/>
  <text x="128" y="160" text-anchor="middle" fill="#7f8c8d" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="500">Sin conexión</text>
</svg>`.trim();

// Offline HTML fallback
const OFFLINE_HTML_FALLBACK = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CampoMaps - Modo Offline</title>
  <style>
    body {
      background-color: #1a1a2e;
      color: #e0e0e0;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { color: #4ecca3; font-size: 24px; margin: 0 0 12px 0; }
    p { color: #a0a0a0; font-size: 15px; max-width: 400px; line-height: 1.5; margin: 0 0 24px 0; }
    button {
      background: #e94560;
      color: white;
      border: none;
      padding: 12px 24px;
      font-size: 15px;
      font-weight: bold;
      border-radius: 8px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="icon">📡</div>
  <h1>CampoMaps Offline</h1>
  <p>No tienes conexión a Internet en este momento. Las capas y datos descargados previamente seguirán funcionando normalmente.</p>
  <button onclick="window.location.reload()">Reintentar</button>
</body>
</html>`.trim();

// ==========================================
// IndexedDB Helper for LRU Tile Tracking
// ==========================================

/**
 * Open or upgrade the IndexedDB instance for tile metadata tracking.
 * @returns {Promise<IDBDatabase>}
 */
function openTileDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      return reject(new Error('IndexedDB not supported'));
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
        const store = db.createObjectStore(DB_STORE_NAME, { keyPath: 'url' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('size', 'size', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Update LRU timestamp for a given tile URL and enforce max tile limit.
 * @param {string} url - Tile URL
 * @param {Response} [response] - Optional response object to estimate size
 */
async function recordTileAccess(url, response) {
  try {
    const db = await openTileDB();
    const tx = db.transaction(DB_STORE_NAME, 'readwrite');
    const store = tx.objectStore(DB_STORE_NAME);

    // Approximate size in bytes if available from response
    let size = 15000; // Default ~15KB per tile
    if (response && response.headers && response.headers.get('content-length')) {
      const parsed = parseInt(response.headers.get('content-length'), 10);
      if (!isNaN(parsed) && parsed > 0) size = parsed;
    }

    store.put({
      url: url,
      timestamp: Date.now(),
      size: size
    });

    tx.oncomplete = () => {
      db.close();
      // Check and enforce tile cache limit asynchronously
      enforceTileLimit().catch((err) => console.warn('[SW] enforceTileLimit error:', err));
    };
    tx.onerror = () => {
      db.close();
    };
  } catch (err) {
    // Graceful fallback if IndexedDB is disabled/unavailable
    // Use Cache API directly for FIFO eviction
    trimCacheFallback(TILE_CACHE_NAME, MAX_TILES).catch(() => {});
  }
}

/**
 * Remove least recently used tiles if total tile count exceeds MAX_TILES.
 */
async function enforceTileLimit() {
  try {
    const db = await openTileDB();
    const tx = db.transaction(DB_STORE_NAME, 'readonly');
    const store = tx.objectStore(DB_STORE_NAME);
    const countRequest = store.count();

    countRequest.onsuccess = async () => {
      const totalCount = countRequest.result;
      if (totalCount <= MAX_TILES) {
        db.close();
        return;
      }

      const excess = totalCount - MAX_TILES;
      const txDelete = db.transaction(DB_STORE_NAME, 'readwrite');
      const storeDelete = txDelete.objectStore(DB_STORE_NAME);
      const index = storeDelete.index('timestamp');
      const cursorReq = index.openCursor(); // Oldest timestamp first

      const urlsToDelete = [];
      cursorReq.onsuccess = async (e) => {
        const cursor = e.target.result;
        if (cursor && urlsToDelete.length < excess) {
          urlsToDelete.push(cursor.value.url);
          cursor.delete();
          cursor.continue();
        } else {
          // Delete from Cache storage
          if (urlsToDelete.length > 0) {
            try {
              const tileCache = await caches.open(TILE_CACHE_NAME);
              await Promise.all(urlsToDelete.map((u) => tileCache.delete(u)));
            } catch (err) {
              console.warn('[SW] Failed to delete evicted tiles from cache:', err);
            }
          }
          db.close();
        }
      };
      cursorReq.onerror = () => db.close();
    };
    countRequest.onerror = () => db.close();
  } catch (err) {
    await trimCacheFallback(TILE_CACHE_NAME, MAX_TILES);
  }
}

/**
 * Fallback FIFO cache trimmer when IndexedDB is not used.
 * @param {string} cacheName 
 * @param {number} maxItems 
 */
async function trimCacheFallback(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      const itemsToDelete = keys.slice(0, keys.length - maxItems);
      await Promise.all(itemsToDelete.map((key) => cache.delete(key)));
    }
  } catch (e) {
    console.warn('[SW] trimCacheFallback error:', e);
  }
}

/**
 * Clear all records in the Tile IndexedDB store.
 */
async function clearTileDB() {
  try {
    const db = await openTileDB();
    const tx = db.transaction(DB_STORE_NAME, 'readwrite');
    tx.objectStore(DB_STORE_NAME).clear();
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch (err) {
    console.warn('[SW] clearTileDB error:', err);
  }
}

// ==========================================
// Service Worker Lifecycle Events
// ==========================================

/**
 * Install Event: Pre-cache application shell and CDN dependencies.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE_NAME);
      
      // Cache each asset individually with error catching to avoid install failure on optional files
      const cachePromises = PRECACHE_ASSETS.map(async (assetUrl) => {
        try {
          const response = await fetch(assetUrl, { cache: 'reload' });
          if (response.ok || response.type === 'opaque') {
            await cache.put(assetUrl, response);
          } else {
            console.warn(`[SW] Precache skipped (${response.status}):`, assetUrl);
          }
        } catch (err) {
          console.warn(`[SW] Precache failed for ${assetUrl}:`, err.message);
        }
      });

      await Promise.allSettled(cachePromises);
      // Skip waiting to activate immediately when instructed
      return self.skipWaiting();
    })()
  );
});

/**
 * Activate Event: Clean up outdated caches and claim clients.
 */
self.addEventListener('activate', (event) => {
  const currentCaches = [APP_CACHE_NAME, TILE_CACHE_NAME];

  event.waitUntil(
    (async () => {
      // Delete obsolete caches
      const cacheNames = await caches.keys();
      const deletePromises = cacheNames
        .filter((cacheName) => {
          // Check if this is a CampoMaps cache from a previous version
          const isCampoCache = cacheName.startsWith('campo-maps-');
          const isCurrent = currentCaches.includes(cacheName);
          return isCampoCache && !isCurrent;
        })
        .map((cacheName) => {
          console.log('[SW] Removing old cache:', cacheName);
          return caches.delete(cacheName);
        });

      await Promise.all(deletePromises);
      // Claim all clients immediately so the page is controlled without reload
      return self.clients.claim();
    })()
  );
});

// ==========================================
// Request Inspection Helpers
// ==========================================

/**
 * Determine if a request is for an OpenStreetMap or other map tile.
 * @param {Request} request 
 * @param {URL} url 
 * @returns {boolean}
 */
function isTileRequest(request, url) {
  return (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('tile.opentopomap.org') ||
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('google.com') ||
    url.hostname.includes('cartocdn.com') ||
    url.hostname.includes('tile.stamen.com') ||
    url.pathname.includes('/vt') ||
    url.pathname.includes('/MapServer/tile') ||
    /\/\d+\/\d+\/\d+(\.png|\.jpg|\.jpeg|\.webp)?(\?.*)?$/i.test(url.pathname)
  );
}

/**
 * Determine if a request is for an App Shell asset (HTML, CSS, JS, manifest, fonts, icons, Leaflet).
 * @param {Request} request 
 * @param {URL} url 
 * @returns {boolean}
 */
function isAppAssetRequest(request, url) {
  // Same origin assets (except API calls)
  if (url.origin === self.location.origin) {
    return true;
  }
  // Leaflet CDN or standard CDN assets
  if (
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    return true;
  }
  return false;
}

/**
 * Generate an offline fallback tile response.
 * @returns {Response}
 */
function createOfflineTileResponse() {
  return new Response(OFFLINE_TILE_SVG, {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store'
    }
  });
}

// ==========================================
// Fetch Event & Caching Strategies
// ==========================================

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only handle HTTP/HTTPS GET requests
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Ignore chrome-extension and unsupported schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // -------------------------------------------------------------
  // STRATEGY 1: Map Tile Requests
  // Strategy: Cache First with Network Fallback & Background Cache Refresh
  // -------------------------------------------------------------
  if (isTileRequest(request, url)) {
    event.respondWith(
      (async () => {
        const tileCache = await caches.open(TILE_CACHE_NAME);
        const cachedResponse = await tileCache.match(request);

        if (cachedResponse) {
          // Update LRU access metadata in the background
          recordTileAccess(request.url, cachedResponse).catch(() => {});

          // If online, perform background cache revalidation
          if (navigator.onLine) {
            fetch(request)
              .then(async (networkResponse) => {
                if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
                  await tileCache.put(request, networkResponse.clone());
                  recordTileAccess(request.url, networkResponse).catch(() => {});
                }
              })
              .catch(() => {
                // Background update failed silently; cached tile continues serving
              });
          }

          return cachedResponse;
        }

        // Tile not in cache: fetch from network
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
            const responseToCache = networkResponse.clone();
            await tileCache.put(request, responseToCache);
            recordTileAccess(request.url, networkResponse).catch(() => {});
          }
          return networkResponse;
        } catch (error) {
          // Offline and tile not cached: return offline SVG tile placeholder
          return createOfflineTileResponse();
        }
      })()
    );
    return;
  }

  // -------------------------------------------------------------
  // STRATEGY 2: App Shell Assets (HTML, CSS, JS, manifest, fonts, icons, Leaflet)
  // Strategy: Network First with Cache Fallback for instant updates & offline reliability
  // -------------------------------------------------------------
  if (isAppAssetRequest(request, url)) {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
            const appCache = await caches.open(APP_CACHE_NAME);
            appCache.put(request, networkResponse.clone()).catch(() => {});
            return networkResponse;
          }
        } catch (err) {
          // Offline: fall back to cache
        }

        const appCache = await caches.open(APP_CACHE_NAME);
        const cachedResponse = await appCache.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }

        if (request.mode === 'navigate' || request.destination === 'document') {
          const fallback = (await appCache.match('./index.html')) || (await appCache.match('./'));
          if (fallback) return fallback;

          return new Response(OFFLINE_HTML_FALLBACK, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }

        return new Response('Recurso no disponible sin conexión', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })()
    );
    return;
  }

  // -------------------------------------------------------------
  // STRATEGY 3: Other Requests (API calls, external links)
  // Strategy: Network First with Cache Fallback
  // -------------------------------------------------------------
  event.respondWith(
    (async () => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
          const appCache = await caches.open(APP_CACHE_NAME);
          appCache.put(request, networkResponse.clone()).catch(() => {});
        }
        return networkResponse;
      } catch (error) {
        // Network failed, look in app cache
        const appCache = await caches.open(APP_CACHE_NAME);
        const cachedResponse = await appCache.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }

        // If navigation request, return offline HTML
        if (request.mode === 'navigate' || request.destination === 'document') {
          const fallback = (await appCache.match('./index.html')) || (await appCache.match('./'));
          if (fallback) return fallback;

          return new Response(OFFLINE_HTML_FALLBACK, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }

        return new Response('Network error occurred', {
          status: 504,
          statusText: 'Gateway Timeout',
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    })
  );
});

// ==========================================
// Message Event Handler for Client Commands
// ==========================================

self.addEventListener('message', async (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  const replyPort = event.ports && event.ports[0];
  const postReply = (message) => {
    if (replyPort) {
      replyPort.postMessage(message);
    } else if (event.source) {
      event.source.postMessage(message);
    }
  };

  switch (data.type) {
    // ---------------------------------------------------------
    // SKIP_WAITING: Activate new service worker immediately
    // ---------------------------------------------------------
    case 'SKIP_WAITING': {
      self.skipWaiting();
      postReply({ type: 'SKIP_WAITING_COMPLETE', success: true });
      break;
    }

    // ---------------------------------------------------------
    // CACHE_TILES: Bulk download and cache a list of tile URLs
    // ---------------------------------------------------------
    case 'CACHE_TILES': {
      const tileUrls = data.urls || data.tiles || [];
      if (!Array.isArray(tileUrls) || tileUrls.length === 0) {
        postReply({
          type: 'CACHE_TILES_COMPLETE',
          success: true,
          total: 0,
          cached: 0,
          failed: 0
        });
        return;
      }

      const total = tileUrls.length;
      let cached = 0;
      let failed = 0;
      const concurrency = 6; // Batch concurrency to respect browser limits

      try {
        const tileCache = await caches.open(TILE_CACHE_NAME);

        for (let i = 0; i < total; i += concurrency) {
          const batch = tileUrls.slice(i, i + concurrency);
          await Promise.all(
            batch.map(async (url) => {
              try {
                // Check if already in cache
                const match = await tileCache.match(url);
                if (match) {
                  cached++;
                  await recordTileAccess(url, match);
                } else {
                  const response = await fetch(url, { mode: 'cors' });
                  if (response.ok || response.type === 'opaque') {
                    await tileCache.put(url, response.clone());
                    await recordTileAccess(url, response);
                    cached++;
                  } else {
                    failed++;
                  }
                }
              } catch (err) {
                failed++;
              }
            })
          );

          // Report incremental progress
          const currentCount = Math.min(i + concurrency, total);
          postReply({
            type: 'CACHE_TILES_PROGRESS',
            current: currentCount,
            total: total,
            percent: Math.round((currentCount / total) * 100),
            cached: cached,
            failed: failed
          });
        }

        postReply({
          type: 'CACHE_TILES_COMPLETE',
          success: true,
          total: total,
          cached: cached,
          failed: failed
        });
      } catch (err) {
        postReply({
          type: 'CACHE_TILES_ERROR',
          success: false,
          error: err.message
        });
      }
      break;
    }

    // ---------------------------------------------------------
    // CLEAR_TILE_CACHE: Clear all cached map tiles
    // ---------------------------------------------------------
    case 'CLEAR_TILE_CACHE': {
      try {
        await caches.delete(TILE_CACHE_NAME);
        await clearTileDB();
        // Re-open fresh empty tile cache
        await caches.open(TILE_CACHE_NAME);

        postReply({
          type: 'CLEAR_TILE_CACHE_SUCCESS',
          success: true,
          message: 'Caché de mapas borrada exitosamente'
        });
      } catch (err) {
        postReply({
          type: 'CLEAR_TILE_CACHE_ERROR',
          success: false,
          error: err.message
        });
      }
      break;
    }

    // ---------------------------------------------------------
    // GET_CACHE_SIZE: Calculate approximate cache size and counts
    // ---------------------------------------------------------
    case 'GET_CACHE_SIZE': {
      try {
        let appCount = 0;
        let tileCount = 0;
        let estimatedBytes = 0;

        // Count App Shell items
        if (await caches.has(APP_CACHE_NAME)) {
          const appCache = await caches.open(APP_CACHE_NAME);
          const appKeys = await appCache.keys();
          appCount = appKeys.length;
          estimatedBytes += appCount * 25000; // ~25KB avg per shell asset
        }

        // Count Tile items
        if (await caches.has(TILE_CACHE_NAME)) {
          const tileCache = await caches.open(TILE_CACHE_NAME);
          const tileKeys = await tileCache.keys();
          tileCount = tileKeys.length;
          estimatedBytes += tileCount * 15000; // ~15KB avg per tile
        }

        // Query Storage API quota if available
        let storageEstimate = null;
        if (navigator.storage && navigator.storage.estimate) {
          try {
            storageEstimate = await navigator.storage.estimate();
          } catch (e) {}
        }

        const usageBytes = (storageEstimate && storageEstimate.usage) ? storageEstimate.usage : estimatedBytes;
        const quotaBytes = (storageEstimate && storageEstimate.quota) ? storageEstimate.quota : null;

        postReply({
          type: 'GET_CACHE_SIZE_RESULT',
          success: true,
          data: {
            appCacheCount: appCount,
            tileCount: tileCount,
            totalItems: appCount + tileCount,
            estimatedBytes: usageBytes,
            estimatedMB: (usageBytes / (1024 * 1024)).toFixed(2),
            quotaBytes: quotaBytes,
            quotaMB: quotaBytes ? (quotaBytes / (1024 * 1024)).toFixed(2) : null,
            maxTiles: MAX_TILES
          }
        });
      } catch (err) {
        postReply({
          type: 'GET_CACHE_SIZE_ERROR',
          success: false,
          error: err.message
        });
      }
      break;
    }

    default:
      console.log('[SW] Unhandled message type:', data.type);
      break;
  }
});
