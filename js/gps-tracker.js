/**
 * CampoMaps - GPSTracker
 *
 * Envuelve navigator.geolocation y la brújula (DeviceOrientation) con:
 *  - suavizado ponderado por precisión (últimas 5 muestras),
 *  - frecuencia mínima configurable entre actualizaciones,
 *  - rumbo de brújula con su propio callback (no dispara actualizaciones de posición),
 *  - suscriptores independientes (grabador de rutas, UI, etc.).
 */
export class GPSTracker {
    constructor() {
        this.watchId = null;
        this.onPositionUpdate = null;   // callback principal de la app
        this.onHeadingUpdate = null;    // callback de brújula (throttled)
        this.onError = null;
        this.lastPosition = null;
        this.positionBuffer = [];
        this.currentHeading = null;
        this.minInterval = 1000;        // ms entre actualizaciones entregadas
        this._lastDelivered = 0;
        this._lastHeadingDelivered = 0;
        this._listeners = new Set();
        this._orientationBound = false;

        // Un solo binding para poder retirar el listener correctamente
        this.handleOrientation = this.handleOrientation.bind(this);
    }

    /** Alias usado por la cámara y el sello de fotos */
    get currentPosition() {
        return this.lastPosition;
    }

    get isActive() {
        return this.watchId !== null;
    }

    /** Suscriptores adicionales (ej. grabador de rutas). Devuelve función para cancelar. */
    subscribe(fn) {
        if (typeof fn === 'function') this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    unsubscribe(fn) {
        this._listeners.delete(fn);
    }

    setMinInterval(ms) {
        const n = parseInt(ms, 10);
        this.minInterval = isNaN(n) ? 1000 : Math.max(0, n);
    }

    start() {
        if (!navigator.geolocation) {
            if (this.onError) this.onError(new Error('Geolocalización no soportada por el navegador.'), 'unsupported');
            return;
        }
        if (this.watchId !== null) return; // ya activo

        const options = {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        };

        this._lastDelivered = 0;
        this.watchId = navigator.geolocation.watchPosition(
            (pos) => this.handlePosition(pos),
            (err) => this.handleError(err),
            options
        );

        this.initCompass();
    }

    stop() {
        if (this.watchId !== null) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }
        if (this._orientationBound) {
            window.removeEventListener('deviceorientationabsolute', this.handleOrientation);
            window.removeEventListener('deviceorientation', this.handleOrientation);
            this._orientationBound = false;
        }
        this.positionBuffer = [];
    }

    getCurrentPosition() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                const err = new Error('Geolocalización no soportada por el navegador.');
                if (this.onError) this.onError(err, 'unsupported');
                return reject(err);
            }

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    this.handlePosition(pos, true);
                    resolve(this.lastPosition);
                },
                (err) => {
                    this.handleError(err);
                    reject(err);
                },
                { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
            );
        });
    }

    getPosition() {
        return this.lastPosition;
    }

    /**
     * @param {GeolocationPosition} position
     * @param {boolean} force - ignora la frecuencia mínima (lecturas puntuales)
     */
    handlePosition(position, force = false) {
        const raw = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            altitude: position.coords.altitude,
            speed: position.coords.speed,
            accuracy: position.coords.accuracy || 15,
            heading: position.coords.heading,
            timestamp: position.timestamp
        };

        // Buffer de estabilización (últimas 5 muestras)
        this.positionBuffer.push(raw);
        if (this.positionBuffer.length > 5) this.positionBuffer.shift();

        // Media móvil ponderada por precisión para amortiguar multitrayecto
        let totalWeight = 0, weightedLat = 0, weightedLng = 0, weightedAlt = 0, altWeights = 0;
        for (const s of this.positionBuffer) {
            const w = 1 / Math.max(1, s.accuracy);
            weightedLat += s.lat * w;
            weightedLng += s.lng * w;
            totalWeight += w;
            if (s.altitude !== null && s.altitude !== undefined) {
                weightedAlt += s.altitude * w;
                altWeights += w;
            }
        }

        const pos = {
            lat: weightedLat / totalWeight,
            lng: weightedLng / totalWeight,
            altitude: altWeights > 0 ? weightedAlt / altWeights : raw.altitude,
            speed: raw.speed,
            accuracy: raw.accuracy,
            // Prioriza el rumbo de brújula si existe; si no, el rumbo de movimiento
            heading: this.currentHeading !== null ? this.currentHeading : raw.heading,
            timestamp: raw.timestamp
        };

        this.lastPosition = pos;

        const now = Date.now();
        if (!force && this.minInterval > 0 && (now - this._lastDelivered) < this.minInterval) {
            return; // se respeta la frecuencia configurada
        }
        this._lastDelivered = now;
        this._emit(pos);
    }

    _emit(pos) {
        if (this.onPositionUpdate) {
            try { this.onPositionUpdate(pos); } catch (e) { console.error('[GPS] onPositionUpdate:', e); }
        }
        this._listeners.forEach((fn) => {
            try { fn(pos); } catch (e) { console.error('[GPS] listener:', e); }
        });
    }

    /**
     * Toma varias lecturas y promedia (descartando el 20% menos preciso).
     * Siempre resuelve o rechaza: si vence el tiempo con al menos una muestra, promedia lo que hay.
     */
    getAveragedPosition(targetSamples = 8, onProgress = null) {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                return reject(new Error('Geolocalización no soportada por el navegador.'));
            }

            const samples = [];
            const timeoutMs = 12000;
            let finished = false;
            let tempWatch = null;

            const finish = () => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                if (tempWatch !== null) navigator.geolocation.clearWatch(tempWatch);

                if (samples.length === 0) {
                    return reject(new Error('No se recibieron lecturas GPS.'));
                }

                samples.sort((a, b) => a.accuracy - b.accuracy);
                const clean = samples.slice(0, Math.max(1, Math.round(samples.length * 0.8)));

                let tw = 0, wLat = 0, wLng = 0, wAcc = 0, wAlt = 0, altW = 0;
                for (const s of clean) {
                    const w = 1 / Math.max(1, s.accuracy);
                    wLat += s.lat * w;
                    wLng += s.lng * w;
                    wAcc += s.accuracy * w;
                    tw += w;
                    if (s.altitude !== null && s.altitude !== undefined) {
                        wAlt += s.altitude * w;
                        altW += w;
                    }
                }

                resolve({
                    lat: wLat / tw,
                    lng: wLng / tw,
                    altitude: altW > 0 ? wAlt / altW : null,
                    accuracy: Math.max(1, Math.round((wAcc / tw) * 0.85)),
                    samplesUsed: clean.length,
                    timestamp: Date.now()
                });
            };

            const timer = setTimeout(finish, timeoutMs);

            tempWatch = navigator.geolocation.watchPosition(
                (pos) => {
                    if (finished) return;
                    const acc = pos.coords.accuracy || 20;
                    samples.push({
                        lat: pos.coords.latitude,
                        lng: pos.coords.longitude,
                        altitude: pos.coords.altitude,
                        accuracy: acc,
                        timestamp: pos.timestamp
                    });
                    if (onProgress) {
                        try { onProgress(samples.length, targetSamples, acc); } catch (e) {}
                    }
                    if (samples.length >= targetSamples) finish();
                },
                (err) => {
                    if (finished) return;
                    if (samples.length > 0) {
                        finish();
                    } else {
                        finished = true;
                        clearTimeout(timer);
                        if (tempWatch !== null) navigator.geolocation.clearWatch(tempWatch);
                        reject(new Error(GPSTracker.describeError(err)));
                    }
                },
                { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs }
            );
        });
    }

    static describeError(error) {
        if (!error || typeof error.code !== 'number') return 'Error de GPS.';
        switch (error.code) {
            case 1: return 'Permiso de ubicación denegado. Actívalo en los ajustes del navegador.';
            case 2: return 'Ubicación no disponible. Busca cielo abierto.';
            case 3: return 'Sin señal GPS suficiente. Esperando satélites...';
            default: return 'Error de GPS.';
        }
    }

    static errorKind(error) {
        if (!error || typeof error.code !== 'number') return 'unknown';
        return ({ 1: 'denied', 2: 'unavailable', 3: 'timeout' })[error.code] || 'unknown';
    }

    handleError(error) {
        if (this.onError) {
            this.onError(new Error(GPSTracker.describeError(error)), GPSTracker.errorKind(error));
        }
    }

    async initCompass() {
        if (this._orientationBound) return;
        const attach = () => {
            // 'deviceorientationabsolute' da norte verdadero en Android/Chrome; iOS usa webkitCompassHeading
            if ('ondeviceorientationabsolute' in window) {
                window.addEventListener('deviceorientationabsolute', this.handleOrientation);
            } else {
                window.addEventListener('deviceorientation', this.handleOrientation);
            }
            this._orientationBound = true;
        };

        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permissionState = await DeviceOrientationEvent.requestPermission();
                if (permissionState === 'granted') attach();
            } catch (error) {
                // El permiso de brújula en iOS requiere un gesto del usuario; no es crítico.
                console.warn('Brújula no disponible:', error && error.message);
            }
        } else {
            attach();
        }
    }

    handleOrientation(event) {
        let heading = null;
        if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
            heading = event.webkitCompassHeading;
        } else if (event.alpha !== null && event.alpha !== undefined) {
            heading = (360 - event.alpha) % 360;
        }
        if (heading === null || isNaN(heading)) return;

        this.currentHeading = Math.round(heading) % 360;
        if (this.lastPosition) this.lastPosition.heading = this.currentHeading;

        // La brújula puede emitir a 60 Hz: se limita a ~4 Hz y no dispara la cadena de posición
        const now = Date.now();
        if (this.onHeadingUpdate && (now - this._lastHeadingDelivered) >= 250) {
            this._lastHeadingDelivered = now;
            try { this.onHeadingUpdate(this.currentHeading); } catch (e) {}
        }
    }

    getHeading() {
        return (this.currentHeading !== undefined && this.currentHeading !== null) ? this.currentHeading : null;
    }

    static headingToCardinal(heading) {
        if (heading === null || heading === undefined || isNaN(heading)) return '';
        const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const val = Math.round(heading / 22.5) % 16;
        return directions[val];
    }

    static calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                  Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    static formatCoordinate(coord, type = 'DD', isLat = true) {
        if (type === 'DD') return coord.toFixed(5);
        const dir = isLat ? (coord >= 0 ? 'N' : 'S') : (coord >= 0 ? 'E' : 'W');
        const absCoord = Math.abs(coord);
        const d = Math.floor(absCoord);
        if (type === 'DDM') {
            const m = ((absCoord - d) * 60).toFixed(3);
            return `${d}° ${m}' ${dir}`;
        }
        if (type === 'DMS') {
            const m = Math.floor((absCoord - d) * 60);
            const s = (((absCoord - d) * 60 - m) * 60).toFixed(1);
            return `${d}° ${m}' ${s}" ${dir}`;
        }
        return coord.toFixed(5);
    }
}
