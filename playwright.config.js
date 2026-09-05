/**
 * Configuración de las pruebas end-to-end (prueba de humo de la interfaz).
 *
 * Las pruebas unitarias (`npm test`) siguen usando el runner de Node sobre
 * `tests/*.test.mjs`; esta configuración solo mira `tests/e2e/*.spec.mjs`.
 */

import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';

const PUERTO = Number(process.env.PORT || 4173);
const BASE_URL = `http://127.0.0.1:${PUERTO}`;

// En este entorno Chromium ya está instalado fuera de la caché de Playwright.
// Si existe, se usa tal cual; si no, se deja que Playwright resuelva el suyo.
const CHROMIUM_LOCAL = '/opt/pw-browsers/chromium';
const executablePath = fs.existsSync(CHROMIUM_LOCAL) ? CHROMIUM_LOCAL : undefined;

export default defineConfig({
    testDir: './tests/e2e',
    testMatch: '**/*.spec.mjs',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    // Sin reintentos a propósito: una prueba de humo intermitente no sirve de
    // red de seguridad, así que la inestabilidad tiene que verse.
    retries: 0,
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

    use: {
        baseURL: BASE_URL,
        // Teléfono en vertical: la app es mobile-first.
        viewport: { width: 412, height: 915 },
        hasTouch: true,
        locale: 'es-CO',
        timezoneId: 'America/Bogota',
        // GPS simulado: sin esto la app se quedaría esperando una posición que
        // en un servidor sin GPS no llega nunca.
        permissions: ['geolocation'],
        geolocation: { latitude: 4.65, longitude: -74.06, accuracy: 8 },
        serviceWorkers: 'allow',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off'
    },

    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 412, height: 915 },
                hasTouch: true,
                launchOptions: {
                    executablePath,
                    args: [
                        // Cámara y micrófono inexistentes en headless: se
                        // sustituyen por dispositivos falsos y permiso concedido
                        // para que ningún diálogo bloquee la prueba.
                        '--use-fake-ui-for-media-stream',
                        '--use-fake-device-for-video-capture'
                    ]
                }
            }
        }
    ],

    webServer: {
        command: `node tests/e2e/static-server.mjs`,
        url: BASE_URL + '/index.html',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        env: { PORT: String(PUERTO) }
    }
});
