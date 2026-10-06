import { store, getActiveConversation } from './storage.js';
import {
    buildFileIndex,
    computeTotals,
    setPruneState,
    restoreAllManual,
    DEFAULT_MANUAL_REASON
} from './pruneManual.js';
import { saveHistory } from './sidebar.js';
import { renderChat } from './chat.js';
import { updateTokenCount } from './tokens.js';
import { scrollToMessage } from './chatNav.js';

/**
 * Slide-in drawer for manual context pruning.
 *
 * Owns only view state; every mutation goes through setPruneState() so the
 * drawer and the assistant's prune card can never disagree about what is
 * currently removed from context.
 */

const view = {
    query: '',
    sortKey: 'tokens',
    sortDir: 'desc',
    filter: 'all',
    scopeIndex: null,
    selection: new Set()
};

function el(id) {
    return document.getElementById(id);
}

export function isPruneDrawerOpen() {
    const drawer = el('prune-drawer');
    return Boolean(drawer && drawer.classList.contains('prune-drawer-open'));
}

export function openPruneDrawer(scopeIndex) {
    const drawer = el('prune-drawer');
    const overlay = el('prune-drawer-overlay');
    if (!drawer || !overlay) return;

    view.scopeIndex = Number.isInteger(scopeIndex) ? scopeIndex : null;
    view.selection.clear();

    drawer.classList.add('prune-drawer-open');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.classList.remove('opacity-0', 'pointer-events-none');

    renderPruneDrawer();

    const search = el('prune-drawer-search');
    if (search) setTimeout(() => search.focus(), 60);
}

export function closePruneDrawer() {
    const drawer = el('prune-drawer');
    const overlay = el('prune-drawer-overlay');
    if (!drawer || !overlay) return;

    drawer.classList.remove('prune-drawer-open');
    drawer.setAttribute('aria-hidden', 'true');
    overlay.classList.add('opacity-0', 'pointer-events-none');
}

function allRows() {
    const active = getActiveConversation();
    if (!active || !Array.isArray(active.messages)) return [];
    return buildFileIndex(active.messages);
}

function matchesScope(row) {
    if (view.scopeIndex === null) return true;
    return row.occurrences.some(o => o.messageIndex === view.scopeIndex);
}

function matchesFilter(row) {
    switch (view.filter) {
        case 'active': return row.prunedCount < row.count;
        case 'pruned': return row.prunedCount > 0;
        case 'partial': return row.isPartial;
        case 'duplicates': return row.count > 1;
        default: return true;
    }
}

function visibleRows() {
    const q = view.query.trim().toLowerCase();

    const list = allRows().filter(row => {
        if (!matchesScope(row)) return false;
        if (q && row.key.toLowerCase().indexOf(q) === -1) return false;
        return matchesFilter(row);
    });

    const dir = view.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
        let cmp = 0;
        if (view.sortKey === 'tokens') cmp = a.tokens - b.tokens;
        else if (view.sortKey === 'path') cmp = a.key.localeCompare(b.key);
        else if (view.sortKey === 'ext') cmp = (a.ext || '').localeCompare(b.ext || '');
        else cmp = a.firstIndex - b.firstIndex;
        if (cmp === 0) cmp = a.key.localeCompare(b.key);
        return cmp * dir;
    });

    return list;
}

function toggleSelection(key) {
    if (view.selection.has(key)) view.selection.delete(key);
    else view.selection.add(key);
    renderPruneDrawer();
}

function badge(text, cls, title) {
    const span = document.createElement('span');
    span.className = 'prune-badge ' + cls;
    span.textContent = text;
    if (title) span.title = title;
    return span;
}

function createRow(row) {
    const selected = view.selection.has(row.key);
    const fullyPruned = row.count > 0 && row.prunedCount === row.count;

    const wrap = document.createElement('div');
    wrap.className = 'prune-row'
        + (selected ? ' prune-row-selected' : '')
        + (row.prunedCount > 0 ? ' prune-row-pruned' : '');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'prune-row-check';
    check.checked = selected;
    check.onclick = (e) => {
        e.stopPropagation();
        toggleSelection(row.key);
    };
    wrap.appendChild(check);

    const main = document.createElement('div');
    main.className = 'prune-row-main';

    const pathEl = document.createElement('div');
    pathEl.className = 'prune-row-path';
    pathEl.textContent = row.path;
    pathEl.title = row.path;
    main.appendChild(pathEl);

    const meta = document.createElement('div');
    meta.className = 'prune-row-meta';

    meta.appendChild(badge('~' + row.tokens.toLocaleString() + ' tok', 'prune-badge-tokens'));
    if (row.ext) meta.appendChild(badge('.' + row.ext, 'prune-badge-ext'));
    if (row.count > 1) {
        meta.appendChild(badge('\u00d7' + row.count, 'prune-badge-dup', 'Provided in ' + row.count + ' messages'));
    }
    if (row.isPartial) meta.appendChild(badge('PARTIAL', 'prune-badge-partial'));

    if (row.isMixed) {
        meta.appendChild(badge('MIXED', 'prune-badge-mixed', 'Pruned in some messages only'));
    } else if (fullyPruned) {
        const label = row.manualCount > 0 ? 'PRUNED' : 'PRUNED (AI)';
        meta.appendChild(badge(label, 'prune-badge-pruned', row.reason || ''));
    }

    row.labels.forEach(label => {
        const jump = document.createElement('button');
        jump.className = 'prune-badge prune-badge-jump';
        jump.textContent = label;
        jump.title = 'Jump to message ' + label;
        jump.onclick = (e) => {
            e.stopPropagation();
            const occ = row.occurrences.find(o => o.label === label);
            if (!occ) return;
            closePruneDrawer();
            scrollToMessage(occ.messageIndex);
        };
        meta.appendChild(jump);
    });

    main.appendChild(meta);
    wrap.appendChild(main);

    const action = document.createElement('button');
    action.className = 'prune-row-action' + (fullyPruned ? ' prune-row-action-restore' : '');
    action.title = fullyPruned ? 'Restore this file' : 'Prune this file';
    action.innerHTML = fullyPruned
        ? '<i data-lucide="rotate-ccw" class="w-4 h-4"></i>'
        : '<i data-lucide="scissors" class="w-4 h-4"></i>';
    action.onclick = (e) => {
        e.stopPropagation();
        applyChange([row.key], !fullyPruned);
    };
    wrap.appendChild(action);

    wrap.onclick = () => toggleSelection(row.key);
    return wrap;
}

function updateSummary(rows) {
    const summary = el('prune-drawer-summary');
    if (!summary) return;

    const totals = computeTotals(allRows());
    const activeTokens = Math.max(0, totals.tokens - totals.saved);

    summary.textContent = rows.length + ' shown \u00b7 '
        + totals.files + ' files \u00b7 '
        + activeTokens.toLocaleString() + ' / ' + totals.tokens.toLocaleString() + ' tok active \u00b7 '
        + totals.saved.toLocaleString() + ' saved \u00b7 '
        + view.selection.size + ' selected';
}

function updateControls(rows) {
    const subtitle = el('prune-drawer-subtitle');
    if (subtitle) {
        subtitle.textContent = view.scopeIndex === null
            ? 'All files in this thread'
            : 'Scoped to one message';
    }

    const clearScope = el('prune-drawer-clear-scope');
    if (clearScope) clearScope.classList.toggle('hidden', view.scopeIndex === null);

    const selectAll = el('prune-drawer-selectall');
    if (selectAll) {
        selectAll.checked = rows.length > 0 && rows.every(r => view.selection.has(r.key));
    }

    const filters = el('prune-drawer-filters');
    if (filters) {
        filters.querySelectorAll('[data-filter]').forEach(btn => {
            btn.classList.toggle('prune-chip-active', btn.getAttribute('data-filter') === view.filter);
        });
    }

    const sortSel = el('prune-drawer-sort');
    if (sortSel) sortSel.value = view.sortKey;

    const dirBtn = el('prune-drawer-sortdir');
    if (dirBtn) {
        dirBtn.innerHTML = view.sortDir === 'asc'
            ? '<i data-lucide="arrow-up-narrow-wide" class="w-4 h-4"></i>'
            : '<i data-lucide="arrow-down-wide-narrow" class="w-4 h-4"></i>';
        dirBtn.title = view.sortDir === 'asc' ? 'Ascending' : 'Descending';
    }

    const pruneBtn = el('prune-drawer-prune');
    const restoreBtn = el('prune-drawer-restore');
    const disabled = view.selection.size === 0;
    [pruneBtn, restoreBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = disabled;
        btn.classList.toggle('opacity-50', disabled);
        btn.classList.toggle('cursor-not-allowed', disabled);
    });
}

export function renderPruneDrawer() {
    const list = el('prune-drawer-list');
    if (!list) return;

    const rows = visibleRows();
    const scrollTop = list.scrollTop;
    list.innerHTML = '';

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'flex flex-col items-center justify-center gap-3 py-12 text-gb-fgDark text-center px-6';
        empty.innerHTML = '<i data-lucide="file-search" class="w-10 h-10 opacity-50"></i><p class="text-sm font-semibold">No files match the current view.</p><p class="text-xs text-gb-bgLight3">File context is detected from combineCopy payloads in this thread.</p>';
        list.appendChild(empty);
    } else {
        rows.forEach(row => list.appendChild(createRow(row)));
    }

    list.scrollTop = scrollTop;
    updateSummary(rows);
    updateControls(rows);
    lucide.createIcons();
}

function blockedWhileProcessing() {
    if (store.isProcessing) {
        alert('Please stop the current generation before changing the context.');
        return true;
    }
    return false;
}

function commit(touched) {
    if (touched > 0) {
        saveHistory();
        renderChat(true);
        updateTokenCount();
    }
    renderPruneDrawer();
}

function applyChange(keys, shouldPrune) {
    if (blockedWhileProcessing()) return;

    const active = getActiveConversation();
    if (!active) return;

    const reasonInput = el('prune-drawer-reason');
    const reason = (reasonInput && reasonInput.value.trim())
        ? reasonInput.value
        : DEFAULT_MANUAL_REASON;

    commit(setPruneState(active.messages, keys, shouldPrune, reason));
}

function applySelection(shouldPrune) {
    if (view.selection.size === 0) return;
    applyChange(Array.from(view.selection), shouldPrune);
}

function handleRestoreAll() {
    if (blockedWhileProcessing()) return;

    const active = getActiveConversation();
    if (!active) return;

    commit(restoreAllManual(active.messages));
}

export function wirePruneDrawer() {
    const openBtn = el('prune-files-btn');
    if (openBtn) openBtn.addEventListener('click', () => openPruneDrawer(null));

    const overlay = el('prune-drawer-overlay');
    if (overlay) overlay.addEventListener('click', closePruneDrawer);

    const closeBtn = el('prune-drawer-close');
    if (closeBtn) closeBtn.addEventListener('click', closePruneDrawer);

    const search = el('prune-drawer-search');
    if (search) {
        search.addEventListener('input', (e) => {
            view.query = e.target.value || '';
            renderPruneDrawer();
        });
    }

    const sortSel = el('prune-drawer-sort');
    if (sortSel) {
        sortSel.addEventListener('change', (e) => {
            view.sortKey = e.target.value;
            renderPruneDrawer();
        });
    }

    const dirBtn = el('prune-drawer-sortdir');
    if (dirBtn) {
        dirBtn.addEventListener('click', () => {
            view.sortDir = view.sortDir === 'asc' ? 'desc' : 'asc';
            renderPruneDrawer();
        });
    }

    const filters = el('prune-drawer-filters');
    if (filters) {
        filters.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-filter]');
            if (!btn) return;
            view.filter = btn.getAttribute('data-filter') || 'all';
            renderPruneDrawer();
        });
    }

    const clearScope = el('prune-drawer-clear-scope');
    if (clearScope) {
        clearScope.addEventListener('click', () => {
            view.scopeIndex = null;
            renderPruneDrawer();
        });
    }

    const selectAll = el('prune-drawer-selectall');
    if (selectAll) {
        selectAll.addEventListener('change', (e) => {
            const rows = visibleRows();
            if (e.target.checked) rows.forEach(r => view.selection.add(r.key));
            else rows.forEach(r => view.selection.delete(r.key));
            renderPruneDrawer();
        });
    }

    const pruneBtn = el('prune-drawer-prune');
    if (pruneBtn) pruneBtn.addEventListener('click', () => applySelection(true));

    const restoreBtn = el('prune-drawer-restore');
    if (restoreBtn) restoreBtn.addEventListener('click', () => applySelection(false));

    const restoreAllBtn = el('prune-drawer-restore-all');
    if (restoreAllBtn) restoreAllBtn.addEventListener('click', handleRestoreAll);
}
