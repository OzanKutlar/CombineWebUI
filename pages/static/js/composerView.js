import { countTokens, updateTokenCount } from './tokens.js';
import { showConfirmModal } from './modals.js';
import { wireModalTabs } from './modalTabs.js';
import { copyTextToClipboard } from './clipboard.js';
import {
    parsePasteText,
    isStageablePaste,
    stagePayload,
    appendFilesToStaged,
    getStaged,
    hasStaged,
    clearStaged,
    composePrompt,
    toggleFileRemoved,
    toggleSectionRemoved,
    isFileRemoved,
    isSectionRemoved,
    onComposerChange
} from './composer.js';

/**
 * DOM side of the structured-paste composer: the paste interceptor, the chip
 * bar above the prompt box, and the Pasted Context modal.
 *
 * The modal is built once per open. Removing or restoring an item updates the
 * affected row in place, so a large payload is never re-rendered on a click,
 * and file contents are only put in the DOM when a row is expanded.
 */

const FILES_PANEL = 'files';
const SECTION_PREFIX = 'sec-';
const COPY_FEEDBACK_MS = 2000;

let activePanel = FILES_PANEL;

function el(id) {
    return document.getElementById(id);
}

function promptBox() {
    return el('prompt-input');
}

function tokenLabel(count) {
    return '~' + (Number(count) || 0).toLocaleString() + ' tok';
}

function plural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
}

function iconHtml(name, cls) {
    return '<i data-lucide="' + name + '"' + (cls ? ' class="' + cls + '"' : '') + '></i>';
}

function refreshIcons() {
    try {
        lucide.createIcons();
    } catch (e) {
        console.warn('Failed to render icons', e);
    }
}

function fileTokens(file) {
    return countTokens((file && file.content) || '');
}

function activeFileStats(files) {
    let count = 0;
    let tokens = 0;
    files.forEach((file, i) => {
        if (isFileRemoved(i)) return;
        count += 1;
        tokens += fileTokens(file);
    });
    return { count, tokens };
}

function activeSectionCount(sections) {
    return sections.filter((_, i) => !isSectionRemoved(i)).length;
}

// ---------------------------------------------------------------------------
// Chip bar
// ---------------------------------------------------------------------------

function buildChip(iconName, label, tokens, title, removed, onClick) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'composer-chip' + (removed ? ' composer-chip-removed' : '');
    chip.title = title;
    chip.innerHTML = iconHtml(iconName);

    const text = document.createElement('span');
    text.className = 'composer-chip-label';
    text.textContent = label;
    chip.appendChild(text);

    const tok = document.createElement('span');
    tok.className = 'composer-chip-tokens';
    tok.textContent = tokenLabel(tokens);
    chip.appendChild(tok);

    chip.onclick = onClick;
    return chip;
}

function buildBarAction(iconName, label, title, onClick, danger) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'composer-bar-action' + (danger ? ' composer-bar-action-danger' : '');
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = iconHtml(iconName);
    if (label) {
        const span = document.createElement('span');
        span.textContent = label;
        btn.appendChild(span);
    }
    btn.onclick = onClick;
    return btn;
}

function buildFilesChip(files) {
    const stats = activeFileStats(files);
    const removed = files.length - stats.count;
    const label = plural(stats.count, 'file') + (removed > 0 ? ' \u00b7 ' + removed + ' removed' : '');
    return buildChip('folder-open', label, stats.tokens, 'View and manage the pasted files',
        stats.count === 0, () => openPasteContextModal(FILES_PANEL));
}

function buildSectionChip(section, index) {
    const removed = isSectionRemoved(index);
    const title = removed ? section.title + ' (removed, click to review)' : 'View ' + section.title;
    return buildChip(section.icon || 'file-text', section.title, countTokens(section.body || ''), title,
        removed, () => openPasteContextModal(SECTION_PREFIX + index));
}

export function renderComposerBar() {
    const bar = el('composer-bar');
    if (!bar) return;
    bar.innerHTML = '';

    const staged = getStaged();
    bar.classList.toggle('composer-bar-empty', !staged);
    if (!staged) return;

    const label = document.createElement('span');
    label.className = 'composer-bar-label';
    label.innerHTML = iconHtml('paperclip');
    const labelText = document.createElement('span');
    labelText.textContent = 'Attached';
    label.appendChild(labelText);
    bar.appendChild(label);

    const files = staged.parsed.files;
    if (files.length > 0) bar.appendChild(buildFilesChip(files));
    staged.parsed.sections.forEach((section, i) => bar.appendChild(buildSectionChip(section, i)));

    const spacer = document.createElement('span');
    spacer.className = 'composer-bar-spacer';
    bar.appendChild(spacer);

    bar.appendChild(buildBarAction('maximize-2', 'Raw', 'Expand to raw: put the full payload back into the prompt box', expandToRaw, false));
    bar.appendChild(buildBarAction('x', '', 'Discard the pasted context', confirmDiscard, true));
    refreshIcons();
}

// ---------------------------------------------------------------------------
// Paste handling
// ---------------------------------------------------------------------------

function insertAtCursor(input, text) {
    if (typeof input.setRangeText === 'function' && Number.isInteger(input.selectionStart)) {
        input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
        return;
    }
    input.value += text;
}

function stageIntoInput(input, raw, parsed, replaceText) {
    if (!stagePayload(raw, parsed)) return;
    const request = parsed.userRequest || '';
    if (replaceText) input.value = request;
    else insertAtCursor(input, request);
    // Lets the prompt box's own input listener recount tokens.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
}

function readClipboardText(event) {
    const data = event.clipboardData;
    if (!data || typeof data.getData !== 'function') return '';
    try {
        return data.getData('text/plain') || '';
    } catch (e) {
        console.warn('Could not read the pasted text', e);
        return '';
    }
}

function appendIntoInput(input, raw, parsed) {
    if (!appendFilesToStaged(raw, parsed)) return false;
    const request = (parsed && parsed.userRequest) ? parsed.userRequest : '';
    if (input && !input.value.trim() && request) {
        input.value = request;
    }
    if (isModalOpen()) {
        renderModal();
    }
    if (input) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (!isModalOpen()) input.focus();
    }
    return true;
}

/** Plain text falls through to the browser; only structured payloads are staged. */
function handlePaste(event) {
    const input = event.currentTarget || promptBox();
    if (!input) return;

    const raw = readClipboardText(event);
    const parsed = parsePasteText(raw);
    if (!isStageablePaste(parsed)) return;

    event.preventDefault();
    if (!hasStaged()) {
        stageIntoInput(input, raw, parsed, false);
        return;
    }
    if (appendIntoInput(input, raw, parsed)) return;

    showConfirmModal(
        'Replace Pasted Context',
        'A pasted payload is already attached to this prompt. Replace it with the new one? The request text in the prompt box is replaced as well.',
        () => stageIntoInput(input, raw, parsed, true)
    );
}

// ---------------------------------------------------------------------------
// Bar and modal actions
// ---------------------------------------------------------------------------

function expandToRaw() {
    const input = promptBox();
    if (!input || !hasStaged()) return;
    input.value = composePrompt(input.value);
    clearStaged();
    closePasteContextModal();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
}

function confirmDiscard() {
    if (!hasStaged()) return;
    showConfirmModal(
        'Discard Pasted Context',
        'Remove every attached file and section? The request text in the prompt box is kept.',
        () => clearStaged()
    );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function isModalOpen() {
    const modal = el('paste-context-modal');
    return Boolean(modal) && !modal.classList.contains('opacity-0');
}

function setModalVisible(visible) {
    const modal = el('paste-context-modal');
    const box = el('paste-context-modal-box');
    if (!modal || !box) return;
    modal.classList.toggle('opacity-0', !visible);
    modal.classList.toggle('pointer-events-none', !visible);
    box.classList.toggle('translate-y-8', !visible);
    box.classList.toggle('translate-y-0', visible);
}

export function openPasteContextModal(panelId) {
    if (!hasStaged()) return;
    activePanel = (typeof panelId === 'string' && panelId) ? panelId : FILES_PANEL;
    setModalVisible(true);
    renderModal();
}

export function closePasteContextModal() {
    setModalVisible(false);
}

function panelIds(staged) {
    const ids = [];
    if (staged.parsed.files.length > 0) ids.push(FILES_PANEL);
    staged.parsed.sections.forEach((_, i) => ids.push(SECTION_PREFIX + i));
    return ids;
}

function buildRailTab(id, iconName, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-tab';
    btn.setAttribute('data-panel', id);
    btn.innerHTML = iconHtml(iconName);
    const span = document.createElement('span');
    span.className = 'ctx-tab-label';
    span.textContent = label;
    span.title = label;
    btn.appendChild(span);
    return btn;
}

function buildPanelShell(id, title) {
    const panel = document.createElement('section');
    panel.className = 'modal-panel';
    panel.setAttribute('data-panel', id);

    const head = document.createElement('div');
    head.className = 'ctx-panel-head';

    const titles = document.createElement('div');
    titles.className = 'min-w-0';
    const heading = document.createElement('h3');
    heading.className = 'text-md font-bold text-gb-fgLightest truncate';
    heading.textContent = title;
    const sub = document.createElement('p');
    sub.className = 'ctx-panel-sub';
    titles.appendChild(heading);
    titles.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2 shrink-0';

    head.appendChild(titles);
    head.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'ctx-panel-body scrollbar-hide';

    panel.appendChild(head);
    panel.appendChild(body);
    return { panel, sub, actions, body };
}

function buildBadge(text, cls, title) {
    const span = document.createElement('span');
    span.className = 'prune-badge ' + cls;
    span.textContent = text;
    if (title) span.title = title;
    return span;
}

function buildActionButton(action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-action-btn';
    btn.setAttribute('data-ctx-action', action);
    return btn;
}

function setToggleButton(btn, removed) {
    btn.classList.toggle('ctx-action-restore', removed);
    btn.classList.toggle('ctx-action-danger', !removed);
    btn.innerHTML = iconHtml(removed ? 'rotate-ccw' : 'trash-2') + '<span>' + (removed ? 'Restore' : 'Remove') + '</span>';
    btn.title = removed ? 'Put this back into the prompt' : 'Leave this out of the prompt';
}

function applyFileState(row, index) {
    const removed = isFileRemoved(index);
    row.classList.toggle('ctx-file-removed', removed);
    const btn = row.querySelector('[data-ctx-action="toggle-file"]');
    if (btn) setToggleButton(btn, removed);
}

/** Content is only put in the DOM while the row is open. */
function toggleFileBody(row, file) {
    const existing = row.querySelector('.ctx-file-body');
    if (existing) {
        existing.remove();
        row.classList.remove('ctx-file-open');
        return;
    }
    const body = document.createElement('div');
    body.className = 'ctx-file-body';
    const pre = document.createElement('pre');
    pre.className = 'prompt-section-body ctx-pre';
    pre.textContent = file.content || '';
    body.appendChild(pre);
    row.appendChild(body);
    row.classList.add('ctx-file-open');
}

function buildFileRow(file, index) {
    const row = document.createElement('div');
    row.className = 'ctx-file-row';

    const head = document.createElement('div');
    head.className = 'ctx-file-head';
    head.innerHTML = iconHtml('chevron-right', 'ctx-file-chevron')
        + iconHtml(file.isPruned ? 'scissors' : 'file-code', 'ctx-file-icon');

    const path = document.createElement('span');
    path.className = 'ctx-file-path';
    path.textContent = file.path || '(unnamed file)';
    path.title = file.path || '';
    head.appendChild(path);

    const meta = document.createElement('div');
    meta.className = 'prune-row-meta shrink-0';
    meta.appendChild(buildBadge(tokenLabel(fileTokens(file)), 'prune-badge-tokens'));
    if (file.isPartial) meta.appendChild(buildBadge('PARTIAL', 'prune-badge-partial', 'Some line ranges are hidden'));
    if (file.isPruned) meta.appendChild(buildBadge('PRUNED', 'prune-badge-pruned', file.prunedReason || ''));
    head.appendChild(meta);

    const toggle = buildActionButton('toggle-file');
    toggle.onclick = (e) => {
        e.stopPropagation();
        if (!toggleFileRemoved(index)) return;
        applyFileState(row, index);
        refreshIcons();
    };
    head.appendChild(toggle);

    head.onclick = () => toggleFileBody(row, file);
    row.appendChild(head);
    applyFileState(row, index);
    return row;
}

function buildFilesPanel(files) {
    const shell = buildPanelShell(FILES_PANEL, 'Files');
    shell.sub.id = 'paste-ctx-files-sub';
    files.forEach((file, i) => shell.body.appendChild(buildFileRow(file, i)));
    return shell.panel;
}

function buildCopyButton(text) {
    const btn = buildActionButton('copy');
    const idle = iconHtml('copy') + '<span>Copy</span>';
    btn.innerHTML = idle;
    btn.title = 'Copy this section';
    btn.onclick = async () => {
        let ok = false;
        try {
            ok = await copyTextToClipboard(text);
        } catch (e) {
            console.error('Failed to copy the section', e);
        }
        if (!ok) return;
        btn.innerHTML = iconHtml('check') + '<span>Copied</span>';
        refreshIcons();
        setTimeout(() => {
            if (!btn.isConnected) return;
            btn.innerHTML = idle;
            refreshIcons();
        }, COPY_FEEDBACK_MS);
    };
    return btn;
}

function applySectionState(index) {
    const id = SECTION_PREFIX + index;
    const removed = isSectionRemoved(index);

    const panel = document.querySelector('#paste-ctx-panels [data-panel="' + id + '"]');
    if (panel) {
        panel.classList.toggle('ctx-section-removed', removed);
        const btn = panel.querySelector('[data-ctx-action="toggle-section"]');
        if (btn) setToggleButton(btn, removed);
    }

    const tab = document.querySelector('#paste-ctx-tabs [data-panel="' + id + '"]');
    if (tab) tab.classList.toggle('ctx-tab-removed', removed);
}

function buildSectionPanel(section, index) {
    const shell = buildPanelShell(SECTION_PREFIX + index, section.title);
    shell.sub.textContent = tokenLabel(countTokens(section.body || ''));
    shell.actions.appendChild(buildCopyButton(section.body || ''));

    const toggle = buildActionButton('toggle-section');
    toggle.onclick = () => {
        if (!toggleSectionRemoved(index)) return;
        applySectionState(index);
        refreshIcons();
    };
    shell.actions.appendChild(toggle);

    const pre = document.createElement('pre');
    pre.className = 'prompt-section-body ctx-section-pre';
    pre.textContent = section.body || '';
    shell.body.appendChild(pre);
    return shell.panel;
}

function updateModalSummary() {
    const staged = getStaged();
    if (!staged) return;
    const { files, sections } = staged.parsed;
    const stats = activeFileStats(files);

    const filesSub = el('paste-ctx-files-sub');
    if (filesSub) {
        filesSub.textContent = stats.count + ' of ' + plural(files.length, 'file') + ' included \u00b7 ' + tokenLabel(stats.tokens);
    }

    const summary = el('paste-ctx-summary');
    if (!summary) return;
    const input = promptBox();
    const total = countTokens(composePrompt(input ? input.value : ''));
    const parts = [];
    if (files.length > 0) parts.push(stats.count + '/' + files.length + ' files');
    if (sections.length > 0) parts.push(activeSectionCount(sections) + '/' + sections.length + ' sections');
    parts.push(tokenLabel(total) + ' will be sent');
    summary.textContent = parts.join(' \u00b7 ');
}

function renderModal() {
    const staged = getStaged();
    const rail = el('paste-ctx-tabs');
    const host = el('paste-ctx-panels');
    if (!staged || !rail || !host) {
        closePasteContextModal();
        return;
    }

    const ids = panelIds(staged);
    if (ids.length === 0) {
        closePasteContextModal();
        return;
    }
    if (ids.indexOf(activePanel) === -1) activePanel = ids[0];

    rail.innerHTML = '';
    host.innerHTML = '';

    const files = staged.parsed.files;
    if (files.length > 0) {
        rail.appendChild(buildRailTab(FILES_PANEL, 'folder-open', 'Files (' + files.length + ')'));
        host.appendChild(buildFilesPanel(files));
    }
    staged.parsed.sections.forEach((section, i) => {
        rail.appendChild(buildRailTab(SECTION_PREFIX + i, section.icon || 'file-text', section.title));
        host.appendChild(buildSectionPanel(section, i));
        applySectionState(i);
    });

    // The panel list changes with every payload, so the rail is re-wired on
    // each open; the shared helper keeps a single click listener regardless.
    const switchTo = wireModalTabs({
        railId: 'paste-ctx-tabs',
        hostId: 'paste-ctx-panels',
        panels: ids,
        onSwitch: (id) => {
            activePanel = id;
        }
    });
    switchTo(activePanel);

    updateModalSummary();
    refreshIcons();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function handleComposerChange() {
    renderComposerBar();
    updateTokenCount();
    if (!hasStaged()) {
        closePasteContextModal();
    } else if (isModalOpen()) {
        updateModalSummary();
    }
}

function bindClick(id, handler) {
    const btn = el(id);
    if (btn) btn.addEventListener('click', handler);
}

export function wireComposer() {
    const input = promptBox();
    if (input) input.addEventListener('paste', handlePaste);

    onComposerChange(handleComposerChange);

    const modal = el('paste-context-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closePasteContextModal();
        });
    }

    bindClick('close-paste-ctx-btn', closePasteContextModal);
    bindClick('paste-ctx-done-btn', closePasteContextModal);
    bindClick('paste-ctx-raw-btn', expandToRaw);
    bindClick('paste-ctx-discard-btn', confirmDiscard);

    renderComposerBar();
}
