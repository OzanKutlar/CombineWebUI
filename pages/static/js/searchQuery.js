/**
 * Pure search query parser and matching logic with zero DOM dependencies.
 * Supports:
 * - Exact phrases: "hello world"
 * - Exclusions: -term or -"excluded phrase"
 * - Bare keywords: term1 term2 (AND by default)
 * - Options: caseSensitive, wholeWord, isRegex
 */

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses a raw query string into tokens.
 */
export function parseSearchQuery(raw, options = {}) {
    const clean = typeof raw === 'string' ? raw.trim() : '';
    if (!clean) {
        return { valid: false, error: '', terms: [], phrases: [], excluded: [], options };
    }

    if (options.isRegex) {
        try {
            const flags = options.caseSensitive ? 'g' : 'gi';
            const re = new RegExp(clean, flags);
            return {
                valid: true,
                error: '',
                isRegex: true,
                regex: re,
                options
            };
        } catch (err) {
            return {
                valid: false,
                error: err && err.message ? err.message : 'Invalid Regular Expression',
                terms: [],
                phrases: [],
                excluded: [],
                options
            };
        }
    }

    const terms = [];
    const phrases = [];
    const excluded = [];

    // Tokenize quotes vs bare terms
    const re = /(-)?"([^"]+)"|(\S+)/g;
    let match;

    while ((match = re.exec(clean)) !== null) {
        const isNeg = Boolean(match[1]) || (match[3] && match[3].startsWith('-') && match[3].length > 1);
        if (match[2] !== undefined) {
            // Quoted phrase
            const phraseText = match[2];
            if (isNeg) {
                excluded.push(phraseText);
            } else {
                phrases.push(phraseText);
            }
        } else if (match[3] !== undefined) {
            let bare = match[3];
            if (isNeg && bare.startsWith('-')) {
                bare = bare.slice(1);
            }
            if (bare) {
                if (isNeg) {
                    excluded.push(bare);
                } else {
                    terms.push(bare);
                }
            }
        }
    }

    const valid = terms.length > 0 || phrases.length > 0 || excluded.length > 0;
    return {
        valid,
        error: valid ? '' : 'Empty query',
        isRegex: false,
        terms,
        phrases,
        excluded,
        options
    };
}

function makeMatcherRegex(term, options, isExactPhrase = false) {
    const flags = options.caseSensitive ? '' : 'i';
    const escaped = escapeRegex(term);
    const pattern = (options.wholeWord && !isExactPhrase) ? `\\b${escaped}\\b` : escaped;
    return new RegExp(pattern, flags);
}

/**
 * Checks if targetText matches the parsed query.
 */
export function testSearchMatch(targetText, parsed) {
    if (typeof targetText !== 'string' || !targetText) return false;
    if (!parsed || !parsed.valid) return false;

    if (parsed.isRegex && parsed.regex) {
        parsed.regex.lastIndex = 0;
        return parsed.regex.test(targetText);
    }

    const opts = parsed.options || {};

    // Check exclusions first
    for (let i = 0; i < parsed.excluded.length; i++) {
        const ex = parsed.excluded[i];
        const re = makeMatcherRegex(ex, opts);
        if (re.test(targetText)) return false;
    }

    // Check phrases (all must match)
    for (let i = 0; i < parsed.phrases.length; i++) {
        const ph = parsed.phrases[i];
        const re = makeMatcherRegex(ph, opts, true);
        if (!re.test(targetText)) return false;
    }

    // Check terms (all must match)
    for (let i = 0; i < parsed.terms.length; i++) {
        const t = parsed.terms[i];
        const re = makeMatcherRegex(t, opts, false);
        if (!re.test(targetText)) return false;
    }

    return (parsed.terms.length > 0 || parsed.phrases.length > 0);
}

/**
 * Extracts context snippets from matching text with highlights.
 */
export function extractSearchSnippets(text, parsed, maxSnippets = 3, snippetRadius = 45) {
    if (typeof text !== 'string' || !text || !parsed || !parsed.valid) return [];

    const matchers = [];
    const opts = parsed.options || {};

    if (parsed.isRegex && parsed.regex) {
        matchers.push(new RegExp(parsed.regex.source, (parsed.regex.flags.replace('g', '')) + 'g'));
    } else {
        const flags = (opts.caseSensitive ? '' : 'i') + 'g';
        parsed.phrases.forEach(ph => matchers.push(new RegExp(escapeRegex(ph), flags)));
        parsed.terms.forEach(t => {
            const pat = opts.wholeWord ? `\\b${escapeRegex(t)}\\b` : escapeRegex(t);
            matchers.push(new RegExp(pat, flags));
        });
    }

    if (matchers.length === 0) return [];

    const hits = [];
    matchers.forEach(re => {
        let m;
        let guard = 0;
        while ((m = re.exec(text)) !== null && guard < 50) {
            guard++;
            hits.push({ start: m.index, end: m.index + m[0].length, len: m[0].length });
            if (re.lastIndex === m.index) re.lastIndex++;
        }
    });

    if (hits.length === 0) return [];
    hits.sort((a, b) => a.start - b.start);

    const snippets = [];
    let lastEnd = -1;

    for (let i = 0; i < hits.length && snippets.length < maxSnippets; i++) {
        const hit = hits[i];
        if (hit.start < lastEnd) continue;

        const sStart = Math.max(0, hit.start - snippetRadius);
        const sEnd = Math.min(text.length, hit.end + snippetRadius);
        lastEnd = sEnd;

        const before = text.slice(sStart, hit.start).replace(/\s+/g, ' ');
        const matchText = text.slice(hit.start, hit.end);
        const after = text.slice(hit.end, sEnd).replace(/\s+/g, ' ');

        snippets.push({
            prefix: sStart > 0 ? '...' : '',
            before,
            match: matchText,
            after,
            suffix: sEnd < text.length ? '...' : ''
        });
    }

    return snippets;
}
