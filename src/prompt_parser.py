"""Python port of pages/static/js/promptParser.js.

FILE blocks are located across the whole text before any header detection, and a
header inside a file's own body is never a section boundary, exactly as in the
web UI, so both sides agree on where every block starts and ends.
"""
import re

HEADERS = (
    {'id': 'user_request', 'title': 'User Request', 'match': '--- USER REQUEST ---'},
    {'id': 'user_reminder', 'title': 'User Request (Reminder)', 'match': '--- USER REQUEST (Reminder) ---'},
    {'id': 'ast_map', 'title': 'Directory AST Map', 'match': '--- DIRECTORY AST MAP ---'},
    {'id': 'file_context', 'title': 'File Context', 'match': '--- FILE CONTEXT ---'},
    {'id': 'requested_file_context', 'title': 'File Context', 'match': '--- REQUESTED FILE CONTEXT ---'},
    {'id': 'git_diff', 'title': 'Uncommitted Git Diff', 'match': '--- CURRENT UNCOMMITTED GIT DIFF ---'},
    {'id': 'system_prompt', 'title': 'System Instructions', 'match': '--- SYSTEM INSTRUCTIONS ---'},
    {'id': 'system_reminder', 'title': 'System Reminder', 'match': '--- SYSTEM REMINDER ---'},
    {'id': 'missing_files', 'title': 'System Note: Missing Files', 'match': '--- SYSTEM NOTE: MISSING FILES ---'},
    {'id': 'prune_note', 'title': 'System Note: Context Pruning', 'match': '--- SYSTEM NOTE: CONTEXT PRUNING ---'},
    {'id': 'search_results', 'title': 'System Note: Search Results', 'match': '--- SYSTEM NOTE: SEARCH RESULTS ---'},
)
_HEADER_BY_LINE = {header['match']: header for header in HEADERS}

MAX_FILE_BLOCKS = 2000
PRUNED_PREFIX = '(Has been removed from context because:'
REQUEST_IDS = ('user_request', 'user_reminder')
FILE_CONTEXT_IDS = ('file_context', 'requested_file_context')

_BLOCK_START_RE = re.compile(r'-{35}\r?\nFILE: (.*?)\r?\n-{35}\r?\n')
_HIDDEN_RANGE_RE = re.compile(r'// \.\.\. \(lines \d+-\d+ hidden\) \.\.\.')
_FENCE_OPEN_RE = re.compile(r'```[\w.+-]*', re.ASCII)
_EARLY_END_RE = re.compile(r'\n```\s*\n*\Z')
_LINE_SPLIT_RE = re.compile(r'\r\n|\n')
_PRUNED_TAIL_RE = re.compile(r'\)\Z')
_NEWLINE_RE = re.compile('\n')


def _strip_outer_fence(body):
    """Drops the block's own opening and closing fence, never one inside the file."""
    lines = _LINE_SPLIT_RE.split(body)
    start = 0
    while start < len(lines) and lines[start].strip() == '':
        start += 1
    if start < len(lines) and _FENCE_OPEN_RE.fullmatch(lines[start].strip()):
        start += 1
    end = len(lines)
    last = len(lines) - 1
    while last >= start and lines[last].strip() == '':
        last -= 1
    if last >= start and lines[last].strip() == '```':
        end = last
    return '\n'.join(lines[start:end])


def _block_starts(text):
    starts = []
    for match in _BLOCK_START_RE.finditer(text):
        if len(starts) >= MAX_FILE_BLOCKS:
            break
        starts.append((match.start(), match.end(), (match.group(1) or '').strip()))
    return starts


def _early_end(text, body_start, block_end, marks):
    """Where a header right after a closing fence ends the block early, else None."""
    for mark in marks:
        offset = mark['offset']
        if body_start < offset < block_end and _EARLY_END_RE.search(text, body_start, offset):
            return offset
    return None


def _file_entry(text, header_start, body_start, block_end, path):
    content = _strip_outer_fence(text[body_start:block_end]).strip()
    is_pruned = content.startswith(PRUNED_PREFIX)
    hidden = len(_HIDDEN_RANGE_RE.findall(content))
    reason = ''
    if is_pruned:
        reason = _PRUNED_TAIL_RE.sub('', content.replace(PRUNED_PREFIX, '', 1)).strip()
    return {
        'path': path,
        'content': content,
        'isPruned': is_pruned,
        'prunedReason': reason,
        'isPartial': (not is_pruned) and hidden > 0,
        'hiddenRangeCount': hidden,
        'start': header_start,
        'end': block_end,
    }


def scan_file_blocks(text, marks=()):
    """Every FILE block with its parsed content and its [start, end) range in text."""
    if not isinstance(text, str) or not text:
        return []
    starts = _block_starts(text)
    files = []
    for index, (header_start, body_start, path) in enumerate(starts):
        block_end = starts[index + 1][0] if index + 1 < len(starts) else len(text)
        early = _early_end(text, body_start, block_end, marks)
        if early is not None:
            block_end = early
        files.append(_file_entry(text, header_start, body_start, block_end, path))
    return files


def _line_offsets(text):
    return [0] + [match.end() for match in _NEWLINE_RE.finditer(text)]


def _header_marks(text):
    lines = text.split('\n')
    offsets = _line_offsets(text)
    marks = []
    for index, line in enumerate(lines):
        header = _HEADER_BY_LINE.get(line.strip())
        if header is not None:
            marks.append({'line': index, 'def': header, 'offset': offsets[index]})
    return lines, offsets, marks


def scan_file_blocks_for_text(text):
    """scan_file_blocks() with the header marks computed, so the last block never
    swallows the sections that follow it."""
    if not isinstance(text, str) or not text:
        return []
    return scan_file_blocks(text, _header_marks(text)[2])


def _inside_any(offset, files):
    return any(item['start'] <= offset < item['end'] for item in files)


def _strip_ranges(text, ranges):
    if not ranges:
        return text
    out = []
    cursor = 0
    for start, end in sorted(ranges):
        if start < cursor:
            continue
        out.append(text[cursor:start])
        cursor = max(cursor, end)
    out.append(text[cursor:])
    return ''.join(out)


def _trim_range(text, start, end):
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def _clip_before_files(start, end, files):
    clipped = end
    for item in files:
        if start <= item['start'] < clipped:
            clipped = item['start']
    return clipped


def _preamble_spans(raw, limit, files):
    """Prose segments of a header-less preamble. The first is primary."""
    ranges = sorted((item['start'], min(item['end'], limit)) for item in files if item['start'] < limit)
    spans = []
    cursor = 0
    for index in range(len(ranges) + 1):
        gap_end = ranges[index][0] if index < len(ranges) else limit
        if gap_end > cursor:
            start, end = _trim_range(raw, cursor, gap_end)
            if end > start:
                spans.append({'start': start, 'end': end, 'kind': 'preamble', 'primary': not spans})
        if index < len(ranges):
            cursor = max(cursor, ranges[index][1])
    return spans


def _empty_result():
    return {'isStructured': False, 'userRequest': None, 'sections': [], 'files': [], 'requestSpans': []}


def parse_combinecopy_prompt(raw):
    """Returns {isStructured, userRequest, sections, files, requestSpans}."""
    if not isinstance(raw, str) or not raw:
        return _empty_result()
    lines, offsets, potential = _header_marks(raw)
    files = scan_file_blocks(raw, potential)
    marks = [mark for mark in potential if not _inside_any(mark['offset'], files)]
    user_request = None
    spans = []

    first_mark = offsets[marks[0]['line']] if marks else len(raw)
    if first_mark > 0:
        ranges = [(item['start'], min(item['end'], first_mark)) for item in files if item['start'] < first_mark]
        preamble = _strip_ranges(raw[:first_mark], ranges).strip()
        if preamble:
            user_request = preamble
            spans.extend(_preamble_spans(raw, first_mark, files))

    sections = []
    saw_file_context = bool(files)
    for index, mark in enumerate(marks):
        nxt = marks[index + 1] if index + 1 < len(marks) else None
        body_line = mark['line'] + 1
        end_line = nxt['line'] if nxt else len(lines)
        header_start = offsets[mark['line']]
        body_start = offsets[body_line] if body_line < len(offsets) else len(raw)
        body_end = offsets[nxt['line']] if nxt else len(raw)
        kind = mark['def']['id']
        if kind in REQUEST_IDS:
            start, end = _trim_range(raw, body_start, _clip_before_files(body_start, body_end, files))
            spans.append({'start': start, 'end': end, 'kind': 'header', 'empty': start == end})
            if user_request is None and end > start:
                user_request = raw[start:end]
            continue
        if kind in FILE_CONTEXT_IDS:
            saw_file_context = True
            continue
        body = '\n'.join(lines[body_line:end_line]).strip()
        if not body:
            continue
        sections.append({
            'id': f'{kind}_{index}',
            'title': mark['def']['title'],
            'body': body,
            'start': header_start,
            'end': _clip_before_files(header_start, body_end, files),
        })

    if not (files or user_request is not None or saw_file_context or sections):
        return _empty_result()
    return {'isStructured': True, 'userRequest': user_request, 'sections': sections,
            'files': files, 'requestSpans': spans}
