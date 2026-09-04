import { GPSTracker } from './gps-tracker.js';
import { generateUUID } from './storage.js';

/**
 * CampoMaps - Grabador de rutas.
 * Se suscribe al GPSTracker (sin envolver su callback principal) y filtra
 * puntos duplicados o demasiado cercanos para no inflar el recorrido.
 */
export class TrackRecorder {
    constructor(gpsTracker, mapEngine) {
        this.gpsTracker = gpsTracker;
        this.mapEngine = mapEngine;
        this.state = 'idle'; // idle | recording | paused

        this.points = [];
        this.stats = this.getDefaultStats();
        this.trackId = null;
        this.name = '';
        this.color = '#FF4444';

        this.minDistanceM = 1.5;   // metros mínimos entre puntos consecutivos
        this.minIntervalMs = 1000; // tiempo mínimo entre puntos
        this.maxAccuracyM = 50;    // descarta lecturas peores que esto

        this.onStatsUpdate = null;
        this._unsubscribe = null;
        this.handlePosition = this.handlePosition.bind(this);
    }

    getDefaultStats() {
        return {
            distance: 0,
            duration: 0,
            avgSpeed: 0,
            maxSpeed: 0,
            elevGain: 0,
            elevLoss: 0,
            startTime: null,
            endTime: null
        };
    }

    startRecording(name = 'Nuevo Recorrido', color = '#FF4444') {
        if (this._unsubscribe) this._unsubscribe();

        this.state = 'recording';
        this.trackId = generateUUID();
        this.name = name;
        this.color = color;
        this.points = [];
        this.stats = this.getDefaultStats();
        this.stats.startTime = Date.now();

        this._unsubscribe = this.gpsTracker.subscribe(this.handlePosition);

        // Si ya hay una posición conocida, arrancar desde ella
        const last = this.gpsTracker.getPosition && this.gpsTracker.getPosition();
        if (last) this.handlePosition(last);
    }

    pauseRecording() {
        if (this.state === 'recording') this.state = 'paused';
    }

    resumeRecording() {
        if (this.state === 'paused') {
            this.state = 'recording';
            this._skipNextDistance = true; // no sumar la línea recta de la pausa
        }
    }

    stopRecording() {
        this.state = 'idle';
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }

        this.stats.endTime = Date.now();
        this.stats.duration = this.stats.endTime - (this.stats.startTime || this.stats.endTime);
        this.stats.avgSpeed = this.stats.duration > 0
            ? (this.stats.distance / (this.stats.duration / 1000)) // m/s (la UI convierte a km/h)
            : 0;

        return {
            id: this.trackId,
            name: this.name,
            points: this.points,
            stats: this.stats,
            color: this.color,
            date: new Date().toISOString()
        };
    }

    handlePosition(pos) {
        if (this.state !== 'recording') return;
        if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number') return;
        if (pos.accuracy > this.maxAccuracyM) return;

        const newPoint = {
            lat: pos.lat,
            lng: pos.lng,
            altitude: (pos.altitude !== undefined) ? pos.altitude : null,
            speed: (pos.speed !== undefined) ? pos.speed : null,
            timestamp: pos.timestamp || Date.now()
        };

        if (this.points.length > 0) {
            const lastPoint = this.points[this.points.length - 1];
            const dist = GPSTracker.calculateDistance(lastPoint.lat, lastPoint.lng, newPoint.lat, newPoint.lng);
            const dt = newPoint.timestamp - lastPoint.timestamp;

            // Filtro anti-ruido: mismo punto, o muy cerca en poco tiempo
            if (dist < this.minDistanceM || dt < this.minIntervalMs) {
                this.stats.duration = Date.now() - this.stats.startTime;
                if (this.onStatsUpdate) this.onStatsUpdate(this.stats);
                return;
            }

            if (this._skipNextDistance) {
                this._skipNextDistance = false;
            } else {
                this.stats.distance += dist;
            }

            if (newPoint.speed !== null && newPoint.speed > this.stats.maxSpeed) {
                this.stats.maxSpeed = newPoint.speed;
            }

            if (newPoint.altitude !== null && lastPoint.altitude !== null) {
                const diff = newPoint.altitude - lastPoint.altitude;
                if (diff > 0) this.stats.elevGain += diff;
                else this.stats.elevLoss += Math.abs(diff);
            }
        }

        this.points.push(newPoint);
        this.stats.duration = Date.now() - this.stats.startTime;
        this.stats.avgSpeed = this.stats.duration > 0
            ? (this.stats.distance / (this.stats.duration / 1000))
            : 0;

        if (this.mapEngine) {
            this.mapEngine.addTrackLine(this.points, this.color, 'current');
        }

        if (this.onStatsUpdate) this.onStatsUpdate(this.stats);
    }
}
