import { store } from './storage.js';
import { readThemeColor, themeVar } from './theme.js';

/**
 * Assistant message avatars. A grouped model shows its provider logo from
 * settings.json; anything ungrouped (including custom endpoints, which
 * register with an empty logo) falls back to a colour-coded name pill.
 */

// Token names rather than literals, so the pills repaint with the theme.
// The hash still selects the same slot for a given model in every theme.
const BLOB_TOKENS = [
    '--gb-avatar-1',
    '--gb-avatar-2',
    '--gb-avatar-3',
    '--gb-avatar-4',
    '--gb-avatar-5',
    '--gb-avatar-6'
];
const MAX_BLOB_CHARS = 10;

/** 'moonshotai/Kimi-K3:fastest' -> 'Kimi-K3' */
export function deriveShortName(modelId) {
    if (typeof modelId !== 'string' || !modelId) return '';
    let name = modelId;

    const slash = name.lastIndexOf('/');
    if (slash !== -1) name = name.slice(slash + 1);

    const colon = name.indexOf(':');
    if (colon !== -1) name = name.slice(0, colon);

    return name.trim() || modelId;
}

function hashString(text) {
    let hash = 0;
    const str = String(text || '');
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function pickBlobToken(modelId) {
    return BLOB_TOKENS[hashString(modelId) % BLOB_TOKENS.length];
}

/** Deterministic, so a given model keeps the same slot across sessions. */
export function pickBlobColor(modelId) {
    return readThemeColor(pickBlobToken(modelId), '#83a598');
}

function resolveProvider(modelId) {
    if (!Array.isArray(store.allModels) || !Array.isArray(store.allProviders)) return null;
    let model = store.allModels.find(m => m && m.id === modelId);
    if (!model) {
        model = store.allModels.find(m => m && m.raw_id === modelId);
    }
    if (!model) return null;

    const providerId = model.provider_id || 'other';
    const provider = store.allProviders.find(p => p && p.id === providerId);
    if (provider && provider.logo) return provider;
    return null;
}

/**
 * Provider logo URL for a model, or '' when it has none. This is the single
 * definition of "has an icon" for avatars, the selector and favorites.
 */
export function getModelLogo(modelId) {
    if (!modelId || typeof modelId !== 'string') return '';
    const provider = resolveProvider(modelId);
    return (provider && typeof provider.logo === 'string') ? provider.logo : '';
}

function createBlob(modelId) {
    const short = deriveShortName(modelId);
    const token = pickBlobToken(modelId);

    const blob = document.createElement('span');
    blob.className = 'model-avatar-blob shrink-0';
    blob.title = modelId;
    blob.textContent = short.length > MAX_BLOB_CHARS
        ? short.slice(0, MAX_BLOB_CHARS) + '\u2026'
        : short;

    // Written as live `rgb(var(--token) / a)` rather than a resolved hex with
    // an alpha suffix, so a theme switch repaints these without any JS.
    blob.style.color = themeVar(token);
    blob.style.backgroundColor = themeVar(token, 0.13);
    blob.style.borderColor = themeVar(token, 0.35);
    return blob;
}

export function createModelAvatar(modelId) {
    if (!modelId || typeof modelId !== 'string') {
        const fallback = document.createElement('i');
        fallback.setAttribute('data-lucide', 'bot');
        fallback.className = 'w-5 h-5 text-gb-aquaAccent shrink-0';
        return fallback;
    }

    const provider = resolveProvider(modelId);
    if (!provider) return createBlob(modelId);

    const img = document.createElement('img');
    img.src = provider.logo;
    img.alt = provider.name || modelId;
    img.title = modelId;
    img.className = 'w-5 h-5 rounded-sm object-contain bg-white p-0.5 shrink-0';
    img.onerror = () => {
        if (img.isConnected) img.replaceWith(createBlob(modelId));
    };
    return img;
}
