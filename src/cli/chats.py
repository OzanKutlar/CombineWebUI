"""Chat listing and creation for CLI mode, on the same storage as the web UI.

Listing a chat needs only its title, message count and label, but reading a
conversation file means opening it, and on Windows each open can cost tens of
milliseconds (real-time antivirus scanning). The summaries are therefore
cached in cli_chat_index.json, keyed on each file's mtime and size, so only
chats that changed since the last listing are opened again.
"""
import json
import time
from dataclasses import dataclass

from src.config import APP_DIR, CHATS_CONV_DIR, logger
from src.history import atomic_write_json, get_conversation, get_history_index, sanitize_conv_id

MAX_LISTED = 200
MAX_SCANNED_IDS = 20_000
DEFAULT_TITLE = 'New chat'
MAX_TITLE_CHARS = 80
SECONDS_PER_DAY = 86_400
SUMMARY_CACHE_PATH = APP_DIR / 'cli_chat_index.json'
SUMMARY_CACHE_VERSION = 1


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


def _stat(conv_id):
    """The conversation file's stat result, or None when it cannot be read."""
    try:
        return (CHATS_CONV_DIR / f'{conv_id}.json').stat()
    except OSError:
        return None


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


# ----------------------------------------------------------------------
# Summary cache
# ----------------------------------------------------------------------

def _valid_entry(entry):
    return (isinstance(entry, dict)
            and isinstance(entry.get('mtime_ns'), int)
            and isinstance(entry.get('size'), int)
            and isinstance(entry.get('title'), str)
            and isinstance(entry.get('count'), int)
            and isinstance(entry.get('label'), str))


def _load_cache(path):
    """Cached summaries by chat id. A missing or unreadable cache is simply empty."""
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        logger.debug(f'Ignoring the chat summary cache {path}: {e}')
        return {}
    if not isinstance(raw, dict) or raw.get('version') != SUMMARY_CACHE_VERSION:
        return {}
    entries = raw.get('entries')
    if not isinstance(entries, dict):
        return {}
    clean = {}
    for conv_id, entry in entries.items():
        if len(clean) >= MAX_SCANNED_IDS:
            break
        if isinstance(conv_id, str) and _valid_entry(entry):
            clean[conv_id] = entry
    return clean


def _save_cache(path, entries):
    payload = {'version': SUMMARY_CACHE_VERSION, 'entries': entries}
    if not atomic_write_json(path, payload):
        logger.debug(f'Could not write the chat summary cache {path}; the next listing reopens every chat.')


def _cached_summary(cache, conv_id, st):
    """The cached entry when the file is unchanged since it was summarized, else None."""
    entry = cache.get(conv_id)
    if entry is None or entry['mtime_ns'] != st.st_mtime_ns or entry['size'] != st.st_size:
        return None
    return entry


def _read_summary(conv_id, st):
    """Opens one conversation and reduces it to what the picker shows, or None."""
    conv = get_conversation(conv_id)
    if not isinstance(conv, dict):
        return None
    messages = conv.get('messages') if isinstance(conv.get('messages'), list) else []
    cli = conv.get('cli') if isinstance(conv.get('cli'), dict) else {}
    return {'mtime_ns': st.st_mtime_ns, 'size': st.st_size, 'title': conv_title(conv),
            'count': len(messages), 'label': str(cli.get('label') or '')}


def _stamped_ids():
    """(mtime, id, stat) for every chat file that exists, newest first."""
    stamped = []
    for conv_id in _candidate_ids():
        st = _stat(conv_id)
        if st is not None:
            stamped.append((st.st_mtime, conv_id, st))
    stamped.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return stamped


def list_chats(limit=MAX_LISTED):
    """Saved chats, most recently modified first.

    Only chats whose file changed since the last listing are opened.
    """
    stamped = _stamped_ids()
    cache = _load_cache(SUMMARY_CACHE_PATH)
    entries = {}
    changed = False
    chats = []
    for stamp, conv_id, st in stamped[:limit]:
        entry = _cached_summary(cache, conv_id, st)
        if entry is None:
            entry = _read_summary(conv_id, st)
            if entry is None:
                continue
            changed = True
        entries[conv_id] = entry
        chats.append(ChatInfo(conv_id, entry['title'], stamp, entry['count'], entry['label']))
    # Chats beyond the listing limit keep their entries; deleted chats lose theirs.
    existing = {conv_id for _, conv_id, _ in stamped}
    for conv_id, entry in cache.items():
        if conv_id in existing and conv_id not in entries:
            entries[conv_id] = entry
    if changed or len(entries) != len(cache):
        _save_cache(SUMMARY_CACHE_PATH, entries)
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
