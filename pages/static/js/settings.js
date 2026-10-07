import { fetchModels } from './models.js';
import { PRUNE_POLICY_DEFERRED, PRUNE_POLICY_IMMEDIATE } from './config.js';
import { clampCacheTtl } from './pruneCache.js';
import { wireModalTabs } from './modalTabs.js';
import { store, persistThinkingPrefs, persistTheme } from './storage.js';
import { THEMES, applyTheme, normalizeTheme } from './theme.js';
import { renderChat } from './chat.js';
import {
    openSaveProgressModal,
    setProviderStatus,
    setModelsStatus,
    finishSaveProgress
} from './saveProgress.js';

let currentSettings = {};
let groupPreviewTimers = {};

// Theme selection is previewed live, so the value the dialog was opened with
// is retained in order to revert on Cancel. `pendingTheme` is what Save
// commits; the two are equal whenever there is nothing uncommitted.
let themeAtOpen = null;
let pendingTheme = null;

// Category ids shared by the rail buttons (data-panel) and the panel sections.
const SETTINGS_PANELS = ['endpoints', 'display', 'providers', 'network'];
const DEFAULT_SETTINGS_PANEL = 'endpoints';

let activePanel = DEFAULT_SETTINGS_PANEL;
let switchPanelFn = null;

/**
 * One delegated listener for the whole rail, installed once by the shared
 * helper. Safe to call repeatedly, since openSettingsModal runs on every open.
 */
function wireSettingsTabs() {
    switchPanelFn = wireModalTabs({
        railId: 'settings-tabs',
        hostId: 'settings-panels',
        tabClass: 'settings-tab',
        activeTabClass: 'settings-tab-active',
        panelClass: 'settings-panel',
        activePanelClass: 'settings-panel-active',
        panels: SETTINGS_PANELS,
        onSwitch: (panelId) => {
            activePanel = panelId;
        }
    });
}

/**
 * Mounts a single settings category. Unknown ids are ignored by the helper
 * rather than hiding every panel and leaving the dialog blank.
 */
export function switchSettingsPanel(panelId) {
    if (!SETTINGS_PANELS.includes(panelId)) return;
    if (!switchPanelFn) wireSettingsTabs();
    if (switchPanelFn) switchPanelFn(panelId);
}

async function resolveLogoPreview(val) {
    if (!val || !val.trim()) return '';
    const s = val.trim();
    if (s.startsWith('<svg') || s.startsWith('<?xml')) {
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
    }
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:')) {
        return s;
    }
    try {
        const res = await fetch('/v1/settings/preview_logo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ logo: s })
        });
        if (res.ok) {
            const d = await res.json();
            return d.resolved || s;
        }
    } catch (e) {}
    return s;
}

/** Coerces the cache-aware pruning fields on an endpoint to valid values. */
function normalizeEndpointCacheFields(ep) {
    if (!ep || typeof ep !== 'object') return;
    ep.prune_policy = ep.prune_policy === PRUNE_POLICY_IMMEDIATE ? PRUNE_POLICY_IMMEDIATE : PRUNE_POLICY_DEFERRED;
    ep.cache_ttl_seconds = clampCacheTtl(ep.cache_ttl_seconds);
}

function renderSettingsEndpoints() {
    const list = document.getElementById('endpoints-list');
    if (!list) return;
    list.innerHTML = '';

    const eps = currentSettings.custom_endpoints || [];
    eps.forEach((ep, i) => {
        const row = document.createElement('div');
        row.className = 'flex flex-col gap-3 bg-gb-bgDarkest p-4 rounded-lg border border-gb-bgLight2 relative animate-fade-in-up transition-all duration-300 transform origin-top';
        row.style.animationDelay = `${i * 0.05}s`;
        row.innerHTML = `
            <div class="flex flex-col xl:flex-row gap-3 w-full items-start xl:items-end">
                <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 flex-1 w-full min-w-0">
                    <div class="min-w-0">
                        <label class="text-xs text-gb-fgDark font-semibold uppercase">Name</label>
                        <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="Local vLLM" data-idx="${i}" data-field="name">
                    </div>
                    <div class="min-w-0">
                        <label class="text-xs text-gb-fgDark font-semibold uppercase">Base URL</label>
                        <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="http://localhost:8000/v1" data-idx="${i}" data-field="url">
                    </div>
                    <div class="min-w-0">
                        <label class="text-xs text-gb-fgDark font-semibold uppercase">API Key (Optional)</label>
                        <input type="password" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="sk-..." data-idx="${i}" data-field="api_key">
                    </div>
                    <div class="min-w-0">
                        <label class="text-xs text-gb-fgDark font-semibold uppercase">Logo (SVG / URL)</label>
                        <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="local.svg, /static/..., or URL" data-idx="${i}" data-field="logo">
                    </div>
                </div>
                <div class="flex items-center gap-2 shrink-0 self-end xl:self-auto pb-0.5">
                    <label class="flex items-center gap-1.5 text-xs font-semibold text-gb-fgLight cursor-pointer select-none whitespace-nowrap" title="Stream replies token-by-token in this web UI. When off, the chat page waits for the full response. Does not affect external API clients.">
                        <input type="checkbox" class="w-4 h-4 rounded border-gb-bgLight2 bg-gb-bgDarkest text-gb-blueAccent focus:ring-gb-blueAccent cursor-pointer" data-idx="${i}" data-field="stream">
                        Stream
                    </label>
                    <button class="check-ep-btn bg-gb-bgLight1 hover:bg-gb-bgLight2 text-gb-fgLight text-xs font-semibold px-2.5 py-1.5 rounded border border-gb-bgLight3 transition-all flex items-center gap-1.5 shadow-sm active:scale-95" data-idx="${i}" title="Check endpoint response time (< 1s)">
                        <i data-lucide="activity" class="w-3.5 h-3.5 text-gb-blueAccent"></i> <span>Check</span>
                    </button>
                    <button class="text-gb-fgDark hover:text-gb-redAccent p-1 rounded transition-colors delete-ep-btn" data-idx="${i}" title="Remove Endpoint">
                        <i data-lucide="trash-2" class="w-5 h-5"></i>
                    </button>
                </div>
            </div>
            <div id="check-status-${i}" class="hidden text-xs font-mono px-2.5 py-1 rounded border"></div>
            <div class="w-full mt-1">
                <label class="text-xs text-gb-fgDark font-semibold uppercase">Models (Optional)</label>
                <div class="flex gap-2 mt-1">
                    <input type="text" class="flex-1 bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1" placeholder="Add model (e.g., deepseek-ai/DeepSeek-V4-Flash...)" id="model-input-${i}">
                    <button class="bg-gb-bgLight2 hover:bg-gb-bgLight3 text-gb-fgLight font-bold px-3 py-1 rounded transition-colors flex items-center justify-center shrink-0 shadow-sm" id="add-model-btn-${i}" title="Add Model">
                        <i data-lucide="plus" class="w-4 h-4 text-gb-aquaAccent"></i>
                    </button>
                </div>
                <div id="models-list-${i}" class="flex flex-wrap gap-2 mt-3 empty:mt-0"></div>
                <p class="text-[10.5px] text-gb-fgDark mt-2 font-medium">If empty, fetches all available models. If provided, forces these exact models to be available.</p>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full mt-1">
                <div class="min-w-0">
                    <label class="text-xs text-gb-fgDark font-semibold uppercase">Prune Policy</label>
                    <select class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" data-idx="${i}" data-field="prune_policy">
                        <option value="deferred">Deferred (cache-aware)</option>
                        <option value="immediate">Immediate</option>
                    </select>
                </div>
                <div class="min-w-0">
                    <label class="text-xs text-gb-fgDark font-semibold uppercase">Cache TTL (seconds)</label>
                    <input type="number" min="30" max="3600" step="1" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" data-idx="${i}" data-field="cache_ttl_seconds">
                </div>
            </div>
            <p class="text-[10.5px] text-gb-fgDark font-medium">Deferred holds new prunes back while this model's prompt cache is warm, so the cached prefix survives. They apply once the cache goes cold, on a model switch, near the context limit, or when you press Apply now. Use Immediate for token quotas that ignore caching.</p>
        `;
        row.querySelector('[data-field="name"]').value = ep.name || '';
        row.querySelector('[data-field="url"]').value = ep.url || '';
        row.querySelector('[data-field="api_key"]').value = ep.api_key || '';
        row.querySelector('[data-field="logo"]').value = ep.logo || '';
        ep.stream = ep.stream !== false;
        row.querySelector('[data-field="stream"]').checked = ep.stream;
        normalizeEndpointCacheFields(ep);
        row.querySelector('[data-field="prune_policy"]').value = ep.prune_policy;
        row.querySelector('[data-field="cache_ttl_seconds"]').value = String(ep.cache_ttl_seconds);
        list.appendChild(row);

        const inputEl = document.getElementById(`model-input-${i}`);
        const addBtn = document.getElementById(`add-model-btn-${i}`);
        const modelsListEl = document.getElementById(`models-list-${i}`);

        if (typeof ep.models === 'string') {
            ep.models = ep.models.split(',').map(s => s.trim()).filter(Boolean);
        } else if (!Array.isArray(ep.models)) {
            ep.models = [];
        }

        const renderPills = () => {
            modelsListEl.innerHTML = '';
            ep.models.forEach((m, mIdx) => {
                const pill = document.createElement('div');
                pill.className = 'flex items-center gap-1 bg-gb-bg border border-gb-bgLight3 rounded pl-2 pr-1 py-1 text-xs font-mono text-gb-fgLight animate-fade-in-up';
                pill.innerHTML = `
                    <span class="truncate max-w-[200px]" title="${m}">${m}</span>
                    <button class="text-gb-fgDark hover:text-gb-redAccent rounded hover:bg-gb-bgLight2 p-0.5 transition-colors" title="Remove">
                        <i data-lucide="minus" class="w-3.5 h-3.5"></i>
                    </button>
                `;
                pill.querySelector('button').onclick = () => {
                    ep.models.splice(mIdx, 1);
                    renderPills();
                };
                modelsListEl.appendChild(pill);
            });
            lucide.createIcons();
        };

        const addModel = () => {
            const val = inputEl.value.trim();
            if (val && !ep.models.includes(val)) {
                ep.models.push(val);
                inputEl.value = '';
                renderPills();
            }
        };

        addBtn.onclick = addModel;
        inputEl.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addModel();
            }
        };

        renderPills();
    });

    list.querySelectorAll('.check-ep-btn').forEach(btn => {
        btn.onclick = async () => {
            const idx = Number(btn.getAttribute('data-idx'));
            const ep = currentSettings.custom_endpoints[idx];
            const statusDiv = document.getElementById(`check-status-${idx}`);
            const origHtml = btn.innerHTML;

            btn.disabled = true;
            btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin text-gb-blueAccent"></i> <span>Checking...</span>';
            lucide.createIcons();

            if (statusDiv) {
                statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-bgLight1/50 border-gb-bgLight3 text-gb-fgDark flex items-center gap-2';
                statusDiv.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> Ping in progress...';
                statusDiv.classList.remove('hidden');
                lucide.createIcons();
            }

            try {
                const res = await fetch('/v1/settings/check_endpoint', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: ep.url, api_key: ep.api_key })
                });
                const data = await res.json();
                if (statusDiv) {
                    if (data.ok && data.latency_ms <= 1000) {
                        statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-green/20 border-gb-greenAccent/40 text-gb-greenAccent flex items-center gap-2';
                        statusDiv.innerHTML = `<i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> <span>Responded in <b>${data.latency_ms}ms</b> (OK &lt; 1s)</span>`;
                    } else if (data.ok) {
                        statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-red/20 border-gb-redAccent/40 text-gb-redAccent flex items-center gap-2';
                        statusDiv.innerHTML = `<i data-lucide="clock-alert" class="w-3.5 h-3.5"></i> <span>Slow response: <b>${data.latency_ms}ms</b> (exceeds 1s threshold)</span>`;
                    } else {
                        statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-red/20 border-gb-redAccent/40 text-gb-redAccent flex items-center gap-2';
                        statusDiv.innerHTML = `<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> <span>Failed (${data.error || 'No response'} &middot; ${data.latency_ms}ms)</span>`;
                    }
                }
            } catch (e) {
                if (statusDiv) {
                    statusDiv.className = 'text-xs font-mono px-2.5 py-1 rounded border bg-gb-red/20 border-gb-redAccent/40 text-gb-redAccent flex items-center gap-2';
                    statusDiv.innerHTML = `<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> <span>Check error: ${e.message}</span>`;
                }
            } finally {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                lucide.createIcons();
            }
        };
    });

    list.querySelectorAll('.delete-ep-btn').forEach(btn => {
        btn.onclick = () => {
            btn.disabled = true;
            const epObj = currentSettings.custom_endpoints[Number(btn.getAttribute('data-idx'))];
            const row = btn.closest('.animate-fade-in-up');
            
            row.classList.remove('animate-fade-in-up');
            row.classList.add('opacity-0', 'scale-95', '-translate-y-2');
            
            setTimeout(() => {
                const realIdx = currentSettings.custom_endpoints.indexOf(epObj);
                if (realIdx > -1) {
                    currentSettings.custom_endpoints.splice(realIdx, 1);
                    renderSettingsEndpoints();
                }
            }, 300);
        };
    });

    list.querySelectorAll('input[data-field]').forEach(inp => {
        const idx = Number(inp.getAttribute('data-idx'));
        const field = inp.getAttribute('data-field');
        const ep = currentSettings.custom_endpoints[idx];
        if (!ep || !field) return;

        if (inp.type === 'checkbox') {
            inp.onchange = (e) => {
                ep[field] = e.target.checked;
            };
            return;
        }

        if (field === 'cache_ttl_seconds') {
            // Clamped on save, so a half-typed value is never fought mid-edit.
            inp.oninput = (e) => {
                ep[field] = parseInt(e.target.value, 10);
            };
            return;
        }

        inp.oninput = (e) => {
            ep[field] = e.target.value;
        };
    });

    list.querySelectorAll('select[data-field]').forEach(sel => {
        const ep = currentSettings.custom_endpoints[Number(sel.getAttribute('data-idx'))];
        const field = sel.getAttribute('data-field');
        if (!ep || !field) return;
        sel.onchange = (e) => {
            ep[field] = e.target.value;
        };
    });

    lucide.createIcons();
}

export function renderSettingsProviderGroups() {
    const list = document.getElementById('provider-groups-list');
    if (!list) return;
    list.innerHTML = '';

    const providers = currentSettings.providers || [];
    providers.forEach((group, idx) => {
        const row = document.createElement('div');
        row.className = 'flex flex-col gap-3 bg-gb-bgDarkest p-4 rounded-lg border border-gb-bgLight2 relative animate-fade-in-up';
        row.id = `group-row-${idx}`;

        const isPastingSvg = typeof group.logo === 'string' && (group.logo.trim().startsWith('<svg') || group.logo.trim().startsWith('<?xml'));
        const keywordsStr = Array.isArray(group.keywords) ? group.keywords.join(', ') : (group.keywords || '');

        row.innerHTML = `
            <div class="flex flex-col sm:flex-row gap-3 w-full items-start sm:items-center">
                <div class="w-10 h-10 rounded bg-white p-1 flex items-center justify-center shrink-0 border border-gb-bgLight3 overflow-hidden shadow-inner group-preview-box-${idx}">
                    <img src="" alt="Logo" class="w-full h-full object-contain group-preview-img-${idx} hidden">
                    <i data-lucide="image" class="w-5 h-5 text-gb-bgLight3 group-preview-placeholder-${idx}"></i>
                </div>
                <div class="w-40">
                    <label class="text-xs text-gb-fgDark font-semibold uppercase">Group ID</label>
                    <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1 font-mono" placeholder="llama" data-gidx="${idx}" data-gfield="id">
                </div>
                <div class="flex-1 w-full">
                    <label class="text-xs text-gb-fgDark font-semibold uppercase">Display Name</label>
                    <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="Meta Llama" data-gidx="${idx}" data-gfield="name">
                </div>
                <div class="flex items-center gap-2 mt-4 sm:mt-5 shrink-0 self-end sm:self-auto">
                    <button type="button" class="toggle-svg-paste-btn bg-gb-bgLight1 hover:bg-gb-bgLight2 text-gb-fgLight text-xs font-semibold px-2.5 py-1.5 rounded border border-gb-bgLight3 transition-all flex items-center gap-1 shadow-sm active:scale-95" data-gidx="${idx}" title="Toggle between URL/path and raw SVG paste">
                        <i data-lucide="code" class="w-3.5 h-3.5 text-gb-aquaAccent"></i> <span>${isPastingSvg ? 'Path / URL' : 'Paste SVG'}</span>
                    </button>
                    <button type="button" class="text-gb-fgDark hover:text-gb-redAccent p-1 rounded transition-colors delete-group-btn" data-gidx="${idx}" title="Remove Group">
                        <i data-lucide="trash-2" class="w-5 h-5"></i>
                    </button>
                </div>
            </div>

            <div class="w-full">
                <label class="text-xs text-gb-fgDark font-semibold uppercase">Keywords (Comma-separated)</label>
                <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 mt-1" placeholder="llama, codellama" data-gidx="${idx}" data-gfield="keywords">
                <p class="text-[10px] text-gb-fgDark mt-1">Models matching any of these keywords will be sorted under this picture.</p>
            </div>

            <div class="w-full group-logo-input-wrap-${idx}">
                <div class="flex justify-between items-center mb-1">
                    <label class="text-xs text-gb-fgDark font-semibold uppercase logo-field-label-${idx}">${isPastingSvg ? 'Raw SVG Markup' : 'Image URL / Local SVG File'}</label>
                </div>
                ${isPastingSvg ? `
                    <textarea class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-xs font-mono rounded focus:ring-1 focus:ring-gb-blueAccent outline-none p-2 resize-y h-24" placeholder="<svg ...>...</svg>" data-gidx="${idx}" data-gfield="logo-raw"></textarea>
                ` : `
                    <input type="text" class="w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded focus:ring-1 focus:ring-gb-blueAccent outline-none px-2 py-1 font-mono" placeholder="icons/llama.svg, /static/icons/logo.svg, or https://..." data-gidx="${idx}" data-gfield="logo-path">
                `}
            </div>
        `;

        row.querySelector('[data-gfield="id"]').value = group.id || '';
        row.querySelector('[data-gfield="name"]').value = group.name || '';
        row.querySelector('[data-gfield="keywords"]').value = keywordsStr;
        
        const logoInput = row.querySelector('[data-gfield="logo-raw"]') || row.querySelector('[data-gfield="logo-path"]');
        if (logoInput) logoInput.value = group.logo || '';

        list.appendChild(row);

        const updatePreview = async (val) => {
            const imgEl = row.querySelector(`.group-preview-img-${idx}`);
            const phEl = row.querySelector(`.group-preview-placeholder-${idx}`);
            if (!imgEl || !phEl) return;
            if (!val || !val.trim()) {
                imgEl.classList.add('hidden');
                phEl.classList.remove('hidden');
                return;
            }
            const resolved = await resolveLogoPreview(val);
            if (resolved) {
                imgEl.src = resolved;
                imgEl.classList.remove('hidden');
                phEl.classList.add('hidden');
                imgEl.onerror = () => {
                    imgEl.classList.add('hidden');
                    phEl.classList.remove('hidden');
                };
            } else {
                imgEl.classList.add('hidden');
                phEl.classList.remove('hidden');
            }
        };

        updatePreview(group.logo);

        if (logoInput) {
            logoInput.oninput = (e) => {
                group.logo = e.target.value;
                if (groupPreviewTimers[idx]) clearTimeout(groupPreviewTimers[idx]);
                groupPreviewTimers[idx] = setTimeout(() => updatePreview(group.logo), 200);
            };
        }
    });

    list.querySelectorAll('.toggle-svg-paste-btn').forEach(btn => {
        btn.onclick = () => {
            const idx = Number(btn.getAttribute('data-gidx'));
            const group = currentSettings.providers[idx];
            if (!group) return;
            const isCurrentlySvg = typeof group.logo === 'string' && (group.logo.trim().startsWith('<svg') || group.logo.trim().startsWith('<?xml'));
            if (isCurrentlySvg) {
                group.logo = '';
            } else {
                group.logo = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>';
            }
            renderSettingsProviderGroups();
        };
    });

    list.querySelectorAll('.delete-group-btn').forEach(btn => {
        btn.onclick = () => {
            const idx = Number(btn.getAttribute('data-gidx'));
            if (currentSettings.providers && currentSettings.providers[idx]) {
                currentSettings.providers.splice(idx, 1);
                renderSettingsProviderGroups();
            }
        };
    });

    list.querySelectorAll('input[data-gfield]').forEach(inp => {
        const idx = Number(inp.getAttribute('data-gidx'));
        const field = inp.getAttribute('data-gfield');
        const group = currentSettings.providers[idx];
        if (!group) return;
        inp.oninput = (e) => {
            if (field === 'keywords') {
                group.keywords = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
            } else if (field === 'id') {
                group.id = e.target.value;
            } else if (field === 'name') {
                group.name = e.target.value;
            }
        };
    });

    lucide.createIcons();
}

export function addProviderGroup() {
    if (!currentSettings.providers) currentSettings.providers = [];
    const newId = `group_${Date.now()}`;
    currentSettings.providers.push({
        id: newId,
        name: 'New Provider',
        keywords: ['model_keyword'],
        logo: ''
    });
    renderSettingsProviderGroups();
}

function renderThemePicker() {
    const host = document.getElementById('setting-theme-picker');
    if (!host) return;

    host.innerHTML = '';

    THEMES.forEach(theme => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'theme-option' + (theme.id === pendingTheme ? ' theme-option-active' : '');
        btn.setAttribute('data-theme-id', theme.id);
        btn.setAttribute('aria-pressed', theme.id === pendingTheme ? 'true' : 'false');

        const info = document.createElement('div');
        info.className = 'theme-option-info';

        const label = document.createElement('span');
        label.className = 'theme-option-label';
        label.textContent = theme.label;
        info.appendChild(label);

        const desc = document.createElement('span');
        desc.className = 'theme-option-desc';
        desc.textContent = theme.description;
        info.appendChild(desc);

        btn.appendChild(info);

        // Swatches are literal hex from the THEMES table rather than resolved
        // tokens: only the active theme's variables are readable at runtime,
        // so a token lookup would render every row identically.
        const swatches = document.createElement('span');
        swatches.className = 'theme-swatches';
        (theme.preview || []).forEach(hex => {
            const dot = document.createElement('span');
            dot.className = 'theme-swatch';
            dot.style.backgroundColor = hex;
            swatches.appendChild(dot);
        });
        btn.appendChild(swatches);

        btn.onclick = () => {
            if (pendingTheme === theme.id) return;
            pendingTheme = theme.id;
            applyTheme(theme.id);
            renderThemePicker();
        };

        host.appendChild(btn);
    });
}

export async function openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const box = document.getElementById('settings-modal-box');
    if (!modal || !box) return;

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');

    // Always reopen on a known category rather than wherever the user last was.
    wireSettingsTabs();
    switchSettingsPanel(DEFAULT_SETTINGS_PANEL);

    themeAtOpen = normalizeTheme(store.theme);
    pendingTheme = themeAtOpen;
    renderThemePicker();

    const addGroupBtn = document.getElementById('add-provider-group-btn');
    if (addGroupBtn && !addGroupBtn._wired) {
        addGroupBtn._wired = true;
        addGroupBtn.onclick = addProviderGroup;
    }

    try {
        const res = await fetch('/v1/settings');
        currentSettings = await res.json();
        if (!currentSettings.custom_endpoints) currentSettings.custom_endpoints = [];
        if (!currentSettings.providers) currentSettings.providers = [];
        renderSettingsEndpoints();
        renderSettingsProviderGroups();

        const prefs = store.thinkingPrefs || {};
        document.getElementById('setting-thinking-show').checked = prefs.show !== false;
        document.getElementById('setting-thinking-autoexpand').checked = prefs.autoExpand === true;
        document.getElementById('setting-thinking-tags').value = (prefs.inlineTags || []).join(', ');

        const timeoutEl = document.getElementById('setting-non-stream-timeout');
        if (timeoutEl) {
            timeoutEl.value = currentSettings.non_stream_timeout || 240;
        }
    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

export function closeSettingsModal() {
    // Cancel, Escape, and the backdrop all land here. saveSettings syncs
    // themeAtOpen to the committed value first, so this only ever reverts an
    // uncommitted preview.
    if (themeAtOpen && pendingTheme !== themeAtOpen) {
        pendingTheme = themeAtOpen;
        applyTheme(themeAtOpen);
    }

    const modal = document.getElementById('settings-modal');
    const box = document.getElementById('settings-modal-box');
    if (!modal || !box) return;
    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
}

export function addEndpoint() {
    if (!currentSettings.custom_endpoints) currentSettings.custom_endpoints = [];
    currentSettings.custom_endpoints.push({
        name: '',
        url: '',
        api_key: '',
        logo: '',
        models: [],
        stream: true,
        prune_policy: PRUNE_POLICY_DEFERRED,
        cache_ttl_seconds: clampCacheTtl(null)
    });
    renderSettingsEndpoints();
}

async function probeEndpoint(ep, timeoutSec) {
    try {
        const res = await fetch('/v1/settings/check_endpoint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: ep.url, api_key: ep.api_key, timeout: timeoutSec })
        });
        const data = await res.json();
        return data;
    } catch (e) {
        return { ok: false, latency_ms: 0, error: e.message || 'Network check error' };
    }
}

export async function saveSettings() {
    const endpoints = currentSettings.custom_endpoints || [];
    for (const ep of endpoints) {
        if (!ep.name || !ep.url) {
            alert('All endpoints must have a Name and Base URL.');
            return;
        }
    }
    endpoints.forEach(normalizeEndpointCacheFields);

    // Reasoning budgets are configured in copilot-api's own settings.json.
    delete currentSettings.thinking_defaults;

    const timeoutInput = document.getElementById('setting-non-stream-timeout');
    if (timeoutInput) {
        currentSettings.non_stream_timeout = parseInt(timeoutInput.value, 10) || 240;
    }

    const tags = document.getElementById('setting-thinking-tags').value
        .split(',')
        .map(s => s.trim().replace(/^<|>$/g, ''))
        .filter(Boolean);

    store.thinkingPrefs = {
        show: document.getElementById('setting-thinking-show').checked,
        autoExpand: document.getElementById('setting-thinking-autoexpand').checked,
        inlineTags: tags
    };
    persistThinkingPrefs();

    if (pendingTheme && pendingTheme !== store.theme) {
        store.theme = pendingTheme;
        persistTheme();
    }
    themeAtOpen = pendingTheme;

    closeSettingsModal();
    openSaveProgressModal(endpoints);

    let hasErrors = false;
    const providerPromises = endpoints.map((ep, idx) => {
        return new Promise(async (resolve) => {
            let currentTimeout = 0.5;
            let retryCount = 0;

            const executeCheck = async (timeoutVal) => {
                setProviderStatus(idx, { state: 'checking', timeoutSec: timeoutVal });
                const result = await probeEndpoint(ep, timeoutVal);
                if (result.ok) {
                    setProviderStatus(idx, { 
                        state: 'ok',
                        latency_ms: result.latency_ms
                    });
                    resolve(true);
                } else {
                    hasErrors = true;
                    let nextTimeout = null;
                    if (retryCount === 0) nextTimeout = 1.0;
                    else if (retryCount === 1) nextTimeout = 5.0;

                    setProviderStatus(idx, {
                        state: 'fail',
                        error: result.error || 'Unreachable',
                        nextTimeout,
                        onRetry: nextTimeout ? () => {
                            retryCount++;
                            executeCheck(nextTimeout);
                        } : null
                    });
                    resolve(false);
                };
            };

            await executeCheck(currentTimeout);
        });
    });

    await Promise.all(providerPromises);

    try {
        await fetch('/v1/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, currentSettings, { refresh_models: false }))
        });
    } catch (e) {
        console.error('Failed to persist settings payload:', e);
    }

    setModelsStatus({ state: 'checking' });
    try {
        const refRes = await fetch('/v1/settings/refresh_models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const refData = await refRes.json();
        await fetchModels();
        const count = (refData && typeof refData.model_count === 'number') ? refData.model_count : (store.allModels.length || 0);
        setModelsStatus({ state: 'ok', count });
    } catch (e) {
        console.error('Failed to query models:', e);
        hasErrors = true;
        setModelsStatus({ state: 'fail', error: e.message || 'Failed to fetch models' });
    }

    renderChat(true);
    finishSaveProgress({ allOk: !hasErrors });
}
