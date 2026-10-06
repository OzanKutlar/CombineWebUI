import { scanFileBlocksForText } from './promptParser.js';
import { countTokens } from './tokens.js';

/**
 * Single source of truth for every write to a user message's `content` that
 * relates to pruning.
 *
 * Both the model-driven PRUNE payload and the manual drawer funnel through
 * rebuildMessageContent(), which recomputes the message from its pristine
 * baseline by applying the union of the two prune sets. That is what stops
 * one from silently discarding the other, and it makes every prune reversible
 * regardless of the order the two were applied in.
 */

export const DEFAULT_MANUAL_REASON = 'Manually pruned by user';

const PRUNED_PREFIX = '(Has been removed from context because:';
const MAX_INDEX_ROWS = 2000;
const MAX_REASON_CHARS = 120;

// Anchored at the start of a block slice, so it can only ever match that
// block's own header rather than the next one down the file.
const HEADER_RE = /^-{35}\r?\nFILE: .*?\r?\n-{35}\r?\n/;
const OPEN_FENCE_RE = /^[ \t]*```[\w.+-]*\r?\n/;

export function normalizePath(path) {
    if (typeof path !== 'string') return '';
    return path.trim().replace(/\\/g, '/');
}

/**
 * Reasons are user input that gets embedded directly into the payload text,
 * so anything that could terminate a code fence or split a line is stripped.
 */
export function sanitizeReason(reason) {
    const raw = typeof reason === 'string' ? reason : '';
    const clean = raw
        .replace(/[`\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return DEFAULT_MANUAL_REASON;
    return clean.slice(0, MAX_REASON_CHARS);
}

function extensionOf(key) {
    const name = key.split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Pristine text for a user message, captured once and never overwritten. */
export function getBaseline(msg) {
    if (!msg || typeof msg.content !== 'string') return '';
    if (typeof msg.originalContent !== 'string' || !msg.originalContent) {
        msg.originalContent = msg.content;
    }
    return msg.originalContent;
}

/** Non-mutating read, for the index builder and other hot paths. */
function readBaseline(msg) {
    if (!msg || typeof msg.content !== 'string') return '';
    return (typeof msg.originalContent === 'string' && msg.originalContent)
        ? msg.originalContent
        : msg.content;
}

/** Map of normalized path -> reason for every block already carrying the marker. */
export function collectPrunedPaths(text) {
    const map = new Map();
    if (typeof text !== 'string' || !text) return map;

    scanFileBlocksForText(text).forEach(block => {
        if (!block || !block.isPruned) return;
        const key = normalizePath(block.path);
        if (key) map.set(key, block.prunedReason || '');
    });
    return map;
}

function resolveTarget(blockPath, targets) {
    if (targets.has(blockPath)) return targets.get(blockPath);

    let found = null;
    targets.forEach((reason, target) => {
        if (found !== null) return;
        if (blockPath.endsWith('/' + target)) found = reason;
    });
    return found;
}

/**
 * Replaces the body of every matching FILE block with the pruned marker.
 *
 * Block boundaries come from the same scanner the renderer uses, so a CRLF
 * payload or an unfenced `-js` style block is handled identically here and on
 * screen. Returns null when nothing matched, so callers can skip cheaply.
 */
export function pruneFilesFromContent(content, pruneFiles) {
    if (typeof content !== 'string' || !content) return null;
    if (!Array.isArray(pruneFiles) || pruneFiles.length === 0) return null;

    const targets = new Map();
    pruneFiles.forEach(f => {
        if (!f || f.stay !== false) return;
        const path = normalizePath(f.path);
        if (!path || !f.reason) return;
        targets.set(path, sanitizeReason(f.reason));
    });
    if (targets.size === 0) return null;

    const blocks = scanFileBlocksForText(content);
    if (blocks.length === 0) return null;

    let result = content;
    let mutated = false;

    // Applied back-to-front so every offset still refers to unmodified text
    // by the time it is used.
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (!block || block.isPruned) continue;

        const reason = resolveTarget(normalizePath(block.path), targets);
        if (reason === null) continue;

        const headerMatch = HEADER_RE.exec(content.slice(block.start, block.end));
        if (!headerMatch) continue;

        const bodyStart = block.start + headerMatch[0].length;
        const rawBody = content.slice(bodyStart, block.end);
        const fenceMatch = OPEN_FENCE_RE.exec(rawBody);

        const marker = PRUNED_PREFIX + ' ' + reason + ')';
        const body = fenceMatch
            ? fenceMatch[0] + marker + '\n```\n\n'
            : marker + '\n\n';

        result = result.slice(0, bodyStart) + body + result.slice(block.end);
        mutated = true;
    }

    return mutated ? result : null;
}

/**
 * Upgrades a legacy message that only carries the rewritten text into an
 * explicit path list, so a later manual restore cannot lose the model's set.
 */
function materializeModelPrunes(msg) {
    if (!msg || msg.modelPrunedPaths) return;
    if (typeof msg.prunedContent !== 'string' || !msg.prunedContent) return;

    const map = {};
    collectPrunedPaths(msg.prunedContent).forEach((reason, path) => {
        map[path] = reason;
    });
    if (Object.keys(map).length > 0) msg.modelPrunedPaths = map;
}

function activeModelPrunes(msg) {
    const map = new Map();
    if (!msg || msg.modelPruneActive === false) return map;

    const stored = msg.modelPrunedPaths;
    if (stored && typeof stored === 'object') {
        Object.keys(stored).forEach(k => map.set(normalizePath(k), sanitizeReason(stored[k])));
        return map;
    }

    if (typeof msg.prunedContent === 'string' && msg.prunedContent) {
        collectPrunedPaths(msg.prunedContent).forEach((reason, path) => map.set(path, reason));
    }
    return map;
}

/**
 * Recomputes `msg.content` from the baseline. Idempotent, and the only place
 * pruning is allowed to assign to `content`. Returns true when it changed.
 */
export function rebuildMessageContent(msg) {
    if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') return false;

    const baseline = readBaseline(msg);
    if (!baseline) return false;

    const applySet = activeModelPrunes(msg);
    const manual = msg.manualPrunedPaths;
    if (manual && typeof manual === 'object') {
        Object.keys(manual).forEach(k => applySet.set(normalizePath(k), sanitizeReason(manual[k])));
    }

    let next = baseline;
    if (applySet.size > 0) {
        const files = [];
        applySet.forEach((reason, path) => files.push({ path, stay: false, reason }));
        next = pruneFilesFromContent(baseline, files) || baseline;
    }

    if (msg.content === next) return false;
    msg.content = next;
    return true;
}

// ---------------------------------------------------------------------------
// File index
// ---------------------------------------------------------------------------

let cachedFingerprint = null;
let cachedIndex = null;

/**
 * Cheap change detector. Content length moves on every prune or edit, and the
 * manual/model flags cover state flips that leave length untouched.
 */
function fingerprint(messages) {
    const parts = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
        const manualCount = (m.manualPrunedPaths && typeof m.manualPrunedPaths === 'object')
            ? Object.keys(m.manualPrunedPaths).length
            : 0;
        parts.push(i + ':' + m.content.length + ':' + manualCount + ':' + (m.modelPruneActive === false ? 0 : 1));
    }
    return parts.join('|');
}

export function invalidateFileIndex() {
    cachedFingerprint = null;
    cachedIndex = null;
}

/**
 * One row per distinct path across every user message in the thread, with the
 * individual occurrences attached. Bounded at MAX_INDEX_ROWS so a pathological
 * payload cannot stall the render.
 */
export function buildFileIndex(messages) {
    if (!Array.isArray(messages)) return [];

    const fp = fingerprint(messages);
    if (cachedIndex && cachedFingerprint === fp) return cachedIndex;

    const rows = new Map();
    let userCount = 0;

    for (let i = 0; i < messages.length; i++) {
        if (rows.size >= MAX_INDEX_ROWS) break;

        const msg = messages[i];
        if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;
        userCount += 1;

        const baseline = readBaseline(msg);
        if (baseline.indexOf('FILE: ') === -1) continue;

        const blocks = scanFileBlocksForText(baseline);
        if (blocks.length === 0) continue;

        // State comes from the live text; sizes come from the baseline, so a
        // pruned file still reports what it would cost if restored.
        const prunedNow = collectPrunedPaths(msg.content);
        const manual = (msg.manualPrunedPaths && typeof msg.manualPrunedPaths === 'object')
            ? msg.manualPrunedPaths
            : {};
        const label = 'U' + userCount;

        blocks.forEach(block => {
            const key = normalizePath(block.path);
            if (!key) return;

            let row = rows.get(key);
            if (!row) {
                if (rows.size >= MAX_INDEX_ROWS) return;
                row = {
                    key,
                    path: block.path,
                    ext: extensionOf(key),
                    tokens: 0,
                    prunedTokens: 0,
                    count: 0,
                    prunedCount: 0,
                    manualCount: 0,
                    partialCount: 0,
                    reason: '',
                    firstIndex: i,
                    labels: [],
                    occurrences: []
                };
                rows.set(key, row);
            }

            const isPruned = prunedNow.has(key);
            const isManual = Object.prototype.hasOwnProperty.call(manual, key);
            const tokens = countTokens(block.content || '');

            row.occurrences.push({ messageIndex: i, label, tokens, isPruned, isManual });
            row.count += 1;
            row.tokens += tokens;
            if (isPruned) {
                row.prunedCount += 1;
                row.prunedTokens += tokens;
                if (!row.reason) row.reason = prunedNow.get(key) || '';
            }
            if (isManual) row.manualCount += 1;
            if (block.isPartial) row.partialCount += 1;
            if (row.labels.indexOf(label) === -1) row.labels.push(label);
        });
    }

    const list = [];
    rows.forEach(row => {
        row.isPruned = row.count > 0 && row.prunedCount === row.count;
        row.isMixed = row.prunedCount > 0 && row.prunedCount < row.count;
        row.isPartial = row.partialCount > 0;
        list.push(row);
    });

    cachedFingerprint = fp;
    cachedIndex = list;
    return list;
}

export function computeTotals(rows) {
    const totals = { files: 0, copies: 0, pruned: 0, tokens: 0, saved: 0 };
    if (!Array.isArray(rows)) return totals;

    rows.forEach(row => {
        totals.files += 1;
        totals.copies += row.count;
        totals.pruned += row.prunedCount;
        totals.tokens += row.tokens;
        totals.saved += row.prunedTokens;
    });
    return totals;
}

/**
 * Prunes or restores `keys` across every user message that actually carries
 * them. Restoring clears the path from both the manual and the model set, so a
 * file the AI pruned can be brought back from the drawer directly.
 * Returns the number of messages touched.
 */
export function setPruneState(messages, keys, shouldPrune, reason) {
    if (!Array.isArray(messages) || !Array.isArray(keys) || keys.length === 0) return 0;

    const wanted = new Set(keys.map(normalizePath).filter(Boolean));
    if (wanted.size === 0) return 0;

    const cleanReason = sanitizeReason(reason);
    let touched = 0;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;

        const baseline = getBaseline(msg);
        if (!baseline || baseline.indexOf('FILE: ') === -1) continue;

        const available = new Set();
        scanFileBlocksForText(baseline).forEach(b => {
            const k = normalizePath(b.path);
            if (k) available.add(k);
        });
        if (available.size === 0) continue;

        materializeModelPrunes(msg);

        let changed = false;
        wanted.forEach(key => {
            if (!available.has(key)) return;

            if (shouldPrune) {
                if (!msg.manualPrunedPaths || typeof msg.manualPrunedPaths !== 'object') {
                    msg.manualPrunedPaths = {};
                }
                if (msg.manualPrunedPaths[key] !== cleanReason) {
                    msg.manualPrunedPaths[key] = cleanReason;
                    changed = true;
                }
                return;
            }

            if (msg.manualPrunedPaths && Object.prototype.hasOwnProperty.call(msg.manualPrunedPaths, key)) {
                delete msg.manualPrunedPaths[key];
                changed = true;
            }
            if (msg.modelPrunedPaths && Object.prototype.hasOwnProperty.call(msg.modelPrunedPaths, key)) {
                delete msg.modelPrunedPaths[key];
                changed = true;
            }
        });

        if (!changed) continue;

        if (msg.manualPrunedPaths && Object.keys(msg.manualPrunedPaths).length === 0) {
            delete msg.manualPrunedPaths;
        }
        // The legacy snapshot would resurrect whatever was just cleared, and the
        // explicit path list has already been materialized above.
        if (!shouldPrune) delete msg.prunedContent;

        rebuildMessageContent(msg);
        touched += 1;
    }

    if (touched > 0) invalidateFileIndex();
    return touched;
}

/** Drops every manual prune in the thread, leaving the model's set intact. */
export function restoreAllManual(messages) {
    if (!Array.isArray(messages)) return 0;

    let touched = 0;
    messages.forEach(msg => {
        if (!msg || msg.role !== 'user') return;
        if (!msg.manualPrunedPaths) return;
        delete msg.manualPrunedPaths;
        rebuildMessageContent(msg);
        touched += 1;
    });

    if (touched > 0) invalidateFileIndex();
    return touched;
}
