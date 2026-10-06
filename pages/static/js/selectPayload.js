import { scanJsonObjects, safeJsonParse } from './execution.js';

/**
 * SELECT (context request) payloads, in both the JSON and the XML variant.
 *
 * Parsing happens once, when a response finishes or after "Parse Again", and
 * the result is cached on the message as `selectInfo`: payload offsets plus
 * the normalized entries. Rendering only reads that cache. A message whose
 * content never mentions SELECT is never parsed at all.
 */

const MAX_SELECT_ENTRIES = 500;
const MAX_XML_PAYLOAD_SCANS = 50;
const MAX_XML_TAG_MATCHES = 2000;
const FENCE_WINDOW = 64;
const PAYLOAD_OPEN_TAG = '<antigravity_payload>';
const SELECT_MARKER = 'SELECT';

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parseBool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return fallback;
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
    return fallback;
}

function normalizeFiles(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, MAX_SELECT_ENTRIES).map(item => cleanString(item)).filter(Boolean);
}

// Accepts the spec's array, or a comma/newline separated string as a common slip.
function normalizeNames(names) {
    const list = typeof names === 'string' ? names.split(/[,\n]/) : names;
    if (!Array.isArray(list)) return [];
    return list.slice(0, MAX_SELECT_ENTRIES).map(item => cleanString(item)).filter(Boolean);
}

function normalizeFunctions(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    list.slice(0, MAX_SELECT_ENTRIES).forEach(entry => {
        if (!entry || typeof entry !== 'object') return;
        const path = cleanString(entry.path);
        const names = normalizeNames(entry.names);
        if (path && names.length > 0) out.push({ path, names });
    });
    return out;
}

// Queries keep their exact text: leading or trailing spaces can be meaningful.
function normalizeSearch(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    list.slice(0, MAX_SELECT_ENTRIES).forEach(entry => {
        if (!entry || typeof entry !== 'object') return;
        const query = typeof entry.query === 'string' ? entry.query : '';
        if (!query.trim()) return;
        out.push({
            path: cleanString(entry.path),
            query,
            regex: parseBool(entry.regex, false),
            caseSensitive: parseBool(entry.case_sensitive, true)
        });
    });
    return out;
}

/**
 * Reduces a parsed payload to { files, functions, search }, dropping any
 * malformed entry instead of throwing.
 */
export function normalizeSelectPayload(data) {
    const source = (data && typeof data === 'object') ? data : {};
    return {
        files: normalizeFiles(source.files),
        functions: normalizeFunctions(source.functions),
        search: normalizeSearch(source.search)
    };
}

function isSelectJson(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (data.phase !== SELECT_MARKER) return false;
    return Array.isArray(data.files) || Array.isArray(data.functions) || Array.isArray(data.search);
}

function scanJsonSelectPayloads(text) {
    const results = [];
    scanJsonObjects(text).forEach(candidate => {
        // Cheap substring check first so unrelated JSON is never parsed.
        if (candidate.raw.indexOf('"SELECT"') === -1) return;
        const data = safeJsonParse(candidate.raw);
        if (!isSelectJson(data)) return;
        results.push({ format: 'json', start: candidate.start, end: candidate.end, ...normalizeSelectPayload(data) });
    });
    return results;
}

function tagValues(chunk, tag) {
    const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'gi');
    const out = [];
    let m;
    while (out.length < MAX_XML_TAG_MATCHES && (m = re.exec(chunk)) !== null) {
        out.push(m[1]);
    }
    return out;
}

function firstTagValue(chunk, tag) {
    const m = chunk.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
    return m ? m[1] : '';
}

function unwrapXmlText(text) {
    if (typeof text !== 'string') return '';
    const cdata = text.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    if (cdata) return cdata[1];
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function xmlField(chunk, tag) {
    return unwrapXmlText(firstTagValue(chunk, tag)).trim();
}

// A <file> holds the path directly or wraps it in <path>.
function parseXmlFile(body) {
    const nested = firstTagValue(body, 'path');
    return unwrapXmlText(nested || body).trim();
}

// Names come as repeated <name> tags, or as one comma separated <names> tag.
function parseXmlFunction(body) {
    const names = tagValues(body, 'name').map(n => unwrapXmlText(n).trim());
    return {
        path: xmlField(body, 'path'),
        names: names.length > 0 ? names : xmlField(body, 'names')
    };
}

// A <search> is one entry itself, or a container of <item> entries.
function parseXmlSearchBlock(block) {
    const items = tagValues(block, 'item');
    const entries = items.length > 0 ? items : (/<query>/i.test(block) ? [block] : []);
    return entries.map(entry => ({
        path: xmlField(entry, 'path'),
        query: xmlField(entry, 'query'),
        regex: xmlField(entry, 'regex'),
        case_sensitive: xmlField(entry, 'case_sensitive')
    }));
}

function parseSelectXml(raw) {
    if (xmlField(raw, 'phase').toUpperCase() !== SELECT_MARKER) return null;
    const search = [];
    tagValues(raw, 'search').forEach(block => search.push(...parseXmlSearchBlock(block)));
    return normalizeSelectPayload({
        files: tagValues(raw, 'file').map(body => parseXmlFile(body)),
        functions: tagValues(raw, 'function').map(body => parseXmlFunction(body)),
        search
    });
}

// Widens a span to its enclosing markdown fence, only when fenced on both sides.
function expandFence(text, start, end) {
    const before = text.slice(Math.max(0, start - FENCE_WINDOW), start).match(/```(?:xml)?\s*$/i);
    if (!before) return { start, end };
    const after = text.slice(end, end + FENCE_WINDOW).match(/^\s*```/);
    if (!after) return { start, end };
    return { start: start - before[0].length, end: end + after[0].length };
}

function scanXmlSelectPayloads(text) {
    if (text.indexOf(PAYLOAD_OPEN_TAG) === -1) return [];
    const results = [];
    const re = /<antigravity_payload>[\s\S]*?<\/antigravity_payload>/gi;
    let m;
    let scans = 0;
    while (scans < MAX_XML_PAYLOAD_SCANS && (m = re.exec(text)) !== null) {
        scans++;
        const data = parseSelectXml(m[0]);
        if (!data) continue;
        const span = expandFence(text, m.index, m.index + m[0].length);
        results.push({ format: 'xml', start: span.start, end: span.end, ...data });
    }
    return results;
}

/**
 * Every SELECT payload in `text`, in document order. Each item is
 * { format, start, end, files, functions, search }, where start/end cover the
 * enclosing fence when there is one.
 */
export function extractAllSelectPayloads(text) {
    if (typeof text !== 'string' || text.indexOf(SELECT_MARKER) === -1) return [];
    const found = scanJsonSelectPayloads(text).concat(scanXmlSelectPayloads(text));
    found.sort((a, b) => a.start - b.start);
    return found;
}

/**
 * Parses `msg.content` and stores the result as `msg.selectInfo`. Called when
 * a response finishes. A failed parse is cached as empty so it is not retried
 * on every render.
 */
export function handleSelectPayload(msg) {
    if (!msg || typeof msg !== 'object') return;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (msg.isError || content.indexOf(SELECT_MARKER) === -1) {
        delete msg.selectInfo;
        return;
    }
    let items = [];
    try {
        items = extractAllSelectPayloads(content);
    } catch (e) {
        console.error('Failed to parse SELECT payloads', e);
    }
    msg.selectInfo = { contentLength: content.length, items };
}

function isItemInBounds(item, content) {
    if (!item || !Number.isInteger(item.start) || !Number.isInteger(item.end)) return false;
    if (item.start < 0 || item.end > content.length || item.end <= item.start) return false;
    return content.slice(item.start, item.end).indexOf(SELECT_MARKER) !== -1;
}

function isCacheValid(info, content) {
    if (!info || !Array.isArray(info.items)) return false;
    if (info.contentLength !== content.length) return false;
    return info.items.every(item => isItemInBounds(item, content));
}

/**
 * Cached SELECT items for rendering. Parses only on a cache miss: a chat
 * saved before this feature, a variant whose fields did not carry the cache,
 * or content that changed since it was parsed.
 */
export function getSelectItems(msg) {
    if (!msg || msg.isError || typeof msg.content !== 'string') return [];
    if (msg.content.indexOf(SELECT_MARKER) === -1) return [];
    if (!isCacheValid(msg.selectInfo, msg.content)) handleSelectPayload(msg);
    const info = msg.selectInfo;
    return (info && Array.isArray(info.items)) ? info.items : [];
}
