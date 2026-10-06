let autoCloseTimer = null;
let isFinished = false;

export function openSaveProgressModal(providers) {
    clearAutoCloseTimer();
    isFinished = false;

    const modal = document.getElementById('save-progress-modal');
    const box = document.getElementById('save-progress-modal-box');
    const container = document.getElementById('save-progress-container');
    const doneBtn = document.getElementById('save-progress-done-btn');
    const closeBtn = document.getElementById('close-save-progress-modal-btn');
    const summaryEl = document.getElementById('save-progress-summary');

    if (!modal || !box || !container) return;

    container.innerHTML = '';
    if (summaryEl) summaryEl.textContent = 'Verifying provider reachability...';
    if (doneBtn) {
        doneBtn.disabled = true;
        doneBtn.className = 'px-4 py-2 rounded bg-gb-bgLight1 text-gb-fgDark text-sm font-semibold transition-all cursor-not-allowed opacity-50';
    }
    if (closeBtn) closeBtn.classList.add('hidden');

    // 1. Render Provider items
    const eps = Array.isArray(providers) ? providers : [];
    if (eps.length === 0) {
        const noEps = document.createElement('div');
        noEps.className = 'text-xs text-gb-fgDark italic py-1';
        noEps.textContent = 'No custom endpoint providers configured.';
        container.appendChild(noEps);
    } else {
        eps.forEach((ep, idx) => {
            const row = document.createElement('div');
            row.id = `progress-provider-row-${idx}`;
            row.className = 'flex items-center justify-between p-3 rounded-lg bg-gb-bgDarkest border border-gb-bgLight2 transition-all duration-300';
            row.innerHTML = `
                <div class="flex items-center gap-3 min-w-0">
                    <div class="status-icon shrink-0 text-gb-blueAccent">
                        <i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>
                    </div>
                    <div class="flex flex-col min-w-0">
                        <span class="provider-name text-sm font-bold text-gb-fgLight truncate">${ep.name || 'Unnamed Endpoint'}</span>
                        <span class="provider-url text-[11px] font-mono text-gb-fgDark truncate">${ep.url || ''}</span>
                    </div>
                </div>
                <div class="status-detail shrink-0 flex items-center gap-2">
                    <span class="status-text text-xs font-mono text-gb-fgDark">testing...</span>
                </div>
            `;
            container.appendChild(row);
        });
    }

    // 2. Render Models checking item
    const modelsRow = document.createElement('div');
    modelsRow.id = 'progress-models-row';
    modelsRow.className = 'flex items-center justify-between p-3 rounded-lg bg-gb-bgDarkest border border-gb-bgLight2 opacity-60 transition-all duration-300 mt-2';
    modelsRow.innerHTML = `
        <div class="flex items-center gap-3 min-w-0">
            <div class="status-icon shrink-0 text-gb-fgDark">
                <i data-lucide="circle-dashed" class="w-4 h-4"></i>
            </div>
            <div class="flex flex-col min-w-0">
                <span class="models-title text-sm font-bold text-gb-fgLight truncate">Checking Available Models</span>
                <span class="models-sub text-[11px] font-mono text-gb-fgDark truncate">Waiting for providers to respond...</span>
            </div>
        </div>
        <div class="status-detail shrink-0 flex items-center gap-2">
            <span class="status-text text-xs font-mono text-gb-fgDark">pending</span>
        </div>
    `;
    container.appendChild(modelsRow);

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-8');
    box.classList.add('translate-y-0');
    lucide.createIcons();
}

export function setProviderStatus(idx, info) {
    const row = document.getElementById(`progress-provider-row-${idx}`);
    if (!row) return;

    const iconEl = row.querySelector('.status-icon');
    const nameEl = row.querySelector('.provider-name');
    const detailEl = row.querySelector('.status-detail');

    const state = info.state || 'pending'; // 'checking' | 'ok' | 'fail'

    if (state === 'checking') {
        if (iconEl) iconEl.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-gb-blueAccent"></i>';
        if (nameEl) {
            nameEl.className = 'provider-name text-sm font-bold text-gb-fgLight truncate';
        }
        if (detailEl) {
            detailEl.innerHTML = `<span class="status-text text-xs font-mono text-gb-fgDark">testing (${info.timeoutSec || 0.5}s)...</span>`;
        }
    } else if (state === 'ok') {
        if (iconEl) iconEl.innerHTML = '<i data-lucide="check-circle-2" class="w-4 h-4 text-gb-greenAccent"></i>';
        if (nameEl) {
            nameEl.className = 'provider-name text-sm font-bold text-gb-greenAccent truncate';
        }
        if (detailEl) {
            detailEl.innerHTML = `<span class="text-xs font-mono text-gb-greenAccent bg-gb-green/20 px-2 py-0.5 rounded border border-gb-greenAccent/30 font-semibold">${info.latency_ms}ms</span>`;
        }
    } else if (state === 'fail') {
        if (iconEl) iconEl.innerHTML = '<i data-lucide="x-circle" class="w-4 h-4 text-gb-redAccent"></i>';
        if (nameEl) {
            nameEl.className = 'provider-name text-sm font-bold text-gb-redAccent truncate';
        }
        if (detailEl) {
            detailEl.innerHTML = '';
            const errSpan = document.createElement('span');
            errSpan.className = 'text-xs font-mono text-gb-redAccent max-w-[150px] truncate';
            errSpan.title = info.error || 'Failed';
            errSpan.textContent = info.error || 'Failed';
            detailEl.appendChild(errSpan);

            if (info.nextTimeout && typeof info.onRetry === 'function') {
                const retryBtn = document.createElement('button');
                retryBtn.className = 'px-2 py-0.5 rounded text-xs font-mono bg-gb-bgLight2 hover:bg-gb-bgLight3 text-gb-fgLight border border-gb-bgLight3 transition-all hover:scale-105 active:scale-95 flex items-center gap-1';
                retryBtn.innerHTML = `<i data-lucide="refresh-cw" class="w-3 h-3 text-gb-aquaAccent"></i> <span>Retry (${info.nextTimeout}s)</span>`;
                retryBtn.onclick = (e) => {
                    e.stopPropagation();
                    info.onRetry();
                };
                detailEl.appendChild(retryBtn);
            }
        }
    }
    lucide.createIcons();
}

export function setModelsStatus(info) {
    const row = document.getElementById('progress-models-row');
    if (!row) return;

    const iconEl = row.querySelector('.status-icon');
    const titleEl = row.querySelector('.models-title');
    const subEl = row.querySelector('.models-sub');
    const detailEl = row.querySelector('.status-detail');

    const state = info.state || 'pending'; // 'pending' | 'checking' | 'ok' | 'fail'

    if (state === 'checking') {
        row.classList.remove('opacity-60');
        if (iconEl) iconEl.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-gb-aquaAccent"></i>';
        if (titleEl) titleEl.className = 'models-title text-sm font-bold text-gb-fgLightest truncate';
        if (subEl) subEl.textContent = 'Querying available models from endpoints...';
        if (detailEl) detailEl.innerHTML = '<span class="status-text text-xs font-mono text-gb-aquaAccent">fetching...</span>';
    } else if (state === 'ok') {
        row.classList.remove('opacity-60');
        if (iconEl) iconEl.innerHTML = '<i data-lucide="check-circle-2" class="w-4 h-4 text-gb-greenAccent"></i>';
        if (titleEl) titleEl.className = 'models-title text-sm font-bold text-gb-greenAccent truncate';
        if (subEl) subEl.textContent = `${info.count || 0} model${info.count === 1 ? '' : 's'} available`;
        if (detailEl) {
            detailEl.innerHTML = `<span class="text-xs font-mono text-gb-greenAccent bg-gb-green/20 px-2 py-0.5 rounded border border-gb-greenAccent/30 font-semibold">${info.count || 0} models</span>`;
        }
    } else if (state === 'fail') {
        row.classList.remove('opacity-60');
        if (iconEl) iconEl.innerHTML = '<i data-lucide="x-circle" class="w-4 h-4 text-gb-redAccent"></i>';
        if (titleEl) titleEl.className = 'models-title text-sm font-bold text-gb-redAccent truncate';
        if (subEl) subEl.textContent = info.error || 'Failed to query models';
        if (detailEl) {
            detailEl.innerHTML = '<span class="text-xs font-mono text-gb-redAccent">failed</span>';
        }
    }
    lucide.createIcons();
}

export function finishSaveProgress(options) {
    const allOk = Boolean(options && options.allOk);
    isFinished = true;

    const doneBtn = document.getElementById('save-progress-done-btn');
    const closeBtn = document.getElementById('close-save-progress-modal-btn');
    const summaryEl = document.getElementById('save-progress-summary');

    if (doneBtn) {
        doneBtn.disabled = false;
        doneBtn.className = 'px-4 py-2 rounded bg-gb-blue hover:bg-gb-blueAccent text-gb-bgDarkest text-sm font-bold transition-all transform hover:scale-105 active:scale-95 cursor-pointer shadow-md';
    }
    if (closeBtn) closeBtn.classList.remove('hidden');

    if (allOk) {
        let secondsLeft = 2;
        if (summaryEl) summaryEl.textContent = `All checks passed! Closing in ${secondsLeft}s...`;
        
        autoCloseTimer = setInterval(() => {
            secondsLeft--;
            if (secondsLeft <= 0) {
                clearAutoCloseTimer();
                closeSaveProgressModal();
            } else if (summaryEl) {
                summaryEl.textContent = `All checks passed! Closing in ${secondsLeft}s...`;
            }
        }, 1000);
    } else {
        clearAutoCloseTimer();
        if (summaryEl) {
            summaryEl.className = 'text-xs text-gb-redAccent font-mono truncate mr-2';
            summaryEl.textContent = 'Some endpoints could not be reached.';
        }
    }
}

export function clearAutoCloseTimer() {
    if (autoCloseTimer) {
        clearInterval(autoCloseTimer);
        autoCloseTimer = null;
    }
}

export function closeSaveProgressModal() {
    clearAutoCloseTimer();
    const modal = document.getElementById('save-progress-modal');
    const box = document.getElementById('save-progress-modal-box');
    if (!modal || !box) return;

    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('translate-y-0');
    box.classList.add('translate-y-8');
}

export function isSaveProgressActive() {
    const modal = document.getElementById('save-progress-modal');
    return modal && !modal.classList.contains('opacity-0') && !isFinished;
}

export function wireSaveProgressModal() {
    const doneBtn = document.getElementById('save-progress-done-btn');
    const closeBtn = document.getElementById('close-save-progress-modal-btn');
    const modal = document.getElementById('save-progress-modal');

    if (doneBtn) doneBtn.onclick = closeSaveProgressModal;
    if (closeBtn) closeBtn.onclick = closeSaveProgressModal;
    if (modal) {
        modal.onclick = (e) => {
            if (e.target === modal && isFinished) closeSaveProgressModal();
        };
    }
}
