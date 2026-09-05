/**
 * Proyectos: alta, cambio de proyecto activo y lista del modal.
 *
 * El proyecto activo (`state.currentProjectId`) decide qué marcadores se
 * dibujan en el mapa, cuáles salen en la lista y cuáles se exportan; se guarda
 * en ajustes como 'activeProjectId' para recuperarlo al arrancar.
 */

import { state } from './state.js';
import { ICONS, escapeHtml, showToast } from './ui-utils.js';
import { updatePlacemarksList } from './ui-placemarks.js';
import { exportPlacemarksToKMZ } from './kmz-export.js';
import {
    getPlacemarks, saveSetting, getMap,
    saveProject, getProjects, getProject, deleteProject, generateUUID
} from './storage.js';

// ========== PROJECTS MANAGEMENT ==========
export async function setupProjects() {
    const btnOpenProjects = document.getElementById('btn-open-projects');
    const btnQuickProjects = document.getElementById('btn-quick-projects');
    const btnMapsSwitchProject = document.getElementById('btn-panel-maps-switch-project');
    const btnPmSwitchProject = document.getElementById('btn-panel-pm-switch-project');
    const btnSettingsOpenProjects = document.getElementById('btn-settings-open-projects');
    const modalProjects = document.getElementById('modal-projects');
    const btnShowForm = document.getElementById('btn-show-project-form');
    const formBox = document.getElementById('project-form-box');
    const btnCancelForm = document.getElementById('btn-cancel-project-form');
    const btnSaveProject = document.getElementById('btn-save-new-project');
    const inputName = document.getElementById('new-project-name');
    const inputDesc = document.getElementById('new-project-desc');

    const openModalProjects = async () => {
        if (modalProjects) modalProjects.classList.remove('hidden');
        await updateProjectsList();
    };

    [btnOpenProjects, btnQuickProjects, btnMapsSwitchProject, btnPmSwitchProject, btnSettingsOpenProjects].forEach(btn => {
        if (btn) btn.addEventListener('click', openModalProjects);
    });

    if (btnShowForm && formBox) {
        btnShowForm.addEventListener('click', () => {
            formBox.classList.toggle('hidden');
            if (!formBox.classList.contains('hidden') && inputName) {
                inputName.focus();
            }
        });
    }

    if (btnCancelForm && formBox) {
        btnCancelForm.addEventListener('click', () => {
            formBox.classList.add('hidden');
            if (inputName) inputName.value = '';
            if (inputDesc) inputDesc.value = '';
        });
    }

    if (btnSaveProject) {
        btnSaveProject.addEventListener('click', async () => {
            const name = inputName?.value?.trim();
            const desc = inputDesc?.value?.trim() || '';

            if (!name) {
                showToast('⚠️ Ingresa un nombre para el proyecto');
                return;
            }

            const newProj = {
                id: generateUUID(),
                name,
                description: desc,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            await saveProject(newProj);
            if (formBox) formBox.classList.add('hidden');
            if (inputName) inputName.value = '';
            if (inputDesc) inputDesc.value = '';

            await switchProject(newProj.id);
            await updateProjectsList();
            showToast(`✅ Proyecto "${name}" creado y activado`);
        });
    }
}

export async function switchProject(projectId, { silent = false } = {}) {
    let proj = await getProject(projectId);
    if (!proj) {
        const projects = await getProjects();
        if (projects.length > 0) {
            proj = projects[0];
        } else {
            proj = {
                id: 'default_proj',
                name: 'Proyecto General',
                description: 'Proyecto inicial de campo',
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            await saveProject(proj);
        }
    }

    state.currentProjectId = proj.id;
    state.currentProjectName = proj.name;

    // Update top bar label
    const labelEl = document.getElementById('active-project-label');
    if (labelEl) labelEl.textContent = proj.name;

    // Update Project Name in Maps panel
    const panelMapsProjectName = document.getElementById('panel-maps-project-name');
    if (panelMapsProjectName) panelMapsProjectName.textContent = proj.name;

    // Update Project Name in Placemarks panel
    const panelPmProjectName = document.getElementById('panel-placemarks-project-name');
    if (panelPmProjectName) panelPmProjectName.textContent = proj.name;

    // Update Project Name in Settings for photo watermark
    const inputProjectName = document.getElementById('input-project-name');
    if (inputProjectName) inputProjectName.value = proj.name;

    // Save active project id in settings
    await saveSetting('activeProjectId', proj.id);

    // Filter and reload placemarks for this project
    await loadPlacemarksForProject(proj.id);

    // If project has an associated map (GeoPDF), activate and load it
    if (proj.mapId) {
        const mapData = await getMap(proj.mapId);
        const img = mapData ? (mapData.imageData || mapData.dataUrl || mapData.imageUrl) : null;
        if (mapData && img && mapData.bounds && state.mapEngine) {
            if (!state.mapEngine.hasImageOverlay(mapData.id)) {
                state.mapEngine.addImageOverlay(mapData.id, img, mapData.bounds, { opacity: mapData.opacity !== undefined ? mapData.opacity : 1 });
            }
            state.mapEngine.fitBounds(mapData.bounds);
            state.lastLoadedGeoPdfBounds = mapData.bounds;
            state.lastLoadedGeoPdfName = mapData.name || 'Plano GeoPDF';
            if (state.tileDownloader) {
                state.tileDownloader.activeGeoPdfBounds = mapData.bounds;
                state.tileDownloader.activeGeoPdfName = state.lastLoadedGeoPdfName;
            }
        }
    }

    // Close modal
    const modalProjects = document.getElementById('modal-projects');
    if (modalProjects) modalProjects.classList.add('hidden');

    if (!silent) showToast(`📁 Proyecto activo: ${proj.name}`);
}

export async function loadPlacemarksForProject(projectId = null) {
    const targetProjId = projectId || state.currentProjectId;

    // Clear existing map markers and vision cones
    if (state.placemarkManager) {
        state.placemarkManager.clearAll();
    }

    const allPms = await getPlacemarks();
    // Filter placemarks that belong to this project (or no projectId for default)
    const projectPms = allPms.filter(pm => {
        if (!targetProjId || targetProjId === 'default_proj') {
            return !pm.projectId || pm.projectId === 'default_proj';
        }
        return pm.projectId === targetProjId;
    });

    if (state.placemarkManager) {
        state.placemarkManager.placemarks = projectPms;
        state.placemarkManager.renderAll();
    }

    await updatePlacemarksList();
}

export async function updateProjectsList() {
    const listEl = document.getElementById('list-projects');
    if (!listEl) return;

    let projects = await getProjects();
    if (!projects || projects.length === 0) {
        const defProj = {
            id: 'default_proj',
            name: 'Proyecto General',
            description: 'Proyecto inicial de campo',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await saveProject(defProj);
        projects = [defProj];
    }

    const allPms = await getPlacemarks();

    listEl.innerHTML = projects.map(p => {
        const isActive = p.id === state.currentProjectId;
        const pmsCount = allPms.filter(pm => {
            if (p.id === 'default_proj') return !pm.projectId || pm.projectId === 'default_proj';
            return pm.projectId === p.id;
        }).length;

        const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleDateString('es-CO') : '';

        return `
            <li class="list-item project-item static ${isActive ? 'active' : ''}">
                <div class="item-icon">${ICONS.folder}</div>
                <div class="item-details">
                    <div class="item-title">
                        <span class="truncate">${escapeHtml(p.name)}</span>
                        ${isActive ? '<span class="badge badge-solid">Activo</span>' : ''}
                    </div>
                    ${p.description ? `<p class="item-meta truncate">${escapeHtml(p.description)}</p>` : ''}
                    <div class="item-meta text-faint">📍 ${pmsCount} punto${pmsCount === 1 ? '' : 's'} · ${dateStr}</div>
                </div>
                <div class="item-actions">
                    ${!isActive ? `<button type="button" class="btn-activate-project btn-primary btn-xs" data-id="${p.id}">Activar</button>` : ''}
                    <div class="row" style="gap:2px">
                        <button type="button" class="btn-export-project-kmz btn-ghost sky btn-xs" data-id="${p.id}" title="Exportar este proyecto a KMZ">KMZ</button>
                        ${!isActive && projects.length > 1 ? `<button type="button" class="btn-delete-project btn-icon" data-id="${p.id}" title="Eliminar proyecto" aria-label="Eliminar proyecto">${ICONS.trash}</button>` : ''}
                    </div>
                </div>
            </li>
        `;
    }).join('');

    // Wire buttons
    listEl.querySelectorAll('.btn-activate-project').forEach(btn => {
        btn.addEventListener('click', async () => {
            await switchProject(btn.dataset.id);
            await updateProjectsList();
        });
    });

    listEl.querySelectorAll('.btn-export-project-kmz').forEach(btn => {
        btn.addEventListener('click', async () => {
            const pId = btn.dataset.id;
            const targetProj = projects.find(p => p.id === pId);
            const pms = allPms.filter(pm => {
                if (pId === 'default_proj') return !pm.projectId || pm.projectId === 'default_proj';
                return pm.projectId === pId;
            });

            if (pms.length === 0) {
                showToast(`⚠️ "${targetProj?.name}" no tiene marcadores aún`);
                return;
            }

            showToast(`📦 Exportando proyecto "${targetProj?.name}" a KMZ...`);
            const safeName = (targetProj?.name || 'Proyecto').replace(/[^a-zA-Z0-9_-]/g, '_');
            await exportPlacemarksToKMZ(pms, `${safeName}_MAGNA.kmz`);
            showToast('✅ KMZ exportado con éxito');
        });
    });

    listEl.querySelectorAll('.btn-delete-project').forEach(btn => {
        btn.addEventListener('click', async () => {
            const pId = btn.dataset.id;
            const targetProj = projects.find(p => p.id === pId);
            if (confirm(`¿Estás seguro de eliminar el proyecto "${targetProj?.name}" y desasociar sus datos?`)) {
                await deleteProject(pId);
                await updateProjectsList();
                showToast(`Proyecto "${targetProj?.name}" eliminado`);
            }
        });
    });
}
