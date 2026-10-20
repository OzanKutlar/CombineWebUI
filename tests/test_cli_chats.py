import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.cli import chats

BASE_STAMP = 1_700_000_000


class ChatListCacheTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.conv_dir = root / 'conversations'
        self.conv_dir.mkdir()
        self.cache_path = root / 'cli_chat_index.json'
        self.reads = []
        for number in range(3):
            self.write(f'conv_{number}', f'Chat {number}', number + 1, BASE_STAMP + number)
        for patcher in (
            mock.patch.object(chats, 'CHATS_CONV_DIR', self.conv_dir),
            mock.patch.object(chats, 'SUMMARY_CACHE_PATH', self.cache_path),
            mock.patch.object(chats, 'get_history_index', return_value={'order': []}),
            mock.patch.object(chats, 'get_conversation', side_effect=self.read),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def write(self, conv_id, title, count, stamp):
        path = self.conv_dir / f'{conv_id}.json'
        conv = {'id': conv_id, 'title': title, 'messages': [{'role': 'user', 'content': 'x'}] * count}
        path.write_text(json.dumps(conv), encoding='utf-8')
        os.utime(path, (stamp, stamp))

    def read(self, conv_id):
        self.reads.append(conv_id)
        path = self.conv_dir / f'{conv_id}.json'
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else None

    def titles(self):
        return [chat.title for chat in chats.list_chats()]

    def test_second_listing_opens_no_chat(self):
        self.assertEqual(self.titles(), ['Chat 2', 'Chat 1', 'Chat 0'])
        self.assertEqual(len(self.reads), 3)
        self.reads.clear()
        listed = chats.list_chats()
        self.assertEqual(self.reads, [])
        self.assertEqual([chat.title for chat in listed], ['Chat 2', 'Chat 1', 'Chat 0'])
        self.assertEqual([chat.count for chat in listed], [3, 2, 1])

    def test_only_a_changed_chat_is_reopened(self):
        self.titles()
        self.reads.clear()
        self.write('conv_1', 'Renamed', 5, BASE_STAMP + 100)
        self.assertEqual(self.titles(), ['Renamed', 'Chat 2', 'Chat 0'])
        self.assertEqual(self.reads, ['conv_1'])

    def test_deleted_chat_leaves_the_cache(self):
        self.titles()
        (self.conv_dir / 'conv_0.json').unlink()
        self.assertEqual(self.titles(), ['Chat 2', 'Chat 1'])
        entries = json.loads(self.cache_path.read_text(encoding='utf-8'))['entries']
        self.assertEqual(sorted(entries), ['conv_1', 'conv_2'])

    def test_corrupt_cache_falls_back_to_reading(self):
        self.cache_path.write_text('{not json', encoding='utf-8')
        self.assertEqual(self.titles(), ['Chat 2', 'Chat 1', 'Chat 0'])
        self.assertEqual(len(self.reads), 3)


if __name__ == '__main__':
    unittest.main()
