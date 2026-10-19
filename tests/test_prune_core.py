import unittest

from src.prompt_parser import PRUNED_PREFIX
from src.prune_core import (
    desired_prune_paths,
    extract_all_prune_payloads,
    handle_prune_payload,
    rebuild_message_content,
    restore_pruned_from_index,
    safe_json_parse,
    sanitize_reason,
    set_prune_state,
)

SEP = '-' * 35
JSON_REPLY = ('Dropping a.py.\n```json\n{"phase": "PRUNE", "files": [{"path": "a.py", "stay": false, "reason": "unused"}, '
              '{"path": "b.py", "stay": true, "reason": "needed"}]}\n```')
XML_REPLY = ('Done.\n```xml\n<claude_payload>\n<phase>PRUNE</phase>\n<files>\n'
             '<file><path>a.py</path><stay>false</stay><reason>old</reason></file>\n'
             '</files>\n</claude_payload>\n```')


def file_block(path, body):
    return f'{SEP}\nFILE: {path}\n{SEP}\n```py\n{body}\n```\n\n'


def payload(request='Fix it'):
    return ('--- FILE CONTEXT ---\n' + file_block('a.py', 'x = 1') + file_block('b.py', 'y = 2')
            + f'--- USER REQUEST ---\n{request}\n')


def thread_with_reply(reply):
    return [{'role': 'user', 'content': payload()}, {'role': 'assistant', 'content': reply}]


class PayloadTests(unittest.TestCase):
    def test_json_prune_payload(self):
        payloads = extract_all_prune_payloads(JSON_REPLY)
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]['files'][0]['path'], 'a.py')
        self.assertTrue(payloads[0]['fullBlock'].startswith('```json'))

    def test_xml_prune_payload(self):
        payloads = extract_all_prune_payloads(XML_REPLY)
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]['files'], [{'path': 'a.py', 'stay': False, 'reason': 'old'}])

    def test_safe_json_parse_repairs_model_output(self):
        self.assertEqual(safe_json_parse('{"a": "line\nbreak",}'), {'a': 'line\nbreak'})
        self.assertIsNone(safe_json_parse('{not json'))

    def test_sanitize_reason(self):
        self.assertEqual(sanitize_reason('a `b`\nc'), 'a b c')
        self.assertEqual(sanitize_reason(''), 'Manually pruned by user')


class PruneTests(unittest.TestCase):
    def test_model_prune_applies_to_earlier_prompt(self):
        messages = thread_with_reply(JSON_REPLY)
        info = handle_prune_payload(messages[1], messages)
        user = messages[0]
        self.assertEqual(info['targetIndices'], [0])
        self.assertIn(PRUNED_PREFIX + ' unused)', user['content'])
        self.assertNotIn('x = 1', user['content'])
        self.assertIn('y = 2', user['content'])
        self.assertIn('x = 1', user['originalContent'])

    def test_manual_and_model_prunes_combine(self):
        messages = thread_with_reply(JSON_REPLY)
        handle_prune_payload(messages[1], messages)
        self.assertEqual(set_prune_state(messages, ['b.py'], True, 'mine'), 1)
        self.assertEqual(set(desired_prune_paths(messages[0])), {'a.py', 'b.py'})
        self.assertEqual(set_prune_state(messages, ['b.py'], False), 1)
        self.assertEqual(set(desired_prune_paths(messages[0])), {'a.py'})
        self.assertIn('y = 2', messages[0]['content'])
        self.assertNotIn('x = 1', messages[0]['content'])

    def test_restoring_an_ai_prune_by_hand(self):
        messages = thread_with_reply(JSON_REPLY)
        handle_prune_payload(messages[1], messages)
        set_prune_state(messages, ['a.py'], False)
        self.assertIn('x = 1', messages[0]['content'])

    def test_undo_lifts_model_prunes(self):
        messages = thread_with_reply(JSON_REPLY)
        handle_prune_payload(messages[1], messages)
        self.assertEqual(restore_pruned_from_index(messages, 0), 1)
        self.assertEqual(desired_prune_paths(messages[0]), {})
        self.assertIn('x = 1', messages[0]['content'])

    def test_rebuild_is_idempotent(self):
        messages = thread_with_reply(JSON_REPLY)
        handle_prune_payload(messages[1], messages)
        self.assertFalse(rebuild_message_content(messages[0]))


if __name__ == '__main__':
    unittest.main()
