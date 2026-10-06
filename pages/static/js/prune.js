import { getActiveConversation } from './storage.js';
import { countTokens } from './tokens.js';
import {
    pruneFilesFromContent,
    collectPrunedPaths,
    getBaseline,
    rebuildMessageContent,
    invalidateFileIndex,
    normalizePath,
    sanitizeReason
} from './pruneManual.js';
import { scanFileBlocksForText } from './promptParser.js';
import { scanJsonObjects, safeJsonParse } from './execution.js';

// Re-exported so existing importers keep working; the implementation now lives
// in pruneManual.js alongside the rest of the prune core.
export { pruneFilesFromContent };

const MAX_PRUNE_XML_CANDIDATES = 20;

function parsePruneXmlFiles(xmlStr) {
    const files = [];
    const fileRegex = /<file>[\s\S]*?<path>(.*?)<\/path>[\s\S]*?<stay>(.*?)<\/stay>[\s\S]*?<reason>([\s\S]*?)<\/reason>[\s\S]*?<\/file>/gi;
    let fm;
    let guard = 0;
    while ((fm = fileRegex.exec(xmlStr)) !== null && guard < 2000) {
        guard++;
        files.push({
            path: fm[1].trim(),
            stay: fm[2].trim().toLowerCase() === 'true',
            reason: fm[3].trim()
        });
    }
    return files;
}

function scanPruneXmlPayloads(text) {
    const results = [];
    // Tempered so a match can never span from one payload into the next.
    const fenceRe = /```(?:xml)?\s*(<antigravity_payload>(?:(?!<\/antigravity_payload>)[\s\S])*?<phase>PRUNE<\/phase>[\s\S]*?<\/antigravity_payload>)\s*```/gi;
    let m;
    let guard = 0;
    while ((m = fenceRe.exec(text)) !== null && guard < MAX_PRUNE_XML_CANDIDATES) {
        results.push({
            raw: m[1],
            fullBlock: m[0],
            start: m.index,
            end: m.index + m[0].length,
            files: parsePruneXmlFiles(m[1])
        });
        guard++;
    }
    if (results.length > 0) return results;

    const tagRe = /<antigravity_payload>(?:(?!<\/antigravity_payload>)[\s\S])*?<phase>PRUNE<\/phase>[\s\S]*?<\/antigravity_payload>/gi;
    guard = 0;
    while ((m = tagRe.exec(text)) !== null && guard < MAX_PRUNE_XML_CANDIDATES) {
        results.push({
            raw: m[0],
            fullBlock: m[0],
            start: m.index,
            end: m.index + m[0].length,
            files: parsePruneXmlFiles(m[0])
        });
        guard++;
    }
    return results;
}

/**
 * Finds and parses all PRUNE payloads in `text` in document order with character offsets.
 * Returns an array of objects: { format, raw, fullBlock, start, end, data, files }.
 */
export function extractAllPrunePayloads(text) {
    if (typeof text !== 'string' || !text) return [];
    const payloads = [];

    const candidates = scanJsonObjects(text);
    for (let i = 0; i < candidates.length; i++) {
        const data = safeJsonParse(candidates[i].raw);
        if (data && data.phase === 'PRUNE' && Array.isArray(data.files)) {
            payloads.push({
                format: 'json',
                raw: candidates[i].raw,
                fullBlock: candidates[i].fullBlock,
                start: candidates[i].start,
                end: candidates[i].end,
                data,
                files: data.files
            });
        }
    }

    if (text.indexOf('<antigravity_payload>') !== -1 && text.indexOf('PRUNE') !== -1) {
        const xmlBlocks = scanPruneXmlPayloads(text);
        for (let i = 0; i < xmlBlocks.length; i++) {
            payloads.push({
                format: 'xml',
                raw: xmlBlocks[i].raw,
                fullBlock: xmlBlocks[i].fullBlock,
                start: xmlBlocks[i].start,
                end: xmlBlocks[i].end,
                data: { phase: 'PRUNE', files: xmlBlocks[i].files },
                files: xmlBlocks[i].files
            });
        }
    }

    payloads.sort((a, b) => a.start - b.start);
    return payloads;
}

export function extractPrunePayload(text) {
    const all = extractAllPrunePayloads(text);
    return all.length > 0 ? all[0] : null;
}

/**
 * Applies a PRUNE payload to every user message above the assistant reply,
 * not just the most recent one, since file context is often split across
 * several turns.
 *
 * The resolved path list is stored on each user message so the model's set can
 * later be toggled or partially cleared without touching the user's own manual
 * prunes. `prunedContent` is still written for backwards compatibility with
 * threads saved by older builds.
 */
export function handlePrunePayload(assistantMsg, conv) {
    if (!assistantMsg || !assistantMsg.content) return;

    const payloads = extractAllPrunePayloads(assistantMsg.content);
    if (payloads.length === 0) {
        delete assistantMsg.pruneInfo;
        return;
    }

    // An explicit thread lets branch replays and finished background responses
    // resolve against the right conversation, not whichever one is on screen.
    const active = (conv && Array.isArray(conv.messages)) ? conv : getActiveConversation();
    if (!active || active.messages.length < 2) return;

    const assistantIdx = active.messages.indexOf(assistantMsg);
    const maxSearchIdx = assistantIdx > -1 ? assistantIdx : active.messages.length;

    // Build a map of file path -> token cost across prior user message baselines
    const pathTokenMap = new Map();
    for (let i = maxSearchIdx - 1; i >= 0; i--) {
        const msg = active.messages[i];
        if (!msg || msg.role !== 'user') continue;
        const baseline = getBaseline(msg);
        if (!baseline || baseline.indexOf('FILE: ') === -1) continue;
        const blocks = scanFileBlocksForText(baseline);
        blocks.forEach(b => {
            const key = normalizePath(b.path);
            if (key && !b.isPruned) {
                const tok = countTokens(b.content || '');
                pathTokenMap.set(key, (pathTokenMap.get(key) || 0) + tok);
            }
        });
    }

    const allPruneFiles = [];
    payloads.forEach(p => {
        if (Array.isArray(p.files)) {
            allPruneFiles.push(...p.files);
        }
    });

    const targetIndices = [];
    let totalTokensSaved = 0;

    for (let i = maxSearchIdx - 1; i >= 0; i--) {
        const msg = active.messages[i];
        if (!msg || msg.role !== 'user') continue;

        const baseline = getBaseline(msg);
        if (!baseline) continue;

        const modelPruned = pruneFilesFromContent(baseline, allPruneFiles);
        if (!modelPruned) continue;

        const before = collectPrunedPaths(baseline);
        const after = collectPrunedPaths(modelPruned);
        const paths = {};
        after.forEach((reason, path) => {
            if (!before.has(path)) paths[path] = reason;
        });
        if (Object.keys(paths).length === 0) continue;

        msg.modelPrunedPaths = paths;
        msg.modelPruneActive = true;
        msg.prunedContent = modelPruned;

        totalTokensSaved += Math.max(0, countTokens(baseline) - countTokens(modelPruned));
        rebuildMessageContent(msg);
        targetIndices.push(i);
    }

    if (targetIndices.length === 0 && payloads.length === 0) return;
    invalidateFileIndex();

    const items = payloads.map(p => {
        const rawFiles = Array.isArray(p.files) ? p.files : [];
        const dropped = [];
        const kept = [];
        let itemTokensSaved = 0;

        rawFiles.forEach(f => {
            const isStay = f.stay === true;
            const pClean = (f.path || '').trim();
            const reasonClean = sanitizeReason(f.reason || '');
            const normKey = normalizePath(pClean);
            const tok = pathTokenMap.get(normKey) || 0;

            if (isStay) {
                kept.push({ path: pClean, reason: reasonClean });
            } else {
                dropped.push({ path: pClean, reason: reasonClean, tokens: tok });
                itemTokensSaved += tok;
            }
        });

        return {
            raw: p.raw,
            fullBlock: p.fullBlock,
            start: p.start,
            end: p.end,
            dropped,
            kept,
            tokensSaved: itemTokensSaved
        };
    });

    assistantMsg.pruneInfo = {
        isPruned: true,
        tokensSaved: totalTokensSaved,
        targetIndices,
        userMsgIndex: targetIndices[0] !== undefined ? targetIndices[0] : -1,
        items
    };
}

/**
 * Clears the model's prune set on any user message pruned by responses that
 * are about to be discarded after cutIndex. Manual prunes are deliberately
 * left in place: the user set those, and the discarded reply did not.
 */
export function restorePrunedFromIndex(messages, cutIndex) {
    if (!Array.isArray(messages)) return;

    let touched = false;
    for (let i = cutIndex + 1; i < messages.length; i++) {
        const m = messages[i];
        if (!m || !m.pruneInfo) continue;

        const indices = Array.isArray(m.pruneInfo.targetIndices)
            ? m.pruneInfo.targetIndices
            : (m.pruneInfo.userMsgIndex > -1 ? [m.pruneInfo.userMsgIndex] : []);

        indices.forEach(idx => {
            if (idx < 0 || idx > cutIndex || idx >= messages.length) return;
            const userMsg = messages[idx];
            if (!userMsg) return;

            delete userMsg.modelPrunedPaths;
            delete userMsg.prunedContent;
            delete userMsg.modelPruneActive;
            rebuildMessageContent(userMsg);
            touched = true;
        });
    }

    if (touched) invalidateFileIndex();
}

const MAX_REAPPLY_MESSAGES = 20000;

function mayContainPrune(content) {
    return typeof content === 'string' && content.indexOf('PRUNE') !== -1;
}

function setModelPruneActive(messages, indices, isActive) {
    if (!Array.isArray(messages) || !Array.isArray(indices)) return;
    indices.forEach(idx => {
        if (!Number.isInteger(idx) || idx < 0 || idx >= messages.length) return;
        const userMsg = messages[idx];
        if (!userMsg || userMsg.role !== 'user') return;
        userMsg.modelPruneActive = isActive;
        rebuildMessageContent(userMsg);
    });
}

/**
 * Replays every model prune on the active path, in thread order, after a
 * branch change. Responses that finished while hidden have never been
 * scanned, so any reply mentioning PRUNE is processed even without pruneInfo.
 * A prune card the user toggled off stays off.
 */
export function reapplyBranchPrunes(conv) {
    if (!conv || !Array.isArray(conv.messages)) return;

    const limit = Math.min(conv.messages.length, MAX_REAPPLY_MESSAGES);
    for (let i = 0; i < limit; i++) {
        const msg = conv.messages[i];
        if (!msg || msg.role !== 'assistant' || msg.isError) continue;
        if (!msg.pruneInfo && !mayContainPrune(msg.content)) continue;

        const keepOff = Boolean(msg.pruneInfo) && msg.pruneInfo.isPruned === false;
        handlePrunePayload(msg, conv);
        if (keepOff && msg.pruneInfo) {
            msg.pruneInfo.isPruned = false;
            setModelPruneActive(conv.messages, msg.pruneInfo.targetIndices, false);
        }
    }
    invalidateFileIndex();
}
