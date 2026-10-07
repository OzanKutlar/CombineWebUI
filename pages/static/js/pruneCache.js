import { store, getStoredTokenLimit } from './storage.js';
import {
    DEFAULT_TOKEN_LIMIT,
    PRUNE_POLICY_IMMEDIATE,
    DEFAULT_CACHE_TTL_SECONDS,
    MIN_CACHE_TTL_SECONDS,
    MAX_CACHE_TTL_SECONDS,
    CONTEXT_PRESSURE_RATIO,
    MAX_CACHE_SCOPES
} from './config.js';
import { desiredPrunePaths, buildContentForPaths, normalizePath } from './pruneManual.js';
import { scanFileBlocksForText } from './promptParser.js';
import { countTokens } from './tokens.js';

/**
 * Cache-aware pruning.
 *
 * A user message's prune set (model + manual) is the *desired* state, and
 * `msg.content` always reflects it. What is actually sent is resolved here,
 * per target model, at send time:
 *
 *   cold cache -> the desired set, so a model meeting the thread for the first
 *                 time (or after its cache expired) gets the pruned form
 *   warm cache -> exactly the set that model was last sent, minus anything
 *                 restored since, so the cached prefix survives
 *   commit     -> the desired set, on Immediate policy or after Apply now
 *
 * Once a warm prefix is broken anyway (a restore, an edit, a message the model
 * never saw), every later message gets the desired set: the cache is already
 * lost from that point, so pending prunes there cost nothing extra.
 *
 * State: `conv.cacheWarmth[modelId]` is the last send time, and
 * `msg.sentPrunes[modelId]` the paths sent pruned for that message.
 */

const MODE_WARM = 'warm';
const MODE_COLD = 'cold';
const MODE_COMMIT = 'commit';

const pendingTokenMemo = new WeakMap();

export function clampCacheTtl(value) {
    if (value === null || value === undefined || value === '') return DEFAULT_CACHE_TTL_SECONDS;
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_CACHE_TTL_SECONDS;
    return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, Math.round(n)));
}

/** Policy and TTL for a model, from the endpoint fields /v1/models reports. */
export function getModelCachePolicy(modelId) {
    const models = Array.isArray(store.allModels) ? store.allModels : [];
    const model = (typeof modelId === 'string' && modelId)
        ? (models.find(m => m && m.id === modelId) || null)
        : null;
    return {
        immediate: Boolean(model) && model.prune_policy === PRUNE_POLICY_IMMEDIATE,
        ttlMs: clampCacheTtl(model ? model.cache_ttl_seconds : null) * 1000
    };
}

export function formatCountdown(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return mins + ':' + (secs < 10 ? '0' + secs : String(secs));
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUserMessage(msg) {
    return Boolean(msg) && msg.role === 'user' && typeof msg.content === 'string';
}

function messageText(msg) {
    return (msg && typeof msg.content === 'string') ? msg.content : '';
}

/** Milliseconds since the last send to this model, or null if never sent. */
function warmAge(conv, modelId, now) {
    if (!conv || !isPlainObject(conv.cacheWarmth)) return null;
    const ts = Number(conv.cacheWarmth[modelId]);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const age = now - ts;
    return age >= 0 ? age : null;
}

function resolveMode(conv, modelId, now) {
    const policy = getModelCachePolicy(modelId);
    if (policy.immediate || conv.pruneCommitRequested === true) return MODE_COMMIT;
    const age = warmAge(conv, modelId, now);
    return (age !== null && age < policy.ttlMs) ? MODE_WARM : MODE_COLD;
}

function readSentPaths(msg, modelId) {
    if (!isPlainObject(msg.sentPrunes)) return null;
    const list = msg.sentPrunes[modelId];
    return Array.isArray(list) ? list.filter(p => typeof p === 'string' && p) : null;
}

function intersectPaths(list, desired) {
    const out = new Map();
    list.forEach(path => {
        const key = normalizePath(path);
        if (desired.has(key)) out.set(key, desired.get(key));
    });
    return out;
}

/**
 * One entry per message: null for anything that is not a user message,
 * otherwise { desired, sent } as path -> reason maps. `sent` is always a
 * subset of `desired`.
 */
function planSentPaths(messages, modelId, mode) {
    const plan = [];
    let broken = mode !== MODE_WARM;
    messages.forEach(msg => {
        if (!isUserMessage(msg)) {
            plan.push(null);
            return;
        }
        const desired = desiredPrunePaths(msg);
        let sent = desired;
        if (!broken) {
            const last = readSentPaths(msg, modelId);
            if (last === null) {
                // Never sent to this model, so nothing from here on is cached.
                broken = true;
            } else {
                sent = intersectPaths(last, desired);
                // A restore changes this message, which breaks everything after it.
                if (sent.size !== last.length) broken = true;
            }
        }
        plan.push({ desired, sent });
    });
    return plan;
}

function materialize(messages, plan) {
    const result = { messages: [], sentPaths: [], sentPrunedIdx: [], pendingCount: 0, tokens: 0 };
    messages.forEach((msg, i) => {
        const entry = plan[i];
        if (!entry) {
            result.messages.push(msg);
            result.sentPaths.push(null);
            result.tokens += countTokens(messageText(msg));
            return;
        }
        const complete = entry.sent.size === entry.desired.size;
        const content = complete ? msg.content : buildContentForPaths(msg, entry.sent);
        result.messages.push(complete ? msg : Object.assign({}, msg, { content }));
        const keys = Array.from(entry.sent.keys());
        result.sentPaths.push(keys);
        if (keys.length > 0) result.sentPrunedIdx.push(i);
        result.pendingCount += entry.desired.size - entry.sent.size;
        result.tokens += countTokens(content);
    });
    return result;
}

function exceedsContextPressure(tokens, modelId) {
    const limit = getStoredTokenLimit(modelId) || DEFAULT_TOKEN_LIMIT;
    return tokens > limit * CONTEXT_PRESSURE_RATIO;
}

/**
 * Resolves what `messages` should look like when sent to `modelId` now.
 * Returns { messages, sentPaths, sentPrunedIdx, pendingCount, tokens, reason }.
 * Messages that need no change are the stored objects; the rest are shallow
 * copies, so the stored thread is never mutated here.
 */
export function buildOutgoingMessages(conv, messages, modelId, now) {
    const list = Array.isArray(messages) ? messages : [];
    if (!conv || typeof modelId !== 'string' || !modelId) {
        return Object.assign(materialize(list, planSentPaths(list, '', MODE_COMMIT)), { reason: MODE_COMMIT });
    }

    const mode = resolveMode(conv, modelId, now);
    const result = materialize(list, planSentPaths(list, modelId, mode));
    if (mode !== MODE_WARM || result.pendingCount === 0) return Object.assign(result, { reason: mode });
    if (!exceedsContextPressure(result.tokens, modelId)) return Object.assign(result, { reason: mode });

    return Object.assign(materialize(list, planSentPaths(list, modelId, MODE_COMMIT)), { reason: 'context-pressure' });
}

function trimScopes(warmth) {
    const keys = Object.keys(warmth);
    if (keys.length <= MAX_CACHE_SCOPES) return;
    keys.sort((a, b) => (Number(warmth[a]) || 0) - (Number(warmth[b]) || 0));
    keys.slice(0, keys.length - MAX_CACHE_SCOPES).forEach(k => {
        delete warmth[k];
    });
}

function writeSentPaths(msg, modelId, keys, warmth) {
    if (!isPlainObject(msg.sentPrunes)) msg.sentPrunes = {};
    msg.sentPrunes[modelId] = keys.slice();
    // Scopes evicted from the warmth map can never be warm again.
    Object.keys(msg.sentPrunes).forEach(k => {
        if (!Object.prototype.hasOwnProperty.call(warmth, k)) delete msg.sentPrunes[k];
    });
}

/**
 * Records that `outgoing` (from buildOutgoingMessages) was sent to `modelId`
 * at `now`. `messages` must be the stored message objects, not the copies.
 * Consumes any pending Apply now request.
 */
export function recordSend(conv, messages, modelId, outgoing, now) {
    if (!conv || typeof modelId !== 'string' || !modelId) return;
    if (!outgoing || !Array.isArray(outgoing.sentPaths)) return;

    if (!isPlainObject(conv.cacheWarmth)) conv.cacheWarmth = {};
    conv.cacheWarmth[modelId] = now;
    trimScopes(conv.cacheWarmth);

    const list = Array.isArray(messages) ? messages : [];
    list.forEach((msg, i) => {
        const keys = outgoing.sentPaths[i];
        if (Array.isArray(keys) && isUserMessage(msg)) writeSentPaths(msg, modelId, keys, conv.cacheWarmth);
    });
    delete conv.pruneCommitRequested;
}

function pendingKeysOf(entry) {
    const keys = [];
    if (!entry) return keys;
    entry.desired.forEach((_, key) => {
        if (!entry.sent.has(key)) keys.push(key);
    });
    return keys;
}

/** Baseline tokens of the files still held back. Memoized per message. */
function pendingTokensFor(msg, keys) {
    if (!isUserMessage(msg) || keys.length === 0) return 0;
    const baseline = (typeof msg.originalContent === 'string' && msg.originalContent)
        ? msg.originalContent
        : msg.content;
    const signature = baseline.length + '|' + keys.slice().sort().join('\n');
    const memo = pendingTokenMemo.get(msg);
    if (memo && memo.signature === signature) return memo.tokens;

    const wanted = new Set(keys);
    let tokens = 0;
    scanFileBlocksForText(baseline).forEach(block => {
        if (block && !block.isPruned && wanted.has(normalizePath(block.path))) {
            tokens += countTokens(block.content || '');
        }
    });
    pendingTokenMemo.set(msg, { signature, tokens });
    return tokens;
}

function emptySummary(conv) {
    return {
        count: 0,
        tokens: 0,
        secondsLeft: 0,
        commitRequested: Boolean(conv) && conv.pruneCommitRequested === true,
        byIndex: new Map()
    };
}

/**
 * Prunes held back for `modelId` right now. Empty unless that model's cache is
 * warm under the Deferred policy. `byIndex` maps message index -> Set of keys.
 * With Apply now requested, the pending set is still reported, and flagged.
 */
export function getPendingSummary(conv, modelId, now) {
    const summary = emptySummary(conv);
    if (!conv || !Array.isArray(conv.messages)) return summary;
    if (typeof modelId !== 'string' || !modelId) return summary;

    const policy = getModelCachePolicy(modelId);
    if (policy.immediate) return summary;
    const age = warmAge(conv, modelId, now);
    if (age === null || age >= policy.ttlMs) return summary;

    planSentPaths(conv.messages, modelId, MODE_WARM).forEach((entry, i) => {
        const keys = pendingKeysOf(entry);
        if (keys.length === 0) return;
        summary.byIndex.set(i, new Set(keys));
        summary.count += keys.length;
        summary.tokens += pendingTokensFor(conv.messages[i], keys);
    });
    summary.secondsLeft = Math.max(0, Math.ceil((policy.ttlMs - age) / 1000));
    return summary;
}

/** Pending file count across the given message indices. */
export function countPendingAt(summary, indices) {
    if (!summary || !(summary.byIndex instanceof Map) || !Array.isArray(indices)) return 0;
    let total = 0;
    indices.forEach(idx => {
        const keys = summary.byIndex.get(idx);
        if (keys) total += keys.size;
    });
    return total;
}

/** Marks the thread so the next send commits every pending prune. */
export function requestPruneCommit(conv) {
    if (!conv || typeof conv !== 'object') return false;
    conv.pruneCommitRequested = true;
    return true;
}
