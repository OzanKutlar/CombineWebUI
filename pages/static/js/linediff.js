/**
 * Dependency-free line-level diff used for execution-payload stat cards.
 * Not a general-purpose diff: it trims a common prefix/suffix first (which
 * covers the common search/replace shape well), then falls back to an LCS
 * over what remains, bounded so a huge block can never stall the UI thread.
 */

const LCS_LINE_LIMIT = 1500;

function splitLines(text) {
    if (typeof text !== 'string' || text === '') return [];
    return text.split(/\r\n|\n|\r/);
}

function trimCommon(a, b) {
    let start = 0;
    const maxStart = Math.min(a.length, b.length);
    while (start < maxStart && a[start] === b[start]) start++;

    let endA = a.length - 1;
    let endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) {
        endA--;
        endB--;
    }

    return {
        a: a.slice(start, endA + 1),
        b: b.slice(start, endB + 1)
    };
}

/** Standard O(n*m) LCS length table, used only after prefix/suffix trimming. */
function lcsLength(a, b) {
    const n = a.length;
    const m = b.length;
    let prev = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
        const cur = new Array(m + 1).fill(0);
        for (let j = 1; j <= m; j++) {
            cur[j] = (a[i - 1] === b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        prev = cur;
    }
    return prev[m];
}

/**
 * Returns { added, removed, approx }. `approx` is true when the inputs
 * exceeded the bounded LCS size and a cheap upper-bound estimate was used
 * in place of an exact diff.
 */
export function diffLineCounts(oldText, newText) {
    const rawOld = splitLines(oldText);
    const rawNew = splitLines(newText);

    const { a, b } = trimCommon(rawOld, rawNew);

    if (a.length === 0 && b.length === 0) {
        return { added: 0, removed: 0, approx: false };
    }

    if (a.length > LCS_LINE_LIMIT || b.length > LCS_LINE_LIMIT) {
        return { added: b.length, removed: a.length, approx: true };
    }

    const common = lcsLength(a, b);
    return {
        added: b.length - common,
        removed: a.length - common,
        approx: false
    };
}
