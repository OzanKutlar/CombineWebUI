"""Asset lookup for the desktop window's app:// scheme.

No Qt here, so it can be tested anywhere. Only pages/index.html and the
pages/static/ tree are served; every other path, including anything that
resolves outside pages/, is refused.
"""
import mimetypes
from pathlib import Path

INDEX_FILE = 'index.html'
STATIC_PREFIX = 'static/'
MAX_URL_PATH_CHARS = 4096
MAX_ASSET_BYTES = 32 * 1024 * 1024
DEFAULT_MIME = 'application/octet-stream'
# Module scripts are refused unless served with a JavaScript type.
MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain',
}


def guess_mime(path):
    suffix = Path(str(path)).suffix.lower()
    known = MIME_TYPES.get(suffix)
    if known:
        return known
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or DEFAULT_MIME


def resolve_page_file(url_path, pages_dir):
    """The file a URL path maps to inside pages_dir, or None when it is not served."""
    if not isinstance(url_path, str) or len(url_path) > MAX_URL_PATH_CHARS or '\x00' in url_path:
        return None
    relative = url_path.lstrip('/') or INDEX_FILE
    if relative != INDEX_FILE and not relative.startswith(STATIC_PREFIX):
        return None
    try:
        root = Path(pages_dir).resolve()
        target = (root / relative).resolve()
        target.relative_to(root)
        return target if target.is_file() else None
    except (OSError, ValueError, RuntimeError):
        return None


def read_asset(path):
    """The file's bytes, or None when it is missing, unreadable or too large."""
    try:
        if path.stat().st_size > MAX_ASSET_BYTES:
            return None
        return path.read_bytes()
    except (OSError, AttributeError):
        return None
