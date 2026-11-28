import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


class FakeStateType:
    PROTECTED = 1
    SELECTED = 2
    FOCUSED = 3
    ACTIVE = 4
    SHOWING = 5


class FakeInterpType:
    BILINEAR = 1


def load_runtime():
    gi = types.ModuleType("gi")
    repository = types.ModuleType("gi.repository")
    gi.require_version = lambda *_: None
    repository.Atspi = types.SimpleNamespace(
        StateType=FakeStateType,
        Text=types.SimpleNamespace(),
        KeySynthType=types.SimpleNamespace(STRING=1, PRESSRELEASE=2),
        generate_keyboard_event=lambda *args, **kwargs: None,
    )
    repository.Gdk = types.SimpleNamespace(keyval_from_name=lambda name: 42)
    repository.GdkPixbuf = types.SimpleNamespace(InterpType=FakeInterpType)
    gi.repository = repository
    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository

    path = Path(__file__).with_name("runtime.py")
    spec = importlib.util.spec_from_file_location("terminalx_linux_runtime_sec_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runtime = load_runtime()


class FakePixbuf:
    def __init__(self, width, height, bytes_per_pixel=1.5, encode_log=None):
        self.width = width
        self.height = height
        self.bytes_per_pixel = bytes_per_pixel
        self.encode_log = encode_log if encode_log is not None else []

    def get_width(self):
        return self.width

    def get_height(self):
        return self.height

    def scale_simple(self, width, height, _interp):
        return FakePixbuf(width, height, bytes_per_pixel=self.bytes_per_pixel, encode_log=self.encode_log)

    def save_to_bufferv(self, fmt, _keys, _values):
        assert fmt == "png"
        self.encode_log.append((self.width, self.height))
        size = int(self.width * self.height * self.bytes_per_pixel)
        return True, b"\x89PNG" + (b"x" * max(0, size - 4))


class LinuxHotkeySecurityTests(unittest.TestCase):
    """S-49: xdotool option injection prevention and strict keysym allowlist."""

    def test_valid_hotkeys_normalize_and_pass_double_dash_to_xdotool(self):
        cases = [
            ("CmdOrCtrl+A", "ctrl+a"),
            ("Cmd Or Ctrl+Shift+P", "ctrl+shift+p"),
            ("Ctrl+Alt+Delete", "ctrl+alt+Delete"),
            ("Ctrl+-", "ctrl+minus"),
            ("Ctrl+=", "ctrl+equal"),
            ("Alt+F4", "alt+F4"),
            ("Super+Return", "super+Return"),
        ]
        for raw, expected_spec in cases:
            with self.subTest(raw=raw):
                self.assertEqual(runtime.normalize_hotkey_spec(raw), expected_spec)
                with (
                    mock.patch.object(runtime.shutil, "which", return_value="/usr/bin/xdotool"),
                    mock.patch.object(runtime.subprocess, "run") as run_mock,
                ):
                    runtime.hotkey(raw)
                    run_mock.assert_called_once_with(
                        ["/usr/bin/xdotool", "key", "--", expected_spec],
                        check=True,
                        timeout=5,
                    )

    def test_rejects_option_injection_and_out_of_order_hotkeys(self):
        malicious = [
            "--window+ctrl",
            "--repeat+ctrl",
            "--clearmodifiers+ctrl",
            "--ctrl+a",
            "ctrl+--window",
            "a+ctrl",
            "ctrl+a+b",
            "ctrl+shift",
            "A",
            "ctrl+",
            "+a",
            "ctrl+foo_bar_exec",
            "ctrl+a;id",
            "ctrl+a\n--window",
        ]
        for bad in malicious:
            with self.subTest(bad=bad):
                with (
                    mock.patch.object(runtime.shutil, "which", return_value="/usr/bin/xdotool"),
                    mock.patch.object(runtime.subprocess, "run") as run_mock,
                ):
                    with self.assertRaisesRegex(RuntimeError, "invalid_argument"):
                        runtime.hotkey(bad)
                    run_mock.assert_not_called()


class LinuxScreenshotScalingTests(unittest.TestCase):
    """P-77: pre-downscale to maxEdge <= 1280 and analytical sqrt retry."""

    def test_4k_screenshot_skips_full_res_encode_and_finishes_in_one_encode(self):
        log = []
        # 3840x2160 at 0.5 bytes/px -> 1280x720 is ~460 KB (<= 900 KB)
        pixbuf = FakePixbuf(3840, 2160, bytes_per_pixel=0.5, encode_log=log)
        result = runtime.bounded_png_payload(pixbuf)
        self.assertIsNotNone(result)
        self.assertNotIn("error", result)
        self.assertEqual(result["width"], 1280)
        self.assertEqual(result["height"], 720)
        self.assertEqual(log, [(1280, 720)])

    def test_noisy_retina_screenshot_converges_analytically_in_two_encodes(self):
        log = []
        # 2560x1600 at 2.0 bytes/px -> 1280x800 is 2,048,000 bytes (> 900k);
        # analytical next scale sqrt(900k/2048k)*0.95 = 0.629 -> ~805x503 -> ~810 KB (<= 900k).
        pixbuf = FakePixbuf(2560, 1600, bytes_per_pixel=2.0, encode_log=log)
        result = runtime.bounded_png_payload(pixbuf)
        self.assertIsNotNone(result)
        self.assertNotIn("error", result)
        self.assertLessEqual(len(log), 2)
        self.assertNotIn((2560, 1600), log)
        self.assertEqual(log[0], (1280, 800))

    def test_small_window_encodes_at_native_resolution_without_resize(self):
        log = []
        pixbuf = FakePixbuf(800, 600, bytes_per_pixel=0.5, encode_log=log)
        result = runtime.bounded_png_payload(pixbuf)
        self.assertEqual(result["width"], 800)
        self.assertEqual(result["height"], 600)
        self.assertEqual(log, [(800, 600)])

    def test_exhausted_cap_returns_screenshot_failed_in_few_attempts(self):
        log = []
        # Always huge even at 0.25 scale (640x400 * 10 = 2.56 MB > 900 KB)
        pixbuf = FakePixbuf(2560, 1600, bytes_per_pixel=10.0, encode_log=log)
        result = runtime.bounded_png_payload(pixbuf)
        self.assertEqual(result["error"]["code"], "screenshot_failed")
        self.assertLessEqual(len(log), 3)
        self.assertNotIn((2560, 1600), log)


if __name__ == "__main__":
    unittest.main()
