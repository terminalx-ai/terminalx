"""The Rust toolchain is pinned in rust-toolchain.toml, and no workflow picks another (#1514, D5)."""

from pathlib import Path
import re
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[2]
TOOLCHAIN = ROOT / "rust-toolchain.toml"
WORKFLOWS = ROOT / ".github/workflows"

# Each way a workflow can choose a toolchain other than the file's: a toolchain
# action, a rustup command that installs or selects one, `cargo +<toolchain>`,
# and the environment variables rustup and cargo read.
CHOOSERS = [
    (r"uses:\s*['\"]?dtolnay/rust-toolchain", "the dtolnay/rust-toolchain action"),
    (r"uses:\s*['\"]?actions-rs/toolchain", "the actions-rs/toolchain action"),
    (r"uses:\s*['\"]?actions-rust-lang/setup-rust-toolchain", "the setup-rust-toolchain action"),
    (r"\brustup\s+(default|override|install|update|toolchain\s+install|toolchain\s+link|run)\b", "a rustup command that installs or picks a toolchain"),
    (r"\b(cargo|rustc|rustup\s+which)\s+\+\S+", "a +toolchain argument"),
    (r"\bRUSTUP_TOOLCHAIN\b", "RUSTUP_TOOLCHAIN"),
    (r"\bRUSTC\s*[:=]", "RUSTC"),
    (r"\bCARGO_BUILD_RUSTC\b", "CARGO_BUILD_RUSTC"),
]


def channel(text):
    return tomllib.loads(text)["toolchain"]["channel"]


def problems(workflows, pinned):
    """Each line of `workflows` ({name: text}) that picks a toolchain, unless it names `pinned` itself."""
    found = []
    for name, text in sorted(workflows.items()):
        for number, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            for pattern, what in CHOOSERS:
                if re.search(pattern, line) and pinned not in line:
                    found.append(f"{name}:{number}: {what}: {line.strip()}")
    return found


class RustToolchain(unittest.TestCase):
    def setUp(self):
        self.text = TOOLCHAIN.read_text()
        self.workflows = {path.name: path.read_text() for path in sorted(WORKFLOWS.glob("*.y*ml"))}

    def test_the_channel_is_one_exact_release(self):
        self.assertRegex(channel(self.text), r"^\d+\.\d+\.\d+$", "rust-toolchain.toml must name an exact release, x.y.z")
        for moving in ('channel = "stable"', 'channel = "beta"', 'channel = "nightly"', 'channel = "1.100"'):
            with self.subTest(channel=moving):
                self.assertNotRegex(channel(re.sub(r'channel = "[^"]*"', moving, self.text)), r"^\d+\.\d+\.\d+$")

    def test_the_file_keeps_the_components_and_targets(self):
        toolchain = tomllib.loads(self.text)["toolchain"]
        self.assertEqual(toolchain["components"], ["clippy", "rustfmt"])
        self.assertEqual(toolchain["targets"], ["aarch64-apple-darwin"])

    def test_no_workflow_picks_another_toolchain(self):
        self.assertTrue(self.workflows, "the workflows were read")
        self.assertEqual(problems(self.workflows, channel(self.text)), [])

    def test_a_workflow_that_picks_another_toolchain_is_rejected(self):
        pinned = channel(self.text)
        for line in (
            "      - uses: dtolnay/rust-toolchain@4be9e76fd7c4901c3e2c1c8b5b4d1b9d2f6f0a1b # stable",
            "        run: rustup default stable",
            "        run: rustup toolchain install 1.99.0",
            "        run: rustup override set nightly",
            "        run: cargo +nightly clippy",
            "        run: cargo +1.99.0 test --locked",
            "      RUSTUP_TOOLCHAIN: stable",
            "      RUSTC: /opt/rust/bin/rustc",
        ):
            with self.subTest(line=line):
                self.assertTrue(problems({"ci.yml": f"jobs:\n  a:\n    steps:\n{line}\n"}, pinned))
        # Naming the pinned release itself is not another toolchain, and a comment picks nothing.
        self.assertFalse(problems({"ci.yml": f"        run: cargo +{pinned} clippy\n        # rustup default stable\n"}, pinned))

    def test_every_rust_workflow_shows_its_toolchain(self):
        # A workflow that runs cargo prints `rustup show` before it, so its log names the release it used.
        for name, text in self.workflows.items():
            if re.search(r"\bcargo\s+(build|test|clippy|check|nextest|run|fmt)\b", text):
                with self.subTest(workflow=name):
                    self.assertIn("rustup show", text)


if __name__ == "__main__":
    unittest.main()
