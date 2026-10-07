"""HTTP surface of CombineWebUI: the chat page, its persistence APIs, and an
OpenAI-compatible router in front of the configured endpoints."""
import asyncio
import json
import time

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from src.config import (
    COPILOT_SEED_FLAG,
    PAGES_DIR,
    STATIC_DIR,
    load_settings,
    logger,
    resolve_logo_to_data_uri,
    save_settings,
    state
)
from src.endpoints import cache_models, create_chat_completions, is_metered
from src.events import broadcast_event, event_broadcaster
from src.history import (
    delete_conversation,
    get_all_history,
    get_conversation,
    get_history_index,
    import_bulk_history,
    save_conversation,
    save_history_index
)
from src.token_counter import calculate_all_chat_tokens
from src.utils import HTTPError, count_messages_tokens

SSE_KEEPALIVE_SECONDS = 20.0
CHECK_TIMEOUT_DEFAULT = 0.5
CHECK_TIMEOUT_MIN = 0.1
CHECK_TIMEOUT_MAX = 15.0
PRICE_UNIT = 1000000
MAX_PRICED_MODELS = 5000

# Cache-aware pruning, configured per endpoint. Mirrors pages/static/js/config.js.
PRUNE_POLICIES = ("deferred", "immediate")
DEFAULT_PRUNE_POLICY = "deferred"
DEFAULT_CACHE_TTL_SECONDS = 300
CACHE_TTL_MIN_SECONDS = 30
CACHE_TTL_MAX_SECONDS = 3600

# Sections with dedicated endpoints. The settings modal posts back the copy it
# loaded when it opened, which must never overwrite newer values.
PROTECTED_SETTINGS_KEYS = ("model_pricing", "ui_preferences", COPILOT_SEED_FLAG)

app = FastAPI(title="CombineWebUI")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
else:
    logger.warn(f"Static asset directory '{STATIC_DIR}' not found; the UI will not load.")


def _ok(**extra):
    body = {"status": "ok"}
    body.update(extra)
    return JSONResponse(body)


def _error(message, status_code):
    return JSONResponse({"status": "error", "message": message}, status_code=status_code)


def _as_list(value):
    return value if isinstance(value, list) else []


async def _json_body(request):
    try:
        return await request.json()
    except (ValueError, UnicodeDecodeError) as e:
        raise HTTPError(f"Invalid JSON body: {e}", 400) from e


@app.exception_handler(HTTPError)
async def http_error_handler(request: Request, exc: HTTPError):
    logger.error(f"HTTP {exc.status_code}: {exc}")
    if isinstance(exc.data, dict) and "error" in exc.data:
        content = exc.data
    else:
        content = {"error": {"message": str(exc), "type": "error"}}
    return JSONResponse(status_code=exc.status_code, content=content)


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled error: {exc}")
    return JSONResponse(status_code=500, content={"error": {"message": str(exc), "type": "error"}})


@app.get("/")
async def root():
    index_path = PAGES_DIR / "index.html"
    if not index_path.is_file():
        return Response("CombineWebUI is running, but pages/index.html is missing.", media_type="text/plain")
    return HTMLResponse(index_path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Chat and models
# ---------------------------------------------------------------------------

@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    payload = await _json_body(request)
    if not isinstance(payload, dict):
        raise HTTPError("Request body must be a JSON object", 400)
    stream = bool(payload.get("stream", False))
    result = await create_chat_completions(payload, stream)
    if stream:
        return StreamingResponse(result, media_type="text/event-stream")
    return JSONResponse(result)


def _merged_providers(settings):
    """Configured picture groups plus one group per endpoint, logos resolved."""
    providers = [dict(p) for p in _as_list(settings.get("providers")) if isinstance(p, dict)]
    for endpoint in _as_list(settings.get("custom_endpoints")):
        if not isinstance(endpoint, dict) or not endpoint.get("name"):
            continue
        name = endpoint["name"]
        logo = endpoint.get("logo", "")
        existing = next((p for p in providers if p.get("id") == name), None)
        if existing is None:
            providers.append({"id": name, "name": name, "keywords": [], "logo": logo})
        elif logo and not existing.get("logo"):
            existing["logo"] = logo
    for provider in providers:
        if provider.get("logo"):
            provider["logo"] = resolve_logo_to_data_uri(provider["logo"])
    return providers


def _match_provider(model_id, raw_id, providers):
    haystacks = (model_id.lower(), raw_id.lower())
    for provider in providers:
        provider_id = provider.get("id")
        if not provider_id or provider_id == "other":
            continue
        for keyword in _as_list(provider.get("keywords")):
            if isinstance(keyword, str) and keyword and any(keyword.lower() in h for h in haystacks):
                return provider_id
    return None


def _prune_policy(endpoint):
    value = str(endpoint.get("prune_policy") or "").strip().lower()
    return value if value in PRUNE_POLICIES else DEFAULT_PRUNE_POLICY


def _cache_ttl(endpoint):
    raw = endpoint.get("cache_ttl_seconds", DEFAULT_CACHE_TTL_SECONDS)
    if raw is None or isinstance(raw, bool):
        return DEFAULT_CACHE_TTL_SECONDS
    try:
        value = int(float(raw))
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_CACHE_TTL_SECONDS
    return min(max(value, CACHE_TTL_MIN_SECONDS), CACHE_TTL_MAX_SECONDS)


def _public_model(model, providers):
    model_id = str(model.get("id"))
    raw_id = str(model.get("_raw_model_id") or model_id)
    endpoint = model.get("_custom_endpoint") or {}
    endpoint_name = model.get("_endpoint_name") or endpoint.get("name") or "Custom"
    metered = is_metered(model)
    display = model.get("display_name") or model.get("name") or raw_id
    if model_id != raw_id:
        display = f"{display} ({endpoint_name})"
    return {
        "id": model_id,
        "object": "model",
        "type": "model",
        "created": 0,
        "owned_by": model.get("vendor"),
        "display_name": display,
        "multiplier": model.get("multiplier") if metered else None,
        "multiplier_label": model.get("multiplier_label") if metered else None,
        "provider_id": _match_provider(model_id, raw_id, providers) or endpoint_name,
        "endpoint_name": endpoint_name,
        "raw_id": raw_id,
        "is_custom": True,
        "is_metered": metered,
        "stream_enabled": endpoint.get("stream", True) is not False,
        "prune_policy": _prune_policy(endpoint),
        "cache_ttl_seconds": _cache_ttl(endpoint)
    }


@app.get("/v1/models")
async def list_models():
    # An empty catalogue is retried, so an endpoint started after the web UI
    # shows up on the next page load.
    if not state.models or not state.models.get("data"):
        await cache_models()
    providers = _merged_providers(load_settings())
    raw_models = (state.models or {}).get("data", [])
    data = [_public_model(m, providers) for m in raw_models if isinstance(m, dict)]
    data.sort(key=lambda m: (-(m["multiplier"] or 0), m["id"]))
    return JSONResponse({"object": "list", "data": data, "providers": providers, "has_more": False})


@app.post("/v1/count_tokens")
async def count_tokens(request: Request):
    try:
        payload = await request.json()
        total = count_messages_tokens(payload.get("messages"), str(payload.get("model") or ""))
    except Exception as e:
        logger.warn(f"Token count failed: {e}")
        total = 0
    return JSONResponse({"total_tokens": total})


@app.get("/v1/token_counter")
async def token_counter(refresh: bool = False):
    logger.info(f"[Token Counter] Requested ({'forced rebuild' if refresh else 'cached read'})")
    try:
        # Tokenizing a large history is CPU-bound; keep the event loop free.
        stats = await asyncio.to_thread(calculate_all_chat_tokens, force=refresh)
    except Exception as e:
        logger.error(f"Failed to calculate chat log tokens: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse(stats)


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

@app.get("/v1/history/index")
async def history_index():
    return JSONResponse(get_history_index())


@app.put("/v1/history/index")
async def put_history_index(request: Request):
    data = await _json_body(request)
    if not isinstance(data, dict):
        return _error("Index payload must be an object", 400)
    # A failed write must not read as success, or the client never retries.
    return _ok() if save_history_index(data) else _error("Failed to write history index", 500)


@app.get("/v1/history/all")
@app.get("/v1/history")
async def history_all():
    return JSONResponse(get_all_history())


@app.get("/v1/history/conversations/{conv_id}")
async def get_conv(conv_id: str):
    conv = get_conversation(conv_id)
    if conv is None:
        return JSONResponse({"error": "Conversation not found"}, status_code=404)
    return JSONResponse(conv)


@app.put("/v1/history/conversations/{conv_id}")
async def put_conv(conv_id: str, request: Request):
    data = await _json_body(request)
    if not isinstance(data, dict):
        return _error("Conversation payload must be an object", 400)
    data["id"] = conv_id
    return _ok() if save_conversation(data) else _error("Failed to write conversation", 500)


@app.delete("/v1/history/conversations/{conv_id}")
async def delete_conv(conv_id: str):
    return _ok() if delete_conversation(conv_id) else _error("Failed to delete conversation", 500)


@app.post("/v1/history/import")
async def import_history(request: Request):
    data = await _json_body(request)
    return _ok() if import_bulk_history(data) else _error("Failed to import history", 500)


@app.get("/v1/events")
async def events(request: Request):
    queue = await event_broadcaster.subscribe()

    async def event_stream():
        try:
            yield f"event: connected\ndata: {json.dumps({'status': 'connected'})}\n\n"
            # Lives as long as the browser tab; ends when the client disconnects.
            while not await request.is_disconnected():
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=SSE_KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {message}\n\n"
        finally:
            await event_broadcaster.unsubscribe(queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Preferences and pricing
# ---------------------------------------------------------------------------

@app.get("/v1/ui_preferences")
async def get_ui_preferences():
    return JSONResponse(load_settings().get("ui_preferences", {}))


@app.put("/v1/ui_preferences")
async def put_ui_preferences(request: Request):
    data = await _json_body(request)
    if not isinstance(data, dict):
        return _error("Invalid payload", 400)
    settings = load_settings()
    prefs = settings.get("ui_preferences")
    if not isinstance(prefs, dict):
        prefs = {}
    prefs.update(data)
    settings["ui_preferences"] = prefs
    if not save_settings(settings):
        return _error("Failed to save preferences", 500)
    broadcast_event("ui_preferences_updated", prefs)
    return _ok(ui_preferences=prefs)


def _clean_price_entry(entry):
    if not isinstance(entry, dict):
        return None
    try:
        price_in = float(entry.get("input", 0) or 0)
        price_out = float(entry.get("output", 0) or 0)
    except (TypeError, ValueError):
        return None
    # Rows at zero on both sides are dropped, so an untouched input never
    # reads as a deliberately free model.
    if price_in <= 0 and price_out <= 0:
        return None
    return {"input": price_in, "output": price_out}


def _clean_price_map(incoming):
    clean = {}
    for model_id, entry in list(incoming.items())[:MAX_PRICED_MODELS]:
        cleaned = _clean_price_entry(entry)
        if cleaned is not None:
            clean[str(model_id)] = cleaned
    return clean


@app.get("/v1/model_pricing")
async def get_model_pricing():
    pricing = load_settings().get("model_pricing")
    if not isinstance(pricing, dict):
        pricing = {"currency": "USD", "unit": PRICE_UNIT, "models": {}}
    return JSONResponse(pricing)


@app.put("/v1/model_pricing")
async def put_model_pricing(request: Request):
    data = await _json_body(request)
    if not isinstance(data, dict) or not isinstance(data.get("models"), dict):
        return _error("Expected an object with a 'models' map", 400)
    settings = load_settings()
    previous = settings.get("model_pricing") if isinstance(settings.get("model_pricing"), dict) else {}
    pricing = {
        "currency": str(data.get("currency") or previous.get("currency") or "USD"),
        "unit": PRICE_UNIT,
        "models": _clean_price_map(data["models"])
    }
    settings["model_pricing"] = pricing
    if not save_settings(settings):
        return _error("Failed to save pricing", 500)
    broadcast_event("model_pricing_updated", pricing)
    return _ok(model_pricing=pricing)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@app.get("/v1/settings")
async def get_settings():
    return JSONResponse(load_settings())


@app.post("/v1/settings")
async def post_settings(request: Request):
    data = await _json_body(request)
    if not isinstance(data, dict):
        return _error("Settings payload must be an object", 400)
    refresh = bool(data.pop("refresh_models", True))
    existing = load_settings()
    for key in PROTECTED_SETTINGS_KEYS:
        if key in existing:
            data[key] = existing[key]
    if not save_settings(data):
        return _error("Failed to save settings", 500)
    if refresh:
        await cache_models()
    return _ok()


@app.post("/v1/settings/preview_logo")
async def preview_logo(request: Request):
    try:
        data = await request.json()
        return JSONResponse({"resolved": resolve_logo_to_data_uri(data.get("logo", ""))})
    except Exception as e:
        return JSONResponse({"resolved": "", "error": str(e)})


@app.post("/v1/settings/refresh_models")
async def refresh_models():
    logger.info("Refreshing the model catalogue on client request...")
    try:
        models = await cache_models()
    except Exception as e:
        logger.error(f"Failed to refresh models: {e}")
        return JSONResponse({"status": "error", "error": str(e)}, status_code=500)
    return _ok(model_count=len(models))


def _check_timeout(raw):
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return CHECK_TIMEOUT_DEFAULT
    return min(max(value, CHECK_TIMEOUT_MIN), CHECK_TIMEOUT_MAX)


def _latency_ms(start):
    return round((time.perf_counter() - start) * 1000.0, 1)


@app.post("/v1/settings/check_endpoint")
async def check_endpoint(request: Request):
    data = await _json_body(request)
    if not isinstance(data, dict):
        return JSONResponse({"ok": False, "error": "Invalid payload", "latency_ms": 0}, status_code=400)
    base_url = str(data.get("url") or "").strip().rstrip("/")
    if not base_url:
        return JSONResponse({"ok": False, "error": "Missing endpoint URL", "latency_ms": 0}, status_code=400)

    timeout = _check_timeout(data.get("timeout", CHECK_TIMEOUT_DEFAULT))
    headers = {}
    api_key = data.get("api_key")
    if isinstance(api_key, str) and api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=state.use_proxy_env) as client:
            resp = await client.get(f"{base_url}/models", headers=headers)
    except httpx.TimeoutException:
        return JSONResponse({"ok": False, "latency_ms": _latency_ms(start), "error": f"Timed out (> {timeout:.1f}s)"})
    except Exception as e:
        return JSONResponse({"ok": False, "latency_ms": _latency_ms(start), "error": str(e) or type(e).__name__})

    ok = resp.status_code == 200
    return JSONResponse({
        "ok": ok,
        "latency_ms": _latency_ms(start),
        "status_code": resp.status_code,
        "error": None if ok else f"HTTP {resp.status_code}"
    })
