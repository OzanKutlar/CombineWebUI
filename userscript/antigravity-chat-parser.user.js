// ==UserScript==
// @name         Antigravity AI Chat Scaffolding & Execution Parser
// @namespace    https://github.com/antigravity-parser
// @version      1.0.0
// @description  Parses combineCopy prompt scaffolding (files, AST, system notes) and AI execution/prune payloads into clean cards and diff accordions on Gemini, ChatGPT, Claude, DeepSeek, and more.
// @author       Antigravity
// @match        https://gemini.google.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://chat.deepseek.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=gemini.google.com
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================================
       1. STYLESHEET INJECTION
       ========================================================================= */
    const STYLES = `
        .ag-parsed-root {
            display: flex;
            flex-direction: column;
            gap: 10px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: #ebdbb2;
            margin: 8px 0;
            width: 100%;
        }
        .ag-card {
            background-color: #1d2021;
            border: 1px solid #3c3836;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            font-size: 13px;
        }
        .ag-blockquote {
            background: rgba(131, 165, 152, 0.22);
            border: 1px solid rgba(131, 165, 152, 0.35);
            border-radius: 6px;
            padding: 10px 14px;
            margin: 8px 0;
            color: #ebdbb2;
        }
        .ag-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            background-color: #282828;
            border-bottom: 1px solid #3c3836;
            gap: 10px;
        }
        .ag-card-title {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
            color: #fbf1c7;
        }
        .ag-accordion-btn {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            background-color: #282828;
            border: none;
            color: #ebdbb2;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            text-align: left;
            transition: background-color 0.15s ease;
        }
        .ag-accordion-btn:hover {
            background-color: #3c3836;
        }
        .ag-accordion-content {
            display: none;
            padding: 10px 12px;
            background-color: #1d2021;
            border-top: 1px solid #3c3836;
            max-height: 400px;
            overflow-y: auto;
            flex-direction: column;
            gap: 6px;
        }
        .ag-accordion-content.ag-open {
            display: flex;
        }
        .ag-file-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 10px;
            background-color: #282828;
            border: 1px solid #3c3836;
            border-radius: 6px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            color: #ebdbb2;
        }
        .ag-file-path {
            display: flex;
            align-items: center;
            gap: 6px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .ag-badge {
            font-size: 11px;
            font-weight: bold;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: ui-monospace, monospace;
        }
        .ag-stat-add { color: #b8bb26; font-weight: 700; }
        .ag-stat-del { color: #fb4934; font-weight: 700; }
        .ag-btn-copy {
            background-color: #3c3836;
            color: #ebdbb2;
            border: 1px solid #504945;
            border-radius: 6px;
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            transition: all 0.2s ease;
        }
        .ag-btn-copy:hover {
            background-color: #504945;
            color: #fbf1c7;
        }
        .ag-btn-toggle-raw {
            background: transparent;
            border: none;
            color: #83a598;
            font-size: 11px;
            cursor: pointer;
            text-decoration: underline;
            padding: 2px 4px;
        }
        .ag-user-req-box {
            padding: 12px 14px;
            background-color: #282828;
            border: 1px solid #3c3836;
            border-radius: 8px;
            font-family: ui-monospace, monospace;
            font-size: 13px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
            color: #fbf1c7;
        }
        .ag-code-pre {
            margin: 0;
            padding: 8px;
            background-color: #1d2021;
            border: 1px solid #3c3836;
            border-radius: 4px;
            font-family: ui-monospace, monospace;
            font-size: 11px;
            color: #d5c4a1;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .ag-badge-partial {
            font-size: 10px;
            text-transform: uppercase;
            padding: 1px 5px;
            border-radius: 4px;
            color: #8ec07c;
            background: rgba(142, 192, 124, 0.15);
            border: 1px solid rgba(142, 192, 124, 0.3);
        }
        .ag-badge-pruned {
            font-size: 10px;
            text-transform: uppercase;
            padding: 1px 5px;
            border-radius: 4px;
            color: #fb4934;
            background: rgba(251, 73, 52, 0.15);
            border: 1px solid rgba(251, 73, 52, 0.3);
        }
        .ag-icon {
            width: 14px;
            height: 14px;
            fill: currentColor;
            flex-shrink: 0;
        }
    `;

    const ICONS = {
        box: `<svg class="ag-icon" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>`,
        copy: `<svg class="ag-icon" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"></path></svg>`,
        check: `<svg class="ag-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" stroke-width="2"></polyline></svg>`,
        folder: `<svg class="ag-icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="2"></path></svg>`,
        file: `<svg class="ag-icon" viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" fill="none" stroke="currentColor" stroke-width="2"></path><polyline points="13 2 13 9 20 9" fill="none" stroke="currentColor" stroke-width="2"></polyline></svg>`,
        chevronDown: `<svg class="ag-icon" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" fill="none" stroke="currentColor" stroke-width="2"></polyline></svg>`,
        chevronUp: `<svg class="ag-icon" viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15" fill="none" stroke="currentColor" stroke-width="2"></polyline></svg>`,
        user: `<svg class="ag-icon" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" fill="none" stroke="currentColor" stroke-width="2"></path><circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"></circle></svg>`,
        git: `<svg class="ag-icon" viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="15" stroke="currentColor" stroke-width="2"></line><circle cx="18" cy="6" r="3" stroke="currentColor" stroke-width="2" fill="none"></circle><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2" fill="none"></circle><path d="M18 9a9 9 0 0 1-9 9" fill="none" stroke="currentColor" stroke-width="2"></path></svg>`
    };

    function injectStyles() {
        if (document.getElementById('ag-userscript-styles')) return;
        const styleEl = document.createElement('style');
        styleEl.id = 'ag-userscript-styles';
        styleEl.textContent = STYLES;
        document.head.appendChild(styleEl);
    }

    /* =========================================================================
       2. LINE DIFF & STATS COMPUTATION
       ========================================================================= */
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
        return { a: a.slice(start, endA + 1), b: b.slice(start, endB + 1) };
    }

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

    function diffLineCounts(oldText, newText) {
        const rawOld = splitLines(oldText);
        const rawNew = splitLines(newText);
        const { a, b } = trimCommon(rawOld, rawNew);
        if (a.length === 0 && b.length === 0) return { added: 0, removed: 0 };
        if (a.length > 1500 || b.length > 1500) {
            return { added: b.length, removed: a.length };
        }
        const common = lcsLength(a, b);
        return { added: b.length - common, removed: a.length - common };
    }

    function countLines(text) {
        if (typeof text !== 'string' || text.length === 0) return 0;
        return (text.match(/\n/g) || []).length + 1;
    }

    /* =========================================================================
       3. PROMPT SCAFFOLDING PARSER
       ========================================================================= */
    const HEADERS = [
        { id: 'user_request', title: 'User Request', icon: ICONS.user, match: '--- USER REQUEST ---' },
        { id: 'user_reminder', title: 'User Request (Reminder)', icon: ICONS.user, match: '--- USER REQUEST (Reminder) ---' },
        { id: 'ast_map', title: 'Directory AST Map', icon: ICONS.git, match: '--- DIRECTORY AST MAP ---' },
        { id: 'file_context', title: 'File Context', icon: ICONS.folder, match: '--- FILE CONTEXT ---' },
        { id: 'requested_file_context', title: 'File Context', icon: ICONS.folder, match: '--- REQUESTED FILE CONTEXT ---' },
        { id: 'git_diff', title: 'Uncommitted Git Diff', icon: ICONS.git, match: '--- CURRENT UNCOMMITTED GIT DIFF ---' },
        { id: 'system_prompt', title: 'System Instructions', icon: ICONS.box, match: '--- SYSTEM INSTRUCTIONS ---' },
        { id: 'system_reminder', title: 'System Reminder', icon: ICONS.box, match: '--- SYSTEM REMINDER ---' }
    ];

    function scanFileBlocks(text) {
        const files = [];
        if (typeof text !== 'string' || !text) return files;
        const re = /-{35}\r?\nFILE: (.*?)\r?\n-{35}\r?\n/g;
        const starts = [];
        let m;
        while ((m = re.exec(text)) !== null) {
            starts.push({ headerStart: m.index, bodyStart: m.index + m[0].length, path: (m[1] || '').trim() });
        }
        for (let i = 0; i < starts.length; i++) {
            const cur = starts[i];
            const blockEnd = (i + 1 < starts.length) ? starts[i + 1].headerStart : text.length;
            const rawBody = text.slice(cur.bodyStart, blockEnd);
            const isPruned = rawBody.includes('(Has been removed from context because:');
            const isPartial = !isPruned && rawBody.includes('hidden) ...');
            files.push({
                path: cur.path,
                content: rawBody.trim(),
                isPruned,
                isPartial,
                start: cur.headerStart,
                end: blockEnd
            });
        }
        return files;
    }

    function parsePromptScaffolding(raw) {
        if (typeof raw !== 'string' || !raw) return { isStructured: false };
        const files = scanFileBlocks(raw);
        const lines = raw.split('\n');
        let userRequest = null;
        const sections = [];

        let currentSection = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const matchedHeader = HEADERS.find(h => h.match === line);
            if (matchedHeader) {
                if (currentSection) sections.push(currentSection);
                currentSection = { id: matchedHeader.id, title: matchedHeader.title, icon: matchedHeader.icon, lines: [] };
            } else if (currentSection) {
                currentSection.lines.push(lines[i]);
            }
        }
        if (currentSection) sections.push(currentSection);

        sections.forEach(s => {
            const body = s.lines.join('\n').trim();
            if (s.id === 'user_request' || s.id === 'user_reminder') {
                if (!userRequest && body) userRequest = body;
            }
            s.body = body;
        });

        const isStructured = files.length > 0 || userRequest !== null || sections.length > 0;
        return { isStructured, userRequest, files, sections };
    }

    /* =========================================================================
       4. EXECUTION PAYLOAD EXTRACTOR
       ========================================================================= */
    function scanJsonObjects(text) {
        const results = [];
        let idx = 0;
        let guard = 0;
        while (idx < text.length && guard < 20) {
            const start = text.indexOf('{', idx);
            if (start === -1) break;
            let depth = 0, inString = false, escapeNext = false, end = -1;
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
                results.push({ raw, start, end: end + 1 });
                idx = end + 1;
            } else {
                idx = start + 1;
            }
            guard++;
        }
        return results;
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

    function safeJsonParse(raw) {
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

    function extractExecutionPayloads(text) {
        if (typeof text !== 'string' || !text) return [];
        const payloads = [];
        const candidates = scanJsonObjects(text);
        for (let i = 0; i < candidates.length; i++) {
            const data = safeJsonParse(candidates[i].raw);
            if (data && data.phase === 'EXECUTION' && Array.isArray(data.files)) {
                payloads.push({ raw: candidates[i].raw, data });
            }
        }
        return payloads;
    }

    function copyToClipboard(text, btnEl) {
        if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(text);
        } else if (navigator.clipboard) {
            navigator.clipboard.writeText(text);
        }
        if (btnEl) {
            const orig = btnEl.innerHTML;
            btnEl.innerHTML = `${ICONS.check} <span>Copied</span>`;
            setTimeout(() => { btnEl.innerHTML = orig; }, 2000);
        }
    }

    /* =========================================================================
       5. UI COMPONENT BUILDERS
       ========================================================================= */
    function createAccordion(title, iconSvg, subtitle, contentNodes) {
        const card = document.createElement('div');
        card.className = 'ag-card';

        const btn = document.createElement('button');
        btn.className = 'ag-accordion-btn';
        btn.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                ${iconSvg}
                <span>${title}</span>
                ${subtitle ? `<span style="font-size:11px; color:#a89984; font-weight:normal;">${subtitle}</span>` : ''}
            </div>
            <span class="ag-chevron">${ICONS.chevronDown}</span>
        `;

        const content = document.createElement('div');
        content.className = 'ag-accordion-content';
        contentNodes.forEach(node => content.appendChild(node));

        btn.onclick = () => {
            const isOpen = content.classList.toggle('ag-open');
            btn.querySelector('.ag-chevron').innerHTML = isOpen ? ICONS.chevronUp : ICONS.chevronDown;
        };

        card.appendChild(btn);
        card.appendChild(content);
        return card;
    }

    function renderParsedUserPrompt(parsed, originalText) {
        const root = document.createElement('div');
        root.className = 'ag-parsed-root';

        if (parsed.userRequest) {
            const reqBox = document.createElement('div');
            reqBox.className = 'ag-user-req-box';
            reqBox.textContent = parsed.userRequest;
            root.appendChild(reqBox);
        }

        if (parsed.files && parsed.files.length > 0) {
            const fileRows = parsed.files.map(f => {
                const row = document.createElement('div');
                row.className = 'ag-file-row';
                row.innerHTML = `
                    <div class="ag-file-path">
                        ${ICONS.file}
                        <span>${f.path}</span>
                    </div>
                    <div>
                        ${f.isPruned ? '<span class="ag-badge-pruned">PRUNED</span>' : ''}
                        ${f.isPartial ? '<span class="ag-badge-partial">PARTIAL</span>' : ''}
                    </div>
                `;
                return row;
            });
            root.appendChild(createAccordion(`${parsed.files.length} Files Provided`, ICONS.folder, '', fileRows));
        }

        (parsed.sections || []).forEach(sec => {
            if (sec.id === 'user_request' || sec.id === 'user_reminder' || !sec.body) return;
            const pre = document.createElement('pre');
            pre.className = 'ag-code-pre';
            pre.textContent = sec.body;
            root.appendChild(createAccordion(sec.title, sec.icon || ICONS.box, '', [pre]));
        });

        return root;
    }

    function renderExecutionCard(payloadObj) {
        const data = payloadObj.data;
        const files = Array.isArray(data.files) ? data.files : [];

        let totalAdd = 0, totalDel = 0;
        const fileNodes = files.map(f => {
            const row = document.createElement('div');
            row.className = 'ag-file-row';
            let add = 0, del = 0;
            const action = (f.action || 'modify').toLowerCase();
            if (action === 'create') add = countLines(f.content || '');
            else if (action === 'delete') del = countLines(f.content || '');
            else if (Array.isArray(f.search_replace)) {
                f.search_replace.forEach(sr => {
                    const d = diffLineCounts(sr.search || '', sr.replace || '');
                    add += d.added;
                    del += d.removed;
                });
            } else if (f.content) {
                add = countLines(f.content);
            }
            totalAdd += add;
            totalDel += del;

            row.innerHTML = `
                <div class="ag-file-path">
                    ${ICONS.file}
                    <span>${f.path || f.command || 'unknown'}</span>
                </div>
                <div style="display:flex; gap:6px;">
                    <span class="ag-stat-add">+${add}</span>
                    <span class="ag-stat-del">-${del}</span>
                </div>
            `;
            return row;
        });

        const card = document.createElement('div');
        card.className = 'ag-card';

        const header = document.createElement('div');
        header.className = 'ag-card-header';
        header.innerHTML = `
            <div class="ag-card-title">
                ${ICONS.box}
                <span>Execution Payload (${files.length} files)</span>
                <span style="font-size:12px; margin-left:8px;"><span class="ag-stat-add">+${totalAdd}</span> <span class="ag-stat-del">-${totalDel}</span></span>
            </div>
            <button class="ag-btn-copy">${ICONS.copy} <span>Copy Payload</span></button>
        `;

        header.querySelector('.ag-btn-copy').onclick = (e) => {
            e.stopPropagation();
            copyToClipboard(payloadObj.raw, e.currentTarget);
        };

        card.appendChild(header);
        if (data.commit_message) {
            const commitDiv = document.createElement('div');
            commitDiv.style.cssText = 'padding:8px 14px; font-family:monospace; font-size:11px; color:#a89984; border-bottom:1px solid #3c3836; background:#1d2021;';
            commitDiv.textContent = data.commit_message;
            card.appendChild(commitDiv);
        }

        const contentDiv = document.createElement('div');
        contentDiv.style.cssText = 'padding:10px 12px; display:flex; flex-direction:column; gap:6px; background:#1d2021;';
        fileNodes.forEach(n => contentDiv.appendChild(n));
        card.appendChild(contentDiv);

        return card;
    }

    /* =========================================================================
       6. DOM OBSERVER & PLATFORM ADAPTERS
       ========================================================================= */
    const PROCESSED_ATTR = 'data-ag-parsed';

    function processMessageNode(node) {
        if (node.getAttribute(PROCESSED_ATTR)) return;
        const text = node.innerText || node.textContent || '';
        if (!text || text.length < 20) return;

        // 1. Check for EXECUTION payload
        if (text.includes('"phase"') && text.includes('"EXECUTION"')) {
            const payloads = extractExecutionPayloads(text);
            if (payloads.length > 0) {
                node.setAttribute(PROCESSED_ATTR, 'true');
                payloads.forEach(p => {
                    const card = renderExecutionCard(p);
                    node.insertAdjacentElement('beforebegin', card);
                });
                return;
            }
        }

        // 2. Check for Structured Prompt Scaffolding
        if (text.includes('--- USER REQUEST') || text.includes('--- FILE CONTEXT ---') || text.includes('-----------------------------------')) {
            const parsed = parsePromptScaffolding(text);
            if (parsed.isStructured) {
                node.setAttribute(PROCESSED_ATTR, 'true');
                const parsedView = renderParsedUserPrompt(parsed, text);
                
                // Add Raw Toggle
                const toggle = document.createElement('button');
                toggle.className = 'ag-btn-toggle-raw';
                toggle.textContent = 'Toggle Raw Prompt';
                toggle.onclick = () => {
                    node.style.display = node.style.display === 'none' ? '' : 'none';
                };

                node.style.display = 'none';
                node.insertAdjacentElement('beforebegin', parsedView);
                node.insertAdjacentElement('beforebegin', toggle);
            }
        }
    }

    function scanAllMessages() {
        injectStyles();
        const selectors = [
            'message-content',             // Gemini
            '.model-response-text',        // Gemini alternate
            '.query-text',                 // Gemini user query
            '[data-message-author-role]',  // ChatGPT
            '.font-claude-message',        // Claude
            '.whitespace-pre-wrap',        // DeepSeek
            '.markdown-body'              // Generic
        ];
        const candidates = document.querySelectorAll(selectors.join(', '));
        candidates.forEach(processMessageNode);
    }

    // Throttled observer
    let timeout = null;
    const observer = new MutationObserver(() => {
        if (timeout) return;
        timeout = setTimeout(() => {
            scanAllMessages();
            timeout = null;
        }, 200);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scanAllMessages();
})();
