"""Exercise the selector against real Git histories, including removed cfgs."""

import importlib.util
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("macos_rust", Path(__file__).with_name("macos-rust.py"))
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)


class MacosRustSelection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        previous = os.getcwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, previous)
        self.git("init", "-q")
        self.git("config", "user.name", "CI selector test")
        self.git("config", "user.email", "test@example.invalid")
        self.write("src-tauri/src/platform.rs", '#[cfg(target_os = "macos")]\nfn apple() {}\n')
        self.write("src-tauri/src/computer/mod.rs", '#[cfg(target_os = "macos")]\nmod helper;\n')
        self.write("src-tauri/src/computer/helper.rs", "fn helper() {}\n")
        self.write("src/app.ts", "export {};\n")
        self.commit()
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.check_output(["git", *args], text=True)

    def write(self, path, text):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(text)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def selected(self):
        self.commit()
        return selector.select(self.base, "HEAD")

    def test_frontend_only_does_not_select(self):
        self.write("src/app.ts", "export const value = 1;\n")
        self.assertEqual(self.selected(), [])

    def test_shared_rust_without_apple_code_does_not_select(self):
        self.write("src-tauri/src/shared.rs", "fn shared() {}\n")
        self.assertEqual(self.selected(), [])

    def test_new_apple_cfg_selects(self):
        path = "src-tauri/src/new.rs"
        self.write(path, '#[cfg(all(unix, target_os = "macos"))]\nfn apple() {}\n')
        self.assertEqual(self.selected(), [path])

    def test_removing_last_cfg_still_selects(self):
        path = "src-tauri/src/platform.rs"
        self.write(path, "fn shared() {}\n")
        self.assertEqual(self.selected(), [path])

    def test_rename_still_selects_deleted_macos_path(self):
        self.git("mv", "src-tauri/src/platform.rs", "src-tauri/src/shared.rs")
        self.write("src-tauri/src/shared.rs", "fn shared() {}\n")
        self.assertIn("src-tauri/src/platform.rs", self.selected())

    def test_child_without_cfg_selects(self):
        path = "src-tauri/src/computer/helper.rs"
        self.write(path, "fn helper() { panic!(); }\n")
        self.assertEqual(self.selected(), [path])

    def test_native_and_build_inputs_select(self):
        for path in ("native/helper.swift", "src-tauri/Cargo.lock", "rust-toolchain.toml"):
            self.write(path, "changed\n")
        self.assertEqual(len(self.selected()), 3)

    def test_approval_wrapper_and_its_tests_select_without_an_apple_cfg(self):
        paths = ["src-tauri/src/harness/read_only.rs", "src-tauri/src/harness/read_only_security_tests.rs"]
        for path in paths:
            self.write(path, "fn portable_approval_guard() {}\n")
        self.assertEqual(self.selected(), paths)

    def test_base_branch_changes_are_not_pr_changes(self):
        self.write("src/app.ts", "export const value = 1;\n")
        self.commit()
        head = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-qb", "other", self.base)
        self.write("src-tauri/src/platform.rs", "fn other() {}\n")
        self.commit()
        self.assertEqual(selector.select("HEAD", head), [])


if __name__ == "__main__":
    unittest.main()
