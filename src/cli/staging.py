"""Python port of pages/static/js/composer.js: a staged combineCopy paste.

The full payload is kept as pasted. On send it is rebuilt from that text:
dropped files and sections are cut out and the request spans take the edited
request. Nothing else is touched, so an unedited paste is sent byte for byte.
"""
from src.prompt_parser import parse_combinecopy_prompt

MAX_PASTE_CHARS = 20_000_000
MAX_EDITS = 4000
# Every combineCopy header and FILE block contains it, so it is a cheap gate.
PASTE_MARKER = '---'
KIND_FILE = 'file'
KIND_SECTION = 'section'


def parse_paste_text(text):
    """The parsed payload for pasted text, or None when it is not worth parsing."""
    if not isinstance(text, str) or not text or len(text) > MAX_PASTE_CHARS or PASTE_MARKER not in text:
        return None
    return parse_combinecopy_prompt(text)


def is_stageable(parsed):
    """Only payloads carrying something besides the request are staged."""
    if not isinstance(parsed, dict) or parsed.get('isStructured') is not True:
        return False
    return bool(parsed.get('files')) or bool(parsed.get('sections'))


def _valid_range(raw, start, end):
    return isinstance(start, int) and isinstance(end, int) and 0 <= start <= end <= len(raw)


def _removal_edits(raw, items, removed):
    edits = []
    for index in sorted(removed):
        if 0 <= index < len(items):
            item = items[index]
            if _valid_range(raw, item.get('start'), item.get('end')):
                edits.append((item['start'], item['end'], ''))
    return edits


def _span_text(raw, span, text):
    """What one request span becomes once the request is text."""
    if span.get('kind') == 'preamble':
        return text if span.get('primary') else ''
    if not span.get('empty'):
        return text
    if not text:
        return ''
    # An empty header body is an insertion point, so it needs its own line.
    lead = '\n' if span['start'] > 0 and raw[span['start'] - 1] != '\n' else ''
    return lead + text + '\n'


def _request_edits(raw, parsed, text):
    edits = []
    for span in parsed.get('requestSpans') or []:
        if isinstance(span, dict) and _valid_range(raw, span.get('start'), span.get('end')):
            edits.append((span['start'], span['end'], _span_text(raw, span, text)))
    return edits


def _apply_edits(raw, edits):
    """Applies non-overlapping edits front to back. An overlapping edit is skipped."""
    out = []
    cursor = 0
    for start, end, text in sorted(edits[:MAX_EDITS], key=lambda edit: (edit[0], edit[1])):
        if start < cursor:
            continue
        out.append(raw[cursor:start])
        out.append(text)
        cursor = end
    out.append(raw[cursor:])
    return ''.join(out)


class Staging:
    """A pasted payload waiting for send, with files or sections dropped and an editable request."""

    def __init__(self, raw, parsed):
        if not isinstance(raw, str) or not raw or not is_stageable(parsed):
            raise ValueError('Only a structured combineCopy payload can be staged.')
        self.raw = raw
        self.parsed = parsed
        self.removed_files = set()
        self.removed_sections = set()
        self.request_text = parsed.get('userRequest') or ''

    @property
    def files(self):
        return self.parsed.get('files') or []

    @property
    def sections(self):
        return self.parsed.get('sections') or []

    def set_removed(self, kind, index, removed):
        """Drops or restores one item. Returns False for an invalid index."""
        if kind == KIND_FILE:
            items, chosen = self.files, self.removed_files
        else:
            items, chosen = self.sections, self.removed_sections
        if not isinstance(index, int) or not 0 <= index < len(items):
            return False
        if removed:
            chosen.add(index)
        else:
            chosen.discard(index)
        return True

    def compose(self):
        """The text that will actually be sent."""
        edits = _removal_edits(self.raw, self.files, self.removed_files)
        edits += _removal_edits(self.raw, self.sections, self.removed_sections)
        request = self.request_text.strip()
        prefix = ''
        if request != (self.parsed.get('userRequest') or '').strip():
            swaps = _request_edits(self.raw, self.parsed, request)
            if swaps:
                edits += swaps
            elif request:
                # A payload with nowhere to hold a request gets it as a preamble.
                prefix = request + '\n\n'
        if not edits:
            return prefix + self.raw
        return prefix + _apply_edits(self.raw, edits)
