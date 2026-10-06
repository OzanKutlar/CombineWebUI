import {
    store,
    isDescendantFolder,
    canMoveFolder,
    saveIndexToBackend,
    saveConversationToBackend
} from './storage.js';
import { renderSidebar } from './sidebar.js';

let activeDragPayload = null;
let hoverExpandTimer = null;
let hoverExpandFolderId = null;

export function clearDragState() {
    activeDragPayload = null;
    if (hoverExpandTimer) {
        clearTimeout(hoverExpandTimer);
        hoverExpandTimer = null;
    }
    hoverExpandFolderId = null;
    document.querySelectorAll('.drop-target-active').forEach(el => {
        el.classList.remove('drop-target-active');
    });
    document.querySelectorAll('.drag-ghost').forEach(el => {
        el.classList.remove('drag-ghost');
    });
}

export function attachConvDrag(rowEl, convId) {
    rowEl.setAttribute('draggable', 'true');
    rowEl.addEventListener('dragstart', (e) => {
        if (e.target && (e.target.closest('button') || e.target.closest('input'))) {
            e.preventDefault();
            return;
        }
        activeDragPayload = { kind: 'conv', id: convId };
        e.dataTransfer.effectAllowed = 'move';
        try {
            e.dataTransfer.setData('text/plain', convId);
            e.dataTransfer.setData('application/json', JSON.stringify(activeDragPayload));
        } catch (err) {}
        setTimeout(() => {
            if (rowEl.isConnected) rowEl.classList.add('drag-ghost');
        }, 0);
    });

    rowEl.addEventListener('dragend', () => {
        clearDragState();
    });
}

export function attachFolderDrag(rowEl, folderId) {
    rowEl.setAttribute('draggable', 'true');
    rowEl.addEventListener('dragstart', (e) => {
        if (e.target && (e.target.closest('button') || e.target.closest('input'))) {
            e.preventDefault();
            return;
        }
        activeDragPayload = { kind: 'folder', id: folderId };
        e.dataTransfer.effectAllowed = 'move';
        try {
            e.dataTransfer.setData('text/plain', folderId);
            e.dataTransfer.setData('application/json', JSON.stringify(activeDragPayload));
        } catch (err) {}
        setTimeout(() => {
            if (rowEl.isConnected) rowEl.classList.add('drag-ghost');
        }, 0);
    });

    rowEl.addEventListener('dragend', () => {
        clearDragState();
    });
}

export function attachFolderDropTarget(targetEl, targetFolderId) {
    targetEl.addEventListener('dragover', (e) => {
        if (!activeDragPayload) return;
        if (activeDragPayload.kind === 'folder') {
            if (!canMoveFolder(activeDragPayload.id, targetFolderId)) return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';

        if (!targetEl.classList.contains('drop-target-active')) {
            targetEl.classList.add('drop-target-active');
        }

        const folder = store.folders.find(f => f.id === targetFolderId);
        if (folder && folder.collapsed) {
            if (hoverExpandFolderId !== targetFolderId) {
                if (hoverExpandTimer) clearTimeout(hoverExpandTimer);
                hoverExpandFolderId = targetFolderId;
                hoverExpandTimer = setTimeout(() => {
                    folder.collapsed = false;
                    saveIndexToBackend();
                    renderSidebar();
                }, 600);
            }
        }
    });

    targetEl.addEventListener('dragleave', (e) => {
        if (targetEl.contains(e.relatedTarget)) return;
        targetEl.classList.remove('drop-target-active');
        if (hoverExpandFolderId === targetFolderId) {
            if (hoverExpandTimer) clearTimeout(hoverExpandTimer);
            hoverExpandTimer = null;
            hoverExpandFolderId = null;
        }
    });

    targetEl.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        targetEl.classList.remove('drop-target-active');
        if (!activeDragPayload) return;

        if (activeDragPayload.kind === 'conv') {
            const conv = store.conversations.find(c => c.id === activeDragPayload.id);
            if (conv && conv.folderId !== targetFolderId) {
                conv.folderId = targetFolderId;
                saveConversationToBackend(conv);
                saveIndexToBackend();
                renderSidebar();
            }
        } else if (activeDragPayload.kind === 'folder') {
            const folder = store.folders.find(f => f.id === activeDragPayload.id);
            if (folder && canMoveFolder(folder.id, targetFolderId)) {
                folder.parentId = targetFolderId;
                saveIndexToBackend();
                renderSidebar();
            }
        }
        clearDragState();
    });
}

export function attachRootDropTarget(containerEl) {
    containerEl.classList.add('drop-target-root');
    containerEl.addEventListener('dragover', (e) => {
        if (!activeDragPayload) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!containerEl.classList.contains('drop-target-active')) {
            containerEl.classList.add('drop-target-active');
        }
    });

    containerEl.addEventListener('dragleave', (e) => {
        if (containerEl.contains(e.relatedTarget)) return;
        containerEl.classList.remove('drop-target-active');
    });

    containerEl.addEventListener('drop', (e) => {
        e.preventDefault();
        containerEl.classList.remove('drop-target-active');
        if (!activeDragPayload) return;

        if (activeDragPayload.kind === 'conv') {
            const conv = store.conversations.find(c => c.id === activeDragPayload.id);
            if (conv && conv.folderId !== null) {
                conv.folderId = null;
                saveConversationToBackend(conv);
                saveIndexToBackend();
                renderSidebar();
            }
        } else if (activeDragPayload.kind === 'folder') {
            const folder = store.folders.find(f => f.id === activeDragPayload.id);
            if (folder && folder.parentId !== null) {
                folder.parentId = null;
                saveIndexToBackend();
                renderSidebar();
            }
        }
        clearDragState();
    });
}
