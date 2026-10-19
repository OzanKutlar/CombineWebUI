"""The CLI conversation engine: prompts in, clipboard copies out, replies back.

It is pure apart from token counting. Every operation returns (level, message)
report pairs and leaves the clipboard, the editor and the disk to commands.py,
the same split Translator keeps between its pipeline and its console.

The web chat stands in for the provider's prompt cache:

* A new copy holds only what the web chat has not seen. Prunes on messages it
  already has are held, because pasting can never remove them from it.
* A full copy starts a fresh web chat with every desired prune applied, the
  CLI's equivalent of a model switch in the web UI.
* Under the deferred policy, held prunes become due once the web chat cools
  (TTL since the last reply) or nears its context limit, and copies warn.
  The immediate policy, or flush, makes the next copy full on its own.

Sends are recorded only when the reply comes back, from the paths captured at
copy time, so swapping between variants before pasting costs nothing.
"""
import time

from src.cli.formatting import format_messages
from src.prompt_parser import scan_file_blocks_for_text
from src.prune_cache import (
    CONTEXT_PRESSURE_RATIO,
    MODE_COMMIT,
    MODE_WARM,
    materialize,
    plan_sent_paths,
    read_sent_paths,
    record_send,
    request_prune_commit,
    warm_age,
)
from src.prune_core import (
    count_tokens,
    desired_prune_paths,
    handle_prune_payload,
    normalize_path,
    read_baseline,
    rebuild_message_content,
    restore_all_manual,
    restore_pruned_from_index,
    set_model_prune_active,
    set_prune_state,
)

VARIANT_NEW = 'new'
VARIANT_FULL = 'full'
VARIANTS = (VARIANT_NEW, VARIANT_FULL)
DUE_IMMEDIATE = 'immediate'
DUE_FLUSH = 'flush'
DUE_PRESSURE = 'context-pressure'
DUE_COLD = 'cold'
AUTO_FULL_REASONS = (DUE_IMMEDIATE, DUE_FLUSH)
DUE_TEXT = {
    DUE_IMMEDIATE: 'this label uses the immediate policy',
    DUE_FLUSH: 'flush was requested',
    DUE_PRESSURE: 'the web chat is near its context limit',
    DUE_COLD: 'the web chat has cooled',
}
EDIT_RESET_FIELDS = ('modelPrunedPaths', 'modelPruneActive', 'prunedContent', 'sentPrunes')
PRUNING_VERBS = ('Pruned', 'Applied')
RESTORING_VERBS = ('Restored', 'Lifted')


def now_ms():
    return int(time.time() * 1000)


def format_tokens(value):
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return '0'
    if number >= 1_000_000:
        return f'{number / 1_000_000:.1f}M'
    if number >= 1_000:
        return f'{number / 1_000:.1f}k'
    return str(number)


def _plural(count, word):
    return f'{count} {word}' + ('' if count == 1 else 's')


def _is_user(msg):
    return isinstance(msg, dict) and msg.get('role') == 'user' and isinstance(msg.get('content'), str)


class Thread:
    """One conversation plus the label (web chat) it is being pasted into."""

    def __init__(self, conv, profile, identity_prefs=None):
        if not isinstance(conv, dict):
            raise ValueError('A conversation must be a JSON object.')
        if not isinstance(conv.get('messages'), list):
            conv['messages'] = []
        self.conv = conv
        self.profile = profile
        self.identity_prefs = identity_prefs if isinstance(identity_prefs, dict) else {}
        self._cli()['label'] = profile.label

    # ------------------------------------------------------------------
    # State access
    # ------------------------------------------------------------------

    @property
    def messages(self):
        return self.conv['messages']

    @property
    def label(self):
        return self.profile.label

    @property
    def title(self):
        for key in ('title', 'name'):
            value = self.conv.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return 'Untitled chat'

    def _cli(self):
        state = self.conv.get('cli')
        if not isinstance(state, dict):
            state = {}
            self.conv['cli'] = state
        return state

    def _chats(self):
        state = self._cli()
        chats = state.get('chats')
        if not isinstance(chats, dict):
            chats = {}
            state['chats'] = chats
        return chats

    def chat(self):
        """This label's web chat state, or None when nothing was pasted into one yet."""
        chat = self._chats().get(self.label)
        if not isinstance(chat, dict) or not isinstance(chat.get('upto'), int):
            return None
        chat['upto'] = max(0, min(chat['upto'], len(self.messages)))
        if not isinstance(chat.get('tokens'), int):
            chat['tokens'] = 0
        return chat

    def set_profile(self, profile):
        self.profile = profile
        self._cli()['label'] = profile.label

    def awaiting_reply(self):
        return bool(self.messages) and _is_user(self.messages[-1])

    def forget_copy(self):
        self._cli().pop('lastCopy', None)

    def _touch(self, now):
        self.conv['updatedAt'] = now

    def _mark_warm(self, now):
        warmth = self.conv.get('cacheWarmth')
        if not isinstance(warmth, dict):
            warmth = {}
            self.conv['cacheWarmth'] = warmth
        warmth[self.label] = now

    def _is_current_copy(self, last):
        return (isinstance(last, dict) and last.get('count') == len(self.messages)
                and last.get('label') == self.label)

    # ------------------------------------------------------------------
    # Prompts
    # ------------------------------------------------------------------

    def add_user(self, text, now):
        """Appends a prompt. Returns (added, reports)."""
        if not isinstance(text, str) or not text.strip():
            return False, [('warn', 'The prompt is empty.')]
        if self.awaiting_reply():
            return False, [('warn', 'The last prompt has no reply yet. Record one with [bold cyan]reply[/bold cyan], '
                                    'change it with [bold cyan]edit last[/bold cyan], or drop it with [bold cyan]undo[/bold cyan].')]
        self.messages.append({'role': 'user', 'content': text, 'ts': now})
        self.forget_copy()
        self._touch(now)
        return True, []

    def editable_last(self):
        """The unpruned text of the last prompt while it has no reply, else None."""
        return read_baseline(self.messages[-1]) if self.awaiting_reply() else None

    def edit_last(self, text, now):
        """Replaces the last unanswered prompt. Manual prunes are re-applied. Returns (changed, reports)."""
        if not self.awaiting_reply():
            return False, [('warn', 'Only a prompt without a reply can be edited. Run [bold cyan]undo[/bold cyan] first to drop its reply.')]
        if not isinstance(text, str) or not text.strip():
            return False, [('warn', 'The edited prompt is empty, so nothing changed.')]
        msg = self.messages[-1]
        if text == read_baseline(msg):
            return False, [('info', 'No changes.')]
        for field in EDIT_RESET_FIELDS:
            msg.pop(field, None)
        msg['content'] = text
        msg['originalContent'] = text
        rebuild_message_content(msg)
        chat = self.chat()
        if chat is not None and chat['upto'] >= len(self.messages):
            chat['upto'] = len(self.messages) - 1
        self.forget_copy()
        self._touch(now)
        return True, [('ok', 'Prompt updated.')]

    def undo(self):
        """Removes the last message. Undoing a reply lifts the AI prunes it made."""
        if not self.messages:
            return [('warn', 'Nothing to undo.')]
        index = len(self.messages) - 1
        msg = self.messages[index]
        lifted = restore_pruned_from_index(self.messages, index - 1)
        self.messages.pop()
        self.forget_copy()
        is_reply = isinstance(msg, dict) and msg.get('role') == 'assistant'
        chat = self.chat()
        if chat is not None and is_reply:
            chat['tokens'] = max(0, chat['tokens'] - count_tokens(msg.get('content')))
        reports = [('ok', 'Removed the last reply.' if is_reply else 'Removed the last prompt.')]
        if lifted:
            messages = _plural(lifted, 'message')
            reports.append(('info', f'Lifted the AI prunes it made on {messages}.'))
        if is_reply and chat is not None:
            reports.append(('dim', 'Regenerate in the web chat, copy the new reply and run [bold cyan]reply[/bold cyan].'))
        return reports

    # ------------------------------------------------------------------
    # Web chat state
    # ------------------------------------------------------------------

    def due_reason(self, chat, age):
        """Why held prunes should apply now, or None while the web chat is warm."""
        if self.profile.immediate:
            return DUE_IMMEDIATE
        if self.conv.get('pruneCommitRequested') is True:
            return DUE_FLUSH
        limit = self.profile.context_limit
        if chat is not None and limit > 0 and chat['tokens'] >= limit * CONTEXT_PRESSURE_RATIO:
            return DUE_PRESSURE
        if age is None or age >= self.profile.cache_ttl_seconds * 1000:
            return DUE_COLD
        return None

    def held(self, upto):
        """{message index: {path: reason}} for desired prunes the web chat got unpruned."""
        held = {}
        for index, msg in enumerate(self.messages[:upto]):
            if not _is_user(msg):
                continue
            last = read_sent_paths(msg, self.label)
            if last is None:
                continue
            sent = {normalize_path(path) for path in last}
            pending = {key: reason for key, reason in desired_prune_paths(msg).items() if key not in sent}
            if pending:
                held[index] = pending
        return held

    def restored(self, upto):
        """Files the web chat got pruned that are no longer pruned (so it lacks them)."""
        count = 0
        for msg in self.messages[:upto]:
            if not _is_user(msg):
                continue
            desired = desired_prune_paths(msg)
            for path in read_sent_paths(msg, self.label) or []:
                if normalize_path(path) not in desired:
                    count += 1
        return count

    def _held_tokens(self, held):
        total = 0
        for index, keys in held.items():
            for block in scan_file_blocks_for_text(read_baseline(self.messages[index])):
                if not block['isPruned'] and normalize_path(block['path']) in keys:
                    total += count_tokens(block['content'])
        return total

    def chat_info(self, now):
        chat = self.chat()
        upto = chat['upto'] if chat is not None else 0
        age = warm_age(self.conv, self.label, now) if chat is not None else None
        ttl_ms = self.profile.cache_ttl_seconds * 1000
        held = self.held(upto)
        return {
            'exists': chat is not None,
            'upto': upto,
            'tokens': chat['tokens'] if chat is not None else 0,
            'age_ms': age,
            'warm': age is not None and age < ttl_ms,
            'remaining_ms': max(0, ttl_ms - age) if age is not None else 0,
            'due': self.due_reason(chat, age) if chat is not None else None,
            'held': held,
            'held_count': sum(len(keys) for keys in held.values()),
            'held_tokens': self._held_tokens(held),
            'restored': self.restored(upto),
            'new_count': len(self.messages) - upto,
            'commit_requested': self.conv.get('pruneCommitRequested') is True,
        }

    # ------------------------------------------------------------------
    # Copies
    # ------------------------------------------------------------------

    def render_variant(self, variant, count, start):
        """(text, outgoing, message count) for the first count messages."""
        items = self.messages[:count]
        mode = MODE_COMMIT if variant == VARIANT_FULL else MODE_WARM
        outgoing = materialize(items, plan_sent_paths(items, self.label, mode))
        part = outgoing['messages'] if variant == VARIANT_FULL else outgoing['messages'][start:]
        return format_messages(part, self.label, self.identity_prefs), outgoing, len(part)

    def _choose_variant(self, requested, info):
        if requested == VARIANT_FULL:
            return VARIANT_FULL, []
        if not info['exists']:
            note = [('dim', 'No web chat for this label yet, so the full conversation was copied.')] if requested else []
            return VARIANT_FULL, note
        if info['new_count'] <= 0:
            return None, [('warn', 'The web chat already has every message. Use [bold cyan]copy full[/bold cyan] to start a fresh one.')]
        held = info['held_count']
        if requested is None and held and info['due'] in AUTO_FULL_REASONS:
            reason = DUE_TEXT[info['due']]
            prunes = _plural(held, 'held prune')
            return VARIANT_FULL, [('info', f'Copied the full conversation because {reason}: {prunes} apply in a fresh web chat.')]
        return VARIANT_NEW, []

    def _new_copy_notes(self, info):
        notes = []
        held = info['held_count']
        if held:
            prunes = _plural(held, 'prune')
            saving = format_tokens(info['held_tokens'])
            due = info['due']
            if due:
                notes.append(('warn', f'{prunes} due because {DUE_TEXT[due]}. Start a fresh web chat and run '
                                      f'[bold cyan]swap[/bold cyan] to save ≈{saving} tokens.'))
            else:
                notes.append(('dim', f'{prunes} held while the web chat is warm (≈{saving} tokens).'))
        if info['restored']:
            files = _plural(info['restored'], 'restored file')
            notes.append(('warn', f'{files} reached this web chat pruned and are still missing from it. '
                                  'Use [bold cyan]swap[/bold cyan] for a fresh chat that has them.'))
        return notes

    def _stage_copy(self, variant, start, now, reports):
        count = len(self.messages)
        text, outgoing, sent = self.render_variant(variant, count, start)
        tokens = count_tokens(text)
        self._cli()['lastCopy'] = {'variant': variant, 'count': count, 'start': start, 'label': self.label,
                                   'at': now, 'tokens': tokens, 'sentPaths': outgoing['sentPaths']}
        where = 'a fresh web chat' if variant == VARIANT_FULL else 'the same web chat'
        messages = _plural(sent, 'message')
        size = format_tokens(tokens)
        reports.append(('ok', f'Copied [bold]{variant}[/bold] ({messages}, ≈{size} tokens). Paste it into {where}.'))
        return text, variant, reports

    def prepare_copy(self, requested, now):
        """(text, variant, reports). text is None when there is nothing to copy."""
        if requested is not None and requested not in VARIANTS:
            return None, None, [('warn', 'Usage: copy [new|full]')]
        if not self.messages:
            return None, None, [('warn', 'This chat has no messages yet. Add a prompt with paste, say or edit.')]
        info = self.chat_info(now)
        variant, reports = self._choose_variant(requested, info)
        if variant is None:
            return None, None, reports
        if variant == VARIANT_NEW:
            reports += self._new_copy_notes(info)
        return self._stage_copy(variant, info['upto'], now, reports)

    def swap(self, now):
        """Toggles the pending copy between new and full. Returns (text, variant, reports)."""
        last = self._cli().get('lastCopy')
        if not self._is_current_copy(last):
            return None, None, [('warn', 'Nothing to swap. Run [bold cyan]copy[/bold cyan] first.')]
        if last.get('variant') == VARIANT_NEW:
            return self._stage_copy(VARIANT_FULL, 0, now, [])
        info = self.chat_info(now)
        if not info['exists'] or info['new_count'] <= 0:
            return None, None, [('warn', 'There is no web chat to continue, so only the full conversation fits.')]
        return self._stage_copy(VARIANT_NEW, info['upto'], now, self._new_copy_notes(info))

    # ------------------------------------------------------------------
    # Replies
    # ------------------------------------------------------------------

    def _record_send(self, now, reports):
        """Records the copy the prompt went out in. False when there is nothing to record against."""
        count = len(self.messages)
        last = self._cli().get('lastCopy')
        chat = self.chat()
        if self._is_current_copy(last):
            sent_paths = last.get('sentPaths') if isinstance(last.get('sentPaths'), list) else []
            tokens = last.get('tokens') if isinstance(last.get('tokens'), int) else 0
            if last.get('variant') == VARIANT_FULL or chat is None:
                record_send(self.conv, self.messages, self.label, {'sentPaths': sent_paths}, now)
                self._chats()[self.label] = {'upto': count, 'tokens': tokens, 'startedAt': now}
            else:
                start = last.get('start') if isinstance(last.get('start'), int) else chat['upto']
                record_send(self.conv, self.messages, self.label, {'sentPaths': sent_paths}, now, start=start)
                chat['upto'] = count
                chat['tokens'] += tokens
            self.forget_copy()
            return True
        if chat is not None and chat['upto'] >= count:
            self._mark_warm(now)
            reports.append(('dim', 'Recorded as a regenerated reply: the web chat already had this prompt.'))
            return True
        reports.append(('warn', 'Copy the prompt first ([bold cyan]copy[/bold cyan]), paste it into the web chat, '
                                'then copy the reply and run [bold cyan]reply[/bold cyan].'))
        return False

    def record_reply(self, text, now):
        """(message or None, reports). Applies any PRUNE payload in the reply."""
        clean = text.strip() if isinstance(text, str) else ''
        if not clean:
            return None, [('warn', 'The clipboard is empty.')]
        if not self.awaiting_reply():
            return None, [('warn', 'There is no unanswered prompt. Add one first, or [bold cyan]undo[/bold cyan] the last reply to replace it.')]
        reports = []
        if not self._record_send(now, reports):
            return None, reports
        msg = {'role': 'assistant', 'content': clean, 'model': self.label, 'ts': now}
        self.messages.append(msg)
        chat = self.chat()
        if chat is not None:
            chat['upto'] = len(self.messages)
            chat['tokens'] += count_tokens(clean)
        info = handle_prune_payload(msg, self.messages)
        if info:
            reports += self._prune_reports(info, now)
        self._touch(now)
        return msg, reports

    def _prune_reports(self, info, now):
        items = [item for item in info.get('items') or [] if isinstance(item, dict)]
        dropped = [entry for item in items for entry in item.get('dropped') or []]
        kept = sum(len(item.get('kept') or []) for item in items)
        if not dropped:
            return [('info', f'The reply has a PRUNE payload that keeps every file ({kept} kept).')]
        if not info.get('targetIndices'):
            return [('warn', 'The PRUNE payload names files no earlier prompt carries, so nothing was pruned.')]
        files = _plural(len(dropped), 'file')
        saved = format_tokens(sum(int(entry.get('tokens') or 0) for entry in dropped))
        reports = [('ok', f'AI pruned {files} (≈{saved} tokens).')]
        state = self.chat_info(now)
        if state['held_count'] and state['due'] in AUTO_FULL_REASONS:
            reports.append(('info', 'The next copy starts a fresh web chat with them removed.'))
        elif state['held_count']:
            reports.append(('dim', 'Held: the web chat already has them. They apply in a fresh chat (swap or copy full), '
                                   'and are flagged as due once the web chat cools.'))
        return reports

    # ------------------------------------------------------------------
    # Pruning
    # ------------------------------------------------------------------

    def _after_prune_change(self, touched, verb, now):
        if not touched:
            return [('warn', 'Nothing changed: no message carries those files in another state.')]
        messages = _plural(touched, 'message')
        reports = [('ok', f'{verb} files in {messages}.')]
        info = self.chat_info(now)
        if verb in PRUNING_VERBS and info['held_count']:
            reports.append(('dim', 'Held in the current web chat, which already has these files. '
                                   'They apply in a fresh chat (swap or copy full).'))
        if verb in RESTORING_VERBS and info['restored']:
            reports.append(('warn', 'The current web chat got these files pruned. Use [bold cyan]copy full[/bold cyan] '
                                    'or [bold cyan]swap[/bold cyan] for a fresh chat that has them.'))
        if self._is_current_copy(self._cli().get('lastCopy')):
            reports.append(('dim', 'The clipboard still holds the earlier copy; run [bold cyan]copy[/bold cyan] to refresh it.'))
        return reports

    def prune(self, keys, reason, now):
        return self._after_prune_change(set_prune_state(self.messages, keys, True, reason), 'Pruned', now)

    def restore(self, keys, now):
        return self._after_prune_change(set_prune_state(self.messages, keys, False), 'Restored', now)

    def restore_manual(self, now):
        return self._after_prune_change(restore_all_manual(self.messages), 'Restored', now)

    def set_ai_prunes(self, active, now):
        """Applies or lifts every prune the AI asked for (the web UI's prune card toggle)."""
        touched = 0
        for msg in self.messages:
            info = msg.get('pruneInfo') if isinstance(msg, dict) and msg.get('role') == 'assistant' else None
            if isinstance(info, dict):
                info['isPruned'] = bool(active)
                touched += set_model_prune_active(self.messages, info.get('targetIndices'), active)
        if not touched:
            return [('info', 'No reply in this chat asked for a prune.')]
        return self._after_prune_change(touched, 'Applied' if active else 'Lifted', now)

    def flush(self, now):
        """The web UI's Apply now: the next copy is full with every prune applied."""
        info = self.chat_info(now)
        if not info['held_count']:
            return [('info', 'No prunes are held, so there is nothing to flush.')]
        if not request_prune_commit(self.conv):
            return [('fail', 'Could not mark the chat for a fresh copy.')]
        prunes = _plural(info['held_count'], 'held prune')
        return [('ok', f'The next copy starts a fresh web chat with {prunes} applied.')]

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def snapshot(self, now):
        """Everything the status lines need, computed once per command."""
        info = self.chat_info(now)
        variant = None
        count = tokens = 0
        if self.messages:
            variant = self._choose_variant(None, info)[0]
        if variant is not None:
            text, _, count = self.render_variant(variant, len(self.messages), info['upto'])
            tokens = count_tokens(text)
        last = self._cli().get('lastCopy')
        age = info['age_ms']
        return {
            'id': str(self.conv.get('id') or ''),
            'title': self.title,
            'label': self.label,
            'messages': len(self.messages),
            'awaiting': self.awaiting_reply(),
            'copied': last.get('variant') if self._is_current_copy(last) else None,
            'info': info,
            'next_variant': variant,
            'next_count': count,
            'next_tokens': tokens,
            'stamp_ms': now - age if age is not None else None,
            'ttl_ms': self.profile.cache_ttl_seconds * 1000,
            'limit': self.profile.context_limit,
            'policy': self.profile.prune_policy,
        }
