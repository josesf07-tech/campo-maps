export const DB_NAME = 'CampoMapsDB';
export const DB_VERSION = 2;

let db;

export function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("Database error: " + event.target.errorCode);
            reject("Error opening database");
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            
            if (!db.objectStoreNames.contains('projects')) {
                const projectsStore = db.createObjectStore('projects', { keyPath: 'id' });
                projectsStore.createIndex('name', 'name', { unique: false });
            }

            if (!db.objectStoreNames.contains('maps')) {
                const mapsStore = db.createObjectStore('maps', { keyPath: 'id' });
                mapsStore.createIndex('name', 'name', { unique: false });
            }
            
            if (!db.objectStoreNames.contains('tracks')) {
                const tracksStore = db.createObjectStore('tracks', { keyPath: 'id' });
                tracksStore.createIndex('date', 'date', { unique: false });
            }
            
            if (!db.objectStoreNames.contains('placemarks')) {
                const placemarksStore = db.createObjectStore('placemarks', { keyPath: 'id' });
                placemarksStore.createIndex('mapId', 'mapId', { unique: false });
            }

            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }
        };
    });
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Generic methods
function add(storeName, data) {
    return new Promise((resolve, reject) => {
        if (!data.id && storeName !== 'settings') {
            data.id = generateUUID();
        }
        const transaction = db.transaction([storeName], 'readwrite');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.add(data);
        
        request.onsuccess = () => resolve(data);
        request.onerror = (e) => reject(e.target.error);
    });
}

function update(storeName, data) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.put(data);
        
        request.onsuccess = () => resolve(data);
        request.onerror = (e) => reject(e.target.error);
    });
}

function get(storeName, id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.get(id);
        
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

function getAll(storeName) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.getAll();
        
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

function getAllKeys(storeName) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.getAllKeys();

        request.onsuccess = (e) => resolve(e.target.result || []);
        request.onerror = (e) => reject(e.target.error);
    });
}

function remove(storeName, id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.delete(id);
        
        request.onsuccess = () => resolve(id);
        request.onerror = (e) => reject(e.target.error);
    });
}

// Specific Methods
export const saveProject = (data) => update('projects', data);
export const getProjects = () => getAll('projects');
export const getProject = (id) => get('projects', id);
export const deleteProject = (id) => remove('projects', id);

export const savePlacemark = (data) => update('placemarks', data);
export const getPlacemarks = () => getAll('placemarks');
export const getPlacemark = (id) => get('placemarks', id);
export const deletePlacemark = (id) => remove('placemarks', id);

export const saveTrack = (data) => update('tracks', data);
export const getTracks = () => getAll('tracks');
export const getTrack = (id) => get('tracks', id);
export const deleteTrack = (id) => remove('tracks', id);

export const saveMap = (data) => update('maps', data);
export const getMaps = () => getAll('maps');
export const getMap = (id) => get('maps', id);
export const deleteMap = (id) => remove('maps', id);

export const saveSetting = (key, value) => update('settings', { key, value });
export const getSetting = (key) => get('settings', key);
export const getSettings = () => getAll('settings');

/**
 * Borra todos los almacenes locales (proyectos, mapas, rutas, marcadores y ajustes).
 */
export function clearAllData() {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Base de datos no inicializada'));
        const stores = Array.from(db.objectStoreNames);
        const transaction = db.transaction(stores, 'readwrite');
        stores.forEach((name) => transaction.objectStore(name).clear());
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Nombres de los almacenes y su clave primaria.
 * Lo usa el módulo de respaldo (backup.js) para recorrer la base sin
 * depender de los helpers específicos de cada tipo de dato.
 */
export const STORE_KEY_PATHS = {
    projects: 'id',
    maps: 'id',
    tracks: 'id',
    placemarks: 'id',
    settings: 'key'
};

export const STORE_NAMES = Object.keys(STORE_KEY_PATHS);

// API genérica por nombre de almacén (respaldo / restauración)
export const getStoreKeys = (storeName) => getAllKeys(storeName);
export const getRecord = (storeName, id) => get(storeName, id);
export const putRecord = (storeName, data) => update(storeName, data);
export const deleteRecord = (storeName, id) => remove(storeName, id);

/**
 * Vacía un único almacén (usado por la restauración en modo reemplazar).
 */
export function clearStore(storeName) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Base de datos no inicializada'));
        const transaction = db.transaction([storeName], 'readwrite');
        transaction.objectStore(storeName).clear();
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = (e) => reject(e.target.error);
    });
}

export async function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
        try {
            const isPersisted = await navigator.storage.persist();
            console.log(`[Storage] Persistencia garantizada: ${isPersisted}`);
            return isPersisted;
        } catch (e) {
            console.warn('[Storage] No se pudo solicitar persistencia:', e);
        }
    }
    return false;
}

export { generateUUID };
