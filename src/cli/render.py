"""Terminal rendering of chat messages with Rich's Markdown engine.

Replies are parsed as markdown. PRUNE and EXECUTION payloads become compact
cards and <think> blocks are shown dimmed, so a reply reads much as it does in
the web UI rather than as a raw JSON blob. combineCopy prompts show their
request plus a file table instead of the whole payload.
"""
import re

from rich.markdown import Markdown
from rich.markup import escape
from rich.panel import Panel
from rich.table import Table

from src.cli import console as con
from src.cli.workflow import format_tokens
from src.prompt_parser import parse_combinecopy_prompt
from src.prune_core import count_tokens, extract_all_prune_payloads, extract_execution_payloads

CODE_THEME = 'monokai'
MAX_CARD_ROWS = 60
_THINK_RE = re.compile(r'<(think|thinking|reasoning)>([\s\S]*?)</\1>', re.I)
_ACTION_STYLES = {'create': 'green', 'modify': 'yellow', 'delete': 'red', 'command': 'cyan'}


def _content(msg):
    content = msg.get('content') if isinstance(msg, dict) else None
    return content if isinstance(content, str) else ''


def _markdown(text):
    return Markdown(text, code_theme=CODE_THEME, hyperlinks=True)


def _prose(text):
    """Markdown renderables for plain text, with thinking blocks folded into dim panels."""
    out = []
    if not isinstance(text, str) or not text.strip():
        return out
    cursor = 0
    for match in _THINK_RE.finditer(text):
        before = text[cursor:match.start()]
        if before.strip():
            out.append(_markdown(before))
        body = match.group(2).strip()
        size = format_tokens(count_tokens(body))
        out.append(Panel(_markdown(body or '_(empty)_'), title=f'thinking · ≈{size} tokens',
                         border_style='bright_black', style='dim'))
        cursor = match.end()
    rest = text[cursor:]
    if rest.strip():
        out.append(_markdown(rest))
    return out


def _card_table(columns):
    table = Table(box=None, header_style='bold', pad_edge=False)
    for column in columns:
        table.add_column(column)
    return table


def _prune_card(payload, item):
    detail = item if isinstance(item, dict) else {}
    tokens = {}
    for entry in detail.get('dropped') or []:
        tokens[entry.get('path')] = entry.get('tokens') or 0
    table = _card_table(('', 'File', 'Tokens', 'Reason'))
    dropped = kept = 0
    for entry in payload.get('files') or []:
        if not isinstance(entry, dict):
            continue
        stay = entry.get('stay') is True
        kept += 1 if stay else 0
        dropped += 0 if stay else 1
        if dropped + kept > MAX_CARD_ROWS:
            continue
        path = str(entry.get('path') or '').strip()
        mark = '[green]keep[/green]' if stay else '[red]drop[/red]'
        size = '' if stay else format_tokens(tokens.get(path, 0))
        table.add_row(mark, escape(path), size, escape(str(entry.get('reason') or '')))
    saved = format_tokens(detail.get('tokensSaved') or 0)
    return Panel(table, title=f'✂ PRUNE · {dropped} dropped · {kept} kept',
                 subtitle=f'≈{saved} tokens', border_style='yellow')


def _exec_card(payload):
    data = payload.get('data') if isinstance(payload.get('data'), dict) else {}
    out = _prose(data.get('markdown') if isinstance(data.get('markdown'), str) else '')
    files = [entry for entry in data.get('files') or [] if isinstance(entry, dict)]
    table = _card_table(('Action', 'Path'))
    for entry in files[:MAX_CARD_ROWS]:
        action = str(entry.get('action') or 'modify').lower()
        target = entry.get('command') if action == 'command' else entry.get('path')
        style = _ACTION_STYLES.get(action, 'white')
        table.add_row(f'[{style}]{escape(action)}[/{style}]', escape(str(target or '')))
    commit = str(data.get('commit_message') or '').strip().splitlines()
    count = len(files)
    out.append(Panel(table, title=f'⚙ EXECUTION · {count} file(s)',
                     subtitle=escape(commit[0]) if commit else None, border_style='magenta'))
    return out


def reply_renderables(msg):
    """An assistant reply as markdown, with its payloads replaced by cards."""
    text = _content(msg)
    info = msg.get('pruneInfo') if isinstance(msg.get('pruneInfo'), dict) else {}
    items = {item.get('start'): item for item in info.get('items') or [] if isinstance(item, dict)}
    blocks = [(p['start'], p['end'], 'prune', p) for p in extract_all_prune_payloads(text)]
    blocks += [(p['start'], p['end'], 'exec', p) for p in extract_execution_payloads(text)]
    blocks.sort(key=lambda block: block[0])
    out = []
    cursor = 0
    for start, end, kind, payload in blocks:
        if start < cursor:
            continue
        out.extend(_prose(text[cursor:start]))
        if kind == 'prune':
            out.append(_prune_card(payload, items.get(start)))
        else:
            out.extend(_exec_card(payload))
        cursor = end
    out.extend(_prose(text[cursor:]))
    return out


def _files_card(files):
    table = Table(box=None, header_style='bold', pad_edge=False)
    table.add_column('#', justify='right', style='cyan')
    table.add_column('File')
    table.add_column('Tokens', justify='right')
    table.add_column('State')
    for number, block in enumerate(files[:MAX_CARD_ROWS], start=1):
        if block['isPruned']:
            size = '—'
            state = '[yellow]pruned[/yellow] ' + escape(block['prunedReason'])
        else:
            size = format_tokens(count_tokens(block['content']))
            state = '[dim]partial[/dim]' if block['isPartial'] else ''
        table.add_row(str(number), escape(block['path']), size, state)
    more = len(files) - MAX_CARD_ROWS
    count = len(files)
    return Panel(table, title=f'{count} file(s)', subtitle=f'{more} more' if more > 0 else None,
                 border_style='blue')


def prompt_renderables(msg):
    """A user prompt: its request as markdown, plus file and section summaries."""
    content = _content(msg)
    parsed = parse_combinecopy_prompt(content)
    if not parsed['isStructured']:
        return _prose(content)
    out = []
    request = parsed.get('userRequest') or ''
    if request.strip():
        out.append(Panel(_markdown(request), title='Request', border_style='cyan'))
    if parsed['files']:
        out.append(_files_card(parsed['files']))
    names = []
    for section in parsed['sections']:
        title = section['title']
        size = format_tokens(count_tokens(section['body']))
        names.append(f'{title} ≈{size}')
    if names:
        joined = escape(', '.join(names))
        out.append(f'[dim]Sections: {joined}[/dim]')
    return out


def render_message(msg, number=None):
    """Prints one message under a rule naming its author."""
    if not isinstance(msg, dict):
        return
    tag = f' #{number}' if number else ''
    if msg.get('role') == 'assistant':
        author = escape(str(msg.get('model') or 'AI'))
        con.rule(f'{author}{tag}')
        body = reply_renderables(msg)
    else:
        con.rule(f'You{tag}')
        body = prompt_renderables(msg)
    for renderable in body or [_markdown('_(empty)_')]:
        con.show(renderable)
