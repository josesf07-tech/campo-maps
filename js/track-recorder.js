import { GPSTracker } from './gps-tracker.js';
import { generateUUID } from './storage.js';

export class TrackRecorder {
    constructor(gpsTracker, mapEngine) {
        this.gpsTracker = gpsTracker;
        this.mapEngine = mapEngine;
        this.state = 'idle'; // idle, recording, paused
        
        this.points = [];
        this.stats = this.getDefaultStats();
        this.trackId = null;
        this.name = "";
        this.color = "#FF0000";
        
        this.onStatsUpdate = null;
        
        // Bind gps callback
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

    startRecording(name = "Nuevo Recorrido", color = "#FF0000") {
        this.state = 'recording';
        this.trackId = generateUUID();
        this.name = name;
        this.color = color;
        this.points = [];
        this.stats = this.getDefaultStats();
        this.stats.startTime = Date.now();
        
        const originalCallback = this.gpsTracker.onPositionUpdate;
        this.gpsTracker.onPositionUpdate = (pos) => {
            if (originalCallback) originalCallback(pos);
            this.handlePosition(pos);
        };
    }

    pauseRecording() {
        if (this.state === 'recording') {
            this.state = 'paused';
        }
    }

    resumeRecording() {
        if (this.state === 'paused') {
            this.state = 'recording';
        }
    }

    stopRecording() {
        this.state = 'idle';
        this.stats.endTime = Date.now();
        
        // Finalize duration
        this.stats.duration = this.stats.endTime - this.stats.startTime;
        if (this.stats.duration > 0 && this.points.length > 0) {
            this.stats.avgSpeed = (this.stats.distance / 1000) / (this.stats.duration / 3600000); // km/h
        }
        
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
        
        // Ignore very inaccurate positions for tracks
        if (pos.accuracy > 50) return; 

        const newPoint = {
            lat: pos.lat,
            lng: pos.lng,
            altitude: pos.altitude,
            speed: pos.speed,
            timestamp: pos.timestamp
        };

        if (this.points.length > 0) {
            const lastPoint = this.points[this.points.length - 1];
            
            const dist = GPSTracker.calculateDistance(lastPoint.lat, lastPoint.lng, newPoint.lat, newPoint.lng);
            this.stats.distance += dist;
            
            if (newPoint.speed && newPoint.speed > this.stats.maxSpeed) {
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
        
        if (this.stats.duration > 0) {
            this.stats.avgSpeed = (this.stats.distance / 1000) / (this.stats.duration / 3600000); // km/h
        }

        // Render on map
        if (this.mapEngine) {
            this.mapEngine.addTrackLine(this.points, this.color);
        }
        
        if (this.onStatsUpdate) {
            this.onStatsUpdate(this.stats);
        }
    }
}
