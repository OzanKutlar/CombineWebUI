"""Interactive console commands for CLI mode.

Commands are bare words and a leading '/' is optional, as in Translator. Every
handler takes (ctx, args), prints through src.cli.console, and saves the chat
after any change, so quitting never loses work.
"""
from rich.markup import escape
from rich.table import Table

from src.cli import console as con
from src.cli import render
from src.cli.chats import clean_title, list_chats, new_conversation
from src.cli.clipboard import ClipboardError
from src.cli.editor import EditorError, edit_text, editor_name
from src.cli.menu import MenuUnavailable, select_option
from src.cli.profiles import ProfileError, parse_limit, parse_policy, parse_ttl
from src.cli.staging import KIND_FILE, KIND_SECTION, Staging, is_stageable, parse_paste_text
from src.cli.workflow import VARIANTS, Thread, format_tokens, now_ms
from src.history import get_conversation, sanitize_conv_id, save_conversation
from src.prompt_parser import parse_combinecopy_prompt
from src.prune_core import build_file_index, count_tokens, normalize_path, tokenizer_name

MAX_SAY_LINES = 10_000
MAX_FILE_ROWS = 300
MAX_HISTORY_ROWS = 300
MAX_CHAT_ROWS = 100
MAX_PICK_ATTEMPTS = 5
PREVIEW_CHARS = 70
REQUEST_PREVIEW_CHARS = 600
NEW_CHAT_LABEL = '＋ New chat…'
REASON_FLAGS = ('-r', '--reason')
ALIASES = {
    'exit': 'quit', 'q': 'quit', '?': 'help', 'r': 'reply', 'micro': 'edit', 'write': 'edit',
    'ls': 'files', 'unprune': 'restore', 'log': 'history', 'open': 'chat',
}

HELP_ROWS = (
    ('chat [new <title>|<n|id>]', 'Open the chat picker (recent first, new chat last), create a chat, or open one by its number in chats or its id (alias: open).'),
    ('chats', 'List saved chats, newest first. They are the same chats the web UI shows.'),
    ('rename <title>', 'Rename the open chat.'),
    ('paste', 'Take the next prompt from the clipboard. A combineCopy payload is staged so you can drop files first; anything else is added and copied at once.'),
    ('say [text]', 'Type a prompt. Without text, enter several lines and finish with a line holding only a dot.'),
    ('edit', 'Write the next prompt in micro in this terminal; save and quit to add and copy it. With a payload staged it edits the request instead (aliases: micro, write).'),
    ('edit last', 'Reopen the last prompt in micro while it has no reply, then copy it again.'),
    ('staged', 'Show the staged payload: files, sections, request and size.'),
    ('drop <n|sN|a-b …>', 'Leave files, or sections sN, out of the staged payload.'),
    ('undrop <n|sN|a-b …>', 'Put dropped files or sections back.'),
    ('send', 'Add the staged payload as the next prompt and copy it.'),
    ('discard', 'Throw the staged payload away.'),
    ('copy [new|full]', 'Copy the conversation. new (the default) is what the web chat has not seen; full starts a fresh web chat with every prune applied.'),
    ('swap', 'Switch the clipboard between new and full for the current turn.'),
    ('reply', 'Record the clipboard as the reply and render it as markdown. PRUNE payloads in it are applied (alias: r).'),
    ('undo', 'Remove the last message. Undoing a reply also lifts the AI prunes it made.'),
    ('show [n]', 'Render a message as markdown (default: the last reply).'),
    ('history', 'Table of every message with its size (alias: log).'),
    ('files [filter]', 'Every file in the chat with its tokens and prune state; held marks prunes the web chat has not applied (alias: ls).'),
    ('prune <n|path|a-b …> [-r reason]', 'Prune files by their number in files, or by path.'),
    ('restore <n|path …|all|manual>', 'Restore files. all restores every pruned file, manual only the ones you pruned (alias: unprune).'),
    ('aiprune <on|off>', 'Apply or lift every prune the AI asked for.'),
    ('cache', 'Cache state for this label: warm or cold, held prunes, web chat size.'),
    ('flush', 'Apply held prunes now: the next copy starts a fresh web chat.'),
    ('policy <deferred|immediate>', 'Deferred holds prunes while the web chat is warm. Immediate makes every copy with held prunes a fresh chat.'),
    ('ttl <seconds|5m|1h>', 'How long the web chat counts as warm after a reply.'),
    ('limit <tokens|200k>', 'Context size of the web chat; at 85% held prunes become due.'),
    ('label [text]', 'Show or switch the web chat label. Each label has its own policy, TTL, limit and identity.'),
    ('status', 'Show chat, label, copy and cache details.'),
    ('clear', 'Clear the screen.'),
    ('help', 'Show this list (alias: ?).'),
    ('quit', 'Leave the console (aliases: exit, q). Everything is saved after each command.'),
)


class ReplContext:
    """Everything the handlers share: the open thread, the staged paste and the I/O seams."""

    def __init__(self, store, clipboard, identity_prefs, editor=edit_text, clock=now_ms):
        self.store = store
        self.clipboard = clipboard
        self.identity_prefs = identity_prefs if isinstance(identity_prefs, dict) else {}
        self.editor = editor
        self.clock = clock
        self.thread = None
        self.staging = None
        self.file_rows = []
        self.chat_list = []
        self.snapshot = None
        self.rest = ''
        self.stats = {'prompts': 0, 'replies': 0, 'copies': 0, 'prunes': 0}

    def open(self, conv, label=None):
        """Opens conv under label, or the label it was last used with. Raises ProfileError."""
        cli = conv.get('cli') if isinstance(conv.get('cli'), dict) else {}
        profile = self.store.get(label or cli.get('label') or self.store.last_label)
        self.thread = Thread(conv, profile, self.identity_prefs)
        self.staging = None
        self.file_rows = []
        if not self.store.set_last_label(profile.label):
            con.warn('Could not remember the label for next time.')
        self.save()

    def save(self):
        if self.thread is None:
            return True
        if save_conversation(self.thread.conv):
            return True
        con.fail('Could not save the chat; see the error above.')
        return False

    def refresh(self):
        self.snapshot = self.thread.snapshot(self.clock()) if self.thread is not None else None


# ----------------------------------------------------------------------
# Shared helpers
# ----------------------------------------------------------------------

def _preview(text, limit=PREVIEW_CHARS):
    line = ' '.join(str(text or '').split())
    return line if len(line) <= limit else line[:limit - 1] + '…'


def _plural(count, word):
    return f'{count} {word}' + ('' if count == 1 else 's')


def _need_thread(ctx):
    if ctx.thread is None:
        con.warn('No chat is open. Use [bold cyan]chat[/bold cyan] to pick or create one.')
    return ctx.thread


def _read_clipboard(ctx):
    try:
        return ctx.clipboard.read()
    except ClipboardError as e:
        con.fail(escape(str(e)))
        return None


def _put_clipboard(ctx, text):
    try:
        ctx.clipboard.copy(text)
    except ClipboardError as e:
        con.fail(escape(str(e)))
        return False
    ctx.stats['copies'] += 1
    return True


def _deliver(ctx, text, reports):
    """Copies a prepared text, or forgets the copy when the clipboard refuses it."""
    if text is None:
        con.print_report(reports)
        return False
    if not _put_clipboard(ctx, text):
        ctx.thread.forget_copy()
        con.print_report([report for report in reports if report[0] != 'ok'])
        return False
    con.print_report(reports)
    ctx.save()
    return True


def _copy(ctx, requested=None):
    text, _, reports = ctx.thread.prepare_copy(requested, ctx.clock())
    return _deliver(ctx, text, reports)


def _commit_prompt(ctx, text):
    added, reports = ctx.thread.add_user(text, ctx.clock())
    con.print_report(reports)
    if not added:
        return False
    ctx.staging = None
    ctx.file_rows = []
    ctx.stats['prompts'] += 1
    ctx.save()
    _copy(ctx)
    return True


def _run_editor(ctx, initial):
    name = editor_name() or 'the editor'
    con.dim(f'Opening {escape(name)}. Save and quit to use the text.')
    try:
        return ctx.editor(initial)
    except EditorError as e:
        con.fail(escape(str(e)))
        return None


# ----------------------------------------------------------------------
# Chats
# ----------------------------------------------------------------------

def open_chat(ctx, conv, label=None):
    try:
        ctx.open(conv, label)
    except ProfileError as e:
        con.fail(escape(str(e)))
        return False
    title = escape(ctx.thread.title)
    label_text = escape(ctx.thread.label)
    con.ok(f'Opened [bold green]{title}[/bold green] for [bold cyan]{label_text}[/bold cyan].')
    return True


def _ask_new(ctx):
    try:
        title = con.console.input('[bold]Title for the new chat (Enter for New chat): [/bold]').strip()
    except (KeyboardInterrupt, EOFError):
        return None
    return new_conversation(title, ctx.clock())


def _numbered_choice(chats):
    con.rule('Select a chat')
    for number, chat in enumerate(chats, start=1):
        title = escape(chat.title)
        hint = escape(chat.hint)
        con.show(f'  [cyan]{number:3d}.[/cyan] {title}  [dim]{hint}[/dim]')
    con.show(f'  [cyan]  n.[/cyan] {NEW_CHAT_LABEL}')
    for _ in range(MAX_PICK_ATTEMPTS):
        try:
            answer = con.console.input('\n[bold]Chat number (n for a new chat, q to cancel): [/bold]').strip().lower()
        except (KeyboardInterrupt, EOFError):
            return None
        if answer in ('', 'q', 'quit'):
            return None
        if answer in ('n', 'new'):
            return len(chats)
        if answer.isdigit() and 1 <= int(answer) <= len(chats):
            return int(answer) - 1
        con.warn(f'Enter a number between 1 and {len(chats)}, n or q.')
    return None


def choose_chat(ctx):
    """Arrow-key picker over saved chats, newest first, with a new-chat row last."""
    chats = list_chats()
    if not chats:
        con.info('No chats yet. Enter a title to create the first one.')
        return _ask_new(ctx)
    labels = [chat.title for chat in chats] + [NEW_CHAT_LABEL]
    hints = [chat.hint for chat in chats] + ['']
    try:
        index = select_option('Select a chat', labels, hints)
    except MenuUnavailable as e:
        con.dim(f'Arrow-key menu unavailable ({escape(str(e))}); using a numbered list.')
        index = _numbered_choice(chats)
    if index is None:
        return None
    if index >= len(chats):
        return _ask_new(ctx)
    conv = get_conversation(chats[index].id)
    if conv is None:
        con.fail(f'Could not load chat {escape(chats[index].id)}.')
    return conv


def _conv_from_ref(ctx, ref):
    if ref.isdigit() and ctx.chat_list:
        number = int(ref)
        if 1 <= number <= len(ctx.chat_list):
            ref = ctx.chat_list[number - 1].id
    conv = get_conversation(ref) if sanitize_conv_id(ref) else None
    if conv is None:
        con.warn(f'No chat {escape(ref)}. Run [bold cyan]chats[/bold cyan] to list them.')
    return conv


def cmd_chat(ctx, args):
    if args and args[0].lower() == 'new':
        open_chat(ctx, new_conversation(' '.join(args[1:]), ctx.clock()))
        return
    if args:
        conv = _conv_from_ref(ctx, args[0])
        if conv is not None:
            open_chat(ctx, conv)
        return
    conv = choose_chat(ctx)
    if conv is None:
        con.info('Chat unchanged.')
        return
    open_chat(ctx, conv)


def cmd_chats(ctx, args):
    chats = list_chats()
    ctx.chat_list = chats
    if not chats:
        con.info('No saved chats yet. Create one with [bold cyan]chat new <title>[/bold cyan].')
        return
    table = Table(title='Chats (newest first)', border_style='blue')
    table.add_column('#', justify='right', style='cyan')
    table.add_column('Title', style='bold')
    table.add_column('Details', style='dim')
    table.add_column('Id', style='dim')
    for number, chat in enumerate(chats[:MAX_CHAT_ROWS], start=1):
        table.add_row(str(number), escape(chat.title), escape(chat.hint), escape(chat.id))
    con.show(table)
    con.dim('Open one with chat <number> or chat <id>.')


def cmd_rename(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    title = clean_title(ctx.rest)
    if not title:
        con.warn('Usage: rename <title>')
        return
    thread.conv['title'] = title
    ctx.save()
    con.ok(f'Renamed the chat to [bold green]{escape(title)}[/bold green].')


# ----------------------------------------------------------------------
# Prompts
# ----------------------------------------------------------------------

def _staged_state(removed, already_pruned=False):
    if removed:
        return '[red]dropped[/red]'
    return '[yellow]already pruned[/yellow]' if already_pruned else '[green]kept[/green]'


def _print_staged(ctx):
    staging = ctx.staging
    table = Table(title='Staged Payload', border_style='cyan')
    table.add_column('#', justify='right', style='cyan')
    table.add_column('Item')
    table.add_column('Tokens', justify='right')
    table.add_column('State')
    for number, block in enumerate(staging.files, start=1):
        state = _staged_state((number - 1) in staging.removed_files, block['isPruned'])
        table.add_row(str(number), escape(block['path']), format_tokens(count_tokens(block['content'])), state)
    for number, section in enumerate(staging.sections, start=1):
        state = _staged_state((number - 1) in staging.removed_sections)
        table.add_row(f's{number}', escape(section['title']), format_tokens(count_tokens(section['body'])), state)
    con.show(table)
    request = staging.request_text.strip()
    shown = request[:REQUEST_PREVIEW_CHARS] + ('…' if len(request) > REQUEST_PREVIEW_CHARS else '')
    con.panel(escape(shown) if shown else '[dim](no request)[/dim]', title='Request', style='cyan')
    size = format_tokens(count_tokens(staging.compose()))
    con.info(f'Sends ≈{size} tokens. [bold cyan]drop[/bold cyan] or [bold cyan]undrop[/bold cyan] items, '
             '[bold cyan]edit[/bold cyan] the request, then [bold cyan]send[/bold cyan] '
             '([bold cyan]discard[/bold cyan] cancels).')


def _number_range(ref):
    """(low, high) for '3' or '2-5', else None."""
    first, _, last = ref.partition('-')
    if not first.isdigit() or (last and not last.isdigit()):
        return None
    return int(first), int(last or first)


def _staged_targets(staging, args):
    targets, bad = [], []
    for raw in args:
        token = raw.lower()
        kind = KIND_SECTION if token.startswith('s') else KIND_FILE
        bounds = _number_range(token[1:] if kind == KIND_SECTION else token)
        count = len(staging.sections if kind == KIND_SECTION else staging.files)
        if bounds is None or not 1 <= bounds[0] <= bounds[1] <= count:
            bad.append(raw)
            continue
        targets.extend((kind, number - 1) for number in range(bounds[0], bounds[1] + 1))
    return targets, bad


def _toggle_staged(ctx, args, removed):
    if ctx.staging is None:
        con.warn('Nothing is staged. Copy a combineCopy payload and run [bold cyan]paste[/bold cyan].')
        return
    if not args:
        con.warn(escape('Usage: drop <n|sN|a-b …> or undrop <n|sN|a-b …>'))
        return
    targets, bad = _staged_targets(ctx.staging, args)
    for kind, index in targets:
        ctx.staging.set_removed(kind, index, removed)
    if bad:
        joined = ', '.join(bad)
        con.warn(f'Not in the staged payload: {escape(joined)}')
    if targets:
        _print_staged(ctx)


def cmd_paste(ctx, args):
    if _need_thread(ctx) is None:
        return
    text = _read_clipboard(ctx)
    if text is None:
        return
    if not text.strip():
        con.warn('The clipboard is empty.')
        return
    if ctx.clipboard.is_own(text):
        con.warn('The clipboard holds the conversation this CLI copied, not a new prompt.')
        return
    parsed = parse_paste_text(text)
    if is_stageable(parsed):
        if ctx.staging is not None:
            con.dim('Replaced the previously staged payload.')
        ctx.staging = Staging(text, parsed)
        _print_staged(ctx)
        return
    _commit_prompt(ctx, text)


def _read_lines():
    con.dim('Type the prompt. Finish with a line holding only a dot; Ctrl+C cancels.')
    lines = []
    for _ in range(MAX_SAY_LINES):
        try:
            line = con.console.input('[dim]… [/dim]')
        except (KeyboardInterrupt, EOFError):
            con.info('Cancelled.')
            return None
        if line.strip() == '.':
            return '\n'.join(lines)
        lines.append(line)
    con.warn(f'Stopped after {MAX_SAY_LINES:,} lines.')
    return '\n'.join(lines)


def cmd_say(ctx, args):
    if _need_thread(ctx) is None:
        return
    text = ctx.rest if args else _read_lines()
    if text is None:
        return
    if ctx.staging is not None:
        ctx.staging.request_text = text
        _print_staged(ctx)
        return
    if not text.strip():
        con.info('Nothing was typed, so no prompt was added.')
        return
    _commit_prompt(ctx, text.strip())


def _edit_last(ctx, thread):
    initial = thread.editable_last()
    if initial is None:
        con.warn('The last message is not an unanswered prompt. Run [bold cyan]undo[/bold cyan] to drop a reply first.')
        return
    text = _run_editor(ctx, initial)
    if text is None:
        return
    changed, reports = thread.edit_last(text, ctx.clock())
    con.print_report(reports)
    if changed:
        ctx.file_rows = []
        ctx.save()
        _copy(ctx)


def cmd_edit(ctx, args):
    """edit -> write a prompt in micro; edit last -> rewrite the unanswered prompt."""
    thread = _need_thread(ctx)
    if thread is None:
        return
    target = args[0].lower() if args else ''
    if target not in ('', 'last'):
        con.warn(escape('Usage: edit [last]'))
        return
    if target == 'last':
        _edit_last(ctx, thread)
        return
    if ctx.staging is not None:
        text = _run_editor(ctx, ctx.staging.request_text)
        if text is not None:
            ctx.staging.request_text = text
            _print_staged(ctx)
        return
    text = _run_editor(ctx, '')
    if text is None:
        return
    if not text.strip():
        con.info('Nothing was written, so no prompt was added.')
        return
    _commit_prompt(ctx, text)


def cmd_staged(ctx, args):
    if ctx.staging is None:
        con.info('Nothing is staged.')
        return
    _print_staged(ctx)


def cmd_drop(ctx, args):
    _toggle_staged(ctx, args, True)


def cmd_undrop(ctx, args):
    _toggle_staged(ctx, args, False)


def cmd_send(ctx, args):
    if _need_thread(ctx) is None:
        return
    if ctx.staging is None:
        con.warn('Nothing is staged. Copy a combineCopy payload and run [bold cyan]paste[/bold cyan].')
        return
    text = ctx.staging.compose()
    if not text.strip():
        con.warn('The staged payload is empty after the drops.')
        return
    _commit_prompt(ctx, text)


def cmd_discard(ctx, args):
    if ctx.staging is None:
        con.info('Nothing is staged.')
        return
    ctx.staging = None
    con.ok('Staged payload discarded.')


# ----------------------------------------------------------------------
# Copies and replies
# ----------------------------------------------------------------------

def cmd_copy(ctx, args):
    if _need_thread(ctx) is None:
        return
    requested = args[0].lower() if args else None
    if requested is not None and requested not in VARIANTS:
        con.warn(escape('Usage: copy [new|full]'))
        return
    _copy(ctx, requested)


def cmd_swap(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    text, _, reports = thread.swap(ctx.clock())
    _deliver(ctx, text, reports)


def cmd_reply(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    text = _read_clipboard(ctx)
    if text is None:
        return
    if ctx.clipboard.is_own(text):
        con.warn('The clipboard still holds the prompt this CLI copied. Copy the reply in the web chat first.')
        return
    msg, reports = thread.record_reply(text, ctx.clock())
    if msg is None:
        con.print_report(reports)
        return
    ctx.stats['replies'] += 1
    ctx.file_rows = []
    ctx.save()
    render.render_message(msg, len(thread.messages))
    con.print_report(reports)


def cmd_undo(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    con.print_report(thread.undo())
    ctx.file_rows = []
    ctx.save()


def _last_reply_index(messages):
    for index in range(len(messages) - 1, -1, -1):
        if isinstance(messages[index], dict) and messages[index].get('role') == 'assistant':
            return index
    return len(messages) - 1


def cmd_show(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    messages = thread.messages
    if not messages:
        con.info('This chat has no messages yet.')
        return
    if args:
        if not args[0].isdigit() or not 1 <= int(args[0]) <= len(messages):
            count = len(messages)
            con.warn(escape(f'Usage: show [1-{count}]'))
            return
        index = int(args[0]) - 1
    else:
        index = _last_reply_index(messages)
    render.render_message(messages[index], index + 1)


def _message_preview(msg):
    content = msg.get('content') if isinstance(msg.get('content'), str) else ''
    if msg.get('role') != 'user':
        return _preview(content)
    parsed = parse_combinecopy_prompt(content)
    if not parsed['isStructured']:
        return _preview(content)
    request = _preview(parsed.get('userRequest') or '(no request)', PREVIEW_CHARS - 12)
    files = len(parsed['files'])
    return f'{request} [{files} files]' if files else request


def _message_notes(msg):
    notes = []
    if msg.get('role') == 'assistant' and msg.get('model'):
        notes.append(str(msg.get('model')))
    info = msg.get('pruneInfo')
    if isinstance(info, dict):
        notes.append('PRUNE' if info.get('isPruned') is not False else 'PRUNE (off)')
    return ' · '.join(notes)


def cmd_history(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    messages = thread.messages
    if not messages:
        con.info('This chat has no messages yet.')
        return
    shown = messages[-MAX_HISTORY_ROWS:]
    first = len(messages) - len(shown) + 1
    table = Table(title=escape(thread.title), border_style='blue')
    table.add_column('#', justify='right', style='cyan')
    table.add_column('Role')
    table.add_column('Preview')
    table.add_column('Tokens', justify='right')
    table.add_column('Notes', style='dim')
    for number, msg in enumerate(shown, start=first):
        if not isinstance(msg, dict):
            continue
        role = 'you' if msg.get('role') == 'user' else str(msg.get('role') or '?')
        size = format_tokens(count_tokens(msg.get('content')))
        table.add_row(str(number), role, escape(_message_preview(msg)), size, escape(_message_notes(msg)))
    con.show(table)
    con.dim('Render one with show <number>.')


# ----------------------------------------------------------------------
# Files and pruning
# ----------------------------------------------------------------------

def _row_state(row, held_keys):
    if row['isPruned']:
        if row['manualCount'] >= row['count']:
            state = '[yellow]pruned[/yellow]'
        elif row['manualCount'] == 0:
            state = '[magenta]pruned (AI)[/magenta]'
        else:
            state = '[magenta]pruned (AI + you)[/magenta]'
    elif row['isMixed']:
        pruned, count = row['prunedCount'], row['count']
        state = f'[yellow]mixed {pruned}/{count}[/yellow]'
    else:
        state = '[green]active[/green]'
    if row['isPartial']:
        state += ' [dim]partial[/dim]'
    if row['key'] in held_keys:
        state += ' [dim]· held[/dim]'
    return state


def cmd_files(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    rows = build_file_index(thread.messages)
    ctx.file_rows = rows
    if not rows:
        con.info('No files in this chat.')
        return
    query = ' '.join(args).strip().lower()
    held = thread.chat_info(ctx.clock())['held']
    held_keys = {key for keys in held.values() for key in keys}
    table = Table(title='Files', border_style='blue')
    for column, justify in (('#', 'right'), ('File', 'left'), ('Tokens', 'right'), ('In', 'left'),
                            ('State', 'left'), ('Reason', 'left')):
        table.add_column(column, justify=justify)
    shown = 0
    for number, row in enumerate(rows, start=1):
        if query and query not in row['key'].lower():
            continue
        if shown >= MAX_FILE_ROWS:
            break
        shown += 1
        labels = ', '.join(row['labels'])
        table.add_row(str(number), escape(row['path']), format_tokens(row['tokens']), labels,
                      _row_state(row, held_keys), escape(row['reason']))
    con.show(table)
    total = format_tokens(sum(row['tokens'] for row in rows))
    saved = format_tokens(sum(row['prunedTokens'] for row in rows))
    con.info(f'{len(rows)} file(s), ≈{total} tokens, ≈{saved} pruned.')
    con.dim(escape('prune <n|path …> [-r reason] · restore <n|path …|all|manual> · aiprune on|off'))


def _resolve_files(ctx, refs):
    rows = ctx.file_rows or build_file_index(ctx.thread.messages)
    ctx.file_rows = rows
    keys, unknown = [], []
    for ref in refs:
        bounds = _number_range(ref)
        if bounds is not None:
            if 1 <= bounds[0] <= bounds[1] <= len(rows):
                keys.extend(row['key'] for row in rows[bounds[0] - 1:bounds[1]])
            else:
                unknown.append(ref)
            continue
        target = normalize_path(ref)
        matches = [row['key'] for row in rows if row['key'] == target or row['key'].endswith('/' + target)]
        if matches:
            keys.extend(matches)
        else:
            unknown.append(ref)
    if unknown:
        joined = ', '.join(unknown)
        con.warn(f'Not in this chat: {escape(joined)}. Run [bold cyan]files[/bold cyan] for the numbers.')
    return keys


def _split_reason(args):
    for flag in REASON_FLAGS:
        if flag in args:
            position = args.index(flag)
            return args[:position], ' '.join(args[position + 1:])
    return args, ''


def _after_files_change(ctx, reports):
    con.print_report(reports)
    ctx.file_rows = build_file_index(ctx.thread.messages)
    ctx.stats['prunes'] += 1
    ctx.save()


def cmd_prune(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    refs, reason = _split_reason(args)
    if not refs:
        con.warn(escape('Usage: prune <n|path|a-b …> [-r reason]'))
        return
    keys = _resolve_files(ctx, refs)
    if keys:
        _after_files_change(ctx, thread.prune(keys, reason, ctx.clock()))


def cmd_restore(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    if not args:
        con.warn(escape('Usage: restore <n|path …|all|manual>'))
        return
    mode = args[0].lower()
    if mode == 'manual' and len(args) == 1:
        _after_files_change(ctx, thread.restore_manual(ctx.clock()))
        return
    if mode == 'all' and len(args) == 1:
        keys = [row['key'] for row in build_file_index(thread.messages) if row['prunedCount']]
        if not keys:
            con.info('No file is pruned.')
            return
    else:
        keys = _resolve_files(ctx, args)
        if not keys:
            return
    _after_files_change(ctx, thread.restore(keys, ctx.clock()))


def cmd_aiprune(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    if not args or args[0].lower() not in ('on', 'off'):
        con.warn(escape('Usage: aiprune <on|off>'))
        return
    _after_files_change(ctx, thread.set_ai_prunes(args[0].lower() == 'on', ctx.clock()))


# ----------------------------------------------------------------------
# Cache and labels
# ----------------------------------------------------------------------

def _clock_text(ms):
    seconds = max(0, int(ms // 1000))
    return f'{seconds // 60}:{seconds % 60:02d}'


def _cache_rows(info):
    if not info['exists']:
        return [('Web chat', 'not started; the next copy is full')]
    upto = info['upto']
    size = format_tokens(info['tokens'])
    rows = [('Web chat', f'{upto} msgs, ≈{size} tokens')]
    if info['warm']:
        left = _clock_text(info['remaining_ms'])
        rows.append(('State', f'[green]warm[/green], {left} left'))
    else:
        rows.append(('State', '[yellow]cold[/yellow]'))
    held = info['held_count']
    if held:
        tokens = format_tokens(info['held_tokens'])
        due = info['due']
        status = f'[yellow]due[/yellow] ({due})' if due else 'held while warm'
        rows.append(('Held prunes', f'{held} (≈{tokens} tokens), {status}'))
    else:
        rows.append(('Held prunes', '0'))
    if info['restored']:
        restored = info['restored']
        rows.append(('Missing from web chat', f'[yellow]{restored} restored file(s)[/yellow]'))
    if info['commit_requested']:
        rows.append(('Flush', 'requested: the next copy is full'))
    return rows


def _print_held(thread, info):
    if not info['held']:
        return
    table = Table(title='Held prunes', border_style='yellow')
    table.add_column('Message', justify='right', style='cyan')
    table.add_column('File')
    table.add_column('Reason', style='dim')
    for index, keys in sorted(info['held'].items()):
        for key, reason in keys.items():
            table.add_row(f'#{index + 1}', escape(key), escape(reason))
    con.show(table)


def cmd_cache(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    info = thread.chat_info(ctx.clock())
    profile = thread.profile
    limit = format_tokens(profile.context_limit)
    table = Table(title=f'Cache · {escape(profile.label)}', border_style='magenta')
    table.add_column('Item', style='bold')
    table.add_column('Value')
    table.add_row('Policy', profile.prune_policy)
    table.add_row('TTL', f'{profile.cache_ttl_seconds}s')
    table.add_row('Context limit', f'{limit} tokens (due at 85%)')
    for name, value in _cache_rows(info):
        table.add_row(name, value)
    con.show(table)
    _print_held(thread, info)


def cmd_flush(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    con.print_report(thread.flush(ctx.clock()))
    ctx.save()


def _set_profile_value(ctx, args, attr, parser, usage, name):
    thread = _need_thread(ctx)
    if thread is None:
        return
    label = escape(thread.label)
    if not args:
        current = getattr(thread.profile, attr)
        con.info(f'{name} for {label} is [bold]{current}[/bold]. Usage: {escape(usage)}')
        return
    try:
        value = parser(' '.join(args))
    except ProfileError as e:
        con.warn(escape(str(e)))
        return
    setattr(thread.profile, attr, value)
    try:
        saved = ctx.store.put(thread.profile)
    except ProfileError as e:
        con.fail(escape(str(e)))
        return
    if not saved:
        con.warn('The change applies now but could not be saved.')
    con.ok(f'{name} for {label} set to [bold green]{value}[/bold green].')


def cmd_policy(ctx, args):
    _set_profile_value(ctx, args, 'prune_policy', parse_policy, 'policy <deferred|immediate>', 'Policy')


def cmd_ttl(ctx, args):
    _set_profile_value(ctx, args, 'cache_ttl_seconds', parse_ttl, 'ttl <seconds|5m|1h>', 'TTL (seconds)')


def cmd_limit(ctx, args):
    _set_profile_value(ctx, args, 'context_limit', parse_limit, 'limit <tokens|200k>', 'Context limit')


def cmd_label(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    if not args:
        current = escape(thread.label)
        con.info(f'Label: [bold cyan]{current}[/bold cyan]. Usage: label <text>, e.g. label Claude (web)')
        return
    try:
        profile = ctx.store.get(ctx.rest)
    except ProfileError as e:
        con.warn(escape(str(e)))
        return
    thread.set_profile(profile)
    thread.forget_copy()
    if not ctx.store.set_last_label(profile.label):
        con.warn('Could not remember the label for next time.')
    ctx.save()
    label = escape(profile.label)
    con.ok(f'Label set to [bold cyan]{label}[/bold cyan] ({profile.prune_policy}, TTL {profile.cache_ttl_seconds}s).')
    if thread.chat() is None:
        con.dim('This label has no web chat for this thread yet, so the next copy is full.')


# ----------------------------------------------------------------------
# Utilities
# ----------------------------------------------------------------------

def cmd_status(ctx, args):
    thread = _need_thread(ctx)
    if thread is None:
        return
    snap = thread.snapshot(ctx.clock())
    profile = thread.profile
    variant = snap['next_variant']
    if variant is None:
        next_text = 'nothing new'
    else:
        count = snap['next_count']
        size = format_tokens(snap['next_tokens'])
        next_text = f'{variant} · {count} msgs · ≈{size} tokens'
    chat_id = escape(snap['id'])
    title = escape(thread.title)
    copied = snap['copied']
    waiting = 'no'
    if snap['awaiting']:
        waiting = f'yes, {copied} copy on the clipboard' if copied else 'yes, not copied yet'
    limit = format_tokens(profile.context_limit)
    table = Table(title='Status', border_style='cyan')
    table.add_column('Item', style='bold')
    table.add_column('Value')
    table.add_row('Chat', f'{title} [dim]({chat_id})[/dim]')
    table.add_row('Label', f'{escape(profile.label)} · {profile.prune_policy} · TTL {profile.cache_ttl_seconds}s · limit {limit}')
    table.add_row('Messages', str(snap['messages']))
    table.add_row('Waiting for reply', waiting)
    table.add_row('Next copy', next_text)
    for name, value in _cache_rows(snap['info']):
        table.add_row(name, value)
    table.add_row('Staged payload', 'yes' if ctx.staging is not None else 'no')
    table.add_row('Editor', escape(editor_name()) or '[yellow]none found (install micro)[/yellow]')
    table.add_row('Tokenizer', escape(tokenizer_name()))
    con.show(table)


def cmd_help(ctx, args):
    table = Table(title='CLI Commands', border_style='blue')
    table.add_column('Command', style='cyan', no_wrap=True)
    table.add_column('Description')
    for usage, description in HELP_ROWS:
        table.add_row(escape(usage), escape(description))
    con.show(table)
    con.dim('A leading / is optional. Press Tab to complete command names.')


def cmd_clear(ctx, args):
    con.console.clear()


HANDLERS = {
    'chat': cmd_chat,
    'chats': cmd_chats,
    'rename': cmd_rename,
    'paste': cmd_paste,
    'say': cmd_say,
    'edit': cmd_edit,
    'staged': cmd_staged,
    'drop': cmd_drop,
    'undrop': cmd_undrop,
    'send': cmd_send,
    'discard': cmd_discard,
    'copy': cmd_copy,
    'swap': cmd_swap,
    'reply': cmd_reply,
    'undo': cmd_undo,
    'show': cmd_show,
    'history': cmd_history,
    'files': cmd_files,
    'prune': cmd_prune,
    'restore': cmd_restore,
    'aiprune': cmd_aiprune,
    'cache': cmd_cache,
    'flush': cmd_flush,
    'policy': cmd_policy,
    'ttl': cmd_ttl,
    'limit': cmd_limit,
    'label': cmd_label,
    'status': cmd_status,
    'help': cmd_help,
    'clear': cmd_clear,
}
COMMAND_WORDS = tuple(sorted(set(HANDLERS) | {'quit'} | set(ALIASES)))


def _normalise(token):
    """Lower-case, strip an optional leading '/', and resolve aliases."""
    name = token.strip().lstrip('/').lower()
    return ALIASES.get(name, name)


def handle_command(ctx, line):
    """Runs one console line. Returns False to leave the console."""
    stripped = line.strip()
    parts = stripped.split()
    if not parts:
        return True
    cmd = _normalise(parts[0])
    if not cmd:
        return True
    if cmd == 'quit':
        return False
    handler = HANDLERS.get(cmd)
    if handler is None:
        con.warn(f'Unknown command {escape(repr(cmd))}. Type [bold cyan]help[/bold cyan] for the list.')
        return True
    ctx.rest = stripped[len(parts[0]):].strip()
    try:
        handler(ctx, parts[1:])
    except Exception as e:  # keep the console alive if a handler hits an unexpected error
        con.fail(f'Command {escape(cmd)} failed: {escape(str(e))}')
    return True
