"""Exercise the selector against real Git histories, and its rules against this tree."""

import importlib.util
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("macos_rust", Path(__file__).with_name("macos-rust.py"))
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)

ROOT = Path(__file__).resolve().parents[2]
LONG_APPLE_FUNCTION = '#[cfg(target_os = "macos")]\nfn apple() {\n' + "".join(f"    step({n});\n" for n in range(40)) + "}\n"
LONG_SHARED_FUNCTION = "fn shared() {\n" + "".join(f"    step({n});\n" for n in range(40)) + "}\n"


class Fixture(unittest.TestCase):
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
        self.write("src-tauri/src/long.rs", LONG_APPLE_FUNCTION + "\n" + LONG_SHARED_FUNCTION)
        self.write("src-tauri/src/startup/macos.rs", "fn launch() {}\n")
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
        self.git("commit", "-q", "--allow-empty", "-m", "fixture")


class MacosRustSelection(Fixture):
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

    def test_apple_only_module_selects_without_a_cfg_of_its_own(self):
        path = "src-tauri/src/startup/macos.rs"
        self.write(path, "fn launch() { panic!(); }\n")
        self.assertEqual(self.selected(), [path])

    def test_change_deep_inside_an_apple_function_selects(self):
        path = "src-tauri/src/long.rs"
        self.write(path, (LONG_APPLE_FUNCTION + "\n" + LONG_SHARED_FUNCTION).replace("    step(30);\n}\n\nfn shared", "    other(30);\n}\n\nfn shared", 1).replace("step(30);", "other(30);", 1))
        self.assertEqual(self.selected(), [path])

    def test_change_far_from_any_apple_cfg_does_not_select(self):
        path = "src-tauri/src/long.rs"
        text = LONG_APPLE_FUNCTION + "\n" + LONG_SHARED_FUNCTION
        head, _, tail = text.rpartition("step(30);")
        self.write(path, head + "other(30);" + tail)
        self.assertEqual(self.selected(), [])

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


class WhatAChangeNeeds(Fixture):
    def needs(self, *paths):
        for path in paths:
            self.write(path, "changed\n")
        self.commit()
        return {name for name, found in selector.answers(self.base, "HEAD").items() if found}

    def test_each_kind_of_change_runs_its_own_jobs(self):
        for paths, expected in [
            (["docs/NOTES.md"], set()),
            (["README.md", "docs/screens/one.png"], set()),
            (["src/components/App.tsx"], {"frontend"}),
            (["scripts/webkit/run-all.mjs"], {"frontend"}),
            (["mobile/app/index.tsx", "mobile/app.json"], {"phone"}),
            # The desktop imports from the phone app's sources, and the root Vitest run includes their tests.
            (["mobile/src/ui/transcript-rows.ts"], {"phone", "frontend"}),
            (["src-tauri/src/shared.rs"], {"rust"}),
            (["src-tauri/serve/tests/owner_pretool.rs"], {"rust"}),
            (["src-tauri/src/startup/macos.rs"], {"rust", "required"}),
            (["native/computer-use-macos/Sources/main.swift"], {"rust", "frontend", "required"}),
            (["src-tauri/Cargo.lock"], {"rust", "required"}),
            # Read from both sides: a Rust test and a frontend test hold each other to these.
            (["packages/portable/src/sessionStatusCases.json"], {"rust", "frontend", "phone"}),
            (["src-tauri/src/remote/protocol.rs"], {"rust", "frontend"}),
            (["src/lib/fixtures/cloudWorkspaceList.server.json"], {"rust", "frontend"}),
            (["scripts/remote-runtime/fake-claude"], {"rust", "frontend"}),
            (["pnpm-lock.yaml"], {"frontend", "phone"}),
            # Nothing else shows the jobs themselves still work.
            ([".github/workflows/ci.yml"], {"required", "rust", "frontend", "phone"}),
            (["infra/ci-runners/macos-rust.py"], {"required", "rust", "frontend", "phone"}),
            (["docs/NOTES.md", "mobile/app/index.tsx", "src-tauri/src/shared.rs"], {"phone", "rust"}),
        ]:
            with self.subTest(paths=paths):
                self.git("checkout", "-q", "--detach", self.base)
                self.assertEqual(self.needs(*paths), expected)

    def test_a_deleted_file_counts(self):
        self.git("rm", "-q", "src/app.ts")
        self.assertEqual(self.needs("docs/NOTES.md"), {"frontend"})

    def run_main(self, *args):
        output = Path(self.temp.name) / "github-output"
        output.write_text("")
        script = Path(__file__).with_name("macos-rust.py")
        printed = subprocess.check_output(["python3", str(script), *args], env={**os.environ, "GITHUB_OUTPUT": str(output)}, text=True)
        return printed, dict(line.split("=") for line in output.read_text().split())

    def test_a_pull_request_gets_every_answer(self):
        self.write("mobile/app/index.tsx", "changed\n")
        self.commit()
        _, written = self.run_main("--base", self.base, "--head", "HEAD")
        self.assertEqual(written, {"required": "false", "rust": "false", "frontend": "false", "phone": "true"})

    def test_every_other_run_gets_everything(self):
        _, written = self.run_main("--all")
        self.assertEqual(written, {"required": "true", "rust": "true", "frontend": "true", "phone": "true"})

    def test_the_macos_filters_are_one_line_of_arguments(self):
        printed, written = self.run_main("--filters")
        self.assertEqual(printed.split(), list(selector.MACOS_FILTERS))
        self.assertEqual(written, {})


class RulesAgainstThisTree(unittest.TestCase):
    """The lists in macos-rust.py are written by hand; these fail when the source outgrows them."""

    def test_the_rules_cover_this_tree(self):
        for what, missing in selector.gaps(ROOT).items():
            with self.subTest(what=what):
                self.assertEqual(missing, [])

    def test_every_listed_apple_only_module_exists(self):
        files = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "src-tauri"], text=True).split("\n")
        for module in selector.APPLE_ONLY:
            with self.subTest(module=module):
                self.assertTrue(any(f == module or f.startswith(module) for f in files), "no such module: remove it from APPLE_ONLY")

    def test_every_macos_filter_names_a_module(self):
        files = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "src-tauri/src"], text=True).split("\n")
        for name in selector.MACOS_FILTERS:
            with self.subTest(filter=name):
                self.assertTrue(any(f.startswith(selector.filter_path(name)) for f in files), "a filter that matches no module runs no test")


class RulesAgainstAGrowingTree(Fixture):
    """The same checks do fail: each kind of gap, made in a small tree."""

    def gaps(self):
        self.commit()
        return selector.gaps(".")

    def test_an_unlisted_apple_only_module_is_found(self):
        gaps = self.gaps()
        self.assertEqual(gaps["Apple-only modules not in APPLE_ONLY"], ["src-tauri/src/computer/helper.rs"])

    def test_an_inline_apple_only_module_and_a_file_wide_cfg_are_found(self):
        self.write("src-tauri/src/sound.rs", '#[cfg(target_os = "macos")]\npub(crate) mod mac {\n}\n')
        self.write("src-tauri/src/tray/mod.rs", '#![cfg(target_vendor = "apple")]\n')
        self.write("src-tauri/src/linux.rs", '#[cfg(not(target_os = "macos"))]\nmod other;\n')
        self.write("src-tauri/src/linux/other.rs", "")
        found = self.gaps()["Apple-only modules not in APPLE_ONLY"]
        self.assertEqual(found, ["src-tauri/src/computer/helper.rs", "src-tauri/src/sound.rs", "src-tauri/src/tray/mod.rs"])

    def test_a_file_with_an_apple_cfg_under_no_filter_is_found(self):
        self.assertEqual(self.gaps()["files with an Apple cfg under no macOS test filter"], ["src-tauri/src/long.rs", "src-tauri/src/platform.rs"])

    def test_a_path_a_rust_test_reads_is_found(self):
        self.write("docs/PROTOCOL.md", "text\n")
        self.write("website/pricing.json", "{}\n")
        self.write("src-tauri/src/protocol.rs", 'const DOC: &str = include_str!("../../docs/PROTOCOL.md");\n')
        self.write("src-tauri/serve/tests/prices.rs", 'fn prices() { read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../website/pricing.json")); }\n')
        # Named, or not a file in the repository: neither is a gap.
        self.write("packages/portable/src/cases.json", "{}\n")
        self.write("src-tauri/src/cases.rs", 'const A: &str = include_str!("../../packages/portable/src/cases.json");\nconst B: &str = "../notes.md";\n')
        self.assertEqual(self.gaps()["paths a Rust source reads that RUST does not name"], ["docs/PROTOCOL.md", "website/pricing.json"])

    def test_a_path_a_frontend_test_reads_is_found(self):
        self.write("src-tauri/src/wire.rs", "")
        self.write("docs/KEYS.md", "text\n")
        self.write("src/lib/wire.test.ts", 'read("src-tauri/src/wire.rs"); read(`../../docs/KEYS.md`); import "../lib/other";\n')
        # The phone app's tests are not the frontend jobs'.
        self.write("mobile/src/wire.test.ts", 'read("../../docs/KEYS.md");\n')
        self.assertEqual(self.gaps()["paths a frontend test reads that FRONTEND does not name"], ["docs/KEYS.md", "src-tauri/src/wire.rs"])


if __name__ == "__main__":
    unittest.main()
