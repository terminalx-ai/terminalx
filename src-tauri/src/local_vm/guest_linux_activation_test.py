# Executed after the production source, with entrypoints disabled. All process
# effects are fake objects; account/home/artifact state uses disposable files.
import tempfile
import unittest


class ActivationFixtures(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = pathlib.Path(self.temporary.name)
        self.observed = {"name": "cua", "uid": 1000, "gid": 1000, "home": "/home/cua",
                         "homeDevice": 1, "homeInode": 2, "architecture": "arm64"}
        binary = bytearray(64)
        binary[:7] = b"\x7fELF\x02\x01\x01"
        binary[16], binary[18], binary[20], binary[52] = 3, 183, 1, 64
        self.intent = {"binding": {"target": {"kind": "linuxContainer", "runtime": "docker", "id": "a" * 64},
                       "environmentId": str(uuid.uuid4()), "generation": str(uuid.uuid4()),
                       "architecture": "arm64", "account": self.observed}, "profileId": "fixture",
                       "sourceCommit": "a" * 40, "runtimeSha256": digest(binary), "protocol": 1, "bytes": 64}
        install = {"action": "install", "requestDigest": "b" * 64,
                   "inputDigest": digest(canonical(self.intent)), "intent": self.intent}
        transact(self.home, self.observed, install, bytes(binary))
        install["action"] = "receipt"
        self.header = {"action": "start", "activationId": str(uuid.uuid4()), "installation": install}
        self.spawns = 0
        self.terminations = 0
        self.polls = 0
        self.child_lease = None
        self.addCleanup(self.close_child)

    def close_child(self):
        if self.child_lease is not None:
            os.close(self.child_lease)
            self.child_lease = None

    def observe(self, action="status"):
        return activation_observe(self.home, self.observed, dict(self.header, action=action))

    def spawn(self, argv, **kwargs):
        self.spawns += 1
        self.assertEqual(argv, [str(self.home / ".terminalx-local/bin/terminalx-serve"), "--data-dir",
                               str(self.home / ".terminalx-local/runtime"), "--runtime-kind", "local"])
        self.assertEqual(set(kwargs["env"]), {"HOME", "USER", "LOGNAME", "PATH", "LANG",
                                             "TERMINALX_LINUX_ACTIVATION", "TERMINALX_LINUX_INSTANCE"})
        self.assertTrue(kwargs["close_fds"])
        self.assertEqual(len(kwargs["pass_fds"]), 1)
        self.child_lease = os.dup(kwargs["pass_fds"][0])
        outer = self
        class Child:
            def poll(self):
                outer.polls += 1
                if outer.polls > 1:
                    outer.close_child()
                    return -15 if outer.terminations else 0
                return None
            def terminate(self):
                outer.terminations += 1
        return Child()

    def test_duplicate_and_reopen_observe_original_owner_without_replay(self):
        def pause(_):
            proof = self.observe()
            self.assertTrue(proof["ownerLeaseHeld"])
            self.assertFalse(proof["terminal"])
            duplicate = activation_supervise(self.home, self.observed, self.header,
                                             lambda *a, **k: self.fail("duplicate spawn"))
            self.assertEqual(duplicate, proof["receipt"])
        result = activation_supervise(self.home, self.observed, self.header, self.spawn, pause)
        self.assertEqual(result["exitProof"], "originalChildWait")
        self.assertTrue(self.observe()["terminal"])
        self.assertEqual(self.spawns, 1)

    def test_cancel_before_delayed_start_is_a_durable_tombstone(self):
        self.assertTrue(self.observe("cancel")["terminal"])
        activation_supervise(self.home, self.observed, self.header,
                             lambda *a, **k: self.fail("canceled activation launched"))
        self.assertEqual(self.spawns, 0)

    def test_cancellation_signals_only_the_original_child_and_waits(self):
        old_spawn = self.spawn
        def spawn(*a, **k):
            child = old_spawn(*a, **k)
            def poll():
                if self.terminations:
                    self.close_child()
                    return -15
                return None
            child.poll = poll
            return child
        result = activation_supervise(self.home, self.observed, self.header, spawn,
                                      lambda _: self.observe("cancel"))
        self.assertEqual(self.terminations, 1)
        self.assertEqual(result["status"], "canceled")
        self.assertTrue(self.observe()["terminal"])

    def test_supervisor_loss_preserves_child_lease_and_never_replaces_or_signals_pid(self):
        def interrupt(_):
            raise RuntimeError("lost supervisor")
        with self.assertRaises(RuntimeError):
            activation_supervise(self.home, self.observed, self.header, self.spawn, interrupt)
        self.assertTrue(self.observe()["ownerLeaseHeld"])
        self.observe("cancel")
        activation_supervise(self.home, self.observed, self.header,
                             lambda *a, **k: self.fail("replacement launched"))
        self.assertEqual(self.terminations, 0)
        self.close_child()
        self.assertFalse(self.observe()["terminal"])  # missing terminal receipt stays fenced

    def test_preexisting_owner_history_is_never_replaced(self):
        (self.home / ".terminalx-local/runtime/run").mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            activation_supervise(self.home, self.observed, self.header,
                                 lambda *a, **k: self.fail("existing owner replaced"))

    def test_uncertain_spawn_and_changed_binding_never_replay(self):
        def failed(*a, **k):
            raise RuntimeError("spawn outcome unknown")
        with self.assertRaises(RuntimeError):
            activation_supervise(self.home, self.observed, self.header, failed)
        self.assertFalse(self.observe()["terminal"])
        activation_supervise(self.home, self.observed, self.header,
                             lambda *a, **k: self.fail("uncertain spawn replayed"))
        with self.assertRaises(ValueError):
            activation_observe(self.home, dict(self.observed, homeInode=99), dict(self.header, action="status"))
        with self.assertRaises(ValueError):
            activation_observe(self.home, self.observed, dict(self.header, action="status", activationId=str(uuid.uuid4())))
        (self.home / ".terminalx-local/bin/terminalx-serve").write_bytes(b"replacement")
        with self.assertRaises(ValueError):
            self.observe()


unittest.main()
