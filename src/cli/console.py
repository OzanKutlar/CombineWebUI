"""Console helpers in the Translator style. Shares the Rich console with src.config."""
import threading

from rich.panel import Panel
from rich.rule import Rule

from src.config import console

_lock = threading.RLock()


def ok(message):
    with _lock:
        console.print(f'[green]✔[/green] {message}')


def info(message):
    with _lock:
        console.print(f'[cyan]ℹ[/cyan] {message}')


def warn(message):
    with _lock:
        console.print(f'[yellow]⚠[/yellow] {message}')


def fail(message):
    with _lock:
        console.print(f'[bold red]✘[/bold red] {message}')


def dim(message):
    with _lock:
        console.print(f'[dim]{message}[/dim]')


def rule(title=''):
    with _lock:
        console.print(Rule(f'[bold blue]{title}[/bold blue]' if title else ''))


def banner(title, subtitle=''):
    text = f'[bold]{title}[/bold]'
    if subtitle:
        text += f'\n[dim]{subtitle}[/dim]'
    with _lock:
        console.print(Panel(text, border_style='blue'))


def panel(message, title='', style='green'):
    with _lock:
        console.print(Panel(message, title=title or None, border_style=style))


def show(renderable):
    with _lock:
        console.print(renderable)


_REPORT_PRINTERS = {'ok': ok, 'info': info, 'warn': warn, 'fail': fail, 'dim': dim}


def print_report(report):
    """Prints (level, message) pairs returned by the workflow."""
    for level, message in report or []:
        _REPORT_PRINTERS.get(level, info)(message)
