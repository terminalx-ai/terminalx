# Executed after the production source, with entrypoints disabled. The sealed
# root is a disposable directory the test account owns, standing in for root.
import tempfile
import types
import unittest
from unittest import mock


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
        self.assertEqual(env["USER"], "terminalx-owner")
        self.assertEqual(env["LOGNAME"], "terminalx-owner")
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

    def test_setid_sealed_runtime_is_refused_before_the_key_is_read(self):
        self.seal_input()
        for mode in (0o4555, 0o2555, 0o1555):
            os.chmod(SEALED, mode)
            with self.assertRaises(ValueError):
                self.rpc()
        self.assertEqual(self.executed, [])

    def test_rpc_account_refusal_leaves_the_key_unread_and_closes_the_runtime(self):
        self.seal_input()
        opened = []
        original = open_sealed
        def observe(expected):
            fd = original(expected)
            opened.append(fd)
            return fd
        def refuse():
            raise ValueError("Owner account changed")
        with mock.patch.dict(globals(), open_sealed=observe):
            with self.assertRaisesRegex(ValueError, "Owner account changed"):
                runtime_main(self.envelope(action="rpc", runtimeSha256=self.sha), Unread(),
                             self.execute, refuse)
        with self.assertRaises(OSError):
            os.fstat(opened[0])
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



class OwnerAccount(unittest.TestCase):
    def setUp(self):
        self.entry = types.SimpleNamespace(pw_name=OWNER, pw_uid=991, pw_gid=992,
                                          pw_dir=str(OWNER_HOME), pw_shell="/usr/sbin/nologin")
        self.worker = types.SimpleNamespace(pw_name="cua", pw_uid=1000, pw_gid=1000)
        self.group = types.SimpleNamespace(gr_name=OWNER, gr_gid=992, gr_mem=[])
        self.info = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=991,
                                          st_gid=992, st_dev=1, st_ino=2)
        self.patches = [
            mock.patch.dict(globals(), safe_owner_ancestors=lambda: None, locked_owner_login=lambda: None),
            mock.patch.object(os.path, "lexists", return_value=False),
            mock.patch.object(platform, "system", return_value="Linux"),
            mock.patch.object(platform, "machine", return_value="aarch64"),
            mock.patch.object(pwd, "getpwnam", side_effect=lambda name: self.entry if name == OWNER else self.worker),
            mock.patch.object(pwd, "getpwall", side_effect=lambda: [self.entry, self.worker]),
            mock.patch.object(grp, "getgrall", side_effect=lambda: [self.group]),
            mock.patch.object(pathlib.Path, "lstat", side_effect=lambda: self.info),
            mock.patch.object(subprocess, "run", side_effect=AssertionError("Polling must never provision")),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_actual_owner_binding_and_no_poll_provisioning(self):
        observed = account()
        self.assertEqual(observed["name"], OWNER)
        self.assertEqual(observed["home"], "/var/lib/terminalx-owner")
        self.assertEqual((observed["uid"], observed["gid"]), (991, 992))
        with mock.patch.object(pwd, "getpwnam", side_effect=lambda name: self.worker if name == "cua" else (_ for _ in ()).throw(KeyError(name))):
            with self.assertRaises(ValueError):
                account()

    def test_shared_identity_groups_home_permissions_and_symlinks_refused(self):
        for field, bad in [("pw_uid", 0), ("pw_uid", 1000), ("pw_gid", 1000),
                           ("pw_dir", "/home/cua"), ("pw_shell", "/bin/sh")]:
            old = getattr(self.entry, field)
            setattr(self.entry, field, bad)
            with self.assertRaises(ValueError, msg=field):
                account()
            setattr(self.entry, field, old)
        self.group.gr_mem = ["cua"]
        with self.assertRaises(ValueError):
            account()
        self.group.gr_mem = [OWNER]
        with self.assertRaises(ValueError):
            account()
        self.group.gr_mem = []
        for mode in [stat.S_IFDIR | 0o755, stat.S_IFDIR | 0o770, stat.S_IFLNK | 0o700]:
            self.info.st_mode = mode
            with self.assertRaises(ValueError):
                account()

    def test_aliases_and_supplementary_memberships_are_refused(self):
        alias = types.SimpleNamespace(pw_name="alias", pw_uid=991, pw_gid=1001)
        with mock.patch.object(pwd, "getpwall", return_value=[self.entry, self.worker, alias]):
            with self.assertRaisesRegex(ValueError, "UID is shared"):
                account()
        alias.pw_uid, alias.pw_gid = 1001, 992
        with mock.patch.object(pwd, "getpwall", return_value=[self.entry, self.worker, alias]):
            with self.assertRaisesRegex(ValueError, "primary group is shared"):
                account()
        extra = types.SimpleNamespace(gr_name="extra", gr_gid=993, gr_mem=[OWNER])
        with mock.patch.object(grp, "getgrall", return_value=[self.group, extra]):
            with self.assertRaisesRegex(ValueError, "supplementary groups"):
                account()
        extra.gr_gid, extra.gr_mem = 992, []
        with mock.patch.object(grp, "getgrall", return_value=[self.group, extra]):
            with self.assertRaisesRegex(ValueError, "Owner group is shared"):
                account()

    def test_shared_account_history_is_refused_even_for_explicit_install(self):
        for old in ["identity.json", "account-binding.json", "runtime", "bin/terminalx-serve"]:
            path = pathlib.Path("/home/cua/.terminalx-local") / old
            with mock.patch.object(os.path, "lexists", side_effect=lambda value: pathlib.Path(value) == path):
                with self.assertRaisesRegex(ValueError, "Shared-account installation"):
                    account(provision=True)
        with mock.patch.object(os.path, "lexists", side_effect=lambda value: str(value) == "/home/cua/.terminalx-installs"):
            with self.assertRaisesRegex(ValueError, "installation history"):
                account(provision=True)

    def test_explicit_install_creates_only_the_fixed_system_account(self):
        created = []
        def lookup(name):
            if name == "cua":
                return self.worker
            if created:
                return self.entry
            raise KeyError(name)
        def create(argv, **kwargs):
            self.assertEqual(argv, ["/usr/sbin/useradd", "--system", "--user-group", "--no-create-home",
                                    "--home-dir", str(OWNER_HOME), "--shell", "/usr/sbin/nologin", OWNER])
            self.assertTrue(kwargs["close_fds"])
            created.append(True)
        with mock.patch.object(pwd, "getpwnam", side_effect=lookup), \
             mock.patch.object(os, "geteuid", return_value=0), \
             mock.patch.object(os.path, "lexists", return_value=False), \
             mock.patch.object(grp, "getgrnam", side_effect=KeyError(OWNER)), \
             mock.patch.object(subprocess, "run", side_effect=create), \
             mock.patch.object(pathlib.Path, "mkdir") as mkdir, \
             mock.patch.object(os, "chown") as chown, \
             mock.patch.dict(globals(), sync_directory=lambda path: None):
            self.assertEqual(account(provision=True)["uid"], 991)
            mkdir.assert_called_once_with(mode=0o700)
            chown.assert_called_once_with(OWNER_HOME, 991, 992)

    def test_missing_account_never_adopts_existing_home_or_group(self):
        def missing(name):
            if name == "cua":
                return self.worker
            raise KeyError(name)
        with mock.patch.object(pwd, "getpwnam", side_effect=missing), mock.patch.object(os, "geteuid", return_value=0):
            with mock.patch.object(os.path, "lexists", return_value=True):
                with self.assertRaises(ValueError):
                    account(provision=True)
            with mock.patch.object(os.path, "lexists", return_value=False), mock.patch.object(grp, "getgrnam", return_value=self.group):
                with self.assertRaises(ValueError):
                    account(provision=True)


class OwnerRootBoundary(unittest.TestCase):
    def test_drop_clears_all_groups_and_cannot_restore_root(self):
        observed = {"uid": 991, "gid": 992}
        calls = []
        def setuid(uid):
            calls.append(("uid", uid))
            if uid == 0:
                raise PermissionError()
        with mock.patch.dict(globals(), account=lambda: observed), \
             mock.patch.object(os, "setgroups", side_effect=lambda groups: calls.append(("groups", groups))), \
             mock.patch.object(os, "setgid", side_effect=lambda gid: calls.append(("gid", gid))), \
             mock.patch.object(os, "setuid", side_effect=setuid), \
             mock.patch.object(os, "getuid", side_effect=[0, 991]), \
             mock.patch.object(os, "geteuid", side_effect=[0, 991]), \
             mock.patch.object(os, "getgid", return_value=992), \
             mock.patch.object(os, "getegid", return_value=992), \
             mock.patch.object(os, "getgroups", return_value=[]), \
             mock.patch.object(pwd, "getpwnam", return_value="owner"):
            self.assertEqual(drop_to_account(), "owner")
        self.assertEqual(calls, [("groups", []), ("gid", 992), ("uid", 991), ("uid", 0)])

    def test_home_ancestors_cannot_be_writable_or_symlinks(self):
        safe = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        for unsafe in [types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o777, st_uid=0),
                       types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o755, st_uid=0),
                       types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=1000)]:
            for position in range(3):
                values = [safe, safe, safe]
                values[position] = unsafe
                with mock.patch.object(pathlib.Path, "lstat", side_effect=values):
                    with self.assertRaises(ValueError):
                        safe_owner_ancestors()

    def test_owner_login_must_be_locked(self):
        import io
        class Shadow(io.StringIO):
            def fileno(self):
                return 100
        safe = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o640, st_uid=0)
        for password, accepted in [("!", True), ("*", True), ("!hash", True), ("hash", False), ("", False)]:
            data = OWNER + ":" + password + ":1:0:99999:7:::" + "\n"
            with mock.patch.object(os, "open", return_value=100), \
                 mock.patch.object(os, "fdopen", return_value=Shadow(data)), \
                 mock.patch.object(os, "fstat", return_value=safe):
                if accepted:
                    locked_owner_login()
                else:
                    with self.assertRaises(ValueError):
                        locked_owner_login()

class WorkerBootstrapFixtures(unittest.TestCase):
    def test_worker_descriptor_collisions_and_clean_identity(self):
        import contextlib
        import itertools
        for sources in itertools.permutations(range(5), 3):
            table = {fd: ("unrelated", False) for fd in range(10)}
            for fd, name in zip(sources, ("sealed", "channel", "lifetime-read")):
                table[fd] = (name, False)
            table[20] = ("lifetime-write", False)
            calls = []
            def duplicate(fd, operation, minimum):
                self.assertEqual(operation, fcntl.F_DUPFD_CLOEXEC)
                dest = minimum
                while dest in table:
                    dest += 1
                table[dest] = (table[fd][0], False)
                return dest
            def dup2(source, dest, inheritable):
                table[dest] = (table[source][0], inheritable)
            def execute(fd, argv, env):
                self.assertEqual(table, {0: ("null", True), 1: ("null", True),
                    2: ("null", True), 3: ("channel", True), 4: ("lifetime-read", True),
                    fd: ("sealed", False)})
                self.assertGreater(fd, 4)
                self.assertEqual(argv, [str(SEALED), "local-vm-worker"])
                self.assertEqual(env, {"HOME": "/home/cua", "USER": "cua", "LOGNAME": "cua",
                    "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"})
                raise SystemExit()
            def open_null(path, flags):
                self.assertEqual(path, "/dev/null")
                table[30] = ("null", False)
                return 30
            patches = [
                mock.patch.object(fcntl, "fcntl", side_effect=duplicate),
                mock.patch.object(os, "open", side_effect=open_null),
                mock.patch.object(os, "fstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=os.makedev(1, 3))),
                mock.patch.object(os, "dup2", side_effect=dup2),
                mock.patch.object(os, "listdir", side_effect=lambda path: list(map(str, table))),
                mock.patch.object(os, "close", side_effect=lambda fd: table.pop(fd)),
                mock.patch.dict(globals(), drop_worker_privileges=lambda entry: calls.append("dropped")),
                mock.patch.object(os, "getuid", return_value=1000),
                mock.patch.object(os, "geteuid", return_value=1000),
                mock.patch.object(os, "getgid", return_value=1000),
                mock.patch.object(os, "getegid", return_value=1000),
                mock.patch.object(os, "getgroups", return_value=[]),
                mock.patch.object(os, "chdir"),
                mock.patch.object(os, "umask"),
            ]
            with contextlib.ExitStack() as stack:
                for patch in patches:
                    stack.enter_context(patch)
                with self.assertRaises(SystemExit):
                    worker_exec(*sources, types.SimpleNamespace(pw_uid=1000, pw_gid=1000,
                                pw_dir="/home/cua"), execute=execute)
            self.assertEqual(calls, ["dropped"])

    def test_worker_clears_capabilities_all_ids_and_blocks_future_privileges(self):
        import contextlib
        entry = types.SimpleNamespace(pw_uid=1000, pw_gid=1000)
        for failure in (None, "prctl", "capset", "capget", "ids"):
            calls = []
            def prctl(option, value, *unused):
                calls.append(("prctl", option.value, value.value))
                if failure == "prctl":
                    return -1
                return 1 if option.value == 39 else 0
            libc = types.SimpleNamespace(prctl=prctl,
                capset=lambda *args: -1 if failure == "capset" else 0,
                capget=lambda *args: -1 if failure == "capget" else 0)
            patches = [
                mock.patch.object(ctypes, "CDLL", return_value=libc),
                mock.patch.object(os, "setgroups", side_effect=lambda groups: calls.append(("groups", groups))),
                mock.patch.object(os, "setresgid", side_effect=lambda *ids: calls.append(("gids", ids)), create=True),
                mock.patch.object(os, "setresuid", side_effect=lambda *ids: calls.append(("uids", ids)), create=True),
                mock.patch.object(os, "getresgid", return_value=(1000,) * 3, create=True),
                mock.patch.object(os, "getresuid", return_value=(0 if failure == "ids" else 1000,) * 3, create=True),
                mock.patch.object(os, "getgroups", return_value=[]),
                mock.patch.object(os, "setuid", side_effect=PermissionError()),
            ]
            with contextlib.ExitStack() as stack:
                for patch in patches:
                    stack.enter_context(patch)
                if failure:
                    with self.assertRaises(ValueError):
                        drop_worker_privileges(entry)
                else:
                    drop_worker_privileges(entry)
                    self.assertEqual(calls, [("prctl", 8, 0), ("prctl", 47, 4),
                        ("groups", []), ("gids", (1000,) * 3), ("uids", (1000,) * 3),
                        ("prctl", 38, 1), ("prctl", 39, 0)])

    def test_parent_endpoints_drop_failure_and_retained_exit(self):
        import contextlib
        for fail_drop in (False, True):
            channels, pipes = [], []
            real_pair = socket.socketpair
            def pair(*args):
                values = real_pair(*args)
                channels.extend(values)
                return values
            def pipe(flags):
                values = os.pipe()
                pipes.extend(values)
                return values
            runtime_fd = os.open("/dev/null", os.O_RDONLY)
            owner = {"uid": 991, "gid": 992}
            def drop():
                self.assertEqual(channels[1].fileno(), -1)
                with self.assertRaises(OSError):
                    os.fstat(pipes[0])
                if fail_drop:
                    raise ValueError("drop refused")
            patches = [
                mock.patch.object(os, "getuid", side_effect=[0, 991]),
                mock.patch.object(os, "geteuid", return_value=0),
                mock.patch.object(os, "getgid", return_value=992),
                mock.patch.object(os, "fork", return_value=123),
                mock.patch.object(os, "pipe2", side_effect=pipe, create=True),
                mock.patch.object(socket, "socketpair", side_effect=pair),
                mock.patch.dict(globals(), account=lambda: owner, worker_account=lambda owner: None,
                                open_sealed=lambda sha: runtime_fd, drop_to_account=drop),
            ]
            with contextlib.ExitStack() as stack:
                for patch in patches:
                    stack.enter_context(patch)
                if fail_drop:
                    with self.assertRaises(WorkerBootstrapFailed) as error:
                        launch_worker("a" * 64)
                    child = error.exception.child
                    self.assertEqual(child.channel.fileno(), -1)
                    self.assertIsNone(child.lifetime)
                else:
                    child = launch_worker("a" * 64)
                    self.assertGreaterEqual(child.channel.fileno(), 0)
                    self.assertEqual(child.lifetime, pipes[1])
                with self.assertRaises(OSError):
                    os.fstat(runtime_fd)
                with mock.patch.object(os, "waitpid", side_effect=[(0, 0), (123, 0)]) as wait:
                    self.assertIsNone(child.poll())
                    self.assertEqual(child.poll(), 0)
                    self.assertEqual(child.poll(), 0)
                    self.assertEqual(wait.call_count, 2)
                    wait.assert_called_with(123, os.WNOHANG)
                child.close()
                child.close()
            for fd in pipes:
                with self.assertRaises(OSError):
                    os.fstat(fd)

    def test_malformed_bootstrap_does_not_fork_or_read_secrets(self):
        with mock.patch.object(os, "getuid", return_value=0), \
             mock.patch.object(os, "geteuid", return_value=0), \
             mock.patch.object(os, "fork", side_effect=AssertionError("must not fork")):
            for sha in (None, "", "x" * 64, "a" * 65):
                with self.assertRaises(ValueError):
                    launch_worker(sha)
        envelope = base64.b64encode(canonical({"action": "worker", "runtimeSha256": "a" * 64})).decode()
        with mock.patch.object(os, "geteuid", return_value=SEALED_OWNER):
            with self.assertRaisesRegex(ValueError, "Unknown runtime action"):
                runtime_main([envelope], Unread())


unittest.main()
