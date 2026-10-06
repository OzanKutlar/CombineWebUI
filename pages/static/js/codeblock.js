/**
 * Chrome for fenced code blocks: a header bar carrying the language, a line
 * count, a copy button and a collapse toggle.
 *
 * enhanceCodeBlocks() runs inside formatMarkdown(), against the DOMParser
 * document and *after* DOMPurify, so the markup it adds is not stripped. It is
 * deliberately markup-only and attaches no event handlers, because the chat
 * reassigns innerHTML wholesale on every render; all behaviour lives in the
 * single delegated listener installed by wireCodeBlocks().
 *
 * Icons are inline SVG rather than data-lucide placeholders: the thinking
 * panel formats its body on expand without ever calling lucide.createIcons(),
 * so a placeholder there would render as an empty box.
 */

import { copyTextToClipboard } from './clipboard.js';

// A pathological reply could carry an unbounded number of fences; the header
// build is cheap but not free, so the pass is capped.
const MAX_BLOCKS_PER_RENDER = 200;
const COPY_FEEDBACK_MS = 2000;
const MAX_LANG_CHARS = 20;

const LANGUAGE_LABELS = {
    js: 'JavaScript', javascript: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    jsx: 'JSX', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
    py: 'Python', python: 'Python', pyi: 'Python',
    rb: 'Ruby', ruby: 'Ruby', rs: 'Rust', rust: 'Rust',
    go: 'Go', golang: 'Go', java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin',
    swift: 'Swift', dart: 'Dart', scala: 'Scala', lua: 'Lua', perl: 'Perl',
    c: 'C', h: 'C', cpp: 'C++', cxx: 'C++', cc: 'C++', hpp: 'C++',
    cs: 'C#', csharp: 'C#', php: 'PHP', r: 'R',
    sh: 'Shell', shell: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish',
    ps1: 'PowerShell', powershell: 'PowerShell', bat: 'Batch', cmd: 'Batch',
    sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protobuf',
    html: 'HTML', htm: 'HTML', xml: 'XML', svg: 'SVG',
    css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
    json: 'JSON', jsonc: 'JSON', json5: 'JSON5',
    yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'Config', env: 'Env',
    md: 'Markdown', markdown: 'Markdown', mdx: 'MDX', rst: 'reStructuredText',
    tex: 'TeX', latex: 'LaTeX', mermaid: 'Mermaid',
    diff: 'Diff', patch: 'Diff',
    dockerfile: 'Dockerfile', docker: 'Dockerfile',
    make: 'Makefile', makefile: 'Makefile', cmake: 'CMake',
    vim: 'Vim', text: 'Text', plaintext: 'Text', txt: 'Text', none: 'Text'
};

const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICON_COPY = SVG_OPEN + '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const ICON_CHECK = SVG_OPEN + '<polyline points="20 6 9 17 4 12"></polyline></svg>';
const ICON_CHEVRON = SVG_OPEN + '<polyline points="6 9 12 15 18 9"></polyline></svg>';

// Only needs to be unique within a page load, so the aria-controls target of a
// freshly rendered block can never collide with a stale one.
let blockIdCounter = 0;

// Keyed on the button element itself, so a re-render simply drops the entry.
const copyTimers = new WeakMap();

function extractLanguageToken(preEl) {
    const code = preEl.querySelector('code');
    if (!code) return '';

    const classes = (code.getAttribute('class') || '').split(/\s+/);
    for (let i = 0; i < classes.length; i++) {
        const cls = classes[i];
        if (cls.indexOf('language-') === 0) {
            return cls.slice(9).trim().toLowerCase();
        }
    }
    return '';
}

/** Known aliases get a proper display name; anything else is shown as written. */
function resolveLanguageLabel(token) {
    if (!token) return 'Text';
    if (Object.prototype.hasOwnProperty.call(LANGUAGE_LABELS, token)) {
        return LANGUAGE_LABELS[token];
    }

    // A fence info string can be arbitrary text, so it is stripped to safe
    // characters and capped rather than allowed to blow out the header.
    const clean = token.replace(/[^a-zA-Z0-9+#._-]/g, '').slice(0, MAX_LANG_CHARS);
    return clean ? clean.toUpperCase() : 'Text';
}

/** Trailing newlines are an artefact of the fence, not a line of code. */
function countCodeLines(text) {
    if (typeof text !== 'string' || !text) return 0;
    const trimmed = text.replace(/\n+$/, '');
    if (!trimmed) return 0;
    return trimmed.split('\n').length;
}

function buildButton(doc, action, iconSvg, label, title) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cb-btn';
    btn.setAttribute('data-cb-action', action);
    btn.title = title;
    btn.innerHTML = iconSvg + '<span class="cb-btn-label"></span>';

    const labelEl = btn.querySelector('.cb-btn-label');
    if (labelEl) labelEl.textContent = label;
    return btn;
}

function buildHeader(doc, label, lines, bodyId) {
    const head = doc.createElement('div');
    head.className = 'cb-head';

    const meta = doc.createElement('div');
    meta.className = 'cb-meta';

    const langEl = doc.createElement('span');
    langEl.className = 'cb-lang';
    langEl.textContent = label;
    meta.appendChild(langEl);

    if (lines > 0) {
        const countEl = doc.createElement('span');
        countEl.className = 'cb-count';
        countEl.textContent = lines + (lines === 1 ? ' line' : ' lines');
        meta.appendChild(countEl);
    }

    const actions = doc.createElement('div');
    actions.className = 'cb-actions';
    actions.appendChild(buildButton(doc, 'copy', ICON_COPY, 'Copy', 'Copy code block'));

    const toggle = buildButton(doc, 'toggle', ICON_CHEVRON, 'Collapse', 'Collapse code block');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-controls', bodyId);
    actions.appendChild(toggle);

    head.appendChild(meta);
    head.appendChild(actions);
    return head;
}

function wrapPre(doc, pre) {
    const parent = pre.parentNode;
    if (!parent) return;

    const label = resolveLanguageLabel(extractLanguageToken(pre));
    const codeEl = pre.querySelector('code');
    const lines = countCodeLines(codeEl ? codeEl.textContent : pre.textContent);

    blockIdCounter += 1;
    const bodyId = 'cb-body-' + blockIdCounter;

    const wrap = doc.createElement('div');
    wrap.className = 'cb-wrap';

    const body = doc.createElement('div');
    body.className = 'cb-body';
    body.id = bodyId;

    const inner = doc.createElement('div');
    inner.className = 'cb-body-inner';

    // Swap the placeholder in first so the original <pre> keeps its position in
    // the flow before being moved into the wrapper.
    parent.replaceChild(wrap, pre);
    inner.appendChild(pre);
    body.appendChild(inner);

    wrap.appendChild(buildHeader(doc, label, lines, bodyId));
    wrap.appendChild(body);
}

/**
 * Wraps every <pre> in `doc` that is not already wrapped. Safe to call on a
 * document with no code blocks at all.
 */
export function enhanceCodeBlocks(doc) {
    if (!doc || !doc.body) return;

    const pres = doc.body.querySelectorAll('pre');
    const limit = Math.min(pres.length, MAX_BLOCKS_PER_RENDER);

    for (let i = 0; i < limit; i++) {
        const pre = pres[i];
        if (!pre || !pre.parentNode) continue;
        if (pre.closest && pre.closest('.cb-wrap')) continue;
        // Prompt-scaffolding bodies are built by hand elsewhere and own their
        // own chrome; they never reach this pass, but the guard is cheap.
        if (pre.classList && pre.classList.contains('prompt-section-body')) continue;

        wrapPre(doc, pre);
    }
}

function restoreCopyButton(btn) {
    if (!btn.isConnected) return;
    btn.classList.remove('cb-btn-ok');
    btn.innerHTML = ICON_COPY + '<span class="cb-btn-label">Copied</span>';
    const label = btn.querySelector('.cb-btn-label');
    if (label) label.textContent = 'Copy';
    btn.title = 'Copy code block';
}

/** Reads the live text node, so the copy is the exact original source. */
async function handleCopy(wrap, btn) {
    const codeEl = wrap.querySelector('.cb-body-inner pre code')
        || wrap.querySelector('.cb-body-inner pre');
    if (!codeEl) return;

    let copied = false;
    try {
        copied = await copyTextToClipboard(codeEl.textContent || '');
    } catch (err) {
        console.error('Failed to copy code block', err);
        return;
    }
    if (!copied) return;

    const pending = copyTimers.get(btn);
    if (pending) clearTimeout(pending);

    btn.classList.add('cb-btn-ok');
    btn.innerHTML = ICON_CHECK + '<span class="cb-btn-label">Copied</span>';

    const timer = setTimeout(() => {
        copyTimers.delete(btn);
        restoreCopyButton(btn);
    }, COPY_FEEDBACK_MS);
    copyTimers.set(btn, timer);
}

function toggleWrap(wrap) {
    const collapsed = wrap.classList.toggle('cb-collapsed');

    const toggle = wrap.querySelector('[data-cb-action="toggle"]');
    if (!toggle) return;

    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.title = collapsed ? 'Expand code block' : 'Collapse code block';

    const label = toggle.querySelector('.cb-btn-label');
    if (label) label.textContent = collapsed ? 'Expand' : 'Collapse';
}

function handleCodeBlockClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    const btn = target.closest('[data-cb-action]');
    if (btn) {
        const wrap = btn.closest('.cb-wrap');
        if (!wrap) return;
        event.preventDefault();

        const action = btn.getAttribute('data-cb-action');
        if (action === 'copy') {
            handleCopy(wrap, btn);
        } else if (action === 'toggle') {
            toggleWrap(wrap);
        }
        return;
    }

    // Clicking the bar itself toggles too, for a larger hit target.
    const head = target.closest('.cb-head');
    if (!head) return;

    const wrap = head.closest('.cb-wrap');
    if (!wrap) return;
    event.preventDefault();
    toggleWrap(wrap);
}

/**
 * One listener for the whole app lifetime. Called from wireEvents(); the
 * headers themselves are rebuilt constantly and must stay handler-free.
 */
export function wireCodeBlocks() {
    document.addEventListener('click', handleCodeBlockClick);
}
