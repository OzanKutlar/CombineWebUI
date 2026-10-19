import unittest

from src.prompt_parser import PRUNED_PREFIX, parse_combinecopy_prompt, scan_file_blocks_for_text

SEP = '-' * 35


def file_block(path, body, newline='\n'):
    return newline.join([SEP, f'FILE: {path}', SEP, '```py', body, '```', '', ''])


class PromptParserTests(unittest.TestCase):
    def test_files_and_request(self):
        raw = '--- FILE CONTEXT ---\n' + file_block('a.py', 'x = 1') + file_block('b.py', 'y = 2') + '--- USER REQUEST ---\nFix it\n'
        parsed = parse_combinecopy_prompt(raw)
        self.assertTrue(parsed['isStructured'])
        self.assertEqual([f['path'] for f in parsed['files']], ['a.py', 'b.py'])
        self.assertEqual(parsed['files'][0]['content'], 'x = 1')
        self.assertEqual(parsed['files'][1]['content'], 'y = 2')
        self.assertEqual(parsed['userRequest'], 'Fix it')

    def test_crlf_blocks(self):
        raw = file_block('a.py', 'x = 1', '\r\n') + file_block('b.py', 'y = 2', '\r\n')
        files = scan_file_blocks_for_text(raw)
        self.assertEqual([f['path'] for f in files], ['a.py', 'b.py'])
        self.assertEqual(files[0]['content'], 'x = 1')

    def test_header_inside_a_file_body_is_not_a_boundary(self):
        body = 'intro\n--- USER REQUEST ---\nnot a request'
        raw = '--- FILE CONTEXT ---\n' + file_block('notes.md', body) + '--- USER REQUEST ---\nReal request\n'
        parsed = parse_combinecopy_prompt(raw)
        self.assertEqual(len(parsed['files']), 1)
        self.assertIn('not a request', parsed['files'][0]['content'])
        self.assertEqual(parsed['userRequest'], 'Real request')

    def test_unfenced_preamble_payload(self):
        raw = 'Please look\n' + SEP + '\nFILE: a.txt\n' + SEP + '\nplain body\n'
        parsed = parse_combinecopy_prompt(raw)
        self.assertEqual(parsed['files'][0]['content'], 'plain body')
        self.assertEqual(parsed['userRequest'], 'Please look')
        self.assertEqual(parsed['requestSpans'][0]['kind'], 'preamble')

    def test_pruned_block_is_detected(self):
        raw = file_block('a.py', PRUNED_PREFIX + ' old)')
        block = scan_file_blocks_for_text(raw)[0]
        self.assertTrue(block['isPruned'])
        self.assertEqual(block['prunedReason'], 'old')

    def test_plain_text_is_not_structured(self):
        self.assertFalse(parse_combinecopy_prompt('just a question')['isStructured'])


if __name__ == '__main__':
    unittest.main()
