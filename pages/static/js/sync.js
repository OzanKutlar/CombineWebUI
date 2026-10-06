import { store, getActiveConversation, persistActiveConvId } from './storage.js';
import { renderSidebar } from './sidebar.js';
import { renderChat, updateHeaderTitle } from './chat.js';
import { updateTokenCount } from './tokens.js';
import { renderModelMatrix, updateSelectedModelUI } from './models.js';
import { applyActiveTokenLimit } from './tokens.js';
import { applyTheme, normalizeTheme } from './theme.js';
import { STORAGE_KEY_THEME } from './config.js';

let eventSource = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

function handleConvUpdated(conv) {
    if (!conv || !conv.id) return;
    const existingIdx = store.conversations.findIndex(c => c.id === conv.id);
    
    if (existingIdx !== -1) {
        // Merge in-place
        const existing = store.conversations[existingIdx];
        const isCurrentActive = (store.activeConvId === conv.id);

        // If we are actively streaming a response in this window for this conversation, don't clobber local stream
        if (isCurrentActive && store.isProcessing) {
            existing.title = conv.title;
            existing.folderId = conv.folderId;
            renderSidebar();
            // Only the title and folder were merged, so renderChat is skipped and
            // cannot refresh the header for us.
            updateHeaderTitle();
            return;
        }

        if (JSON.stringify(existing) === JSON.stringify(conv)) {
            return;
        }

        store.conversations[existingIdx] = conv;
    } else {
        store.conversations.unshift(conv);
    }

    renderSidebar();
    if (store.activeConvId === conv.id) {
        updateHeaderTitle();
        if (!store.isProcessing) {
            renderChat(true);
            updateTokenCount();
        }
    }
}

function handleConvDeleted(data) {
    if (!data || !data.id) return;
    const convId = data.id;
    store.conversations = store.conversations.filter(c => c.id !== convId);
    
    if (store.activeConvId === convId) {
        store.activeConvId = store.conversations.length > 0 ? store.conversations[0].id : '';
        persistActiveConvId();
        renderChat();
    }
    renderSidebar();
}

function isIndexStateEqual(folders, order) {
    if (Array.isArray(folders)) {
        if (folders.length !== store.folders.length) return false;
        for (let i = 0; i < folders.length; i++) {
            const a = folders[i];
            const b = store.folders[i];
            if (!b || a.id !== b.id || a.name !== b.name || a.parentId !== b.parentId || Boolean(a.collapsed) !== Boolean(b.collapsed)) {
                return false;
            }
        }
    }
    if (Array.isArray(order)) {
        if (order.length !== store.conversations.length) return false;
        for (let i = 0; i < order.length; i++) {
            if (!store.conversations[i] || store.conversations[i].id !== order[i]) {
                return false;
            }
        }
    }
    return true;
}

function handleIndexUpdated(data) {
    if (!data) return;
    if (isIndexStateEqual(data.folders, data.order)) {
        return;
    }
    if (Array.isArray(data.folders)) {
        store.folders = data.folders;
    }
    if (Array.isArray(data.order)) {
        const orderMap = new Map();
        data.order.forEach((id, idx) => orderMap.set(id, idx));
        store.conversations.sort((a, b) => {
            const aIdx = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
            const bIdx = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;
            return aIdx - bIdx;
        });
    }
    renderSidebar();
}

function handleUIPreferencesUpdated(prefs) {
    if (!prefs || typeof prefs !== 'object') return;

    if (Array.isArray(prefs.hidden_models)) {
        store.hiddenModels = prefs.hidden_models;
    }
    if (typeof prefs.selected_model === 'string' && prefs.selected_model) {
        store.selectedModel = prefs.selected_model;
    }
    if (typeof prefs.auto_name_model === 'string') {
        store.autoNameModel = prefs.auto_name_model;
    }
    if (prefs.preserve_thinking_models && typeof prefs.preserve_thinking_models === 'object') {
        store.preserveModels = prefs.preserve_thinking_models;
    }
    if (prefs.thinking_prefs && typeof prefs.thinking_prefs === 'object') {
        store.thinkingPrefs = Object.assign({}, store.thinkingPrefs, prefs.thinking_prefs);
    }
    if (typeof prefs.theme === 'string' && prefs.theme) {
        const nextTheme = normalizeTheme(prefs.theme);
        if (store.theme !== nextTheme) {
            store.theme = nextTheme;
            try {
                localStorage.setItem(STORAGE_KEY_THEME, nextTheme);
            } catch (e) {
                console.warn('Could not cache the synced theme locally', e);
            }
            applyTheme(nextTheme);
        }
    }

    applyActiveTokenLimit();
    updateSelectedModelUI();
    renderModelMatrix();
    updateTokenCount();
}

export function initRealtimeSync() {
    if (eventSource) {
        try { eventSource.close(); } catch (e) {}
        eventSource = null;
    }

    try {
        eventSource = new EventSource('/v1/events');

        eventSource.onopen = () => {
            reconnectAttempts = 0;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        eventSource.onmessage = (e) => {
            if (!e.data || e.data.startsWith(':')) return;
            try {
                const msg = JSON.parse(e.data);
                const eventType = msg.type;
                const data = msg.data;

                switch (eventType) {
                    case 'conv_updated':
                        handleConvUpdated(data);
                        break;
                    case 'conv_deleted':
                        handleConvDeleted(data);
                        break;
                    case 'index_updated':
                        handleIndexUpdated(data);
                        break;
                    case 'ui_preferences_updated':
                        handleUIPreferencesUpdated(data);
                        break;
                    case 'history_reloaded':
                        handleIndexUpdated(data);
                        break;
                    default:
                        break;
                }
            } catch (err) {
                console.warn('Realtime event parse error:', err);
            }
        };

        eventSource.onerror = () => {
            try { eventSource.close(); } catch (e) {}
            eventSource = null;

            const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
            reconnectAttempts++;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(initRealtimeSync, delay);
        };
    } catch (err) {
        console.error('Failed to initialize EventSource:', err);
    }
}
