import { store, persistAutoNameModel } from './storage.js';
import { AUTO_NAME_MAX_CHARS } from './config.js';
import { parseCombineCopyPrompt } from './promptParser.js';

/**
 * Auto-naming support: which model performs the naming, and what text it is
 * allowed to see. The naming basis is deliberately narrow so titles describe
 * the actual task rather than the surrounding prompt scaffolding.
 */

const BUILTIN_PROVIDER_IDS = ['openai', 'anthropic', 'google'];

// Built fresh per call so a stale lastIndex can never leak between callers.
function pruneJsonRegex() {
    return /```(?:json)?\s*\{[\s\S]*?"phase"\s*:\s*"PRUNE"[\s\S]*?\}\s*```/ig;
}

// Tempered so a match can never start in an earlier fenced block and run across it.
function selectJsonRegex() {
    return /```(?:json)?\s*\{(?:(?!```)[\s\S])*?"phase"\s*:\s*"SELECT"(?:(?!```)[\s\S])*?\}\s*```/ig;
}

// Anchored to the closing fence rather than the first '}', since an
// EXECUTION payload's file contents can themselves contain literal braces.
function executionJsonRegex() {
    return /```(?:json)?\s*\{[\s\S]*?"phase"\s*:\s*"EXECUTION"[\s\S]*?\n```/ig;
}

function payloadTagRegex() {
    return /<antigravity_payload>[\s\S]*?<\/antigravity_payload>/ig;
}

function isSelectable(model) {
    if (!model || typeof model.id !== 'string' || !model.id) return false;
    return store.hiddenModels.indexOf(model.id) === -1;
}

/**
 * Every non-hidden model is eligible to perform auto-naming and auto-foldering.
 * Copilot models included: they cost premium credits, so the UI warns, but the
 * choice belongs to the user rather than to this filter.
 */
export function getAutoNameCandidates() {
    const models = Array.isArray(store.allModels) ? store.allModels : [];
    return models.filter(isSelectable);
}

/**
 * True when using the model costs nothing upstream. Prefers the backend's
 * explicit is_metered flag (set when the endpoint reports a premium
 * multiplier, as copilot-api does), then is_custom, and only falls back to
 * the provider-id heuristic when neither is present.
 */
export function isCustomEndpointModel(model) {
    if (!model) return false;
    if (typeof model.is_metered === 'boolean') return !model.is_metered;
    if (typeof model.is_custom === 'boolean') return model.is_custom;
    const pid = model.provider_id || 'other';
    return BUILTIN_PROVIDER_IDS.indexOf(pid) === -1;
}

/**
 * Whether naming with this model will consume Copilot premium credits.
 * Exported so the picker can warn without duplicating the lookup.
 */
export function isCopilotNamingModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    const models = Array.isArray(store.allModels) ? store.allModels : [];
    const model = models.find(m => m && m.id === modelId);
    if (!model) return false;
    return !isCustomEndpointModel(model);
}

/**
 * The default when the user has never chosen. A custom endpoint is preferred so
 * the out-of-the-box behaviour stays free; only when none exists does a
 * credit-consuming model become the default.
 */
export function preferredDefaultModel(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const free = candidates.find(isCustomEndpointModel);
    return free || candidates[0];
}

/**
 * The user's stored choice when it is still selectable, otherwise the preferred
 * default, persisted so the picker and the naming run never disagree.
 * Returns null when no model is available at all.
 */
export function resolveAutoNameModel() {
    const candidates = getAutoNameCandidates();
    if (candidates.length === 0) return null;

    const stored = store.autoNameModel;
    if (stored && candidates.some(m => m.id === stored)) return stored;

    const fallback = preferredDefaultModel(candidates);
    if (!fallback) return null;

    store.autoNameModel = fallback.id;
    persistAutoNameModel();
    return store.autoNameModel;
}

function stripPayloadBlocks(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
        .replace(pruneJsonRegex(), '')
        .replace(selectJsonRegex(), '')
        .replace(executionJsonRegex(), '')
        .replace(payloadTagRegex(), '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * The user's actual request, with every other payload section discarded.
 * A structured payload with no request text yields '' rather than falling
 * back to the raw content, which would reintroduce the scaffolding.
 */
function firstUserRequest(messages) {
    const msg = messages.find(m => m && m.role === 'user' && typeof m.content === 'string');
    if (!msg) return { text: '', index: -1 };

    const parsed = parseCombineCopyPrompt(msg.content);
    const text = parsed.isStructured ? (parsed.userRequest || '') : msg.content;
    return { text: (text || '').trim(), index: messages.indexOf(msg) };
}

function firstAssistantReply(messages, afterIndex) {
    if (afterIndex < 0) return '';
    for (let i = afterIndex + 1; i < messages.length; i++) {
        const m = messages[i];
        if (!m || m.role !== 'assistant' || m.isError === true) continue;
        const cleaned = stripPayloadBlocks(m.content);
        if (cleaned) return cleaned;
    }
    return '';
}

/**
 * The text handed to the naming model: the user's request plus the first
 * assistant reply, concatenated then truncated to AUTO_NAME_MAX_CHARS.
 * Reasoning traces live in their own field and are never included.
 * Returns '' when there is nothing worth naming from.
 */
export function buildNamingBasis(conv) {
    if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) return '';

    const request = firstUserRequest(conv.messages);
    if (!request.text) return '';

    const reply = firstAssistantReply(conv.messages, request.index);
    const combined = reply ? (request.text + '\n\n' + reply) : request.text;
    return combined.slice(0, AUTO_NAME_MAX_CHARS);
}
