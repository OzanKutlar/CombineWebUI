"""CombineWebUI command line entry point."""
import argparse
import asyncio
import json
import sys

import uvicorn
from rich.panel import Panel
from rich.table import Table

from src.config import DEFAULT_HOST, DEFAULT_PORT, console, ensure_paths, logger, state

VERBOSE_LOG_LEVEL = 4
MIN_PORT = 1
MAX_PORT = 65535
DASH = "\u2014"

PROVIDER_COLUMNS = (
    ("Provider", "bold"),
    ("Input Tokens", "cyan"),
    ("Output Tokens", "green"),
    ("Total Tokens", "bold yellow"),
    ("Cost", "magenta"),
    ("Saved", "blue"),
    ("Turns", "dim")
)
MODEL_COLUMNS = (
    ("Model ID", "bold"),
    ("Provider", "dim"),
    ("Input Tokens", "cyan"),
    ("Output Tokens", "green"),
    ("Total Tokens", "bold yellow"),
    ("Cost", "magenta"),
    ("Saved", "blue"),
    ("Turns", "dim")
)
TEXT_COLUMNS = ("Provider", "Model ID")


def _port(value):
    port = int(value)
    if port < MIN_PORT or port > MAX_PORT:
        raise argparse.ArgumentTypeError(f"port must be between {MIN_PORT} and {MAX_PORT}")
    return port


def _configure_logging(verbose):
    if verbose:
        logger.level = VERBOSE_LOG_LEVEL
        logger.info("Verbose logging enabled")


async def _warm_model_cache():
    from src.endpoints import cache_models
    try:
        models = await cache_models()
    except Exception as e:
        logger.error(f"Failed to load models from endpoints: {e}")
        return
    if not models:
        logger.warn("No models available yet. Start copilot-api or add an endpoint in Settings.")
        return
    listing = "\n".join(f"- {m.get('id')}" for m in models)
    logger.info(f"Available models:\n{listing}")


def cmd_start(args):
    _configure_logging(args.verbose)
    state.use_proxy_env = bool(args.proxy_env)
    ensure_paths()
    asyncio.run(_warm_model_cache())

    from src.server import app
    shown_host = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    console.print(f"\n[bold green]CombineWebUI[/bold green] is running at http://{shown_host}:{args.port}/\n")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info" if args.verbose else "warning")


def _money(value, has_price, currency):
    from src.token_counter import format_money
    # A dash rather than zero: zero would read as "free", not "no rate set".
    return format_money(value, currency) if has_price else DASH


def _count_or_dash(value):
    return f"{value:,}" if value and value > 0 else DASH


def _new_table(title, header_style, columns):
    table = Table(title=title, header_style=header_style)
    for label, style in columns:
        table.add_column(label, style=style, justify="left" if label in TEXT_COLUMNS else "right")
    return table


def _provider_table(stats, currency):
    table = _new_table("Token Usage by Provider", "bold cyan", PROVIDER_COLUMNS)
    for p in stats.get("by_provider", []):
        cost = p.get("cost", 0.0) or 0.0
        table.add_row(
            str(p.get("name", "")),
            f"{p.get('input_tokens', 0):,}",
            f"{p.get('output_tokens', 0):,}",
            f"{p.get('total_tokens', 0):,}",
            _money(cost, cost > 0, currency),
            _count_or_dash(p.get("saved_tokens", 0)),
            f"{p.get('turns', 0):,}"
        )
    return table


def _model_table(stats, currency):
    table = _new_table("Token Usage by Model", "bold magenta", MODEL_COLUMNS)
    for m in stats.get("by_model", []):
        table.add_row(
            str(m.get("model_id", "")),
            str(m.get("provider_name", "")),
            f"{m.get('input_tokens', 0):,}",
            f"{m.get('output_tokens', 0):,}",
            f"{m.get('total_tokens', 0):,}",
            _money(m.get("cost", 0.0), m.get("has_price", False), currency),
            _count_or_dash(m.get("saved_tokens", 0)),
            f"{m.get('turns', 0):,}"
        )
    return table


def _summary_lines(stats, currency):
    totals = stats.get("totals", {})
    models = stats.get("by_model", [])
    cache = stats.get("cache", {})
    priced = sum(1 for m in models if m.get("has_price"))

    lines = [
        f"[bold]Total Tokens:[/bold] {totals.get('total_tokens', 0):,}  |  "
        f"[bold cyan]Input:[/bold cyan] {totals.get('input_tokens', 0):,}  |  "
        f"[bold green]Output:[/bold green] {totals.get('output_tokens', 0):,}"
    ]
    if priced > 0:
        lines.append(
            f"[bold magenta]Estimated Cost:[/bold magenta] {_money(totals.get('cost', 0.0), True, currency)}  |  "
            f"[dim]{priced} of {len(models)} models priced[/dim]"
        )
    else:
        lines.append("[dim]No model prices configured; set rates in the web UI's Pricing tab[/dim]")
    lines.append(f"[dim]Scanned {totals.get('conversations', 0):,} conversations ({totals.get('turns', 0):,} assistant turns)[/dim]")
    saved = totals.get("saved_tokens", 0) or 0
    if saved > 0:
        lines.append(f"[dim]Pruning kept {saved:,} context tokens off the bill[/dim]")
    lines.append(
        f"[dim]Cache: {cache.get('hits', 0):,} reused, {cache.get('misses', 0):,} recounted, "
        f"finished in {cache.get('elapsed_seconds', 0):.2f}s[/dim]"
    )
    return lines


def cmd_token_counter(args):
    from src.token_counter import TOKEN_CACHE_PATH, calculate_all_chat_tokens, clear_token_cache
    ensure_paths()

    if args.clear_cache:
        if not clear_token_cache():
            sys.exit(1)
        logger.success(f"Token counter cache cleared ({TOKEN_CACHE_PATH})")
        return

    try:
        stats = calculate_all_chat_tokens(force=args.refresh)
    except Exception as e:
        logger.error(f"Failed to tally chat tokens: {e}")
        sys.exit(1)

    if args.json:
        print(json.dumps(stats, indent=2))
        return

    currency = stats.get("pricing", {}).get("currency", "USD")
    console.print("\n[bold green]Chat Log Token Counter Summary[/bold green]")
    console.print(Panel("\n".join(_summary_lines(stats, currency)), expand=False))
    console.print(_provider_table(stats, currency))
    console.print(_model_table(stats, currency))


def build_parser():
    parser = argparse.ArgumentParser(description="CombineWebUI: a chat UI for OpenAI-compatible endpoints")
    subparsers = parser.add_subparsers(dest="command", required=True)

    start_p = subparsers.add_parser("start", help="Start the web UI server")
    start_p.add_argument("--host", default=DEFAULT_HOST, help="Host to listen on")
    start_p.add_argument("-p", "--port", type=_port, default=DEFAULT_PORT, help="Port to listen on")
    start_p.add_argument("-v", "--verbose", action="store_true", help="Enable verbose logging")
    start_p.add_argument("--proxy-env", action="store_true", help="Honour HTTP_PROXY / HTTPS_PROXY for upstream calls")

    token_p = subparsers.add_parser("token-counter", help="Tally tokens from chat logs by model and provider")
    token_p.add_argument("--json", action="store_true", help="Output stats as JSON")
    token_p.add_argument("--refresh", action="store_true", help="Ignore the cache and re-tokenize every conversation")
    token_p.add_argument("--clear-cache", action="store_true", help="Delete the token counter cache file and exit")
    return parser


COMMANDS = {
    "start": cmd_start,
    "token-counter": cmd_token_counter
}


def main():
    args = build_parser().parse_args()
    COMMANDS[args.command](args)


if __name__ == "__main__":
    main()
