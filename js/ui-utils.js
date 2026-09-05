/**
 * Utilidades compartidas de interfaz.
 *
 * Aquí viven los helpers que usan casi todos los módulos de interfaz: escape de
 * HTML, avisos (`showToast`), capa de carga, visor de fotos (lightbox), iconos
 * SVG en línea y el marcador de lista vacía. No dependen del estado de la app.
 */

export const ICONS = {
    trash: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    route: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    globe: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    map: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
    folder: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    record: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>',
    stop: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    camera: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
};

export const PM_ICON_MAP = { default: '📍', tree: '🌳', water: '💧', warning: '⚠️', camera: '📷' };

export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function showLoading(message = 'Procesando...') {
    const overlay = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    if (text) text.textContent = message;
    if (overlay) overlay.classList.remove('hidden');
}

export function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('hidden');
}

export function openLightbox(url, caption = '') {
    const box = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    const cap = document.getElementById('lightbox-caption');
    if (!box || !img) return;
    img.src = url;
    if (cap) cap.textContent = caption;
    box.classList.remove('hidden');
}

export function closeLightbox() {
    const box = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    if (box) box.classList.add('hidden');
    if (img) setTimeout(() => { if (box && box.classList.contains('hidden')) img.src = ''; }, 250);
}

export function setupLightbox() {
    const box = document.getElementById('lightbox');
    const btnClose = document.getElementById('lightbox-close');
    if (btnClose) btnClose.addEventListener('click', closeLightbox);
    if (box) box.addEventListener('click', (e) => { if (e.target === box) closeLightbox(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
    window.__campoMapsOpenPhoto = openLightbox;
}

export function emptyState(icon, text) {
    return `<li class="empty-state"><div class="empty-icon">${icon}</div>${escapeHtml(text)}</li>`;
}

// ========== TOAST NOTIFICATIONS ==========
export function showToast(message, duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    let type = '';
    if (/^(❌|🛑)/.test(message)) type = ' toast-error';
    else if (/^(⚠️|⚠)/.test(message)) type = ' toast-warn';
    else if (/^(📡|📄|📥|📦|⚡|🗺️|🛰️)/.test(message)) type = ' toast-info';
    toast.className = 'toast' + type;
    toast.textContent = message;

    // Máximo 3 avisos visibles a la vez
    while (container.children.length >= 3) container.removeChild(container.firstChild);

    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
    }, duration);
}
