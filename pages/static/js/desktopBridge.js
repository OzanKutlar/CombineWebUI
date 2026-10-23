/**
 * Desktop mode bridge.
 *
 * In the desktop window (python main.py desktop) there is no HTTP server.
 * This script replaces fetch() and EventSource for same-origin /v1/ URLs and
 * carries each request over Qt's QWebChannel to the FastAPI app running
 * in-process. Responses stream back chunk by chunk, so a streamed reply behaves
 * exactly as it does over HTTP. In a normal browser qt.webChannelTransport does
 * not exist and this file does nothing.
 *
 * It must load as a classic script above every module script, so the modules
 * only ever see the replaced fetch and EventSource.
 */
(function () {
    'use strict';

    const transport = window.qt && window.qt.webChannelTransport;
    if (!transport) return;

    const CHANNEL_SCRIPT = '/__desktop__/qwebchannel.js';
    const API_PREFIX = '/v1/';
    const READY_TIMEOUT_MS = 15000;
    const MAX_PENDING = 64;
    const BINARY_SLICE = 0x8000;
    const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];
    const MAX_EVENT_READS = 10000000;
    const MAX_EVENT_BUFFER_CHARS = 8 * 1024 * 1024;
    const MAX_EVENT_LINES = 10000;

    const nativeFetch = window.fetch.bind(window);
    const NativeEventSource = window.EventSource;
    const pending = new Map();
    let counter = 0;
    let bridge = null;

    // ------------------------------------------------------------------
    // Encoding
    // ------------------------------------------------------------------

    function bytesToBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += BINARY_SLICE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BINARY_SLICE));
        }
        return btoa(binary);
    }

    function base64ToBytes(text) {
        const binary = atob(text || '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    async function bodyToBase64(body) {
        if (body === undefined || body === null) return '';
        if (typeof body === 'string') return bytesToBase64(new TextEncoder().encode(body));
        if (body instanceof URLSearchParams) return bytesToBase64(new TextEncoder().encode(body.toString()));
        if (body instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(body));
        if (ArrayBuffer.isView(body)) return bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
        if (body instanceof Blob) return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
        throw new TypeError('The desktop bridge cannot send this kind of request body.');
    }

    function headerPairs(init) {
        const pairs = [];
        new Headers(init || {}).forEach((value, name) => pairs.push([name, value]));
        return pairs;
    }

    function abortError() {
        return new DOMException('The operation was aborted.', 'AbortError');
    }

    // ------------------------------------------------------------------
    // Channel
    // ------------------------------------------------------------------

    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The desktop bridge did not start in time.')), READY_TIMEOUT_MS);
        const finish = (fn, value) => {
            clearTimeout(timer);
            fn(value);
        };
        const script = document.createElement('script');
        script.src = CHANNEL_SCRIPT;
        script.onerror = () => finish(reject, new Error('Could not load ' + CHANNEL_SCRIPT + '.'));
        script.onload = () => {
            try {
                new window.QWebChannel(transport, (channel) => {
                    const object = channel.objects.bridge;
                    if (!object) {
                        finish(reject, new Error('The desktop bridge object is missing.'));
                        return;
                    }
                    object.responseStarted.connect(onStarted);
                    object.responseChunk.connect(onChunk);
                    object.responseFinished.connect(onFinished);
                    bridge = object;
                    finish(resolve, object);
                });
            } catch (e) {
                finish(reject, e);
            }
        };
        (document.head || document.documentElement).appendChild(script);
    });
    ready.catch((e) => console.error('Desktop bridge unavailable; API calls will fail.', e));

    // ------------------------------------------------------------------
    // Responses
    // ------------------------------------------------------------------

    function settle(id) {
        const entry = pending.get(id);
        if (!entry) return null;
        pending.delete(id);
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
        return entry;
    }

    function failStream(entry, error) {
        if (!entry.controller) return;
        try {
            entry.controller.error(error);
        } catch (e) {
            console.debug('Desktop bridge: the stream was already closed', e);
        }
    }

    function onStarted(id, status, headersJson) {
        const entry = pending.get(id);
        if (!entry || entry.started) return;
        entry.started = true;
        let list = [];
        try {
            list = JSON.parse(headersJson || '[]');
        } catch (e) {
            console.warn('Desktop bridge: unreadable response headers', e);
        }
        const headers = new Headers();
        (Array.isArray(list) ? list : []).forEach((pair) => {
            try {
                headers.append(pair[0], pair[1]);
            } catch (e) {
                console.debug('Desktop bridge: skipped a response header', e);
            }
        });
        const hasBody = NULL_BODY_STATUSES.indexOf(status) === -1;
        const stream = hasBody ? new ReadableStream({
            start(controller) { entry.controller = controller; },
            cancel() { abortRequest(id); }
        }) : null;
        try {
            entry.resolve(new Response(stream, { status, headers }));
        } catch (e) {
            settle(id);
            if (bridge) bridge.abort(id);
            entry.reject(new TypeError('Desktop bridge: invalid response (' + e.message + ')'));
        }
    }

    function onChunk(id, data) {
        const entry = pending.get(id);
        if (!entry || !entry.controller) return;
        try {
            entry.controller.enqueue(base64ToBytes(data));
        } catch (e) {
            console.warn('Desktop bridge: dropped a response chunk', e);
            abortRequest(id);
        }
    }

    function onFinished(id, error) {
        const entry = settle(id);
        if (!entry) return;
        let problem = error;
        if (!problem && !entry.started) problem = 'the response ended before it started';
        if (problem) {
            const failure = new TypeError('Desktop bridge: ' + problem);
            if (entry.started) failStream(entry, failure);
            else entry.reject(failure);
            return;
        }
        if (!entry.controller) return;
        try {
            entry.controller.close();
        } catch (e) {
            console.debug('Desktop bridge: the stream was already closed', e);
        }
    }

    function abortRequest(id) {
        const entry = settle(id);
        if (!entry) return;
        try {
            if (bridge) bridge.abort(id);
        } catch (e) {
            console.warn('Desktop bridge: could not cancel request ' + id, e);
        }
        if (entry.started) failStream(entry, abortError());
        else entry.reject(abortError());
    }

    // ------------------------------------------------------------------
    // fetch
    // ------------------------------------------------------------------

    function nextId() {
        counter = (counter + 1) % 1000000000;
        return 'r' + Date.now().toString(36) + '_' + counter.toString(36);
    }

    async function bridgeFetch(target, init) {
        const options = init || {};
        const signal = options.signal || null;
        if (signal && signal.aborted) throw abortError();
        const method = String(options.method || 'GET').toUpperCase();
        const headers = JSON.stringify(headerPairs(options.headers));
        const body = await bodyToBase64(options.body);
        const channelBridge = await ready;
        if (signal && signal.aborted) throw abortError();
        if (pending.size >= MAX_PENDING) throw new TypeError('Desktop bridge: too many requests in flight.');
        const id = nextId();
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, started: false, controller: null, signal, onAbort: null };
            if (signal) {
                entry.onAbort = () => abortRequest(id);
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            pending.set(id, entry);
            try {
                channelBridge.request(id, method, target, headers, body);
            } catch (e) {
                settle(id);
                reject(new TypeError('Desktop bridge: ' + (e && e.message ? e.message : 'the request failed')));
            }
        });
    }

    /** Path and query for a same-origin /v1/ URL, or null when it is not an API call. */
    function apiTarget(input) {
        let raw = null;
        if (typeof input === 'string') raw = input;
        else if (input instanceof URL) raw = input.href;
        if (raw === null) return null;
        let url;
        try {
            url = new URL(raw, window.location.href);
        } catch (e) {
            return null;
        }
        if (url.protocol !== window.location.protocol || url.host !== window.location.host) return null;
        if (url.pathname.indexOf(API_PREFIX) !== 0) return null;
        return url.pathname + url.search;
    }

    window.fetch = function fetch(input, init) {
        const target = apiTarget(input);
        if (target === null) return nativeFetch(input, init);
        return bridgeFetch(target, init);
    };

    // ------------------------------------------------------------------
    // EventSource
    // ------------------------------------------------------------------

    class BridgeEventSource {
        constructor(url) {
            this.url = String(url);
            this.withCredentials = false;
            this.readyState = BridgeEventSource.CONNECTING;
            this.onopen = null;
            this.onmessage = null;
            this.onerror = null;
            this._listeners = new Map();
            this._abort = new AbortController();
            this._run();
        }

        addEventListener(type, listener) {
            if (typeof listener !== 'function') return;
            if (!this._listeners.has(type)) this._listeners.set(type, new Set());
            this._listeners.get(type).add(listener);
        }

        removeEventListener(type, listener) {
            const set = this._listeners.get(type);
            if (set) set.delete(listener);
        }

        close() {
            if (this.readyState === BridgeEventSource.CLOSED) return;
            this.readyState = BridgeEventSource.CLOSED;
            this._abort.abort();
        }

        _emit(type, event) {
            const handlers = [];
            const property = this['on' + type];
            if (typeof property === 'function') handlers.push(property);
            const set = this._listeners.get(type);
            if (set) set.forEach((fn) => handlers.push(fn));
            handlers.forEach((fn) => {
                try {
                    fn.call(this, event);
                } catch (e) {
                    console.error('EventSource listener failed', e);
                }
            });
        }

        async _run() {
            try {
                const res = await window.fetch(this.url, {
                    signal: this._abort.signal,
                    headers: { Accept: 'text/event-stream' }
                });
                if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
                if (this.readyState === BridgeEventSource.CLOSED) return;
                this.readyState = BridgeEventSource.OPEN;
                this._emit('open', new Event('open'));
                await this._pump(res.body.getReader());
            } catch (e) {
                if (this.readyState === BridgeEventSource.CLOSED) return;
                console.warn('Desktop event stream failed', e);
            }
            if (this.readyState === BridgeEventSource.CLOSED) return;
            this.readyState = BridgeEventSource.CLOSED;
            this._emit('error', new Event('error'));
        }

        async _pump(reader) {
            const decoder = new TextDecoder();
            let buffer = '';
            for (let reads = 0; reads < MAX_EVENT_READS; reads++) {
                const { value, done } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    this._dispatch(buffer.slice(0, boundary));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf('\n\n');
                }
                if (buffer.length > MAX_EVENT_BUFFER_CHARS) throw new Error('An event exceeded the size limit.');
            }
            throw new Error('The event stream exceeded the read limit.');
        }

        _dispatch(block) {
            let type = 'message';
            const data = [];
            block.split('\n').slice(0, MAX_EVENT_LINES).forEach((line) => {
                if (!line || line.charAt(0) === ':') return;
                const colon = line.indexOf(':');
                const field = colon === -1 ? line : line.slice(0, colon);
                let value = colon === -1 ? '' : line.slice(colon + 1);
                if (value.charAt(0) === ' ') value = value.slice(1);
                if (field === 'data') data.push(value);
                else if (field === 'event' && value) type = value;
            });
            if (data.length === 0) return;
            this._emit(type, new MessageEvent(type, { data: data.join('\n') }));
        }
    }

    BridgeEventSource.CONNECTING = 0;
    BridgeEventSource.OPEN = 1;
    BridgeEventSource.CLOSED = 2;

    function DesktopEventSource(url, options) {
        if (apiTarget(String(url)) === null) return new NativeEventSource(url, options);
        return new BridgeEventSource(url);
    }
    DesktopEventSource.CONNECTING = 0;
    DesktopEventSource.OPEN = 1;
    DesktopEventSource.CLOSED = 2;
    window.EventSource = DesktopEventSource;
})();
