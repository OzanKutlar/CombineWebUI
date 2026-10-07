import { store, getActiveConversation, touchConversation } from './storage.js';
import { countTokens, applyActiveTokenLimit, updateTokenCount, learnModelTokenLimitFromError } from './tokens.js';
import { createMessageElement, formatMarkdown } from './message.js';
import { saveHistory, renderSidebar } from './sidebar.js';
import { handlePrunePayload } from './prune.js';
import { handleExecutionPayload } from './execution.js';
import { handleSelectPayload } from './selectPayload.js';
import { isStreamingModel } from './models.js';
import { extractReasoningDelta, splitInlineThinking, getInlineTags, buildReplayHistory } from './reasoning.js';
import { renderChatNav, scrollToMessageTop } from './chatNav.js';
import {
    MAX_VARIANTS,
    ensureVariants,
    addVariant,
    getVariantCount,
    getVariantVid,
    findVariantTarget,
    replaceVariantFields,
    setInFlightVariant
} from './messageTree.js';
import { removeBranchByVid, withBranchChange } from './branchOps.js';
import { buildOutgoingMessages, recordSend } from './pruneCache.js';

// Upper bound on reader.read() calls for one streamed reply. Far above any
// real response; it only stops a misbehaving server from spinning forever.
const MAX_STREAM_READS = 2000000;

const STREAM_CONTENT_CLASS = 'prose prose-invert prose-gruvbox max-w-none text-sm break-words leading-relaxed';

export function updateHeaderTitle() {
    const active = getActiveConversation();
    const titleEl = document.getElementById('header-chat-title');
    const title = (active && active.title) ? active.title : 'New Chat';

    if (titleEl) {
        titleEl.textContent = title;
        titleEl.title = title;
    }
    document.title = `${title} - CombineWebUI`;
}

export function renderChat(preserveScroll = false) {
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) return;

    updateHeaderTitle();

    // Captured before the wipe so in-place edits do not yank the view downward.
    const oldScroll = chatContainer.scrollTop;
    chatContainer.innerHTML = '';

    const active = getActiveConversation();
    const history = active ? active.messages : [];

    if (history.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'flex flex-col items-center justify-center h-full text-gb-bgLight3 gap-4 mt-20 animate-fade-in-up';
        empty.innerHTML = '<i data-lucide="message-square-dashed" class="w-16 h-16 opacity-50"></i><p class="font-medium text-gb-fgDark">No chat history. Start a conversation below.</p>';
        chatContainer.appendChild(empty);
    } else {
        history.forEach((msg, i) => {
            chatContainer.appendChild(createMessageElement(msg, i));
        });
    }

    if (preserveScroll) {
        chatContainer.scrollTop = oldScroll;
    } else {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    renderChatNav();
    lucide.createIcons();
}

export async function handleSend() {
    const promptInput = document.getElementById('prompt-input');
    if (!promptInput) return;

    const text = promptInput.value.trim();
    if (!text) return;

    applyActiveTokenLimit();
    if (countTokens(text) > store.activeTokenLimit) return;

    const active = getActiveConversation();
    if (!active) return;

    // Stamped at send time so the token counter can bucket usage by day.
    active.messages.push({ role: 'user', content: text, ts: Date.now() });
    promptInput.value = '';
    updateTokenCount();
    touchConversation(active.id);
    renderSidebar();

    await triggerAPI();
}

function setProcessingUI(isProcessing) {
    const sendBtn = document.getElementById('send-btn');
    const continueBtn = document.getElementById('continue-btn');
    if (!sendBtn || !continueBtn) return;

    if (isProcessing) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i data-lucide="square" class="w-5 h-5 text-gb-bgDarkest fill-current"></i> Stop';
        sendBtn.classList.remove('bg-gb-blue', 'hover:bg-gb-blueAccent');
        sendBtn.classList.add('bg-gb-red', 'hover:bg-gb-redAccent');
        continueBtn.disabled = true;
        continueBtn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        sendBtn.classList.add('bg-gb-blue', 'hover:bg-gb-blueAccent');
        sendBtn.classList.remove('bg-gb-red', 'hover:bg-gb-redAccent');
        sendBtn.innerHTML = '<i data-lucide="send" class="w-5 h-5 text-gb-bgDarkest"></i> Send';
        // Previously never undone, which left Continue dead after the first reply.
        continueBtn.disabled = false;
        continueBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
    lucide.createIcons();
}

/**
 * Updates the thinking panel in place during streaming. Full re-renders would
 * collapse the panel and reset scroll on every delta.
 */
function updateThinkingPanel(index, traceText) {
    const panel = document.getElementById(`thinking-panel-${index}`);
    if (!panel) return;

    const trace = (traceText || '').trim();
    if (!trace) {
        panel.classList.add('hidden');
        return;
    }

    const prefs = store.thinkingPrefs || {};
    if (prefs.show !== false) panel.classList.remove('hidden');

    const body = document.getElementById(`thinking-body-${index}`);
    // Only pay for markdown parsing while the panel is actually open. A
    // collapsed panel renders from msg.reasoning when it is expanded.
    if (body && !body.classList.contains('hidden')) {
        const wasAtBottom = body.scrollHeight - body.clientHeight <= body.scrollTop + 40;
        // Code block chrome is skipped mid-stream; the post-run render
        // reformats with it enabled.
        body.innerHTML = formatMarkdown(trace, { enhanceCode: false });
        if (wasAtBottom) body.scrollTop = body.scrollHeight;
    }

    const meta = document.getElementById(`thinking-meta-${index}`);
    if (meta) meta.textContent = `~${countTokens(trace).toLocaleString()} tok`;

    const preview = document.getElementById(`thinking-preview-${index}`);
    if (preview) preview.textContent = trace.replace(/\s+/g, ' ').slice(-140);
}

/**
 * Where one in-flight response writes. Every write re-resolves the variant by
 * vid, so the reply keeps landing in the right place after the user switches
 * tabs mid-stream, and the DOM is only painted while that variant is on screen.
 */
function createVariantSink(conv, index, vid) {
    return {
        index,
        vid,
        patch(fields) {
            const target = findVariantTarget(conv, index, vid);
            if (target) Object.assign(target, fields);
            return target;
        },
        visibleContentEl() {
            if (store.activeConvId !== conv.id) return null;
            const el = document.getElementById(`msg-content-${index}`);
            return (el && el.dataset.vid === vid) ? el : null;
        }
    };
}

function paintContent(el, text, chatContainer) {
    el.className = STREAM_CONTENT_CLASS;
    el.innerHTML = formatMarkdown(text, { enhanceCode: false });
    if (!chatContainer) return;
    const atBottom = chatContainer.scrollHeight - chatContainer.clientHeight <= chatContainer.scrollTop + 100;
    if (atBottom) chatContainer.scrollTop = chatContainer.scrollHeight;
}

/** Folds one SSE line into the accumulator. Returns true when text changed. */
function applySseLine(line, acc) {
    if (acc.done || !line.startsWith('data: ')) return false;
    const dataStr = line.slice(6);
    if (dataStr === '[DONE]') {
        acc.done = true;
        return false;
    }

    let parsed;
    try {
        parsed = JSON.parse(dataStr);
    } catch (e) {
        // Expected for keep-alives and partial chunks; nothing to apply.
        return false;
    }

    const choice = (parsed && Array.isArray(parsed.choices)) ? parsed.choices[0] : null;
    const delta = (choice && choice.delta) || {};
    let updated = false;

    const reasoningDelta = extractReasoningDelta(delta);
    if (reasoningDelta) {
        acc.reasoning += reasoningDelta;
        updated = true;
    }
    if (typeof delta.content === 'string' && delta.content) {
        acc.raw += delta.content;
        updated = true;
    }
    return updated;
}

function paintStreamProgress(sink, acc, inlineTags, chatContainer) {
    // Streaming mode lets a dangling open tag be treated as an in-progress
    // thought. Reconciled once the stream drains.
    const split = splitInlineThinking(acc.raw, acc.reasoning, inlineTags, { streaming: true });
    const trace = split.extractedThink.trim();
    const content = split.cleanContent;
    const traceChanged = trace !== acc.lastTrace;
    const contentChanged = content !== acc.lastContent;
    if (!traceChanged && !contentChanged) return;

    acc.lastTrace = trace;
    acc.lastContent = content;
    sink.patch({ reasoning: trace, content });

    const el = sink.visibleContentEl();
    if (!el) return;
    try {
        if (traceChanged) updateThinkingPanel(sink.index, trace);
        if (contentChanged && content) paintContent(el, content, chatContainer);
    } catch (e) {
        // A paint failure must not kill the request; the final render repaints.
        console.warn('Failed to paint a streamed delta', e);
    }
}

/** Reads an SSE response into the variant behind `sink`. */
async function consumeStream(res, sink, inlineTags, chatContainer) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        throw new Error('The server returned a streaming response with no readable body.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const acc = { raw: '', reasoning: '', done: false, lastTrace: '', lastContent: '' };
    let buffer = '';
    let drained = false;

    for (let reads = 0; reads < MAX_STREAM_READS; reads++) {
        const { value, done } = await reader.read();
        if (done) {
            drained = true;
            break;
        }
        buffer += decoder.decode(value, { stream: true });

        // Each pass shortens the buffer, so this ends once no newline is left.
        let boundary = buffer.indexOf('\n');
        while (boundary !== -1) {
            const line = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 1);
            if (applySseLine(line, acc)) paintStreamProgress(sink, acc, inlineTags, chatContainer);
            boundary = buffer.indexOf('\n');
        }
    }

    if (!drained) {
        reader.cancel().catch(e => console.warn('Failed to cancel an over-long stream', e));
        throw new Error('The response stream exceeded the maximum number of reads.');
    }

    // The stream is over, so an open tag that never closed was never a
    // thought. Re-parse strictly and hand that text back to the content.
    const finalSplit = splitInlineThinking(acc.raw, acc.reasoning, inlineTags);
    const reasoning = finalSplit.extractedThink.trim();
    sink.patch({ reasoning, content: finalSplit.cleanContent });
    if (sink.visibleContentEl()) updateThinkingPanel(sink.index, reasoning);
}

/**
 * Reads a single non-streamed JSON response, used when the model's endpoint
 * has streaming turned off in Settings.
 */
async function consumeSingleResponse(res, sink, inlineTags, chatContainer) {
    const data = await res.json();
    const choice = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
    const message = (choice && choice.message) ? choice.message : {};
    const rawOutput = typeof message.content === 'string' ? message.content : '';

    // Same extraction the stream uses: structured reasoning fields first, then
    // any inline <think> block lifted out of the visible content.
    const split = splitInlineThinking(rawOutput, extractReasoningDelta(message), inlineTags);
    const trace = split.extractedThink.trim();
    sink.patch({ reasoning: trace, content: split.cleanContent });

    const el = sink.visibleContentEl();
    if (!el) return;
    updateThinkingPanel(sink.index, trace);
    // The post-run render repaints regardless; this only stops a blank flash.
    // Where the view ends up is decided by finishRun, same as for streams.
    if (split.cleanContent) paintContent(el, split.cleanContent, null);
}

/** A response body can only be read once, so it is read as text and parsed. */
async function readErrorMessage(res) {
    const fallback = `Server returned HTTP ${res.status}`;
    let text = '';
    try {
        text = await res.text();
    } catch (e) {
        console.warn('Could not read the error response body', e);
        return fallback;
    }
    if (!text) return fallback;

    try {
        const data = JSON.parse(text);
        if (data && data.error && data.error.message) return data.error.message;
        return JSON.stringify(data, null, 2);
    } catch (e) {
        // Not JSON: the raw body is the most useful message available.
        return text;
    }
}

async function requestCompletion(model, replayHistory, useStream, signal) {
    const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: replayHistory,
            stream: useStream,
            max_tokens: 16384
        }),
        signal
    });

    if (!res.ok) {
        throw new Error(await readErrorMessage(res));
    }
    return res;
}

async function handleRunFailure(conv, index, vid, model, err) {
    if (err && err.name === 'AbortError') {
        // Only discard when nothing was captured. A run stopped mid-reasoning
        // still has a trace worth keeping.
        const target = findVariantTarget(conv, index, vid);
        const hasAnything = Boolean(target)
            && (Boolean(target.content) || Boolean((target.reasoning || '').trim()));
        if (target && !hasAnything) removeBranchByVid(conv, index, vid);
        return;
    }

    const message = (err && err.message) ? err.message : String(err);
    try {
        await learnModelTokenLimitFromError(message, model);
    } catch (learnErr) {
        console.warn('Could not learn a token limit from the error', learnErr);
    }
    // Only this response turns red; its siblings are untouched.
    replaceVariantFields(conv, index, vid, { content: message, model, isError: true, ts: Date.now() });
}

/**
 * Parses payloads on a finished response. Execution info is stored on the
 * variant wherever it lives. Prunes are applied only if the response is still
 * on screen; a hidden one is picked up by the branch replay when switched to.
 */
function finalizeVariant(conv, index, vid) {
    const target = findVariantTarget(conv, index, vid);
    if (!target || target.isError) return;

    const pathView = conv.messages.slice(0, index).concat([target]);
    handleExecutionPayload(target, pathView);
    // Parsed once here and cached; rendering only reads selectInfo.
    handleSelectPayload(target);
    if (target === conv.messages[index]) {
        handlePrunePayload(target, conv);
    }
}

/**
 * Glides up to the top of a reply that just finished on screen. Deferred a
 * frame so the post-run render, icons and code block chrome are laid out
 * before anything is measured.
 */
function scheduleScrollToReplyTop(conv, index) {
    const run = () => {
        // The user may have switched threads in the frame since.
        if (store.activeConvId !== conv.id) return;
        try {
            scrollToMessageTop(index, { onlyIfAbove: true });
        } catch (e) {
            console.warn('Failed to scroll to the finished reply', e);
        }
    };

    if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
    } else {
        run();
    }
}

function finishRun(conv, index, vid) {
    try {
        finalizeVariant(conv, index, vid);
    } catch (e) {
        console.error('Failed to post-process the response', e);
    }

    const target = findVariantTarget(conv, index, vid);
    const onScreen = Boolean(target) && target === conv.messages[index];

    touchConversation(conv.id);
    saveHistory();
    // Keep wherever the stream left the view; jumping to the bottom here is
    // what used to strand the reader at the end of the reply.
    renderChat(true);
    setProcessingUI(false);
    updateTokenCount();
    if (onScreen) scheduleScrollToReplyTop(conv, index);
}

/** One request, written into the variant identified by vid. */
async function runCompletion(conv, index, vid, model) {
    const chatContainer = document.getElementById('chat-container');
    const inlineTags = getInlineTags();
    // Per-endpoint preference from Settings. Copilot models are always true.
    const useStream = isStreamingModel(model);
    const sink = createVariantSink(conv, index, vid);

    setInFlightVariant(vid);
    store.isProcessing = true;
    store.currentAbortController = new AbortController();
    const signal = store.currentAbortController.signal;

    saveHistory();
    renderChat();
    setProcessingUI(true);

    try {
        const prefix = conv.messages.slice(0, index);
        const sentAt = Date.now();
        // Prunes are resolved per model here, so a warm cache keeps its prefix.
        const outgoing = buildOutgoingMessages(conv, prefix, model, sentAt);
        // Recorded on the response so the token counter bills what was sent.
        sink.patch({ sentPrunedIdx: outgoing.sentPrunedIdx });
        const replayHistory = buildReplayHistory(outgoing.messages);
        const res = await requestCompletion(model, replayHistory, useStream, signal);
        // The upstream has read the prompt by now, so its cache holds this form.
        recordSend(conv, prefix, model, outgoing, sentAt);
        if (useStream) {
            await consumeStream(res, sink, inlineTags, chatContainer);
        } else {
            await consumeSingleResponse(res, sink, inlineTags, chatContainer);
        }
    } catch (e) {
        await handleRunFailure(conv, index, vid, model, e);
    } finally {
        setInFlightVariant(null);
        store.isProcessing = false;
        store.currentAbortController = null;
        finishRun(conv, index, vid);
    }
}

/** Appends a new assistant turn and generates it with the selected model. */
export async function triggerAPI() {
    const conv = getActiveConversation();
    if (!conv || store.isProcessing) return;

    // Captured up front so a later model switch cannot mislabel the reply.
    const model = store.selectedModel;
    const index = conv.messages.length;
    const slot = { role: 'assistant', content: '', model, reasoning: '', ts: Date.now() };
    ensureVariants(slot);
    conv.messages.push(slot);

    await runCompletion(conv, index, getVariantVid(slot, 0), model);
}

/**
 * Generates one more response for an existing assistant turn, as a sibling of
 * the replies already there. It sees exactly the context the original reply
 * saw: everything before the turn, with that turn's later prunes undone.
 */
export async function addModelResponse(index, modelId) {
    if (store.isProcessing) {
        alert('Please stop the current generation before adding a response.');
        return false;
    }
    if (typeof modelId !== 'string' || !modelId) return false;

    const conv = getActiveConversation();
    if (!conv || !Array.isArray(conv.messages)) return false;
    const slot = conv.messages[index];
    if (!slot || slot.role !== 'assistant') return false;

    if (getVariantCount(slot) >= MAX_VARIANTS) {
        alert(`This turn already has the maximum of ${MAX_VARIANTS} responses.`);
        return false;
    }

    let vid = '';
    withBranchChange(conv, index, () => {
        vid = addVariant(conv, index, { content: '', model: modelId, reasoning: '', ts: Date.now() });
        return Boolean(vid);
    });
    if (!vid) return false;

    touchConversation(conv.id);
    renderSidebar();
    await runCompletion(conv, index, vid, modelId);
    return true;
}
