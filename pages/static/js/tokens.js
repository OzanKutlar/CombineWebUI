import { DEFAULT_TOKEN_LIMIT, PENDING_REFRESH_MS, PRUNE_PENDING_EVENT } from './config.js';
import { store, getActiveConversation, getStoredTokenLimit, saveModelTokenLimit } from './storage.js';
import { getPendingSummary, formatCountdown } from './pruneCache.js';

export function countTokens(text) {
    return Math.ceil((text || '').length / 4);
}

export function getActiveTokenLimit() {
    return getStoredTokenLimit(store.selectedModel) || DEFAULT_TOKEN_LIMIT;
}

export function formatTokenLimit(limit) {
    return (Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_TOKEN_LIMIT).toLocaleString();
}

export function applyActiveTokenLimit() {
    store.activeTokenLimit = getActiveTokenLimit();
}

function setTokenLimitExceededState(isExceeded) {
    const tokenCount = document.getElementById('token-count');
    const sendBtn = document.getElementById('send-btn');
    const continueBtn = document.getElementById('continue-btn');
    if (!tokenCount || !sendBtn || !continueBtn) return;

    if (isExceeded) {
        tokenCount.className = 'text-xs text-gb-redAccent font-bold uppercase tracking-wider';
        if (!store.isProcessing) {
            sendBtn.disabled = true;
            sendBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
        continueBtn.disabled = true;
        continueBtn.classList.add('opacity-50', 'cursor-not-allowed');
        return;
    }

    tokenCount.className = 'text-xs text-gb-fgDark font-semibold uppercase tracking-wider';
    if (!store.isProcessing) {
        sendBtn.disabled = false;
        sendBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        continueBtn.disabled = false;
        continueBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}

// ---------------------------------------------------------------------------
// Pending (cache-deferred) prune display
// ---------------------------------------------------------------------------

// What the counter last showed, without the pending suffix, so the countdown
// can refresh without recounting the thread or hitting the server.
let baseTokenText = '';
let pendingTimer = null;
let hadPending = false;

function pendingSuffix(summary) {
    const tokens = summary.tokens.toLocaleString();
    if (summary.commitRequested) {
        return ` \u2022 +${tokens} tok held for cache, pruned on next send`;
    }
    return ` \u2022 +${tokens} tok held for cache (prune pending, ${formatCountdown(summary.secondsLeft)})`;
}

function readPendingSummary() {
    try {
        return getPendingSummary(getActiveConversation(), store.selectedModel, Date.now());
    } catch (e) {
        console.warn('Failed to compute pending prunes', e);
        return null;
    }
}

function syncPendingTimer(hasPending) {
    if (hasPending && !pendingTimer) {
        pendingTimer = setInterval(refreshPendingDisplay, PENDING_REFRESH_MS);
    } else if (!hasPending && pendingTimer) {
        clearInterval(pendingTimer);
        pendingTimer = null;
    }
}

/** Lets prune cards repaint when pending prunes appear or the cache cools. */
function notifyPendingTransition(hasPending) {
    if (hasPending === hadPending) return;
    hadPending = hasPending;
    try {
        window.dispatchEvent(new CustomEvent(PRUNE_PENDING_EVENT, { detail: { hasPending } }));
    } catch (e) {
        console.warn('Failed to dispatch the pending prune event', e);
    }
}

function refreshPendingDisplay() {
    const tokenCount = document.getElementById('token-count');
    if (!tokenCount) return;
    const summary = readPendingSummary();
    const hasPending = Boolean(summary) && summary.count > 0;
    tokenCount.textContent = baseTokenText + (hasPending ? pendingSuffix(summary) : '');
    syncPendingTimer(hasPending);
    notifyPendingTransition(hasPending);
}

function setTokenText(text) {
    baseTokenText = text;
    refreshPendingDisplay();
}

let tokenCalcTimeout = null;

export function updateTokenCount() {
    const tokenCount = document.getElementById('token-count');
    const promptInput = document.getElementById('prompt-input');
    if (!tokenCount || !promptInput) return;

    applyActiveTokenLimit();
    const currentLimit = store.activeTokenLimit;
    const text = promptInput.value;
    const active = getActiveConversation();
    const history = active ? active.messages : [];

    let roughTokens = countTokens(text);
    let totalSaved = 0;

    history.forEach(m => {
        roughTokens += countTokens(m.content);
        if (m.role === 'user' && m.originalContent && m.content !== m.originalContent) {
            totalSaved += Math.max(0, countTokens(m.originalContent) - countTokens(m.content));
        }
    });

    let displayTxt = `${roughTokens.toLocaleString()} / ${formatTokenLimit(currentLimit)} tokens (est.)`;
    if (totalSaved > 0) {
        displayTxt += ` \u2022 Would be ${(roughTokens + totalSaved).toLocaleString()} without pruning`;
    }
    setTokenText(displayTxt);
    setTokenLimitExceededState(roughTokens > currentLimit);

    clearTimeout(tokenCalcTimeout);
    tokenCalcTimeout = setTimeout(async () => {
        try {
            const tempMessages = history.map(m => ({ role: m.role, content: m.content }));
            if (text.trim()) {
                tempMessages.push({ role: 'user', content: text });
            }
            if (tempMessages.length === 0) {
                setTokenText(`0 / ${formatTokenLimit(currentLimit)} tokens`);
                setTokenLimitExceededState(false);
                return;
            }

            const res = await fetch('/v1/count_tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: store.selectedModel || 'gpt-4o',
                    messages: tempMessages
                })
            });

            if (res.ok) {
                const data = await res.json();
                const exactTokens = data.total_tokens;
                applyActiveTokenLimit();
                const latestLimit = store.activeTokenLimit;

                let displayExact = `${exactTokens.toLocaleString()} / ${formatTokenLimit(latestLimit)} tokens`;
                if (totalSaved > 0) {
                    displayExact += ` \u2022 Would be ${(exactTokens + totalSaved).toLocaleString()} without pruning`;
                }
                setTokenText(displayExact);
                setTokenLimitExceededState(exactTokens > latestLimit);
            }
        } catch (e) {
            console.error('Token calculation failed', e);
        }
    }, 500);
}

export function extractPromptTokenLimitFromErrorMessage(message) {
    if (typeof message !== 'string' || !message) return null;
    const match = message.match(/prompt token count of\s+\d+\s+exceeds the limit of\s+(\d+)/i);
    if (!match) return null;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

export async function learnModelTokenLimitFromError(message, modelId) {
    const targetModel = (typeof modelId === 'string' && modelId) ? modelId : store.selectedModel;
    if (!targetModel) return false;

    const learnedLimit = extractPromptTokenLimitFromErrorMessage(message);
    if (!learnedLimit) return false;

    const currentLimit = getStoredTokenLimit(targetModel);
    if (currentLimit === learnedLimit) {
        applyActiveTokenLimit();
        updateTokenCount();
        return true;
    }

    try {
        await saveModelTokenLimit(targetModel, learnedLimit);
    } catch (e) {
        console.error('Failed to persist learned model token limit', e);
    }
    applyActiveTokenLimit();
    updateTokenCount();
    return true;
}
