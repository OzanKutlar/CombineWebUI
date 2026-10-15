import { store } from './storage.js';
import { IDENTITY_PLACEHOLDER, MAX_IDENTITY_TEXT } from './config.js';

/**
 * Per-request agent identity for combineCopy prompts.
 *
 * Only the system-instructions part of a message is rewritten. File context
 * that happens to contain an <identity> block or the placeholder token (for
 * example combineCopy's own prompts.py) reaches the model byte for byte, so
 * the model's search blocks still match the real file. Saved messages are
 * never modified: this runs on the outgoing copy built for one request.
 */

const SYSTEM_MARKER = '--- SYSTEM INSTRUCTIONS ---';
const PERSONA_TAIL = 'a powerful agentic AI coding assistant';
// Exactly what combineCopy emits for its dynamic identity preset.
const PLACEHOLDER_LINE = 'You are ' + IDENTITY_PLACEHOLDER + ', ' + PERSONA_TAIL + '.';
const MAX_BLOCK_REWRITES = 20;

// The first line directly inside an <identity> block, when it starts with You are.
const IDENTITY_LINE_RE = /(<identity>[ \t]*\r?\n[ \t]*)(You are [^\r\n]*)/g;

const PRESETS = Object.freeze({
    antigravity: Object.freeze({
        name: 'Antigravity',
        line: 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.'
    }),
    claude: Object.freeze({
        name: 'Claude',
        line: 'You are Claude, a powerful agentic AI coding assistant created by Anthropic.'
    }),
    gemini: Object.freeze({
        name: 'Gemini',
        line: 'You are Gemini, a powerful agentic AI coding assistant created by Google.'
    }),
    chatgpt: Object.freeze({
        name: 'ChatGPT',
        line: 'You are ChatGPT, a powerful agentic AI coding assistant created by OpenAI.'
    }),
    neutral: Object.freeze({
        name: 'the assistant',
        line: 'You are a powerful agentic AI coding assistant.'
    })
});

// Model id patterns are checked before provider ids, so a Claude model served
// through a generic endpoint is still recognised.
const FAMILY_RULES = Object.freeze([
    { preset: 'claude', providers: ['anthropic'], pattern: /claude|sonnet|opus|haiku/ },
    { preset: 'gemini', providers: ['google'], pattern: /gemini/ },
    { preset: 'chatgpt', providers: ['openai'], pattern: /gpt|codex|(?:^|[^a-z0-9])o[1-9](?:[^a-z0-9]|$)/ }
]);

function identityFromName(name) {
    return { name, line: 'You are ' + name + ', ' + PERSONA_TAIL + '.' };
}

function findModel(modelId) {
    const models = Array.isArray(store.allModels) ? store.allModels : [];
    return models.find(m => m && (m.id === modelId || m.raw_id === modelId)) || null;
}

function providerIdOf(model) {
    return (model && typeof model.provider_id === 'string') ? model.provider_id : '';
}

function providerGroupName(model) {
    const pid = providerIdOf(model);
    if (!pid || pid === 'other') return '';
    const groups = Array.isArray(store.allProviders) ? store.allProviders : [];
    const group = groups.find(g => g && g.id === pid);
    return (group && typeof group.name === 'string') ? group.name.trim().slice(0, MAX_IDENTITY_TEXT) : '';
}

function detectPreset(modelId, model) {
    const rawId = (model && typeof model.raw_id === 'string') ? model.raw_id : '';
    const haystack = (modelId + ' ' + rawId).toLowerCase();
    for (const rule of FAMILY_RULES) {
        if (rule.pattern.test(haystack)) return rule.preset;
    }
    const pid = providerIdOf(model);
    for (const rule of FAMILY_RULES) {
        if (rule.providers.indexOf(pid) !== -1) return rule.preset;
    }
    return '';
}

/** Without a target model there is nothing to match, so the prompt is left alone. */
function resolveAuto(modelId) {
    if (typeof modelId !== 'string' || !modelId) return null;
    const model = findModel(modelId);
    const preset = detectPreset(modelId, model);
    if (preset) return PRESETS[preset];
    const groupName = providerGroupName(model);
    return groupName ? identityFromName(groupName) : PRESETS.neutral;
}

/** A bare name gets the standard persona line; a full You are sentence is used as is. */
function resolveCustom(text) {
    const clean = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, MAX_IDENTITY_TEXT);
    if (!clean) return PRESETS.neutral;
    if (!/^you are\s/i.test(clean)) return identityFromName(clean);
    const name = clean.replace(/^you are\s+/i, '').split(/[,.]/)[0].trim();
    return { name: name || PRESETS.neutral.name, line: clean };
}

/**
 * The { name, line } identity for a request to `modelId`, or null when the
 * prompt should be sent unchanged.
 */
export function resolveIdentity(modelId) {
    const prefs = store.identityPrefs || {};
    const mode = typeof prefs.mode === 'string' ? prefs.mode : 'auto';
    if (mode === 'off') return null;
    if (mode === 'auto') return resolveAuto(modelId);
    if (mode === 'custom') return resolveCustom(prefs.customText);
    return Object.prototype.hasOwnProperty.call(PRESETS, mode) ? PRESETS[mode] : null;
}

function rewriteIdentityBlocks(text, line) {
    let count = 0;
    return text.replace(IDENTITY_LINE_RE, (match, prefix) => {
        count += 1;
        return count > MAX_BLOCK_REWRITES ? match : prefix + line;
    });
}

function rewriteSection(section, identity, overrideHardcoded) {
    let out = section;
    if (out.indexOf(IDENTITY_PLACEHOLDER) !== -1) {
        // split/join rather than a regex, so custom text is never read as a pattern.
        out = out.split(PLACEHOLDER_LINE).join(identity.line);
        out = out.split(IDENTITY_PLACEHOLDER).join(identity.name);
    }
    if (overrideHardcoded) out = rewriteIdentityBlocks(out, identity.line);
    return out;
}

/**
 * Where the system instructions start. The last marker is used because file
 * context comes first and may itself mention the marker. A message with no
 * marker is only treated as instructions when it opens with an <identity> block.
 */
function systemSectionStart(content) {
    const idx = content.lastIndexOf(SYSTEM_MARKER);
    if (idx !== -1) return idx;
    return /^\s*<identity>/.test(content) ? 0 : -1;
}

/** Returns `content` with its identity tailored to `modelId`. Never throws. */
export function applyIdentity(content, modelId) {
    if (typeof content !== 'string' || !content) return typeof content === 'string' ? content : '';
    const start = systemSectionStart(content);
    if (start === -1) return content;

    let identity = null;
    try {
        identity = resolveIdentity(modelId);
    } catch (e) {
        console.warn('Could not resolve the agent identity; sending the prompt unchanged', e);
        return content;
    }
    if (!identity) return content;

    const prefs = store.identityPrefs || {};
    const tail = rewriteSection(content.slice(start), identity, prefs.overrideHardcoded !== false);
    return content.slice(0, start) + tail;
}
