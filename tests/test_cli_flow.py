import subprocess
import sys
import unittest
from pathlib import Path

from src.cli.formatting import apply_identity
from src.cli.profiles import Profile
from src.cli.staging import Staging, parse_paste_text
from src.cli.workflow import Thread
from src.prompt_parser import PRUNED_PREFIX
from src.prune_cache import build_outgoing_messages
from src.prune_core import count_tokens, desired_prune_paths, set_prune_state

ROOT = Path(__file__).resolve().parent.parent
T0 = 1_700_000_000_000
TTL_MS = 300_000
SEP = '-' * 35
PRUNE_REPLY = ('Dropping a.py.\n```json\n{"phase": "PRUNE", "files": [{"path": "a.py", "stay": false, '
               '"reason": "unused"}]}\n```')


def file_block(path, body):
    return f'{SEP}\nFILE: {path}\n{SEP}\n```py\n{body}\n```\n\n'


def payload(request='Fix it'):
    return ('--- FILE CONTEXT ---\n' + file_block('a.py', 'x = 1') + file_block('b.py', 'y = 2')
            + f'--- USER REQUEST ---\n{request}\n')


def make_thread(policy='deferred'):
    conv = {'id': 'conv_test', 'title': 'Test', 'messages': []}
    profile = Profile('Claude (web)', prune_policy=policy, cache_ttl_seconds=TTL_MS // 1000)
    return Thread(conv, profile, {'mode': 'off'})


def start_with_prune(thread):
    """Payload copied (full), then a reply that prunes a.py."""
    thread.add_user(payload(), T0)
    thread.prepare_copy(None, T0)
    msg, _ = thread.record_reply(PRUNE_REPLY, T0 + 1000)
    return msg


class CopyFlowTests(unittest.TestCase):
    def test_first_copy_is_full_then_new(self):
        thread = make_thread()
        thread.add_user(payload(), T0)
        _, variant, _ = thread.prepare_copy(None, T0)
        self.assertEqual(variant, 'full')
        self.assertIsNotNone(thread.record_reply('Sure.', T0 + 1000)[0])
        thread.add_user('Next question', T0 + 2000)
        text, variant, _ = thread.prepare_copy(None, T0 + 2000)
        self.assertEqual(variant, 'new')
        self.assertIn('Next question', text)
        self.assertNotIn('x = 1', text)

    def test_reply_needs_a_copy_first(self):
        thread = make_thread()
        thread.add_user('hello', T0)
        msg, _ = thread.record_reply('hi', T0)
        self.assertIsNone(msg)

    def test_prune_is_held_while_warm_and_due_when_cold(self):
        thread = make_thread()
        start_with_prune(thread)
        info = thread.chat_info(T0 + 2000)
        self.assertEqual(info['held_count'], 1)
        self.assertTrue(info['warm'])
        self.assertIsNone(info['due'])
        self.assertEqual(thread.chat_info(T0 + 1000 + TTL_MS + 1)['due'], 'cold')

    def test_swap_toggles_and_full_applies_prunes(self):
        thread = make_thread()
        start_with_prune(thread)
        thread.add_user('Next', T0 + 3000)
        _, variant, _ = thread.prepare_copy(None, T0 + 3000)
        self.assertEqual(variant, 'new')
        text, variant, _ = thread.swap(T0 + 3000)
        self.assertEqual(variant, 'full')
        self.assertIn(PRUNED_PREFIX, text)
        self.assertNotIn('x = 1', text)
        self.assertIn('y = 2', text)
        self.assertEqual(thread.swap(T0 + 3000)[1], 'new')
        thread.swap(T0 + 3000)
        thread.record_reply('ok', T0 + 4000)
        self.assertEqual(thread.chat_info(T0 + 4000)['held_count'], 0)

    def test_immediate_policy_copies_full_when_prunes_are_held(self):
        thread = make_thread('immediate')
        start_with_prune(thread)
        thread.add_user('Next', T0 + 2000)
        self.assertEqual(thread.prepare_copy(None, T0 + 2000)[1], 'full')

    def test_flush_makes_the_next_copy_full(self):
        thread = make_thread()
        start_with_prune(thread)
        self.assertEqual(thread.flush(T0 + 2000)[0][0], 'ok')
        thread.add_user('Next', T0 + 3000)
        self.assertEqual(thread.prepare_copy(None, T0 + 3000)[1], 'full')
        thread.record_reply('ok', T0 + 4000)
        self.assertNotIn('pruneCommitRequested', thread.conv)

    def test_undo_lifts_the_reply_prunes(self):
        thread = make_thread()
        start_with_prune(thread)
        thread.undo()
        self.assertEqual(len(thread.messages), 1)
        self.assertEqual(desired_prune_paths(thread.messages[0]), {})
        self.assertIn('x = 1', thread.messages[0]['content'])

    def test_edit_last_replaces_the_prompt(self):
        thread = make_thread()
        thread.add_user('first', T0)
        thread.prepare_copy(None, T0)
        changed, _ = thread.edit_last('second', T0)
        self.assertTrue(changed)
        text, _, _ = thread.prepare_copy(None, T0)
        self.assertIn('second', text)
        self.assertNotIn('first', text)

    def test_snapshot_estimate_matches_the_copy(self):
        thread = make_thread()
        thread.add_user(payload(), T0)
        snap = thread.snapshot(T0)
        text, variant, _ = thread.prepare_copy(None, T0)
        self.assertEqual(snap['next_variant'], variant)
        self.assertEqual(snap['next_count'], 1)
        self.assertLessEqual(abs(count_tokens(text) - snap['next_tokens']), 20)


class StagingTests(unittest.TestCase):
    def test_unedited_payload_is_byte_for_byte(self):
        raw = payload()
        self.assertEqual(Staging(raw, parse_paste_text(raw)).compose(), raw)

    def test_drop_file_and_change_request(self):
        raw = payload()
        staging = Staging(raw, parse_paste_text(raw))
        self.assertTrue(staging.set_removed('file', 0, True))
        staging.request_text = 'Changed'
        out = staging.compose()
        self.assertNotIn('FILE: a.py', out)
        self.assertIn('FILE: b.py', out)
        self.assertIn('Changed', out)
        self.assertNotIn('Fix it', out)


class CachePortTests(unittest.TestCase):
    def setUp(self):
        self.messages = [{'role': 'user', 'content': payload(), 'sentPrunes': {'scope': []}}]
        set_prune_state(self.messages, ['a.py'], True, 'mine')
        self.conv = {'messages': self.messages, 'cacheWarmth': {'scope': T0}}
        self.policy = {'immediate': False, 'ttl_ms': TTL_MS, 'limit': 0}

    def test_warm_holds_the_prune(self):
        out = build_outgoing_messages(self.conv, self.messages, 'scope', self.policy, T0 + 1000)
        self.assertEqual(out['reason'], 'warm')
        self.assertEqual(out['pendingCount'], 1)
        self.assertIn('x = 1', out['messages'][0]['content'])

    def test_context_pressure_commits(self):
        policy = dict(self.policy, limit=10)
        out = build_outgoing_messages(self.conv, self.messages, 'scope', policy, T0 + 1000)
        self.assertEqual(out['reason'], 'context-pressure')
        self.assertEqual(out['pendingCount'], 0)

    def test_cold_applies_the_prune(self):
        out = build_outgoing_messages(self.conv, self.messages, 'scope', self.policy, T0 + TTL_MS + 1)
        self.assertEqual(out['reason'], 'cold')
        self.assertNotIn('x = 1', out['messages'][0]['content'])


class IdentityTests(unittest.TestCase):
    PROMPT = ('--- SYSTEM INSTRUCTIONS ---\n<identity>\nYou are {{IDENTITY}}, a powerful agentic AI coding assistant.\n'
              '</identity>\n')

    def test_label_fills_the_placeholder(self):
        out = apply_identity(self.PROMPT, 'Claude (web)', {})
        self.assertIn('You are Claude, a powerful agentic AI coding assistant created by Anthropic.', out)

    def test_generic_label_keeps_a_hardcoded_identity(self):
        prompt = '--- SYSTEM INSTRUCTIONS ---\n<identity>\nYou are Gemini, made by Google.\n</identity>\n'
        self.assertEqual(apply_identity(prompt, 'Web chat', {}), prompt)


class BoundaryTests(unittest.TestCase):
    def test_cli_never_imports_the_server_stack(self):
        code = ("import sys, src.cli.repl; "
                "bad = [m for m in ('fastapi', 'uvicorn', 'httpx') if m in sys.modules]; "
                "print(bad); sys.exit(1 if bad else 0)")
        result = subprocess.run([sys.executable, '-c', code], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
