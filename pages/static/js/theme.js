import { store } from './storage.js';
import { DEFAULT_THEME } from './config.js';

/**
 * Theme runtime.
 *
 * A theme is nothing more than a `data-theme` attribute on <html>; every
 * colour in the app resolves through the custom properties that attribute
 * selects in themes.css. This module owns validation, application, and the
 * one case that CSS cannot cover on its own: reading a token back out as a
 * concrete hex string for the few places that build SVG fills in JS.
 *
 * Adding a theme means adding an entry here and a matching [data-theme]
 * block in themes.css. Nothing else needs to change.
 */

export const THEMES = [
    {
        id: 'dark',
        label: 'Gruvbox Dark',
        description: 'The original balanced palette.',
        meta: '#1d2021',
        preview: ['#1d2021', '#3c3836', '#83a598', '#8ec07c', '#fabd2f']
    },
    {
        id: 'hard',
        label: 'Midnight Hard',
        description: 'Near-black surfaces for low-light rooms.',
        meta: '#0a0b0c',
        preview: ['#0a0b0c', '#1a1d1e', '#83a598', '#8ec07c', '#fabd2f']
    },
    {
        id: 'light',
        label: 'Gruvbox Light',
        description: 'Warm cream surfaces with dark text.',
        meta: '#f9f5d7',
        preview: ['#f9f5d7', '#ebdbb2', '#076678', '#427b58', '#b57614']
    }
];

export const THEME_EVENT = 'ag:theme-changed';

const THEME_IDS = THEMES.map(t => t.id);

export function isValidTheme(id) {
    return typeof id === 'string' && THEME_IDS.indexOf(id) !== -1;
}

/** Unknown ids collapse to the default rather than leaving the DOM undefined. */
export function normalizeTheme(id) {
    return isValidTheme(id) ? id : DEFAULT_THEME;
}

export function getTheme(id) {
    const target = normalizeTheme(id);
    return THEMES.find(t => t.id === target) || THEMES[0];
}

/** Keeps mobile browser chrome in step with the page. */
function updateMetaThemeColor(themeId) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    meta.setAttribute('content', getTheme(themeId).meta);
}

/**
 * Applies a theme to the document. Idempotent, and safe to call with a bad
 * id. Pass `{ silent: true }` during boot so listeners that only care about
 * *changes* are not woken by the initial paint.
 */
export function applyTheme(id, options) {
    const theme = normalizeTheme(id);
    const root = document.documentElement;

    if (root.getAttribute('data-theme') !== theme) {
        root.setAttribute('data-theme', theme);
    }
    updateMetaThemeColor(theme);

    if (!options || options.silent !== true) {
        try {
            window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
        } catch (e) {
            console.warn('Failed to dispatch theme change event', e);
        }
    }
    return theme;
}

function toHexPair(value) {
    const clamped = Math.max(0, Math.min(255, Math.round(value)));
    const hex = clamped.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
}

/**
 * Resolves a token to a `#rrggbb` string, for the handful of call sites that
 * must hand a literal colour to something CSS cannot reach (inline SVG fill
 * attributes, chart series definitions).
 *
 * Tokens hold RGB triples, so the triple is converted here. A token that is
 * missing or malformed falls back rather than producing `#NaNNaNNaN`.
 */
export function readThemeColor(token, fallback) {
    const safeFallback = fallback || '#000000';
    if (typeof token !== 'string' || !token) return safeFallback;

    try {
        const raw = getComputedStyle(document.documentElement)
            .getPropertyValue(token)
            .trim();
        if (!raw) return safeFallback;
        if (raw.charAt(0) === '#') return raw;

        const parts = raw.split(/[\s,]+/).filter(Boolean).map(Number);
        if (parts.length < 3) return safeFallback;
        for (let i = 0; i < 3; i++) {
            if (!Number.isFinite(parts[i])) return safeFallback;
        }
        return '#' + toHexPair(parts[0]) + toHexPair(parts[1]) + toHexPair(parts[2]);
    } catch (e) {
        console.warn('Failed to resolve theme token ' + token, e);
        return safeFallback;
    }
}

/**
 * A `rgb(var(--token) / alpha)` string. Preferred over readThemeColor when the
 * value lands in an inline style, since it stays live across theme changes
 * instead of freezing the colour at assignment time.
 */
export function themeVar(token, alpha) {
    if (typeof alpha === 'number' && Number.isFinite(alpha)) {
        return 'rgb(var(' + token + ') / ' + alpha + ')';
    }
    return 'rgb(var(' + token + '))';
}

/** Boot-time application, from whatever the store hydrated out of localStorage. */
export function initTheme() {
    const resolved = normalizeTheme(store.theme);
    store.theme = resolved;
    return applyTheme(resolved, { silent: true });
}
