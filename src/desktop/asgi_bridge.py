"""Runs the FastAPI app in-process, without a socket.

Each request becomes a direct ASGI call on a private asyncio loop that lives
in one background thread. Response events are handed to a sink as soon as the
app sends them, so streamed chat completions still stream. Nothing here binds,
listens on or connects to a socket; the outbound calls the app makes to model
endpoints are its own.

A sink is any object with three methods, all called on the loop thread:
on_start(status, headers), on_chunk(data) and on_done(error), where error is
None for a complete response and a short string otherwise. A request aborted
before it began running gets no on_done; whoever aborted it already knows.
"""
import asyncio
import functools
import threading
from urllib.parse import unquote, urlsplit

from src.config import logger

API_PREFIX = '/v1/'
ABORTED = 'aborted'
MAX_TARGET_CHARS = 8192
MAX_BODY_BYTES = 128 * 1024 * 1024
MAX_HEADERS = 100
MAX_HEADER_CHARS = 16384
MAX_IN_FLIGHT = 64
MAX_REQUEST_ID_CHARS = 64
START_TIMEOUT_SECONDS = 30.0
STOP_TIMEOUT_SECONDS = 5.0
ALLOWED_METHODS = frozenset(('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'))
# 2.3 rather than 2.4, so Starlette watches receive() for a disconnect and an
# aborted stream stops at once instead of on its next write.
ASGI_INFO = {'version': '3.0', 'spec_version': '2.3'}
DEFAULT_HOST = (b'host', b'desktop')
SINK_METHODS = ('on_start', 'on_chunk', 'on_done')


class BridgeError(RuntimeError):
    """A request was rejected before it reached the app."""


def parse_target(target, prefix=API_PREFIX):
    """(path, raw_path, query_string) for a request target. Raises BridgeError."""
    if not isinstance(target, str) or not target or len(target) > MAX_TARGET_CHARS:
        raise BridgeError('Invalid request target')
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in target):
        raise BridgeError('The request target must be plain, percent-encoded ASCII')
    parts = urlsplit(target)
    if parts.scheme or parts.netloc:
        raise BridgeError('Only paths can be requested, not full URLs')
    path = unquote(parts.path)
    if not path.startswith(prefix):
        raise BridgeError(f'Only {prefix} paths are served')
    return path, parts.path.encode('ascii'), parts.query.encode('ascii')


def normalize_headers(pairs):
    """[[name, value], ...] as lower-cased latin-1 byte pairs, plus a host header."""
    if pairs is None:
        pairs = []
    if not isinstance(pairs, (list, tuple)) or len(pairs) > MAX_HEADERS:
        raise BridgeError('Request headers must be a short list of [name, value] pairs')
    out = []
    for pair in pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise BridgeError('Each request header must be a [name, value] pair')
        name, value = pair
        if not isinstance(name, str) or not isinstance(value, str) or not name.strip():
            raise BridgeError('Request header names and values must be strings')
        if len(name) + len(value) > MAX_HEADER_CHARS:
            raise BridgeError('A request header is too long')
        try:
            out.append((name.strip().lower().encode('latin-1'), value.strip().encode('latin-1')))
        except UnicodeEncodeError as e:
            raise BridgeError(f'Request header {name!r} is not latin-1 text') from e
    if not any(key == b'host' for key, _ in out):
        out.append(DEFAULT_HOST)
    return out


def build_scope(method, path, raw_path, query, headers):
    return {
        'type': 'http',
        'asgi': dict(ASGI_INFO),
        'http_version': '1.1',
        'method': method,
        'scheme': 'http',
        'path': path,
        'raw_path': raw_path,
        'query_string': query,
        'root_path': '',
        'headers': headers,
        'client': None,
        'server': None,
    }


def _decode_headers(raw):
    pairs = []
    for item in list(raw or [])[:MAX_HEADERS]:
        try:
            name, value = item
            pairs.append([bytes(name).decode('latin-1'), bytes(value).decode('latin-1')])
        except (TypeError, ValueError) as e:
            logger.debug(f'Skipping a malformed response header: {e}')
    return pairs


def _notify(callback, *args):
    """Calls a sink method. A failing sink is logged and never breaks the app."""
    try:
        callback(*args)
    except Exception as e:
        logger.error(f'Desktop bridge sink failed: {type(e).__name__}: {e}')


def _check_sink(sink):
    for name in SINK_METHODS:
        if not callable(getattr(sink, name, None)):
            raise BridgeError(f'The response sink has no {name}() method')


class AsgiBridge:
    """An ASGI app served on a private loop thread. Every public method is thread-safe."""

    def __init__(self, app_factory, prefix=API_PREFIX):
        if not callable(app_factory):
            raise TypeError('app_factory must be callable')
        self._factory = app_factory
        self._prefix = prefix
        self._app = None
        self._loop = None
        self._thread = None
        self._ready = threading.Event()
        self._start_error = None
        self._lock = threading.Lock()
        self._futures = {}

    @property
    def in_flight(self):
        with self._lock:
            return len(self._futures)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self):
        """Starts the loop thread and builds the app on it. Raises BridgeError on failure."""
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name='combine-asgi-bridge', daemon=True)
        self._thread.start()
        if not self._ready.wait(START_TIMEOUT_SECONDS):
            raise BridgeError('The in-process server did not start in time')
        if self._start_error is not None:
            raise BridgeError(f'The in-process server failed to start: {self._start_error}')

    def _run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            # Built on this thread, so asyncio objects created at import bind to this loop.
            self._app = self._factory()
        except Exception as e:
            self._start_error = f'{type(e).__name__}: {e}'
            loop.close()
            self._ready.set()
            return
        self._loop = loop
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            self._close_loop(loop)

    @staticmethod
    def _close_loop(loop):
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception as e:
            logger.debug(f'Async generator shutdown: {e}')
        loop.close()

    def stop(self):
        """Cancels every request, stops the loop and joins its thread. Safe to call twice."""
        loop, thread = self._loop, self._thread
        if loop is None or thread is None or not thread.is_alive():
            return
        try:
            asyncio.run_coroutine_threadsafe(self._drain(), loop).result(STOP_TIMEOUT_SECONDS)
        except Exception as e:
            logger.warn(f'The in-process server did not drain cleanly: {type(e).__name__}: {e}')
        try:
            loop.call_soon_threadsafe(loop.stop)
        except RuntimeError as e:
            logger.debug(f'The bridge loop had already stopped: {e}')
        thread.join(STOP_TIMEOUT_SECONDS)
        self._loop = None

    async def _drain(self):
        current = asyncio.current_task()
        tasks = [task for task in asyncio.all_tasks() if task is not current]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ------------------------------------------------------------------
    # Requests
    # ------------------------------------------------------------------

    def submit(self, request_id, method, target, headers, body, sink):
        """Queues one request for the app. Raises BridgeError when it is rejected."""
        loop = self._loop
        if loop is None:
            raise BridgeError('The in-process server is not running')
        if not isinstance(request_id, str) or not request_id or len(request_id) > MAX_REQUEST_ID_CHARS:
            raise BridgeError('Invalid request id')
        verb = str(method or '').upper()
        if verb not in ALLOWED_METHODS:
            shown = verb or '?'
            raise BridgeError(f'Method {shown} is not allowed')
        if not isinstance(body, (bytes, bytearray)):
            raise BridgeError('The request body must be bytes')
        if len(body) > MAX_BODY_BYTES:
            raise BridgeError('The request body is too large')
        _check_sink(sink)
        path, raw_path, query = parse_target(target, self._prefix)
        scope = build_scope(verb, path, raw_path, query, normalize_headers(headers))
        with self._lock:
            if request_id in self._futures:
                raise BridgeError('Duplicate request id')
            if len(self._futures) >= MAX_IN_FLIGHT:
                raise BridgeError('Too many requests in flight')
            coroutine = self._serve(scope, bytes(body), sink)
            try:
                future = asyncio.run_coroutine_threadsafe(coroutine, loop)
            except RuntimeError as e:
                coroutine.close()
                raise BridgeError('The in-process server has stopped') from e
            self._futures[request_id] = future
        future.add_done_callback(functools.partial(self._forget, request_id))

    def abort(self, request_id):
        """Cancels a request. Returns False when no such request is in flight."""
        with self._lock:
            future = self._futures.get(request_id)
        return future.cancel() if future is not None else False

    def _forget(self, request_id, future):
        with self._lock:
            if self._futures.get(request_id) is future:
                del self._futures[request_id]

    async def _serve(self, scope, body, sink):
        disconnected = asyncio.Event()
        state = {'body_sent': False, 'finished': False}

        async def receive():
            if not state['body_sent']:
                state['body_sent'] = True
                return {'type': 'http.request', 'body': body, 'more_body': False}
            await disconnected.wait()
            return {'type': 'http.disconnect'}

        async def send(message):
            kind = message.get('type')
            if kind == 'http.response.start':
                _notify(sink.on_start, int(message.get('status', 500)), _decode_headers(message.get('headers')))
            elif kind == 'http.response.body':
                chunk = message.get('body') or b''
                if chunk:
                    _notify(sink.on_chunk, bytes(chunk))
                if not message.get('more_body', False):
                    state['finished'] = True

        error = None
        method, path = scope['method'], scope['path']
        try:
            await self._app(scope, receive, send)
        except asyncio.CancelledError:
            error = ABORTED
            raise
        except Exception as e:
            error = f'{type(e).__name__}: {e}'
            log = logger.debug if state['finished'] else logger.error
            log(f'{method} {path} raised {error}')
        finally:
            disconnected.set()
            if not state['finished'] and error is None:
                error = 'The app ended without completing the response'
            _notify(sink.on_done, None if state['finished'] else error)
