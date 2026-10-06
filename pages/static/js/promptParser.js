/**
 * Parses raw combineCopy payloads into their logical sections so the UI can
 * show the user's request prominently and collapse everything else.
 *
 * File blocks are located across the *entire* raw text before any header
 * detection happens. This matters for two reasons: emitters like `-js`
 * without `--system` ship file context with no `--- FILE CONTEXT ---` header
 * at all (just a bare preamble), and a header string appearing inside a
 * pasted file's own body must never be allowed to split the message.
 */

const HEADERS = [
    { id: 'user_request', title: 'User Request', icon: 'user', match: '--- USER REQUEST ---' },
    { id: 'user_reminder', title: 'User Request (Reminder)', icon: 'repeat', match: '--- USER REQUEST (Reminder) ---' },
    { id: 'ast_map', title: 'Directory AST Map', icon: 'git-branch', match: '--- DIRECTORY AST MAP ---' },
    { id: 'file_context', title: 'File Context', icon: 'folder-open', match: '--- FILE CONTEXT ---' },
    { id: 'requested_file_context', title: 'File Context', icon: 'folder-open', match: '--- REQUESTED FILE CONTEXT ---' },
    { id: 'git_diff', title: 'Uncommitted Git Diff', icon: 'git-compare', match: '--- CURRENT UNCOMMITTED GIT DIFF ---' },
    { id: 'system_prompt', title: 'System Instructions', icon: 'shield', match: '--- SYSTEM INSTRUCTIONS ---' },
    { id: 'system_reminder', title: 'System Reminder', icon: 'alert-circle', match: '--- SYSTEM REMINDER ---' },
    { id: 'missing_files', title: 'System Note: Missing Files', icon: 'file-x', match: '--- SYSTEM NOTE: MISSING FILES ---' },
    { id: 'prune_note', title: 'System Note: Context Pruning', icon: 'scissors', match: '--- SYSTEM NOTE: CONTEXT PRUNING ---' },
    { id: 'search_results', title: 'System Note: Search Results', icon: 'search', match: '--- SYSTEM NOTE: SEARCH RESULTS ---' }
];

const MAX_FILE_BLOCKS = 2000;
const PRUNED_PREFIX = '(Has been removed from context because:';
const HIDDEN_RANGE_RE = /\/\/ \.\.\. \(lines \d+-\d+ hidden\) \.\.\./g;

function blockStartRegex() {
    return /-{35}\r?\nFILE: (.*?)\r?\n-{35}\r?\n/g;
}

/**
 * Strips the opening/closing markdown fence from a file block's raw body.
 * Unlike a lazy match to the first backtick fence, this looks at the body's
 * own first and last non-blank lines, so a fence embedded in the file's own
 * content (e.g. a Markdown file, or this very file) can't cut the block
 * short.
 */
function stripOuterFence(body) {
    const lines = body.split(/\r\n|\n/);

    let start = 0;
    while (start < lines.length && lines[start].trim() === '') start++;
    if (start < lines.length && /^```[\w.+-]*$/.test(lines[start].trim())) {
        start++;
    }

    let end = lines.length;
    let last = lines.length - 1;
    while (last >= start && lines[last].trim() === '') last--;
    if (last >= start && lines[last].trim() === '```') {
        end = last;
    }

    return lines.slice(start, end).join('\n');
}

/**
 * Scans the entire raw text for FILE blocks, independent of any header
 * detection. Returns each file's parsed content plus its `[start, end)`
 * character range in `text`, so callers can mask headers that fall inside a
 * file's own body and exclude the block's text from surrounding sections.
 */
export function scanFileBlocks(text, potentialMarks = []) {
    const files = [];
    if (typeof text !== 'string' || !text) return files;

    const re = blockStartRegex();
    const starts = [];
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
        guard += 1;
        if (guard > MAX_FILE_BLOCKS) break;
        starts.push({ headerStart: m.index, bodyStart: m.index + m[0].length, path: (m[1] || '').trim() });
    }

    for (let i = 0; i < starts.length; i++) {
        const cur = starts[i];
        let blockEnd = (i + 1 < starts.length) ? starts[i + 1].headerStart : text.length;

        let earlyEnd = null;
        for (let j = 0; j < potentialMarks.length; j++) {
            const pm = potentialMarks[j];
            if (pm.offset > cur.bodyStart && pm.offset < blockEnd) {
                const textBefore = text.slice(cur.bodyStart, pm.offset);
                if (/\n```\s*\n*$/.test(textBefore)) {
                    earlyEnd = pm.offset;
                    break;
                }
            }
        }

        if (earlyEnd !== null) {
            blockEnd = earlyEnd;
        }

        const rawBody = text.slice(cur.bodyStart, blockEnd);
        const content = stripOuterFence(rawBody).trim();
        const isPruned = content.startsWith(PRUNED_PREFIX);
        const hiddenMatches = content.match(HIDDEN_RANGE_RE);

        files.push({
            path: cur.path,
            content,
            isPruned,
            prunedReason: isPruned
                ? content.replace(PRUNED_PREFIX, '').replace(/\)$/, '').trim()
                : '',
            isPartial: !isPruned && Boolean(hiddenMatches),
            hiddenRangeCount: hiddenMatches ? hiddenMatches.length : 0,
            start: cur.headerStart,
            end: blockEnd
        });
    }
    return files;
}

// Retained for any external caller still expecting the old name/shape.
export function parseFileBlocks(text) {
    return scanFileBlocks(text).map(f => ({
        path: f.path,
        content: f.content,
        isPruned: f.isPruned,
        prunedReason: f.prunedReason
    }));
}

/**
 * scanFileBlocks() with the header marks computed for you.
 *
 * Callers that only want the file blocks (the prune core, for one) must still
 * pass the marks, or the final block will swallow every trailing section that
 * follows it. This wraps the same two steps parseCombineCopyPrompt() performs
 * internally so the two can never drift apart on where a block ends.
 */
export function scanFileBlocksForText(text) {
    if (typeof text !== 'string' || !text) return [];

    const lines = text.split('\n');
    const lineOffsets = computeLineOffsets(text);
    const potentialMarks = [];

    for (let i = 0; i < lines.length; i++) {
        const def = matchHeader(lines[i].trim());
        if (!def) continue;
        potentialMarks.push({
            line: i,
            def,
            offset: lineOffsets[i] !== undefined ? lineOffsets[i] : 0
        });
    }

    return scanFileBlocks(text, potentialMarks);
}

function matchHeader(line) {
    for (let i = 0; i < HEADERS.length; i++) {
        if (line === HEADERS[i].match) return HEADERS[i];
    }
    return null;
}

/** Starting character offset of each line in `text`, split on '\n'. */
function computeLineOffsets(text) {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') offsets.push(i + 1);
    }
    return offsets;
}

function isInsideAnyBlock(offset, blocks) {
    for (let i = 0; i < blocks.length; i++) {
        if (offset >= blocks[i].start && offset < blocks[i].end) return true;
    }
    return false;
}

/** Removes the given [start, end) ranges from `text`; ranges share `text`'s coordinates. */
function stripRanges(text, ranges) {
    if (!ranges || ranges.length === 0) return text;
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    let result = '';
    let cursor = 0;
    for (let i = 0; i < sorted.length; i++) {
        const r = sorted[i];
        if (r.start < cursor) continue;
        result += text.slice(cursor, r.start);
        cursor = Math.max(cursor, r.end);
    }
    result += text.slice(cursor);
    return result;
}

function emptyResult() {
    return { isStructured: false, userRequest: null, sections: [], files: [] };
}

/**
 * Returns { isStructured, userRequest, sections, files }.
 * When isStructured is false the caller should render the raw text unchanged.
 */
export function parseCombineCopyPrompt(raw) {
    if (typeof raw !== 'string' || !raw) return emptyResult();

    const lines = raw.split('\n');
    const lineOffsets = computeLineOffsets(raw);
    
    const potentialMarks = [];
    for (let i = 0; i < lines.length; i++) {
        const def = matchHeader(lines[i].trim());
        if (def) {
            const offset = lineOffsets[i] !== undefined ? lineOffsets[i] : 0;
            potentialMarks.push({ line: i, def, offset });
        }
    }

    const files = scanFileBlocks(raw, potentialMarks);

    const marks = [];
    for (let i = 0; i < potentialMarks.length; i++) {
        const pm = potentialMarks[i];
        // A header string that lives inside a file's own body is just text,
        // not a real section boundary.
        if (isInsideAnyBlock(pm.offset, files)) continue;
        marks.push({ line: pm.line, def: pm.def });
    }

    let userRequest = null;

    // Everything before the first recognised header (or the whole text, when
    // there are no headers at all) used to be discarded outright. Emitters
    // like `combineCopy -js` without `--system` ship bare file context with
    // no header whatsoever, so that text is now kept: file blocks in it are
    // already captured above, and any remaining prose becomes the request.
    const firstMarkOffset = marks.length > 0 ? lineOffsets[marks[0].line] : raw.length;
    if (firstMarkOffset > 0) {
        const preambleRanges = files
            .filter(f => f.start < firstMarkOffset)
            .map(f => ({ start: f.start, end: Math.min(f.end, firstMarkOffset) }));
        const preambleText = stripRanges(raw.slice(0, firstMarkOffset), preambleRanges).trim();
        if (preambleText) userRequest = preambleText;
    }

    const sections = [];
    let sawFileContext = files.length > 0;

    for (let mIdx = 0; mIdx < marks.length; mIdx++) {
        const start = marks[mIdx].line + 1;
        const end = (mIdx + 1 < marks.length) ? marks[mIdx + 1].line : lines.length;
        const body = lines.slice(start, end).join('\n').trim();
        const def = marks[mIdx].def;

        // The reminder duplicates the request verbatim; first non-empty wins.
        if (def.id === 'user_request' || def.id === 'user_reminder') {
            if (userRequest === null && body) userRequest = body;
            continue;
        }

        if (def.id === 'file_context' || def.id === 'requested_file_context') {
            sawFileContext = true;
            continue; // files themselves are already fully captured above
        }

        if (!body) continue;
        sections.push({
            id: def.id + '_' + mIdx,
            title: def.title,
            icon: def.icon,
            body
        });
    }

    const isStructured = files.length > 0 || userRequest !== null || sawFileContext || sections.length > 0;
    if (!isStructured) return emptyResult();

    return { isStructured: true, userRequest, sections, files };
}
