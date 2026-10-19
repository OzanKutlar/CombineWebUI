"""Writes prompts in micro (or another terminal editor) inside the current terminal.

The editor gets a temporary file; whatever is saved when it quits becomes the
text. COMBINE_CLI_EDITOR overrides the choice (for example 'nano' or 'vim -n'),
then micro is used, then $VISUAL / $EDITOR.
"""
import os
import shlex
import shutil
import subprocess
import sys
import tempfile

from src.config import logger

EDITOR_ENV = 'COMBINE_CLI_EDITOR'
FALLBACK_ENVS = ('VISUAL', 'EDITOR')
MAX_EDIT_BYTES = 80_000_000
MICRO_HINT = ('Install micro (winget install zyedidia.micro, scoop install micro or brew install micro), '
              'or set COMBINE_CLI_EDITOR to another terminal editor.')
_WINDOWS_MICRO_PATHS = (
    r'%LOCALAPPDATA%\Programs\micro\micro.exe',
    r'%USERPROFILE%\bin\micro.exe',
    r'%USERPROFILE%\go\bin\micro.exe',
    r'%USERPROFILE%\scoop\shims\micro.exe',
    r'C:\Program Files\micro\micro.exe',
    r'C:\ProgramData\chocolatey\bin\micro.exe',
)


class EditorError(RuntimeError):
    """No editor could be started, or it failed."""


def find_micro():
    for name in ('micro', 'micro.exe'):
        found = shutil.which(name)
        if found:
            return found
    if sys.platform == 'win32':
        for raw in _WINDOWS_MICRO_PATHS:
            path = os.path.expandvars(raw)
            if os.path.isfile(path):
                return path
    return None


def _split(command):
    try:
        return shlex.split(command, posix=(os.name != 'nt'))
    except ValueError:
        return []


def resolve_editor():
    """The editor command as an argument list, or None when none is available."""
    override = os.environ.get(EDITOR_ENV, '').strip()
    if override:
        return _split(override) or None
    micro = find_micro()
    if micro:
        return [micro]
    for env in FALLBACK_ENVS:
        parts = _split(os.environ.get(env, '').strip())
        if parts:
            return parts
    return None


def editor_name():
    command = resolve_editor()
    return os.path.basename(command[0]) if command else ''


def _write_temp(initial, suffix):
    handle, path = tempfile.mkstemp(prefix='combine-prompt-', suffix=suffix)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8', newline='') as f:
            f.write(initial)
    except OSError:
        _remove(path)
        raise
    return path


def _remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        return
    except OSError as e:
        logger.warn(f'Could not remove the temporary file {path}: {e}')


def _run_and_read(command, path):
    try:
        result = subprocess.run(command + [path])
    except (OSError, ValueError) as e:
        raise EditorError(f'Could not start {command[0]}: {e}. {MICRO_HINT}') from e
    name = os.path.basename(command[0])
    if result.returncode != 0:
        raise EditorError(f'{name} exited with code {result.returncode}; the text was not used.')
    try:
        if os.path.getsize(path) > MAX_EDIT_BYTES:
            raise EditorError('The saved file is too large to use as a prompt.')
        with open(path, 'r', encoding='utf-8', errors='replace', newline='') as f:
            text = f.read()
    except OSError as e:
        raise EditorError(f'Could not read the saved text: {e}') from e
    return text.rstrip('\r\n')


def edit_text(initial='', suffix='.md'):
    """Opens initial in the editor and returns the saved text, trailing newlines trimmed.

    Raises EditorError when no editor exists, it fails to start, or exits non-zero.
    """
    command = resolve_editor()
    if not command:
        raise EditorError(f'No terminal editor found. {MICRO_HINT}')
    try:
        path = _write_temp(initial if isinstance(initial, str) else '', suffix)
    except OSError as e:
        raise EditorError(f'Could not create a temporary file: {e}') from e
    try:
        return _run_and_read(command, path)
    finally:
        _remove(path)
