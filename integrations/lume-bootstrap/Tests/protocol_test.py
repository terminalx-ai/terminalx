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

if __name__=='__main__':unittest.main()
