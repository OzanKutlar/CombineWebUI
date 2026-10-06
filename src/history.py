import os
import json
import re
import stat
import time
from pathlib import Path
from src.config import (
    APP_DIR,
    CHATS_PATH,
    CHATS_DIR,
    CHATS_INDEX_PATH,
    CHATS_CONV_DIR,
    logger
)
from src.events import broadcast_event

CONV_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,128}$')

# On Windows, os.replace onto an existing file fails with WinError 5 while any
# other process (AV, indexer, backup agent) holds a handle to the destination
# without FILE_SHARE_DELETE. Those holds are short, so a bounded retry clears
# almost all of them.
REPLACE_ATTEMPTS = 5
REPLACE_BACKOFF_SECONDS = (0.02, 0.04, 0.08, 0.16)

# Orphaned temp files left behind by older builds that did not clean up on
# failure. Swept lazily rather than on every save.
STALE_TEMP_AGE_SECONDS = 60
SWEEP_INTERVAL_SECONDS = 60
MAX_TEMP_SWEEP = 500

_last_sweep_ts = 0.0


def sanitize_conv_id(raw_id: str) -> str:
    if not isinstance(raw_id, str):
        return ""
    clean = raw_id.strip()
    if CONV_ID_RE.match(clean) and clean not in (".", ".."):
        return clean
    return ""


def _clear_readonly(dest_path: Path) -> None:
    """Best effort. os.replace also fails with WinError 5 on a read-only target."""
    try:
        if dest_path.exists():
            os.chmod(dest_path, stat.S_IWRITE | stat.S_IREAD)
    except Exception:
        pass


def _try_replace(temp_path: Path, dest_path: Path):
    """Bounded retry around the rename. Returns (ok, last_error)."""
    last_error = None
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            temp_path.replace(dest_path)
            if attempt > 0:
                logger.debug(f"Replace to {dest_path} succeeded on attempt {attempt + 1}")
            return True, None
        except OSError as e:
            last_error = e
            if attempt == 0:
                _clear_readonly(dest_path)
            if attempt < len(REPLACE_BACKOFF_SECONDS):
                time.sleep(REPLACE_BACKOFF_SECONDS[attempt])
    return False, last_error


def _write_in_place(dest_path: Path, payload: str) -> bool:
    """Last resort. NOT crash-atomic: a failure mid-write truncates the file."""
    try:
        dest_path.write_text(payload, encoding="utf-8")
        return True
    except Exception as e:
        logger.error(f"In-place write to {dest_path} failed: {e}")
        return False


def _cleanup_temp(temp_path: Path) -> None:
    try:
        if temp_path.exists():
            temp_path.unlink()
    except Exception as e:
        logger.warn(f"Could not remove temp file {temp_path}: {e}")


def sweep_stale_temps(force: bool = False) -> None:
    """Removes temp files orphaned by earlier failed writes. Bounded per call."""
    global _last_sweep_ts
    now = time.time()
    if not force and (now - _last_sweep_ts) < SWEEP_INTERVAL_SECONDS:
        return
    _last_sweep_ts = now

    if not CHATS_CONV_DIR.exists():
        return

    removed = 0
    try:
        for temp in CHATS_CONV_DIR.glob("*.json.tmp.*"):
            if removed >= MAX_TEMP_SWEEP:
                break
            try:
                if now - temp.stat().st_mtime < STALE_TEMP_AGE_SECONDS:
                    continue
                temp.unlink()
                removed += 1
            except Exception:
                continue
    except Exception as e:
        logger.warn(f"Failed sweeping stale temp files: {e}")
        return

    if removed > 0:
        logger.info(f"Removed {removed} stale temp file(s) from {CHATS_CONV_DIR}")


def atomic_write_json(file_path: Path, data) -> bool:
    try:
        payload = json.dumps(data, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to serialize payload for {file_path}: {e}")
        return False

    temp_path = file_path.with_name(f"{file_path.name}.tmp.{time.time_ns()}")
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path.write_text(payload, encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed writing temp file for {file_path}: {e}")
        _cleanup_temp(temp_path)
        return False

    try:
        ok, last_error = _try_replace(temp_path, file_path)
        if ok:
            return True
        logger.warn(
            f"Atomic replace to {file_path} failed after {REPLACE_ATTEMPTS} attempts "
            f"({last_error}). Falling back to a non-atomic in-place write."
        )
        return _write_in_place(file_path, payload)
    finally:
        _cleanup_temp(temp_path)


def ensure_history_dirs():
    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    CHATS_CONV_DIR.mkdir(parents=True, exist_ok=True)
    sweep_stale_temps()


def migrate_legacy_if_needed():
    ensure_history_dirs()
    if CHATS_INDEX_PATH.exists():
        return
    if not CHATS_PATH.exists():
        atomic_write_json(CHATS_INDEX_PATH, {"version": 2, "folders": [], "order": []})
        return

    try:
        raw_text = CHATS_PATH.read_text(encoding="utf-8").strip()
        if not raw_text:
            atomic_write_json(CHATS_INDEX_PATH, {"version": 2, "folders": [], "order": []})
            return

        legacy_data = json.loads(raw_text)
        folders = []
        convs = []

        if isinstance(legacy_data, list):
            convs = legacy_data
        elif isinstance(legacy_data, dict):
            folders = legacy_data.get("folders", [])
            convs = legacy_data.get("conversations", [])

        clean_folders = []
        if isinstance(folders, list):
            for f in folders:
                if isinstance(f, dict) and f.get("id"):
                    clean_folders.append({
                        "id": str(f["id"]),
                        "name": str(f.get("name", "Untitled Folder")),
                        "parentId": f.get("parentId") if f.get("parentId") else None,
                        "collapsed": bool(f.get("collapsed", False))
                    })

        order = []
        if isinstance(convs, list):
            for c in convs:
                if not isinstance(c, dict):
                    continue
                raw_id = str(c.get("id", f"conv_{int(time.time()*1000)}"))
                safe_id = sanitize_conv_id(raw_id) or f"conv_{int(time.time()*1000)}_{len(order)}"
                c["id"] = safe_id
                if "folderId" not in c:
                    c["folderId"] = None
                conv_file = CHATS_CONV_DIR / f"{safe_id}.json"
                atomic_write_json(conv_file, c)
                order.append(safe_id)

        index_payload = {
            "version": 2,
            "folders": clean_folders,
            "order": order
        }
        atomic_write_json(CHATS_INDEX_PATH, index_payload)

        bak_name = f"chats.json.migrated-{int(time.time())}.bak"
        bak_path = APP_DIR / bak_name
        try:
            CHATS_PATH.rename(bak_path)
            logger.info(f"Successfully migrated legacy chat history. Backup created at {bak_path}")
        except Exception as be:
            logger.warn(f"Could not rename legacy chats.json: {be}")

    except Exception as e:
        logger.error(f"Failed to migrate legacy chat history from {CHATS_PATH}: {e}")
        atomic_write_json(CHATS_INDEX_PATH, {"version": 2, "folders": [], "order": []})


def get_history_index() -> dict:
    migrate_legacy_if_needed()
    if not CHATS_INDEX_PATH.exists():
        return {"version": 2, "folders": [], "order": []}
    try:
        return json.loads(CHATS_INDEX_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        logger.error(f"Failed reading history index: {e}")
        return {"version": 2, "folders": [], "order": []}


def save_history_index(data: dict, notify: bool = True) -> bool:
    ensure_history_dirs()
    folders = data.get("folders", []) if isinstance(data, dict) else []
    order = data.get("order", []) if isinstance(data, dict) else []
    payload = {
        "version": 2,
        "folders": folders,
        "order": order
    }
    ok = atomic_write_json(CHATS_INDEX_PATH, payload)
    if ok and notify:
        broadcast_event("index_updated", {"folders": folders, "order": order})
    return ok


def get_conversation(conv_id: str):
    safe_id = sanitize_conv_id(conv_id)
    if not safe_id:
        return None
    conv_path = CHATS_CONV_DIR / f"{safe_id}.json"
    if not conv_path.exists():
        return None
    try:
        return json.loads(conv_path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.error(f"Failed reading conversation {safe_id}: {e}")
        return None


def save_conversation(conv: dict) -> bool:
    ensure_history_dirs()
    if not isinstance(conv, dict):
        return False
    raw_id = str(conv.get("id", ""))
    safe_id = sanitize_conv_id(raw_id)
    if not safe_id:
        return False
    conv["id"] = safe_id
    conv_path = CHATS_CONV_DIR / f"{safe_id}.json"
    success = atomic_write_json(conv_path, conv)
    if not success:
        return False

    idx = get_history_index()
    order = idx.get("order", [])
    if safe_id not in order:
        order.insert(0, safe_id)
        idx["order"] = order
        save_history_index(idx, notify=False)
    broadcast_event("conv_updated", conv)
    return True


def delete_conversation(conv_id: str) -> bool:
    safe_id = sanitize_conv_id(conv_id)
    if not safe_id:
        return False
    conv_path = CHATS_CONV_DIR / f"{safe_id}.json"
    if conv_path.exists():
        try:
            conv_path.unlink()
        except Exception as e:
            logger.error(f"Failed removing conversation file {conv_path}: {e}")
            return False

    idx = get_history_index()
    order = idx.get("order", [])
    if safe_id in order:
        idx["order"] = [cid for cid in order if cid != safe_id]
        save_history_index(idx, notify=False)
    broadcast_event("conv_deleted", {"id": safe_id})
    return True


def get_all_history() -> dict:
    idx = get_history_index()
    folders = idx.get("folders", [])
    order = idx.get("order", [])

    conversations = []
    seen = set()
    for cid in order:
        safe_id = sanitize_conv_id(cid)
        if not safe_id:
            continue
        conv = get_conversation(safe_id)
        if conv:
            conversations.append(conv)
            seen.add(safe_id)

    if CHATS_CONV_DIR.exists():
        try:
            for f in CHATS_CONV_DIR.glob("*.json"):
                cid = f.stem
                if cid not in seen and sanitize_conv_id(cid):
                    conv = get_conversation(cid)
                    if conv:
                        conversations.append(conv)
                        order.append(cid)
            idx["order"] = order
            save_history_index(idx)
        except Exception as e:
            logger.warn(f"Failed scanning orphan conversations: {e}")

    return {
        "folders": folders,
        "conversations": conversations
    }


def import_bulk_history(data) -> bool:
    ensure_history_dirs()
    folders = []
    convs = []
    if isinstance(data, list):
        convs = data
    elif isinstance(data, dict):
        folders = data.get("folders", [])
        convs = data.get("conversations", [])

    clean_folders = []
    if isinstance(folders, list):
        for f in folders:
            if isinstance(f, dict) and f.get("id"):
                clean_folders.append({
                    "id": str(f["id"]),
                    "name": str(f.get("name", "Untitled Folder")),
                    "parentId": f.get("parentId") if f.get("parentId") else None,
                    "collapsed": bool(f.get("collapsed", False))
                })

    order = []
    if isinstance(convs, list):
        for c in convs:
            if not isinstance(c, dict):
                continue
            raw_id = str(c.get("id", f"conv_{int(time.time()*1000)}"))
            safe_id = sanitize_conv_id(raw_id) or f"conv_{int(time.time()*1000)}_{len(order)}"
            c["id"] = safe_id
            if "folderId" not in c:
                c["folderId"] = None
            conv_path = CHATS_CONV_DIR / f"{safe_id}.json"
            atomic_write_json(conv_path, c)
            order.append(safe_id)

    ok = atomic_write_json(CHATS_INDEX_PATH, {
        "version": 2,
        "folders": clean_folders,
        "order": order
    })
    if ok:
        broadcast_event("history_reloaded", {"folders": clean_folders, "order": order})
    return ok
