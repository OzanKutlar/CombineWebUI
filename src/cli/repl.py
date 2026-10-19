"""Entry point of CLI mode: chat selection, the console loop and the session summary.

Nothing here opens a socket or calls an API. The conversation travels through
the clipboard and is stored in the same files the web UI reads.
"""
import time

from rich.markup import escape

from src.cli import console as con
from src.cli.clipboard import Clipboard
from src.cli.commands import COMMAND_WORDS, ReplContext, choose_chat, handle_command, open_chat
from src.cli.menu import is_interactive
from src.cli.profiles import ProfileStore
from src.cli.workflow import format_tokens, now_ms
from src.config import load_settings
from src.history import get_conversation, sanitize_conv_id

try:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import Completer, Completion
    from prompt_toolkit.styles import Style
    HAS_PROMPT_TOOLKIT = True
except ImportError:
    HAS_PROMPT_TOOLKIT = False

# The console runs until the user quits; this bound only guards against a runaway loop.
MAX_REPL_ITERATIONS = 10_000_000
REFRESH_SECONDS = 1.0
PROMPT_TEXT = 'combine> '
STATS_ROWS = (
    ('Prompts added', 'prompts'),
    ('Replies recorded', 'replies'),
    ('Clipboard copies', 'copies'),
    ('Prune changes', 'prunes'),
)


# ----------------------------------------------------------------------
# Status lines above the prompt (plain text, no Rich markup)
# ----------------------------------------------------------------------

def _clock_text(ms):
    seconds = max(0, int(ms // 1000))
    return f'{seconds // 60}:{seconds % 60:02d}'


def _cache_text(snap, now):
    info = snap['info']
    policy = snap['policy']
    if not info['exists']:
        return f'{policy} · the next copy starts a web chat'
    stamp = snap['stamp_ms']
    remaining = snap['ttl_ms'] - (now - stamp) if stamp is not None else 0
    state = f'warm {_clock_text(remaining)}' if remaining > 0 else 'cold'
    parts = [f'{policy} · {state}']
    held = info['held_count']
    if held:
        tokens = format_tokens(info['held_tokens'])
        word = 'prune' if held == 1 else 'prunes'
        due = info['due'] or ('cold' if remaining <= 0 else None)
        tail = f'due ({due})' if due else 'held'
        parts.append(f'{held} {word} {tail} (−{tokens})')
    if info['commit_requested']:
        parts.append('fresh chat on next copy')
    return ' · '.join(parts)


def status_lines(ctx, now):
    snap = ctx.snapshot
    if snap is None:
        return ' No chat open · type chat to pick or create one'
    info = snap['info']
    title = snap['title']
    label = snap['label']
    count = snap['messages']
    flags = ''
    if snap['awaiting']:
        copied = snap['copied']
        flags = f' · {copied} copied, waiting for reply' if copied else ' · prompt not copied yet'
    if ctx.staging is not None:
        flags += ' · payload staged'
    chat_line = f' Chat     {title} · {label} · {count} msgs{flags}'
    variant = snap['next_variant']
    if variant:
        next_count = snap['next_count']
        next_tokens = format_tokens(snap['next_tokens'])
        nxt = f'next copy: {variant} · {next_count} msgs · {next_tokens} tok'
    else:
        nxt = 'next copy: nothing new'
    if info['exists']:
        web_tokens = format_tokens(info['tokens'])
        limit = format_tokens(snap['limit'])
        web = f'web chat ≈ {web_tokens} / {limit}'
    else:
        web = 'no web chat yet'
    context_line = f' Context  {nxt}    {web}'
    cache_line = ' Cache    ' + _cache_text(snap, now)
    return '\n'.join((chat_line, context_line, cache_line))


# ----------------------------------------------------------------------
# Readers
# ----------------------------------------------------------------------

if HAS_PROMPT_TOOLKIT:
    class CommandCompleter(Completer):
        """Tab-completes command names in the first word only."""

        def __init__(self, words):
            self._words = tuple(words)

        def get_completions(self, document, complete_event):
            text = document.text_before_cursor.lstrip()
            if ' ' in text:
                return
            word = text.lstrip('/').lower()
            for name in self._words:
                if name.startswith(word):
                    yield Completion(name, start_position=-len(word))


def _prompt_reader(ctx):
    style = Style.from_dict({'status': 'ansibrightblack', 'prompt': 'bold ansicyan'})
    session = PromptSession(completer=CommandCompleter(COMMAND_WORDS), complete_while_typing=False, style=style)

    def message():
        return [('class:status', '\n' + status_lines(ctx, now_ms()) + '\n'), ('class:prompt', PROMPT_TEXT)]

    def read_line():
        try:
            return session.prompt(message, refresh_interval=REFRESH_SECONDS).strip()
        except (KeyboardInterrupt, EOFError):
            return None

    return read_line


def _plain_reader(ctx):
    def read_line():
        con.dim(escape(status_lines(ctx, now_ms())))
        try:
            return con.console.input('[bold cyan]combine> [/bold cyan]').strip()
        except (KeyboardInterrupt, EOFError):
            return None

    return read_line


# ----------------------------------------------------------------------
# Session
# ----------------------------------------------------------------------

def _identity_prefs():
    """The web UI's identity setting, so copies match what the browser would send."""
    settings = load_settings()
    ui = settings.get('ui_preferences') if isinstance(settings, dict) else None
    prefs = ui.get('identity_prefs') if isinstance(ui, dict) else None
    return prefs if isinstance(prefs, dict) else {}


def _initial_chat(ctx, chat_id):
    if not chat_id:
        return choose_chat(ctx)
    conv = get_conversation(chat_id) if sanitize_conv_id(chat_id) else None
    if conv is None:
        con.fail(f'No chat with id {escape(chat_id)}. Run without -c to pick one.')
    return conv


def _refresh(ctx):
    try:
        ctx.refresh()
    except Exception as e:  # a status failure must never stop the console
        ctx.snapshot = None
        con.fail(f'Could not compute the status: {escape(str(e))}')


def _loop(ctx):
    con.rule('CLI Console')
    con.info('Type [bold cyan]help[/bold cyan] for commands, [bold cyan]quit[/bold cyan] to exit. '
             'Tab completes command names.')
    use_toolkit = HAS_PROMPT_TOOLKIT and is_interactive()
    read_line = _prompt_reader(ctx) if use_toolkit else _plain_reader(ctx)
    for _ in range(MAX_REPL_ITERATIONS):
        _refresh(ctx)
        line = read_line()
        if line is None:
            break
        if line and not handle_command(ctx, line):
            break


def _summary(ctx, started):
    con.rule('Session Summary')
    lines = []
    if ctx.thread is not None:
        title = escape(ctx.thread.title)
        chat_id = escape(str(ctx.thread.conv.get('id') or ''))
        label = escape(ctx.thread.label)
        lines.append(f'Chat: [bold green]{title}[/bold green] [dim]({chat_id})[/dim]')
        lines.append(f'Label: {label}')
    for name, key in STATS_ROWS:
        value = ctx.stats.get(key, 0)
        lines.append(f'{name}: [bold]{value}[/bold]')
    minutes = (time.time() - started) / 60
    lines.append(f'[dim]Session length: {minutes:.1f} min. Everything is saved.[/dim]')
    con.panel('\n'.join(lines), title='CLI mode', style='blue')


def run_cli(chat_id=None, label=None):
    """Runs CLI mode until the user quits."""
    con.banner('CombineWebUI · CLI mode',
               'No server and no API calls: the conversation travels through your clipboard.')
    ctx = ReplContext(ProfileStore(), Clipboard(), _identity_prefs())
    conv = _initial_chat(ctx, chat_id)
    if conv is None:
        con.warn('No chat selected. Exiting.')
        return
    if not open_chat(ctx, conv, label):
        return
    started = time.time()
    try:
        _loop(ctx)
    finally:
        _summary(ctx, started)
