/**
 * Navegación inferior, paneles laterales y modales.
 *
 * Cablea el esqueleto de la interfaz: la barra de navegación, la apertura y
 * cierre de los cuatro paneles laterales (con su capa de fondo) y el cierre
 * genérico de los modales.
 */

import { state } from './state.js';

// ========== NAVIGATION ==========
export function setupNavigation() {
    // Bottom nav buttons
    document.querySelectorAll('#bottom-nav .nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            if (target) {
                togglePanel(target);
            }
        });
    });
}

// ========== PANELS ==========
export function setupPanels() {
    // Close panel buttons
    document.querySelectorAll('.btn-close-panel').forEach(btn => {
        btn.addEventListener('click', () => {
            closeAllPanels();
        });
    });

    // Overlay click closes panel
    const overlay = document.getElementById('panel-overlay');
    if (overlay) {
        overlay.addEventListener('click', closeAllPanels);
    }
}

export function togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    const overlay = document.getElementById('panel-overlay');

    if (state.currentPanel === panelId) {
        closeAllPanels();
        return;
    }

    // Close any open panel first
    closeAllPanels();

    if (panel) {
        panel.classList.add('open');
        if (overlay) overlay.classList.remove('hidden');
        state.currentPanel = panelId;

        // Update active nav (el botón GPS se gestiona por estado del GPS)
        document.querySelectorAll('#bottom-nav .nav-item[data-target]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.target === panelId);
        });
    }
}

export function closeAllPanels() {
    document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
    const overlay = document.getElementById('panel-overlay');
    if (overlay) overlay.classList.add('hidden');
    state.currentPanel = null;
    document.querySelectorAll('#bottom-nav .nav-item[data-target]').forEach(btn => btn.classList.remove('active'));
    const btnGps = document.getElementById('btn-nav-gps');
    if (btnGps) btnGps.classList.toggle('active', !!state.gpsActive);
}

// ========== MODALS ==========
export function setupModals() {
    // Close modal buttons
    document.querySelectorAll('.btn-close-modal, .btn-cancel-modal').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = btn.closest('.modal');
            if (modal) modal.classList.add('hidden');
        });
    });

    // Click outside modal to close (excepto formularios con datos: data-no-dismiss)
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal && !modal.hasAttribute('data-no-dismiss')) {
                modal.classList.add('hidden');
            }
        });
    });

    // Escape cierra el modal visible (salvo la cámara)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = Array.from(document.querySelectorAll('.modal:not(.hidden)')).pop();
        if (open && open.id !== 'modal-camera' && !open.hasAttribute('data-no-dismiss')) open.classList.add('hidden');
    });
}
