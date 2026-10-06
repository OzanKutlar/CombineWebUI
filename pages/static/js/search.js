import { store, getFolderAncestors } from './storage.js';
import { parseSearchQuery, testSearchMatch, extractSearchSnippets } from './searchQuery.js';
import { parseCombineCopyPrompt } from './promptParser.js';
import { switchToConversation } from './sidebar.js';
import { scrollToMessage } from './chatNav.js';

const MAX_DEEP_CONVS = 1000;
const MAX_MSG_CHARS_TO_SCAN = 50000;
const MAX_SNIPPETS_PER_CONV = 4;

const searchState = {
    rawQuery: '',
    mode: 'titles', // 'titles' | 'deep'
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    includeScaffolding: false,
    includeThinking: false,
    isSearching: false,
    deepResults: []
};

function el(id) {
    return document.getElementById(id);
}

export function isSearchModalOpen() {
    const modal = el('search-modal');
    return modal && !modal.classList.contains('opacity-0');
}

export function openSearchModal() {
    const modal = el('search-modal');
    const box = el('search-modal-box');
    const input = el('search-input');
    if (!modal || !box) return;

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');

    if (input) {
        setTimeout(() => {
            input.focus();
            input.select();
        }, 60);
    }
    renderSearchResults();
}

export function closeSearchModal() {
    const modal = el('search-modal');
    const box = el('search-modal-box');
    if (!modal || !box) return;

    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
}

function getFolderBreadcrumb(folderId) {
    if (!folderId) return '';
    const ancestors = getFolderAncestors(folderId);
    const allIds = [...ancestors.reverse(), folderId];
    const names = [];
    allIds.forEach(id => {
        const f = store.folders.find(folder => folder.id === id);
        if (f) names.push(f.name);
    });
    return names.join(' / ');
}

function getSearchableMessageText(msg, includeScaffolding, includeThinking) {
    if (!msg) return '';
    let text = '';

    if (msg.role === 'user') {
        if (includeScaffolding) {
            text = msg.content || '';
        } else {
            const parsed = parseCombineCopyPrompt(msg.content || '');
            text = parsed.isStructured ? (parsed.userRequest || '') : (msg.content || '');
        }
    } else {
        text = msg.content || '';
        if (includeThinking && typeof msg.reasoning === 'string') {
            text += '\n' + msg.reasoning;
        }
    }

    return text.slice(0, MAX_MSG_CHARS_TO_SCAN);
}

function runTitleSearch(parsedQuery) {
    const results = [];
    const convs = store.conversations || [];

    convs.forEach(c => {
        const title = c.title || 'Untitled';
        if (testSearchMatch(title, parsedQuery)) {
            results.push({
                id: c.id,
                title,
                folderPath: getFolderBreadcrumb(c.folderId),
                messageCount: Array.isArray(c.messages) ? c.messages.length : 0
            });
        }
    });

    return results;
}

function runDeepContentSearch(parsedQuery) {
    const results = [];
    const convs = store.conversations.slice(0, MAX_DEEP_CONVS);

    convs.forEach(c => {
        const title = c.title || 'Untitled';
        const messages = Array.isArray(c.messages) ? c.messages : [];
        const matchedSnippets = [];

        for (let idx = 0; idx < messages.length && matchedSnippets.length < MAX_SNIPPETS_PER_CONV; idx++) {
            const msg = messages[idx];
            const textToScan = getSearchableMessageText(msg, searchState.includeScaffolding, searchState.includeThinking);
            if (testSearchMatch(textToScan, parsedQuery)) {
                const snips = extractSearchSnippets(textToScan, parsedQuery, 2, 45);
                snips.forEach(s => {
                    matchedSnippets.push({
                        messageIndex: idx,
                        role: msg.role,
                        snippet: s
                    });
                });
            }
        }

        if (matchedSnippets.length > 0 || testSearchMatch(title, parsedQuery)) {
            results.push({
                id: c.id,
                title,
                folderPath: getFolderBreadcrumb(c.folderId),
                messageCount: messages.length,
                snippets: matchedSnippets
            });
        }
    });

    return results;
}

export function renderSearchResults() {
    const container = el('search-results-list');
    const statusEl = el('search-status-bar');
    const deepBtn = el('search-deep-btn');
    const errorEl = el('search-error-banner');
    if (!container) return;

    container.innerHTML = '';
    if (errorEl) errorEl.classList.add('hidden');

    const q = searchState.rawQuery.trim();
    if (!q) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-16 text-gb-fgDark gap-3">
                <i data-lucide="search" class="w-10 h-10 opacity-40"></i>
                <span class="text-sm font-semibold">Search chat names or deep message content</span>
                <span class="text-xs text-gb-bgLight3">Type keywords, "exact phrases", or -exclusions</span>
            </div>
        `;
        if (statusEl) statusEl.textContent = 'Ready';
        if (deepBtn) {
            deepBtn.disabled = true;
            deepBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
        lucide.createIcons();
        return;
    }

    const parsed = parseSearchQuery(q, {
        caseSensitive: searchState.caseSensitive,
        wholeWord: searchState.wholeWord,
        isRegex: searchState.isRegex
    });

    if (!parsed.valid) {
        if (errorEl && parsed.error) {
            errorEl.textContent = parsed.error;
            errorEl.classList.remove('hidden');
        }
        if (statusEl) statusEl.textContent = 'Invalid query';
        return;
    }

    if (deepBtn) {
        deepBtn.disabled = false;
        deepBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    if (searchState.mode === 'titles') {
        const titleHits = runTitleSearch(parsed);
        if (statusEl) {
            statusEl.textContent = `${titleHits.length} chat title${titleHits.length === 1 ? '' : 's'} found &middot; Press Deep Search to scan messages`;
        }

        if (titleHits.length === 0) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-gb-fgDark gap-2 text-center">
                    <span class="text-sm font-semibold">No chat titles matched "${q}"</span>
                    <span class="text-xs text-gb-bgLight3">Click <b>Deep Search</b> below to scan conversation contents.</span>
                </div>
            `;
        } else {
            titleHits.forEach(hit => {
                const row = document.createElement('div');
                row.className = 'group p-3 rounded-lg bg-gb-bgDarkest hover:bg-gb-bgLight1 border border-gb-bgLight2 hover:border-gb-blueAccent transition-all cursor-pointer flex items-center justify-between gap-3';
                
                const left = document.createElement('div');
                left.className = 'flex items-center gap-2.5 min-w-0 flex-1';
                left.innerHTML = `<i data-lucide="message-square" class="w-4 h-4 text-gb-aquaAccent shrink-0"></i><div class="flex flex-col min-w-0"><span class="text-sm font-bold text-gb-fgLight group-hover:text-gb-fgLightest truncate title-label"></span>${hit.folderPath ? `<span class="text-[11px] font-mono text-gb-fgDark truncate">${hit.folderPath}</span>` : ''}</div>`;
                left.querySelector('.title-label').textContent = hit.title;
                row.appendChild(left);

                const right = document.createElement('span');
                right.className = 'text-xs font-mono text-gb-fgDark shrink-0';
                right.textContent = `${hit.messageCount} msg${hit.messageCount === 1 ? '' : 's'}`;
                row.appendChild(right);

                row.onclick = () => {
                    switchToConversation(hit.id);
                    closeSearchModal();
                };
                container.appendChild(row);
            });
        }
    } else {
        // Deep search mode
        const deepHits = runDeepContentSearch(parsed);
        if (statusEl) {
            statusEl.textContent = `${deepHits.length} thread${deepHits.length === 1 ? '' : 's'} matched in deep search`;
        }

        if (deepHits.length === 0) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-gb-fgDark gap-2 text-center">
                    <span class="text-sm font-semibold">No message contents matched your query.</span>
                    <span class="text-xs text-gb-bgLight3">Try enabling "Include Scaffolding" or loosening phrase requirements.</span>
                </div>
            `;
        } else {
            deepHits.forEach(hit => {
                const card = document.createElement('div');
                card.className = 'p-3 rounded-lg bg-gb-bgDarkest border border-gb-bgLight2 flex flex-col gap-2 transition-all';

                const head = document.createElement('div');
                head.className = 'flex items-center justify-between gap-2 border-b border-gb-bgLight2 pb-2 cursor-pointer group';
                head.innerHTML = `
                    <div class="flex items-center gap-2 min-w-0">
                        <i data-lucide="message-square" class="w-4 h-4 text-gb-blueAccent shrink-0"></i>
                        <span class="text-sm font-bold text-gb-fgLight group-hover:text-gb-fgLightest truncate chat-title-span"></span>
                        ${hit.folderPath ? `<span class="text-[10px] font-mono text-gb-fgDark bg-gb-bgLight1 px-1.5 py-0.5 rounded truncate">${hit.folderPath}</span>` : ''}
                    </div>
                    <span class="text-xs font-mono text-gb-fgDark shrink-0 group-hover:text-gb-blueAccent">Open chat &rarr;</span>
                `;
                head.querySelector('.chat-title-span').textContent = hit.title;
                head.onclick = () => {
                    switchToConversation(hit.id);
                    closeSearchModal();
                };
                card.appendChild(head);

                if (Array.isArray(hit.snippets) && hit.snippets.length > 0) {
                    const snipList = document.createElement('div');
                    snipList.className = 'flex flex-col gap-1.5 pl-3 border-l-2 border-gb-bgLight2 pt-1';

                    hit.snippets.forEach(snipObj => {
                        const sRow = document.createElement('div');
                        sRow.className = 'p-2 rounded bg-gb-bg hover:bg-gb-bgLight1 border border-gb-bgLight3 cursor-pointer text-xs font-mono text-gb-fgLight flex flex-col gap-1 transition-colors';
                        
                        const roleLabel = snipObj.role === 'user' ? 'User Request' : 'Assistant Output';
                        const roleColor = snipObj.role === 'user' ? 'text-gb-blueAccent' : 'text-gb-aquaAccent';
                        
                        sRow.innerHTML = `
                            <div class="flex items-center justify-between text-[10.5px] text-gb-fgDark">
                                <span class="font-bold ${roleColor}">${roleLabel}</span>
                                <span>Msg #${snipObj.messageIndex + 1}</span>
                            </div>
                            <div class="leading-relaxed text-gb-fgMedium search-snip-body">
                                ${snipObj.snippet.prefix}${escapeHtml(snipObj.snippet.before)}<mark class="search-highlight">${escapeHtml(snipObj.snippet.match)}</mark>${escapeHtml(snipObj.snippet.after)}${snipObj.snippet.suffix}
                            </div>
                        `;

                        sRow.onclick = (e) => {
                            e.stopPropagation();
                            switchToConversation(hit.id);
                            closeSearchModal();
                            setTimeout(() => {
                                scrollToMessage(snipObj.messageIndex);
                            }, 120);
                        };
                        snipList.appendChild(sRow);
                    });
                    card.appendChild(snipList);
                }

                container.appendChild(card);
            });
        }
    }

    lucide.createIcons();
}

function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function wireSearchModal() {
    const openBtn = el('search-chats-btn');
    const closeBtn = el('close-search-modal-btn');
    const modal = el('search-modal');
    const input = el('search-input');
    const deepBtn = el('search-deep-btn');
    const titlesTabBtn = el('search-tab-titles');
    const deepTabBtn = el('search-tab-deep');

    if (openBtn) openBtn.onclick = openSearchModal;
    if (closeBtn) closeBtn.onclick = closeSearchModal;
    if (modal) {
        modal.onclick = (e) => {
            if (e.target === modal) closeSearchModal();
        };
    }

    if (input) {
        input.addEventListener('input', (e) => {
            searchState.rawQuery = e.target.value || '';
            renderSearchResults();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (searchState.mode === 'titles') {
                    searchState.mode = 'deep';
                    updateTabUI();
                    renderSearchResults();
                }
            }
        });
    }

    const updateTabUI = () => {
        if (titlesTabBtn) {
            titlesTabBtn.classList.toggle('bg-gb-blue', searchState.mode === 'titles');
            titlesTabBtn.classList.toggle('text-gb-bgDarkest', searchState.mode === 'titles');
            titlesTabBtn.classList.toggle('bg-gb-bgLight1', searchState.mode !== 'titles');
            titlesTabBtn.classList.toggle('text-gb-fgLight', searchState.mode !== 'titles');
        }
        if (deepTabBtn) {
            deepTabBtn.classList.toggle('bg-gb-blue', searchState.mode === 'deep');
            deepTabBtn.classList.toggle('text-gb-bgDarkest', searchState.mode === 'deep');
            deepTabBtn.classList.toggle('bg-gb-bgLight1', searchState.mode !== 'deep');
            deepTabBtn.classList.toggle('text-gb-fgLight', searchState.mode !== 'deep');
        }
    };

    if (titlesTabBtn) {
        titlesTabBtn.onclick = () => {
            searchState.mode = 'titles';
            updateTabUI();
            renderSearchResults();
        };
    }
    if (deepTabBtn) {
        deepTabBtn.onclick = () => {
            searchState.mode = 'deep';
            updateTabUI();
            renderSearchResults();
        };
    }

    if (deepBtn) {
        deepBtn.onclick = () => {
            searchState.mode = 'deep';
            updateTabUI();
            renderSearchResults();
        };
    }

    // Option checkboxes
    const caseCheck = el('search-opt-case');
    const wordCheck = el('search-opt-word');
    const regexCheck = el('search-opt-regex');
    const scaffCheck = el('search-opt-scaffolding');
    const thinkCheck = el('search-opt-thinking');

    if (caseCheck) {
        caseCheck.onchange = (e) => {
            searchState.caseSensitive = e.target.checked;
            renderSearchResults();
        };
    }
    if (wordCheck) {
        wordCheck.onchange = (e) => {
            searchState.wholeWord = e.target.checked;
            renderSearchResults();
        };
    }
    if (regexCheck) {
        regexCheck.onchange = (e) => {
            searchState.isRegex = e.target.checked;
            renderSearchResults();
        };
    }
    if (scaffCheck) {
        scaffCheck.onchange = (e) => {
            searchState.includeScaffolding = e.target.checked;
            if (searchState.mode === 'deep') renderSearchResults();
        };
    }
    if (thinkCheck) {
        thinkCheck.onchange = (e) => {
            searchState.includeThinking = e.target.checked;
            if (searchState.mode === 'deep') renderSearchResults();
        };
    }

    // Global shortcut: Ctrl+K or Cmd+K
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (isSearchModalOpen()) {
                closeSearchModal();
            } else {
                openSearchModal();
            }
        }
    });
}
