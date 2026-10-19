"""Builds the text copied to the clipboard: Human Hands blocks plus the identity fill.

The identity part ports pages/static/js/identity.js. Only the system
instructions of a user message are rewritten, never file context, and only the
copy is changed, never the stored message.
"""
import re

USER_HEADER = '------ USER MESSAGE ------'
AI_HEADER = '------ AI RESPONSE -------'
IDENTITY_PLACEHOLDER = '{{IDENTITY}}'
SYSTEM_MARKER = '--- SYSTEM INSTRUCTIONS ---'
PERSONA_TAIL = 'a powerful agentic AI coding assistant'
PLACEHOLDER_LINE = 'You are ' + IDENTITY_PLACEHOLDER + ', ' + PERSONA_TAIL + '.'
MAX_IDENTITY_TEXT = 200
MAX_BLOCK_REWRITES = 20
_IDENTITY_LINE_RE = re.compile(r'(<identity>[ \t]*\r?\n[ \t]*)(You are [^\r\n]*)')
_IDENTITY_OPEN_RE = re.compile(r'\s*<identity>')
_YOU_ARE_RE = re.compile(r'you are\s', re.I)
_YOU_ARE_PREFIX_RE = re.compile(r'^you are\s+', re.I)

PRESETS = {
    'antigravity': ('Antigravity', 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.'),
    'claude': ('Claude', 'You are Claude, a powerful agentic AI coding assistant created by Anthropic.'),
    'gemini': ('Gemini', 'You are Gemini, a powerful agentic AI coding assistant created by Google.'),
    'chatgpt': ('ChatGPT', 'You are ChatGPT, a powerful agentic AI coding assistant created by OpenAI.'),
    'neutral': ('the assistant', 'You are a powerful agentic AI coding assistant.'),
}
FAMILY_RULES = (
    ('claude', re.compile(r'claude|sonnet|opus|haiku')),
    ('gemini', re.compile(r'gemini')),
    ('chatgpt', re.compile(r'gpt|codex|(?:^|[^a-z0-9])o[1-9](?:[^a-z0-9]|$)')),
)


def _from_name(name):
    return name, f'You are {name}, {PERSONA_TAIL}.'


def _custom(text):
    """A bare name gets the standard persona line; a full You are sentence is used as is."""
    clean = ' '.join(str(text or '').split())[:MAX_IDENTITY_TEXT]
    if not clean:
        return PRESETS['neutral']
    if not _YOU_ARE_RE.match(clean):
        return _from_name(clean)
    name = re.split(r'[,.]', _YOU_ARE_PREFIX_RE.sub('', clean))[0].strip()
    return (name or PRESETS['neutral'][0]), clean


def resolve_identity(label, prefs):
    """((name, line), explicit), or (None, False) to send prompts unchanged.

    explicit is False only for an auto label that names no model family: the
    placeholder is then filled neutrally, but a hardcoded identity line stays.
    """
    rules = prefs if isinstance(prefs, dict) else {}
    mode = str(rules.get('mode') or 'auto')
    if mode == 'off':
        return None, False
    if mode == 'custom':
        return _custom(rules.get('customText')), True
    if mode != 'auto':
        preset = PRESETS.get(mode)
        return (preset, True) if preset else (None, False)
    haystack = str(label or '').lower()
    for preset, pattern in FAMILY_RULES:
        if pattern.search(haystack):
            return PRESETS[preset], True
    return PRESETS['neutral'], False


def _system_start(content):
    """The last marker, because file context comes first and may mention it."""
    index = content.rfind(SYSTEM_MARKER)
    if index != -1:
        return index
    return 0 if _IDENTITY_OPEN_RE.match(content) else -1


def apply_identity(content, label, prefs):
    """content with its identity tailored to the label. Never raises."""
    if not isinstance(content, str) or not content:
        return content if isinstance(content, str) else ''
    start = _system_start(content)
    if start == -1:
        return content
    identity, explicit = resolve_identity(label, prefs)
    if identity is None:
        return content
    name, line = identity
    section = content[start:]
    if IDENTITY_PLACEHOLDER in section:
        section = section.replace(PLACEHOLDER_LINE, line).replace(IDENTITY_PLACEHOLDER, name)
    override = explicit and not (isinstance(prefs, dict) and prefs.get('overrideHardcoded') is False)
    if override:
        section = _IDENTITY_LINE_RE.sub(lambda match: match.group(1) + line, section, count=MAX_BLOCK_REWRITES)
    return content[:start] + section


def _block(header, content):
    return f'{header}\n\n\n{content}\n\n\n\n'


def format_messages(messages, label='', prefs=None):
    """Human Hands' clipboard format, with the identity fill applied to user messages."""
    parts = []
    for msg in messages if isinstance(messages, list) else []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get('role') or '').upper()
        content = msg.get('content') if isinstance(msg.get('content'), str) else ''
        if role == 'USER':
            parts.append(_block(USER_HEADER, apply_identity(content, label, prefs)))
        elif role == 'ASSISTANT':
            parts.append(_block(AI_HEADER, content))
        else:
            parts.append(_block(f'------ {role} MESSAGE ------', content))
    return ''.join(parts)
