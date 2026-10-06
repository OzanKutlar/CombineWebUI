let activeConfirmCallback = null;

export function showConfirmModal(title, text, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    const box = document.getElementById('confirm-modal-box');
    if (!modal || !box) return;

    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-text').textContent = text;

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');

    activeConfirmCallback = () => {
        onConfirm();
        closeConfirmModal();
    };
    lucide.createIcons();
}

export function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    const box = document.getElementById('confirm-modal-box');
    if (!modal || !box) return;

    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
    activeConfirmCallback = null;
}

export function wireConfirmModal() {
    const cancelBtn = document.getElementById('modal-cancel-btn');
    const confirmBtn = document.getElementById('modal-confirm-btn');
    if (cancelBtn) cancelBtn.onclick = closeConfirmModal;
    if (confirmBtn) {
        confirmBtn.onclick = () => {
            if (activeConfirmCallback) activeConfirmCallback();
        };
    }
}
