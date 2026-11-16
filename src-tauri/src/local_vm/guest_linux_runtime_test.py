# Executed after the production source, with entrypoints disabled. The sealed
# root is a disposable directory the test account owns, standing in for root.
import tempfile
import types
import unittest


class Unread:
    def read(self, *args):
        raise AssertionError("the launcher read stdin, where the host key waits")


class SealedRuntime(unittest.TestCase):
    def setUp(self):
        global SEALED_ROOT, SEALED, SEALED_OWNER
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        SEALED_ROOT = pathlib.Path(temporary.name)
        SEALED = SEALED_ROOT / "opt/terminalx-local/bin/terminalx-serve"
        SEALED_OWNER = os.geteuid()
        self.home = SEALED_ROOT / "home"
        self.home.mkdir()
        binary = bytearray(64)
        binary[:7] = b"\x7fELF\x02\x01\x01"
        self.binary = bytes(binary)
        self.sha = digest(self.binary)
        self.executed = []

    def envelope(self, **header):
        return [base64.b64encode(canonical(header)).decode()]

    def seal_input(self, data=None, sha=None):
        data = self.binary if data is None else data
        stream = types.SimpleNamespace(read=lambda size: data[:size])
        return runtime_main(self.envelope(action="seal", runtimeSha256=sha or digest(data), bytes=len(data)), stream)

    def execute(self, fd, argv, env):
        self.executed.append((os.read(fd, 1024), argv, env, os.getcwd()))
        os.close(fd)
        raise SystemExit("executed")

    def drop(self):
        return types.SimpleNamespace(pw_dir=str(self.home))

    def rpc(self, sha=None):
        return runtime_main(self.envelope(action="rpc", runtimeSha256=sha or self.sha), Unread(),
                            self.execute, self.drop)

    def test_seal_stores_a_read_only_runtime_under_unwritable_directories(self):
        self.assertEqual(self.seal_input(), {"status": "sealed", "path": str(SEALED), "runtimeSha256": self.sha})
        self.assertEqual(SEALED.read_bytes(), self.binary)
        self.assertEqual(stat.S_IMODE(SEALED.stat().st_mode), 0o555)
        for directory in sealed_directories()[1:]:
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755, directory)
        self.assertEqual([p.name for p in SEALED.parent.iterdir()], ["terminalx-serve"])
        # Repeating the identical seal observes it; a different runtime is refused, never replaced.
        self.assertEqual(self.seal_input()["status"], "sealed")
        other = self.binary[:-1] + b"\x01"
        with self.assertRaises(ValueError):
            self.seal_input(other)
        self.assertEqual(SEALED.read_bytes(), self.binary)
        with self.assertRaises(ValueError):
            self.seal_input(sha="0" * 64)

    def test_rpc_executes_the_verified_inode_without_reading_stdin(self):
        self.seal_input()
        with self.assertRaises(SystemExit):
            self.rpc()
        data, argv, env, cwd = self.executed[0]
        self.assertEqual(data, self.binary)
        self.assertEqual(argv, [str(SEALED), "local-vm-rpc", "-"])
        self.assertEqual(set(env), {"HOME", "USER", "LOGNAME", "PATH", "LANG"})
        self.assertEqual(os.path.realpath(cwd), os.path.realpath(self.home))

    def test_rpc_refuses_a_changed_or_guest_writable_runtime(self):
        self.seal_input()
        with self.assertRaises(ValueError):
            self.rpc("f" * 64)
        os.chmod(SEALED.parent, 0o777)
        with self.assertRaises(ValueError):
            self.rpc()
        os.chmod(SEALED.parent, 0o755)
        os.chmod(SEALED, 0o755)
        with self.assertRaises(ValueError):
            self.rpc()
        SEALED.write_bytes(self.binary[:-1] + b"\x02")
        os.chmod(SEALED, 0o555)
        with self.assertRaises(ValueError):
            self.rpc()
        SEALED.unlink()
        SEALED.symlink_to(SEALED_ROOT / "elsewhere")
        (SEALED_ROOT / "elsewhere").write_bytes(self.binary)
        with self.assertRaises(OSError):
            self.rpc()
        self.assertEqual(self.executed, [])

    def test_only_the_owning_account_manages_it_and_fields_are_exact(self):
        global SEALED_OWNER
        with self.assertRaises(ValueError):
            runtime_main(self.envelope(action="rpc", runtimeSha256=self.sha, argv=["sh"]), Unread())
        with self.assertRaises(ValueError):
            runtime_main(self.envelope(action="install", runtimeSha256=self.sha), Unread())
        SEALED_OWNER = os.geteuid() + 1
        with self.assertRaises(ValueError):
            self.seal_input()
        self.assertFalse(os.path.lexists(SEALED_ROOT / "opt"))


unittest.main()
