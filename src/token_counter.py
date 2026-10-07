import json
import time
import itertools
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor

from src.config import (
    APP_DIR,
    load_settings,
    resolve_logo_to_data_uri,
    logger,
    state
)
from src.utils import get_tokenizer
from src.history import get_all_history, atomic_write_json

# Bumping this invalidates every cached entry at once. Change it whenever the
# counting logic or the cached shape changes, otherwise stale numbers survive
# an upgrade. Version 2 introduced per-day bucketing; version 3 switched to a
# billed estimate that counts each message in the form it had at the time;
# version 4 also counts responses on inactive branches of the message tree;
# version 5 bills the prune forms each turn recorded as actually sent.
TOKEN_CACHE_VERSION = 5
TOKEN_CACHE_PATH = APP_DIR / "token_counter_cache.json"

# tiktoken encodes in Rust and releases the GIL, so a small pool is a real
# speedup. Bounded so a huge backlog cannot exhaust threads.
MAX_COUNT_WORKERS = 4
PROGRESS_LOG_EVERY = 25

# Overhead the API adds when priming the assistant's reply.
ASSISTANT_PRIMING_TOKENS = 3

# Per-message envelope: the structural tokens plus the role name. Replaces the
# old approach of encoding every string-valued key on the stored object, which
# swept up bookkeeping fields that never reach the API.
MESSAGE_OVERHEAD_TOKENS = 4

# Opening and closing <think> tags that `buildReplayHistory` wraps a preserved
# trace in, plus the blank line separating it from the visible content.
REPLAY_TAG_TOKENS = 6

# Message tree bounds. A fork's alternatives live on the assistant slot as
# `variants`; each inactive one holds its own response fields plus a `tail` of
# the messages that followed it, which may fork again.
MAX_BRANCH_DEPTH = 64
MAX_BRANCH_PATHS = 512
_VARIANT_META_KEYS = frozenset(("vid", "tail", "variants", "activeVariant"))

# Prices are expressed per this many tokens, matching how every major provider
# publishes them. Kept here so the frontend and backend cannot disagree.
PRICE_UNIT = 1000000

# Mirrors the map in tokenCounterModal.js. Anything unlisted falls back to a
# trailing currency code rather than guessing at a symbol.
CURRENCY_SYMBOLS = {
    "USD": "$",
    "EUR": "\u20ac",
    "GBP": "\u00a3",
    "JPY": "\u00a5",
    "AUD": "A$",
    "CAD": "C$"
}

# Bucket key for turns whose date could not be resolved at all. They still
# count toward all-time totals but are excluded from the daily series, which is
# far better than attributing them to the epoch and skewing every chart.
UNDATED_KEY = ""

_encoder_lock = threading.Lock()
_encoder_cache = {}


def _resolve_encoder(model_id: str):
    """Returns (encoding_name, encoder) for a model, memoized across runs.

    Guarded by a lock because changed conversations are counted in a thread
    pool and would otherwise race on first population.
    """
    key = model_id or "unknown"
    with _encoder_lock:
        cached = _encoder_cache.get(key)
    if cached is not None:
        return cached

    try:
        encoder = get_tokenizer(key)
    except Exception:
        encoder = get_tokenizer("gpt-4o")

    name = getattr(encoder, "name", None) or "cl100k_base"
    entry = (name, encoder)
    with _encoder_lock:
        _encoder_cache[key] = entry
    return entry


def _match_configured_provider(model_lower: str, providers: list):
    """Keyword match against the configured picture groups.

    Checked before custom endpoints on purpose: a model whose id matches a
    provider grouping belongs under that provider's logo regardless of which
    local endpoint happens to be serving it.
    """
    for p in providers:
        if not isinstance(p, dict):
            continue
        p_id = p.get("id", "other")
        if p_id == "other":
            continue
        for kw in (p.get("keywords") or []):
            if not kw:
                continue
            if str(kw).lower() in model_lower:
                return {
                    "id": p_id,
                    "name": p.get("name", str(p_id).capitalize()),
                    "logo": resolve_logo_to_data_uri(p.get("logo", "")),
                    "is_custom": False
                }
    return None


def _match_custom_endpoint(model_id: str, model_lower: str, custom_eps: list):
    for ep in custom_eps:
        if not isinstance(ep, dict):
            continue
        ep_name = ep.get("name", "Custom")
        ep_models = ep.get("models", [])
        if isinstance(ep_models, str):
            ep_models = [m.strip() for m in ep_models.split(",") if m.strip()]
        if not isinstance(ep_models, list):
            ep_models = []

        matches_listed = any(
            isinstance(m, str) and (m.lower() == model_lower or m.lower() in model_lower)
            for m in ep_models
        )
        if matches_listed or f"({str(ep_name).lower()})" in model_lower:
            return {
                "id": str(ep_name).lower().replace(" ", "_"),
                "name": ep_name,
                "logo": resolve_logo_to_data_uri(ep.get("logo", "")),
                "is_custom": True
            }

    if state.models:
        for m in state.models.get("data", []):
            if not isinstance(m, dict):
                continue
            if m.get("id") != model_id and m.get("_raw_model_id") != model_id:
                continue
            ep = m.get("_custom_endpoint")
            if isinstance(ep, dict):
                ep_name = ep.get("name", "Custom")
                return {
                    "id": str(ep_name).lower().replace(" ", "_"),
                    "name": ep_name,
                    "logo": resolve_logo_to_data_uri(ep.get("logo", "")),
                    "is_custom": True
                }
    return None


def resolve_model_provider(model_id: str, settings: dict) -> dict:
    """Resolves the provider id, display name, and logo data for any model ID.

    Resolution order matches the /v1/models endpoint: configured provider
    keywords first, then the custom endpoint that serves the model, then
    coarse prefix heuristics. Deliberately never cached alongside token
    counts, so renaming a provider or editing its keywords takes effect on the
    next read without forcing a full recount.
    """
    model_lower = (model_id or "").lower()

    matched = _match_configured_provider(model_lower, settings.get("providers", []))
    if matched:
        return matched

    matched = _match_custom_endpoint(model_id, model_lower, settings.get("custom_endpoints", []))
    if matched:
        return matched

    if "claude" in model_lower or "anthropic" in model_lower:
        return {"id": "anthropic", "name": "Anthropic", "logo": "", "is_custom": False}
    if "gpt" in model_lower or "o1" in model_lower or "o3" in model_lower or "openai" in model_lower:
        return {"id": "openai", "name": "OpenAI", "logo": "", "is_custom": False}
    if "gemini" in model_lower or "google" in model_lower:
        return {"id": "google", "name": "Google", "logo": "", "is_custom": False}

    return {"id": "other", "name": "Other", "logo": "", "is_custom": False}


def _conversation_fallback_ts(conv: dict) -> int:
    """Best available creation time for a conversation, in epoch milliseconds.

    Prefers the id, which encodes creation time and never changes, over
    `updatedAt`, which moves on every save. Used to date turns written before
    messages carried their own `ts`.
    """
    cid = str(conv.get("id") or "")
    if cid.startswith("conv_"):
        head = cid[5:].split("_")[0]
        if head.isdigit():
            val = int(head)
            if val > 0:
                return val

    updated = conv.get("updatedAt")
    if isinstance(updated, (int, float)) and updated > 0:
        return int(updated)
    return 0


def _message_timestamp(msg: dict, fallback_ms: int) -> int:
    raw = msg.get("ts")
    if isinstance(raw, (int, float)) and raw > 0:
        return int(raw)
    return fallback_ms


def _day_key(ms: int) -> str:
    """Local-time YYYY-MM-DD bucket, or UNDATED_KEY when there is no date."""
    if not ms or ms <= 0:
        return UNDATED_KEY
    try:
        return time.strftime("%Y-%m-%d", time.localtime(ms / 1000.0))
    except (ValueError, OverflowError, OSError):
        return UNDATED_KEY


def _pricing_config(settings: dict) -> dict:
    """Validated pricing map. Entries priced at zero on both sides are dropped
    so an untouched row never looks like a deliberate free model."""
    raw = settings.get("model_pricing")
    if not isinstance(raw, dict):
        raw = {}

    models = raw.get("models")
    if not isinstance(models, dict):
        models = {}

    clean = {}
    for model_id, entry in models.items():
        if not isinstance(entry, dict):
            continue
        try:
            inp = float(entry.get("input", 0) or 0)
            out = float(entry.get("output", 0) or 0)
        except (TypeError, ValueError):
            continue
        if inp <= 0 and out <= 0:
            continue
        clean[str(model_id)] = {"input": inp, "output": out}

    return {
        "currency": str(raw.get("currency") or "USD"),
        "unit": PRICE_UNIT,
        "models": clean
    }


def format_money(value, currency: str = "USD") -> str:
    """Formats a cost for display, matching the web UI's tiered precision.

    Small per-model costs would round to nothing at two decimals, so precision
    scales with magnitude. Shared with the CLI so the two surfaces cannot drift
    apart on how the same figure reads.
    """
    try:
        amount = float(value or 0.0)
    except (TypeError, ValueError):
        amount = 0.0

    magnitude = abs(amount)
    if magnitude >= 100:
        body = f"{amount:.2f}"
    elif magnitude >= 1:
        body = f"{amount:.3f}"
    else:
        body = f"{amount:.4f}"

    symbol = CURRENCY_SYMBOLS.get(str(currency or "USD").upper())
    return f"{symbol}{body}" if symbol else f"{body} {currency}"


def _cost_for(input_tokens: int, output_tokens: int, price) -> float:
    if not isinstance(price, dict):
        return 0.0
    inp_rate = float(price.get("input", 0.0) or 0.0)
    out_rate = float(price.get("output", 0.0) or 0.0)
    return (input_tokens / PRICE_UNIT) * inp_rate + (output_tokens / PRICE_UNIT) * out_rate


def _project_message(msg: dict, depth: int) -> dict:
    """Token-relevant projection of one message, including any stashed
    alternatives, so adding or switching a response invalidates the cache."""
    info = msg.get("pruneInfo")
    prune_targets = info.get("targetIndices") if isinstance(info, dict) else None
    projection = {
        "role": msg.get("role"),
        "model": msg.get("model"),
        "isError": bool(msg.get("isError")),
        "ts": msg.get("ts"),
        "content": msg.get("content"),
        "originalContent": msg.get("originalContent"),
        "prunedContent": msg.get("prunedContent"),
        "reasoning": msg.get("reasoning"),
        "pruneTargets": prune_targets,
        "sentPrunedIdx": msg.get("sentPrunedIdx")
    }

    variants = msg.get("variants")
    if isinstance(variants, list) and variants and depth < MAX_BRANCH_DEPTH:
        projection["activeVariant"] = msg.get("activeVariant")
        projection["variants"] = [
            _project_variant(v, depth + 1) for v in variants if isinstance(v, dict)
        ]
    return projection


def _project_variant(variant: dict, depth: int) -> dict:
    projection = _project_message(variant, depth)
    tail = variant.get("tail")
    if isinstance(tail, list):
        projection["tail"] = [_project_message(t, depth) for t in tail if isinstance(t, dict)]
    return projection


def _conversation_fingerprint(conv: dict, preserve_key: str = "") -> str:
    """SHA-256 over only the token-relevant projection of a conversation.

    Volatile fields (title, folderId, reasoningExpanded, derived
    executionInfo) are excluded on purpose: none of them change the token
    count. The message `ts` and the conversation fallback timestamp are
    included, because both change which day bucket a turn lands in.

    The alternate content forms and `pruneInfo.targetIndices` are included
    because the billed estimate reads all of them, and `preserve_key` because
    toggling thinking preservation changes what is replayed into context.
    """
    h = hashlib.sha256()
    h.update(str(TOKEN_CACHE_VERSION).encode("utf-8"))
    h.update(b"\x1d")
    h.update(preserve_key.encode("utf-8"))
    h.update(b"\x1d")
    h.update(str(_conversation_fallback_ts(conv)).encode("utf-8"))
    h.update(b"\x1d")

    messages = conv.get("messages") if isinstance(conv, dict) else None
    if not isinstance(messages, list):
        messages = []

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        projection = _project_message(msg, 0)
        encoded = json.dumps(projection, sort_keys=True, ensure_ascii=False, default=str)
        h.update(encoded.encode("utf-8"))
        # Record separator, so two adjacent messages cannot hash the same as
        # one concatenated message.
        h.update(b"\x1e")

    return h.hexdigest()


def _load_cache() -> dict:
    if not TOKEN_CACHE_PATH.exists():
        return {}
    try:
        raw = json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warn(f"[Token Counter] Cache unreadable, rebuilding from scratch: {e}")
        return {}

    if not isinstance(raw, dict) or raw.get("version") != TOKEN_CACHE_VERSION:
        return {}

    entries = raw.get("conversations")
    return entries if isinstance(entries, dict) else {}


def _save_cache(entries: dict) -> None:
    payload = {"version": TOKEN_CACHE_VERSION, "conversations": entries}
    if not atomic_write_json(TOKEN_CACHE_PATH, payload):
        logger.warn("[Token Counter] Failed to persist cache; the next run will recount everything.")


def clear_token_cache() -> bool:
    try:
        if TOKEN_CACHE_PATH.exists():
            TOKEN_CACHE_PATH.unlink()
        return True
    except Exception as e:
        logger.error(f"[Token Counter] Failed to clear cache: {e}")
        return False


def _preserve_models(settings: dict) -> frozenset:
    """Model ids whose stored reasoning is replayed back into later context.

    Mirrors `isPreserveEnabled` on the frontend: an absent key means off, so
    preservation is opt-in and the default costs nothing.
    """
    prefs = settings.get("ui_preferences")
    if not isinstance(prefs, dict):
        return frozenset()
    raw = prefs.get("preserve_thinking_models")
    if not isinstance(raw, dict):
        return frozenset()
    return frozenset(str(k) for k, v in raw.items() if v is True)


def _preserve_key(preserve_models: frozenset) -> str:
    """Stable digest of the preserve set, folded into every cache fingerprint.

    Toggling preservation changes what actually reaches the API, so it has to
    invalidate cached counts rather than silently leaving them stale.
    """
    return "|".join(sorted(preserve_models))


def _coerce_text(value) -> str:
    """Flattens a content field to plain text. Stored messages are almost always
    strings, but a multimodal list is tolerated rather than dropped."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for part in value:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(parts)
    return ""


def _context_text(msg: dict, pruned_form: bool) -> str:
    """The text this message contributed to context at a given point in time.

    A user message carries up to three forms. `originalContent` is the pristine
    baseline, `prunedContent` is baseline plus the model's prunes only, and
    `content` is the live state with manual prunes merged in. Manual prunes are
    deliberately excluded from both historical forms: they were applied after
    the fact and never reduced a bill that had already been paid.
    """
    if msg.get("role") != "user":
        return _coerce_text(msg.get("content"))

    order = ("prunedContent", "content") if pruned_form else ("originalContent", "content")
    for key in order:
        text = _coerce_text(msg.get(key))
        if text:
            return text
    return ""


def _context_tokens(msg: dict, pruned_form: bool, encoder, preserve_models: frozenset) -> int:
    """Tokens this message costs as *context* on some later turn.

    Counts only what `buildReplayHistory` actually sends: the envelope, the
    content, and a reasoning trace when that model has thinking preservation
    enabled. Stored bookkeeping fields are never included.
    """
    total = MESSAGE_OVERHEAD_TOKENS

    text = _context_text(msg, pruned_form)
    if text:
        total += len(encoder.encode(text))

    if msg.get("role") == "assistant" and preserve_models:
        model_id = msg.get("model")
        if model_id and str(model_id) in preserve_models:
            trace = msg.get("reasoning")
            if isinstance(trace, str) and trace.strip():
                total += len(encoder.encode(trace.strip())) + REPLAY_TAG_TOKENS

    return total


def _is_index(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _payload_targets(msg: dict, idx: int) -> list:
    """User indices a PRUNE payload on this assistant turn rewrote."""
    info = msg.get("pruneInfo")
    if not isinstance(info, dict):
        return []
    targets = info.get("targetIndices")
    if not isinstance(targets, list):
        legacy = info.get("userMsgIndex")
        targets = [legacy] if isinstance(legacy, int) and legacy > -1 else []
    return [t for t in targets if _is_index(t) and t < idx]


def _recorded_targets(msg: dict, idx: int):
    """User indices this turn was actually sent in pruned form, or None when
    the turn predates send-time recording."""
    raw = msg.get("sentPrunedIdx")
    if not isinstance(raw, list):
        return None
    return [t for t in raw if _is_index(t) and t < idx]


def _first_recorded_turn(messages: list):
    for idx, msg in enumerate(messages):
        if isinstance(msg, dict) and msg.get("role") == "assistant" and isinstance(msg.get("sentPrunedIdx"), list):
            return idx
    return None


def _prune_boundaries(messages: list) -> list:
    """(first_turn, user_index) pairs, sorted by first_turn: from assistant turn
    `first_turn` onward, that user message counts in its pruned form.

    Turns that recorded `sentPrunedIdx` say exactly what was sent, which is what
    bills cache-deferred prunes correctly: the prune applies from the turn it
    actually went out, not the turn that requested it. Older turns fall back to
    the PRUNE payload, applied from the turn after it, since the turn that
    emitted it still saw the full context. Payload prunes at or after the first
    recorded turn are skipped, because the recorded turns already cover them.

    `pruneInfo.isPruned` is ignored on purpose, because re-adding files now
    cannot un-bill a request that already went out.

    Only the earliest prune per message is recorded. A message pruned in
    stages, or restored after being sent pruned, is counted in its stub form
    from the first prune onward, which slightly understates those turns.
    """
    first_recorded = _first_recorded_turn(messages)
    pending = []
    seen = set()

    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict) or msg.get("role") != "assistant" or msg.get("isError"):
            continue

        recorded = _recorded_targets(msg, idx)
        if recorded is not None:
            first_turn, targets = idx, recorded
        elif first_recorded is None or idx < first_recorded:
            first_turn, targets = idx + 1, _payload_targets(msg, idx)
        else:
            continue

        for target in targets:
            if target in seen:
                continue
            seen.add(target)
            pending.append((first_turn, target))

    pending.sort(key=lambda pair: pair[0])
    return pending


def _count_output_tokens(assistant_msg: dict, encoder) -> int:
    """Assistant-generated tokens: visible content plus any reasoning trace."""
    total = 0

    content = assistant_msg.get("content", "")
    if isinstance(content, str) and content:
        total += len(encoder.encode(content))
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("text"):
                total += len(encoder.encode(part["text"]))

    reasoning = assistant_msg.get("reasoning", "")
    if isinstance(reasoning, str) and reasoning.strip():
        total += len(encoder.encode(reasoning.strip()))

    return total


def _active_variant_index(msg: dict, count: int) -> int:
    raw = msg.get("activeVariant")
    if isinstance(raw, int) and not isinstance(raw, bool) and 0 <= raw < count:
        return raw
    return -1


def _variant_as_message(variant: dict) -> dict:
    """A stashed variant as a plain assistant message on its own path."""
    message = {k: v for k, v in variant.items() if k not in _VARIANT_META_KEYS}
    message["role"] = "assistant"
    return message


def _is_placeholder(variant: dict) -> bool:
    """The active variant's entry only holds identity; its fields are live."""
    return "content" not in variant and "model" not in variant


def _iter_inactive_branches(messages: list, start: int = 0, depth: int = 0):
    """Yields (path, fork_index) for every inactive response in the tree.

    Each path is the shared prefix, the stashed response, and the tail that
    followed it. Only slots from `start` onward are scanned, so each fork is
    reported exactly once however many branches share its prefix.
    """
    if depth >= MAX_BRANCH_DEPTH:
        return
    for idx in range(max(0, start), len(messages)):
        msg = messages[idx]
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        variants = msg.get("variants")
        if not isinstance(variants, list) or not variants:
            continue
        active = _active_variant_index(msg, len(variants))
        for k, variant in enumerate(variants):
            if k == active or not isinstance(variant, dict) or _is_placeholder(variant):
                continue
            tail = variant.get("tail")
            if not isinstance(tail, list):
                tail = []
            path = messages[:idx] + [_variant_as_message(variant)] + tail
            yield path, idx
            yield from _iter_inactive_branches(path, idx + 1, depth + 1)


def count_conversation_tokens(conv: dict, preserve_models: frozenset = frozenset()) -> dict:
    """Walks one conversation, returning
    {model_id: {day_key: {input, output, turns, saved}}}.

    The active path is counted first. Every inactive response in the message
    tree was a real, billed request too, so each is then walked as its own
    path (shared prefix, the response, whatever followed it), counting only
    turns from the fork onward so the prefix is never billed twice.
    """
    result = {}
    messages = conv.get("messages") if isinstance(conv, dict) else None
    if not isinstance(messages, list) or not messages:
        return result

    fallback_ms = _conversation_fallback_ts(conv)
    token_cache = {}
    _walk_path(messages, fallback_ms, preserve_models, result, 0, token_cache)

    # Holding every path keeps its synthesized variant messages alive, so no
    # id() used as a key in the shared token cache can be reused by another
    # object during this count.
    keepalive = []
    branches = itertools.islice(_iter_inactive_branches(messages), MAX_BRANCH_PATHS)
    for path, fork_index in branches:
        keepalive.append(path)
        _walk_path(path, fallback_ms, preserve_models, result, fork_index, token_cache)

    if len(keepalive) >= MAX_BRANCH_PATHS:
        logger.warn(
            f"[Token Counter] Conversation '{conv.get('id')}' reached the "
            f"{MAX_BRANCH_PATHS}-branch limit; any further branches were not counted."
        )
    return result


def _walk_path(messages: list, fallback_ms: int, preserve_models: frozenset,
               result: dict, count_from: int, token_cache: dict) -> None:
    """Walks one linear path, adding turns at or after `count_from` into
    `result` as {model_id: {day_key: {input, output, turns, saved}}}.

    Input tokens for a turn are the cumulative context tokens of every
    preceding message plus the assistant priming overhead, counted in the form
    each message had *at that point in the thread*. A message pruned at turn A
    counts in full for every turn up to and including A, and in stub form
    afterwards, which is what was actually billed.

    `saved` is the running difference between the full and stub forms of every
    already-pruned message, recorded per turn. Summed across turns it reads as
    the total context pruning kept off the bill.

    Running sums are keyed by encoding name, not model id: models sharing an
    encoding share a sum, and a thread that switches to a genuinely different
    encoding pays a single backfill at the point of the switch. A form change
    is applied as a delta rather than a rebuild, so the walk stays linear in
    message count.
    """
    if not isinstance(messages, list) or not messages:
        return

    pending = _prune_boundaries(messages)
    cursor = 0

    history = []
    switched = set()
    running = {}
    saved_running = {}
    active_encoders = {}

    def tokens_for(index, message, enc_name, encoder, pruned_form):
        # Keyed by object identity rather than index, so a prefix shared
        # between branch walks is tokenized once. The caller keeps every path
        # alive for the whole count, which keeps the ids stable.
        key = (id(message), enc_name, pruned_form)
        cached = token_cache.get(key)
        if cached is None:
            cached = _context_tokens(message, pruned_form, encoder, preserve_models)
            token_cache[key] = cached
        return cached

    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            continue

        is_assistant = msg.get("role") == "assistant"
        is_error = bool(msg.get("isError"))

        if is_assistant and not is_error:
            # Every prune whose first turn is at or before this one now applies.
            # `pending` is sorted by first turn, so the cursor only moves forward.
            while cursor < len(pending) and pending[cursor][0] <= idx:
                target = pending[cursor][1]
                cursor += 1
                if target in switched:
                    continue
                target_msg = messages[target] if target < len(messages) else None
                if not isinstance(target_msg, dict):
                    continue
                switched.add(target)
                for enc_name, encoder in active_encoders.items():
                    full = tokens_for(target, target_msg, enc_name, encoder, False)
                    stub = tokens_for(target, target_msg, enc_name, encoder, True)
                    running[enc_name] += (stub - full)
                    saved_running[enc_name] = saved_running.get(enc_name, 0) + (full - stub)

            if idx < count_from:
                # Shared prefix, already counted on the path this fork left.
                # No encoder is registered yet, so there is no running sum to
                # update; backfill at the first counted turn covers it.
                history.append((idx, msg))
                continue

            model_id = msg.get("model") or "unknown"
            enc_name, encoder = _resolve_encoder(model_id)

            if enc_name not in running:
                backfill = 0
                backfill_saved = 0
                for h_idx, h_msg in history:
                    pruned_form = h_idx in switched
                    backfill += tokens_for(h_idx, h_msg, enc_name, encoder, pruned_form)
                    if pruned_form:
                        full = tokens_for(h_idx, h_msg, enc_name, encoder, False)
                        stub = tokens_for(h_idx, h_msg, enc_name, encoder, True)
                        backfill_saved += (full - stub)
                running[enc_name] = backfill
                saved_running[enc_name] = backfill_saved
                active_encoders[enc_name] = encoder

            has_history = bool(history)
            input_tokens = (running[enc_name] + ASSISTANT_PRIMING_TOKENS) if has_history else 0
            saved_tokens = saved_running.get(enc_name, 0) if has_history else 0
            output_tokens = _count_output_tokens(msg, encoder)
            day = _day_key(_message_timestamp(msg, fallback_ms))

            days = result.get(model_id)
            if days is None:
                days = {}
                result[model_id] = days
            row = days.get(day)
            if row is None:
                row = {"input": 0, "output": 0, "turns": 0, "saved": 0}
                days[day] = row

            row["input"] += input_tokens
            row["output"] += output_tokens
            row["saved"] += saved_tokens
            row["turns"] += 1

        # An errored reply is filtered out of the replay history, so it never
        # became context for any later turn.
        if is_assistant and is_error:
            continue

        history.append((idx, msg))
        for enc_name, encoder in active_encoders.items():
            running[enc_name] += tokens_for(idx, msg, enc_name, encoder, idx in switched)


def _partition_conversations(conversations, cache, force, preserve_key=""):
    """Splits conversations into cache hits and entries needing a recount."""
    hits = []
    misses = []

    for conv in conversations:
        conv_id = str(conv.get("id") or "")
        fingerprint = _conversation_fingerprint(conv, preserve_key)
        entry = cache.get(conv_id) if (conv_id and not force) else None

        if entry and entry.get("hash") == fingerprint and isinstance(entry.get("models"), dict):
            hits.append((conv_id, fingerprint, entry["models"]))
        else:
            misses.append((conv_id, fingerprint, conv))

    return hits, misses


def _recount_misses(misses, preserve_models=frozenset()):
    """Recounts changed conversations across a bounded worker pool."""
    computed = []
    if not misses:
        return computed

    workers = min(MAX_COUNT_WORKERS, len(misses))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            (conv_id, fingerprint, pool.submit(count_conversation_tokens, conv, preserve_models))
            for conv_id, fingerprint, conv in misses
        ]
        for idx, (conv_id, fingerprint, future) in enumerate(futures, start=1):
            try:
                computed.append((conv_id, fingerprint, future.result()))
            except Exception as e:
                logger.error(f"[Token Counter] Failed to count conversation '{conv_id}': {e}")
                computed.append((conv_id, fingerprint, {}))
            if idx % PROGRESS_LOG_EVERY == 0:
                logger.info(f"[Token Counter] Recounted {idx}/{len(misses)} changed conversation(s)...")

    return computed


def _accumulate(entries):
    """Folds cached and freshly counted maps into all-time and per-day views."""
    per_model = {}
    daily_map = {}
    undated_turns = 0

    for _, _, models_map in entries:
        if not isinstance(models_map, dict):
            continue
        for model_id, days in models_map.items():
            if not isinstance(days, dict):
                continue
            for day, row in days.items():
                if not isinstance(row, dict):
                    continue
                inp = int(row.get("input", 0) or 0)
                out = int(row.get("output", 0) or 0)
                turns = int(row.get("turns", 0) or 0)
                saved = int(row.get("saved", 0) or 0)

                agg = per_model.get(model_id)
                if agg is None:
                    agg = {"input": 0, "output": 0, "turns": 0, "saved": 0}
                    per_model[model_id] = agg
                agg["input"] += inp
                agg["output"] += out
                agg["turns"] += turns
                agg["saved"] += saved

                if not day:
                    undated_turns += turns
                    continue

                day_models = daily_map.get(day)
                if day_models is None:
                    day_models = {}
                    daily_map[day] = day_models
                drow = day_models.get(model_id)
                if drow is None:
                    drow = {"input": 0, "output": 0, "turns": 0, "saved": 0}
                    day_models[model_id] = drow
                drow["input"] += inp
                drow["output"] += out
                drow["turns"] += turns
                drow["saved"] += saved

    return per_model, daily_map, undated_turns


def calculate_all_chat_tokens(force: bool = False) -> dict:
    """Retroactively tallies input and output tokens per model and provider,
    bucketed by day so the UI can filter to any window.

    Conversations whose content hash is unchanged since the last run are not
    re-tokenized; their stored counts are added straight back in.
    """
    start_time = time.perf_counter()

    settings = load_settings()
    pricing = _pricing_config(settings)
    price_models = pricing["models"]
    preserve_models = _preserve_models(settings)
    preserve_key = _preserve_key(preserve_models)

    history_data = get_all_history()
    conversations = [c for c in history_data.get("conversations", []) if isinstance(c, dict)]

    cache = {} if force else _load_cache()
    hits, misses = _partition_conversations(conversations, cache, force, preserve_key)

    mode = "forced rebuild" if force else "cached"
    logger.info(
        f"[Token Counter] Scanning {len(conversations)} conversation(s) "
        f"[{mode}] ({len(hits)} cached, {len(misses)} changed)..."
    )

    computed = _recount_misses(misses, preserve_models)

    # Only raw per-model, per-day counts are persisted. Provider attribution
    # and pricing are derived below on every run, so settings edits apply
    # without forcing a recount.
    next_cache = {}
    for conv_id, fingerprint, models_map in hits:
        if conv_id:
            next_cache[conv_id] = {"hash": fingerprint, "models": models_map}
    for conv_id, fingerprint, models_map in computed:
        if conv_id:
            next_cache[conv_id] = {"hash": fingerprint, "models": models_map}

    per_model, daily_map, undated_turns = _accumulate(hits + computed)

    by_model = {}
    by_provider = {}
    model_index = {}
    total_input = 0
    total_output = 0
    total_turns = 0
    total_saved = 0
    total_cost = 0.0

    for model_id, agg in per_model.items():
        prov_info = resolve_model_provider(model_id, settings)
        prov_id = prov_info["id"]
        inp = agg["input"]
        out = agg["output"]
        turns = agg["turns"]
        saved = agg.get("saved", 0)
        price = price_models.get(model_id)
        cost = _cost_for(inp, out, price)

        logger.info(f"[Token Counter] Model '{model_id}' (Provider: {prov_info['name']}) \u00b7 {turns} turn(s)")

        model_index[model_id] = {
            "provider_id": prov_id,
            "provider_name": prov_info["name"],
            "provider_logo": prov_info["logo"]
        }

        by_model[model_id] = {
            "model_id": model_id,
            "provider_id": prov_id,
            "provider_name": prov_info["name"],
            "provider_logo": prov_info["logo"],
            "input_tokens": inp,
            "output_tokens": out,
            "total_tokens": inp + out,
            "saved_tokens": saved,
            "turns": turns,
            "cost": cost,
            "has_price": bool(price)
        }

        prov = by_provider.get(prov_id)
        if prov is None:
            prov = {
                "provider_id": prov_id,
                "name": prov_info["name"],
                "logo": prov_info["logo"],
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "saved_tokens": 0,
                "turns": 0,
                "cost": 0.0,
                "model_count": 0
            }
            by_provider[prov_id] = prov
        prov["input_tokens"] += inp
        prov["output_tokens"] += out
        prov["total_tokens"] += (inp + out)
        prov["saved_tokens"] += saved
        prov["turns"] += turns
        prov["cost"] += cost
        prov["model_count"] += 1

        total_input += inp
        total_output += out
        total_turns += turns
        total_saved += saved
        total_cost += cost

    # Entries for conversations that no longer exist are dropped here, so the
    # cache cannot grow unbounded as chats are deleted.
    _save_cache(next_cache)

    providers_list = list(by_provider.values())
    providers_list.sort(key=lambda x: -x["total_tokens"])

    models_list = list(by_model.values())
    models_list.sort(key=lambda x: -x["total_tokens"])

    daily_list = []
    for day in sorted(daily_map.keys()):
        daily_list.append({"date": day, "models": daily_map[day]})

    elapsed = time.perf_counter() - start_time
    logger.success(
        f"[Token Counter] Tally complete: {total_turns} turn(s), "
        f"{total_input:,} input tokens, {total_output:,} output tokens "
        f"across {len(conversations)} conversation(s) ({len(models_list)} models) "
        f"in {elapsed:.2f}s ({len(hits)} from cache, {len(misses)} recounted)"
    )

    return {
        "totals": {
            "input_tokens": total_input,
            "output_tokens": total_output,
            "total_tokens": total_input + total_output,
            "saved_tokens": total_saved,
            "conversations": len(conversations),
            "turns": total_turns,
            "cost": total_cost
        },
        "by_provider": providers_list,
        "by_model": models_list,
        "model_index": model_index,
        "daily": daily_list,
        "pricing": pricing,
        "cache": {
            "hits": len(hits),
            "misses": len(misses),
            "forced": bool(force),
            "undated_turns": undated_turns,
            "elapsed_seconds": round(elapsed, 3)
        }
    }
