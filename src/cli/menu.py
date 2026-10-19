"""Arrow-key picker adapted from Translator's booktl/menu.py.

Raises MenuUnavailable when there is no real terminal (piped input, some IDE
consoles) or prompt_toolkit is missing, so callers fall back to a numbered list.
"""
import sys

try:
    from prompt_toolkit.application import Application
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout import HSplit, Layout, Window
    from prompt_toolkit.layout.controls import FormattedTextControl
    from prompt_toolkit.styles import Style
    HAS_PROMPT_TOOLKIT = True
except ImportError:
    HAS_PROMPT_TOOLKIT = False

VISIBLE_ROWS = 15
PAGE_JUMP = 10
FOOTER = '↑/↓ move · PgUp/PgDn jump · Enter select · Esc cancel'


class MenuUnavailable(RuntimeError):
    """The interactive menu cannot run in this environment."""


def is_interactive():
    """True when prompt_toolkit is installed and stdin/stdout are real terminals."""
    if not HAS_PROMPT_TOOLKIT:
        return False
    try:
        return bool(sys.stdin and sys.stdin.isatty() and sys.stdout and sys.stdout.isatty())
    except (AttributeError, ValueError):
        return False


class _MenuState:
    """Cursor position and scroll window."""

    def __init__(self, count, default_index):
        self.count = count
        self.index = default_index if isinstance(default_index, int) and 0 <= default_index < count else 0
        self.top = 0
        self._scroll()

    def move(self, delta, wrap=True):
        if wrap:
            self.index = (self.index + delta) % self.count
        else:
            self.index = max(0, min(self.count - 1, self.index + delta))
        self._scroll()

    def _scroll(self):
        if self.index < self.top:
            self.top = self.index
        elif self.index >= self.top + VISIBLE_ROWS:
            self.top = self.index - VISIBLE_ROWS + 1


def _render(title, labels, hints, state):
    fragments = [('class:title', f' {title}\n')]
    end = min(state.count, state.top + VISIBLE_ROWS)
    scrolling = state.count > VISIBLE_ROWS
    if scrolling:
        fragments.append(('class:dim', '   ↑ more\n' if state.top > 0 else '\n'))
    for index in range(state.top, end):
        if index == state.index:
            fragments += [('class:pointer', ' ❯ '), ('class:selected', labels[index])]
        else:
            fragments += [('', '   '), ('', labels[index])]
        if hints[index]:
            fragments.append(('class:hint', f'  {hints[index]}'))
        fragments.append(('', '\n'))
    if scrolling:
        fragments.append(('class:dim', '   ↓ more\n' if end < state.count else '\n'))
    fragments.append(('class:dim', f' {state.index + 1}/{state.count} · {FOOTER}'))
    return fragments


def _bindings(state):
    kb = KeyBindings()

    @kb.add('up')
    def _up(event):
        state.move(-1)

    @kb.add('down')
    def _down(event):
        state.move(1)

    @kb.add('pageup')
    def _page_up(event):
        state.move(-PAGE_JUMP, wrap=False)

    @kb.add('pagedown')
    def _page_down(event):
        state.move(PAGE_JUMP, wrap=False)

    @kb.add('enter')
    def _select(event):
        event.app.exit(result=state.index)

    @kb.add('escape', eager=True)
    @kb.add('c-c')
    def _cancel(event):
        event.app.exit(result=None)

    return kb


def _style():
    return Style.from_dict({
        'title': 'bold ansicyan',
        'pointer': 'bold ansicyan',
        'selected': 'reverse bold',
        'hint': 'ansibrightblack',
        'dim': 'ansibrightblack',
    })


def select_option(title, options, hints=None, default_index=0):
    """Shows the menu and returns the chosen index, or None when cancelled or empty.

    Raises MenuUnavailable when no interactive terminal is available.
    """
    if not options:
        return None
    labels = [str(option) for option in options]
    hint_list = [str(hint or '') for hint in (hints if hints is not None else [''] * len(labels))]
    if len(hint_list) != len(labels):
        raise ValueError('hints must have the same length as options')
    if not is_interactive():
        raise MenuUnavailable('no interactive terminal')
    state = _MenuState(len(labels), default_index)
    control = FormattedTextControl(lambda: _render(str(title), labels, hint_list, state),
                                   focusable=True, show_cursor=False)
    window = Window(content=control, dont_extend_height=True, always_hide_cursor=True)
    app = Application(layout=Layout(HSplit([window])), key_bindings=_bindings(state), style=_style(),
                      full_screen=False, mouse_support=False, erase_when_done=True)
    try:
        result = app.run()
    except Exception as e:  # any terminal start-up failure -> the caller's numbered fallback
        raise MenuUnavailable(f'{type(e).__name__}: {e}') from e
    return result if isinstance(result, int) else None
