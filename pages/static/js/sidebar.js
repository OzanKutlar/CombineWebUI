import {
    store,
    getActiveConversation,
    persistActiveConvId,
    persistSidebarViewMode,
    touchConversation,
    getConvTimestamp,
    saveConversationToBackend,
    saveIndexToBackend,
    deleteConversationOnBackend,
    saveHistoryToBackend,
    getFolderChildren,
    canMoveFolder
} from './storage.js';
import { showConfirmModal } from './modals.js';
import { renderChat, updateHeaderTitle } from './chat.js';
import { updateTokenCount } from './tokens.js';
import { showPopupMenu, closePopupMenu } from './popupMenu.js';
import { resolveAutoNameModel, buildNamingBasis } from './autoName.js';
import { splitInlineThinking, getInlineTags } from './reasoning.js';
import {
    AUTO_NAME_MAX_TOKENS,
    AUTO_NAME_REASONING_EFFORT,
    AUTO_FOLDER_MAX_TOKENS,
    MAX_FOLDER_DEPTH
} from './config.js';
import {
    AUTO_FOLDER_SYSTEM_PROMPT,
    buildUnsortedChats,
    buildFolderSnapshot,
    buildAutoFolderPrompt
} from './autoFolder.js';
import { extractJsonObject, resolvePlan } from './autoFolderPlan.js';
import { openAutoFolderModal } from './autoFolderModal.js';
import {
    attachConvDrag,
    attachFolderDrag,
    attachFolderDropTarget,
    attachRootDropTarget
} from './dragdrop.js';
import { attachNameReveal, attachFolderNameReveal, hideFolderNameChip } from './folderReveal.js';

const NAMING_SYSTEM_PROMPT = 'You are a helpful assistant. You will be given an excerpt of a conversation containing a user request and the assistant reply to it. Generate a short, one-line title (max 5 words) describing what the exchange is about. Output ONLY the title, no quotes or prefix.';
const AUTO_NAME_BTN_HTML = '<i data-lucide="zap" class="w-3.5 h-3.5"></i> Auto Name';
const NO_NAMING_MODEL_MSG = 'No local or custom endpoint model is available for auto-naming. Add one in Settings.';

export function saveConversations() {
    persistActiveConvId();
    saveHistoryToBackend();
}

export function initConversations() {
    if (!Array.isArray(store.folders)) store.folders = [];
    if (store.conversations.length === 0) {
        createNewChat();
        return;
    }
    if (!store.activeConvId || !store.conversations.some(c => c.id === store.activeConvId)) {
        store.activeConvId = store.conversations[0].id;
    }
    saveConversations();
}

export function createNewChat(folderId) {
    const id = 'conv_' + Date.now();
    const now = Date.now();
    store.conversations.unshift({
        id,
        title: 'New Chat',
        messages: [],
        folderId: folderId || null,
        updatedAt: now
    });
    store.activeConvId = id;
    saveConversations();
    renderSidebar();
    renderChat();
}

export function setSidebarViewMode(mode) {
    const nextMode = mode === 'recent' ? 'recent' : 'folders';
    if (store.sidebarViewMode === nextMode) return;
    store.sidebarViewMode = nextMode;
    persistSidebarViewMode();
    if (nextMode === 'recent') {
        store.conversations.sort((a, b) => getConvTimestamp(b) - getConvTimestamp(a));
        saveIndexToBackend();
    }
    renderSidebar();
}

export function createNewFolder(parentId = null) {
    const cleanParentId = (typeof parentId === 'string' && parentId.trim()) ? parentId.trim() : null;
    const folder = {
        id: 'folder_' + Date.now(),
        name: 'New Folder',
        parentId: cleanParentId,
        collapsed: false
    };
    store.folders.unshift(folder);
    saveConversations();
    renderSidebar();
}

export function saveHistory() {
    const active = getActiveConversation();
    if (!active) return;
    active.updatedAt = Date.now();
    if (active.title === 'New Chat' && active.messages.length > 0) {
        const firstUser = active.messages.find(m => m.role === 'user');
        if (firstUser) {
            const sliced = firstUser.content.slice(0, 30);
            active.title = sliced + (firstUser.content.length > 30 ? '...' : '');
            updateHeaderTitle();
        }
    }
    touchConversation(active.id);
    saveConversations();
    renderSidebar();
}

export function deleteConversation(id) {
    deleteConversationOnBackend(id);
    store.conversations = store.conversations.filter(c => c.id !== id);
    if (store.activeConvId === id) {
        store.activeConvId = store.conversations.length > 0 ? store.conversations[0].id : '';
    }
    initConversations();
    saveConversations();
    renderSidebar();
    renderChat();
}

/** Non-destructive: children are moved to the folder's parent rather than lost. */
export function deleteFolder(folderId) {
    const targetFolder = store.folders.find(f => f.id === folderId);
    const newParentId = targetFolder ? targetFolder.parentId : null;

    store.folders = store.folders.filter(f => f.id !== folderId);
    store.folders.forEach(f => {
        if (f.parentId === folderId) {
            f.parentId = newParentId;
        }
    });
    store.conversations.forEach(c => {
        if (c.folderId === folderId) {
            c.folderId = newParentId;
            saveConversationToBackend(c);
        }
    });
    saveConversations();
    renderSidebar();
}

// ---------------------------------------------------------------------------
// Auto-naming
// ---------------------------------------------------------------------------

function setConvIcon(convId, iconName, spinning) {
    const iconEl = document.getElementById('conv-icon-' + convId);
    if (!iconEl) return;
    iconEl.setAttribute('data-lucide', iconName);
    iconEl.classList.toggle('animate-spin', spinning === true);
    lucide.createIcons();
}

/**
 * Shared busy state for both the bulk run and a single forced rename, so the
 * two paths can never interleave against the same endpoint.
 */
function setAutoNamingState(isActive) {
    store.isAutoNaming = isActive;

    const modelBtn = document.getElementById('auto-name-model-btn');
    if (modelBtn) {
        modelBtn.disabled = isActive;
        modelBtn.classList.toggle('opacity-50', isActive);
        modelBtn.classList.toggle('cursor-not-allowed', isActive);
    }

    const btn = document.getElementById('auto-name-btn');
    if (btn) {
        btn.innerHTML = isActive
            ? '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Naming...'
            : AUTO_NAME_BTN_HTML;
    }
    lucide.createIcons();
}

// Statuses a strict OpenAI-compatible server uses to reject an unknown
// top-level field. Anything else is a real failure, not a schema complaint.
const NAMING_RETRY_STATUSES = [400, 422];
const MAX_TITLE_CHARS = 80;

function buildNamingBody(modelId, basis, withEffort) {
    const body = {
        model: modelId,
        messages: [
            { role: 'system', content: NAMING_SYSTEM_PROMPT },
            { role: 'user', content: basis }
        ],
        stream: false,
        max_tokens: AUTO_NAME_MAX_TOKENS
    };
    if (withEffort) body.reasoning_effort = AUTO_NAME_REASONING_EFFORT;
    return body;
}

function postNaming(modelId, basis, withEffort) {
    return fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildNamingBody(modelId, basis, withEffort))
    });
}

/**
 * Two attempts at most, never a loop. The reasoning_effort field is dropped
 * and the call repeated only when the server rejected the schema itself.
 */
async function postNamingRequest(modelId, basis) {
    const first = await postNaming(modelId, basis, true);
    if (first.ok || NAMING_RETRY_STATUSES.indexOf(first.status) === -1) return first;

    console.warn('Naming endpoint rejected reasoning_effort (HTTP ' + first.status + '), retrying without it.');
    return postNaming(modelId, basis, false);
}

async function postAutoFolderRequest(modelId, promptText) {
    const makeBody = (withEffort) => {
        const b = {
            model: modelId,
            messages: [
                { role: 'system', content: AUTO_FOLDER_SYSTEM_PROMPT },
                { role: 'user', content: promptText }
            ],
            stream: false,
            max_tokens: AUTO_FOLDER_MAX_TOKENS
        };
        if (withEffort) b.reasoning_effort = AUTO_NAME_REASONING_EFFORT;
        return b;
    };

    const send = (withEffort) => fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody(withEffort))
    });

    const first = await send(true);
    if (first.ok || NAMING_RETRY_STATUSES.indexOf(first.status) === -1) return first;

    console.warn('Folder endpoint rejected reasoning_effort (HTTP ' + first.status + '), retrying without it.');
    return send(false);
}

/**
 * Pulls a usable title out of a naming response.
 *
 * Inline think blocks are stripped even though reasoning_effort asked for
 * none, since not every server honours the flag. Returns '' when nothing
 * usable survives.
 */
function extractTitle(data) {
    const choice = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
    const message = (choice && choice.message) ? choice.message : null;
    const raw = (message && typeof message.content === 'string') ? message.content : '';
    if (!raw) return '';

    const clean = splitInlineThinking(raw, '', getInlineTags()).cleanContent || '';

    // Last non-empty line: a model that narrates before answering leaves the
    // title at the end, and a well-behaved one emits a single line anyway.
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return '';

    return lines[lines.length - 1]
        .replace(/^title\s*:\s*/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim()
        .slice(0, MAX_TITLE_CHARS);
}

function emptyTitleReason(data) {
    const choice = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
    if (choice && choice.finish_reason === 'length') {
        return 'the naming model used its entire token budget before writing a title.';
    }
    return 'the naming model returned an empty title.';
}

/**
 * Names one conversation from its request-plus-reply excerpt.
 * Returns { ok, reason } so the caller decides whether to surface a failure:
 * the bulk run stays quiet, an explicit user action does not.
 */
async function nameConversation(conv, modelId) {
    const basis = buildNamingBasis(conv);
    if (!basis) {
        return { ok: false, reason: 'there is no user request text to name it from.' };
    }

    setConvIcon(conv.id, 'loader-2', true);

    try {
        const res = await postNamingRequest(modelId, basis);
        if (!res.ok) {
            return { ok: false, reason: 'the naming model returned HTTP ' + res.status + '.' };
        }

        const data = await res.json();
        const title = extractTitle(data);
        if (!title) {
            return { ok: false, reason: emptyTitleReason(data) };
        }

        conv.title = title;
        conv.isAutoNamed = true;
        // Cleared so a forced rename does not permanently exclude the thread
        // from later bulk runs.
        conv.isCustomName = false;
        saveConversations();
        // The sidebar row is repainted by the caller, but the workspace header and
        // document.title are not, so they are refreshed here for the active thread.
        if (conv.id === store.activeConvId) {
            updateHeaderTitle();
        }
        return { ok: true, reason: '' };
    } catch (e) {
        console.error('Auto name failed for', conv.id, e);
        return { ok: false, reason: (e && e.message) ? e.message : 'the request failed.' };
    } finally {
        setConvIcon(conv.id, 'message-square', false);
    }
}

/**
 * Bulk-run eligibility. Marks anything with a title the user must have typed
 * as custom, so it is skipped now and on every later run.
 */
function shouldAutoName(conv) {
    if (!conv || conv.isCustomName || conv.isAutoNamed) return false;
    if (conv.title === 'New Chat') return true;

    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const firstUser = messages.find(m => m && m.role === 'user');
    if (!firstUser || typeof firstUser.content !== 'string') {
        conv.isCustomName = true;
        return false;
    }

    const sliced = firstUser.content.slice(0, 30);
    const expected = sliced + (firstUser.content.length > 30 ? '...' : '');
    if (conv.title === expected) return true;

    conv.isCustomName = true;
    return false;
}

export async function startAutoFolder() {
    if (store.isAutoNaming || store.isProcessing) return;

    const modelId = resolveAutoNameModel();
    if (!modelId) {
        alert(NO_NAMING_MODEL_MSG);
        return;
    }

    const unsortedChats = buildUnsortedChats(store.folders, store.conversations);
    if (unsortedChats.length === 0) {
        alert('No unsorted, named conversations found to organize.');
        return;
    }

    const snapshot = buildFolderSnapshot(store.folders, store.conversations);
    const promptText = buildAutoFolderPrompt(snapshot, unsortedChats);

    const btn = document.getElementById('auto-folder-btn');
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Organizing...';
        lucide.createIcons();
    }
    store.isAutoNaming = true;

    try {
        const res = await postAutoFolderRequest(modelId, promptText);
        if (!res.ok) {
            alert(`Auto Folder request failed (HTTP ${res.status}).`);
            return;
        }

        const data = await res.json();
        const rawContent = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '';
        const cleanContent = splitInlineThinking(rawContent, '', getInlineTags()).cleanContent;
        const parsed = extractJsonObject(cleanContent);

        if (!parsed) {
            alert('Failed to parse a valid folder plan from the AI response.');
            return;
        }

        const plan = resolvePlan(parsed, store.folders, unsortedChats);
        openAutoFolderModal(plan);
    } catch (e) {
        console.error('Auto Folder run failed', e);
        alert('Auto Folder failed: ' + (e && e.message ? e.message : 'Unknown error'));
    } finally {
        store.isAutoNaming = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            lucide.createIcons();
        }
    }
}

export async function startAutoNaming() {
    if (store.isAutoNaming) return;

    const modelId = resolveAutoNameModel();
    if (!modelId) {
        alert(NO_NAMING_MODEL_MSG);
        return;
    }

    setAutoNamingState(true);
    try {
        for (let i = 0; i < store.conversations.length; i++) {
            const conv = store.conversations[i];
            if (!shouldAutoName(conv)) continue;
            await nameConversation(conv, modelId);
            renderSidebar();
        }
    } finally {
        setAutoNamingState(false);
        renderSidebar();
        updateHeaderTitle();
    }
}

/**
 * Forced single-conversation rename. Deliberately skips the eligibility gate,
 * so it works on threads that were named manually or automatically before.
 */
export async function autoNameConversation(convId) {
    if (store.isAutoNaming) return;

    const conv = store.conversations.find(c => c.id === convId);
    if (!conv) return;

    const modelId = resolveAutoNameModel();
    if (!modelId) {
        alert(NO_NAMING_MODEL_MSG);
        return;
    }

    setAutoNamingState(true);
    try {
        const result = await nameConversation(conv, modelId);
        if (!result.ok) {
            alert('Could not name this thread: ' + result.reason);
        }
    } finally {
        setAutoNamingState(false);
        renderSidebar();
        updateHeaderTitle();
    }
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

export function switchToConversation(convId) {
    if (store.isProcessing) {
        alert('Please stop the current generation before switching threads.');
        return;
    }
    if (store.activeConvId === convId) return;
    store.activeConvId = convId;
    persistActiveConvId();
    renderSidebar();
    renderChat();
    updateTokenCount();
}

/**
 * Swaps the title span for an input in place. Extracted so a menu item can
 * trigger it after the popup has closed.
 */
function beginInlineRename(conv, container, titleSpan) {
    hideFolderNameChip();
    if (!container || !titleSpan || !titleSpan.isConnected) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-sm font-medium bg-gb-bgDarkest text-gb-fgLight border border-gb-blueAccent rounded px-1 outline-none w-full mr-2';
    input.value = conv.title;
    input.onclick = (ev) => ev.stopPropagation();
    input.onkeydown = (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') {
            input.value = conv.title;
            input.blur();
        }
    };
    input.onblur = () => {
        const newTitle = input.value.trim() || 'Untitled';
        if (conv.title !== newTitle) {
            conv.title = newTitle;
            conv.isCustomName = true;
            conv.isAutoNamed = false;
        }
        saveConversations();
        updateHeaderTitle();
        renderSidebar();
    };

    container.replaceChild(input, titleSpan);
    input.focus();
    input.select();
}

function buildFolderTreeOptions(parentId = null, depth = 0, excludeFolderId = null) {
    if (depth > MAX_FOLDER_DEPTH) return [];
    const children = getFolderChildren(parentId);
    const result = [];
    children.forEach(f => {
        if (excludeFolderId && (f.id === excludeFolderId || !canMoveFolder(excludeFolderId, f.id))) {
            return;
        }
        const indent = depth > 0 ? '  '.repeat(depth) + '— ' : '';
        result.push({
            id: f.id,
            name: indent + f.name,
            depth
        });
        const sub = buildFolderTreeOptions(f.id, depth + 1, excludeFolderId);
        sub.forEach(sf => result.push(sf));
    });
    return result;
}

function buildMoveMenuItems(conv, anchorEl, beginRename) {
    const items = [{
        icon: 'arrow-left',
        label: 'Back',
        onSelect: () => {
            showPopupMenu(buildConversationMenuItems(conv, anchorEl, beginRename), anchorEl);
            return 'keep-open';
        }
    }];

    const targets = [{ id: null, name: 'No Folder (Root)' }].concat(
        buildFolderTreeOptions(null, 0)
    );

    targets.forEach(target => {
        items.push({
            icon: target.id ? 'folder' : 'inbox',
            label: target.name,
            active: (conv.folderId || null) === target.id,
            onSelect: () => {
                conv.folderId = target.id;
                saveConversationToBackend(conv);
                saveIndexToBackend();
                renderSidebar();
            }
        });
    });

    return items;
}

function buildConversationMenuItems(conv, anchorEl, beginRename) {
    let nameDisabled = false;
    let nameTitle = 'Generate a title for this thread using the naming model';

    if (store.isAutoNaming) {
        nameDisabled = true;
        nameTitle = 'A naming run is already in progress';
    } else if (!resolveAutoNameModel()) {
        nameDisabled = true;
        nameTitle = 'No local or custom endpoint model is configured for naming';
    }

    return [
        {
            icon: 'sparkles',
            label: 'Name with AI',
            disabled: nameDisabled,
            title: nameTitle,
            onSelect: () => {
                autoNameConversation(conv.id);
            }
        },
        {
            icon: 'edit-2',
            label: 'Rename',
            onSelect: () => {
                beginRename();
            }
        },
        {
            icon: 'folder-input',
            label: 'Move to folder',
            onSelect: () => {
                showPopupMenu(buildMoveMenuItems(conv, anchorEl, beginRename), anchorEl);
                return 'keep-open';
            }
        },
        {
            icon: 'trash-2',
            label: 'Delete',
            danger: true,
            onSelect: () => {
                if (store.isProcessing && conv.id === store.activeConvId) {
                    alert('Please stop the current generation before deleting this thread.');
                    return;
                }
                showConfirmModal('Delete Thread', 'Are you sure you want to delete the thread "' + conv.title + '"?', () => {
                    deleteConversation(conv.id);
                });
            }
        }
    ];
}

function createConversationRow(conv, options = {}) {
    const isActive = conv.id === store.activeConvId;
    const item = document.createElement('div');
    item.className = `group flex justify-between items-center p-3 rounded-lg cursor-pointer transition-all duration-300 sidebar-item select-none ${isActive ? 'bg-gb-bgLight1 border border-gb-bgLight3 text-gb-fgLightest shadow-sm scale-[1.02]' : 'text-gb-fgDark hover:bg-gb-bgLight1/40 hover:text-gb-fgLight hover:translate-x-1'}`;

    const left = document.createElement('div');
    left.className = 'flex items-center gap-2 overflow-hidden flex-1';
    left.innerHTML = `<i id="conv-icon-${conv.id}" data-lucide="message-square" class="w-4 h-4 shrink-0 ${isActive ? 'text-gb-aquaAccent' : 'opacity-60'} transition-all"></i>`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'text-sm truncate font-medium flex-1 min-w-0';
    titleSpan.textContent = conv.title;
    left.appendChild(titleSpan);

    if (options.showFolderBadge && conv.folderId) {
        const folder = store.folders.find(f => f.id === conv.folderId);
        if (folder) {
            const badge = document.createElement('span');
            badge.className = 'text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-gb-bgDarkest text-gb-aquaAccent border border-gb-bgLight2 shrink-0 truncate max-w-[85px]';
            badge.textContent = folder.name;
            badge.title = `Folder: ${folder.name}`;
            left.appendChild(badge);
        }
    }

    item.appendChild(left);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0';

    const moreBtn = document.createElement('button');
    moreBtn.className = 'text-gb-fgDark hover:text-gb-fgLightest transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    moreBtn.innerHTML = '<i data-lucide="more-vertical" class="w-3.5 h-3.5"></i>';
    moreBtn.title = 'More options';
    moreBtn.onclick = (e) => {
        e.stopPropagation();
        const beginRename = () => beginInlineRename(conv, left, titleSpan);
        showPopupMenu(buildConversationMenuItems(conv, moreBtn, beginRename), moreBtn);
    };

    actionsDiv.appendChild(moreBtn);
    item.appendChild(actionsDiv);

    item.onclick = (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        switchToConversation(conv.id);
    };

    attachConvDrag(item, conv.id);
    attachNameReveal(item, titleSpan, conv.title);
    return item;
}

function buildFolderMenuItems(folder, anchorEl, nameSpan, leftContainer) {
    return [
        {
            icon: 'folder-plus',
            label: 'New subfolder',
            onSelect: () => {
                folder.collapsed = false;
                createNewFolder(folder.id);
            }
        },
        {
            icon: 'plus',
            label: 'New chat inside',
            onSelect: () => {
                folder.collapsed = false;
                createNewChat(folder.id);
            }
        },
        {
            icon: 'edit-2',
            label: 'Rename',
            onSelect: () => {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'text-sm font-bold bg-gb-bgDarkest text-gb-fgLight border border-gb-blueAccent rounded px-1 outline-none w-full mr-2';
                input.value = folder.name;
                input.onclick = (ev) => ev.stopPropagation();
                input.onkeydown = (ev) => {
                    if (ev.key === 'Enter') input.blur();
                    if (ev.key === 'Escape') {
                        input.value = folder.name;
                        input.blur();
                    }
                };
                input.onblur = () => {
                    folder.name = input.value.trim() || 'Untitled Folder';
                    saveConversations();
                    renderSidebar();
                };
                leftContainer.replaceChild(input, nameSpan);
                input.focus();
            }
        },
        {
            icon: 'folder-input',
            label: 'Move to folder',
            onSelect: () => {
                const targets = [{ id: null, name: 'No Folder (Root)' }].concat(
                    buildFolderTreeOptions(null, 0, folder.id)
                );
                const moveItems = [{
                    icon: 'arrow-left',
                    label: 'Back',
                    onSelect: () => {
                        showPopupMenu(buildFolderMenuItems(folder, anchorEl, nameSpan, leftContainer), anchorEl);
                        return 'keep-open';
                    }
                }];
                targets.forEach(t => {
                    moveItems.push({
                        icon: t.id ? 'folder' : 'inbox',
                        label: t.name,
                        active: (folder.parentId || null) === t.id,
                        onSelect: () => {
                            folder.parentId = t.id;
                            saveConversations();
                            renderSidebar();
                        }
                    });
                });
                showPopupMenu(moveItems, anchorEl);
                return 'keep-open';
            }
        },
        {
            icon: 'trash-2',
            label: 'Delete folder',
            danger: true,
            onSelect: () => {
                const childConvs = store.conversations.filter(c => c.folderId === folder.id).length;
                const childSubfolders = store.folders.filter(f => f.parentId === folder.id).length;
                const parts = [];
                if (childConvs > 0) parts.push(`${childConvs} conversation(s)`);
                if (childSubfolders > 0) parts.push(`${childSubfolders} subfolder(s)`);
                const desc = parts.length > 0 ? ` (${parts.join(' and ')})` : '';
                showConfirmModal(
                    'Delete Folder',
                    `Delete the folder "${folder.name}"? Its contents${desc} will be moved up one level, not deleted.`,
                    () => deleteFolder(folder.id)
                );
            }
        }
    ];
}

function createFolderRow(folder, childCount, toggleCallback) {
    const row = document.createElement('div');
    row.className = 'group folder-row flex justify-between items-center p-2 rounded-lg cursor-pointer text-gb-fgMedium hover:text-gb-fgLightest hover:bg-gb-bgLight1/50 select-none';

    const left = document.createElement('div');
    left.className = 'flex items-center gap-2 overflow-hidden flex-1';
    left.innerHTML = `<i data-lucide="chevron-right" class="folder-chevron-icon w-3.5 h-3.5 shrink-0 opacity-70 ${folder.collapsed ? '' : 'rotate-90'}"></i><span class="folder-icon-wrap flex items-center shrink-0"><i data-lucide="${folder.collapsed ? 'folder' : 'folder-open'}" class="w-4 h-4 text-gb-aquaAccent transition-colors"></i></span>`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'folder-row-label text-sm truncate font-bold';
    nameSpan.textContent = folder.name;
    // Native tooltip as the non-animated fallback (touch devices, reduced UA).
    nameSpan.title = folder.name;
    left.appendChild(nameSpan);

    const countSpan = document.createElement('span');
    countSpan.className = 'text-xs font-mono text-gb-fgDark shrink-0';
    countSpan.textContent = String(childCount);
    left.appendChild(countSpan);

    row.onclick = (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        if (toggleCallback) {
            toggleCallback();
        } else {
            folder.collapsed = !folder.collapsed;
            saveIndexToBackend();
            renderSidebar();
        }
    };
    row.appendChild(left);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0';

    const addBtn = document.createElement('button');
    addBtn.className = 'text-gb-fgDark hover:text-gb-greenAccent transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    addBtn.innerHTML = '<i data-lucide="plus" class="w-3.5 h-3.5"></i>';
    addBtn.title = 'New chat in folder';
    addBtn.onclick = (e) => {
        e.stopPropagation();
        if (store.isProcessing) {
            alert('Please stop the current generation before starting a new chat.');
            return;
        }
        folder.collapsed = false;
        createNewChat(folder.id);
    };

    const moreBtn = document.createElement('button');
    moreBtn.className = 'text-gb-fgDark hover:text-gb-fgLightest transition-all p-1 rounded hover:bg-gb-bgLight2 hover:scale-110';
    moreBtn.innerHTML = '<i data-lucide="more-vertical" class="w-3.5 h-3.5"></i>';
    moreBtn.title = 'Folder options';
    moreBtn.onclick = (e) => {
        e.stopPropagation();
        showPopupMenu(buildFolderMenuItems(folder, moreBtn, nameSpan, left), moreBtn);
    };

    actionsDiv.appendChild(addBtn);
    actionsDiv.appendChild(moreBtn);
    row.appendChild(actionsDiv);

    attachFolderDrag(row, folder.id);
    attachFolderDropTarget(row, folder.id);
    attachFolderNameReveal(row, nameSpan, folder.name);
    return row;
}

function renderFolderTree(container, parentId = null, depth = 0) {
    if (depth > MAX_FOLDER_DEPTH) return;
    const folders = getFolderChildren(parentId);

    folders.forEach(folder => {
        const childConvs = store.conversations.filter(c => c.folderId === folder.id);
        const childFolders = getFolderChildren(folder.id);
        const totalItems = childConvs.length + childFolders.length;

        const folderBlock = document.createElement('div');
        folderBlock.className = 'flex flex-col gap-0.5';

        const wrapper = document.createElement('div');
        wrapper.className = `folder-children-wrapper ${folder.collapsed ? 'collapsed' : ''}`;

        const inner = document.createElement('div');
        inner.className = 'folder-children-inner';

        const childWrap = document.createElement('div');
        childWrap.className = 'folder-children flex flex-col gap-1.5 pt-1 pb-0.5';
        attachFolderDropTarget(childWrap, folder.id);

        renderFolderTree(childWrap, folder.id, depth + 1);

        if (childConvs.length > 0) {
            childConvs.forEach(conv => childWrap.appendChild(createConversationRow(conv)));
        } else if (childFolders.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.className = 'text-xs text-gb-bgLight3 italic px-3 py-1';
            emptyHint.textContent = 'Empty';
            childWrap.appendChild(emptyHint);
        }

        inner.appendChild(childWrap);
        wrapper.appendChild(inner);

        const toggleCallback = () => {
            folder.collapsed = !folder.collapsed;
            saveIndexToBackend();

            if (folder.collapsed) {
                wrapper.classList.add('collapsed');
            } else {
                wrapper.classList.remove('collapsed');
            }

            const chev = row.querySelector('.folder-chevron-icon');
            if (chev) {
                chev.classList.toggle('rotate-90', !folder.collapsed);
            }

            const folderIconWrap = row.querySelector('.folder-icon-wrap');
            if (folderIconWrap) {
                folderIconWrap.innerHTML = `<i data-lucide="${folder.collapsed ? 'folder' : 'folder-open'}" class="w-4 h-4 text-gb-aquaAccent transition-colors"></i>`;
                lucide.createIcons({ root: folderIconWrap });
            }
        };

        const row = createFolderRow(folder, totalItems, toggleCallback);
        folderBlock.appendChild(row);
        folderBlock.appendChild(wrapper);
        container.appendChild(folderBlock);
    });
}

function updateViewModeButtons() {
    const foldersBtn = document.getElementById('view-mode-folders-btn');
    const recentBtn = document.getElementById('view-mode-recent-btn');
    const newFolderBtn = document.getElementById('new-folder-btn');
    const isRecent = store.sidebarViewMode === 'recent';

    if (foldersBtn) {
        foldersBtn.className = `flex-1 py-1.5 rounded flex items-center justify-center gap-1.5 transition-all text-xs font-semibold ${!isRecent ? 'bg-gb-blue text-gb-bgDarkest shadow-sm' : 'text-gb-fgDark hover:text-gb-fgLight'}`;
    }
    if (recentBtn) {
        recentBtn.className = `flex-1 py-1.5 rounded flex items-center justify-center gap-1.5 transition-all text-xs font-semibold ${isRecent ? 'bg-gb-blue text-gb-bgDarkest shadow-sm' : 'text-gb-fgDark hover:text-gb-fgLight'}`;
    }
    if (newFolderBtn) {
        newFolderBtn.classList.toggle('hidden', isRecent);
    }
}

function renderRecentChats(container) {
    if (store.conversations.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-xs text-gb-bgLight3 italic px-3 py-6 text-center';
        empty.textContent = 'No conversations yet';
        container.appendChild(empty);
        return;
    }

    const sorted = store.conversations.slice().sort((a, b) => getConvTimestamp(b) - getConvTimestamp(a));
    sorted.forEach(conv => {
        container.appendChild(createConversationRow(conv, { showFolderBadge: true }));
    });
}

export function renderSidebar() {
    updateViewModeButtons();
    const convList = document.getElementById('conv-list');
    if (!convList) return;
    convList.innerHTML = '';
    closePopupMenu();
    // The chip is anchored to a row that is about to be discarded.
    hideFolderNameChip();

    attachRootDropTarget(convList);

    if (store.sidebarViewMode === 'recent') {
        renderRecentChats(convList);
    } else {
        const folderIds = new Set(store.folders.map(f => f.id));
        renderFolderTree(convList, null, 0);

        // Conversations with no folder, or a dangling folderId, render at root.
        const rootConvs = store.conversations.filter(c => !c.folderId || !folderIds.has(c.folderId));
        rootConvs.forEach(conv => convList.appendChild(createConversationRow(conv)));
    }

    lucide.createIcons();
}
