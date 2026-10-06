/**
 * Detects, parses, and summarises EXECUTION payloads emitted by the AI so
 * the chat UI can render a compact file/diff card instead of a raw JSON or
 * XML blob.
 */

import { parseCombineCopyPrompt } from './promptParser.js';
import { diffLineCounts } from './linediff.js';

const MAX_JSON_CANDIDATES = 20;
const MAX_XML_CANDIDATES = 20;
const MAX_LOOP_GUARD = 2000;

/**
 * Bounded state-machine scan for top-level {...} JSON objects in `text`,
 * respecting string quoting so braces inside string values never throw the
 * depth counter off. Mirrors the Python extractor's fallback strategy.
 */
export function scanJsonObjects(text) {
    const results = [];
    let idx = 0;
    let guard = 0;
    while (idx < text.length && guard < MAX_JSON_CANDIDATES) {
        const start = text.indexOf('{', idx);
        if (start === -1) break;

        let depth = 0;
        let inString = false;
        let escapeNext = false;
        let end = -1;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (ch === '\\') { escapeNext = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (!inString) {
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) { end = i; break; }
                }
            }
        }

        if (end !== -1) {
            const raw = text.slice(start, end + 1);
            let blockStart = start;
            let blockEnd = end + 1;

            const beforeFence = text.slice(0, blockStart).match(/```(?:json)?\s*$/i);
            if (beforeFence) blockStart -= beforeFence[0].length;
            const afterFence = text.slice(blockEnd).match(/^\s*```/);
            if (afterFence) blockEnd += afterFence[0].length;

            results.push({
                raw,
                fullBlock: text.slice(blockStart, blockEnd),
                start: blockStart,
                end: blockEnd
            });
            idx = end + 1;
        } else {
            idx = start + 1;
        }
        guard++;
    }
    return results;
}

function scanXmlPayloads(text) {
    const results = [];
    const fenceRe = /```(?:xml)?\s*(<antigravity_payload>[\s\S]*?<\/antigravity_payload>)\s*```/gi;
    let m;
    let guard = 0;
    while ((m = fenceRe.exec(text)) !== null && guard < MAX_XML_CANDIDATES) {
        results.push({
            raw: m[1],
            fullBlock: m[0],
            start: m.index,
            end: m.index + m[0].length
        });
        guard++;
    }
    if (results.length > 0) return results;

    const tagRe = /<antigravity_payload>[\s\S]*?<\/antigravity_payload>/gi;
    guard = 0;
    while ((m = tagRe.exec(text)) !== null && guard < MAX_XML_CANDIDATES) {
        results.push({
            raw: m[0],
            fullBlock: m[0],
            start: m.index,
            end: m.index + m[0].length
        });
        guard++;
    }
    return results;
}

function getTagValue(chunk, tag) {
    const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>');
    const m = re.exec(chunk);
    if (!m) return null;
    const val = m[1];
    const cdataMatch = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(val);
    if (cdataMatch) return cdataMatch[1];
    return val.trim();
}

function parseExecutionXml(xmlStr) {
    const phase = getTagValue(xmlStr, 'phase');
    if (phase !== 'EXECUTION') return null;

    const data = {
        phase,
        markdown: getTagValue(xmlStr, 'markdown'),
        commit_message: getTagValue(xmlStr, 'commit_message'),
        files: []
    };

    const filesMatch = /<files>([\s\S]*?)<\/files>/.exec(xmlStr);
    if (!filesMatch) return data;

    const fileRe = /<file>([\s\S]*?)<\/file>/g;
    let fm;
    let guard = 0;
    while ((fm = fileRe.exec(filesMatch[1])) !== null && guard < MAX_LOOP_GUARD) {
        guard++;
        const chunk = fm[1];
        const fileObj = {
            action: getTagValue(chunk, 'action'),
            path: getTagValue(chunk, 'path')
        };
        const command = getTagValue(chunk, 'command');
        if (command !== null) fileObj.command = command;
        const contentVal = getTagValue(chunk, 'content');
        if (contentVal !== null) fileObj.content = contentVal;

        const srMatch = /<search_replace>([\s\S]*?)<\/search_replace>/.exec(chunk);
        if (srMatch) {
            const blocks = [];
            const blockRe = /<block>([\s\S]*?)<\/block>/g;
            let bm;
            let bguard = 0;
            while ((bm = blockRe.exec(srMatch[1])) !== null && bguard < MAX_LOOP_GUARD) {
                bguard++;
                const s = getTagValue(bm[1], 'search');
                const r = getTagValue(bm[1], 'replace');
                if (s !== null && r !== null) blocks.push({ search: s, replace: r });
            }
            if (blocks.length > 0) fileObj.search_replace = blocks;
        }

        const rrMatch = /<regex_replace>([\s\S]*?)<\/regex_replace>/.exec(chunk);
        if (rrMatch) {
            const blocks = [];
            const blockRe = /<block>([\s\S]*?)<\/block>/g;
            let bm;
            let bguard = 0;
            while ((bm = blockRe.exec(rrMatch[1])) !== null && bguard < MAX_LOOP_GUARD) {
                bguard++;
                const p = getTagValue(bm[1], 'pattern');
                const rep = getTagValue(bm[1], 'replacement');
                if (p !== null && rep !== null) blocks.push({ pattern: p, replacement: rep });
            }
            if (blocks.length > 0) fileObj.regex_replace = blocks;
        }

        data.files.push(fileObj);
    }

    return data;
}

function cleanJsonString(raw) {
    let result = '';
    let inString = false;
    let escapeNext = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (escapeNext) {
            result += ch;
            escapeNext = false;
            continue;
        }
        if (ch === '\\') {
            result += ch;
            escapeNext = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            result += ch;
            continue;
        }
        if (inString) {
            if (ch === '\n') {
                result += '\\n';
            } else if (ch === '\r') {
                result += '\\r';
            } else if (ch === '\t') {
                result += '\\t';
            } else if (ch.charCodeAt(0) < 0x20) {
                const hex = ch.charCodeAt(0).toString(16).padStart(4, '0');
                result += '\\u' + hex;
            } else {
                result += ch;
            }
        } else {
            result += ch;
        }
    }
    return result;
}

export function safeJsonParse(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e1) {
        try {
            const cleaned = cleanJsonString(raw);
            return JSON.parse(cleaned);
        } catch (e2) {
            try {
                const cleaned = cleanJsonString(raw).replace(/,\s*([}\]])/g, '$1');
                return JSON.parse(cleaned);
            } catch (e3) {
                return null;
            }
        }
    }
}

/**
 * Finds and parses all EXECUTION payloads in `text` in document order.
 * Returns an array of objects: { format, raw, fullBlock, start, end, data }.
 */
export function extractAllExecutionPayloads(text) {
    if (typeof text !== 'string' || !text) return [];
    const payloads = [];

    const candidates = scanJsonObjects(text);
    for (let i = 0; i < candidates.length; i++) {
        const data = safeJsonParse(candidates[i].raw);
        if (data && data.phase === 'EXECUTION' && Array.isArray(data.files)) {
            payloads.push({
                format: 'json',
                raw: candidates[i].raw,
                fullBlock: candidates[i].fullBlock,
                start: candidates[i].start,
                end: candidates[i].end,
                data
            });
        }
    }

    if (text.indexOf('<antigravity_payload>') !== -1) {
        const xmlBlocks = scanXmlPayloads(text);
        for (let i = 0; i < xmlBlocks.length; i++) {
            const data = parseExecutionXml(xmlBlocks[i].raw);
            if (data) {
                payloads.push({
                    format: 'xml',
                    raw: xmlBlocks[i].raw,
                    fullBlock: xmlBlocks[i].fullBlock,
                    start: xmlBlocks[i].start,
                    end: xmlBlocks[i].end,
                    data
                });
            }
        }
    }

    payloads.sort((a, b) => a.start - b.start);
    return payloads;
}

/**
 * Finds and parses the first EXECUTION payload in `text`. Returns
 * { format, raw, fullBlock, start, end, data } or null.
 */
export function extractExecutionPayload(text) {
    const all = extractAllExecutionPayloads(text);
    return all.length > 0 ? all[0] : null;
}

/**
 * Removes the raw payload block (and its enclosing markdown fence, if any)
 * from `text`, for display purposes only. `text` itself is never mutated.
 */
export function stripExecutionBlocks(text, rawBlock) {
    if (typeof text !== 'string' || !text) return text || '';
    if (!rawBlock) return text;

    const idx = text.indexOf(rawBlock);
    if (idx === -1) return text;

    let start = idx;
    let end = idx + rawBlock.length;

    const beforeFence = text.slice(0, start).match(/```(?:json|xml)?\s*$/);
    if (beforeFence) start -= beforeFence[0].length;
    const afterFence = text.slice(end).match(/^\s*```/);
    if (afterFence) end += afterFence[0].length;

    const stripped = text.slice(0, start) + text.slice(end);
    return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Indexes complete (non-partial, non-pruned) files carried by earlier user
 * messages in the conversation, so per-file diff stats can be computed
 * against the actual original content when it's available.
 */
function buildContextFileIndex(messages, beforeIndex) {
    const byPath = new Map();
    const byBasename = new Map();

    if (!Array.isArray(messages)) return { byPath, byBasename };

    const limit = Number.isFinite(beforeIndex) ? beforeIndex : messages.length;
    for (let i = 0; i < limit && i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;

        const parsed = parseCombineCopyPrompt(msg.content);
        if (!parsed.isStructured || !Array.isArray(parsed.files)) continue;

        parsed.files.forEach(f => {
            if (f.isPruned || f.isPartial || !f.path) return;
            const norm = f.path.replace(/\\/g, '/');
            byPath.set(norm, f.content);
            const base = norm.split('/').pop();
            if (!byBasename.has(base)) byBasename.set(base, []);
            if (byBasename.get(base).indexOf(norm) === -1) byBasename.get(base).push(norm);
        });
    }
    return { byPath, byBasename };
}

function resolveContextFile(path, contextIndex) {
    if (!path) return null;
    const norm = path.replace(/\\/g, '/');
    if (contextIndex.byPath.has(norm)) return contextIndex.byPath.get(norm);

    const suffixMatches = [];
    for (const key of contextIndex.byPath.keys()) {
        if (key.endsWith(norm)) suffixMatches.push(key);
    }
    if (suffixMatches.length === 1) return contextIndex.byPath.get(suffixMatches[0]);

    const base = norm.split('/').pop();
    const baseMatches = contextIndex.byBasename.get(base);
    if (baseMatches && baseMatches.length === 1) return contextIndex.byPath.get(baseMatches[0]);

    return null;
}

function countLines(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;
    return (text.match(/\n/g) || []).length + 1;
}

/**
 * Block-local +/- line counts for a single file entry, per action. Returns
 * { added, removed, approx, unknown }. `unknown` means the browser has no
 * way to know the true count (deletes and regex_replace without an original
 * on hand), and the UI should render that as "—" rather than a fake 0.
 */
function computeFileStats(fileObj, originalContent) {
    const action = (fileObj.action || 'modify').toLowerCase();

    if (action === 'command') {
        return { added: null, removed: null, approx: false, unknown: true };
    }

    if (action === 'create') {
        return { added: countLines(fileObj.content || ''), removed: 0, approx: false, unknown: false };
    }

    if (action === 'delete') {
        if (typeof originalContent === 'string') {
            return { added: 0, removed: countLines(originalContent), approx: false, unknown: false };
        }
        return { added: null, removed: null, approx: false, unknown: true };
    }

    // modify
    if (typeof fileObj.content === 'string') {
        if (typeof originalContent === 'string') {
            const res = diffLineCounts(originalContent, fileObj.content);
            return { added: res.added, removed: res.removed, approx: res.approx, unknown: false };
        }
        return { added: countLines(fileObj.content), removed: 0, approx: true, unknown: false };
    }

    if (Array.isArray(fileObj.search_replace) && fileObj.search_replace.length > 0) {
        let added = 0;
        let removed = 0;
        let approx = false;
        fileObj.search_replace.forEach(block => {
            const res = diffLineCounts(block.search || '', block.replace || '');
            added += res.added;
            removed += res.removed;
            approx = approx || res.approx;
        });
        return { added, removed, approx, unknown: false };
    }

    if (Array.isArray(fileObj.regex_replace) && fileObj.regex_replace.length > 0) {
        return { added: null, removed: null, approx: false, unknown: true };
    }

    return { added: 0, removed: 0, approx: false, unknown: false };
}

/**
 * Attaches a compact `msg.executionInfo` summary when `assistantMsg.content`
 * carries an EXECUTION payload. Deliberately does not duplicate the raw
 * payload into storage: it already lives in `msg.content`, and both the
 * card's copy button and the message's own copy button read from there.
 */
export function handleExecutionPayload(assistantMsg, messages) {
    if (!assistantMsg || typeof assistantMsg.content !== 'string') return;
    const content = assistantMsg.content;

    const looksLikeExecution = (content.indexOf('"phase"') !== -1 && content.indexOf('"EXECUTION"') !== -1)
        || content.indexOf('<phase>EXECUTION</phase>') !== -1;

    const payloads = extractAllExecutionPayloads(content);
    if (payloads.length === 0) {
        if (looksLikeExecution) {
            assistantMsg.executionInfo = {
                commitMessage: '',
                parseFailed: true,
                totals: { added: 0, removed: 0, known: false },
                files: [],
                items: []
            };
        } else {
            delete assistantMsg.executionInfo;
        }
        return;
    }

    const msgIndex = Array.isArray(messages) ? messages.indexOf(assistantMsg) : -1;
    const contextIndex = buildContextFileIndex(messages, msgIndex === -1 ? undefined : msgIndex);

    const items = payloads.map(extracted => {
        const data = extracted.data || {};
        const files = Array.isArray(data.files) ? data.files : [];
        let totalAdded = 0;
        let totalRemoved = 0;
        let anyKnown = false;

        const fileRows = files.map(f => {
            const action = (f.action || 'modify').toLowerCase();
            const original = action === 'command' ? null : resolveContextFile(f.path, contextIndex);
            const stats = computeFileStats(f, original);
            if (!stats.unknown) {
                anyKnown = true;
                totalAdded += stats.added || 0;
                totalRemoved += stats.removed || 0;
            }
            return {
                path: f.path || '',
                command: f.command || '',
                action,
                added: stats.unknown ? null : stats.added,
                removed: stats.unknown ? null : stats.removed,
                approx: Boolean(stats.approx)
            };
        });

        return {
            raw: extracted.raw,
            fullBlock: extracted.fullBlock,
            start: extracted.start,
            end: extracted.end,
            markdown: (typeof data.markdown === 'string') ? data.markdown : '',
            commitMessage: data.commit_message || '',
            totals: { added: totalAdded, removed: totalRemoved, known: anyKnown },
            files: fileRows
        };
    });

    const first = items[0];
    assistantMsg.executionInfo = {
        commitMessage: first.commitMessage,
        parseFailed: false,
        totals: first.totals,
        files: first.files,
        items
    };
}
