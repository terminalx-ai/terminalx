"""Tests for scripts/release/desktop-feed.py, the Windows and Linux update feeds.

    python3 -m unittest discover -s scripts/release -p 'test_*.py'
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location('desktop_feed', Path(__file__).resolve().parent / 'desktop-feed.py')
feed = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(feed)

VERSION = '9.8.7'
REPO = 'example/terminalx'
WHEN = '2026-11-26T10:00:00Z'
WINDOWS = f'TerminalX_{VERSION}_x64-setup.exe'
LINUX = [f'TerminalX_{VERSION}_amd64.AppImage', f'TerminalX_{VERSION}_amd64.deb', f'TerminalX-{VERSION}-1.x86_64.rpm']


class DesktopFeed(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def add(self, *names: str, signed: bool = True):
        for name in names:
            (self.dir / name).write_bytes(name.encode())
            if signed:
                (self.dir / f'{name}.sig').write_text(f'sig of {name}\n')

    def test_windows_and_linux_feeds_list_each_installer_under_its_keys(self):
        self.add(WINDOWS, *LINUX)
        uploads = feed.write(self.dir, REPO, VERSION, pub_date=WHEN)
        windows = json.loads((self.dir / 'latest-windows.json').read_text())
        self.assertEqual(windows['version'], VERSION)
        self.assertEqual(windows['notes'], f'TerminalX {VERSION}')
        self.assertEqual(windows['pub_date'], WHEN)
        self.assertEqual(sorted(windows['platforms']), ['windows-x86_64', 'windows-x86_64-nsis'])
        nsis = windows['platforms']['windows-x86_64-nsis']
        self.assertEqual(nsis, {'signature': f'sig of {WINDOWS}', 'url': f'https://github.com/{REPO}/releases/download/v{VERSION}/{WINDOWS}'})
        linux = json.loads((self.dir / 'latest-linux.json').read_text())
        self.assertEqual(sorted(linux['platforms']), ['linux-x86_64', 'linux-x86_64-appimage', 'linux-x86_64-deb', 'linux-x86_64-rpm'])
        # An install the updater cannot tell gets the AppImage.
        self.assertEqual(linux['platforms']['linux-x86_64'], linux['platforms']['linux-x86_64-appimage'])
        self.assertTrue(linux['platforms']['linux-x86_64-rpm']['url'].endswith(f'/v{VERSION}/{LINUX[2]}'))
        # Feeds last, after everything they name.
        self.assertEqual(sorted(uploads[-2:]), ['latest-linux.json', 'latest-windows.json'])
        self.assertIn('TerminalX-latest-x64-setup.exe', uploads)
        self.assertEqual((self.dir / 'TerminalX-latest-x64-setup.exe').read_bytes(), (self.dir / WINDOWS).read_bytes())

    def test_the_checksums_cover_every_upload_but_themselves(self):
        self.add(WINDOWS)
        uploads = feed.write(self.dir, REPO, VERSION, pub_date=WHEN)
        listed = [line.split('  ', 1)[1] for line in (self.dir / feed.CHECKSUMS).read_text().splitlines()]
        self.assertEqual(sorted(listed), sorted(name for name in uploads if name != feed.CHECKSUMS))
        self.assertFalse((self.dir / 'latest-linux.json').exists(), 'a Windows-only folder writes no Linux feed')

    def test_an_installer_without_its_signature_is_refused(self):
        self.add(WINDOWS, signed=False)
        with self.assertRaisesRegex(feed.FeedError, 'no updater signature'):
            feed.write(self.dir, REPO, VERSION)
        self.assertFalse((self.dir / 'latest-windows.json').exists())

    def test_a_system_with_only_some_of_its_installers_is_refused(self):
        self.add(LINUX[0], LINUX[1])
        with self.assertRaisesRegex(feed.FeedError, 'no rpm installer'):
            feed.write(self.dir, REPO, VERSION)

    def test_two_installers_of_one_kind_are_refused(self):
        self.add(WINDOWS, f'TerminalX_1.0.0_x64-setup.exe')
        with self.assertRaisesRegex(feed.FeedError, 'more than one nsis'):
            feed.write(self.dir, REPO, VERSION)

    def test_a_folder_without_installers_is_an_error_from_the_command_line(self):
        self.assertEqual(feed.main(['--version', VERSION, '--repo', REPO, '--dir', str(self.dir)]), 1)

    def test_names_with_spaces_are_quoted_in_urls(self):
        self.assertEqual(feed.release_url(REPO, VERSION, 'Terminal X_x64-setup.exe'), f'https://github.com/{REPO}/releases/download/v{VERSION}/Terminal%20X_x64-setup.exe')


if __name__ == '__main__':
    unittest.main()
