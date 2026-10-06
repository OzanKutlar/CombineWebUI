import { applyPlan } from './autoFolderPlan.js';
import { renderSidebar } from './sidebar.js';

let currentPlan = null;

export function openAutoFolderModal(plan) {
    currentPlan = plan;
    const modal = document.getElementById('auto-folder-modal');
    const box = document.getElementById('auto-folder-modal-box');
    if (!modal || !box) return;

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');

    renderPlanPreview(plan);
}

export function closeAutoFolderModal() {
    const modal = document.getElementById('auto-folder-modal');
    const box = document.getElementById('auto-folder-modal-box');
    if (!modal || !box) return;

    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
    currentPlan = null;
}

function renderPlanPreview(plan) {
    const container = document.getElementById('auto-folder-preview-container');
    const applyBtn = document.getElementById('auto-folder-apply-btn');
    if (!container) return;

    container.innerHTML = '';
    const moves = plan ? plan.moves : [];
    const newFolders = plan ? plan.newFolders : [];
    const rejected = plan ? plan.rejected : [];

    if (!moves || moves.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center p-8 text-gb-fgDark gap-3">
                <i data-lucide="folder-x" class="w-12 h-12 text-gb-fgDark opacity-50"></i>
                <p class="text-sm font-semibold">No chats were matched to any folders.</p>
                <p class="text-xs text-gb-bgLight3 text-center max-w-sm">The model did not find appropriate existing or new categories for your unsorted chats.</p>
            </div>
        `;
        if (applyBtn) {
            applyBtn.disabled = true;
            applyBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
        lucide.createIcons();
        return;
    }

    if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    // Summary Header
    const summary = document.createElement('div');
    summary.className = 'flex flex-wrap gap-2 mb-4';
    summary.innerHTML = `
        <span class="px-2.5 py-1 rounded bg-gb-blue/20 text-gb-blueAccent border border-gb-blue/30 text-xs font-semibold">
            ${moves.length} chat${moves.length === 1 ? '' : 's'} to sort
        </span>
        <span class="px-2.5 py-1 rounded bg-gb-aquaAccent/20 text-gb-aquaAccent border border-gb-aquaAccent/30 text-xs font-semibold">
            ${newFolders.length} new folder${newFolders.length === 1 ? '' : 's'}
        </span>
    `;
    container.appendChild(summary);

    // Group moves by target folder
    const grouped = new Map();
    moves.forEach(m => {
        if (!grouped.has(m.targetFolderId)) {
            grouped.set(m.targetFolderId, {
                folderName: m.folderName,
                isNew: m.isNewFolder,
                chats: []
            });
        }
        grouped.get(m.targetFolderId).chats.push(m.chatTitle);
    });

    const list = document.createElement('div');
    list.className = 'flex flex-col gap-3';

    grouped.forEach((info) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'bg-gb-bgDarkest border border-gb-bgLight2 rounded-lg p-3 flex flex-col gap-2';

        const head = document.createElement('div');
        head.className = 'flex items-center justify-between gap-2 border-b border-gb-bgLight2 pb-2';
        head.innerHTML = `
            <div class="flex items-center gap-2 min-w-0">
                <i data-lucide="folder" class="w-4 h-4 text-gb-aquaAccent shrink-0"></i>
                <span class="font-bold text-sm text-gb-fgLightest truncate">${info.folderName}</span>
                ${info.isNew ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-gb-aquaAccent/20 text-gb-aquaAccent border border-gb-aquaAccent/40 shrink-0">NEW</span>' : ''}
            </div>
            <span class="text-xs font-mono text-gb-fgDark shrink-0">${info.chats.length} chat${info.chats.length === 1 ? '' : 's'}</span>
        `;
        groupEl.appendChild(head);

        const chatList = document.createElement('div');
        chatList.className = 'flex flex-col gap-1 pl-4 border-l border-gb-bgLight2';
        info.chats.forEach(title => {
            const chatRow = document.createElement('div');
            chatRow.className = 'text-xs text-gb-fgLight font-mono flex items-center gap-2 truncate py-0.5';
            chatRow.innerHTML = `<i data-lucide="message-square" class="w-3 h-3 text-gb-fgDark shrink-0"></i><span class="truncate">${title}</span>`;
            chatList.appendChild(chatRow);
        });
        groupEl.appendChild(chatList);
        list.appendChild(groupEl);
    });
    container.appendChild(list);

    // Rejected items accordion
    if (rejected.length > 0) {
        const rejWrap = document.createElement('div');
        rejWrap.className = 'mt-4 border border-gb-bgLight2 rounded-lg bg-gb-bgDarkest overflow-hidden text-xs';
        rejWrap.innerHTML = `
            <button class="w-full flex justify-between items-center p-2.5 bg-gb-bgLight1 hover:bg-gb-bgLight2 text-gb-fgDark font-semibold transition-colors">
                <span>Skipped / Discarded (${rejected.length})</span>
                <i data-lucide="chevron-down" class="w-4 h-4"></i>
            </button>
            <div class="p-3 flex flex-col gap-1 border-t border-gb-bgLight2 hidden">
                ${rejected.map(r => `<span class="text-gb-fgDark font-mono">• ${r.reason}</span>`).join('')}
            </div>
        `;
        const btn = rejWrap.querySelector('button');
        const content = rejWrap.querySelector('div');
        btn.onclick = () => content.classList.toggle('hidden');
        container.appendChild(rejWrap);
    }

    lucide.createIcons();
}

export function wireAutoFolderModal() {
    const cancelBtn = document.getElementById('auto-folder-cancel-btn');
    const applyBtn = document.getElementById('auto-folder-apply-btn');
    const closeBtn = document.getElementById('close-auto-folder-modal-btn');
    const modal = document.getElementById('auto-folder-modal');

    if (cancelBtn) cancelBtn.onclick = closeAutoFolderModal;
    if (closeBtn) closeBtn.onclick = closeAutoFolderModal;
    if (modal) {
        modal.onclick = (e) => {
            if (e.target === modal) closeAutoFolderModal();
        };
    }

    if (applyBtn) {
        applyBtn.onclick = () => {
            if (currentPlan) {
                applyPlan(currentPlan);
                renderSidebar();
            }
            closeAutoFolderModal();
        };
    }
}
