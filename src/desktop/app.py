"""Desktop mode: the web UI in a native Qt window, with no listening socket.

Pages are served from an in-process app:// URL scheme. API calls from the page
travel over QWebChannel to an in-process ASGI bridge that calls the FastAPI app
directly, so the only network traffic is outbound requests to the endpoints in
Settings. Chromium's DevTools server, the one part of Qt WebEngine that can
listen on a port, is switched off before Qt starts.
"""
import base64
import binascii
import json
import os
import signal
import sys

from PySide6.QtCore import QBuffer, QByteArray, QFile, QIODevice, QObject, Qt, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QDesktopServices, QIcon
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import (
    QWebEnginePage,
    QWebEngineProfile,
    QWebEngineSettings,
    QWebEngineUrlRequestJob,
    QWebEngineUrlScheme,
    QWebEngineUrlSchemeHandler,
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QMainWindow

from src.config import APP_DIR, PAGES_DIR, STATIC_DIR, logger
from src.desktop.asgi_bridge import MAX_BODY_BYTES, AsgiBridge, BridgeError
from src.desktop.assets import guess_mime, read_asset, resolve_page_file

APP_NAME = 'CombineWebUI'
SCHEME = 'app'
HOST = 'ui'
START_URL = 'app://ui/index.html'
CHANNEL_SCRIPT_PATH = '/__desktop__/qwebchannel.js'
CHANNEL_SCRIPT_RESOURCE = ':/qtwebchannel/qwebchannel.js'
PROFILE_NAME = 'combine-webui'
PROFILE_DIR = APP_DIR / 'desktop-profile'
WINDOW_SIZE = (1440, 920)
CHUNK_BYTES = 1024 * 1024
MAX_BODY_B64_CHARS = (MAX_BODY_BYTES // 3 + 1) * 4
MAX_HEADERS_JSON_CHARS = 256 * 1024
EXTERNAL_SCHEMES = ('http', 'https', 'mailto')
REMOTE_DEBUG_ENV = 'QTWEBENGINE_REMOTE_DEBUGGING'
CHROMIUM_FLAGS_ENV = 'QTWEBENGINE_CHROMIUM_FLAGS'
REMOTE_DEBUG_MARKER = 'remote-debugging'
PAGE_ATTRIBUTES = ('JavascriptCanAccessClipboard', 'JavascriptCanPaste', 'LocalStorageEnabled')
# Ctrl+C in the terminal closes the window. Qt's loop runs in C++, so a timer
# hands Python control this often to run the signal handler.
SIGNAL_POLL_MS = 200
INTERRUPT_EXIT_CODE = 130
INTERRUPT_SIGNALS = ('SIGINT', 'SIGTERM', 'SIGBREAK')


# ---------------------------------------------------------------------------
# Start-up
# ---------------------------------------------------------------------------

def _harden_environment():
    """Removes every way to switch on DevTools, which would listen on a port.

    Returns the argv Qt gets: only the program name, so no command-line flag
    such as --remote-debugging-port can reach Chromium either.
    """
    if os.environ.pop(REMOTE_DEBUG_ENV, None) is not None:
        logger.warn(f'Ignoring {REMOTE_DEBUG_ENV}: desktop mode never opens a debugging port')
    flags = os.environ.get(CHROMIUM_FLAGS_ENV, '')
    if REMOTE_DEBUG_MARKER in flags:
        kept = [flag for flag in flags.split() if REMOTE_DEBUG_MARKER not in flag]
        os.environ[CHROMIUM_FLAGS_ENV] = ' '.join(kept)
        logger.warn(f'Removed remote debugging flags from {CHROMIUM_FLAGS_ENV}')
    return [sys.argv[0] if sys.argv else APP_NAME]


def _register_scheme():
    """Must run before QApplication exists. Secure and CORS-enabled, so ES modules load."""
    scheme = QWebEngineUrlScheme(QByteArray(SCHEME.encode('ascii')))
    scheme.setSyntax(QWebEngineUrlScheme.Syntax.Host)
    scheme.setFlags(QWebEngineUrlScheme.Flag.SecureScheme | QWebEngineUrlScheme.Flag.CorsEnabled)
    QWebEngineUrlScheme.registerScheme(scheme)


# ---------------------------------------------------------------------------
# app:// scheme
# ---------------------------------------------------------------------------

def _load_channel_script():
    resource = QFile(CHANNEL_SCRIPT_RESOURCE)
    if not resource.open(QIODevice.OpenModeFlag.ReadOnly):
        logger.error('qwebchannel.js is missing from the Qt resources; the page cannot reach Python')
        return None
    try:
        return resource.readAll().data()
    finally:
        resource.close()


def _reply(job, mime, data):
    # Parented to the job, so Qt frees the buffer together with the request.
    buffer = QBuffer(job)
    buffer.setData(QByteArray(data))
    buffer.open(QIODevice.OpenModeFlag.ReadOnly)
    job.reply(QByteArray(mime.encode('ascii')), buffer)


class AppSchemeHandler(QWebEngineUrlSchemeHandler):
    """Serves GET requests for app://ui/ from pages/. Everything else fails."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._channel_script = _load_channel_script()

    def requestStarted(self, job):
        try:
            self._serve(job)
        except Exception as e:  # an unanswered job would leave the page waiting forever
            logger.error(f'Desktop asset request failed: {type(e).__name__}: {e}')
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)

    def _serve(self, job):
        url = job.requestUrl()
        method = job.requestMethod().data().decode('ascii', 'replace').upper()
        if url.host() != HOST or method != 'GET':
            job.fail(QWebEngineUrlRequestJob.Error.RequestDenied)
            return
        path = url.path()
        if path == CHANNEL_SCRIPT_PATH:
            data, mime = self._channel_script, 'text/javascript'
        else:
            target = resolve_page_file(path, PAGES_DIR)
            data = read_asset(target) if target is not None else None
            mime = guess_mime(target) if target is not None else ''
        if data is None:
            logger.debug(f'Desktop asset not found: {path}')
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        _reply(job, mime, data)


# ---------------------------------------------------------------------------
# Page <-> Python bridge
# ---------------------------------------------------------------------------

def _parse_headers_json(text):
    if not text:
        return []
    if len(text) > MAX_HEADERS_JSON_CHARS:
        raise BridgeError('The request headers are too large')
    try:
        return json.loads(text)
    except ValueError as e:
        raise BridgeError('The request headers are not valid JSON') from e


def _decode_body(text):
    if not text:
        return b''
    if len(text) > MAX_BODY_B64_CHARS:
        raise BridgeError('The request body is too large')
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as e:
        raise BridgeError('The request body is not valid base64') from e


def _as_status(text):
    try:
        return int(text)
    except (TypeError, ValueError):
        return 500


class _Relay(QObject):
    """Moves bridge events from the asyncio thread onto the Qt thread."""

    message = Signal(str, str, str, str)

    def __init__(self, bridge):
        super().__init__(bridge)
        self._bridge = bridge
        self.message.connect(self.forward, Qt.ConnectionType.QueuedConnection)

    @Slot(str, str, str, str)
    def forward(self, kind, request_id, first, second):
        self._bridge.deliver(kind, request_id, first, second)


class _QtSink:
    """ASGI response sink that relays every event through the queued signal."""

    def __init__(self, relay, request_id):
        self._relay = relay
        self._id = request_id

    def on_start(self, status, headers):
        self._relay.message.emit('start', self._id, str(status), json.dumps(headers))

    def on_chunk(self, data):
        for offset in range(0, len(data), CHUNK_BYTES):
            piece = base64.b64encode(data[offset:offset + CHUNK_BYTES]).decode('ascii')
            self._relay.message.emit('chunk', self._id, piece, '')

    def on_done(self, error):
        self._relay.message.emit('done', self._id, error or '', '')


class WebBridge(QObject):
    """The object the page sees as channel.objects.bridge."""

    responseStarted = Signal(str, int, str)
    responseChunk = Signal(str, str)
    responseFinished = Signal(str, str)

    def __init__(self, asgi, parent=None):
        super().__init__(parent)
        self._asgi = asgi
        self._relay = _Relay(self)

    @Slot(str, str, str, str, str)
    def request(self, request_id, method, target, headers_json, body_b64):
        try:
            headers = _parse_headers_json(headers_json)
            body = _decode_body(body_b64)
            self._asgi.submit(request_id, method, target, headers, body, _QtSink(self._relay, request_id))
        except BridgeError as e:
            logger.warn(f'Desktop bridge rejected {method} {target}: {e}')
            self.responseFinished.emit(request_id, str(e))
        except Exception as e:
            logger.error(f'Desktop bridge failed on {method} {target}: {type(e).__name__}: {e}')
            self.responseFinished.emit(request_id, f'{type(e).__name__}: {e}')

    @Slot(str)
    def abort(self, request_id):
        self._asgi.abort(request_id)

    def deliver(self, kind, request_id, first, second):
        """Re-emits a relayed event as the signal the page listens to. Qt thread only."""
        if kind == 'start':
            self.responseStarted.emit(request_id, _as_status(first), second)
        elif kind == 'chunk':
            self.responseChunk.emit(request_id, first)
        elif kind == 'done':
            self.responseFinished.emit(request_id, first)
        else:
            logger.warn(f'Unknown desktop bridge event {kind!r}')


# ---------------------------------------------------------------------------
# Window
# ---------------------------------------------------------------------------

def _open_externally(url):
    if url.scheme() in EXTERNAL_SCHEMES:
        if not QDesktopServices.openUrl(url):
            logger.warn(f'Could not open {url.toString()} in the system browser')
        return
    logger.debug(f'Blocked navigation to {url.toString()}')


class _ExternalLinkPage(QWebEnginePage):
    """Target for target=_blank links and window.open: hands them to the system browser."""

    def acceptNavigationRequest(self, url, navigation_type, is_main_frame):
        if url.scheme() == 'about':
            return True
        _open_externally(url)
        self.deleteLater()
        return False


class AppPage(QWebEnginePage):
    """Stays on app://ui/. Any other link opens in the system browser."""

    def acceptNavigationRequest(self, url, navigation_type, is_main_frame):
        if url.scheme() == SCHEME and url.host() == HOST:
            return True
        if url.scheme() == 'about':
            return True
        if is_main_frame:
            _open_externally(url)
        return False

    def createWindow(self, window_type):
        return _ExternalLinkPage(self.profile(), self)

    def javaScriptConsoleMessage(self, level, message, line, source):
        text = f'[page] {source}:{line} {message}'
        if level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            logger.warn(text)
        else:
            logger.debug(text)


class MainWindow(QMainWindow):
    def __init__(self, profile, bridge):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(*WINDOW_SIZE)
        icon = QIcon(str(STATIC_DIR / 'icons' / 'logo.svg'))
        if not icon.isNull():
            self.setWindowIcon(icon)
        self._view = QWebEngineView(self)
        self._page = AppPage(profile, self._view)
        self._channel = QWebChannel(self._page)
        self._channel.registerObject('bridge', bridge)
        self._page.setWebChannel(self._channel)
        self._page.titleChanged.connect(self._sync_title)
        self._view.setPage(self._page)
        self.setCentralWidget(self._view)
        self._view.load(QUrl(START_URL))

    def _sync_title(self, title):
        clean = title.strip() if isinstance(title, str) else ''
        self.setWindowTitle(clean or APP_NAME)


def _build_profile(parent):
    """A persistent profile, so localStorage and IndexedDB survive restarts."""
    profile = QWebEngineProfile(PROFILE_NAME, parent)
    try:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.warn(f'Could not create {PROFILE_DIR}: {e}')
    profile.setPersistentStoragePath(str(PROFILE_DIR / 'storage'))
    profile.setCachePath(str(PROFILE_DIR / 'cache'))
    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.MemoryHttpCache)
    settings = profile.settings()
    for name in PAGE_ATTRIBUTES:
        attribute = getattr(QWebEngineSettings.WebAttribute, name, None)
        if attribute is not None:
            settings.setAttribute(attribute, True)
    handler = AppSchemeHandler(profile)
    profile.installUrlSchemeHandler(QByteArray(SCHEME.encode('ascii')), handler)
    return profile


class _InterruptGuard:
    """Turns SIGINT (and SIGTERM / SIGBREAK where they exist) into app.quit().

    Python runs signal handlers only between bytecodes, and Qt's event loop
    runs in C++, so a no-op timer gives Python control a few times a second.
    A second interrupt exits at once, in case shutdown itself hangs.
    """

    def __init__(self, app):
        self._app = app
        self.interrupted = False
        self._previous = {}
        self._timer = QTimer(app)
        self._timer.timeout.connect(self._wake)
        self._timer.start(SIGNAL_POLL_MS)
        for name in INTERRUPT_SIGNALS:
            self._install(name)

    def _install(self, name):
        signum = getattr(signal, name, None)
        if signum is None:
            return
        try:
            self._previous[signum] = signal.signal(signum, self._handle)
        except (ValueError, OSError, RuntimeError) as e:
            logger.debug(f'Could not handle {name}: {e}')

    def _wake(self):
        """Empty on purpose: returning to Python is what lets a pending handler run."""

    def _handle(self, signum, frame):
        if self.interrupted:
            logger.warn('Second interrupt: exiting immediately.')
            os._exit(INTERRUPT_EXIT_CODE)
        self.interrupted = True
        logger.info('Interrupt received; closing the desktop window...')
        self._app.quit()

    def restore(self):
        """Stops the timer and puts the previous handlers back."""
        self._timer.stop()
        for signum, previous in self._previous.items():
            try:
                signal.signal(signum, previous if previous is not None else signal.SIG_DFL)
            except (ValueError, OSError, RuntimeError, TypeError) as e:
                logger.debug(f'Could not restore the handler for signal {signum}: {e}')
        self._previous.clear()


def _load_server_app():
    # Runs on the bridge thread, so asyncio objects created at import bind to its loop.
    from src.server import app
    return app


def _dispose(window):
    """Deletes the window, and with it the page, while the profile still exists."""
    if window is None:
        return
    try:
        from shiboken6 import Shiboken
        if Shiboken.isValid(window):
            Shiboken.delete(window)
    except Exception as e:
        logger.debug(f'Window cleanup: {e}')


def run_desktop():
    """Opens the window and blocks until it closes. Returns the process exit code."""
    qt_argv = _harden_environment()
    _register_scheme()
    QApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication(qt_argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationDisplayName(APP_NAME)
    asgi = AsgiBridge(_load_server_app)
    try:
        asgi.start()
    except BridgeError as e:
        logger.error(str(e))
        return 1
    window = None
    guard = None
    try:
        profile = _build_profile(app)
        window = MainWindow(profile, WebBridge(asgi, app))
        window.show()
        # Installed only now: app.quit() before exec() would be ignored.
        guard = _InterruptGuard(app)
        logger.success('Desktop window open. Nothing is listening on a port; API calls stay in-process. '
                       'Ctrl+C here closes the window.')
        if guard.interrupted:
            return INTERRUPT_EXIT_CODE
        code = app.exec()
        return INTERRUPT_EXIT_CODE if guard.interrupted else code
    finally:
        _dispose(window)
        asgi.stop()
        # Restored last, so a second Ctrl+C during cleanup still exits at once.
        if guard is not None:
            guard.restore()
