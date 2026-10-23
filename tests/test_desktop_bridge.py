import asyncio
import importlib
import importlib.util
import json
import socket
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from src.config import PAGES_DIR
from src.desktop.asgi_bridge import ABORTED, AsgiBridge, BridgeError, normalize_headers, parse_target
from src.desktop.assets import guess_mime, resolve_page_file

ROOT = Path(__file__).resolve().parent.parent
WAIT_SECONDS = 5.0
POLL_SECONDS = 0.02
HAS_FASTAPI = importlib.util.find_spec('fastapi') is not None


class RecordingSink:
    def __init__(self):
        self.status = None
        self.headers = []
        self.chunks = []
        self.error = 'unset'
        self.first_chunk = threading.Event()
        self.done = threading.Event()

    def on_start(self, status, headers):
        self.status = status
        self.headers = headers

    def on_chunk(self, data):
        self.chunks.append(data)
        self.first_chunk.set()

    def on_done(self, error):
        self.error = error
        self.done.set()

    @property
    def body(self):
        return b''.join(self.chunks)


def _start(status=200, kind=b'text/plain'):
    return {'type': 'http.response.start', 'status': status, 'headers': [(b'content-type', kind)]}


def _body(data, more=False):
    return {'type': 'http.response.body', 'body': data, 'more_body': more}


async def demo_app(scope, receive, send):
    request = await receive()
    path = scope['path']
    if path == '/v1/echo':
        payload = {'method': scope['method'], 'query': scope['query_string'].decode(),
                   'body': request.get('body', b'').decode(),
                   'host': dict(scope['headers']).get(b'host', b'').decode()}
        await send(_start(kind=b'application/json'))
        await send(_body(json.dumps(payload).encode()))
    elif path == '/v1/stream':
        await send(_start(kind=b'text/event-stream'))
        for index in range(3):
            await send(_body(f'data: {index}\n\n'.encode(), more=True))
        await send(_body(b''))
    elif path == '/v1/hang':
        await send(_start())
        await send(_body(b'first', more=True))
        await asyncio.sleep(3600)
    elif path == '/v1/boom':
        raise RuntimeError('boom')
    else:
        await send(_start(404))
        await send(_body(b'missing'))


def _refuse(*args, **kwargs):
    raise AssertionError('Something tried to open a listening socket')


def _guard_sockets(test):
    """Fails the test if anything binds or listens while it runs."""
    for name in ('bind', 'listen'):
        patcher = mock.patch.object(socket.socket, name, _refuse)
        patcher.start()
        test.addCleanup(patcher.stop)


def _wait_until(predicate):
    for _ in range(int(WAIT_SECONDS / POLL_SECONDS)):
        if predicate():
            return True
        time.sleep(POLL_SECONDS)
    return predicate()


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AsgiBridge(lambda: demo_app)
        self.bridge.start()
        self.addCleanup(self.bridge.stop)
        # Guarded only after start: on Windows, asyncio's self-pipe is a bound loopback pair.
        _guard_sockets(self)

    def run_request(self, target, method='GET', body=b'', headers=None, request_id='r1'):
        sink = RecordingSink()
        self.bridge.submit(request_id, method, target, headers or [], body, sink)
        self.assertTrue(sink.done.wait(WAIT_SECONDS), f'{target} never finished')
        return sink

    def test_request_round_trip(self):
        sink = self.run_request('/v1/echo?x=1', 'post', b'{"a": 1}', [['Content-Type', 'application/json']])
        self.assertEqual(sink.status, 200)
        self.assertIsNone(sink.error)
        self.assertIn(['content-type', 'application/json'], sink.headers)
        self.assertEqual(json.loads(sink.body),
                         {'method': 'POST', 'query': 'x=1', 'body': '{"a": 1}', 'host': 'desktop'})

    def test_stream_arrives_in_order(self):
        sink = self.run_request('/v1/stream')
        self.assertEqual(sink.chunks, [b'data: 0\n\n', b'data: 1\n\n', b'data: 2\n\n'])
        self.assertIsNone(sink.error)

    def test_abort_stops_a_running_request(self):
        sink = RecordingSink()
        self.bridge.submit('r-hang', 'GET', '/v1/hang', [], b'', sink)
        self.assertTrue(sink.first_chunk.wait(WAIT_SECONDS))
        self.assertTrue(self.bridge.abort('r-hang'))
        self.assertTrue(sink.done.wait(WAIT_SECONDS))
        self.assertEqual(sink.error, ABORTED)
        self.assertTrue(_wait_until(lambda: self.bridge.in_flight == 0))

    def test_app_error_is_reported(self):
        sink = self.run_request('/v1/boom')
        self.assertIsNone(sink.status)
        self.assertIn('boom', sink.error)

    def test_rejections(self):
        sink = RecordingSink()
        cases = (('/static/js/main.js', 'GET'), ('http://example.com/v1/models', 'GET'),
                 ('/v1/models', 'TRACE'), ('/v1/a b', 'GET'))
        for target, method in cases:
            with self.subTest(target=target, method=method):
                with self.assertRaises(BridgeError):
                    self.bridge.submit('bad', method, target, [], b'', sink)
        self.assertFalse(sink.done.is_set())

    def test_duplicate_ids_are_rejected(self):
        sink = RecordingSink()
        self.bridge.submit('dup', 'GET', '/v1/hang', [], b'', sink)
        self.assertTrue(sink.first_chunk.wait(WAIT_SECONDS))
        with self.assertRaises(BridgeError):
            self.bridge.submit('dup', 'GET', '/v1/echo', [], b'', RecordingSink())
        self.bridge.abort('dup')
        self.assertTrue(sink.done.wait(WAIT_SECONDS))


class HelperTests(unittest.TestCase):
    def test_parse_target_decodes_the_path(self):
        self.assertEqual(parse_target('/v1/history/conversations/conv%5F1?x=2'),
                         ('/v1/history/conversations/conv_1', b'/v1/history/conversations/conv%5F1', b'x=2'))

    def test_headers_get_a_host(self):
        self.assertEqual(normalize_headers([['Accept', 'text/event-stream']]),
                         [(b'accept', b'text/event-stream'), (b'host', b'desktop')])

    def test_bad_headers_are_rejected(self):
        for pairs in ('nope', [['only-name']], [['x', 1]], [['x', 'euro \u20ac']]):
            with self.subTest(pairs=pairs):
                with self.assertRaises(BridgeError):
                    normalize_headers(pairs)


class AssetTests(unittest.TestCase):
    def test_pages_resolve(self):
        self.assertEqual(resolve_page_file('/', PAGES_DIR), (PAGES_DIR / 'index.html').resolve())
        self.assertEqual(resolve_page_file('/static/js/main.js', PAGES_DIR),
                         (PAGES_DIR / 'static' / 'js' / 'main.js').resolve())

    def test_outside_paths_are_refused(self):
        for path in ('/../main.py', '/static/../../main.py', '/v1/models', '/static/js/missing.js', '/static/%2e%2e/x'):
            with self.subTest(path=path):
                self.assertIsNone(resolve_page_file(path, PAGES_DIR))

    def test_module_scripts_get_a_javascript_type(self):
        self.assertEqual(guess_mime('a/b/main.js'), 'text/javascript')
        self.assertEqual(guess_mime('index.html'), 'text/html')


def _server_app():
    return importlib.import_module('src.server').app


@unittest.skipUnless(HAS_FASTAPI, 'FastAPI is not installed')
class ServerOverBridgeTests(unittest.TestCase):
    def test_real_app_answers_without_a_socket(self):
        bridge = AsgiBridge(_server_app)
        bridge.start()
        self.addCleanup(bridge.stop)
        _guard_sockets(self)
        sink = RecordingSink()
        body = json.dumps({'logo': 'https://example.com/a.png'}).encode()
        bridge.submit('r1', 'POST', '/v1/settings/preview_logo', [['Content-Type', 'application/json']], body, sink)
        self.assertTrue(sink.done.wait(WAIT_SECONDS))
        self.assertEqual(sink.status, 200)
        self.assertEqual(json.loads(sink.body)['resolved'], 'https://example.com/a.png')


class BoundaryTests(unittest.TestCase):
    def test_desktop_mode_never_loads_uvicorn(self):
        code = ('import importlib.util, sys\n'
                'import src.desktop.asgi_bridge, src.desktop.assets\n'
                "if importlib.util.find_spec('fastapi'):\n"
                '    import src.server\n'
                "if importlib.util.find_spec('PySide6'):\n"
                '    try:\n'
                '        import src.desktop.app\n'
                '    except ImportError as e:\n'
                "        print('Qt import skipped:', e)\n"
                "sys.exit(1 if 'uvicorn' in sys.modules else 0)\n")
        result = subprocess.run([sys.executable, '-c', code], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
