"""Model discovery and request routing across OpenAI-compatible endpoints.

Every model the web UI can use comes from an endpoint listed in
settings.json. The local copilot-api proxy is simply one of them.
"""
import asyncio
import json

import httpx
import httpx_sse

from src.config import (
    CUSTOM_ENDPOINT_MODEL_TIMEOUT,
    DEFAULT_NON_STREAM_TIMEOUT,
    load_settings,
    logger,
    state
)
from src.utils import HTTPError, safe_json

STREAM_TIMEOUT_SECONDS = 120.0
NON_STREAM_TIMEOUT_MIN = 5.0
NON_STREAM_TIMEOUT_MAX = 3600.0
MAX_ENDPOINTS = 64
MAX_MODELS_PER_ENDPOINT = 2000
ERROR_BODY_PREVIEW_CHARS = 2000

REASONING_KEYS = ("reasoning_content", "reasoning", "reasoning_text", "thinking")
NESTED_REASONING_KEYS = ("text", "content", "reasoning")


def _client(timeout):
    return httpx.AsyncClient(trust_env=state.use_proxy_env, timeout=timeout)


def _base_url(endpoint):
    return str(endpoint.get("url") or "").strip().rstrip("/")


def _endpoint_name(endpoint):
    return str(endpoint.get("name") or "Custom")


def _request_headers(endpoint):
    headers = {"Content-Type": "application/json"}
    api_key = endpoint.get("api_key")
    if isinstance(api_key, str) and api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"
    return headers


def _describe(exc):
    text = str(exc)
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


# ---------------------------------------------------------------------------
# Model discovery
# ---------------------------------------------------------------------------

def _pinned_model_ids(endpoint):
    """Model ids the user pinned in Settings. Accepts a list or a CSV string."""
    raw = endpoint.get("models", [])
    if isinstance(raw, str):
        raw = raw.split(",")
    if not isinstance(raw, list):
        return []
    ids = [item.strip() for item in raw[:MAX_MODELS_PER_ENDPOINT] if isinstance(item, str)]
    return [item for item in ids if item]


async def _list_remote_models(endpoint):
    async with _client(CUSTOM_ENDPOINT_MODEL_TIMEOUT) as client:
        resp = await client.get(f"{_base_url(endpoint)}/models", headers=_request_headers(endpoint))
    if resp.status_code != 200:
        raise HTTPError(f"HTTP {resp.status_code}", resp.status_code)
    data = safe_json(resp, {})
    items = data.get("data", []) if isinstance(data, dict) else []
    if not isinstance(items, list):
        return []
    return [m for m in items[:MAX_MODELS_PER_ENDPOINT] if isinstance(m, dict) and m.get("id")]


def _select_models(remote, pinned_ids):
    """Pinned ids win; otherwise everything the endpoint reported is used."""
    if not pinned_ids:
        return [dict(m) for m in remote]
    by_id = {m.get("id"): m for m in remote}
    return [dict(by_id[mid]) if mid in by_id else {"id": mid, "name": mid} for mid in pinned_ids]


async def fetch_endpoint_models(endpoint):
    name = _endpoint_name(endpoint)
    if not _base_url(endpoint):
        return []
    try:
        remote = await _list_remote_models(endpoint)
    except Exception as e:
        logger.warn(f"Could not list models from endpoint '{name}': {_describe(e)}")
        remote = []
    models = _select_models(remote, _pinned_model_ids(endpoint))
    for model in models:
        model["_custom_endpoint"] = endpoint
        model["_endpoint_name"] = name
        model["vendor"] = model.get("owned_by") or name
    logger.info(f"Registered {len(models)} model(s) from endpoint '{name}'")
    return models


def _configured_endpoints():
    endpoints = load_settings().get("custom_endpoints", [])
    if not isinstance(endpoints, list):
        return []
    return [ep for ep in endpoints[:MAX_ENDPOINTS] if isinstance(ep, dict) and _base_url(ep)]


def _assign_public_ids(models):
    """The first endpoint to report an id keeps it bare; later duplicates get
    an '(Endpoint)' suffix so every public id stays unique."""
    seen = set()
    for model in models:
        raw_id = str(model.get("id"))
        model["_raw_model_id"] = raw_id
        if raw_id in seen:
            model["id"] = f"{raw_id} ({model.get('_endpoint_name', 'Custom')})"
        seen.add(raw_id)
        seen.add(model["id"])


async def cache_models():
    endpoints = _configured_endpoints()
    results = await asyncio.gather(*(fetch_endpoint_models(ep) for ep in endpoints), return_exceptions=True)
    merged = []
    for endpoint, result in zip(endpoints, results):
        if isinstance(result, BaseException):
            logger.error(f"Endpoint '{_endpoint_name(endpoint)}' failed: {_describe(result)}")
            continue
        merged.extend(result)
    _assign_public_ids(merged)
    state.models = {"data": merged}
    logger.success(f"Model catalogue updated: {len(merged)} model(s) across {len(endpoints)} endpoint(s)")
    return merged


def find_model(model_id):
    if not isinstance(model_id, str) or not model_id or not state.models:
        return None
    data = state.models.get("data", [])
    exact = next((m for m in data if m.get("id") == model_id), None)
    if exact is not None:
        return exact
    return next((m for m in data if m.get("_raw_model_id") == model_id), None)


def is_metered(model):
    """True when the upstream reported a premium multiplier (copilot-api does)."""
    value = model.get("multiplier") if isinstance(model, dict) else None
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


# ---------------------------------------------------------------------------
# Reasoning normalization
# ---------------------------------------------------------------------------

def _coerce_reasoning(value):
    if isinstance(value, str):
        return value or None
    if isinstance(value, dict):
        for key in NESTED_REASONING_KEYS:
            nested = value.get(key)
            if isinstance(nested, str) and nested:
                return nested
    return None


def normalize_reasoning_fields(obj):
    """Moves any provider-specific reasoning field onto reasoning_content."""
    if not isinstance(obj, dict):
        return None
    for key in REASONING_KEYS:
        if key not in obj:
            continue
        text = _coerce_reasoning(obj.get(key))
        if key != "reasoning_content":
            obj.pop(key, None)
        if text:
            obj["reasoning_content"] = text
            return text
    return None


def normalize_reasoning_payload(data):
    if isinstance(data, dict):
        for choice in data.get("choices") or []:
            if isinstance(choice, dict):
                normalize_reasoning_fields(choice.get("message"))
                normalize_reasoning_fields(choice.get("delta"))
    return data


# ---------------------------------------------------------------------------
# Chat completions
# ---------------------------------------------------------------------------

def _non_stream_timeout():
    raw = load_settings().get("non_stream_timeout", DEFAULT_NON_STREAM_TIMEOUT)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = float(DEFAULT_NON_STREAM_TIMEOUT)
    return min(max(value, NON_STREAM_TIMEOUT_MIN), NON_STREAM_TIMEOUT_MAX)


def _upstream_error(status_code, body_text, endpoint_name):
    """Passes an OpenAI-shaped error through untouched so the UI can read
    error.message (and learn token limits from it); wraps anything else."""
    try:
        parsed = json.loads(body_text) if body_text else None
    except ValueError:
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
        message = str(parsed["error"].get("message") or body_text)
        return HTTPError(message, status_code, parsed)
    preview = (body_text or "no body")[:ERROR_BODY_PREVIEW_CHARS]
    return HTTPError(f"Endpoint '{endpoint_name}' returned HTTP {status_code}: {preview}", status_code)


async def _complete_once(url, headers, body, endpoint_name):
    async with _client(_non_stream_timeout()) as client:
        resp = await client.post(url, headers=headers, json=body)
    if resp.status_code != 200:
        raise _upstream_error(resp.status_code, resp.text, endpoint_name)
    data = safe_json(resp, None)
    if not isinstance(data, dict) or ("raw" in data and "choices" not in data):
        raise HTTPError(f"Endpoint '{endpoint_name}' returned a non-JSON response", 502)
    return normalize_reasoning_payload(data)


def _reframe_chunk(data):
    try:
        chunk = json.loads(data)
    except ValueError:
        # Keepalives and partial frames pass through untouched.
        return f"data: {data}\n\n"
    normalize_reasoning_payload(chunk)
    return f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n"


async def _relay_stream(client, resp, endpoint_name):
    try:
        async for event in httpx_sse.EventSource(resp).aiter_sse():
            if event.data == "[DONE]":
                break
            yield _reframe_chunk(event.data)
    except (httpx.HTTPError, httpx_sse.SSEError) as e:
        logger.error(f"Stream from endpoint '{endpoint_name}' broke off: {_describe(e)}")
    finally:
        await resp.aclose()
        await client.aclose()
    # Always terminate the stream, even if the upstream never sent [DONE].
    yield "data: [DONE]\n\n"


async def _open_stream(url, headers, body, endpoint_name):
    client = _client(STREAM_TIMEOUT_SECONDS)
    try:
        request = client.build_request("POST", url, headers=headers, json=body)
        resp = await client.send(request, stream=True)
    except BaseException:
        await client.aclose()
        raise
    if resp.status_code == 200:
        return _relay_stream(client, resp, endpoint_name)
    try:
        raw = await resp.aread()
    finally:
        await resp.aclose()
        await client.aclose()
    raise _upstream_error(resp.status_code, raw.decode("utf-8", errors="ignore"), endpoint_name)


async def _resolve_model(model_id):
    model = find_model(model_id)
    if model is None:
        # The catalogue may be stale: an endpoint came online or was just added.
        await cache_models()
        model = find_model(model_id)
    if model is None:
        raise HTTPError(f"Unknown model '{model_id}'. Make sure an endpoint in Settings serves it.", 404)
    return model


async def create_chat_completions(payload, stream):
    if not isinstance(payload, dict):
        raise HTTPError("Request body must be a JSON object", 400)
    model = await _resolve_model(payload.get("model"))
    endpoint = model.get("_custom_endpoint") or {}
    name = _endpoint_name(endpoint)
    body = dict(payload)
    body["model"] = model.get("_raw_model_id") or model.get("id")
    url = f"{_base_url(endpoint)}/chat/completions"
    headers = _request_headers(endpoint)
    logger.debug(f"Routing '{model.get('id')}' to endpoint '{name}' (stream={bool(stream)})")
    try:
        if stream:
            return await _open_stream(url, headers, body, name)
        return await _complete_once(url, headers, body, name)
    except httpx.TimeoutException as e:
        raise HTTPError(f"Endpoint '{name}' timed out", 504) from e
    except httpx.HTTPError as e:
        raise HTTPError(f"Could not reach endpoint '{name}': {_describe(e)}", 502) from e
