"""Clipboard access for CLI mode. pyperclip errors are raised, never swallowed."""
import hashlib

try:
    import pyperclip
except ImportError:
    pyperclip = None

MAX_CLIPBOARD_CHARS = 20_000_000
MAX_REMEMBERED = 8
INSTALL_HINT = ('pyperclip is not installed (pip install -r requirements-cli.txt). '
                'On Linux it also needs xclip, xsel or wl-clipboard.')


class ClipboardError(RuntimeError):
    """The clipboard could not be read or written."""


def fingerprint(text):
    """Whitespace-insensitive hash, so a web chat reformatting a paste still matches."""
    normalized = ' '.join(str(text or '').split())
    return hashlib.sha256(normalized.encode('utf-8', 'replace')).hexdigest()


class Clipboard:
    """pyperclip wrapper that remembers the CLI's own copies, so reply can reject them."""

    def __init__(self):
        self._own = []

    def read(self):
        if pyperclip is None:
            raise ClipboardError(INSTALL_HINT)
        try:
            text = pyperclip.paste()
        except Exception as e:  # pyperclip raises platform-specific exception types
            raise ClipboardError(f'Could not read the clipboard: {e}') from e
        if not isinstance(text, str):
            raise ClipboardError('The clipboard does not hold text.')
        if len(text) > MAX_CLIPBOARD_CHARS:
            raise ClipboardError(f'The clipboard holds {len(text):,} characters, over the {MAX_CLIPBOARD_CHARS:,} limit.')
        return text

    def copy(self, text):
        if pyperclip is None:
            raise ClipboardError(INSTALL_HINT)
        if not isinstance(text, str):
            raise ClipboardError('Only text can be copied.')
        try:
            pyperclip.copy(text)
        except Exception as e:  # pyperclip raises platform-specific exception types
            raise ClipboardError(f'Could not write the clipboard: {e}') from e
        self._own.append(fingerprint(text))
        del self._own[:-MAX_REMEMBERED]

    def is_own(self, text):
        return fingerprint(text) in self._own
