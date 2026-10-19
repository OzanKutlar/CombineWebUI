import { parseCombineCopyPrompt } from './promptParser.js';

/**
 * Staged combineCopy paste.
 *
 * When a structured payload is pasted, the prompt box keeps only the user
 * request. The full payload is held here, and on send it is rebuilt from the
 * original text: removed files and sections are cut out, and the request
 * spans are replaced with whatever the prompt box now says. Nothing else is
 * touched, so an unedited paste is sent byte for byte as it was copied.
 *
 * Pure data, no DOM. composerView.js owns the UI.
 */

// Far beyond any real payload; only stops a runaway clipboard from stalling.
const MAX_PASTE_CHARS = 20000000;
const MAX_EDITS = 4000;
// Every combineCopy header and FILE block contains it, so it is a cheap gate.
const PASTE_MARKER = '---';

let staged = null;
const listeners = new Set();

function notify() {
    listeners.forEach(fn => {
        try {
            fn();
        } catch (e) {
            console.error('Composer listener failed', e);
        }
    });
}

/** Called after any change to the staged payload, including clearing it. */
export function onComposerChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
}

/** The parsed payload for pasted text, or null when it is not worth parsing. */
export function parsePasteText(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_PASTE_CHARS) return null;
    if (text.indexOf(PASTE_MARKER) === -1) return null;
    try {
        return parseCombineCopyPrompt(text);
    } catch (e) {
        console.warn('Could not parse the pasted text', e);
        return null;
    }
}

/** Only payloads carrying something besides the request are staged. */
export function isStageablePaste(parsed) {
    if (!parsed || parsed.isStructured !== true) return false;
    const files = Array.isArray(parsed.files) ? parsed.files.length : 0;
    const sections = Array.isArray(parsed.sections) ? parsed.sections.length : 0;
    return files + sections > 0;
}

export function stagePayload(raw, parsed) {
    if (typeof raw !== 'string' || !raw || !isStageablePaste(parsed)) return false;
    staged = { raw, parsed, removedFiles: new Set(), removedSections: new Set() };
    notify();
    return true;
}

export function hasStaged() {
    return staged !== null;
}

export function getStaged() {
    return staged;
}

export function clearStaged() {
    if (!staged) return;
    staged = null;
    notify();
}

function toggleIndex(set, list, index) {
    if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return false;
    if (set.has(index)) set.delete(index);
    else set.add(index);
    notify();
    return true;
}

/** Removes or restores one file. Returns false for an invalid index. */
export function toggleFileRemoved(index) {
    if (!staged) return false;
    return toggleIndex(staged.removedFiles, staged.parsed.files, index);
}

/** Removes or restores one section. Returns false for an invalid index. */
export function toggleSectionRemoved(index) {
    if (!staged) return false;
    return toggleIndex(staged.removedSections, staged.parsed.sections, index);
}

export function isFileRemoved(index) {
    return Boolean(staged) && staged.removedFiles.has(index);
}

export function isSectionRemoved(index) {
    return Boolean(staged) && staged.removedSections.has(index);
}

function isValidRange(raw, start, end) {
    return Number.isInteger(start) && Number.isInteger(end)
        && start >= 0 && end >= start && end <= raw.length;
}

function removalEdits(raw, items, removed) {
    const edits = [];
    if (!Array.isArray(items)) return edits;
    removed.forEach(i => {
        const item = items[i];
        if (item && isValidRange(raw, item.start, item.end)) {
            edits.push({ start: item.start, end: item.end, text: '' });
        }
    });
    return edits;
}

/** What one request span becomes once the request text is `text`. */
function spanReplacement(raw, span, text) {
    if (span.kind === 'preamble') return span.primary ? text : '';
    if (!span.empty) return text;
    if (!text) return '';
    // An empty header body is an insertion point, so it needs its own line.
    const lead = (span.start > 0 && raw[span.start - 1] !== '\n') ? '\n' : '';
    return lead + text + '\n';
}

function requestEdits(raw, parsed, text) {
    const spans = Array.isArray(parsed.requestSpans) ? parsed.requestSpans : [];
    return spans
        .filter(span => span && isValidRange(raw, span.start, span.end))
        .map(span => ({ start: span.start, end: span.end, text: spanReplacement(raw, span, text) }));
}

/** Applies non-overlapping edits front to back. An overlapping edit is skipped. */
function applyEdits(raw, edits) {
    const sorted = edits.slice(0, MAX_EDITS).sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let out = '';
    let cursor = 0;
    sorted.forEach(edit => {
        if (edit.start < cursor) return;
        out += raw.slice(cursor, edit.start) + edit.text;
        cursor = edit.end;
    });
    return out + raw.slice(cursor);
}

/**
 * The text that will actually be sent, given what the prompt box holds.
 * Without a staged payload that is simply the prompt box text.
 */
export function composePrompt(requestText) {
    const text = typeof requestText === 'string' ? requestText : '';
    if (!staged) return text;

    const { raw, parsed } = staged;
    const edits = removalEdits(raw, parsed.files, staged.removedFiles)
        .concat(removalEdits(raw, parsed.sections, staged.removedSections));

    const request = text.trim();
    let prefix = '';
    if (request !== (parsed.userRequest || '').trim()) {
        const swaps = requestEdits(raw, parsed, request);
        // A payload with nowhere to hold a request gets it as a preamble,
        // which is exactly where the parser looks for one.
        if (swaps.length > 0) swaps.forEach(edit => edits.push(edit));
        else if (request) prefix = request + '\n\n';
    }

    if (edits.length === 0) return prefix + raw;
    return prefix + applyEdits(raw, edits);
}
