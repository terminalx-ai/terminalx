"""TXGuestProtocol version 2 across languages: the real Swift owner, the real
Rust guest helper, and an independent standard-library reference that also
plays a hostile helper and a hostile owner. No VM, share or real key is used."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

OWNER = Path(sys.argv.pop(1)).resolve()
HELPER = Path(sys.argv.pop(1)).resolve()
VECTORS = Path(__file__).resolve().parents[3] / 'native/vm-bootstrap/tests/vectors'
PREFIX = 'terminalx-vm-enrollment-v2'

def wire(v): return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
def digest(b): return hashlib.sha256(b).hexdigest()
def tag(key, domain, parts):
    message = b''.join(struct.pack('!I', len(p.encode())) + p.encode() for p in [PREFIX, domain] + parts)
    return hmac.new(key, message, hashlib.sha256).hexdigest()
def hkdf(ikm, salt, info, n=32):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out, block, i = b'', b'', 1
    while len(out) < n:
        block = hmac.new(prk, block + info + bytes([i]), hashlib.sha256).digest(); out += block; i += 1
    return out[:n]
def session_key(key, client, server, challenge_sha):
    return hkdf(key, bytes.fromhex(client) + bytes.fromhex(server), f'{PREFIX} session {challenge_sha}'.encode())
def frame(key, direction, seq, body): return {'body': body, 'seq': seq, 'tag': tag(key, 'frame', [direction, str(seq), digest(wire(body))])}
def acceptance(sha): return {'accountAuthenticated': False, 'challengeSha256': sha, 'helperAuthenticated': True, 'ready': False, 'trustAccepted': False}
def send_raw(s, data): s.sendall(struct.pack('!I', len(data)) + data)
def send(s, v): send_raw(s, wire(v))
def read_raw(s):
    def exact(n):
        out = b''
        while len(out) < n:
            part = s.recv(n - len(out))
            if not part: raise EOFError()
            out += part
        return out
    n = struct.unpack('!I', exact(4))[0]
    if n == 0 or n > 256 * 1024: raise ValueError('frame bound')
    return exact(n)

class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='txe-', dir='/private/tmp')
        unittest.addModuleCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.journal = self.root / 'journal'; self.journal.mkdir(mode=0o700)
        self.key = os.urandom(32)
        self.binding = {'bootstrapId': str(uuid.uuid4()), 'seedId': os.urandom(16).hex(), 'bindingDigest': os.urandom(32).hex(),
                        'ownerEpoch': str(uuid.uuid4()), 'seedReceiptSha256': os.urandom(32).hex()}
        self.config = self.private('owner.json', {'key': self.key.hex(), 'journal': str(self.journal), **self.binding})
        self.seed = self.private('enrollment.json', {'bootstrapId': self.binding['bootstrapId'], 'key': base64.b64encode(self.key).decode(),
                                                     'seedId': self.binding['seedId'], 'version': 1})
        self.outputs = []
    def private(self, name, value):
        path = self.root / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as f: f.write(wire(value))
        return path
    def owner(self, limit, count):
        pairs = [socket.socketpair() for _ in range(count)]
        ends = [p[0] for p in pairs]
        process = subprocess.Popen([str(OWNER), 'enroll-gate', str(self.config), str(limit), *[str(e.fileno()) for e in ends]],
                                   pass_fds=[e.fileno() for e in ends], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for e in ends: e.close()
        return process, [p[1] for p in pairs]
    def finish(self, process):
        out, err = process.communicate(timeout=60)
        self.outputs += [out, err]
        lines = [json.loads(line) for line in out.decode().splitlines()]
        return lines[:-1], lines[-1]
    def secret_free(self):
        forms = [self.key.hex().encode(), base64.b64encode(self.key)]
        texts = self.outputs + [p.read_bytes() for p in self.journal.iterdir()]
        return not any(f in t for f in forms for t in texts)
    def hello(self, **change): return {'bootstrapId': self.binding['bootstrapId'], 'clientNonce': os.urandom(32).hex(), 'seedId': self.binding['seedId'], 'version': 2, **change}

def honest_helper(f, s, key=None, claims=None, before_proof=None, session=True):
    """A conforming helper. Returns the challenge bytes and the owner's echo."""
    key = key or f.key
    hello = f.hello(); send(s, hello)
    challenge_bytes = read_raw(s); challenge = json.loads(challenge_bytes)
    claims = claims if claims is not None else {'euid': 0, 'reference': True}
    sha = digest(challenge_bytes)
    proof = {'challengeSha256': sha, 'claims': claims, 'proof': tag(key, 'enrollment', [sha, digest(wire(claims))])}
    if before_proof: proof = before_proof(proof, challenge_bytes)
    send(s, proof)
    k = session_key(key, hello['clientNonce'], challenge['serverNonce'], sha)
    accepted = json.loads(read_raw(s))
    assert accepted == frame(k, 'owner', 0, acceptance(sha)), accepted
    if not session: return challenge_bytes, None, k
    send(s, frame(k, 'helper', 0, {'hello': 'reference'}))
    return challenge_bytes, json.loads(read_raw(s)), k

def attempt_quietly(action):
    try: action()
    except (EOFError, ConnectionError, ValueError, AssertionError, OSError): pass

class OwnerAndHelper(unittest.TestCase):
    def test_rust_helper_and_swift_owner_enroll_and_exchange_tagged_frames(self):
        f = Fixture()
        process, (helper_end,) = f.owner(limit=3, count=1)
        helper = subprocess.run([str(HELPER), str(helper_end.fileno()), str(f.seed)], pass_fds=[helper_end.fileno()],
                                capture_output=True, timeout=30)
        helper_end.close()
        attempts, state = f.finish(process)
        f.outputs += [helper.stdout, helper.stderr]
        rust = json.loads(helper.stdout)
        self.assertEqual(helper.returncode, 0, helper.stdout)
        owner = attempts[0]
        self.assertTrue(owner['authenticated'] and rust['authenticated'])
        self.assertEqual(owner['claims'], {'euid': os.geteuid(), 'fixture': True})
        self.assertEqual(rust['echo'], {'echo': {'hello': 'rust helper'}})
        journaled = (f.journal / 'challenge-0.json').read_bytes()
        self.assertEqual(owner['challengeSha256'], rust['challengeSha256'])
        self.assertEqual(owner['challengeSha256'], digest(journaled))
        challenge = json.loads(journaled)
        self.assertEqual({k: challenge[k] for k in f.binding}, f.binding)
        self.assertEqual((owner['sent'], owner['received']), (2, 1))
        self.assertEqual(state, {'claimed': True, 'refusals': 0, 'fenced': False})
        self.assertTrue(f.secret_free())

    def test_reference_helper_interoperates_with_the_swift_owner(self):
        f = Fixture()
        process, (s,) = f.owner(limit=1, count=1)
        _, echo, k = honest_helper(f, s)
        self.assertEqual(echo, frame(k, 'owner', 1, {'echo': {'hello': 'reference'}}))
        s.close()
        attempts, state = f.finish(process)
        self.assertTrue(attempts[0]['authenticated'])
        self.assertEqual(state['claimed'], True)

class OwnerRefusals(unittest.TestCase):
    def test_failed_proofs_spend_the_budget_but_never_the_claim(self):
        f = Fixture()
        process, sockets = f.owner(limit=3, count=3)
        attempt_quietly(lambda: honest_helper(f, sockets[0], key=os.urandom(32)))
        # Claims changed after the proof was computed.
        attempt_quietly(lambda: honest_helper(f, sockets[1], before_proof=lambda p, _: {**p, 'claims': {'euid': 501}}))
        honest_helper(f, sockets[2])
        for s in sockets: s.close()
        attempts, state = f.finish(process)
        self.assertEqual([a.get('authenticated') for a in attempts], [False, False, True])
        self.assertEqual(state, {'claimed': True, 'refusals': 2, 'fenced': False})
        self.assertTrue(f.secret_free())

    def test_spent_budget_fences_before_a_valid_proof(self):
        f = Fixture()
        process, sockets = f.owner(limit=2, count=3)
        for s in sockets[:2]: attempt_quietly(lambda s=s: honest_helper(f, s, key=os.urandom(32)))
        attempt_quietly(lambda: honest_helper(f, sockets[2]))
        for s in sockets: s.close()
        attempts, state = f.finish(process)
        self.assertEqual(attempts[2], {'attempt': 2, 'admitted': False})
        self.assertEqual(state, {'claimed': False, 'refusals': 2, 'fenced': True})

    def test_a_claimed_enrollment_admits_nothing_more(self):
        f = Fixture()
        process, sockets = f.owner(limit=3, count=2)
        honest_helper(f, sockets[0]); sockets[0].close()
        attempt_quietly(lambda: honest_helper(f, sockets[1]))
        sockets[1].close()
        attempts, state = f.finish(process)
        self.assertEqual(attempts[1], {'attempt': 1, 'admitted': False})
        self.assertEqual((state['claimed'], state['refusals']), (True, 0))

    def test_replayed_and_redirected_proofs_refuse(self):
        f = Fixture()
        process, sockets = f.owner(limit=4, count=4)
        captured = {}
        def capture(proof, challenge):
            captured['proof'] = proof; raise EOFError()  # walk away before sending
        attempt_quietly(lambda: honest_helper(f, sockets[0], before_proof=capture))
        sockets[0].close()
        attempt_quietly(lambda: honest_helper(f, sockets[1], before_proof=lambda p, _: captured['proof']))
        attempt_quietly(lambda: honest_helper(f, sockets[2], before_proof=lambda p, _: {**captured['proof'], 'challengeSha256': p['challengeSha256']}))
        honest_helper(f, sockets[3])
        for s in sockets: s.close()
        attempts, state = f.finish(process)
        self.assertEqual([a.get('authenticated') for a in attempts], [False, False, False, True])
        nonces = {json.loads((f.journal / f'challenge-{i}.json').read_bytes())['serverNonce'] for i in range(4)}
        self.assertEqual(len(nonces), 4, 'every attempt gets a fresh challenge')
        self.assertEqual(state['refusals'], 3)

    def test_hellos_for_another_seed_binding_or_form_refuse_before_any_challenge(self):
        f = Fixture()
        process, sockets = f.owner(limit=5, count=5)
        bad = [f.hello(seedId=os.urandom(16).hex()), f.hello(bootstrapId=str(uuid.uuid4())), f.hello(version=1)]
        for s, hello in zip(sockets, bad):
            send(s, hello); attempt_quietly(lambda s=s: read_raw(s))
        noncanonical = f.hello()
        send_raw(sockets[3], json.dumps(noncanonical, indent=1).encode()); attempt_quietly(lambda: read_raw(sockets[3]))
        honest_helper(f, sockets[4])
        for s in sockets: s.close()
        attempts, state = f.finish(process)
        self.assertEqual([a.get('authenticated') for a in attempts], [False] * 4 + [True])
        self.assertEqual(sorted(p.name for p in f.journal.iterdir()), ['challenge-4.json'], 'no challenge for a refused hello')
        self.assertEqual(state['refusals'], 4)

    def test_limits_closed_streams_and_silence_refuse_within_bounds(self):
        f = Fixture()
        process, sockets = f.owner(limit=5, count=5)
        sockets[0].sendall(struct.pack('!I', 256 * 1024 + 1))
        sockets[1].close()
        started = time.monotonic()  # sockets[2] stays silent
        many = {f'c{i}': i for i in range(17)}
        attempt_quietly(lambda: (time.sleep(0), honest_helper(f, sockets[3], claims=many)))
        honest_helper(f, sockets[4])
        for s in sockets: s.close()
        attempts, state = f.finish(process)
        self.assertLess(time.monotonic() - started, 20)
        self.assertEqual([a.get('authenticated') for a in attempts], [False, False, False, False, True])
        self.assertEqual(state, {'claimed': True, 'refusals': 4, 'fenced': False})

    def test_session_frames_out_of_sequence_or_tampered_end_the_session_only(self):
        for name, change in [('sequence', lambda k: frame(k, 'helper', 1, {'x': 1})),
                             ('tag', lambda k: {**frame(k, 'helper', 0, {'x': 1}), 'body': {'x': 2}}),
                             ('reflected', lambda k: frame(k, 'owner', 0, {'x': 1}))]:
            f = Fixture()
            process, (s,) = f.owner(limit=1, count=1)
            _, _, k = honest_helper(f, s, session=False)
            send(s, change(k)); attempt_quietly(lambda: read_raw(s)); s.close()
            attempts, state = f.finish(process)
            self.assertTrue(attempts[0]['authenticated'], name)
            self.assertIn('sessionError', attempts[0], name)
            self.assertEqual((attempts[0]['received'], state['claimed']), (0, True), name)

class HelperRefusals(unittest.TestCase):
    def hostile_owner(self, mutate_challenge=lambda c: c, mutate_accept=lambda k, sha, f: f, mutate_echo=None):
        f = Fixture()
        owner, helper_end = socket.socketpair()
        process = subprocess.Popen([str(HELPER), str(helper_end.fileno()), str(f.seed)], pass_fds=[helper_end.fileno()],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        helper_end.close()
        sent_proof = None
        try:
            hello = json.loads(read_raw(owner))
            challenge = mutate_challenge({'bindingDigest': f.binding['bindingDigest'], 'bootstrapId': hello['bootstrapId'],
                'clientNonce': hello['clientNonce'], 'ownerEpoch': f.binding['ownerEpoch'], 'seedId': hello['seedId'],
                'seedReceiptSha256': f.binding['seedReceiptSha256'], 'serverNonce': os.urandom(32).hex(), 'version': 2})
            data = wire(challenge); send_raw(owner, data); sha = digest(data)
            sent_proof = json.loads(read_raw(owner))
            k = session_key(f.key, hello['clientNonce'], challenge['serverNonce'], sha)
            send(owner, mutate_accept(k, sha, frame(k, 'owner', 0, acceptance(sha))))
            helper_frame = json.loads(read_raw(owner))
            send(owner, (mutate_echo or (lambda k: frame(k, 'owner', 1, {'echo': helper_frame['body']})))(k))
        except (EOFError, ConnectionError, ValueError):
            pass
        out, _ = process.communicate(timeout=30)
        owner.close()
        return process.returncode, json.loads(out), sent_proof

    def test_a_conforming_reference_owner_is_accepted(self):
        code, result, proof = self.hostile_owner()
        self.assertEqual((code, result['authenticated']), (0, True))
        self.assertEqual(set(proof), {'challengeSha256', 'claims', 'proof'})

    def test_challenges_for_another_seed_or_hello_get_no_proof(self):
        for change in [{'seedId': os.urandom(16).hex()}, {'bootstrapId': str(uuid.uuid4())}, {'clientNonce': os.urandom(32).hex()}, {'version': 1}]:
            code, result, proof = self.hostile_owner(mutate_challenge=lambda c, change=change: {**c, **change})
            self.assertEqual((code, result['authenticated'], proof), (3, False, None), change)

    def test_promoted_or_mistagged_acceptance_and_bad_echo_refuse(self):
        cases = [lambda k, sha, f: frame(k, 'owner', 0, {**acceptance(sha), 'trustAccepted': True}),
                 lambda k, sha, f: frame(k, 'owner', 0, {**acceptance(sha), 'accountAuthenticated': True}),
                 lambda k, sha, f: {**f, 'tag': tag(os.urandom(32), 'frame', ['owner', '0', digest(wire(f['body']))])},
                 lambda k, sha, f: frame(k, 'helper', 0, acceptance(sha))]
        for case in cases:
            code, result, _ = self.hostile_owner(mutate_accept=case)
            self.assertEqual((code, result['authenticated']), (3, False))
        code, result, _ = self.hostile_owner(mutate_echo=lambda k: frame(k, 'owner', 2, {'echo': {}}))
        self.assertEqual((code, result['authenticated']), (3, False))

class Vectors(unittest.TestCase):
    def test_rust_pinned_vectors_match_this_reference(self):
        key = bytes([0x42]) * 32
        self.assertEqual((VECTORS / 'enrollment-tag.txt').read_text().strip(), tag(key, 'enrollment', ['a' * 64, 'b' * 64]))
        self.assertEqual((VECTORS / 'session-key.txt').read_text().strip(), session_key(key, '1' * 64, '2' * 64, '3' * 64).hex())

if __name__ == '__main__':
    unittest.main()
