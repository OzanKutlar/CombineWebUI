import { store, isPreserveEnabled } from './storage.js';
import { countTokens } from './tokens.js';

/**
 * Shared reasoning/thinking parsing. Both the live stream and historical
 * re-render go through here so they can never drift apart.
 *
 * Extraction is deliberately conservative: a tag only counts when it sits
 * outside any code region and at the structural start of a line. Pulling a
 * code sample or a passing prose mention into the thinking panel silently
 * removes it from the answer, which is far worse than leaving a real trace
 * inline where the user can still read it.
 */

const REASONING_KEYS = ['reasoning_content', 'reasoning', 'reasoning_text', 'thinking'];
const MAX_TAG_MATCHES = 500;

// Same-length filler for masked code regions. Must not be '<', '/', or a
// character that can appear in a tag name.
const MASK_CHAR = '\u0000';

// A tag further than this into a line is prose, not structure. Also bounds the
// backward scan so a single very long line cannot cost more than a fixed walk.
const MAX_LINE_LOOKBACK = 200;

// Set false to accept tags anywhere on a line. Every reasoning endpoint we know
// of emits them at line start, and requiring it is what kills prose mentions.
const REQUIRE_STRUCTURAL_TAGS = true;

// Used when replaying a trace with inline parsing switched off entirely, so
// preservation still produces a well-formed block.
const REPLAY_FALLBACK_TAG = 'think';

function coerceReasoningValue(value) {
    if (typeof value === 'string') return value || '';
    if (value && typeof value === 'object') {
        const nested = value.text || value.content || value.reasoning;
        if (typeof nested === 'string' && nested) return nested;
    }
    return '';
}

/**
 * Mirrors the backend normalizer as defence in depth, in case a response ever
 * reaches the UI through a path that skipped proxy-side normalization.
 */
export function extractReasoningDelta(delta) {
    if (!delta || typeof delta !== 'object') return '';
    for (let i = 0; i < REASONING_KEYS.length; i++) {
        const text = coerceReasoningValue(delta[REASONING_KEYS[i]]);
        if (text) return text;
    }
    return '';
}

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the user has explicitly cleared the tag list. An absent or malformed
 * value means "never configured" and falls back to the defaults; an empty array
 * means "off", and is honoured.
 */
export function getInlineTags() {
    const prefs = store.thinkingPrefs || {};
    if (!Array.isArray(prefs.inlineTags)) return ['think'];

    return prefs.inlineTags
        .map(tag => String(tag).trim().replace(/^<|>$/g, ''))
        .filter(tag => /^[a-zA-Z0-9_-]+$/.test(tag));
}

/**
 * Same-length copy of `text` with fenced blocks and inline code spans replaced
 * by filler, so tag scanning never sees inside them. Length is preserved, which
 * is what lets callers scan the mask but slice the original.
 *
 * An unterminated fence masks to end of string. Mid-stream that is exactly
 * right, and once the stream ends an unclosed fence is malformed markdown
 * anyway, so erring toward "leave the text alone" is correct either way.
 */
export function maskCodeRegions(text) {
    if (typeof text !== 'string' || !text) return '';
    if (text.indexOf('`') === -1) return text;

    const fill = (match) => MASK_CHAR.repeat(match.length);

    // Order matters. Closed fences first, so a leftover ``` is genuinely an
    // unterminated opener; inline spans last, so they cannot match across a
    // region already masked out.
    let masked = text.replace(/```[\s\S]*?```/g, fill);
    masked = masked.replace(/```[\s\S]*$/, fill);
    masked = masked.replace(/`[^`\n]*`/g, fill);
    return masked;
}

/** True when only whitespace separates the tag from the start of its line. */
function isStructuralTagPosition(text, index) {
    if (!REQUIRE_STRUCTURAL_TAGS) return true;

    const floor = Math.max(0, index - MAX_LINE_LOOKBACK);
    for (let i = index - 1; i >= floor; i--) {
        const ch = text[i];
        if (ch === '\n') return true;
        if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
    }
    return floor === 0;
}

/**
 * Escapes configured tag names to HTML entities so a markdown renderer treats
 * them as text rather than markup.
 *
 * Without this, DOMPurify drops the element and keeps its inner text, so a
 * literal <think>x</think> in prose renders as a bare x. Extraction has already
 * run by the time this is called, so anything still carrying a tag is content
 * the user is meant to see.
 *
 * Code regions are skipped: a markdown renderer escapes them itself, and
 * double-escaping surfaces the raw entity in the code block.
 */
export function escapeThinkingTags(text, tags) {
    const source = typeof text === 'string' ? text : '';
    const tagList = Array.isArray(tags)
        ? tags.filter(tag => typeof tag === 'string' && tag)
        : [];

    if (tagList.length === 0 || source.indexOf('<') === -1) return source;

    const masked = maskCodeRegions(source);
    const pattern = tagList.map(escapeRegex).join('|');
    const re = new RegExp('<\\/?(?:' + pattern + ')>', 'gi');

    let result = '';
    let cursor = 0;
    let match;
    let guard = 0;

    while ((match = re.exec(masked)) !== null) {
        guard += 1;
        if (guard > MAX_TAG_MATCHES) break;

        const end = match.index + match[0].length;
        result += source.slice(cursor, match.index);
        result += source.slice(match.index, end)
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        cursor = end;
    }

    result += source.slice(cursor);
    return result;
}

/** Collects every well-formed <tag>...</tag> pair as a removable region. */
function collectClosedRegions(masked, source, tag, regions) {
    const safe = escapeRegex(tag);
    const re = new RegExp('<' + safe + '>([\\s\\S]*?)<\\/' + safe + '>', 'g');
    const openLength = tag.length + 2;

    let match;
    let guard = 0;
    while ((match = re.exec(masked)) !== null) {
        guard += 1;
        if (guard > MAX_TAG_MATCHES) break;
        if (!isStructuralTagPosition(masked, match.index)) continue;

        const innerStart = match.index + openLength;
        regions.push({
            start: match.index,
            end: match.index + match[0].length,
            text: source.slice(innerStart, innerStart + match[1].length)
        });
    }
}

/**
 * A trailing unclosed tag means the model is still mid-thought. Only ever
 * consulted while streaming: after the stream ends, a tag that never closed was
 * just text.
 */
function findOpenRegion(masked, source, tag, closedRegions) {
    const openTag = '<' + tag + '>';
    const idx = masked.lastIndexOf(openTag);
    if (idx === -1) return null;
    if (!isStructuralTagPosition(masked, idx)) return null;

    // If the last opener belongs to a pair we already collected, there is no
    // trailing unclosed tag to speculate about.
    for (let i = 0; i < closedRegions.length; i++) {
        if (idx >= closedRegions[i].start && idx < closedRegions[i].end) return null;
    }

    return {
        start: idx,
        end: source.length,
        text: source.slice(idx + openTag.length)
    };
}

/** Sorted, non-overlapping. A region starting inside a kept one is dropped. */
function mergeRegions(regions) {
    const sorted = regions.slice().sort((a, b) => a.start - b.start);
    const merged = [];
    let cursor = -1;

    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].start < cursor) continue;
        merged.push(sorted[i]);
        cursor = sorted[i].end;
    }
    return merged;
}

/**
 * Withholds a trailing partial tag mid-stream, but only when it could still
 * become one of the configured tags, so an ordinary trailing '<' in code is
 * left alone.
 */
function stripTrailingTagFragment(text, tagList) {
    const match = /<\/?[a-zA-Z0-9_-]*$/.exec(text);
    if (!match) return text;

    const body = match[0].replace(/^<\/?/, '').toLowerCase();
    for (let i = 0; i < tagList.length; i++) {
        if (tagList[i].toLowerCase().indexOf(body) === 0) {
            return text.slice(0, match.index);
        }
    }
    return text;
}

/**
 * Pulls inline <think>-style blocks out of raw model output.
 *
 * `reasoningSoFar` is the trace already gathered from structured deltas; the
 * return value is a fresh derivation each call, never appended in place, so
 * repeated invocations against a growing rawOutput cannot double-count.
 *
 * `options.streaming` enables the trailing-open-tag heuristic. It defaults to
 * false: any finalized parse must treat an unclosed tag as ordinary text.
 */
export function splitInlineThinking(rawOutput, reasoningSoFar, tags, options) {
    const source = typeof rawOutput === 'string' ? rawOutput : '';
    const baseTrace = typeof reasoningSoFar === 'string' ? reasoningSoFar : '';
    const streaming = Boolean(options && options.streaming);

    const tagList = Array.isArray(tags)
        ? tags.filter(tag => typeof tag === 'string' && tag)
        : [];

    if (tagList.length === 0 || source.indexOf('<') === -1) {
        return { cleanContent: source, extractedThink: baseTrace };
    }

    const masked = maskCodeRegions(source);
    const regions = [];

    for (let t = 0; t < tagList.length; t++) {
        collectClosedRegions(masked, source, tagList[t], regions);
    }

    if (streaming) {
        const closed = regions.slice();
        for (let t = 0; t < tagList.length; t++) {
            const open = findOpenRegion(masked, source, tagList[t], closed);
            if (open) regions.push(open);
        }
    }

    const merged = mergeRegions(regions);

    let cleanContent = '';
    let extractedThink = baseTrace;
    let cursor = 0;

    for (let i = 0; i < merged.length; i++) {
        const region = merged[i];
        cleanContent += source.slice(cursor, region.start);
        if (region.text) extractedThink += region.text + '\n';
        cursor = region.end;
    }
    cleanContent += source.slice(cursor);

    if (streaming) {
        cleanContent = stripTrailingTagFragment(cleanContent, tagList);
    }

    return { cleanContent, extractedThink };
}

/**
 * Threads saved before traces were a first-class field still carry their
 * thinking inline in content. Lift it out on first render.
 *
 * Gated on key presence rather than emptiness: chat.js seeds every assistant
 * message with `reasoning: ''`, so an emptiness check would re-run this on
 * every modern message and rewrite `content` in place. Stamped so it is
 * genuinely one-shot regardless.
 */
export function migrateLegacyThinking(msg) {
    if (!msg || msg.role !== 'assistant') return false;
    if (msg.thinkingMigrated === true) return false;

    if ('reasoning' in msg) {
        msg.thinkingMigrated = true;
        return false;
    }
    if (typeof msg.content !== 'string' || msg.content.indexOf('<') === -1) {
        msg.thinkingMigrated = true;
        return false;
    }

    const split = splitInlineThinking(msg.content, '', getInlineTags());
    const trace = split.extractedThink.trim();

    msg.thinkingMigrated = true;
    if (!trace) return false;

    msg.reasoning = trace;
    msg.content = split.cleanContent;
    return true;
}

export function estimateReasoningTokens(text) {
    return countTokens(text || '');
}

/**
 * A closing tag inside the trace itself would terminate the wrapper early and
 * corrupt the next turn's parse. Broken with a space rather than dropped, so
 * the trace stays readable to the model.
 */
function neutralizeClosingTags(trace, tag) {
    const re = new RegExp('<\\/' + escapeRegex(tag) + '>', 'gi');
    return trace.replace(re, '< /' + tag + '>');
}

/**
 * Builds the messages array sent to the API.
 *
 * Traces are re-inlined as <think> blocks rather than sent back in their
 * native field, because most OpenAI-compatible servers reject or silently
 * drop an assistant-side `reasoning_content`. Gated per originating model, so
 * you can preserve on one model and strip on another within the same thread.
 */
export function buildReplayHistory(messages) {
    if (!Array.isArray(messages)) return [];
    const tag = getInlineTags()[0] || REPLAY_FALLBACK_TAG;

    return messages
        .filter(m => m && !m.isError && typeof m.role === 'string')
        .map(m => {
            const base = { role: m.role, content: m.content || '' };
            if (m.role !== 'assistant') return base;

            const trace = typeof m.reasoning === 'string' ? m.reasoning.trim() : '';
            if (!trace) return base;
            if (!isPreserveEnabled(m.model)) return base;

            const safeTrace = neutralizeClosingTags(trace, tag);
            base.content = '<' + tag + '>\n' + safeTrace + '\n</' + tag + '>\n\n' + base.content;
            return base;
        });
}
