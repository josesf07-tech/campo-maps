export class GPSTracker {
    constructor() {
        this.watchId = null;
        this.onPositionUpdate = null;
        this.onError = null;
        this.lastPosition = null;
    }

    start() {
        if (!navigator.geolocation) {
            if (this.onError) this.onError(new Error("Geolocalización no soportada por el navegador."));
            return;
        }

        const options = {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        };

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
        window.removeEventListener('deviceorientation', this.handleOrientation);
    }

    getCurrentPosition() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                const err = new Error("Geolocalización no soportada por el navegador.");
                if (this.onError) this.onError(err);
                return reject(err);
            }

            const options = {
                enableHighAccuracy: true,
                timeout: 12000,
                maximumAge: 5000
            };

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    this.handlePosition(pos);
                    resolve(this.lastPosition);
                },
                (err) => {
                    this.handleError(err);
                    reject(err);
                },
                options
            );
        });
    }

    getPosition() {
        return this.lastPosition;
    }

    handlePosition(position) {
        const pos = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            altitude: position.coords.altitude,
            speed: position.coords.speed,
            accuracy: position.coords.accuracy,
            heading: position.coords.heading,
            timestamp: position.timestamp
        };
        this.lastPosition = pos;
        if (this.onPositionUpdate) this.onPositionUpdate(pos);
    }

    handleError(error) {
        let msg = "Error de GPS.";
        switch(error.code) {
            case error.PERMISSION_DENIED:
                msg = "Permiso denegado para usar el GPS.";
                break;
            case error.POSITION_UNAVAILABLE:
                msg = "Información de ubicación no disponible.";
                break;
            case error.TIMEOUT:
                msg = "Tiempo de espera agotado al obtener la ubicación.";
                break;
        }
        if (this.onError) this.onError(new Error(msg));
    }

    async initCompass() {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permissionState = await DeviceOrientationEvent.requestPermission();
                if (permissionState === 'granted') {
                    window.addEventListener('deviceorientation', this.handleOrientation.bind(this));
                }
            } catch (error) {
                console.error("Error pidiendo permiso para brújula:", error);
            }
        } else {
            window.addEventListener('deviceorientation', this.handleOrientation.bind(this));
        }
    }

    handleOrientation(event) {
        let heading = null;
        if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
            heading = event.webkitCompassHeading;
        } else if (event.alpha !== null && event.alpha !== undefined) {
            heading = 360 - event.alpha;
        }
        
        if (heading !== null) {
            this.currentHeading = Math.round(heading);
            if (this.lastPosition) {
                this.lastPosition.heading = this.currentHeading;
                if (this.onPositionUpdate) this.onPositionUpdate(this.lastPosition);
            }
        }
    }

    getHeading() {
        return this.currentHeading !== undefined ? this.currentHeading : null;
    }

    static headingToCardinal(heading) {
        if (heading === null || heading === undefined || isNaN(heading)) return '';
        const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const val = Math.round(heading / 22.5) % 16;
        return directions[val];
    }

    static calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3; // metres
        const φ1 = lat1 * Math.PI/180;
        const φ2 = lat2 * Math.PI/180;
        const Δφ = (lat2-lat1) * Math.PI/180;
        const Δλ = (lon2-lon1) * Math.PI/180;

        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

        return R * c; 
    }

    static formatCoordinate(coord, type = 'DD', isLat = true) {
        if (type === 'DD') {
            return coord.toFixed(5);
        }
        
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
