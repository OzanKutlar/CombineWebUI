import { store } from './storage.js';
import { createModelAvatar } from './avatar.js';
import { wireModalTabs } from './modalTabs.js';
import { renderBarChart } from './chart.js';
import { readThemeColor, THEME_EVENT } from './theme.js';
import {
    filterDaily,
    aggregateModels,
    aggregateProviders,
    totalsFromRows,
    rollUp,
    computeCost,
    rangeLabel,
    rangeNote,
    PRICE_UNIT
} from './tokenStats.js';

/**
 * Token counter dialog.
 *
 * The server payload is fetched once per Recalculate; every range, granularity
 * and pricing change re-derives from that in-memory copy, so switching tabs is
 * instant and never costs a round trip.
 */

const PANELS = ['overview', 'trends', 'providers', 'models', 'pricing'];
const DEFAULT_PANEL = 'overview';
const RANGE_PANELS = ['overview', 'providers', 'models'];
const TOP_MODEL_COUNT = 5;
const RESIZE_DEBOUNCE_MS = 180;

// Resolved per render rather than frozen at module load: the chart bakes its
// fills into generated SVG attributes, which CSS variables cannot reach.
function colorInput() {
    return readThemeColor('--gb-chart-input', '#83a598');
}

function colorOutput() {
    return readThemeColor('--gb-chart-output', '#b8bb26');
}

const CURRENCY_SYMBOLS = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5', AUD: 'A$', CAD: 'C$' };

const view = {
    range: 'all',
    granularity: 'daily',
    chartType: 'spline', // 'spline' | 'area' | 'heatmap'
    activePanel: DEFAULT_PANEL,
    modelFilter: '',
    priceFilter: '',
    data: null,
    pricing: { currency: 'USD', unit: PRICE_UNIT, models: {} }
};

let switchPanel = null;
let resizeTimer = null;

function el(id) {
    return document.getElementById(id);
}

function isModalOpen() {
    const modal = el('token-counter-modal');
    return Boolean(modal && !modal.classList.contains('opacity-0'));
}

function hasDaily() {
    return Boolean(view.data && Array.isArray(view.data.daily));
}

function hasAnyPrice() {
    const models = view.pricing && view.pricing.models;
    return Boolean(models && Object.keys(models).length > 0);
}

function formatMoney(value) {
    const currency = (view.pricing && view.pricing.currency) || 'USD';
    const symbol = CURRENCY_SYMBOLS[currency];
    const n = Number(value) || 0;
    const abs = Math.abs(n);

    let body;
    if (abs >= 100) body = n.toFixed(2);
    else if (abs >= 1) body = n.toFixed(3);
    else body = n.toFixed(4);

    return symbol ? symbol + body : body + ' ' + currency;
}

function formatCostCell(row) {
    if (!row || !row.has_price) return '\u2014';
    return formatMoney(row.cost);
}

// ---------------------------------------------------------------------------
// Derived rows
// ---------------------------------------------------------------------------

/**
 * All-time reads the flat `by_model` payload rather than summing `daily`, so
 * turns with no resolvable date are still counted. Narrower ranges necessarily
 * derive from the dated buckets.
 */
function currentModelRows() {
    const data = view.data;
    if (!data) return [];

    const priceModels = (view.pricing && view.pricing.models) || {};

    if (view.range === 'all' || !hasDaily()) {
        return (data.by_model || []).map(row => {
            const price = priceModels[row.model_id];
            return Object.assign({}, row, {
                cost: computeCost(row.input_tokens, row.output_tokens, price),
                has_price: Boolean(price)
            });
        }).sort((a, b) => b.total_tokens - a.total_tokens);
    }

    return aggregateModels(
        filterDaily(data.daily, view.range),
        data.model_index || {},
        view.pricing
    );
}

// ---------------------------------------------------------------------------
// Shared cell builders
// ---------------------------------------------------------------------------

function renderProviderImage(logoUrl, name) {
    const wrap = document.createElement('div');
    wrap.className = 'w-5 h-5 rounded flex items-center justify-center shrink-0 overflow-hidden bg-white p-0.5 border border-gb-bgLight3';
    if (logoUrl) {
        const img = document.createElement('img');
        img.src = logoUrl;
        img.alt = name || 'Provider';
        img.className = 'w-full h-full object-contain';
        img.onerror = () => {
            wrap.className = 'w-5 h-5 rounded flex items-center justify-center shrink-0 bg-gb-bgLight1 text-gb-aquaAccent';
            wrap.innerHTML = '<i data-lucide="box" class="w-3.5 h-3.5"></i>';
            lucide.createIcons({ root: wrap });
        };
        wrap.appendChild(img);
    } else {
        wrap.className = 'w-5 h-5 rounded flex items-center justify-center shrink-0 bg-gb-bgLight1 text-gb-aquaAccent';
        wrap.innerHTML = '<i data-lucide="box" class="w-3.5 h-3.5"></i>';
    }
    return wrap;
}

function numericCell(value, className) {
    const td = document.createElement('td');
    td.className = 'p-3 text-right ' + className;
    td.textContent = (Number(value) || 0).toLocaleString();
    return td;
}

function textCell(text, className) {
    const td = document.createElement('td');
    td.className = 'p-3 text-right ' + className;
    td.textContent = text;
    return td;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function renderOverview(rows) {
    const totals = totalsFromRows(rows);

    const grandTotalEl = el('tc-grand-total');
    const inputEl = el('tc-total-input');
    const outputEl = el('tc-total-output');
    const costEl = el('tc-total-cost');
    const costNoteEl = el('tc-cost-note');
    const turnsEl = el('tc-turns-summary');
    const subEl = el('tc-overview-sub');

    if (grandTotalEl) grandTotalEl.textContent = totals.total.toLocaleString();
    if (inputEl) inputEl.textContent = totals.input.toLocaleString();
    if (outputEl) outputEl.textContent = totals.output.toLocaleString();

    if (costEl) costEl.textContent = totals.priced > 0 ? formatMoney(totals.cost) : '\u2014';
    if (costNoteEl) {
        const base = totals.priced > 0
            ? totals.priced + ' of ' + totals.models + ' models priced'
            : 'Set rates in the Pricing tab';
        // Saved is what pruning kept off the bill, so it is reported alongside
        // the cost rather than folded into the token totals.
        costNoteEl.textContent = totals.saved > 0
            ? base + ' \u00b7 ' + totals.saved.toLocaleString() + ' saved by pruning'
            : base;
    }

    if (turnsEl) {
        const chats = (view.range === 'all' && view.data && view.data.totals)
            ? ' across ' + (view.data.totals.conversations || 0).toLocaleString() + ' chats'
            : '';
        turnsEl.textContent = totals.turns.toLocaleString() + ' turns' + chats;
    }

    if (subEl) subEl.textContent = rangeLabel(view.range) + ' \u00b7 ' + rangeNote(view.range);

    const list = el('tc-top-models');
    const note = el('tc-top-note');
    if (!list) return;

    list.innerHTML = '';
    const top = rows.slice(0, TOP_MODEL_COUNT);
    if (note) note.textContent = top.length + ' of ' + rows.length + ' shown';

    if (top.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tc-empty';
        empty.textContent = 'No token usage recorded in this range.';
        list.appendChild(empty);
        return;
    }

    const peak = top[0].total_tokens || 1;

    top.forEach(row => {
        const item = document.createElement('div');
        item.className = 'bg-gb-bg border border-gb-bgLight2 rounded-lg p-3 flex flex-col gap-2';

        const head = document.createElement('div');
        head.className = 'flex items-center justify-between gap-3 min-w-0';

        const left = document.createElement('div');
        left.className = 'flex items-center gap-2.5 min-w-0';
        left.appendChild(createModelAvatar(row.model_id));
        const name = document.createElement('span');
        name.className = 'text-sm font-bold text-gb-fgLight truncate font-mono';
        name.textContent = row.model_id;
        name.title = row.model_id;
        left.appendChild(name);
        head.appendChild(left);

        const right = document.createElement('div');
        right.className = 'flex items-center gap-3 shrink-0 font-mono text-xs';
        right.innerHTML =
            '<span class="text-gb-fgLightest font-bold">' + (row.total_tokens || 0).toLocaleString() + '</span>' +
            '<span class="text-gb-purpleAccent">' + formatCostCell(row) + '</span>';
        head.appendChild(right);

        item.appendChild(head);

        // Proportion bar: input and output stacked to the model's share of peak.
        const barWrap = document.createElement('div');
        barWrap.className = 'flex h-2 w-full rounded-full overflow-hidden bg-gb-bgDarkest';
        const share = Math.max(2, Math.round(((row.total_tokens || 0) / peak) * 100));
        const inShare = row.total_tokens > 0 ? (row.input_tokens / row.total_tokens) * share : 0;
        const outShare = Math.max(0, share - inShare);
        barWrap.innerHTML =
            '<div style="width:' + inShare.toFixed(2) + '%;background-color:' + colorInput() + '"></div>' +
            '<div style="width:' + outShare.toFixed(2) + '%;background-color:' + colorOutput() + '"></div>';
        item.appendChild(barWrap);

        const meta = document.createElement('div');
        meta.className = 'flex items-center gap-3 text-[11px] font-mono text-gb-fgDark';
        meta.innerHTML =
            '<span class="text-gb-blueAccent">in ' + (row.input_tokens || 0).toLocaleString() + '</span>' +
            '<span class="text-gb-greenAccent">out ' + (row.output_tokens || 0).toLocaleString() + '</span>' +
            '<span>' + (row.turns || 0).toLocaleString() + ' turns</span>';
        item.appendChild(meta);

        list.appendChild(item);
    });

    lucide.createIcons();
}

function renderTrends() {
    const container = el('tc-chart');
    const summary = el('tc-trend-summary');
    if (!container) return;

    if (!hasDaily()) {
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'tc-empty';
        empty.textContent = 'This server build does not report dated usage. Restart the proxy to enable trends.';
        container.appendChild(empty);
        if (summary) summary.textContent = '';
        return;
    }

    const buckets = rollUp(view.data.daily, view.granularity, view.pricing);

    renderBarChart(container, {
        type: view.chartType,
        labels: buckets.map(b => b.label),
        dailyRaw: view.data.daily,
        pricing: view.pricing,
        series: [
            { name: 'Input', color: '#74d2e7', values: buckets.map(b => b.input) },
            { name: 'Output', color: '#b8bb26', values: buckets.map(b => b.output) }
        ],
        costSeries: {
            name: 'Estimated Cost',
            values: buckets.map(b => b.cost)
        },
        formatCost: (c) => formatMoney(c),
        height: 330,
        emptyMessage: 'No dated token usage recorded yet.'
    });

    if (!summary) return;

    if (buckets.length === 0) {
        summary.textContent = '';
        return;
    }

    let totalIn = 0;
    let totalOut = 0;
    let totalCost = 0;
    let peak = buckets[0];

    buckets.forEach(b => {
        totalIn += b.input;
        totalOut += b.output;
        totalCost += b.cost;
        if ((b.input + b.output) > (peak.input + peak.output)) peak = b;
    });

    const periodWord = view.granularity === 'monthly' ? 'months'
        : view.granularity === 'weekly' ? 'weeks' : 'days';

    const parts = [
        buckets.length + ' ' + periodWord,
        (totalIn + totalOut).toLocaleString() + ' tokens (' + totalIn.toLocaleString() + ' in / ' + totalOut.toLocaleString() + ' out)',
        'peak ' + peak.label + ' at ' + (peak.input + peak.output).toLocaleString()
    ];
    if (hasAnyPrice()) parts.push('est. ' + formatMoney(totalCost));

    summary.textContent = parts.join(' \u00b7 ');
}

function renderProviders(rows) {
    const tbody = el('tc-providers-tbody');
    const countEl = el('tc-provider-count');
    if (!tbody) return;

    tbody.innerHTML = '';
    const providers = aggregateProviders(rows);
    if (countEl) countEl.textContent = providers.length + ' provider' + (providers.length === 1 ? '' : 's');

    if (providers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-gb-fgDark italic">No provider token records in this range.</td></tr>';
        return;
    }

    providers.forEach(p => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gb-bgLight1/40 transition-colors';

        const provCell = document.createElement('td');
        provCell.className = 'p-3 flex items-center gap-2.5';
        provCell.appendChild(renderProviderImage(p.logo, p.name));
        const nameSpan = document.createElement('span');
        nameSpan.className = 'font-bold text-gb-fgLightest';
        nameSpan.textContent = p.name || p.provider_id;
        provCell.appendChild(nameSpan);
        tr.appendChild(provCell);

        tr.appendChild(numericCell(p.input_tokens, 'text-gb-blueAccent font-semibold'));
        tr.appendChild(numericCell(p.output_tokens, 'text-gb-greenAccent font-semibold'));
        tr.appendChild(numericCell(p.total_tokens, 'text-gb-fgLightest font-bold'));
        tr.appendChild(textCell(p.cost > 0 ? formatMoney(p.cost) : '\u2014', 'text-gb-purpleAccent'));
        tr.appendChild(numericCell(p.turns, 'text-gb-fgDark'));

        tbody.appendChild(tr);
    });

    lucide.createIcons();
}

function renderModels(rows) {
    const tbody = el('tc-models-tbody');
    const countEl = el('tc-model-count');
    if (!tbody) return;

    tbody.innerHTML = '';

    const q = view.modelFilter.trim().toLowerCase();
    const filtered = rows.filter(m => {
        if (!q) return true;
        return (m.model_id || '').toLowerCase().includes(q)
            || (m.provider_name || '').toLowerCase().includes(q);
    });

    if (countEl) {
        countEl.textContent = filtered.length + ' of ' + rows.length + ' model' + (rows.length === 1 ? '' : 's');
    }

    if (filtered.length === 0) {
        const msg = rows.length === 0
            ? 'No model tokens recorded in this range.'
            : 'No models matched your filter.';
        tbody.innerHTML = '<tr><td colspan="8" class="p-4 text-center text-gb-fgDark italic">' + msg + '</td></tr>';
        return;
    }

    filtered.forEach(m => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gb-bgLight1/40 transition-colors';

        const modelCell = document.createElement('td');
        modelCell.className = 'p-3 flex items-center gap-2.5 max-w-[280px] min-w-0';
        modelCell.appendChild(createModelAvatar(m.model_id));
        const modelName = document.createElement('span');
        modelName.className = 'truncate font-bold text-gb-fgLight';
        modelName.textContent = m.model_id;
        modelName.title = m.model_id;
        modelCell.appendChild(modelName);
        tr.appendChild(modelCell);

        const provCell = document.createElement('td');
        provCell.className = 'p-3';
        const provBadge = document.createElement('div');
        provBadge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-gb-bgLight1 border border-gb-bgLight2 text-[11px] text-gb-fgLight';
        provBadge.appendChild(renderProviderImage(m.provider_logo, m.provider_name));
        const pText = document.createElement('span');
        pText.textContent = m.provider_name;
        provBadge.appendChild(pText);
        provCell.appendChild(provBadge);
        tr.appendChild(provCell);

        tr.appendChild(numericCell(m.input_tokens, 'text-gb-blueAccent font-semibold'));
        tr.appendChild(numericCell(m.output_tokens, 'text-gb-greenAccent font-semibold'));
        tr.appendChild(numericCell(m.total_tokens, 'text-gb-fgLightest font-bold'));
        tr.appendChild(textCell(formatCostCell(m), 'text-gb-purpleAccent'));
        tr.appendChild(textCell(
            m.saved_tokens > 0 ? m.saved_tokens.toLocaleString() : '\u2014',
            'text-gb-aquaAccent'
        ));
        tr.appendChild(numericCell(m.turns, 'text-gb-fgDark'));

        tbody.appendChild(tr);
    });

    lucide.createIcons();
}

/**
 * Pricing rows are built once and filtered by toggling visibility rather than
 * re-rendering, so a half-typed price is never destroyed by the filter box.
 */
function renderPricing() {
    const list = el('tc-pricing-list');
    if (!list) return;

    list.innerHTML = '';

    const ids = new Set();
    const index = (view.data && view.data.model_index) || {};
    Object.keys(index).forEach(id => ids.add(id));
    if (view.data && Array.isArray(view.data.by_model)) {
        view.data.by_model.forEach(m => {
            if (m && typeof m.model_id === 'string' && m.model_id) ids.add(m.model_id);
        });
    }

    const priceModels = (view.pricing && view.pricing.models) || {};

    const sorted = Array.from(ids).sort((a, b) => a.localeCompare(b));

    if (sorted.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tc-empty';
        empty.textContent = 'No models counted yet. Chat with a model first to configure its pricing.';
        list.appendChild(empty);
        return;
    }

    sorted.forEach(modelId => {
        const meta = index[modelId] || {};
        const price = priceModels[modelId] || {};

        const row = document.createElement('div');
        row.className = 'tc-price-row';
        row.setAttribute('data-price-model', modelId);
        row.setAttribute('data-search', (modelId + ' ' + (meta.provider_name || '')).toLowerCase());

        row.appendChild(createModelAvatar(modelId));

        const info = document.createElement('div');
        info.className = 'flex flex-col min-w-0 flex-1';
        const name = document.createElement('span');
        name.className = 'text-xs font-bold text-gb-fgLight truncate font-mono';
        name.textContent = modelId;
        name.title = modelId;
        info.appendChild(name);
        if (meta.provider_name) {
            const prov = document.createElement('span');
            prov.className = 'text-[10px] font-mono text-gb-fgDark truncate';
            prov.textContent = meta.provider_name;
            info.appendChild(prov);
        }
        row.appendChild(info);

        const inputField = document.createElement('input');
        inputField.type = 'number';
        inputField.min = '0';
        inputField.step = '0.01';
        inputField.className = 'tc-price-input';
        inputField.placeholder = 'in / 1M';
        inputField.title = 'Input price per 1,000,000 tokens';
        inputField.setAttribute('data-price-field', 'input');
        if (Number(price.input) > 0) inputField.value = String(price.input);
        row.appendChild(inputField);

        const outputField = document.createElement('input');
        outputField.type = 'number';
        outputField.min = '0';
        outputField.step = '0.01';
        outputField.className = 'tc-price-input';
        outputField.placeholder = 'out / 1M';
        outputField.title = 'Output price per 1,000,000 tokens';
        outputField.setAttribute('data-price-field', 'output');
        if (Number(price.output) > 0) outputField.value = String(price.output);
        row.appendChild(outputField);

        list.appendChild(row);
    });

    applyPriceFilter();
    lucide.createIcons();
}

function applyPriceFilter() {
    const list = el('tc-pricing-list');
    if (!list) return;
    const q = view.priceFilter.trim().toLowerCase();
    list.querySelectorAll('[data-price-model]').forEach(row => {
        const haystack = row.getAttribute('data-search') || '';
        row.classList.toggle('hidden', Boolean(q) && haystack.indexOf(q) === -1);
    });
}

function collectPricingFromDom() {
    const list = el('tc-pricing-list');
    const models = Object.assign({}, (view.pricing && view.pricing.models) || {});
    if (!list) return models;

    list.querySelectorAll('[data-price-model]').forEach(row => {
        const id = row.getAttribute('data-price-model');
        if (!id) return;
        const inEl = row.querySelector('[data-price-field="input"]');
        const outEl = row.querySelector('[data-price-field="output"]');
        const inp = parseFloat(inEl && inEl.value) || 0;
        const out = parseFloat(outEl && outEl.value) || 0;
        if (inp > 0 || out > 0) {
            models[id] = { input: inp, output: out };
        } else {
            delete models[id];
        }
    });

    return models;
}

async function savePricing() {
    const btn = el('tc-price-save');
    const status = el('tc-price-status');
    const models = collectPricingFromDom();

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving...';
    }
    if (status) {
        status.className = 'text-xs font-mono text-gb-fgDark truncate';
        status.textContent = 'Saving prices...';
    }

    try {
        const res = await fetch('/v1/model_pricing', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                models,
                currency: (view.pricing && view.pricing.currency) || 'USD'
            })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const payload = await res.json();
        view.pricing = payload.model_pricing || { currency: 'USD', unit: PRICE_UNIT, models };

        const count = Object.keys(view.pricing.models || {}).length;
        if (status) {
            status.className = 'text-xs font-mono text-gb-greenAccent truncate';
            status.textContent = count + ' model' + (count === 1 ? '' : 's') + ' priced';
        }

        renderPricing();
        renderActivePanel();
    } catch (e) {
        console.error('Failed to save model pricing', e);
        if (status) {
            status.className = 'text-xs font-mono text-gb-redAccent truncate';
            status.textContent = 'Save failed: ' + (e && e.message ? e.message : 'unknown error');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Save Prices';
        }
    }
}

// ---------------------------------------------------------------------------
// Chrome + orchestration
// ---------------------------------------------------------------------------

function updateChrome() {
    const rangeRow = el('tc-range-row');
    if (rangeRow) {
        rangeRow.classList.toggle('hidden', RANGE_PANELS.indexOf(view.activePanel) === -1);
        rangeRow.querySelectorAll('[data-range]').forEach(btn => {
            const key = btn.getAttribute('data-range');
            btn.classList.toggle('tc-range-chip-active', key === view.range);
            // Without dated buckets there is nothing to narrow to.
            btn.disabled = (key !== 'all') && !hasDaily();
        });
    }

    const note = el('tc-range-note');
    if (note) {
        note.textContent = hasDaily()
            ? rangeNote(view.range)
            : 'Dated usage unavailable \u00b7 showing all time';
    }

    const granRow = el('tc-granularity-row');
    if (granRow) {
        granRow.classList.toggle('hidden', view.chartType === 'heatmap');
        granRow.querySelectorAll('[data-granularity]').forEach(btn => {
            btn.classList.toggle('tc-range-chip-active', btn.getAttribute('data-granularity') === view.granularity);
        });
    }

    const styleRow = el('tc-chart-type-row');
    if (styleRow) {
        styleRow.querySelectorAll('[data-chart-type]').forEach(btn => {
            btn.classList.toggle('tc-style-chip-active', btn.getAttribute('data-chart-type') === view.chartType);
        });
    }
}

function renderCacheInfo() {
    const target = el('tc-cache-info');
    if (!target) return;

    const cache = view.data && view.data.cache;
    if (!cache || typeof cache !== 'object') {
        target.textContent = 'Calculated using model tokenizer encoding';
        return;
    }

    const hits = cache.hits || 0;
    const misses = cache.misses || 0;
    const total = hits + misses;
    const secs = typeof cache.elapsed_seconds === 'number' ? cache.elapsed_seconds.toFixed(2) : '?';

    const parts = [rangeLabel(view.range)];
    if (cache.forced) {
        parts.push('full rebuild \u00b7 ' + total.toLocaleString() + ' chats re-tokenized in ' + secs + 's');
    } else {
        parts.push(hits.toLocaleString() + ' of ' + total.toLocaleString() + ' chats from cache \u00b7 ' + secs + 's');
    }
    if (cache.undated_turns > 0) {
        parts.push(cache.undated_turns.toLocaleString() + ' undated turns excluded from charts');
    }

    target.textContent = parts.join(' \u00b7 ');
}

function renderActivePanel() {
    updateChrome();

    if (!view.data) return;

    if (view.activePanel === 'trends') {
        renderTrends();
        renderCacheInfo();
        return;
    }

    if (view.activePanel === 'pricing') {
        renderCacheInfo();
        return;
    }

    const rows = currentModelRows();
    if (view.activePanel === 'overview') renderOverview(rows);
    else if (view.activePanel === 'providers') renderProviders(rows);
    else if (view.activePanel === 'models') renderModels(rows);

    renderCacheInfo();
}

export async function fetchAndRenderTokenCounter(force = false) {
    const refreshBtn = el(force ? 'force-token-counter-btn' : 'refresh-token-counter-btn');
    const originalHtml = refreshBtn ? refreshBtn.innerHTML : '';

    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Working...';
        lucide.createIcons();
    }

    try {
        const url = force ? '/v1/token_counter?refresh=true' : '/v1/token_counter';
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const data = await res.json();
        view.data = data;

        if (data.pricing && typeof data.pricing === 'object') {
            view.pricing = data.pricing;
        }

        // An older server has no dated buckets; fall back rather than throw.
        if (!Array.isArray(data.daily)) view.range = 'all';

        renderPricing();
        renderActivePanel();
    } catch (e) {
        console.error('Failed to load token counter data', e);
        const tbody = el('tc-providers-tbody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-gb-redAccent">Error loading token counts: ' + e.message + '</td></tr>';
        }
        const cacheInfo = el('tc-cache-info');
        if (cacheInfo) cacheInfo.textContent = 'Failed to load: ' + e.message;
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = originalHtml;
            lucide.createIcons();
        }
    }
}

function wireTabs() {
    switchPanel = wireModalTabs({
        railId: 'tc-tabs',
        hostId: 'tc-panels',
        panels: PANELS,
        onSwitch: (panelId) => {
            view.activePanel = panelId;
            // Rendered after the panel is visible, so the chart can measure it.
            renderActivePanel();
        }
    });
}

export function openTokenCounterModal() {
    const modal = el('token-counter-modal');
    const box = el('token-counter-modal-box');
    if (!modal || !box) return;

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');

    if (!switchPanel) wireTabs();
    view.activePanel = DEFAULT_PANEL;
    if (switchPanel) switchPanel(DEFAULT_PANEL);

    fetchAndRenderTokenCounter(false);
}

export function closeTokenCounterModal() {
    const modal = el('token-counter-modal');
    const box = el('token-counter-modal-box');
    if (!modal || !box) return;

    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
}

export function wireTokenCounterModal() {
    const openBtn = el('token-counter-btn');
    const closeBtn = el('close-token-counter-btn');
    const doneBtn = el('close-token-counter-done-btn');
    const refreshBtn = el('refresh-token-counter-btn');
    const forceBtn = el('force-token-counter-btn');
    const modal = el('token-counter-modal');

    if (openBtn) openBtn.onclick = openTokenCounterModal;
    if (closeBtn) closeBtn.onclick = closeTokenCounterModal;
    if (doneBtn) doneBtn.onclick = closeTokenCounterModal;
    if (refreshBtn) refreshBtn.onclick = () => fetchAndRenderTokenCounter(false);
    if (forceBtn) forceBtn.onclick = () => fetchAndRenderTokenCounter(true);

    if (modal) {
        modal.onclick = (e) => {
            if (e.target === modal) closeTokenCounterModal();
        };
    }

    const rangeRow = el('tc-range-row');
    if (rangeRow) {
        rangeRow.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-range]');
            if (!btn || btn.disabled) return;
            const next = btn.getAttribute('data-range');
            if (!next || next === view.range) return;
            view.range = next;
            renderActivePanel();
        });
    }

    const granRow = el('tc-granularity-row');
    if (granRow) {
        granRow.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-granularity]');
            if (!btn) return;
            const next = btn.getAttribute('data-granularity');
            if (!next || next === view.granularity) return;
            view.granularity = next;
            renderActivePanel();
        });
    }

    const styleRow = el('tc-chart-type-row');
    if (styleRow) {
        styleRow.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-chart-type]');
            if (!btn) return;
            const next = btn.getAttribute('data-chart-type');
            if (!next || next === view.chartType) return;
            view.chartType = next;
            renderActivePanel();
        });
    }

    const modelFilter = el('tc-model-filter');
    if (modelFilter) {
        modelFilter.oninput = (e) => {
            view.modelFilter = e.target.value || '';
            if (view.activePanel === 'models') renderActivePanel();
        };
    }

    const priceFilter = el('tc-price-filter');
    if (priceFilter) {
        priceFilter.oninput = (e) => {
            view.priceFilter = e.target.value || '';
            applyPriceFilter();
        };
    }

    const saveBtn = el('tc-price-save');
    if (saveBtn) saveBtn.onclick = savePricing;

    // Generated SVG fills and the overview proportion bars are written as
    // literal colours, so a theme switch needs an explicit repaint. Only the
    // mounted panel is redrawn; the others rebuild on their next switch.
    window.addEventListener(THEME_EVENT, () => {
        if (isModalOpen()) renderActivePanel();
    });

    // The chart is sized in real pixels, so it has to be redrawn when the
    // window changes. Debounced, and only while it is actually on screen.
    window.addEventListener('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            if (isModalOpen() && view.activePanel === 'trends') renderTrends();
        }, RESIZE_DEBOUNCE_MS);
    });
}
