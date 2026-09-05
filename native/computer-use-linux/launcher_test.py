import unittest
import types
from unittest.mock import patch
import launcher
from launcher import install_compatibility


class CompatibilityTests(unittest.TestCase):
    def test_missing_predicate_uses_the_interface_and_respects_unsupported_nodes(self):
        class Accessible:
            def __init__(self, interface):
                self.interface = interface

            def get_editable_text_iface(self):
                return self.interface

        install_compatibility(Accessible)
        self.assertTrue(Accessible(object()).is_editable_text())
        self.assertFalse(Accessible(None).is_editable_text())

    def test_existing_bindings_are_not_overridden(self):
        class Accessible:
            def is_editable_text(self):
                return 'original'

        original = Accessible.is_editable_text
        install_compatibility(Accessible)
        self.assertIs(Accessible.is_editable_text, original)


class KeyboardTests(unittest.TestCase):
    def fake(self, succeed=True):
        calls = []
        def generate(*args):
            calls.append(args)
            return succeed
        atspi = types.SimpleNamespace(KeySynthType=types.SimpleNamespace(PRESSRELEASE=2, SYM=3, STRING=4), generate_keyboard_event=generate)
        return atspi, calls

    def test_x11_text_uses_keysyms_and_named_keys_are_not_hardware_codes(self):
        atspi, calls = self.fake()
        launcher.install_keyboard_compatibility(atspi, wayland=False)
        atspi.generate_keyboard_event(0, ' a\n\t✓', 4)
        self.assertEqual(calls, [(32, None, 3), (97, None, 3), (0xff0d, None, 3), (0xff09, None, 3), (0x1002713, None, 3)])
        atspi.generate_keyboard_event(0xff1b, None, 2)
        self.assertEqual(calls[-1], (0xff1b, None, 3))

    def test_xdotool_receives_text_on_stdin_and_closed_named_key_events(self):
        atspi, calls = self.fake()
        launcher.install_keyboard_compatibility(atspi, wayland=False, xdotool="/bin/xdotool", key_name=lambda _: "Return")
        with patch('launcher.subprocess.run') as run:
            atspi.generate_keyboard_event(0, 'private payload', 4)
            argv = run.call_args.args[0]
            self.assertNotIn('private payload', argv)
            self.assertEqual(run.call_args.kwargs['input'], 'private payload')
            self.assertEqual(argv[-2:], ['--file', '-'])
            atspi.generate_keyboard_event(0xff0d, None, 2)
            self.assertEqual(run.call_args.args[0], ['/bin/xdotool', 'key', '--clearmodifiers', 'Return'])
        self.assertEqual(calls, [])

    def test_wayland_keeps_composed_text_synthesis(self):
        atspi, calls = self.fake()
        launcher.install_keyboard_compatibility(atspi, wayland=True)
        atspi.generate_keyboard_event(0, 'hello', 4)
        self.assertEqual(calls, [(0, 'hello', 4)])

    def test_failed_synthesis_stops_without_retrying_or_duplicating_text(self):
        atspi, calls = self.fake(False)
        launcher.install_keyboard_compatibility(atspi, wayland=False)
        with self.assertRaisesRegex(RuntimeError, 'keyboard synthesis failed'):
            atspi.generate_keyboard_event(0, 'abc', 4)
        self.assertEqual(calls, [(97, None, 3)])


if __name__ == '__main__':
    unittest.main()
