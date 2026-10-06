"""Configuration, filesystem paths and persisted settings for CombineWebUI."""
import base64
import json
import shutil
import time
from pathlib import Path

from rich.console import Console

console = Console()


class Logger:
    """Level-gated console logger: 1 error, 2 warn, 3 info, 4 debug."""

    def __init__(self):
        self.level = 3

    def _emit(self, threshold, label, args):
        if self.level >= threshold:
            console.print(label, *args)

    def error(self, *args):
        self._emit(1, "[bold red]ERROR[/bold red]:", args)

    def warn(self, *args):
        self._emit(2, "[bold yellow]WARN[/bold yellow]:", args)

    def info(self, *args):
        self._emit(3, "[bold cyan]INFO[/bold cyan]:", args)

    def success(self, *args):
        self._emit(3, "[bold green]SUCCESS[/bold green]:", args)

    def debug(self, *args):
        self._emit(4, "[bold magenta]DEBUG[/bold magenta]:", args)


logger = Logger()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PAGES_DIR = PROJECT_ROOT / "pages"
STATIC_DIR = PAGES_DIR / "static"
SETTINGS_PATH = PROJECT_ROOT / "settings.json"

APP_DIR = Path.home() / ".local" / "share" / "combine-webui"
CHATS_PATH = APP_DIR / "chats.json"
CHATS_DIR = APP_DIR / "chats"
CHATS_INDEX_PATH = CHATS_DIR / "index.json"
CHATS_CONV_DIR = CHATS_DIR / "conversations"

# Data written by copilot-api-py before the web UI was split out. Copied once,
# never moved, so the proxy's own directory is left exactly as it was.
LEGACY_APP_DIR = Path.home() / ".local" / "share" / "copilot-api"
LEGACY_IMPORT_ITEMS = ("chats", "chats.json", "token_counter_cache.json")
LEGACY_IMPORT_MARKER = APP_DIR / ".legacy_import_done"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4142
DEFAULT_NON_STREAM_TIMEOUT = 240

# Upper bound for listing one endpoint's models. Generous enough for a proxy
# that resolves its catalogue lazily on the first request.
CUSTOM_ENDPOINT_MODEL_TIMEOUT = 3.0

COPILOT_DEFAULT_URL = "http://localhost:4141/v1"
COPILOT_DEFAULT_PORT_MARKER = ":4141"
COPILOT_SEED_FLAG = "copilot_endpoint_seeded"

# Keys owned by copilot-api-py before the split. Dropped on load so a copied
# settings.json does not carry dead configuration forward.
LEGACY_SETTINGS_KEYS = ("multipliers", "default", "payload_defaults", "thinking_defaults")

_LOGO_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml"
}
_LOGO_PASSTHROUGH_PREFIXES = ("http://", "https://", "data:")
_LOGO_STATIC_PREFIXES = ("/static/", "static/")
_LOGO_SNIFF_BYTES = 300


class State:
    """Process-wide runtime state. Kept deliberately small."""

    def __init__(self):
        self.models = None
        self.use_proxy_env = False


state = State()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def _default_providers():
    return [
        {"id": "openai", "name": "OpenAI", "keywords": ["gpt", "o1", "o3", "codex", "babbage", "dall-e", "davinci", "text-embedding"], "logo": "https://upload.wikimedia.org/wikipedia/commons/4/4d/OpenAI_Logo.svg"},
        {"id": "anthropic", "name": "Anthropic", "keywords": ["claude", "sonnet", "opus", "haiku"], "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Anthropic_logo.svg/2560px-Anthropic_logo.svg.png"},
        {"id": "google", "name": "Google", "keywords": ["gemini"], "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/1024px-Google_%22G%22_logo.svg.png"}
    ]


def _default_ui_preferences():
    return {
        "hidden_models": [],
        "selected_model": "",
        "auto_name_model": "",
        "preserve_thinking_models": {},
        # One of "dark", "hard" or "light"; validated client-side.
        "theme": "dark",
        "thinking_prefs": {
            "show": True,
            "autoExpand": False,
            "inlineTags": ["think", "thinking", "reasoning"]
        }
    }


def _default_model_pricing():
    return {"currency": "USD", "unit": 1000000, "models": {}}


def default_copilot_endpoint():
    return {
        "name": "Copilot",
        "url": COPILOT_DEFAULT_URL,
        "api_key": "",
        "logo": "",
        "models": [],
        "stream": True
    }


_SETTINGS_FACTORIES = (
    ("providers", _default_providers),
    ("custom_endpoints", list),
    ("ui_preferences", _default_ui_preferences),
    ("model_pricing", _default_model_pricing),
    ("non_stream_timeout", lambda: DEFAULT_NON_STREAM_TIMEOUT)
)


def _default_settings():
    config = {key: factory() for key, factory in _SETTINGS_FACTORIES}
    config["custom_endpoints"] = [default_copilot_endpoint()]
    config[COPILOT_SEED_FLAG] = True
    return config


def save_settings(config):
    if not isinstance(config, dict):
        logger.error("Refusing to save settings: payload is not an object")
        return False
    try:
        SETTINGS_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
        return True
    except OSError as e:
        logger.error(f"Failed to save {SETTINGS_PATH}: {e}")
        return False


def _points_at_copilot(endpoint):
    if not isinstance(endpoint, dict):
        return False
    return COPILOT_DEFAULT_PORT_MARKER in str(endpoint.get("url") or "")


def _seed_copilot_endpoint(config):
    """Adds the local copilot-api endpoint exactly once, so a settings file
    carried over from before the split keeps its Copilot models."""
    if config.get(COPILOT_SEED_FLAG):
        return False
    endpoints = config.get("custom_endpoints")
    if not isinstance(endpoints, list):
        endpoints = []
        config["custom_endpoints"] = endpoints
    if not any(_points_at_copilot(ep) for ep in endpoints):
        endpoints.insert(0, default_copilot_endpoint())
        logger.info(f"Added the local copilot-api endpoint ({COPILOT_DEFAULT_URL}) to settings")
    config[COPILOT_SEED_FLAG] = True
    return True


def _normalize_settings(config):
    """Fills missing sections and drops legacy ones. Returns True if changed."""
    modified = False
    for key, factory in _SETTINGS_FACTORIES:
        if key not in config:
            config[key] = factory()
            modified = True
    for key in LEGACY_SETTINGS_KEYS:
        if key in config:
            config.pop(key)
            modified = True
    if _seed_copilot_endpoint(config):
        modified = True
    return modified


def load_settings():
    if not SETTINGS_PATH.exists():
        config = _default_settings()
        save_settings(config)
        return config
    try:
        config = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        logger.error(f"Failed to load {SETTINGS_PATH}: {e}")
        return _default_settings()
    if not isinstance(config, dict):
        logger.error(f"{SETTINGS_PATH} does not contain a JSON object; using defaults")
        return _default_settings()
    if _normalize_settings(config):
        save_settings(config)
    return config


# ---------------------------------------------------------------------------
# Data directory
# ---------------------------------------------------------------------------

def _import_legacy_item(name):
    """Copies one legacy item. Returns 'copied', 'skipped' or 'failed'."""
    source = LEGACY_APP_DIR / name
    target = APP_DIR / name
    if not source.exists() or target.exists():
        return "skipped"
    try:
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
    except (OSError, shutil.Error) as e:
        logger.warn(f"Could not import {source}: {e}")
        return "failed"
    return "copied"


def import_legacy_data():
    """One-time copy of chat history from copilot-api-py's data directory.

    The marker is only written when every item was copied or skipped, so a
    failed item is retried on the next start rather than silently lost.
    """
    if LEGACY_IMPORT_MARKER.exists() or not LEGACY_APP_DIR.is_dir():
        return 0
    results = [_import_legacy_item(name) for name in LEGACY_IMPORT_ITEMS]
    copied = results.count("copied")
    if "failed" not in results:
        try:
            LEGACY_IMPORT_MARKER.write_text(str(int(time.time())), encoding="utf-8")
        except OSError as e:
            logger.warn(f"Could not write {LEGACY_IMPORT_MARKER}: {e}")
    if copied:
        logger.success(f"Imported {copied} item(s) of chat data from {LEGACY_APP_DIR}")
    return copied


def ensure_paths():
    APP_DIR.mkdir(parents=True, exist_ok=True)
    import_legacy_data()


# ---------------------------------------------------------------------------
# Provider logos
# ---------------------------------------------------------------------------

def _logo_candidates(value):
    relative = value
    for prefix in _LOGO_STATIC_PREFIXES:
        if relative.startswith(prefix):
            relative = relative[len(prefix):]
            break
    return (
        Path(value),
        PROJECT_ROOT / value,
        APP_DIR / value,
        STATIC_DIR / relative,
        STATIC_DIR / "icons" / relative
    )


def _data_uri(content, mime):
    return f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"


def _read_logo_file(path):
    try:
        if not path.is_file():
            return ""
        content = path.read_bytes()
    except (OSError, ValueError) as e:
        logger.debug(f"Skipping logo candidate {path}: {e}")
        return ""
    mime = _LOGO_MIME_BY_SUFFIX.get(path.suffix.lower())
    if mime is None:
        mime = "image/svg+xml" if b"<svg" in content[:_LOGO_SNIFF_BYTES] else "application/octet-stream"
    return _data_uri(content, mime)


def resolve_logo_to_data_uri(logo_value):
    """Turns a URL, raw SVG markup or a local image path into something an
    <img src> can display. Unresolvable values are returned unchanged."""
    if not isinstance(logo_value, str):
        return ""
    value = logo_value.strip()
    if not value or value.startswith(_LOGO_PASSTHROUGH_PREFIXES):
        return value
    if value.startswith(("<svg", "<?xml")):
        return _data_uri(value.encode("utf-8"), "image/svg+xml")
    for candidate in _logo_candidates(value):
        resolved = _read_logo_file(candidate)
        if resolved:
            return resolved
    return value
