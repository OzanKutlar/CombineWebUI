/**
 * Settings dialog: endpoint and provider cards, display preferences, network
 * options, and the save-and-verify flow.
 *
 * Cards are built from DOM nodes rather than an HTML template, so user values
 * are only ever assigned as text or input values, and each card repaints its
 * own header as fields change without re-rendering the list.
 */
import { fetchModels } from './models.js';
import {
    PRUNE_POLICY_DEFERRED,
    PRUNE_POLICY_IMMEDIATE,
    MIN_CACHE_TTL_SECONDS,
    MAX_CACHE_TTL_SECONDS
} from './config.js';
import { clampCacheTtl } from './pruneCache.js';
import { wireModalTabs } from './modalTabs.js';
import { store, persistThinkingPrefs, persistTheme, persistIdentityPrefs, sanitizeIdentityPrefs } from './storage.js';
import { THEMES, applyTheme, normalizeTheme } from './theme.js';
import { renderChat } from './chat.js';
import {
    openSaveProgressModal,
    setProviderStatus,
    setModelsStatus,
    finishSaveProgress
} from './saveProgress.js';

let currentSettings = {};

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

// Card UI state, keyed by the settings objects themselves. Those are refetched
// on every open, so none of this outlives a dialog session or reaches disk.
const expandedCards = new WeakSet();
const checkResults = new WeakMap();
const endpointFields = new WeakMap();

const SLOW_LATENCY_MS = 1000;
const MANUAL_CHECK_TIMEOUT_SECONDS = 5;
const LOGO_PREVIEW_DEBOUNCE_MS = 200;
const CARD_REMOVE_MS = 260;
const MAX_ANIMATED_CARDS = 10;
const MAX_MODEL_ID_CHARS = 300;
const MAX_PINNED_MODELS = 2000;
const INVALID_CLASS = 'form-input-invalid';
const DEFAULT_SVG_LOGO = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>';

let fieldIdCounter = 0;

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

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'string') node.textContent = text;
    return node;
}

function icon(name) {
    const node = document.createElement('i');
    node.setAttribute('data-lucide', name);
    return node;
}

function refreshIcons(root) {
    try {
        if (root) lucide.createIcons({ root });
        else lucide.createIcons();
    } catch (e) {
        console.warn('Failed to render settings icons', e);
    }
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function buildIconButton(iconName, title, onClick, danger) {
    const btn = el('button', 'ep-icon-btn' + (danger ? ' ep-icon-btn-danger' : ''));
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.appendChild(icon(iconName));
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(btn);
    });
    return btn;
}

function buildInput(value, options) {
    const opts = options || {};
    const multiline = opts.multiline === true;
    const input = el(multiline ? 'textarea' : 'input', 'form-input' + (opts.mono ? ' form-input-mono' : ''));
    if (!multiline) input.type = opts.type || 'text';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    ['min', 'max', 'step'].forEach(attr => {
        if (opts[attr] !== undefined) input.setAttribute(attr, String(opts[attr]));
    });
    input.value = (value === undefined || value === null) ? '' : String(value);
    input.spellcheck = false;
    input.setAttribute('autocomplete', opts.type === 'password' ? 'new-password' : 'off');
    if (typeof opts.onInput === 'function') {
        input.addEventListener('input', () => opts.onInput(input.value, input));
    }
    return input;
}

/**
 * A labelled field. The label is a real <label for> when the control holds an
 * input, and plain text otherwise, so clicking a caption never activates the
 * first button of a segmented control.
 */
function buildField(labelText, control, options) {
    const opts = options || {};
    const field = el('div', 'form-field' + (opts.wide ? ' form-field-wide' : ''));
    const target = control.matches('input, textarea, select')
        ? control
        : control.querySelector('input, textarea, select');

    let label;
    if (target) {
        if (!target.id) {
            fieldIdCounter += 1;
            target.id = 'settings-field-' + fieldIdCounter;
        }
        label = el('label', 'form-label', labelText);
        label.htmlFor = target.id;
    } else {
        label = el('span', 'form-label', labelText);
    }

    field.append(label, control);
    if (opts.hint) field.appendChild(el('span', 'form-hint', opts.hint));
    return field;
}

function buildSwitch(labelText, checked, onChange, title) {
    const wrap = el('label', 'switch');
    if (title) wrap.title = title;
    const input = el('input', 'switch-input');
    input.type = 'checkbox';
    input.checked = checked === true;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, el('span', 'switch-track'));
    if (labelText) wrap.appendChild(el('span', 'switch-label', labelText));
    // Keeps a click on the switch from also toggling the card it sits in.
    wrap.addEventListener('click', (e) => e.stopPropagation());
    return wrap;
}

function buildSegmented(choices, current, onChange) {
    const group = el('div', 'segmented');
    group.setAttribute('role', 'radiogroup');

    const buttons = choices.map(choice => {
        const btn = el('button', 'segmented-btn', choice.label);
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        if (choice.title) btn.title = choice.title;
        btn.addEventListener('click', () => {
            select(choice.value);
            onChange(choice.value);
        });
        group.appendChild(btn);
        return { btn, value: choice.value };
    });

    function select(value) {
        buttons.forEach(entry => {
            const on = entry.value === value;
            entry.btn.classList.toggle('segmented-btn-active', on);
            entry.btn.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }

    select(current);
    return group;
}

function buildSection(title, iconName, children) {
    const section = el('section', 'ep-section');
    const head = el('div', 'ep-section-title');
    head.append(icon(iconName), el('span', '', title));
    section.appendChild(head);
    children.forEach(child => section.appendChild(child));
    return section;
}

function buildEmptyState(iconName, title, text) {
    const box = el('div', 'ep-empty');
    box.append(icon(iconName), el('p', 'ep-empty-title', title), el('p', 'form-hint', text));
    return box;
}

function clearInvalid(input) {
    input.classList.remove(INVALID_CLASS);
    input.removeAttribute('aria-invalid');
}

// ---------------------------------------------------------------------------
// Card shell, shared by endpoints and provider groups
// ---------------------------------------------------------------------------

function buildCardShell(index) {
    const card = el('div', 'ep-card animate-fade-in-up');
    card.style.animationDelay = `${Math.min(index, MAX_ANIMATED_CARDS) * 0.04}s`;
    return card;
}

function setCardOpen(card, key, open) {
    card.classList.toggle('ep-card-open', open);
    if (open) expandedCards.add(key);
    else expandedCards.delete(key);

    const toggle = card.querySelector('.ep-chevron');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.title = open ? 'Hide details' : 'Show details';
    toggle.setAttribute('aria-label', toggle.title);
}

function toggleCard(card, key) {
    setCardOpen(card, key, !card.classList.contains('ep-card-open'));
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
    } catch (e) {
        console.warn('Could not resolve the logo preview', e);
    }
    return s;
}

/**
 * Returns an updater that shows `value` as a logo inside `box`, debounced and
 * guarded so a slow lookup can never overwrite a newer one.
 */
function createLogoPreview(box, fallbackIcon) {
    let lastValue = null;
    let timer = null;
    let generation = 0;

    const showFallback = () => {
        box.innerHTML = '';
        box.appendChild(icon(fallbackIcon));
        refreshIcons(box);
    };

    const showImage = (src) => {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.onerror = () => {
            if (img.isConnected) showFallback();
        };
        img.src = src;
        box.innerHTML = '';
        box.appendChild(img);
    };

    showFallback();

    return (value) => {
        const next = typeof value === 'string' ? value.trim() : '';
        if (next === lastValue) return;
        lastValue = next;
        generation += 1;
        if (timer) clearTimeout(timer);
        timer = null;
        if (!next) {
            showFallback();
            return;
        }

        const mine = generation;
        timer = setTimeout(async () => {
            timer = null;
            const resolved = await resolveLogoPreview(next);
            if (mine !== generation) return;
            if (resolved) showImage(resolved);
            else showFallback();
        }, LOGO_PREVIEW_DEBOUNCE_MS);
    };
}

/** Logo, title and summary on the left; the caller fills the actions. */
function buildCardHead(card, key, fallbackIcon) {
    const head = el('div', 'ep-card-head');
    const main = el('div', 'ep-card-head-main');
    const logo = el('div', 'ep-card-logo');
    const titles = el('div', 'ep-card-titles');
    const titleRow = el('div', 'ep-card-title-row');
    const title = el('span', 'ep-card-title');
    const sub = el('span', 'ep-card-sub');
    const actions = el('div', 'ep-card-actions');

    titleRow.append(title, el('span', 'ep-badge', 'Inactive'));
    titles.append(titleRow, sub);
    main.append(logo, titles);
    head.append(main, actions);

    head.addEventListener('click', (e) => {
        if (e.target.closest('button, input, label, textarea, select')) return;
        toggleCard(card, key);
    });

    return { head, title, sub, actions, setLogo: createLogoPreview(logo, fallbackIcon) };
}

function appendCardControls(actions, card, key, removeTitle, onRemove) {
    const chevron = buildIconButton('chevron-down', 'Show details', () => toggleCard(card, key));
    chevron.classList.add('ep-chevron');
    actions.append(chevron, buildIconButton('trash-2', removeTitle, onRemove, true));
}

/** Fades a card out, then drops its item from the list and re-renders. */
function removeCard(card, getList, item, rerender) {
    if (card.classList.contains('ep-card-removing')) return;
    // The entrance animation pins opacity, so it has to go before the fade.
    card.classList.remove('animate-fade-in-up');
    card.classList.add('ep-card-removing');

    setTimeout(() => {
        const list = getList();
        const idx = Array.isArray(list) ? list.indexOf(item) : -1;
        if (idx > -1) list.splice(idx, 1);
        expandedCards.delete(item);
        rerender();
    }, CARD_REMOVE_MS);
}

/** Scrolls a freshly added card into view and focuses its first field. */
function focusLastCard(listId) {
    const list = document.getElementById(listId);
    const card = list ? list.lastElementChild : null;
    if (!card || !card.classList.contains('ep-card')) return;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const first = card.querySelector('.ep-card-body input');
    if (first) first.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Coerces the cache-aware pruning fields on an endpoint to valid values. */
function normalizeEndpointCacheFields(ep) {
    if (!ep || typeof ep !== 'object') return;
    ep.prune_policy = ep.prune_policy === PRUNE_POLICY_IMMEDIATE ? PRUNE_POLICY_IMMEDIATE : PRUNE_POLICY_DEFERRED;
    ep.cache_ttl_seconds = clampCacheTtl(ep.cache_ttl_seconds);
}

/** Endpoints are active unless explicitly switched off, matching the backend. */
function normalizeEndpointActiveField(ep) {
    if (!ep || typeof ep !== 'object') return;
    ep.enabled = ep.enabled !== false;
}

function normalizeEndpoint(ep) {
    normalizeEndpointCacheFields(ep);
    normalizeEndpointActiveField(ep);
    ep.stream = ep.stream !== false;
    if (typeof ep.models === 'string') {
        ep.models = ep.models.split(',').map(s => s.trim()).filter(Boolean);
    } else if (!Array.isArray(ep.models)) {
        ep.models = [];
    }
}

function isEndpointIncomplete(ep) {
    if (!ep || typeof ep !== 'object') return false;
    return !String(ep.name || '').trim() || !String(ep.url || '').trim();
}

function endpointSummary(ep) {
    const url = String(ep.url || '').trim();
    const count = Array.isArray(ep.models) ? ep.models.length : 0;
    const parts = [url || 'No URL yet', count > 0 ? plural(count, 'pinned model') : 'all models'];
    if (ep.stream === false) parts.push('no streaming');
    if (ep.prune_policy === PRUNE_POLICY_IMMEDIATE) parts.push('immediate prunes');
    return parts.join(' · ');
}

function applyActiveState(card, ep) {
    card.classList.toggle('ep-card-inactive', ep.enabled === false);
}

function renderStatus(node, result) {
    const state = (result && typeof result.state === 'string') ? result.state : 'idle';
    const latency = (result && Number.isFinite(result.latency)) ? Math.round(result.latency) : null;
    const latencyText = latency !== null ? `${latency} ms` : 'OK';

    let text = '';
    let tip = '';
    if (state === 'checking') {
        text = 'Checking';
        tip = 'Waiting for the endpoint to answer';
    } else if (state === 'ok') {
        text = latencyText;
        tip = 'Responded in under a second';
    } else if (state === 'slow') {
        text = latencyText;
        tip = 'Responded, but slower than one second';
    } else if (state === 'fail') {
        text = 'Failed';
        tip = (result && result.error) || 'No response';
    }

    node.className = 'ep-status ep-status-' + state;
    node.innerHTML = '';
    node.append(el('span', 'ep-status-dot'), el('span', '', text));
    node.title = tip;
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

async function runEndpointCheck(ctx, button) {
    const { ep } = ctx;
    if (!String(ep.url || '').trim()) {
        checkResults.set(ep, { state: 'fail', error: 'Enter a Base URL first' });
        ctx.sync();
        return;
    }

    button.disabled = true;
    checkResults.set(ep, { state: 'checking' });
    ctx.sync();
    try {
        const data = await probeEndpoint(ep, MANUAL_CHECK_TIMEOUT_SECONDS);
        const latency = Number(data && data.latency_ms);
        if (data && data.ok) {
            checkResults.set(ep, { state: latency > SLOW_LATENCY_MS ? 'slow' : 'ok', latency });
        } else {
            checkResults.set(ep, { state: 'fail', latency, error: (data && data.error) || 'No response' });
        }
    } finally {
        button.disabled = false;
        ctx.sync();
    }
}

function buildEndpointHead(ctx) {
    const { ep, card } = ctx;
    const parts = buildCardHead(card, ep, 'server');
    const status = el('span', 'ep-status');

    const check = buildIconButton('activity', 'Check the response time', (btn) => {
        runEndpointCheck(ctx, btn).catch(e => console.error('Endpoint check failed', e));
    });
    const active = buildSwitch('Active', ep.enabled, (on) => {
        ep.enabled = on;
        applyActiveState(card, ep);
    }, 'Active endpoints are pinged on save and supply models. Inactive ones keep their settings but are ignored.');

    parts.actions.append(status, check, active);
    appendCardControls(parts.actions, card, ep, 'Remove endpoint', () => {
        removeCard(card, () => currentSettings.custom_endpoints, ep, renderSettingsEndpoints);
    });

    ctx.sync = () => {
        parts.title.textContent = String(ep.name || '').trim() || 'Unnamed endpoint';
        parts.sub.textContent = endpointSummary(ep);
        parts.sub.title = parts.sub.textContent;
        renderStatus(status, checkResults.get(ep));
        parts.setLogo(ep.logo);
    };
    return parts.head;
}

function buildSecretInput(ep) {
    const wrap = el('div', 'form-input-wrap');
    const input = buildInput(ep.api_key, {
        type: 'password',
        placeholder: 'Optional, e.g. sk-...',
        mono: true,
        onInput: (value) => {
            ep.api_key = value;
        }
    });

    const toggle = el('button', 'form-input-btn');
    toggle.type = 'button';
    const paint = () => {
        const shown = input.type === 'text';
        toggle.innerHTML = '';
        toggle.appendChild(icon(shown ? 'eye-off' : 'eye'));
        toggle.title = shown ? 'Hide key' : 'Show key';
        toggle.setAttribute('aria-label', toggle.title);
        refreshIcons(toggle);
    };
    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        input.type = input.type === 'password' ? 'text' : 'password';
        paint();
    });
    paint();

    wrap.append(input, toggle);
    return wrap;
}

function buildConnectionSection(ctx) {
    const { ep } = ctx;
    const name = buildInput(ep.name, {
        placeholder: 'Local vLLM',
        onInput: (value, input) => {
            ep.name = value;
            clearInvalid(input);
            ctx.sync();
        }
    });
    const url = buildInput(ep.url, {
        placeholder: 'http://localhost:8000/v1',
        mono: true,
        onInput: (value, input) => {
            ep.url = value;
            clearInvalid(input);
            // A result for the old URL would be misleading.
            checkResults.delete(ep);
            ctx.sync();
        }
    });
    const logo = buildInput(ep.logo, {
        placeholder: 'icons/local.svg or https://...',
        mono: true,
        onInput: (value) => {
            ep.logo = value;
            ctx.sync();
        }
    });
    endpointFields.set(ep, { card: ctx.card, name, url });

    const grid = el('div', 'form-grid');
    grid.append(
        buildField('Name', name),
        buildField('Base URL', url),
        buildField('API key', buildSecretInput(ep)),
        buildField('Logo', logo, { hint: 'Image URL, local file or pasted SVG markup.' })
    );
    return buildSection('Connection', 'plug', [grid]);
}

function buildModelPill(modelId, onRemove) {
    const pill = el('span', 'ep-pill');
    const label = el('span', 'ep-pill-label', modelId);
    label.title = modelId;

    const remove = el('button', 'ep-pill-remove');
    remove.type = 'button';
    remove.title = 'Remove ' + modelId;
    remove.setAttribute('aria-label', remove.title);
    remove.appendChild(icon('x'));
    remove.addEventListener('click', onRemove);

    pill.append(label, remove);
    return pill;
}

function buildModelsSection(ctx) {
    const { ep } = ctx;
    const pills = el('div', 'ep-pills');
    const hint = el('p', 'form-hint');
    const input = buildInput('', { placeholder: 'Add a model id, e.g. deepseek-ai/DeepSeek-V4-Flash', mono: true });
    input.maxLength = MAX_MODEL_ID_CHARS;

    const render = () => {
        pills.innerHTML = '';
        ep.models.forEach((modelId, mIdx) => {
            pills.appendChild(buildModelPill(modelId, () => {
                ep.models.splice(mIdx, 1);
                render();
            }));
        });
        const empty = ep.models.length === 0;
        pills.classList.toggle('ep-pills-empty', empty);
        hint.textContent = empty
            ? 'None pinned, so every model the endpoint lists is offered.'
            : 'Only the pinned models are offered, even if the endpoint lists more.';
        ctx.sync();
        refreshIcons(pills);
    };

    const addModel = () => {
        const value = input.value.trim();
        if (!value) return;
        if (ep.models.includes(value) || ep.models.length >= MAX_PINNED_MODELS) {
            input.select();
            return;
        }
        ep.models.push(value);
        input.value = '';
        render();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        addModel();
    });

    const add = el('button', 'btn-secondary');
    add.type = 'button';
    add.append(icon('plus'), el('span', '', 'Add'));
    add.addEventListener('click', addModel);

    const row = el('div', 'ep-model-add');
    row.append(input, add);
    render();
    return buildSection('Models', 'list', [row, pills, hint]);
}

function buildBehaviourSection(ctx) {
    const { ep } = ctx;
    const stream = buildSwitch('Stream replies', ep.stream, (on) => {
        ep.stream = on;
        ctx.sync();
    }, 'Show replies token by token in this web UI. External API clients are unaffected.');
    const streamRow = el('div', 'ep-switch-row');
    streamRow.append(stream, el('span', 'form-hint', 'When off, the chat page waits for the whole reply.'));

    const policy = buildSegmented([
        { value: PRUNE_POLICY_DEFERRED, label: 'Deferred', title: 'Cache-aware: hold new prunes while the prompt cache is warm' },
        { value: PRUNE_POLICY_IMMEDIATE, label: 'Immediate', title: 'Apply prunes on the next send' }
    ], ep.prune_policy, (value) => {
        ep.prune_policy = value;
        ctx.sync();
    });

    // Clamped on save, so a half-typed value is never fought mid-edit.
    const ttl = buildInput(ep.cache_ttl_seconds, {
        type: 'number',
        min: MIN_CACHE_TTL_SECONDS,
        max: MAX_CACHE_TTL_SECONDS,
        step: 1,
        mono: true,
        onInput: (value) => {
            ep.cache_ttl_seconds = parseInt(value, 10);
        }
    });

    const grid = el('div', 'form-grid');
    grid.append(
        buildField('Prune policy', policy, {
            hint: 'Deferred keeps the cached prefix intact. Use Immediate for token quotas that ignore caching.'
        }),
        buildField('Cache TTL (seconds)', ttl, {
            hint: `How long the cache counts as warm, ${MIN_CACHE_TTL_SECONDS} to ${MAX_CACHE_TTL_SECONDS} s.`
        })
    );
    return buildSection('Behaviour', 'sliders-horizontal', [streamRow, grid]);
}

function buildCardBody(sections) {
    const body = el('div', 'ep-card-body');
    const inner = el('div', 'ep-card-body-inner');
    const content = el('div', 'ep-card-content');
    sections.forEach(section => content.appendChild(section));
    inner.appendChild(content);
    body.appendChild(inner);
    return body;
}

function buildEndpointCard(ep, index) {
    normalizeEndpoint(ep);
    const card = buildCardShell(index);
    const ctx = { ep, card, sync: () => {} };

    // The head is built first, because it defines ctx.sync for the sections.
    card.appendChild(buildEndpointHead(ctx));
    card.appendChild(buildCardBody([
        buildConnectionSection(ctx),
        buildModelsSection(ctx),
        buildBehaviourSection(ctx)
    ]));

    applyActiveState(card, ep);
    setCardOpen(card, ep, expandedCards.has(ep));
    ctx.sync();
    return card;
}

function renderSettingsEndpoints() {
    const list = document.getElementById('endpoints-list');
    if (!list) return;
    list.innerHTML = '';

    const eps = Array.isArray(currentSettings.custom_endpoints) ? currentSettings.custom_endpoints : [];
    if (eps.length === 0) {
        list.appendChild(buildEmptyState('server-off', 'No endpoints yet',
            'Add an OpenAI-compatible server such as copilot-api, Ollama, vLLM or LM Studio.'));
    }
    eps.forEach((ep, i) => {
        if (ep && typeof ep === 'object') list.appendChild(buildEndpointCard(ep, i));
    });
    refreshIcons(list);
}

/** Opens the first incomplete endpoint and outlines its empty fields. */
function revealInvalidEndpoint(ep) {
    switchSettingsPanel('endpoints');
    const fields = endpointFields.get(ep);
    if (!fields || !fields.card.isConnected) {
        alert('All endpoints must have a Name and Base URL.');
        return;
    }

    setCardOpen(fields.card, ep, true);
    const missing = [];
    if (!String(ep.name || '').trim()) missing.push(fields.name);
    if (!String(ep.url || '').trim()) missing.push(fields.url);
    missing.forEach(input => {
        input.classList.add(INVALID_CLASS);
        input.setAttribute('aria-invalid', 'true');
    });

    fields.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (missing.length > 0) missing[0].focus({ preventScroll: true });
}

export function addEndpoint() {
    if (!Array.isArray(currentSettings.custom_endpoints)) currentSettings.custom_endpoints = [];
    const ep = {
        name: '',
        url: '',
        api_key: '',
        logo: '',
        models: [],
        enabled: true,
        stream: true,
        prune_policy: PRUNE_POLICY_DEFERRED,
        cache_ttl_seconds: clampCacheTtl(null)
    };
    currentSettings.custom_endpoints.push(ep);
    expandedCards.add(ep);
    renderSettingsEndpoints();
    focusLastCard('endpoints-list');
}

// ---------------------------------------------------------------------------
// Provider (picture) groups
// ---------------------------------------------------------------------------

function isSvgMarkup(value) {
    const s = typeof value === 'string' ? value.trim() : '';
    return s.startsWith('<svg') || s.startsWith('<?xml');
}

function normalizeProviderGroup(group) {
    if (typeof group.keywords === 'string') {
        group.keywords = group.keywords.split(',').map(s => s.trim()).filter(Boolean);
    } else if (!Array.isArray(group.keywords)) {
        group.keywords = [];
    }
}

function providerSummary(group) {
    const id = String(group.id || '').trim() || 'no id';
    const keywords = Array.isArray(group.keywords) ? group.keywords : [];
    return keywords.length > 0 ? `${id} · ${keywords.join(', ')}` : `${id} · no keywords`;
}

/** Logo field with a Path / URL versus Raw SVG selector; repaints in place. */
function buildLogoEditor(group, ctx) {
    const holder = el('div', 'form-field form-field-wide');

    const paint = () => {
        holder.innerHTML = '';
        const svgMode = isSvgMarkup(group.logo);

        const mode = buildSegmented([
            { value: 'path', label: 'Path / URL' },
            { value: 'svg', label: 'Raw SVG' }
        ], svgMode ? 'svg' : 'path', (next) => {
            if ((next === 'svg') === isSvgMarkup(group.logo)) return;
            group.logo = next === 'svg' ? DEFAULT_SVG_LOGO : '';
            ctx.sync();
            paint();
        });

        const input = buildInput(group.logo, {
            multiline: svgMode,
            mono: true,
            placeholder: svgMode ? '<svg ...>...</svg>' : 'icons/llama.svg, /static/icons/logo.svg or https://...',
            onInput: (value) => {
                group.logo = value;
                ctx.sync();
            }
        });
        fieldIdCounter += 1;
        input.id = 'settings-field-' + fieldIdCounter;

        const head = el('div', 'ep-field-head');
        const label = el('label', 'form-label', 'Logo');
        label.htmlFor = input.id;
        head.append(label, mode);

        const hint = svgMode
            ? 'Pasted markup is stored as is.'
            : 'An image URL, a file in the project or data folder, or a path under /static/.';
        holder.append(head, input, el('span', 'form-hint', hint));
    };

    paint();
    return holder;
}

function buildProviderSection(ctx) {
    const { group } = ctx;
    const name = buildInput(group.name, {
        placeholder: 'Meta Llama',
        onInput: (value) => {
            group.name = value;
            ctx.sync();
        }
    });
    const id = buildInput(group.id, {
        placeholder: 'llama',
        mono: true,
        onInput: (value) => {
            group.id = value;
            ctx.sync();
        }
    });
    const keywords = buildInput(group.keywords.join(', '), {
        placeholder: 'llama, codellama',
        onInput: (value) => {
            group.keywords = value.split(',').map(s => s.trim()).filter(Boolean);
            ctx.sync();
        }
    });

    const grid = el('div', 'form-grid');
    grid.append(
        buildField('Display name', name),
        buildField('Group id', id),
        buildField('Keywords', keywords, {
            wide: true,
            hint: 'Comma-separated. Models whose id contains any of them are grouped under this picture.'
        }),
        buildLogoEditor(group, ctx)
    );
    return buildSection('Picture group', 'image', [grid]);
}

function buildProviderCard(group, index) {
    normalizeProviderGroup(group);
    const card = buildCardShell(index);
    const ctx = { group, card, sync: () => {} };
    const parts = buildCardHead(card, group, 'image');

    appendCardControls(parts.actions, card, group, 'Remove picture group', () => {
        removeCard(card, () => currentSettings.providers, group, renderSettingsProviderGroups);
    });
    ctx.sync = () => {
        parts.title.textContent = String(group.name || '').trim() || 'Unnamed group';
        parts.sub.textContent = providerSummary(group);
        parts.sub.title = parts.sub.textContent;
        parts.setLogo(group.logo);
    };

    card.appendChild(parts.head);
    card.appendChild(buildCardBody([buildProviderSection(ctx)]));
    setCardOpen(card, group, expandedCards.has(group));
    ctx.sync();
    return card;
}

export function renderSettingsProviderGroups() {
    const list = document.getElementById('provider-groups-list');
    if (!list) return;
    list.innerHTML = '';

    const groups = Array.isArray(currentSettings.providers) ? currentSettings.providers : [];
    if (groups.length === 0) {
        list.appendChild(buildEmptyState('image-off', 'No picture groups',
            'Add one to give models a logo by matching keywords in their ids.'));
    }
    groups.forEach((group, i) => {
        if (group && typeof group === 'object') list.appendChild(buildProviderCard(group, i));
    });
    refreshIcons(list);
}

export function addProviderGroup() {
    if (!Array.isArray(currentSettings.providers)) currentSettings.providers = [];
    const group = { id: `group_${Date.now()}`, name: '', keywords: [], logo: '' };
    currentSettings.providers.push(group);
    expandedCards.add(group);
    renderSettingsProviderGroups();
    focusLastCard('provider-groups-list');
}

// ---------------------------------------------------------------------------
// Display: theme and identity
// ---------------------------------------------------------------------------

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

function syncIdentityCustomVisibility() {
    const modeEl = document.getElementById('setting-identity-mode');
    const wrap = document.getElementById('setting-identity-custom-wrap');
    if (!modeEl || !wrap) return;
    wrap.classList.toggle('hidden', modeEl.value !== 'custom');
}

function populateIdentityControls() {
    const modeEl = document.getElementById('setting-identity-mode');
    const customEl = document.getElementById('setting-identity-custom');
    const overrideEl = document.getElementById('setting-identity-override');
    if (!modeEl || !customEl || !overrideEl) return;

    const prefs = sanitizeIdentityPrefs(store.identityPrefs);
    modeEl.value = prefs.mode;
    customEl.value = prefs.customText;
    overrideEl.checked = prefs.overrideHardcoded;

    if (!modeEl._wired) {
        modeEl._wired = true;
        modeEl.addEventListener('change', syncIdentityCustomVisibility);
    }
    syncIdentityCustomVisibility();
}

/** Reads the identity controls; falls back to the stored prefs if they are missing. */
function readIdentityControls() {
    const modeEl = document.getElementById('setting-identity-mode');
    const customEl = document.getElementById('setting-identity-custom');
    const overrideEl = document.getElementById('setting-identity-override');
    if (!modeEl || !customEl || !overrideEl) return sanitizeIdentityPrefs(store.identityPrefs);
    return sanitizeIdentityPrefs({
        mode: modeEl.value,
        customText: customEl.value,
        overrideHardcoded: overrideEl.checked
    });
}

// ---------------------------------------------------------------------------
// Dialog lifecycle
// ---------------------------------------------------------------------------

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
    populateIdentityControls();

    // The Add Picture Group button is wired once in main.js. It used to be
    // wired here as well, which added two groups per click.

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

export async function saveSettings() {
    const endpoints = Array.isArray(currentSettings.custom_endpoints) ? currentSettings.custom_endpoints : [];
    const incomplete = endpoints.find(isEndpointIncomplete);
    if (incomplete) {
        revealInvalidEndpoint(incomplete);
        return;
    }
    endpoints.forEach(normalizeEndpointCacheFields);
    endpoints.forEach(normalizeEndpointActiveField);
    // Inactive endpoints are saved with everything else but never pinged.
    const activeEndpoints = endpoints.filter(ep => ep && ep.enabled !== false);
    const skippedCount = endpoints.length - activeEndpoints.length;

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

    store.identityPrefs = readIdentityControls();
    persistIdentityPrefs();

    if (pendingTheme && pendingTheme !== store.theme) {
        store.theme = pendingTheme;
        persistTheme();
    }
    themeAtOpen = pendingTheme;

    closeSettingsModal();
    openSaveProgressModal(activeEndpoints, { skippedCount });

    let hasErrors = false;
    const providerPromises = activeEndpoints.map((ep, idx) => {
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
                }
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
