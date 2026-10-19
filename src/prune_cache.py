"""Python port of pages/static/js/pruneCache.js.

A user message's prune set (model + manual) is the desired state and its
content always reflects it. What a cache scope is sent is resolved here.
conv['cacheWarmth'][scope] is the last send time in milliseconds and
msg['sentPrunes'][scope] the paths sent pruned for that message, exactly as
the web UI stores them. CLI mode uses its label as the scope.

Everything is pure: the caller passes the clock and the policy, a dict of
{'immediate': bool, 'ttl_ms': int, 'limit': int}.
"""
import math

from src.prune_core import build_content_for_paths, count_tokens, desired_prune_paths, normalize_path

MODE_WARM = 'warm'
MODE_COLD = 'cold'
MODE_COMMIT = 'commit'
REASON_PRESSURE = 'context-pressure'

DEFAULT_CACHE_TTL_SECONDS = 300
MIN_CACHE_TTL_SECONDS = 10
MAX_CACHE_TTL_SECONDS = 86400
CONTEXT_PRESSURE_RATIO = 0.85
MAX_CACHE_SCOPES = 16


def clamp_cache_ttl(value):
    if value is None or value == '':
        return DEFAULT_CACHE_TTL_SECONDS
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_CACHE_TTL_SECONDS
    if not math.isfinite(number):
        return DEFAULT_CACHE_TTL_SECONDS
    return int(min(MAX_CACHE_TTL_SECONDS, max(MIN_CACHE_TTL_SECONDS, round(number))))


def _is_user(msg):
    return isinstance(msg, dict) and msg.get('role') == 'user' and isinstance(msg.get('content'), str)


def _as_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def _policy(policy):
    return policy if isinstance(policy, dict) else {}


def warm_age(conv, scope, now):
    """Milliseconds since the last send to scope, or None if it was never sent."""
    warmth = conv.get('cacheWarmth') if isinstance(conv, dict) else None
    if not isinstance(warmth, dict):
        return None
    stamp = _as_number(warmth.get(scope))
    if stamp <= 0:
        return None
    age = now - stamp
    return age if age >= 0 else None


def resolve_mode(conv, scope, policy, now):
    rules = _policy(policy)
    if rules.get('immediate') or conv.get('pruneCommitRequested') is True:
        return MODE_COMMIT
    age = warm_age(conv, scope, now)
    return MODE_WARM if age is not None and age < rules.get('ttl_ms', 0) else MODE_COLD


def read_sent_paths(msg, scope):
    """Paths last sent pruned to scope for msg, or None when msg never reached it."""
    sent = msg.get('sentPrunes') if isinstance(msg, dict) else None
    if not isinstance(sent, dict) or not isinstance(sent.get(scope), list):
        return None
    return [path for path in sent[scope] if isinstance(path, str) and path]


def plan_sent_paths(messages, scope, mode):
    """One entry per message: None for non-user messages, else {'desired', 'sent'}.

    Once a warm prefix is broken (a restore, or a message the scope never saw),
    every later message gets its desired set, because the cache is lost from
    there anyway.
    """
    plan = []
    broken = mode != MODE_WARM
    for msg in messages:
        if not _is_user(msg):
            plan.append(None)
            continue
        desired = desired_prune_paths(msg)
        sent = desired
        if not broken:
            last = read_sent_paths(msg, scope)
            if last is None:
                broken = True
            else:
                sent = {}
                for path in last:
                    key = normalize_path(path)
                    if key in desired:
                        sent[key] = desired[key]
                if len(sent) != len(last):
                    broken = True
        plan.append({'desired': desired, 'sent': sent})
    return plan


def materialize(messages, plan):
    """Outgoing copies for a plan. Unchanged messages are the stored objects."""
    result = {'messages': [], 'sentPaths': [], 'sentPrunedIdx': [], 'pendingCount': 0, 'tokens': 0}
    for index, msg in enumerate(messages):
        entry = plan[index] if index < len(plan) else None
        if entry is None:
            result['messages'].append(msg)
            result['sentPaths'].append(None)
            result['tokens'] += count_tokens(msg.get('content') if isinstance(msg, dict) else '')
            continue
        complete = len(entry['sent']) == len(entry['desired'])
        content = msg['content'] if complete else build_content_for_paths(msg, entry['sent'])
        result['messages'].append(msg if complete else dict(msg, content=content))
        keys = list(entry['sent'].keys())
        result['sentPaths'].append(keys)
        if keys:
            result['sentPrunedIdx'].append(index)
        result['pendingCount'] += len(entry['desired']) - len(entry['sent'])
        result['tokens'] += count_tokens(content)
    return result


def build_outgoing_messages(conv, messages, scope, policy, now):
    """What messages should look like when sent to scope now, plus the reason."""
    items = messages if isinstance(messages, list) else []
    if not isinstance(conv, dict) or not isinstance(scope, str) or not scope:
        return dict(materialize(items, plan_sent_paths(items, '', MODE_COMMIT)), reason=MODE_COMMIT)
    mode = resolve_mode(conv, scope, policy, now)
    result = materialize(items, plan_sent_paths(items, scope, mode))
    if mode != MODE_WARM or result['pendingCount'] == 0:
        return dict(result, reason=mode)
    limit = _as_number(_policy(policy).get('limit'))
    if limit <= 0 or result['tokens'] <= limit * CONTEXT_PRESSURE_RATIO:
        return dict(result, reason=mode)
    return dict(materialize(items, plan_sent_paths(items, scope, MODE_COMMIT)), reason=REASON_PRESSURE)


def _trim_scopes(warmth):
    keys = list(warmth.keys())
    if len(keys) <= MAX_CACHE_SCOPES:
        return
    keys.sort(key=lambda key: _as_number(warmth[key]))
    for key in keys[:len(keys) - MAX_CACHE_SCOPES]:
        del warmth[key]


def _write_sent_paths(msg, scope, keys, warmth):
    sent = msg.get('sentPrunes')
    if not isinstance(sent, dict):
        sent = {}
        msg['sentPrunes'] = sent
    sent[scope] = list(keys)
    # Scopes evicted from the warmth map can never be warm again.
    for stale in [key for key in sent if key not in warmth]:
        del sent[stale]


def record_send(conv, messages, scope, outgoing, now, start=0):
    """Records that outgoing was sent to scope at now, for messages from start on.

    messages must be the stored message objects, not the outgoing copies.
    Consumes any pending commit request.
    """
    if not isinstance(conv, dict) or not isinstance(scope, str) or not scope:
        return False
    sent_paths = outgoing.get('sentPaths') if isinstance(outgoing, dict) else None
    if not isinstance(sent_paths, list) or not isinstance(messages, list):
        return False
    warmth = conv.get('cacheWarmth')
    if not isinstance(warmth, dict):
        warmth = {}
        conv['cacheWarmth'] = warmth
    warmth[scope] = now
    _trim_scopes(warmth)
    for index, msg in enumerate(messages):
        if index < start or index >= len(sent_paths):
            continue
        keys = sent_paths[index]
        if isinstance(keys, list) and _is_user(msg):
            _write_sent_paths(msg, scope, keys, warmth)
    conv.pop('pruneCommitRequested', None)
    return True


def request_prune_commit(conv):
    """Marks the thread so the next send commits every pending prune."""
    if not isinstance(conv, dict):
        return False
    conv['pruneCommitRequested'] = True
    return True
