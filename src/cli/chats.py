"""Chat listing and creation for CLI mode, on the same storage as the web UI."""
import time
from dataclasses import dataclass

from src.config import CHATS_CONV_DIR, logger
from src.history import get_conversation, get_history_index, sanitize_conv_id

MAX_LISTED = 200
MAX_SCANNED_IDS = 20_000
DEFAULT_TITLE = 'New chat'
MAX_TITLE_CHARS = 80
SECONDS_PER_DAY = 86_400


def format_age(stamp, now=None):
    """'just now', '5m ago', '2h ago', '3d ago', or a date for anything older than 30 days."""
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or stamp <= 0:
        return ''
    current = time.time() if now is None else now
    seconds = max(0.0, current - stamp)
    if seconds < 60:
        return 'just now'
    if seconds < 3600:
        return f'{int(seconds // 60)}m ago'
    if seconds < SECONDS_PER_DAY:
        return f'{int(seconds // 3600)}h ago'
    if seconds < 30 * SECONDS_PER_DAY:
        return f'{int(seconds // SECONDS_PER_DAY)}d ago'
    return time.strftime('%Y-%m-%d', time.localtime(stamp))


@dataclass(frozen=True)
class ChatInfo:
    """A saved chat as shown in the picker."""

    id: str
    title: str
    updated: float
    count: int
    label: str

    @property
    def hint(self):
        parts = []
        age = format_age(self.updated)
        if age:
            parts.append(f'updated {age}')
        parts.append(f'{self.count} msgs')
        if self.label:
            parts.append(self.label)
        return ' · '.join(parts)


def conv_title(conv):
    for key in ('title', 'name'):
        value = conv.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return 'Untitled chat'


def _mtime(conv_id):
    try:
        return (CHATS_CONV_DIR / f'{conv_id}.json').stat().st_mtime
    except OSError:
        return 0.0


def _candidate_ids():
    """Ids from the index order plus any orphan files, without duplicates."""
    seen = set()
    ids = []
    index = get_history_index()
    order = index.get('order') if isinstance(index, dict) and isinstance(index.get('order'), list) else []
    for raw in order[:MAX_SCANNED_IDS]:
        conv_id = sanitize_conv_id(str(raw))
        if conv_id and conv_id not in seen:
            seen.add(conv_id)
            ids.append(conv_id)
    try:
        for path in CHATS_CONV_DIR.glob('*.json'):
            if len(ids) >= MAX_SCANNED_IDS:
                break
            conv_id = sanitize_conv_id(path.stem)
            if conv_id and conv_id not in seen:
                seen.add(conv_id)
                ids.append(conv_id)
    except OSError as e:
        logger.warn(f'Could not scan {CHATS_CONV_DIR}: {e}')
    return ids


def list_chats(limit=MAX_LISTED):
    """Saved chats, most recently modified first."""
    stamped = sorted(((_mtime(conv_id), conv_id) for conv_id in _candidate_ids()), reverse=True)
    chats = []
    for stamp, conv_id in stamped[:limit]:
        conv = get_conversation(conv_id)
        if not isinstance(conv, dict):
            continue
        messages = conv.get('messages') if isinstance(conv.get('messages'), list) else []
        cli = conv.get('cli') if isinstance(conv.get('cli'), dict) else {}
        chats.append(ChatInfo(conv_id, conv_title(conv), stamp, len(messages), str(cli.get('label') or '')))
    return chats


def clean_title(title):
    return ' '.join(str(title or '').split())[:MAX_TITLE_CHARS]


def new_conversation(title, now_ms):
    """A new, unsaved conversation in the web UI's shape."""
    return {
        'id': f'conv_{int(now_ms)}',
        'title': clean_title(title) or DEFAULT_TITLE,
        'folderId': None,
        'messages': [],
        'createdAt': int(now_ms),
        'updatedAt': int(now_ms),
    }
