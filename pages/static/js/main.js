import { store, initModelLimitStorage, loadHistoryFromBackend, importHistoryToBackend, openChatDb, loadConversationsFromDb, normalizeHistory, readLegacyLocalStorageConversations, getActiveConversation, syncUIPreferencesFromBackend } from './storage.js';
import { initRealtimeSync } from './sync.js';
import { initTheme, applyTheme } from './theme.js';
import { applyActiveTokenLimit, updateTokenCount } from './tokens.js';
import { wireConfirmModal, showConfirmModal } from './modals.js';
import { fetchModels, openModelModal, closeModelModal, toggleShowHiddenModels } from './models.js';
import { openSettingsModal, closeSettingsModal, addEndpoint, addProviderGroup, saveSettings } from './settings.js';
import { renderSidebar, initConversations, createNewChat, createNewFolder, saveConversations, startAutoNaming, startAutoFolder, setSidebarViewMode } from './sidebar.js';
import { wireAutoFolderModal, closeAutoFolderModal } from './autoFolderModal.js';
import { wireSaveProgressModal, closeSaveProgressModal, isSaveProgressActive } from './saveProgress.js';
import { renderChat, handleSend } from './chat.js';
import { wireChatNav } from './chatNav.js';
import { closeActiveDropdown } from './messageActions.js';
import { closePopupMenu } from './popupMenu.js';
import { wirePruneDrawer, closePruneDrawer } from './pruneDrawer.js';
import { wireCodeBlocks } from './codeblock.js';
import { wireSearchModal, closeSearchModal } from './search.js';
import { wireTokenCounterModal, closeTokenCounterModal } from './tokenCounterModal.js';

marked.setOptions({ breaks: true, gfm: true });

function wireEvents() {
    wireConfirmModal();
    wireAutoFolderModal();
    wireSaveProgressModal();
    wireChatNav();
    wirePruneDrawer();
    wireCodeBlocks();
    wireSearchModal();
    wireTokenCounterModal();

    // Any outside click or Escape dismisses an open message dropdown.
    document.addEventListener('click', closeActiveDropdown);
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        closeActiveDropdown();
        closePopupMenu();
        closeAutoFolderModal();
        closePruneDrawer();
        closeSearchModal();
        closeTokenCounterModal();
        if (!isSaveProgressActive()) {
            closeSaveProgressModal();
        }
    });

    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');
    const continueBtn = document.getElementById('continue-btn');

    promptInput.addEventListener('input', updateTokenCount);
    promptInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            if (store.isProcessing) return;
            handleSend();
        }
    });

    sendBtn.addEventListener('click', () => {
        if (store.isProcessing) {
            if (store.currentAbortController) store.currentAbortController.abort();
            return;
        }
        handleSend();
    });

    continueBtn.addEventListener('click', () => {
        // Only inject the boilerplate when the user has not typed their own nudge.
        if (!promptInput.value.trim()) {
            promptInput.value = 'Please continue exactly where you left off, preserving any open code blocks or formatting.';
        }
        handleSend();
    });

    const foldersModeBtn = document.getElementById('view-mode-folders-btn');
    const recentModeBtn = document.getElementById('view-mode-recent-btn');
    if (foldersModeBtn) {
        foldersModeBtn.addEventListener('click', () => setSidebarViewMode('folders'));
    }
    if (recentModeBtn) {
        recentModeBtn.addEventListener('click', () => setSidebarViewMode('recent'));
    }

    document.getElementById('new-chat-btn').addEventListener('click', () => {
        if (store.isProcessing) {
            alert('Please stop the current generation before starting a new chat.');
            return;
        }
        createNewChat();
    });

    document.getElementById('new-folder-btn').addEventListener('click', () => createNewFolder());

    document.getElementById('clear-btn').addEventListener('click', () => {
        if (store.isProcessing) {
            alert('Please stop the current generation before clearing.');
            return;
        }
        const active = getActiveConversation();
        if (!active) return;
        showConfirmModal('Clear Current Thread', 'Are you sure you want to clear all messages in this thread?', () => {
            active.messages = [];
            active.title = 'New Chat';
            saveConversations();
            renderSidebar();
            renderChat();
            updateTokenCount();
        });
    });

    document.getElementById('clear-all-convs-btn').addEventListener('click', () => {
        if (store.isProcessing) {
            alert('Please stop the current generation before deleting chats.');
            return;
        }
        showConfirmModal('Delete All Chats', 'Are you absolutely sure you want to delete ALL conversations? This cannot be undone.', () => {
            store.conversations = [];
            store.folders = [];
            store.activeConvId = '';
            initConversations();
            saveConversations();
            renderSidebar();
            renderChat();
            updateTokenCount();
        });
    });

    document.getElementById('model-select-btn').addEventListener('click', () => openModelModal('chat'));

    const autoNameModelBtn = document.getElementById('auto-name-model-btn');
    if (autoNameModelBtn) {
        autoNameModelBtn.addEventListener('click', () => openModelModal('autoName'));
    }

    document.getElementById('close-model-modal-btn').addEventListener('click', closeModelModal);
    document.getElementById('show-hidden-models-btn').addEventListener('click', toggleShowHiddenModels);
    document.getElementById('auto-name-btn').addEventListener('click', startAutoNaming);
    document.getElementById('auto-folder-btn').addEventListener('click', startAutoFolder);

    const modelModal = document.getElementById('model-modal');
    modelModal.addEventListener('click', (e) => {
        if (e.target === modelModal) closeModelModal();
    });

    document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
    document.getElementById('close-settings-btn').addEventListener('click', closeSettingsModal);
    document.getElementById('cancel-settings-btn').addEventListener('click', closeSettingsModal);
    document.getElementById('add-endpoint-btn').addEventListener('click', addEndpoint);
    const addGroupBtn = document.getElementById('add-provider-group-btn');
    if (addGroupBtn) {
        addGroupBtn.addEventListener('click', addProviderGroup);
    }
    document.getElementById('save-settings-btn').addEventListener('click', saveSettings);

    const settingsModal = document.getElementById('settings-modal');
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettingsModal();
    });
}

/**
 * Resolution order: backend blob -> legacy IndexedDB store -> legacy
 * localStorage key. Anything found outside the backend is re-saved.
 */
async function loadHistory() {
    let history = await loadHistoryFromBackend();
    let needsResave = history ? history.needsResave : false;

    if (!history || history.conversations.length === 0) {
        try {
            store.chatDb = await openChatDb();
            const legacyDb = await loadConversationsFromDb();
            const normalized = normalizeHistory(legacyDb);
            if (normalized && normalized.conversations.length > 0) {
                history = normalized;
                needsResave = true;
            }
        } catch (e) {
            console.warn('Legacy chat IndexedDB unavailable', e);
        }
    }

    if (!history || history.conversations.length === 0) {
        const legacyLocal = readLegacyLocalStorageConversations();
        const normalized = normalizeHistory(legacyLocal);
        if (normalized && normalized.conversations.length > 0) {
            history = normalized;
            needsResave = true;
        }
    }

    store.conversations = history ? history.conversations : [];
    store.folders = history ? history.folders : [];

    if (needsResave && store.conversations.length > 0) {
        console.log('Migrating chat history to the { folders, conversations } shape...');
        await importHistoryToBackend({ folders: store.folders, conversations: store.conversations });
    }
}

async function initializeApp() {
    // First, so the locally cached theme is in place before anything renders.
    // The inline bootstrap in index.html already painted it; this keeps the
    // store and the DOM agreeing and stamps the meta theme-color.
    initTheme();

    await initModelLimitStorage();
    applyActiveTokenLimit();

    await syncUIPreferencesFromBackend();
    // Corrects the local value only if the server disagreed.
    applyTheme(store.theme);
    await loadHistory();
    initConversations();

    wireEvents();

    await fetchModels();

    renderSidebar();
    renderChat();
    updateTokenCount();
    lucide.createIcons();

    initRealtimeSync();
}

initializeApp().catch(e => {
    console.error('Failed to initialize the chat UI', e);
});
