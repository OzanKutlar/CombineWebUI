import {
    STORAGE_KEY_CONVS,
    STORAGE_KEY_ACTIVE,
    STORAGE_KEY_MODEL,
    STORAGE_KEY_AUTONAME_MODEL,
    STORAGE_KEY_HIDDEN,
    STORAGE_KEY_SIDEBAR_VIEW_MODE,
    DEFAULT_TOKEN_LIMIT,
    MODEL_LIMITS_DB_NAME,
    MODEL_LIMITS_DB_VERSION,
    MODEL_LIMITS_STORE,
    CHAT_DB_NAME,
    CHAT_DB_VERSION,
    CHAT_STORE,
    STORAGE_KEY_THINKING_PREFS,
    STORAGE_KEY_PRESERVE_MODELS,
    STORAGE_KEY_THEME,
    DEFAULT_THEME,
    DEFAULT_THINKING_PREFS,
    MAX_FOLDER_DEPTH
} from './config.js';

function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
        return fallback;
    }
}

function loadThinkingPrefs() {
    const raw = safeParse(localStorage.getItem(STORAGE_KEY_THINKING_PREFS), {});
    const prefs = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
        show: typeof prefs.show === 'boolean' ? prefs.show : DEFAULT_THINKING_PREFS.show,
        autoExpand: typeof prefs.autoExpand === 'boolean' ? prefs.autoExpand : DEFAULT_THINKING_PREFS.autoExpand,
        // An empty array is a deliberate "off", so it is preserved. Only an
        // absent or malformed value falls back to the defaults.
        inlineTags: Array.isArray(prefs.inlineTags)
            ? prefs.inlineTags.slice()
            : DEFAULT_THINKING_PREFS.inlineTags.slice()
    };
}

function loadPreserveModels() {
    const raw = safeParse(localStorage.getItem(STORAGE_KEY_PRESERVE_MODELS), {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
}

export const store = {
    conversations: [],
    folders: [],
    activeConvId: localStorage.getItem(STORAGE_KEY_ACTIVE) || '',
    sidebarViewMode: localStorage.getItem(STORAGE_KEY_SIDEBAR_VIEW_MODE) || 'folders',
    theme: localStorage.getItem(STORAGE_KEY_THEME) || DEFAULT_THEME,
    selectedModel: localStorage.getItem(STORAGE_KEY_MODEL) || '',
    autoNameModel: localStorage.getItem(STORAGE_KEY_AUTONAME_MODEL) || '',
    hiddenModels: safeParse(localStorage.getItem(STORAGE_KEY_HIDDEN), []),
    thinkingPrefs: loadThinkingPrefs(),
    preserveModels: loadPreserveModels(),
    allModels: [],
    allProviders: [],
    isProcessing: false,
    isAutoNaming: false,
    currentAbortController: null,
    modelLimitsDb: null,
    chatDb: null,
    modelTokenLimits: {},
    activeTokenLimit: DEFAULT_TOKEN_LIMIT
};

export function getActiveConversation() {
    return store.conversations.find(c => c.id === store.activeConvId) || null;
}

let uiPrefSaveTimeout = null;

export function saveUIPreferencesToBackend() {
    if (uiPrefSaveTimeout) clearTimeout(uiPrefSaveTimeout);
    uiPrefSaveTimeout = setTimeout(() => {
        uiPrefSaveTimeout = null;
        const payload = {
            hidden_models: store.hiddenModels,
            selected_model: store.selectedModel,
            auto_name_model: store.autoNameModel,
            preserve_thinking_models: store.preserveModels,
            thinking_prefs: store.thinkingPrefs,
            theme: store.theme
        };
        fetch('/v1/ui_preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(e => console.warn('Failed to sync UI preferences to backend', e));
    }, 300);
}

export async function syncUIPreferencesFromBackend() {
    try {
        const res = await fetch('/v1/ui_preferences');
        if (!res.ok) return;
        const prefs = await res.json();
        if (!prefs || typeof prefs !== 'object') return;

        if (Array.isArray(prefs.hidden_models)) {
            store.hiddenModels = prefs.hidden_models;
            localStorage.setItem(STORAGE_KEY_HIDDEN, JSON.stringify(store.hiddenModels));
        }
        if (typeof prefs.selected_model === 'string' && prefs.selected_model) {
            store.selectedModel = prefs.selected_model;
            localStorage.setItem(STORAGE_KEY_MODEL, store.selectedModel);
        }
        if (typeof prefs.auto_name_model === 'string') {
            store.autoNameModel = prefs.auto_name_model;
            localStorage.setItem(STORAGE_KEY_AUTONAME_MODEL, store.autoNameModel);
        }
        if (prefs.preserve_thinking_models && typeof prefs.preserve_thinking_models === 'object') {
            store.preserveModels = prefs.preserve_thinking_models;
            localStorage.setItem(STORAGE_KEY_PRESERVE_MODELS, JSON.stringify(store.preserveModels));
        }
        if (prefs.thinking_prefs && typeof prefs.thinking_prefs === 'object') {
            store.thinkingPrefs = Object.assign({}, DEFAULT_THINKING_PREFS, prefs.thinking_prefs);
            localStorage.setItem(STORAGE_KEY_THINKING_PREFS, JSON.stringify(store.thinkingPrefs));
        }
        // Only cached here. main.js re-applies it once this resolves, which
        // keeps theme.js out of this module's import graph and avoids a cycle.
        if (typeof prefs.theme === 'string' && prefs.theme) {
            store.theme = prefs.theme;
            localStorage.setItem(STORAGE_KEY_THEME, store.theme);
        }
    } catch (e) {
        console.warn('Could not load remote UI preferences, using local cache', e);
    }
}

export function persistActiveConvId() {
    localStorage.setItem(STORAGE_KEY_ACTIVE, store.activeConvId);
}

export function persistSidebarViewMode() {
    localStorage.setItem(STORAGE_KEY_SIDEBAR_VIEW_MODE, store.sidebarViewMode || 'folders');
}

export function getConvTimestamp(conv) {
    if (!conv) return 0;
    if (typeof conv.updatedAt === 'number' && !isNaN(conv.updatedAt)) {
        return conv.updatedAt;
    }
    if (typeof conv.id === 'string' && conv.id.startsWith('conv_')) {
        const numPart = parseInt(conv.id.slice(5).split('_')[0], 10);
        if (!isNaN(numPart) && numPart > 0) return numPart;
    }
    return 0;
}

export function touchConversation(convId) {
    if (!convId) return;
    const conv = store.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.updatedAt = Date.now();

    const idx = store.conversations.indexOf(conv);
    if (idx > 0) {
        store.conversations.splice(idx, 1);
        store.conversations.unshift(conv);
        saveIndexToBackend();
    }
    saveConversationToBackend(conv);
}

export function persistSelectedModel() {
    localStorage.setItem(STORAGE_KEY_MODEL, store.selectedModel);
    saveUIPreferencesToBackend();
}

export function persistHiddenModels() {
    localStorage.setItem(STORAGE_KEY_HIDDEN, JSON.stringify(store.hiddenModels));
    saveUIPreferencesToBackend();
}

export function persistAutoNameModel() {
    localStorage.setItem(STORAGE_KEY_AUTONAME_MODEL, store.autoNameModel || '');
    saveUIPreferencesToBackend();
}

export function persistTheme() {
    localStorage.setItem(STORAGE_KEY_THEME, store.theme || DEFAULT_THEME);
    saveUIPreferencesToBackend();
}

export function persistThinkingPrefs() {
    localStorage.setItem(STORAGE_KEY_THINKING_PREFS, JSON.stringify(store.thinkingPrefs));
    saveUIPreferencesToBackend();
}

export function persistPreserveModels() {
    localStorage.setItem(STORAGE_KEY_PRESERVE_MODELS, JSON.stringify(store.preserveModels));
    saveUIPreferencesToBackend();
}

/** Absent key means off, so preservation is opt-in without seeding defaults. */
export function isPreserveEnabled(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    return store.preserveModels[modelId] === true;
}

export function setPreserveEnabled(modelId, enabled) {
    if (!modelId || typeof modelId !== 'string') return;
    if (enabled) {
        store.preserveModels[modelId] = true;
    } else {
        delete store.preserveModels[modelId];
    }
    persistPreserveModels();
}

// ---------------------------------------------------------------------------
// Folder tree helpers
// ---------------------------------------------------------------------------

export function getFolderChildren(parentId = null) {
    const pId = parentId || null;
    return store.folders.filter(f => (f.parentId || null) === pId);
}

export function getFolderAncestors(folderId) {
    const ancestors = [];
    let current = store.folders.find(f => f.id === folderId);
    let guard = 0;
    while (current && current.parentId && guard < MAX_FOLDER_DEPTH) {
        ancestors.push(current.parentId);
        current = store.folders.find(f => f.id === current.parentId);
        guard++;
    }
    return ancestors;
}

export function isDescendantFolder(candidateId, ancestorId) {
    if (!candidateId || !ancestorId) return false;
    if (candidateId === ancestorId) return true;
    const ancestors = getFolderAncestors(candidateId);
    return ancestors.includes(ancestorId);
}

export function canMoveFolder(folderId, targetParentId) {
    if (!folderId) return false;
    const target = targetParentId || null;
    if (folderId === target) return false;
    if (target && isDescendantFolder(target, folderId)) return false;
    return true;
}

export function sanitizeFolders(folders) {
    if (!Array.isArray(folders)) return [];
    const folderMap = new Map();
    folders.forEach(f => {
        if (f && typeof f.id === 'string' && f.id) {
            folderMap.set(f.id, {
                id: f.id,
                name: String(f.name || 'Untitled Folder'),
                parentId: (f.parentId && typeof f.parentId === 'string') ? f.parentId : null,
                collapsed: Boolean(f.collapsed)
            });
        }
    });

    folderMap.forEach(f => {
        if (f.parentId && (typeof f.parentId !== 'string' || !folderMap.has(f.parentId) || isDescendantFolder(f.parentId, f.id))) {
            f.parentId = null;
        }
    });

    return Array.from(folderMap.values());
}

// ---------------------------------------------------------------------------
// Chat history persistence
// ---------------------------------------------------------------------------

const convSaveTimeouts = new Map();

// Fingerprint of the last CONFIRMED save per conversation. saveHistoryToBackend
// loops over every conversation on any sidebar event, so without this a single
// message re-PUTs the entire history. Each redundant write is another chance
// for an external file handle to collide with the server's atomic replace.
const convFingerprints = new Map();

let indexSaveTimeout = null;

/** djb2. Only needs to be stable and cheap, not cryptographic. */
function hashString(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return hash >>> 0;
}

/** Length is paired with the hash so a collision also has to match in size. */
function fingerprintOf(serialized) {
    return serialized.length + ':' + hashString(serialized).toString(36);
}

export function saveConversationToBackend(conv) {
    if (!conv || !conv.id) return;
    const convId = conv.id;

    let serialized;
    try {
        serialized = JSON.stringify(conv);
    } catch (e) {
        console.error(`Failed to serialize conversation ${convId}`, e);
        return;
    }

    const fp = fingerprintOf(serialized);
    if (convFingerprints.get(convId) === fp) return;

    if (convSaveTimeouts.has(convId)) {
        clearTimeout(convSaveTimeouts.get(convId));
    }

    const timer = setTimeout(() => {
        convSaveTimeouts.delete(convId);
        fetch(`/v1/history/conversations/${encodeURIComponent(convId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: serialized
        }).then(res => {
            // Recorded only on a confirmed save. Dropping it on failure means
            // the next call retries rather than treating it as persisted.
            if (res.ok) {
                convFingerprints.set(convId, fp);
            } else {
                convFingerprints.delete(convId);
                console.error(`Failed to save conversation ${convId} (HTTP ${res.status})`);
            }
        }).catch(e => {
            convFingerprints.delete(convId);
            console.error(`Failed to save conversation ${convId}`, e);
        });
    }, 250);
    convSaveTimeouts.set(convId, timer);
}

export function saveIndexToBackend() {
    if (indexSaveTimeout) {
        clearTimeout(indexSaveTimeout);
    }
    indexSaveTimeout = setTimeout(() => {
        indexSaveTimeout = null;
        const payload = {
            folders: store.folders,
            order: store.conversations.map(c => c.id)
        };
        fetch('/v1/history/index', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(e => console.error('Failed to save history index', e));
    }, 200);
}

export function deleteConversationOnBackend(convId) {
    if (!convId) return;
    if (convSaveTimeouts.has(convId)) {
        clearTimeout(convSaveTimeouts.get(convId));
        convSaveTimeouts.delete(convId);
    }
    convFingerprints.delete(convId);
    fetch(`/v1/history/conversations/${encodeURIComponent(convId)}`, {
        method: 'DELETE'
    }).catch(e => console.error(`Failed to delete conversation ${convId}`, e));
    saveIndexToBackend();
}

export function importHistoryToBackend(payload) {
    // A bulk import rewrites every file server-side, so no cached fingerprint
    // can be trusted afterwards.
    convFingerprints.clear();
    return fetch('/v1/history/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => console.error('Backend bulk import failed', e));
}

export function saveHistoryToBackend() {
    saveIndexToBackend();
    store.conversations.forEach(c => saveConversationToBackend(c));
}

export function normalizeHistory(raw) {
    if (Array.isArray(raw)) {
        return {
            folders: [],
            conversations: raw,
            needsResave: raw.length > 0
        };
    }
    if (raw && typeof raw === 'object' && Array.isArray(raw.conversations)) {
        const rawFolders = Array.isArray(raw.folders) ? raw.folders : [];
        return {
            folders: sanitizeFolders(rawFolders),
            conversations: raw.conversations,
            needsResave: !Array.isArray(raw.folders)
        };
    }
    return null;
}

export async function loadHistoryFromBackend() {
    try {
        const res = await fetch('/v1/history/all');
        if (!res.ok) {
            const legacyRes = await fetch('/v1/history');
            if (!legacyRes.ok) return null;
            const legacyData = await legacyRes.json();
            return normalizeHistory(legacyData);
        }
        const data = await res.json();
        return normalizeHistory(data);
    } catch (e) {
        console.error('Failed to load history from backend', e);
        return null;
    }
}

export function openChatDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB is not supported'));
            return;
        }
        const request = window.indexedDB.open(CHAT_DB_NAME, CHAT_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(CHAT_STORE)) {
                db.createObjectStore(CHAT_STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open Chat DB'));
    });
}

export function loadConversationsFromDb() {
    return new Promise((resolve, reject) => {
        if (!store.chatDb) {
            resolve([]);
            return;
        }
        const tx = store.chatDb.transaction(CHAT_STORE, 'readonly');
        const objStore = tx.objectStore(CHAT_STORE);
        const request = objStore.get('all_conversations');
        request.onsuccess = () => {
            if (request.result && request.result.data) {
                resolve(request.result.data);
            } else {
                resolve([]);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

export function readLegacyLocalStorageConversations() {
    const oldData = localStorage.getItem(STORAGE_KEY_CONVS);
    if (!oldData) return null;
    const parsed = safeParse(oldData, null);
    localStorage.removeItem(STORAGE_KEY_CONVS);
    return Array.isArray(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Per-model token limit persistence
// ---------------------------------------------------------------------------

export function openModelLimitsDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB is not supported in this browser'));
            return;
        }
        const request = window.indexedDB.open(MODEL_LIMITS_DB_NAME, MODEL_LIMITS_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(MODEL_LIMITS_STORE)) {
                db.createObjectStore(MODEL_LIMITS_STORE, { keyPath: 'model' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
    });
}

function loadAllModelTokenLimits() {
    return new Promise((resolve, reject) => {
        if (!store.modelLimitsDb) {
            resolve({});
            return;
        }
        const tx = store.modelLimitsDb.transaction(MODEL_LIMITS_STORE, 'readonly');
        const objStore = tx.objectStore(MODEL_LIMITS_STORE);
        const request = objStore.getAll();
        request.onsuccess = () => {
            const rows = Array.isArray(request.result) ? request.result : [];
            const mapped = {};
            rows.forEach((row) => {
                if (!row || typeof row.model !== 'string') return;
                const limit = Number(row.limit);
                if (Number.isFinite(limit) && limit > 0) {
                    mapped[row.model] = limit;
                }
            });
            resolve(mapped);
        };
        request.onerror = () => reject(request.error || new Error('Failed to load model token limits'));
    });
}

export async function initModelLimitStorage() {
    try {
        store.modelLimitsDb = await openModelLimitsDb();
        store.modelTokenLimits = await loadAllModelTokenLimits();
    } catch (e) {
        console.error('Failed to initialize model token limit storage', e);
        store.modelLimitsDb = null;
        store.modelTokenLimits = {};
    }
}

export function getStoredTokenLimit(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;
    const limit = store.modelTokenLimits[modelId];
    if (!Number.isFinite(limit) || limit <= 0) return null;
    return limit;
}

export function saveModelTokenLimit(modelId, limit) {
    return new Promise((resolve, reject) => {
        if (!modelId || typeof modelId !== 'string') {
            reject(new Error('Model ID is required to save a token limit'));
            return;
        }
        const normalizedLimit = Number(limit);
        if (!Number.isFinite(normalizedLimit) || normalizedLimit <= 0) {
            reject(new Error('Token limit must be a positive number'));
            return;
        }
        store.modelTokenLimits[modelId] = normalizedLimit;
        if (!store.modelLimitsDb) {
            resolve();
            return;
        }
        const tx = store.modelLimitsDb.transaction(MODEL_LIMITS_STORE, 'readwrite');
        const objStore = tx.objectStore(MODEL_LIMITS_STORE);
        const request = objStore.put({ model: modelId, limit: normalizedLimit, updatedAt: Date.now() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error('Failed to save model token limit'));
    });
}
