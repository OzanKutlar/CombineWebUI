"""Shared helpers: HTTP errors, defensive JSON parsing and tokenization."""
import tiktoken

FALLBACK_ENCODING = "cl100k_base"
MESSAGE_OVERHEAD_TOKENS = 4
REPLY_PRIMING_TOKENS = 3
MAX_COUNTED_MESSAGES = 20000


class HTTPError(Exception):
    """An error that maps directly onto an HTTP response."""

    def __init__(self, message, status_code=500, data=None):
        super().__init__(message)
        valid = isinstance(status_code, int) and 400 <= status_code <= 599
        self.status_code = status_code if valid else 502
        if isinstance(data, dict):
            self.data = data
        else:
            self.data = {"error": {"message": str(message), "type": "error"}}


def safe_json(resp, default=None):
    """Parses a response body without ever raising. Unparseable bodies come
    back wrapped as {"raw": ..., "status_code": ...}."""
    if resp is None:
        return default
    text = getattr(resp, "text", "")
    if not text or not text.strip():
        return default
    try:
        return resp.json()
    except ValueError:
        return {"raw": text, "status_code": getattr(resp, "status_code", None)}


class SafeEncoder:
    """tiktoken wrapper that never rejects special-token text found in chats."""

    def __init__(self, encoding):
        self._encoding = encoding
        self.name = getattr(encoding, "name", FALLBACK_ENCODING)

    def encode(self, text, *args, **kwargs):
        if not isinstance(text, str):
            text = str(text)
        kwargs.setdefault("disallowed_special", ())
        return self._encoding.encode(text, *args, **kwargs)


def get_tokenizer(model_name):
    try:
        encoding = tiktoken.encoding_for_model(str(model_name or ""))
    except KeyError:
        encoding = tiktoken.get_encoding(FALLBACK_ENCODING)
    return SafeEncoder(encoding)


def _flatten_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [p.get("text") for p in content if isinstance(p, dict)]
        return "\n".join(t for t in parts if isinstance(t, str))
    return ""


def count_messages_tokens(messages, model_name):
    """Approximate prompt size of an OpenAI-style messages array."""
    if not isinstance(messages, list) or not messages:
        return 0
    encoder = get_tokenizer(model_name)
    total = REPLY_PRIMING_TOKENS
    for message in messages[:MAX_COUNTED_MESSAGES]:
        if not isinstance(message, dict):
            continue
        total += MESSAGE_OVERHEAD_TOKENS
        text = _flatten_content(message.get("content"))
        if text:
            total += len(encoder.encode(text))
    return total
