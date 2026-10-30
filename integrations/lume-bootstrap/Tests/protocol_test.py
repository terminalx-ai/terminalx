"""Exercises the real candidate socket/HMAC/filesystem implementation, no VM."""
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

BINARY = Path(sys.argv.pop(1)).resolve()
# Optional: the real Rust guest helper fixture for version-3 listener tests.
HELPER = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else None
def wire(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(v): return hashlib.sha256(v).hexdigest()
def uid(): return str(uuid.uuid4())
def b64(v): return base64.b64encode(v).decode()
def tag(secret, domain, parts):
    message=b''.join(struct.pack('!I',len(v.encode()))+v.encode() for v in ['terminalx-lume-owner-v1',domain]+parts)
    return hmac.new(secret,message,hashlib.sha256).hexdigest()
def send(s,v):
    data=wire(v);s.sendall(struct.pack('!I',len(data))+data)
def read(s):
    def exact(n):
        result=b''
        while len(result)<n:
            part=s.recv(n-len(result))
            if not part:raise EOFError()
            result+=part
        return result
    n=struct.unpack('!I',exact(4))[0]
    if n>256*1024:raise ValueError('frame too large')
    return json.loads(exact(n))
def private(path,data):
    path.write_bytes(data);path.chmod(0o600)

class Fixture:
    def __init__(self):
        self.temp=tempfile.TemporaryDirectory(prefix='txb-',dir='/private/tmp')
        self.root=Path(self.temp.name);self.op=self.root/'op';self.vm=self.root/'vm'
        for p in [self.op,self.vm,self.op/'input',self.op/'receipt']:p.mkdir(mode=0o700)
        for name in ['config.json','disk.img','nvram.bin']:private(self.vm/name,wire({'os':'macOS'}) if name=='config.json' else b'synthetic')
        paths={'operation':self.op,'storage':self.root,'vm':self.vm,'config':self.vm/'config.json','disk':self.vm/'disk.img','nvram':self.vm/'nvram.bin','input':self.op/'input','output':self.op/'receipt'}
        self.binding={'version':1,'macosMajor':26,**{k:uid() for k in ['bootstrapId','ownerEpoch','environmentId','generation','parentSession','parentTab','inputShareId','outputShareId']},
          **{k:'a'*64 for k in ['nonce','vmFingerprint','restoreSha256','runtimeSha256','helperManifestSha256']},
          'executableSha256':digest(BINARY.read_bytes()),'parentConversation':'original',
          'configSha256':digest((self.vm/'config.json').read_bytes()),
          'paths':{k:{'path':str(p),'device':p.stat().st_dev,'inode':p.stat().st_ino} for k,p in paths.items()}}
        self.secret=bytes([17])*32
        self.view={'running':True,'shares':[{'name':'input','path':str(self.op/'input'),'readOnly':True},{'name':'receipt','path':str(self.op/'receipt'),'readOnly':False}]}
        self.store_view()
        private(self.op/'owner-intent.json',wire(self.binding))
        private(self.op/'receipt/account-receipt.json',wire({'stage':'syntheticAccount','ready':False}))
        self.process=None
    def store_view(self):private(self.op/'fixture-view.json',wire(self.view))
    def start(self,n=1, binding=None, retained=True):
        value=binding or self.binding
        raw=wire(value)
        if retained:private(self.op/'owner-intent.json',raw)
        self.bd=digest(raw)
        a,b=socket.socketpair();a.settimeout(5)
        self.process=subprocess.Popen([str(BINARY),str(b.fileno()),str(n)],pass_fds=[b.fileno()],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        b.close()
        send(a,{'binding':b64(raw),'capability':b64(self.secret)})
        try:
            announced=read(a)
            body=base64.b64decode(announced['payload'])
            assert announced['mac']==tag(self.secret,'launch',[digest(body)])
            self.announcement=json.loads(body)
            assert self.announcement['bindingDigest']==self.bd
            assert self.announcement['epoch']==value['ownerEpoch']
            assert self.announcement['ownerPid']==self.process.pid
            assert not self.announcement['consoleAvailable']
        except EOFError as error:
            out,err=self.process.communicate(timeout=5)
            raise EOFError(err.decode()) from error
        finally:a.close()
    def connect(self,action='accountReceipt',request=None,extra=None):
        s=socket.socket(socket.AF_UNIX);s.settimeout(5);s.connect(str(self.op/'owner.sock'))
        request=request or {'action':action,'bindingDigest':self.bd,'clientNonce':'b'*64,'requestId':uid()}
        if extra:request.update(extra)
        send(s,request)
        try:challenge=read(s)
        except BaseException:
            s.close();raise
        parts=[self.bd,self.binding['ownerEpoch'],request['action'],request['requestId'],request['clientNonce'],challenge['serverNonce']]
        assert challenge['mac']==tag(self.secret,'owner',parts)
        return s,parts
    def call(self,action='accountReceipt'):
        s,parts=self.connect(action)
        with s:
            send(s,{'mac':tag(self.secret,'host',parts)})
            result=read(s);raw=base64.b64decode(result['payload'])
            assert result['mac']==tag(self.secret,'receipt',parts+[digest(raw)])
            payload=json.loads(raw);receipt=base64.b64decode(payload['receipt'])
            assert payload['receiptSha256']==digest(receipt)
            assert not payload['ready'] and not payload['consoleAvailable']
            return payload,receipt
    def finish(self):
        if self.process:
            out,err=self.process.communicate(timeout=12)
            assert self.secret.hex().encode() not in out+err and b64(self.secret).encode() not in out+err
        self.temp.cleanup()

class ProtocolTests(unittest.TestCase):
    def test_nonreading_peer_cannot_extend_absolute_write_deadline(self):
        a,b=socket.socketpair()
        started=time.monotonic()
        process=subprocess.Popen([str(BINARY),str(b.fileno()),'wire-backpressure'],pass_fds=[b.fileno()],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        b.close()
        try:
            out,err=process.communicate(timeout=5)
            self.assertEqual(process.returncode,2)
            self.assertLess(time.monotonic()-started,5)
            self.assertGreater(time.monotonic()-started,2)
        finally:
            a.close()
            process.communicate(timeout=5)
    def fixture(self,n=1):
        f=Fixture();self.addCleanup(f.finish);f.start(n);return f
    def test_authenticated_receipt_and_reconnect_same_owner(self):
        f=self.fixture(3)
        before=(f.op/'receipt/account-receipt.json').read_bytes()
        for _ in range(2):self.assertEqual(f.call()[1],before)
        self.assertEqual(f.call('observe')[1],b'')
        self.assertEqual((f.op/'owner.sock').stat().st_mode&0o777,0o600)
        self.assertEqual((f.op/'owner-started.json').stat().st_mode&0o777,0o600)
    def test_invalid_auth_and_replayed_challenge_refused(self):
        f=self.fixture(3)
        s,parts=f.connect();auth=tag(f.secret,'host',parts)
        with s:
            send(s,{'mac':'0'*64})
            with self.assertRaises(EOFError):read(s)
        s,second=f.connect()
        self.assertNotEqual(parts[-1],second[-1])
        with s:
            send(s,{'mac':auth})
            with self.assertRaises(EOFError):read(s)
        f.call()
    def test_caller_selected_endpoint_proof_and_stale_binding_refused(self):
        f=self.fixture(3)
        for extra in [{'endpoint':'127.0.0.1:5900'},{'proof':{'trusted':True}},{'bindingDigest':'c'*64}]:
            with self.assertRaises(EOFError):f.connect(extra=extra)
    def test_share_or_vm_state_change_after_challenge_refused(self):
        for mutation in ['state','extra-share','writable-input','other-output','swapped-names']:
            with self.subTest(mutation=mutation):
                f=self.fixture()
                s,parts=f.connect()
                if mutation=='state':f.view['running']=False
                elif mutation=='extra-share':f.view['shares'].append({'name':'extra','path':str(f.root),'readOnly':True})
                elif mutation=='writable-input':f.view['shares'][0]['readOnly']=False
                elif mutation=='swapped-names':
                    f.view['shares'][0]['name']='receipt';f.view['shares'][1]['name']='input'
                else:f.view['shares'][1]['path']=str(f.op/'input')
                f.store_view()
                with s:
                    send(s,{'mac':tag(f.secret,'host',parts)})
                    with self.assertRaises(EOFError):read(s)
    def test_replaced_config_share_socket_and_receipt_alias_refused(self):
        for mutation in ['config','share','socket','receipt-symlink','receipt-hardlink','oversize','original-intent','start-history']:
            with self.subTest(mutation=mutation):
                f=self.fixture()
                s,parts=f.connect()
                receipt=f.op/'receipt/account-receipt.json'
                if mutation=='config':private(f.vm/'config.json',b'changed')
                elif mutation=='share':
                    (f.op/'input').rename(f.op/'retained-input');(f.op/'input').mkdir(mode=0o700)
                elif mutation=='socket':(f.op/'owner.sock').rename(f.op/'retained.sock')
                elif mutation=='receipt-symlink':
                    receipt.rename(f.op/'receipt/retained');receipt.symlink_to(f.op/'receipt/retained')
                elif mutation=='receipt-hardlink':os.link(receipt,f.op/'receipt/alias')
                elif mutation=='original-intent':private(f.op/'owner-intent.json',b'{}')
                elif mutation=='start-history':private(f.op/'owner-started.json',b'partial')
                else:private(receipt,b'x'*(64*1024+1))
                with s:
                    send(s,{'mac':tag(f.secret,'host',parts)})
                    with self.assertRaises(EOFError):read(s)
    def test_original_intent_mismatch_and_unknown_start_never_recreated(self):
        f=Fixture();self.addCleanup(f.finish)
        changed=dict(f.binding,ownerEpoch=uid())
        with self.assertRaises(EOFError):f.start(binding=changed,retained=False)
        self.assertFalse((f.op/'owner-started.json').exists())
        f.process.communicate(timeout=5)
        private(f.op/'owner-started.json',b'partial-original-intent')
        with self.assertRaises(EOFError):f.start()
        self.assertEqual((f.op/'owner-started.json').read_bytes(),b'partial-original-intent')
    def test_lost_reply_reconnect_reads_without_changing_receipt_or_start(self):
        f=self.fixture(2)
        receipt=(f.op/'receipt/account-receipt.json').read_bytes()
        intent=(f.op/'owner-started.json').read_bytes()
        s,parts=f.connect();send(s,{'mac':tag(f.secret,'host',parts)});s.close()
        self.assertEqual(f.call()[1],receipt)
        self.assertEqual((f.op/'owner-started.json').read_bytes(),intent)
    def test_partial_frame_does_not_panic_or_expose_next_request(self):
        f=self.fixture(2)
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(str(f.op/'owner.sock'));s.sendall(struct.pack('!I',999999))
        f.call()

class GuestTests(unittest.TestCase):
    def guest(self):
        f=Fixture();self.addCleanup(f.finish)
        b=f.binding;b['version']=2
        node=lambda role:{k:b['paths'][role][k] for k in ['device','inode']}
        plan={'version':2,'macosMajor':26,'accountName':'personal','accountHome':'/Users/personal',
          'helperSha256':'b'*64,'runtimeSha256':b['runtimeSha256'],'accountIntentDigest':'c'*64,
          'binding':{k:b[k] for k in ['bootstrapId','ownerEpoch','nonce','parentSession','parentTab','parentConversation']}}
        plan['binding']['target']={k:b[k] for k in ['environmentId','generation','vmFingerprint','restoreSha256','macosMajor']}
        plan['binding']['input']={'id':b['inputShareId'],'host':node('input'),'readOnly':True}
        plan['binding']['output']={'id':b['outputShareId'],'host':node('output'),'readOnly':False}
        data=wire(plan);b['helperManifestSha256']=digest(data)
        private(f.op/'expected-helper.json',data);private(f.op/'input/host-plan.json',data)
        private(f.op/'owner-intent.json',wire(b));f.bd=digest(wire(b))
        a,c=socket.socketpair();g,h=socket.socketpair();g.settimeout(5)
        f.process=subprocess.Popen([str(BINARY),str(c.fileno()),'guest-observe',str(h.fileno())],pass_fds=[c.fileno(),h.fileno()],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        c.close();h.close();send(a,{'binding':b64(wire(b)),'capability':b64(f.secret)});self.addCleanup(a.close)
        self.addCleanup(g.close)
        send(g,{'version':1,'clientNonce':'d'*64})
        try:offer=read(g)
        except EOFError:
            _,err=f.process.communicate(timeout=5);raise RuntimeError(err.decode())
        challenge=base64.b64decode(offer['challenge']);parsed=json.loads(challenge)
        self.assertEqual(parsed['bindingDigest'],f.bd);self.assertEqual(parsed['clientNonce'],'d'*64)
        self.assertEqual(parsed['ownerEpoch'],b['ownerEpoch']);self.assertEqual(base64.b64decode(offer['hostPlan']),data)
        self.assertNotIn(b64(f.secret),json.dumps(offer));self.assertNotIn(f.secret.hex(),json.dumps(offer))
        claims={'accountName':'personal','accountHome':'/Users/personal','uid':501,'osVersion':'26.0','osBuild':'25A001',
          'helperSha256':'b'*64,'input':{'device':51,'inode':81},'output':{'device':51,'inode':82}}
        return f,g,challenge,claims
    def test_guest_observation_stays_untrusted_and_original_attempt_is_exclusive(self):
        f,g,challenge,claims=self.guest()
        private(f.op/'receipt/guest-mount-echo.json',challenge)
        send(g,{'challengeSha256':digest(challenge),'claims':claims});result=read(g)
        self.assertTrue(result['vmRouteObserved']);self.assertTrue(result['shareRoundTripObserved'])
        for k in ['accountAuthenticated','helperAuthenticated','trustAccepted','ready']:self.assertFalse(result[k])
        retained=(f.op/'guest-observation.json').read_bytes()
        send(g,{'version':1,'clientNonce':'e'*64})
        with self.assertRaises((EOFError,ConnectionResetError)):read(g)
        self.assertEqual((f.op/'guest-observation-intent.json').read_bytes(),challenge)
        self.assertEqual((f.op/'guest-observation.json').read_bytes(),retained)
        self.assertFalse((f.op/'input/account-manifest.json').exists())
    def test_guest_changed_partial_or_forged_identity_never_creates_plan(self):
        for fault in ['challenge','epoch','nonce','share','alias','partial','uid','account','home','helper','nodes','field','view']:
            with self.subTest(fault=fault):
                f,g,challenge,claims=self.guest()
                echo=challenge
                if fault in ['epoch','nonce']:
                    changed=json.loads(challenge);changed['ownerEpoch' if fault=='epoch' else 'serverNonce']='f'*64;echo=wire(changed)
                if fault=='share':echo=b'wrong share'
                if fault=='partial':echo=challenge[:10]
                if fault=='alias':
                    private(f.op/'retained-echo',echo);(f.op/'receipt/guest-mount-echo.json').symlink_to(f.op/'retained-echo')
                else:private(f.op/'receipt/guest-mount-echo.json',echo)
                if fault=='uid':claims['uid']=0
                if fault=='account':claims['accountName']='other'
                if fault=='home':claims['accountHome']='/Users/other'
                if fault=='helper':claims['helperSha256']='e'*64
                if fault=='nodes':claims['output']=claims['input']
                if fault=='field':claims['proof']=True
                if fault=='view':f.view['shares'][0]['readOnly']=False;f.store_view()
                send(g,{'challengeSha256':'f'*64 if fault=='challenge' else digest(challenge),'claims':claims})
                with self.assertRaises((EOFError,ConnectionResetError)):read(g)
                self.assertFalse((f.op/'guest-observation.json').exists())
                self.assertEqual((f.op/'guest-observation-intent.json').read_bytes(),challenge)
                self.assertFalse((f.op/'input/account-manifest.json').exists())
                g.close();f.process.communicate(timeout=5)
    def test_lost_guest_reply_retains_owner_observation_without_replay(self):
        f,g,challenge,claims=self.guest()
        private(f.op/'receipt/guest-mount-echo.json',challenge)
        send(g,{'challengeSha256':digest(challenge),'claims':claims})
        # Never read the reply. Observe the disposable journal before closing to
        # distinguish lost result from an attempt interrupted before completion.
        deadline=time.monotonic()+5
        while not (f.op/'guest-observation.json').exists() and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue((f.op/'guest-observation.json').exists());g.close()
        f.process.communicate(timeout=5)
        self.assertEqual((f.op/'guest-observation-intent.json').read_bytes(),challenge)
        result=json.loads((f.op/'guest-observation.json').read_bytes())
        self.assertFalse(result['helperAuthenticated']);self.assertFalse(result['ready'])

class PublicationTests(unittest.TestCase):
    """The real TXPinnedPath.writeNew: exclusive, atomic for readers, fail-closed."""
    def directory(self):
        temp = tempfile.TemporaryDirectory(prefix='txp-', dir='/private/tmp'); self.addCleanup(temp.cleanup)
        path = Path(temp.name).resolve(); path.chmod(0o700)
        return path
    def publish(self, path, count=1, size=16):
        return subprocess.run([str(BINARY), 'publish', str(path), str(count), str(size)], capture_output=True, timeout=60)
    def test_readers_see_absent_or_complete_records_only(self):
        import threading
        size, count, seen, bad = 60000, 9, [], []
        for _ in range(4):
            path = self.directory(); done = threading.Event()
            def reader():
                while not done.is_set():
                    for i in range(count):
                        try: fd = os.open(path/f'enrollment-attempt-{i}.json', os.O_RDONLY | os.O_NOFOLLOW)
                        except FileNotFoundError: continue
                        with os.fdopen(fd, 'rb') as f:
                            info = os.fstat(f.fileno()); data = f.read()
                        seen.append(i)
                        if len(data) != size or data != bytes([65 + i]) * size or info.st_nlink != 1: bad.append((i, len(data), info.st_nlink))
            thread = threading.Thread(target=reader); thread.start()
            result = self.publish(path, count, size); done.set(); thread.join()
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(sorted(p.name for p in path.iterdir()), sorted(f'enrollment-attempt-{i}.json' for i in range(count)), 'no staged name remains')
        self.assertEqual(bad, [], 'a reader saw a prefix or a second link')
        self.assertTrue(seen, 'the reader observed published records')
    def test_an_existing_target_of_any_kind_is_never_replaced(self):
        outside = self.directory()/'outside'; outside.write_bytes(b'outside')
        for make in [lambda t: t.write_bytes(b'original'), lambda t: t.symlink_to(outside), lambda t: t.mkdir()]:
            path = self.directory(); target = path/'enrollment-attempt-0.json'; make(target)
            before = os.lstat(target)
            result = self.publish(path)
            self.assertNotEqual(result.returncode, 0)
            after = os.lstat(target)
            self.assertEqual((before.st_ino, before.st_mode), (after.st_ino, after.st_mode))
            self.assertEqual([p.name for p in path.iterdir()], ['enrollment-attempt-0.json'], 'no staged name remains')
        self.assertEqual(outside.read_bytes(), b'outside')
    def test_unsafe_or_aliased_directories_refuse_before_writing(self):
        path = self.directory(); path.chmod(0o755)
        self.assertNotEqual(self.publish(path).returncode, 0); self.assertEqual(list(path.iterdir()), [])
        real = self.directory(); alias = self.directory()/'alias'; alias.symlink_to(real)
        self.assertNotEqual(self.publish(alias).returncode, 0); self.assertEqual(list(real.iterdir()), [])

ENROLL = 'terminalx-vm-enrollment-v2'
def etag(key, domain, parts):
    message = b''.join(struct.pack('!I', len(v.encode())) + v.encode() for v in [ENROLL, domain] + parts)
    return hmac.new(key, message, hashlib.sha256).hexdigest()
def send_raw(s, data): s.sendall(struct.pack('!I', len(data)) + data)

@unittest.skipIf(HELPER is None, 'needs the Rust enroll-fixture helper')
class EnrollmentListenerTests(unittest.TestCase):
    """The real version-3 TXEnrollmentService after a genuine launch hand-off."""
    def binding(self, f, key=True):
        b = f.binding; b['version'] = 3; b['seedId'] = os.urandom(16).hex(); b['seedReceiptSha256'] = digest(b'seed receipt')
        self.key = os.urandom(32)
        if key: private(f.op/'enrollment.key', self.key.hex().encode())
        private(f.op/'owner-intent.json', wire(b)); f.bd = digest(wire(b))
        return b
    def launch(self, f, b, count):
        a, c = socket.socketpair(); pairs = [socket.socketpair() for _ in range(count)]
        ends = [p[1] for p in pairs]
        f.process = subprocess.Popen([str(BINARY), str(c.fileno()), 'guest-enroll', *[str(e.fileno()) for e in ends]],
            pass_fds=[c.fileno(), *[e.fileno() for e in ends]], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        c.close()
        for e in ends: e.close()
        send(a, {'binding': b64(wire(b)), 'capability': b64(f.secret)}); self.addCleanup(a.close)
        return [p[0] for p in pairs]
    def rust(self, f, b, s, key=None):
        seed = f.root/f'seed-{uid()}.json'
        private(seed, wire({'bootstrapId': b['bootstrapId'], 'key': b64(key or self.key), 'seedId': b['seedId'], 'version': 1}))
        result = subprocess.run([str(HELPER), str(s.fileno()), str(seed), 'enroll-only'], pass_fds=[s.fileno()], capture_output=True, timeout=30)
        s.close(); self.outputs += [result.stdout, result.stderr]
        return json.loads(result.stdout)
    def done(self, f):
        out, err = f.process.communicate(timeout=60); self.outputs += [out, err]
        self.assertEqual(f.process.returncode, 0, err.decode())
        return json.loads(out)
    def secret_free(self, f):
        forms = [self.key.hex().encode(), b64(self.key).encode(), f.secret.hex().encode(), b64(f.secret).encode()]
        files = [p.read_bytes() for p in f.op.rglob('*') if p.is_file() and p.name != 'enrollment.key']
        return not any(x in t for x in forms for t in self.outputs + files)
    def setUp(self): self.outputs = []
    def test_listener_enrolls_the_real_rust_helper_and_records_only_helper_authentication(self):
        f = Fixture(); self.addCleanup(f.finish); b = self.binding(f)
        (s,) = self.launch(f, b, 1)
        rust = self.rust(f, b, s)
        state = self.done(f)
        self.assertTrue(rust['authenticated'])
        self.assertEqual(state, {'claimed': True, 'refusals': 0, 'fenced': False, 'sessionRetained': True})
        receipt = json.loads((f.op/'enrollment.json').read_bytes())
        self.assertEqual(receipt['challengeSha256'], rust['challengeSha256'])
        self.assertEqual(receipt['challengeSha256'], digest((f.op/'enrollment-attempt-0.json').read_bytes()))
        self.assertEqual({k: receipt[k] for k in ['bindingDigest', 'bootstrapId', 'seedId', 'seedReceiptSha256', 'ownerEpoch']},
            {'bindingDigest': f.bd, 'bootstrapId': b['bootstrapId'], 'seedId': b['seedId'], 'seedReceiptSha256': b['seedReceiptSha256'], 'ownerEpoch': b['ownerEpoch']})
        self.assertTrue(receipt['helperAuthenticated'])
        for k in ['accountAuthenticated', 'trustAccepted', 'ready']: self.assertFalse(receipt[k])
        self.assertTrue(self.secret_free(f))
    def test_failed_attempts_are_bounded_journaled_and_never_claim(self):
        f = Fixture(); self.addCleanup(f.finish); b = self.binding(f)
        sockets = self.launch(f, b, 3)
        self.assertFalse(self.rust(f, b, sockets[0], key=os.urandom(32))['authenticated'])
        send(sockets[1], {'bootstrapId': b['bootstrapId'], 'clientNonce': 'a'*64, 'seedId': os.urandom(16).hex(), 'version': 2})
        with self.assertRaises((EOFError, ConnectionResetError)): read(sockets[1])
        sockets[1].close()
        self.assertTrue(self.rust(f, b, sockets[2])['authenticated'])
        self.assertEqual(self.done(f), {'claimed': True, 'refusals': 2, 'fenced': False, 'sessionRetained': True})
        self.assertTrue((f.op/'enrollment-attempt-0.json').exists())
        self.assertFalse((f.op/'enrollment-attempt-1.json').exists(), 'a refused hello gets no challenge')
        self.assertEqual(json.loads((f.op/'enrollment.json').read_bytes())['attempt'], 2)
    def test_spent_budget_fences_and_a_claim_admits_nothing_more(self):
        f = Fixture(); self.addCleanup(f.finish); b = self.binding(f)
        sockets = self.launch(f, b, 9)
        for s in sockets[:8]: s.close()
        self.assertFalse(self.rust(f, b, sockets[8])['authenticated'])
        self.assertEqual(self.done(f), {'claimed': False, 'refusals': 8, 'fenced': True, 'sessionRetained': False})
        self.assertFalse((f.op/'enrollment.json').exists())
        g = Fixture(); self.addCleanup(g.finish); b = self.binding(g)
        sockets = self.launch(g, b, 2)
        self.assertTrue(self.rust(g, b, sockets[0])['authenticated'])
        self.assertFalse(self.rust(g, b, sockets[1])['authenticated'])
        self.assertEqual(self.done(g)['claimed'], True)
    def test_a_lost_acceptance_reply_still_claims_once(self):
        f = Fixture(); self.addCleanup(f.finish); b = self.binding(f)
        sockets = self.launch(f, b, 2)
        s = sockets[0]; hello = {'bootstrapId': b['bootstrapId'], 'clientNonce': os.urandom(32).hex(), 'seedId': b['seedId'], 'version': 2}
        send(s, hello)
        n = struct.unpack('!I', s.recv(4, socket.MSG_WAITALL))[0]; challenge = s.recv(n, socket.MSG_WAITALL)
        claims = {'euid': 0}; sha = digest(challenge)
        send(s, {'challengeSha256': sha, 'claims': claims, 'proof': etag(self.key, 'enrollment', [sha, digest(wire(claims))])})
        s.close()  # never reads the acceptance
        self.assertFalse(self.rust(f, b, sockets[1])['authenticated'])
        state = self.done(f)
        self.assertTrue(state['claimed'])
        self.assertEqual(json.loads((f.op/'enrollment.json').read_bytes())['attempt'], 0)
    def test_version_3_needs_its_private_key_and_exact_seed_binding(self):
        f = Fixture(); self.addCleanup(f.finish); b = self.binding(f, key=False)
        (s,) = self.launch(f, b, 1); s.close()
        f.process.communicate(timeout=30); self.assertNotEqual(f.process.returncode, 0, 'no key, no listener')
        for change in [{'seedReceiptSha256': None}, {'seedId': 'short'}, {'version': 2}]:
            g = Fixture(); self.addCleanup(g.finish); b = self.binding(g)
            for k, v in change.items():
                if v is None: del b[k]
                else: b[k] = v
            private(g.op/'owner-intent.json', wire(b))
            (s,) = self.launch(g, b, 1); s.close()
            g.process.communicate(timeout=30); self.assertNotEqual(g.process.returncode, 0, change)
    def test_owner_channel_serves_only_the_enrollment_receipt_for_version_3(self):
        f = Fixture(); self.addCleanup(f.finish); b = self.binding(f)
        receipt = wire({'helperAuthenticated': True, 'accountAuthenticated': False, 'trustAccepted': False, 'ready': False})
        private(f.op/'enrollment.json', receipt)
        f.start(n=3, binding=b)
        payload, served = f.call('enrollment')
        self.assertEqual((served, payload['action']), (receipt, 'enrollment'))
        for action in ['guestObservation', 'accountReceipt']:
            with self.assertRaises((EOFError, ConnectionResetError, AssertionError, socket.timeout)): f.call(action)
    def test_owner_mediated_stop_is_version_3_only_and_answered_before_stopping(self):
        f = Fixture(); self.addCleanup(f.finish); b = self.binding(f)
        f.start(n=3, binding=b)
        payload, record = f.call('stop')
        self.assertEqual(json.loads(record), {'bindingDigest': f.bd, 'exitConfirmed': False, 'ownerEpoch': b['ownerEpoch'],
                                              'ready': False, 'stopRequested': True, 'version': 1})
        f.process.communicate(timeout=15)
        self.assertEqual(f.process.returncode, 0, 'the fixture owner stopped as the VM would')
        self.assertEqual((f.op/'stop-requested.json').read_bytes(), record)
        g = Fixture(); self.addCleanup(g.finish); g.start(n=2)
        with self.assertRaises((EOFError, ConnectionResetError, AssertionError, socket.timeout)): g.call('stop')
        self.assertFalse((g.op/'stop-requested.json').exists())
    def owner_with_guest(self, f, b, wait=8):
        raw = wire(b); private(f.op/'owner-intent.json', raw); f.bd = digest(raw)
        a, c = socket.socketpair(); a.settimeout(5); g, h = socket.socketpair()
        f.process = subprocess.Popen([str(BINARY), str(c.fileno()), '16', 'guest', str(h.fileno()), str(wait)],
            pass_fds=[c.fileno(), h.fileno()], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        c.close(); h.close()
        send(a, {'binding': b64(raw), 'capability': b64(f.secret)}); read(a); a.close()
        return g
    def host(self, f, action, payload=None):
        s = socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(str(f.op/'owner.sock'))
        with s:
            request = {'action': action, 'bindingDigest': f.bd, 'clientNonce': os.urandom(32).hex(), 'requestId': uid()}
            if payload is not None: request['payload'] = b64(payload)
            send(s, request); challenge = read(s)
            parts = [f.bd, f.binding['ownerEpoch'], action, request['requestId'], request['clientNonce'], challenge['serverNonce']]
            parts += [digest(payload)] if payload is not None else []
            assert challenge['mac'] == tag(f.secret, 'owner', parts)
            send(s, {'mac': tag(f.secret, 'host', parts)}); result = read(s)
        raw = base64.b64decode(result['payload']); assert result['mac'] == tag(f.secret, 'receipt', parts + [digest(raw)])
        return base64.b64decode(json.loads(raw)['receipt'])
    def poll(self, f, action):
        deadline = time.monotonic() + 6
        while True:
            try: return self.host(f, action)
            except (EOFError, ConnectionResetError, AssertionError, socket.timeout):
                if time.monotonic() > deadline: raise
                time.sleep(0.2)
    def test_only_the_persons_relayed_confirmation_authenticates_one_reported_account(self):
        f = Fixture(); self.addCleanup(f.finish); b = self.binding(f)
        g = self.owner_with_guest(f, b)
        seed = f.root/'seed.json'
        private(seed, wire({'bootstrapId': b['bootstrapId'], 'key': b64(self.key), 'seedId': b['seedId'], 'version': 1}))
        helper = subprocess.Popen([str(HELPER), str(g.fileno()), str(seed), 'confirm'], pass_fds=[g.fileno()],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        g.close()
        observed_bytes = self.poll(f, 'accountObservation')
        observed = json.loads(observed_bytes)
        self.assertEqual((observed['helperAuthenticated'], observed['accountAuthenticated'], observed['trustAccepted'], observed['ready']),
                         (True, False, False, False))
        mine = next(a for a in observed['accounts'] if a['uid'] == os.getuid())
        def confirmation(**change):
            value = {'version': 1, 'bindingDigest': f.bd, 'ownerEpoch': b['ownerEpoch'], 'observationSha256': digest(observed_bytes),
                     'account': mine, 'parentSession': uid(), 'parentTab': uid(), 'parentConversation': 'original', 'confirmationId': uid()}
            value.update(change); return wire(value)
        refused = [confirmation(account={**mine, 'homeInode': mine['homeInode'] + 1}),
                   confirmation(account={**mine, 'uid': 0}),
                   confirmation(observationSha256='0' * 64),
                   confirmation(bindingDigest='e' * 64),
                   confirmation(parentSession='not-a-uuid')]
        for bad in refused:
            with self.assertRaises((EOFError, ConnectionResetError, AssertionError, socket.timeout)): self.host(f, 'confirmAccount', bad)
        self.assertFalse((f.op/'account-confirmation-relay.json').exists(), 'no refused confirmation is journaled')
        chosen = confirmation()
        relay = self.host(f, 'confirmAccount', chosen)
        record = json.loads(relay)
        self.assertEqual((record['relayed'], record['accountAuthenticated'], record['confirmationSha256'], record['account']),
                         (True, False, digest(chosen), mine))
        self.assertEqual(self.host(f, 'confirmAccount', chosen), relay, 'a lost-reply retry gets the same record')
        with self.assertRaises((EOFError, ConnectionResetError, AssertionError, socket.timeout)):
            self.host(f, 'confirmAccount', confirmation())
        out, err = helper.communicate(timeout=30)
        result = json.loads(out)
        self.assertEqual((result['confirmed'], result['confirmationSha256']), (mine['name'], digest(chosen)), err.decode())
        answer = json.loads(self.poll(f, 'accountAnswer'))
        self.assertEqual((answer['outcome'], answer['accountAuthenticated'], answer['trustAccepted'], answer['ready']),
                         ('confirmed', True, False, False))
        self.assertEqual(json.loads((f.op/'account-confirmation-relay.json').read_bytes())['confirmationSha256'], digest(chosen))
        texts = [p.read_bytes() for p in f.op.rglob('*') if p.is_file() and p.name != 'enrollment.key'] + [out, err]
        self.assertFalse(any(self.key.hex().encode() in t or b64(self.key).encode() in t for t in texts))
    def test_version_2_owner_serves_no_account_relay(self):
        f = Fixture(); self.addCleanup(f.finish); b = f.binding; b['version'] = 2
        f.start(n=3, binding=b)
        for action, payload in [('accountObservation', None), ('confirmAccount', b'{}'), ('accountAnswer', None)]:
            with self.assertRaises((EOFError, ConnectionResetError, AssertionError, socket.timeout)): self.host(f, action, payload)
    def test_version_2_owner_never_serves_an_enrollment_receipt(self):
        f = Fixture(); self.addCleanup(f.finish); b = f.binding; b['version'] = 2
        private(f.op/'enrollment.json', wire({'helperAuthenticated': True}))
        f.start(n=2, binding=b)
        with self.assertRaises((EOFError, ConnectionResetError, AssertionError, socket.timeout)): f.call('enrollment')

if __name__=='__main__':unittest.main()
