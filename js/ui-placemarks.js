/**
 * Interfaz de marcadores: alta, ficha de censo y lista del panel.
 *
 * Cablea el botón flotante y la pulsación larga sobre el mapa, el selector de
 * icono, el formulario del censo de Uso y Usuarios (chips y acordeón) y el
 * guardado del marcador con sus fotos. La lista del panel filtra por proyecto
 * activo, igual que las exportaciones.
 *
 * Las fotos viven en js/ui-photos.js y las exportaciones en js/ui-exports.js:
 * este módulo solo los arranca desde `setupPlacemarks()`, en el mismo punto en
 * el que se cableaban antes.
 */

import { state } from './state.js';
import { ICONS, PM_ICON_MAP, escapeHtml, emptyState, showToast } from './ui-utils.js';
import { closeAllPanels } from './ui-panels.js';
import { setupPhotos } from './ui-photos.js';
import { setupExports } from './ui-exports.js';
import { toMagnaSirgas } from './coords.js';
import { getPlacemarks } from './storage.js';
import { FUENTES_AGUA, RESIDUOS_LIQUIDOS, RESIDUOS_SOLIDOS } from './excel-export.js';

// ========== PLACEMARKS ==========
export function setupPlacemarks() {
    // FAB button - add placemark exactly at the crosshair pointer (Avenza style)
    const fab = document.getElementById('fab-add-placemark');
    if (fab) {
        fab.addEventListener('click', () => {
            const center = state.mapEngine.getCenter();
            openPlacemarkModal({ lat: center.lat, lng: center.lng });
        });
    }

    // Long press on map to add placemark
    state.mapEngine.onMapLongPress((e) => {
        openPlacemarkModal(e.latlng);
    });

    // Icon selector
    document.querySelectorAll('.icon-option').forEach(opt => {
        opt.addEventListener('click', () => {
            document.querySelectorAll('.icon-option').forEach(o => {
                o.classList.remove('selected');
                o.setAttribute('aria-checked', 'false');
            });
            opt.classList.add('selected');
            opt.setAttribute('aria-checked', 'true');
            state.selectedIcon = opt.dataset.icon;
        });
    });

    // Save placemark button
    const btnSave = document.getElementById('btn-save-placemark');
    if (btnSave) {
        btnSave.addEventListener('click', savePlacemarkFromModal);
    }

    // Fotos del marcador (ráfaga, cámara nativa y galería): js/ui-photos.js
    setupPhotos();

    // Update badge helper for Censo accordions
    const updateBadge = (containerId) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        const count = container.querySelectorAll('.censo-chip.selected').length;
        const details = container.closest('details');
        if (details) {
            const badge = details.querySelector('.censo-badge');
            if (badge) {
                badge.textContent = count > 0 ? `✓ ${count} sel.` : '0 sel.';
                if (count > 0) {
                    badge.classList.add('has-selection');
                } else {
                    badge.classList.remove('has-selection');
                }
            }
        }
    };
    window.__campoMapsUpdateBadges = () => {
        ['chips-fuente-primaria', 'chips-fuente-secundaria', 'chips-fuente-pecuario', 'chips-fuente-agricola', 'chips-residuo-liquido', 'chips-residuo-solido'].forEach(id => updateBadge(id));
    };

    // Render multi-select chips for Uso y Usuarios
    const renderChips = (containerId, items) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        items.forEach(item => {
            const chip = document.createElement('div');
            chip.className = 'censo-chip';
            chip.dataset.val = item;
            chip.textContent = item;
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                chip.classList.toggle('selected');
                chip.textContent = chip.classList.contains('selected') ? `✓ ${item}` : item;
                updateBadge(containerId);
            });
            container.appendChild(chip);
        });
        updateBadge(containerId);
    };

    renderChips('chips-fuente-primaria', FUENTES_AGUA);
    renderChips('chips-fuente-secundaria', FUENTES_AGUA);
    renderChips('chips-fuente-pecuario', FUENTES_AGUA);
    renderChips('chips-fuente-agricola', FUENTES_AGUA);
    renderChips('chips-residuo-liquido', RESIDUOS_LIQUIDOS);
    renderChips('chips-residuo-solido', RESIDUOS_SOLIDOS);

    // Toggle Censo Accordion (Robust handler without double-event trap)
    const toggleCensoHeader = document.getElementById('toggle-censo-header');
    const checkEnableCenso = document.getElementById('check-enable-censo');
    const censoFormBody = document.getElementById('censo-form-body');
    const censoArrow = document.getElementById('censo-arrow');

    if (toggleCensoHeader && censoFormBody) {
        toggleCensoHeader.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const willOpen = censoFormBody.classList.contains('hidden');
            if (checkEnableCenso) checkEnableCenso.checked = willOpen;
            if (willOpen) {
                censoFormBody.classList.remove('hidden');
                if (censoArrow) {
                    censoArrow.textContent = 'Ocultar';
                    censoArrow.classList.add('open');
                }
                setTimeout(() => {
                    const modalBody = toggleCensoHeader.closest('.modal-body');
                    if (modalBody) {
                        modalBody.scrollTo({
                            top: toggleCensoHeader.offsetTop - 15,
                            behavior: 'smooth'
                        });
                    }
                }, 100);
            } else {
                censoFormBody.classList.add('hidden');
                if (censoArrow) {
                    censoArrow.textContent = 'Activar';
                    censoArrow.classList.remove('open');
                }
            }
        });
    }

    // Exportación a KMZ, Word y Excel del proyecto activo: js/ui-exports.js
    setupExports();
}

let pendingPlacemarkLatLng = null;

export function openPlacemarkModal(latlng) {
    pendingPlacemarkLatLng = latlng;

    // Reset form
    const nameInput = document.getElementById('pm-name');
    const descInput = document.getElementById('pm-desc');
    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';

    // Reset icon selection
    document.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
    const defaultIcon = document.querySelector('.icon-option[data-icon="default"]');
    if (defaultIcon) defaultIcon.classList.add('selected');
    state.selectedIcon = 'default';

    // Reset photos
    if (window.__campoMapsClearPhotos) window.__campoMapsClearPhotos();

    // Reset Censo form
    const checkCenso = document.getElementById('check-enable-censo');
    const censoBody = document.getElementById('censo-form-body');
    const censoArrow = document.getElementById('censo-arrow');
    if (checkCenso) checkCenso.checked = false;
    if (censoBody) censoBody.classList.add('hidden');
    if (censoArrow) {
        censoArrow.textContent = 'Activar';
        censoArrow.classList.remove('open');
    }

    const censoIdCampo = document.getElementById('censo-id-campo');
    if (censoIdCampo) censoIdCampo.value = '';
    const censoMun = document.getElementById('censo-municipio');
    if (censoMun) censoMun.value = '';
    const censoVer = document.getElementById('censo-vereda');
    if (censoVer) censoVer.value = '';
    const censoPredio = document.getElementById('censo-predio');
    if (censoPredio) censoPredio.value = '';
    const censoHab = document.getElementById('censo-habitantes');
    if (censoHab) censoHab.value = '';
    const censoOtros = document.getElementById('censo-otros-usos');
    if (censoOtros) censoOtros.value = '';

    // Clear all chips selection and reset text
    document.querySelectorAll('.censo-chip').forEach(c => {
        c.classList.remove('selected');
        c.textContent = c.dataset.val;
    });
    if (window.__campoMapsUpdateBadges) window.__campoMapsUpdateBadges();

    const censoCota = document.getElementById('censo-cota');
    if (censoCota) {
        if (state.gps && state.gps.lastPosition && state.gps.lastPosition.altitude !== null) {
            censoCota.value = Math.round(state.gps.lastPosition.altitude);
        } else {
            censoCota.value = '';
        }
    }

    // Update live coordinates and precision display
    const statusMagna = document.getElementById('pm-status-magna');
    const statusAcc = document.getElementById('pm-status-acc');
    const btnAverage = document.getElementById('btn-average-gps');

    if (latlng) {
        const magna = toMagnaSirgas(latlng.lat, latlng.lng);
        if (statusMagna) statusMagna.textContent = `N: ${Math.round(magna.norte).toLocaleString('es-CO')} | E: ${Math.round(magna.este).toLocaleString('es-CO')}`;
    }

    const currentAcc = (state.gps && state.gps.lastPosition) ? state.gps.lastPosition.accuracy : null;
    if (statusAcc) {
        if (currentAcc) {
            const accVal = Math.round(currentAcc);
            const qual = accVal <= 5 ? '🟢 Alta' : (accVal <= 15 ? '🟡 Media' : '🔴 Baja (Interiores)');
            statusAcc.textContent = `Precisión actual: ±${accVal} m (${qual})`;
        } else {
            statusAcc.textContent = 'Precisión: Punto fijado en pantalla';
        }
    }

    if (btnAverage) {
        btnAverage.textContent = '🎯 Promediar GPS';
        btnAverage.disabled = false;
        btnAverage.onclick = async () => {
            if (!state.gps || !state.gps.getAveragedPosition) {
                showToast('GPS no activo');
                return;
            }
            btnAverage.disabled = true;
            try {
                showToast('📡 Tomando lecturas para estabilizar...');
                const avgPos = await state.gps.getAveragedPosition(8, (curr, total, acc) => {
                    btnAverage.textContent = `⏳ ${curr}/${total} (±${Math.round(acc)}m)`;
                });

                pendingPlacemarkLatLng = { lat: avgPos.lat, lng: avgPos.lng };
                const m = toMagnaSirgas(avgPos.lat, avgPos.lng);
                if (statusMagna) statusMagna.textContent = `N: ${Math.round(m.norte).toLocaleString('es-CO')} | E: ${Math.round(m.este).toLocaleString('es-CO')}`;
                if (statusAcc) statusAcc.textContent = `🎯 Promediado con éxito (±${avgPos.accuracy} m - 8 lecturas)`;
                btnAverage.textContent = `✔ ±${avgPos.accuracy}m`;
                showToast(`🎯 Coordenadas estabilizadas a ±${avgPos.accuracy} m`);
            } catch (err) {
                btnAverage.textContent = '🎯 Reintentar';
                btnAverage.disabled = false;
                showToast('⚠️ No se pudo promediar: ' + err.message);
            }
        };
    }

    // Show modal
    const modal = document.getElementById('modal-placemark');
    if (modal) modal.classList.remove('hidden');
}

export async function savePlacemarkFromModal() {
    if (!pendingPlacemarkLatLng) return;

    const name = document.getElementById('pm-name')?.value || 'Marcador';
    const desc = document.getElementById('pm-desc')?.value || '';
    const photos = window.__campoMapsGetPhotos ? window.__campoMapsGetPhotos() : [];

    // Helper to get selected chip values
    const getSelectedChips = (containerId) => {
        const container = document.getElementById(containerId);
        if (!container) return [];
        return Array.from(container.querySelectorAll('.censo-chip.selected')).map(c => c.dataset.val);
    };

    // Check if Censo is enabled
    const isCensoEnabled = document.getElementById('check-enable-censo')?.checked;
    let censoData = null;
    if (isCensoEnabled) {
        censoData = {
            idCampo: document.getElementById('censo-id-campo')?.value.trim() || '',
            municipio: document.getElementById('censo-municipio')?.value.trim() || '',
            vereda: document.getElementById('censo-vereda')?.value.trim() || '',
            predio: document.getElementById('censo-predio')?.value.trim() || '',
            habitantes: document.getElementById('censo-habitantes')?.value.trim() || '',
            cota: document.getElementById('censo-cota')?.value.trim() || '',
            fuentePrimaria: getSelectedChips('chips-fuente-primaria'),
            fuenteSecundaria: getSelectedChips('chips-fuente-secundaria'),
            fuentePecuario: getSelectedChips('chips-fuente-pecuario'),
            fuenteAgricola: getSelectedChips('chips-fuente-agricola'),
            otrosUsos: document.getElementById('censo-otros-usos')?.value.trim() || '',
            residuoLiquido: getSelectedChips('chips-residuo-liquido'),
            residuoSolido: getSelectedChips('chips-residuo-solido')
        };
    }

    const data = {
        name,
        description: desc,
        icon: state.selectedIcon,
        color: '#10b981',
        photos: photos,
        censoAgua: censoData,
        projectId: state.currentProjectId || 'default_proj',
        createdAt: new Date().toISOString()
    };

    await state.placemarkManager.addPlacemark(pendingPlacemarkLatLng, data);

    // Close modal
    const modal = document.getElementById('modal-placemark');
    if (modal) modal.classList.add('hidden');

    pendingPlacemarkLatLng = null;
    if (window.__campoMapsClearPhotos) window.__campoMapsClearPhotos();

    await updatePlacemarksList();
    showToast(photos.length > 0 ? `📌 Marcador con ${photos.length} foto(s) guardado` : '📌 Marcador guardado');
}

export async function updatePlacemarksList() {
    const list = document.getElementById('list-placemarks');
    if (!list) return;

    const allPms = await getPlacemarks();
    const placemarks = allPms.filter(pm => {
        if (!state.currentProjectId || state.currentProjectId === 'default_proj') {
            return !pm.projectId || pm.projectId === 'default_proj';
        }
        return pm.projectId === state.currentProjectId;
    });
    let html = '';

    placemarks.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    placemarks.forEach(pm => {
        const icon = PM_ICON_MAP[pm.icon] || '📍';
        const magna = toMagnaSirgas(pm.lat, pm.lng);
        const photoCount = Array.isArray(pm.photos) ? pm.photos.length : 0;
        const hasCenso = !!pm.censoAgua;

        html += `
        <li class="list-item" data-id="${pm.id}">
            <div class="item-icon">${icon}</div>
            <div class="item-details">
                <h3 class="item-title">${escapeHtml(pm.name || 'Sin nombre')}</h3>
                <p class="item-meta mono">${magna.formatted}</p>
                ${(photoCount > 0 || hasCenso) ? `<div class="row mt-8" style="gap:4px">${photoCount > 0 ? `<span class="badge">📷 ${photoCount}</span>` : ''}${hasCenso ? '<span class="badge badge-sky">Censo</span>' : ''}</div>` : ''}
            </div>
            <button class="btn-icon btn-delete-pm" data-id="${pm.id}" aria-label="Eliminar marcador">${ICONS.trash}</button>
        </li>`;
    });

    list.innerHTML = html || emptyState('📍', 'Sin marcadores en este proyecto. Usa el botón + sobre la mira.');

    // Delete handlers
    list.querySelectorAll('.btn-delete-pm').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (confirm('¿Eliminar este marcador?')) {
                await state.placemarkManager.deletePlacemark(id);
                await updatePlacemarksList();
                showToast('Marcador eliminado');
            }
        });
    });

    // Click to zoom
    list.querySelectorAll('.list-item').forEach(item => {
        item.addEventListener('click', () => {
            const pm = placemarks.find(p => p.id === item.dataset.id);
            if (pm) {
                state.mapEngine.setView(pm.lat, pm.lng, 16);
                closeAllPanels();
            }
        });
    });
}
