import { store, getActiveConversation, touchConversation } from './storage.js';
import { updateTokenCount } from './tokens.js';
import { showConfirmModal } from './modals.js';
import { saveHistory, saveConversations, renderSidebar } from './sidebar.js';
import { renderChat, triggerAPI, addModelResponse } from './chat.js';
import { getVariantCount, getActiveVariantIndex } from './messageTree.js';
import { removeBranch } from './branchOps.js';
import { handleExecutionPayload } from './execution.js';
import { restorePrunedFromIndex } from './prune.js';
import { copyTextToClipboard } from './clipboard.js';

/**
 * Only one message dropdown may be open at a time. main.js wires
 * closeActiveDropdown() to document click and Escape.
 */
let activeDropdownMenu = null;

export function closeActiveDropdown() {
    if (activeDropdownMenu) {
        activeDropdownMenu();
        activeDropdownMenu = null;
    }
}

// The implementation moved to clipboard.js so codeblock.js can share it
// without importing this module, which would tighten an existing import cycle.
// Re-exported here so every current call site keeps working unchanged.
export { copyTextToClipboard };

function blockedWhileProcessing(actionLabel) {
    if (store.isProcessing) {
        alert(`Please stop the current generation before ${actionLabel}.`);
        return true;
    }
    return false;
}

function buildCopyButton(msg) {
    const copyBtn = document.createElement('button');
    // Explicit h-8 keeps the text pill flush with the square icon buttons.
    copyBtn.className = 'h-8 px-3 text-gb-fgDark hover:text-gb-fgLightest rounded-xl hover:bg-gb-bgLight1 transition-all duration-200 active:scale-95 flex items-center justify-center gap-2 text-xs font-bold shrink-0';
    copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i> <span>Copy</span>';
    copyBtn.onclick = async () => {
        if (store.isProcessing) return;
        // Always copies the FULL untouched payload, not the trimmed display text.
        const success = await copyTextToClipboard(msg.content);
        if (!success) return;
        copyBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4 text-gb-greenAccent"></i> <span class="text-gb-greenAccent">Copied</span>';
        lucide.createIcons();
        setTimeout(() => {
            if (!copyBtn.isConnected) return;
            copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i> <span>Copy</span>';
            lucide.createIcons();
        }, 2000);
    };
    return copyBtn;
}

function buildEditButton(msg, contentDiv) {
    const editBtn = document.createElement('button');
    editBtn.className = 'w-8 h-8 text-gb-fgDark hover:text-gb-fgLightest rounded-xl hover:bg-gb-bgLight1 transition-all duration-200 active:scale-95 flex items-center justify-center shrink-0';
    editBtn.innerHTML = '<i data-lucide="pencil" class="w-4 h-4"></i>';
    editBtn.title = 'Edit';

    editBtn.onclick = () => {
        if (blockedWhileProcessing('editing messages')) return;

        const existing = contentDiv.querySelector('.edit-textarea');
        if (existing) {
            msg.content = existing.value;
            delete msg.originalContent;
            delete msg.prunedContent;
            // Stale path lists would re-prune against text that no longer
            // contains those blocks, so the whole prune state is reset.
            delete msg.manualPrunedPaths;
            delete msg.modelPrunedPaths;
            delete msg.modelPruneActive;
            // `active` was never defined in this scope, so saving an edit threw.
            const editConv = getActiveConversation();
            if (editConv) touchConversation(editConv.id);
            saveHistory();
            renderChat(true);
            updateTokenCount();
            return;
        }

        const currentText = msg.content || '';
        contentDiv.innerHTML = '';
        const editTextArea = document.createElement('textarea');
        editTextArea.className = 'edit-textarea w-full bg-gb-bg border border-gb-bgLight2 text-gb-fgLight text-sm rounded-lg focus:ring-1 focus:ring-gb-blueAccent outline-none p-4 font-mono resize-y mt-2';
        editTextArea.rows = Math.max(3, currentText.split('\n').length);
        editTextArea.value = currentText;
        contentDiv.appendChild(editTextArea);

        editBtn.innerHTML = '<i data-lucide="save" class="w-4 h-4 text-gb-greenAccent"></i>';
        editBtn.title = 'Save';
        lucide.createIcons();
    };

    return editBtn;
}

function buildRerunButton(msg, contentDiv, isUser) {
    const active = getActiveConversation();
    const history = active ? active.messages : [];
    const idx = history.indexOf(msg);
    if (idx < 0) return null;

    let cutIndex = idx;
    if (!isUser) {
        let foundUserIdx = -1;
        for (let i = idx - 1; i >= 0; i--) {
            if (history[i] && history[i].role === 'user') {
                foundUserIdx = i;
                break;
            }
        }
        if (foundUserIdx === -1) return null;
        cutIndex = foundUserIdx;
    }

    const rerunBtn = document.createElement('button');
    rerunBtn.className = 'w-8 h-8 text-gb-fgDark hover:text-gb-blueAccent rounded-xl hover:bg-gb-bgLight1 transition-all duration-200 active:scale-95 flex items-center justify-center shrink-0';
    rerunBtn.innerHTML = '<i data-lucide="sparkles" class="w-4 h-4"></i>';
    rerunBtn.title = isUser ? 'Re-run' : 'Add another response from this model';

    if (!isUser) {
        // Non-destructive: the new reply becomes a sibling tab on this turn.
        rerunBtn.onclick = () => {
            if (blockedWhileProcessing('re-running')) return;
            const currentActive = getActiveConversation();
            if (!currentActive) return;
            const slotIndex = currentActive.messages.indexOf(msg);
            if (slotIndex < 0) return;
            const modelId = msg.model || store.selectedModel;
            addModelResponse(slotIndex, modelId).catch(e => console.error('Failed to add a response', e));
        };
        return rerunBtn;
    }

    rerunBtn.onclick = () => {
        if (blockedWhileProcessing('re-running')) return;
        const currentActive = getActiveConversation();
        if (!currentActive) return;

        if (isUser) {
            // Commit any in-flight edit so the re-run uses what the user sees.
            const editTextArea = contentDiv.querySelector('.edit-textarea');
            if (editTextArea) {
                msg.content = editTextArea.value;
                delete msg.originalContent;
                delete msg.prunedContent;
                delete msg.manualPrunedPaths;
                delete msg.modelPrunedPaths;
                delete msg.modelPruneActive;
            }
        }

        const modalTitle = isUser ? 'Re-run Prompt' : 'Re-run Response';
        const modalMsg = isUser
            ? 'Re-running this prompt will permanently discard all subsequent messages in this thread. Proceed?'
            : 'Re-running this response will discard it and all subsequent messages in this thread. Proceed?';

        showConfirmModal(modalTitle, modalMsg, () => {
            restorePrunedFromIndex(currentActive.messages, cutIndex);
            currentActive.messages = currentActive.messages.slice(0, cutIndex + 1);
            touchConversation(currentActive.id);
            saveHistory();
            renderChat(true);
            triggerAPI();
        });
    };

    return rerunBtn;
}

function buildParseAgainButton(msg, closeMenu) {
    const parseBtn = document.createElement('button');
    parseBtn.className = 'w-full text-left px-4 py-2.5 text-sm hover:bg-gb-bgLight1 active:bg-gb-bgLight2 flex items-center gap-3 text-gb-fgLight transition-colors';
    parseBtn.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i> Parse Again';

    parseBtn.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        if (blockedWhileProcessing('parsing messages')) return;

        const active = getActiveConversation();
        if (!active) return;
        
        delete msg.executionInfo;
        handleExecutionPayload(msg, active.messages);
        // Dropping the cache makes the next render re-read SELECT payloads once.
        delete msg.selectInfo;
        
        saveHistory();
        renderChat(true);
    };

    return parseBtn;
}

function buildCopyThinkingButton(msg, closeMenu) {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left px-4 py-2.5 text-sm hover:bg-gb-bgLight1 active:bg-gb-bgLight2 flex items-center gap-3 text-gb-fgLight transition-colors';
    btn.innerHTML = '<i data-lucide="brain" class="w-4 h-4"></i> Copy thinking';

    btn.onclick = async (e) => {
        e.stopPropagation();
        closeMenu();
        await copyTextToClipboard(msg.reasoning || '');
    };

    return btn;
}

function buildBranchButton(msg, closeMenu) {
    const branchBtn = document.createElement('button');
    branchBtn.className = 'w-full text-left px-4 py-2.5 text-sm hover:bg-gb-bgLight1 active:bg-gb-bgLight2 flex items-center gap-3 text-gb-fgLight transition-colors';
    branchBtn.innerHTML = '<i data-lucide="git-branch" class="w-4 h-4"></i> Branch';

    branchBtn.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        if (blockedWhileProcessing('branching')) return;

        const active = getActiveConversation();
        if (!active) return;
        const idx = active.messages.indexOf(msg);
        if (idx < 0) return;

        const branchedMessages = JSON.parse(JSON.stringify(active.messages.slice(0, idx + 1)));
        const id = 'conv_' + Date.now();
        const now = Date.now();
        store.conversations.unshift({
            id,
            title: active.title + ' (Branch)',
            isCustomName: active.isCustomName,
            isAutoNamed: active.isAutoNamed,
            // Keep the branch beside its parent in the sidebar tree.
            folderId: active.folderId || null,
            messages: branchedMessages,
            updatedAt: now
        });
        store.activeConvId = id;
        saveConversations();
        renderSidebar();
        renderChat();
        updateTokenCount();
    };

    return branchBtn;
}

function buildDeleteButton(msg, closeMenu) {
    const delBtn = document.createElement('button');
    delBtn.className = 'w-full text-left px-4 py-2.5 text-sm hover:bg-gb-bgLight1 active:bg-gb-bgLight2 flex items-center gap-3 text-gb-redAccent transition-colors rounded-b-xl';
    const isAssistant = msg.role === 'assistant';
    const isSibling = isAssistant && getVariantCount(msg) > 1;
    delBtn.innerHTML = `<i data-lucide="trash-2" class="w-4 h-4"></i> ${isSibling ? 'Delete response' : 'Delete'}`;

    delBtn.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        if (blockedWhileProcessing('deleting messages')) return;

        const title = isSibling ? 'Delete Response' : 'Delete Message';
        const text = isSibling
            ? 'Delete this model response? The other responses for this turn are kept, but anything that followed this one is removed with it.'
            : 'Are you sure you want to delete this specific message from the history?';

        showConfirmModal(title, text, () => {
            const active = getActiveConversation();
            if (!active) return;
            const idx = active.messages.indexOf(msg);
            if (idx < 0) return;
            if (isAssistant) {
                // Removes only the shown response; the turn goes with its last one.
                removeBranch(active, idx, getActiveVariantIndex(msg));
            } else {
                active.messages.splice(idx, 1);
            }
            saveHistory();
            renderChat(true);
            updateTokenCount();
        });
    };

    return delBtn;
}

function wireDropdown(wrapper, moreBtn, dropdown) {
    function closeMenu() {
        const isUpward = dropdown.classList.contains('bottom-full');

        dropdown.classList.remove('opacity-100', 'scale-100', 'pointer-events-auto', 'translate-y-0');
        dropdown.classList.add('opacity-0', 'scale-95', 'pointer-events-none');
        
        if (isUpward) {
            dropdown.classList.add('translate-y-2');
        } else {
            dropdown.classList.add('-translate-y-2');
        }
        
        wrapper.classList.remove('menu-open');

        const moreIcon = moreBtn.querySelector('.icon-more');
        const arrowIcon = moreBtn.querySelector('.icon-arrow');
        if (moreIcon) moreIcon.classList.remove('rotate-90', 'opacity-0', 'scale-50');
        if (arrowIcon) {
            arrowIcon.classList.add('-rotate-90', 'opacity-0', 'scale-50');
            arrowIcon.classList.remove('rotate-0', 'opacity-100', 'scale-100');
        }
    }

    function openMenu() {
        closeActiveDropdown();
        wrapper.classList.add('menu-open');
        activeDropdownMenu = closeMenu;

        // Flip upward when the viewport cannot fit the menu below the button.
        const rect = moreBtn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const needSpace = dropdown.children.length * 40 + 20;

        if (spaceBelow < needSpace && rect.top > needSpace) {
            dropdown.classList.add('bottom-full', 'mb-3', 'origin-bottom-right', 'translate-y-2');
            dropdown.classList.remove('origin-top-right', '-translate-y-2');
        } else {
            dropdown.classList.add('top-full', 'mt-3', 'origin-top-right');
            dropdown.classList.remove('-translate-y-2');
        }

        // Force reflow so the transform transition actually plays.
        void dropdown.offsetWidth;

        dropdown.classList.remove('opacity-0', 'scale-95', 'pointer-events-none', 'translate-y-2', '-translate-y-2');
        dropdown.classList.add('opacity-100', 'scale-100', 'pointer-events-auto', 'translate-y-0');

        const moreIcon = moreBtn.querySelector('.icon-more');
        const arrowIcon = moreBtn.querySelector('.icon-arrow');
        if (moreIcon) moreIcon.classList.add('rotate-90', 'opacity-0', 'scale-50');
        if (arrowIcon) {
            arrowIcon.classList.remove('-rotate-90', 'opacity-0', 'scale-50');
            arrowIcon.classList.add('rotate-0', 'opacity-100', 'scale-100');
        }
    }

    moreBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = !dropdown.classList.contains('opacity-0');
        if (isOpen) closeMenu();
        else openMenu();
    };

    return closeMenu;
}

/**
 * Floating pill pinned to the top-right of a message. Reveals on hover of the
 * parent `.group` element and stays pinned while the message scrolls.
 */
export function createActionBar(msg, index, isUser, isError, contentDiv) {
    const wrapper = document.createElement('div');
    // items-start stops the h-0 flex wrapper from vertically squishing the pill.
    wrapper.className = 'msg-action-wrapper sticky top-4 z-20 w-full flex justify-end items-start h-0 pointer-events-none select-none';

    const bar = document.createElement('div');
    bar.className = 'msg-action-bar pointer-events-none group-hover:pointer-events-auto focus-within:pointer-events-auto flex items-center gap-1 bg-gb-bgDarkest/95 backdrop-blur-sm border border-gb-bgLight2 rounded-2xl p-1.5 shadow-xl opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-all duration-300 ease-in-out relative transform translate-y-[-16px] right-2';

    if (!isError && (msg.content || msg.role === 'assistant')) {
        bar.appendChild(buildCopyButton(msg));
    }

    bar.appendChild(buildEditButton(msg, contentDiv));

    const rerunBtn = buildRerunButton(msg, contentDiv, isUser);
    if (rerunBtn) {
        bar.appendChild(rerunBtn);
    }

    const moreBtn = document.createElement('button');
    moreBtn.className = 'w-8 h-8 text-gb-fgDark hover:text-gb-fgLightest rounded-xl hover:bg-gb-bgLight1 transition-all duration-200 active:scale-95 flex items-center justify-center relative shrink-0';
    moreBtn.title = 'More options';
    moreBtn.innerHTML = '<i data-lucide="more-vertical" class="w-4 h-4 absolute inset-0 m-auto transition-all duration-300 transform origin-center icon-more"></i><i data-lucide="chevron-down" class="w-4 h-4 absolute inset-0 m-auto transition-all duration-300 transform origin-center -rotate-90 opacity-0 scale-50 icon-arrow"></i>';

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute right-0 w-48 bg-gb-bgDarkest border border-gb-bgLight2 rounded-xl shadow-2xl flex flex-col py-1.5 z-30 transition-all duration-200 transform opacity-0 scale-95 pointer-events-none -translate-y-2 origin-top-right';

    const closeMenu = wireDropdown(wrapper, moreBtn, dropdown);
    
    if (!isUser && !isError) {
        dropdown.appendChild(buildParseAgainButton(msg, closeMenu));
    }
    
    if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) {
        dropdown.appendChild(buildCopyThinkingButton(msg, closeMenu));
    }
    dropdown.appendChild(buildBranchButton(msg, closeMenu));
    dropdown.appendChild(buildDeleteButton(msg, closeMenu));

    bar.appendChild(moreBtn);
    bar.appendChild(dropdown);
    wrapper.appendChild(bar);

    return wrapper;
}
