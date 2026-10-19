"""Python port of pruneManual.js plus the payload half of prune.js and execution.js.

Every write to a user message's content that relates to pruning goes through
rebuild_message_content(), as in the web UI, and the fields written
(originalContent, manualPrunedPaths, modelPrunedPaths, modelPruneActive,
prunedContent, pruneInfo) have the shape the browser reads.
"""
import json
import os
import re
from functools import lru_cache

from src.config import logger
from src.prompt_parser import PRUNED_PREFIX, scan_file_blocks_for_text

DEFAULT_MANUAL_REASON = 'Manually pruned by user'
MAX_REASON_CHARS = 120
MAX_INDEX_ROWS = 2000
MAX_JSON_CANDIDATES = 20
MAX_XML_CANDIDATES = 20
MAX_XML_FILES = 2000
CHARS_PER_TOKEN = 4.0
TOKENIZER_ENV = 'COMBINE_CLI_TOKENIZER'

_HEADER_RE = re.compile(r'-{35}\r?\nFILE: .*?\r?\n-{35}\r?\n')
_OPEN_FENCE_RE = re.compile(r'[ \t]*```[\w.+-]*\r?\n', re.ASCII)
_REASON_STRIP_RE = re.compile(r'[`\x00-\x1f]+')
_SPACES_RE = re.compile(r'\s+')
_XML_OPEN_RE = re.compile(r'<[a-zA-Z0-9_]+_payload>')
_PRUNE_FENCE_RE = re.compile(
    r'```(?:xml)?\s*(<([a-zA-Z0-9_]+_payload)>(?:(?!</\2>)[\s\S])*?<phase>PRUNE</phase>[\s\S]*?</\2>)\s*```', re.I)
_PRUNE_TAG_RE = re.compile(
    r'<([a-zA-Z0-9_]+_payload)>(?:(?!</\1>)[\s\S])*?<phase>PRUNE</phase>[\s\S]*?</\1>', re.I)
_PRUNE_FILE_RE = re.compile(
    r'<file>[\s\S]*?<path>(.*?)</path>[\s\S]*?<stay>(.*?)</stay>[\s\S]*?<reason>([\s\S]*?)</reason>[\s\S]*?</file>', re.I)
_TRAILING_COMMA_RE = re.compile(r',\s*([}\]])')
_FENCE_BEFORE_RE = re.compile(r'```(?:json)?\s*\Z', re.I)
_FENCE_AFTER_RE = re.compile(r'\s*```')


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _encoder():
    """tiktoken encoder, or None when it is missing, disabled or cannot load offline."""
    if os.environ.get(TOKENIZER_ENV, '').strip().lower() == 'heuristic':
        return None
    try:
        from src.utils import get_tokenizer
        return get_tokenizer('')
    except Exception as e:  # ImportError, or a failed download of the encoding
        logger.warn(f'tiktoken is unavailable ({e}); token counts use a characters / 4 estimate')
        return None


@lru_cache(maxsize=8192)
def _count_cached(text):
    encoder = _encoder()
    if encoder is not None:
        try:
            return len(encoder.encode(text))
        except Exception as e:
            logger.debug(f'Tokenizer failed, using the estimate instead: {e}')
    return max(1, int(round(len(text) / CHARS_PER_TOKEN)))


def count_tokens(text):
    if not isinstance(text, str) or not text:
        return 0
    return _count_cached(text)


def tokenizer_name():
    encoder = _encoder()
    return getattr(encoder, 'name', 'tiktoken') if encoder is not None else 'characters / 4 estimate'


# ---------------------------------------------------------------------------
# Paths and baselines
# ---------------------------------------------------------------------------

def normalize_path(path):
    if not isinstance(path, str):
        return ''
    return path.strip().replace('\\', '/')


def sanitize_reason(reason):
    """Reasons are embedded in the payload, so anything that could end a fence or split a line goes."""
    raw = reason if isinstance(reason, str) else ''
    clean = _SPACES_RE.sub(' ', _REASON_STRIP_RE.sub(' ', raw)).strip()
    return clean[:MAX_REASON_CHARS] if clean else DEFAULT_MANUAL_REASON


def _is_user(msg):
    return isinstance(msg, dict) and msg.get('role') == 'user' and isinstance(msg.get('content'), str)


def get_baseline(msg):
    """Pristine text of a user message, captured once and never overwritten."""
    if not isinstance(msg, dict) or not isinstance(msg.get('content'), str):
        return ''
    original = msg.get('originalContent')
    if not isinstance(original, str) or not original:
        msg['originalContent'] = msg['content']
    return msg['originalContent']


def read_baseline(msg):
    """Non-mutating read of the baseline."""
    if not isinstance(msg, dict) or not isinstance(msg.get('content'), str):
        return ''
    original = msg.get('originalContent')
    return original if isinstance(original, str) and original else msg['content']


def collect_pruned_paths(text):
    """{normalized path: reason} for every block already carrying the pruned marker."""
    found = {}
    if not isinstance(text, str) or not text:
        return found
    for block in scan_file_blocks_for_text(text):
        if block['isPruned']:
            key = normalize_path(block['path'])
            if key:
                found[key] = block['prunedReason'] or ''
    return found


# ---------------------------------------------------------------------------
# Rewriting content
# ---------------------------------------------------------------------------

def _resolve_target(block_path, targets):
    if block_path in targets:
        return targets[block_path]
    for target, reason in targets.items():
        if block_path.endswith('/' + target):
            return reason
    return None


def _prune_targets(prune_files):
    targets = {}
    for item in prune_files if isinstance(prune_files, list) else []:
        if not isinstance(item, dict) or item.get('stay') is not False:
            continue
        path = normalize_path(item.get('path'))
        if path and item.get('reason'):
            targets[path] = sanitize_reason(item.get('reason'))
    return targets


def prune_files_from_content(content, prune_files):
    """Replaces the body of every matching FILE block with the pruned marker. None when nothing matched."""
    if not isinstance(content, str) or not content:
        return None
    targets = _prune_targets(prune_files)
    if not targets:
        return None
    result = content
    mutated = False
    # Back to front, so every offset still refers to unmodified text when used.
    for block in reversed(scan_file_blocks_for_text(content)):
        if block['isPruned']:
            continue
        reason = _resolve_target(normalize_path(block['path']), targets)
        if reason is None:
            continue
        header = _HEADER_RE.match(content, block['start'], block['end'])
        if not header:
            continue
        body_start = header.end()
        fence = _OPEN_FENCE_RE.match(content, body_start, block['end'])
        marker = f'{PRUNED_PREFIX} {reason})'
        body = (fence.group(0) + marker + '\n```\n\n') if fence else (marker + '\n\n')
        result = result[:body_start] + body + result[block['end']:]
        mutated = True
    return result if mutated else None


def _materialize_model_prunes(msg):
    """Upgrades a legacy message that only carries prunedContent into an explicit path list."""
    if msg.get('modelPrunedPaths') is not None:
        return
    snapshot = msg.get('prunedContent')
    if isinstance(snapshot, str) and snapshot:
        found = collect_pruned_paths(snapshot)
        if found:
            msg['modelPrunedPaths'] = found


def _active_model_prunes(msg):
    active = {}
    if not isinstance(msg, dict) or msg.get('modelPruneActive') is False:
        return active
    stored = msg.get('modelPrunedPaths')
    if isinstance(stored, dict):
        for key, reason in stored.items():
            active[normalize_path(key)] = sanitize_reason(reason)
        return active
    snapshot = msg.get('prunedContent')
    if isinstance(snapshot, str) and snapshot:
        active.update(collect_pruned_paths(snapshot))
    return active


def desired_prune_paths(msg):
    """The model's active set plus the user's manual set, as {normalized path: reason}."""
    desired = _active_model_prunes(msg)
    manual = msg.get('manualPrunedPaths') if isinstance(msg, dict) else None
    if isinstance(manual, dict):
        for key, reason in manual.items():
            desired[normalize_path(key)] = sanitize_reason(reason)
    return desired


def build_content_for_paths(msg, path_map):
    """Baseline text with exactly path_map pruned. Non-mutating."""
    baseline = read_baseline(msg)
    if not baseline:
        content = msg.get('content') if isinstance(msg, dict) else None
        return content if isinstance(content, str) else ''
    if not path_map:
        return baseline
    files = [{'path': path, 'stay': False, 'reason': reason} for path, reason in path_map.items()]
    return prune_files_from_content(baseline, files) or baseline


def rebuild_message_content(msg):
    """Recomputes content from the baseline. Idempotent. Returns True when it changed."""
    if not _is_user(msg) or not read_baseline(msg):
        return False
    nxt = build_content_for_paths(msg, desired_prune_paths(msg))
    if msg['content'] == nxt:
        return False
    msg['content'] = nxt
    return True


# ---------------------------------------------------------------------------
# Manual pruning (the drawer)
# ---------------------------------------------------------------------------

def _available_paths(baseline):
    return {normalize_path(block['path']) for block in scan_file_blocks_for_text(baseline)} - {''}


def _apply_key(msg, key, should_prune, reason):
    if should_prune:
        manual = msg.get('manualPrunedPaths')
        if not isinstance(manual, dict):
            manual = {}
            msg['manualPrunedPaths'] = manual
        if manual.get(key) == reason:
            return False
        manual[key] = reason
        return True
    changed = False
    for field in ('manualPrunedPaths', 'modelPrunedPaths'):
        store = msg.get(field)
        if isinstance(store, dict) and key in store:
            del store[key]
            changed = True
    return changed


def set_prune_state(messages, keys, should_prune, reason=''):
    """Prunes or restores keys on every user message carrying them. Returns messages touched.

    Restoring clears both the manual and the model set, so a file the AI pruned
    can be brought back directly.
    """
    if not isinstance(messages, list) or not isinstance(keys, (list, tuple, set)):
        return 0
    wanted = {normalize_path(key) for key in keys} - {''}
    if not wanted:
        return 0
    clean_reason = sanitize_reason(reason)
    touched = 0
    for msg in messages:
        if not _is_user(msg):
            continue
        baseline = get_baseline(msg)
        if 'FILE: ' not in baseline:
            continue
        available = _available_paths(baseline)
        if not available:
            continue
        _materialize_model_prunes(msg)
        changed = False
        for key in sorted(wanted & available):
            changed = _apply_key(msg, key, should_prune, clean_reason) or changed
        if not changed:
            continue
        if isinstance(msg.get('manualPrunedPaths'), dict) and not msg['manualPrunedPaths']:
            del msg['manualPrunedPaths']
        if not should_prune:
            # The legacy snapshot would resurrect whatever was just cleared.
            msg.pop('prunedContent', None)
        rebuild_message_content(msg)
        touched += 1
    return touched


def restore_all_manual(messages):
    """Drops every manual prune, leaving the model's set intact."""
    touched = 0
    for msg in messages if isinstance(messages, list) else []:
        if _is_user(msg) and 'manualPrunedPaths' in msg:
            del msg['manualPrunedPaths']
            rebuild_message_content(msg)
            touched += 1
    return touched


def set_model_prune_active(messages, indices, active):
    """Turns the model's prune set on or off for the given user messages."""
    count = 0
    if not isinstance(messages, list):
        return count
    for index in indices if isinstance(indices, list) else []:
        if isinstance(index, int) and 0 <= index < len(messages) and _is_user(messages[index]):
            messages[index]['modelPruneActive'] = bool(active)
            rebuild_message_content(messages[index])
            count += 1
    return count


# ---------------------------------------------------------------------------
# File index
# ---------------------------------------------------------------------------

def _extension(key):
    name = key.rsplit('/', 1)[-1]
    dot = name.rfind('.')
    return name[dot + 1:].lower() if dot > 0 else ''


def _new_row(key, path, index):
    return {'key': key, 'path': path, 'ext': _extension(key), 'tokens': 0, 'prunedTokens': 0,
            'count': 0, 'prunedCount': 0, 'manualCount': 0, 'partialCount': 0, 'reason': '',
            'firstIndex': index, 'labels': [], 'occurrences': []}


def _add_occurrence(row, block, index, label, is_pruned, is_manual, reason):
    tokens = count_tokens(block['content'])
    row['occurrences'].append({'messageIndex': index, 'label': label, 'tokens': tokens,
                               'isPruned': is_pruned, 'isManual': is_manual})
    row['count'] += 1
    row['tokens'] += tokens
    if is_pruned:
        row['prunedCount'] += 1
        row['prunedTokens'] += tokens
        if not row['reason']:
            row['reason'] = reason
    if is_manual:
        row['manualCount'] += 1
    if block['isPartial']:
        row['partialCount'] += 1
    if label not in row['labels']:
        row['labels'].append(label)


def build_file_index(messages):
    """One row per distinct path across every user message, with its occurrences.

    State comes from the live text and sizes from the baseline, so a pruned file
    still reports what it would cost if restored.
    """
    rows = {}
    user_count = 0
    for index, msg in enumerate(messages if isinstance(messages, list) else []):
        if len(rows) >= MAX_INDEX_ROWS:
            break
        if not _is_user(msg):
            continue
        user_count += 1
        baseline = read_baseline(msg)
        if 'FILE: ' not in baseline:
            continue
        pruned_now = collect_pruned_paths(msg['content'])
        manual = msg.get('manualPrunedPaths') if isinstance(msg.get('manualPrunedPaths'), dict) else {}
        label = f'U{user_count}'
        for block in scan_file_blocks_for_text(baseline):
            key = normalize_path(block['path'])
            if not key:
                continue
            row = rows.get(key)
            if row is None:
                if len(rows) >= MAX_INDEX_ROWS:
                    continue
                row = _new_row(key, block['path'], index)
                rows[key] = row
            _add_occurrence(row, block, index, label, key in pruned_now, key in manual, pruned_now.get(key, ''))
    result = list(rows.values())
    for row in result:
        row['isPruned'] = row['count'] > 0 and row['prunedCount'] == row['count']
        row['isMixed'] = 0 < row['prunedCount'] < row['count']
        row['isPartial'] = row['partialCount'] > 0
    return result


# ---------------------------------------------------------------------------
# Payload scanning (execution.js)
# ---------------------------------------------------------------------------

def _json_object_end(text, start):
    """Index of the brace closing the object opened at start, or -1. Respects string quoting."""
    depth = 0
    in_string = False
    escape_next = False
    for index in range(start, len(text)):
        ch = text[index]
        if escape_next:
            escape_next = False
        elif ch == '\\':
            escape_next = True
        elif ch == '"':
            in_string = not in_string
        elif not in_string:
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return index
    return -1


def scan_json_objects(text):
    """Top-level {...} objects in text, each with its enclosing markdown fence range."""
    results = []
    if not isinstance(text, str) or not text:
        return results
    cursor = 0
    for _ in range(MAX_JSON_CANDIDATES):
        start = text.find('{', cursor)
        if start == -1:
            break
        end = _json_object_end(text, start)
        if end == -1:
            cursor = start + 1
            continue
        block_start, block_end = start, end + 1
        before = _FENCE_BEFORE_RE.search(text, 0, block_start)
        if before:
            block_start = before.start()
        after = _FENCE_AFTER_RE.match(text, block_end)
        if after:
            block_end = after.end()
        results.append({'raw': text[start:end + 1], 'fullBlock': text[block_start:block_end],
                        'start': block_start, 'end': block_end})
        cursor = end + 1
    return results


def _clean_json_string(raw):
    """Escapes raw control characters inside JSON strings, which models often emit."""
    out = []
    in_string = False
    escape_next = False
    for ch in raw:
        if escape_next:
            escape_next = False
            out.append(ch)
        elif ch == '\\':
            escape_next = True
            out.append(ch)
        elif ch == '"':
            in_string = not in_string
            out.append(ch)
        elif in_string and ord(ch) < 0x20:
            out.append(json.dumps(ch)[1:-1])
        else:
            out.append(ch)
    return ''.join(out)


def safe_json_parse(raw):
    """json.loads with the web UI's two fallbacks; None when nothing parses."""
    if not isinstance(raw, str) or not raw:
        return None
    cleaned = _clean_json_string(raw)
    for candidate in (raw, cleaned, _TRAILING_COMMA_RE.sub(r'\1', cleaned)):
        try:
            return json.loads(candidate)
        except (ValueError, RecursionError):
            continue
    return None


def has_xml_payload_tag(text):
    return isinstance(text, str) and '_payload>' in text and bool(_XML_OPEN_RE.search(text))


def _parse_prune_xml_files(xml):
    files = []
    for match in _PRUNE_FILE_RE.finditer(xml):
        if len(files) >= MAX_XML_FILES:
            break
        files.append({'path': match.group(1).strip(), 'stay': match.group(2).strip().lower() == 'true',
                      'reason': match.group(3).strip()})
    return files


def _xml_entry(raw, full, start, end):
    files = _parse_prune_xml_files(raw)
    return {'format': 'xml', 'raw': raw, 'fullBlock': full, 'start': start, 'end': end,
            'data': {'phase': 'PRUNE', 'files': files}, 'files': files}


def _scan_prune_xml(text):
    results = []
    for match in _PRUNE_FENCE_RE.finditer(text):
        if len(results) >= MAX_XML_CANDIDATES:
            break
        results.append(_xml_entry(match.group(1), match.group(0), match.start(), match.end()))
    if results:
        return results
    for match in _PRUNE_TAG_RE.finditer(text):
        if len(results) >= MAX_XML_CANDIDATES:
            break
        results.append(_xml_entry(match.group(0), match.group(0), match.start(), match.end()))
    return results


def extract_all_prune_payloads(text):
    """Every JSON and XML PRUNE payload in text, in document order."""
    if not isinstance(text, str) or not text:
        return []
    payloads = []
    for candidate in scan_json_objects(text):
        data = safe_json_parse(candidate['raw'])
        if isinstance(data, dict) and data.get('phase') == 'PRUNE' and isinstance(data.get('files'), list):
            payloads.append(dict(candidate, format='json', data=data, files=data['files']))
    if 'PRUNE' in text and has_xml_payload_tag(text):
        payloads.extend(_scan_prune_xml(text))
    payloads.sort(key=lambda payload: payload['start'])
    return payloads


def extract_execution_payloads(text):
    """Every JSON EXECUTION payload in text, for rendering as a card."""
    found = []
    if not isinstance(text, str) or not text:
        return found
    for candidate in scan_json_objects(text):
        data = safe_json_parse(candidate['raw'])
        if isinstance(data, dict) and data.get('phase') == 'EXECUTION' and isinstance(data.get('files'), list):
            found.append(dict(candidate, format='json', data=data))
    return found


# ---------------------------------------------------------------------------
# Applying model prunes (prune.js)
# ---------------------------------------------------------------------------

def _index_of(messages, target):
    for index, msg in enumerate(messages):
        if msg is target:
            return index
    return -1


def _path_token_map(messages, limit):
    tokens = {}
    for msg in messages[:limit]:
        if not _is_user(msg):
            continue
        baseline = get_baseline(msg)
        if 'FILE: ' not in baseline:
            continue
        for block in scan_file_blocks_for_text(baseline):
            key = normalize_path(block['path'])
            if key and not block['isPruned']:
                tokens[key] = tokens.get(key, 0) + count_tokens(block['content'])
    return tokens


def _apply_model_prunes(messages, limit, prune_files):
    targets = []
    saved = 0
    for index in range(limit - 1, -1, -1):
        msg = messages[index]
        if not _is_user(msg):
            continue
        baseline = get_baseline(msg)
        if not baseline:
            continue
        pruned = prune_files_from_content(baseline, prune_files)
        if not pruned:
            continue
        before = collect_pruned_paths(baseline)
        paths = {path: reason for path, reason in collect_pruned_paths(pruned).items() if path not in before}
        if not paths:
            continue
        msg['modelPrunedPaths'] = paths
        msg['modelPruneActive'] = True
        msg['prunedContent'] = pruned
        saved += max(0, count_tokens(baseline) - count_tokens(pruned))
        rebuild_message_content(msg)
        targets.append(index)
    return targets, saved


def _payload_item(payload, token_map):
    dropped, kept, saved = [], [], 0
    files = payload.get('files') if isinstance(payload.get('files'), list) else []
    for entry in files:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get('path') or '').strip()
        reason = sanitize_reason(entry.get('reason') or '')
        if entry.get('stay') is True:
            kept.append({'path': path, 'reason': reason})
            continue
        tokens = token_map.get(normalize_path(path), 0)
        dropped.append({'path': path, 'reason': reason, 'tokens': tokens})
        saved += tokens
    return {'raw': payload['raw'], 'fullBlock': payload['fullBlock'], 'start': payload['start'],
            'end': payload['end'], 'dropped': dropped, 'kept': kept, 'tokensSaved': saved}


def handle_prune_payload(assistant_msg, messages):
    """Applies the PRUNE payloads in assistant_msg to every earlier user message.

    Writes and returns pruneInfo, or returns None when the reply has no payload.
    """
    if not isinstance(assistant_msg, dict) or not isinstance(assistant_msg.get('content'), str):
        return None
    payloads = extract_all_prune_payloads(assistant_msg['content'])
    if not payloads:
        assistant_msg.pop('pruneInfo', None)
        return None
    if not isinstance(messages, list) or len(messages) < 2:
        return None
    position = _index_of(messages, assistant_msg)
    limit = position if position > -1 else len(messages)
    token_map = _path_token_map(messages, limit)
    prune_files = [entry for payload in payloads for entry in (payload.get('files') or [])]
    targets, saved = _apply_model_prunes(messages, limit, prune_files)
    info = {
        'isPruned': True,
        'tokensSaved': saved,
        'targetIndices': targets,
        'userMsgIndex': targets[0] if targets else -1,
        'items': [_payload_item(payload, token_map) for payload in payloads],
    }
    assistant_msg['pruneInfo'] = info
    return info


def _clear_model_prunes(msg):
    for field in ('modelPrunedPaths', 'prunedContent', 'modelPruneActive'):
        msg.pop(field, None)
    rebuild_message_content(msg)


def restore_pruned_from_index(messages, cut_index):
    """Clears model prunes made by replies after cut_index. Manual prunes stay. Returns messages touched."""
    if not isinstance(messages, list) or not isinstance(cut_index, int):
        return 0
    touched = 0
    for msg in messages[cut_index + 1:]:
        info = msg.get('pruneInfo') if isinstance(msg, dict) else None
        if not isinstance(info, dict):
            continue
        indices = info.get('targetIndices')
        if not isinstance(indices, list):
            single = info.get('userMsgIndex', -1)
            indices = [single] if isinstance(single, int) and single > -1 else []
        for index in indices:
            if isinstance(index, int) and 0 <= index <= cut_index and index < len(messages) and _is_user(messages[index]):
                _clear_model_prunes(messages[index])
                touched += 1
    return touched
