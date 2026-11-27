import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SOURCE = Path(__file__).with_name("workspace-openssh.py")
spec = importlib.util.spec_from_file_location("workspace_openssh", SOURCE)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class PayloadTest(unittest.TestCase):
    def test_tracking_uses_numeric_portable_versions(self):
        self.assertEqual(tool.discover("openssh-9.6p0.tar.gz openssh-9.9p9.tar.gz "
                                      "openssh-9.10p1.tar.gz openssh-09.99p1.tar.gz"), "9.10p1")
        with self.assertRaises(ValueError):
            tool.discover("openssh-9.6p0.tar.gz")
        for invalid in ("9.6p0", "9.6p1-terminalx.00", "9.6p1/../bad"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                tool.version_order(invalid)

    def test_deterministic_package_and_locally_signed_manifest(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            tree = directory / "tree"
            out = directory / "out"
            out.mkdir()
            sshd = tree / "usr/sbin/sshd"
            sshd.parent.mkdir(parents=True)
            sshd.write_bytes(b"fixture")
            sshd.chmod(0o755)
            version = "9.6p1-terminalx.1"
            x64 = out / tool.artifact_name(version, "x86_64")
            arm = out / tool.artifact_name(version, "aarch64")
            tool.pack(tree, x64)
            tool.pack(tree, arm)
            self.assertEqual(x64.read_bytes(), arm.read_bytes())
            with tarfile.open(x64, "r:gz") as archive:
                daemon = archive.getmember("usr/sbin/sshd")
                self.assertEqual((daemon.uid, daemon.gid, daemon.mode), (0, 0, 0o755))
            key = directory / "throwaway"
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], check=True)
            subprocess.run([
                "python3", SOURCE, "manifest", "--version", version, "--arch", "x86_64",
                "--arch", "aarch64", "--output", out, "--signing-key", key,
            ], check=True)
            manifest = out / "manifest.json"
            content = manifest.read_bytes()
            self.assertEqual(json.loads(content), {
                "v": 1, "version": version, "artifacts": [
                    {"arch": arch, "locator": artifact.name, "sha256": tool.sha256(artifact)}
                    for arch, artifact in [("aarch64", arm), ("x86_64", x64)]
                ],
            })
            signer = directory / "allowed_signers"
            signer.write_text(f"release@terminalx {key.with_suffix('.pub').read_text()}")
            subprocess.run([
                "ssh-keygen", "-Y", "verify", "-f", signer, "-I", "release@terminalx",
                "-n", tool.SIGNATURE_NAMESPACE, "-s", out / "manifest.json.sig",
            ], input=content, check=True, capture_output=True)
            (tree / "external").symlink_to("/outside")
            with self.assertRaises(ValueError):
                tool.pack(tree, out / "unsafe.tar.gz")
            self.assertFalse((out / "unsafe.tar.gz").exists())


if __name__ == "__main__":
    unittest.main()
