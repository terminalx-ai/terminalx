#!/usr/bin/env python3
"""Private #643 adapter for the source-pinned no-account fake. Never a provider.
Staged as <fixed root>/bin/claude and invoked by the existing local harness.
Every journal write is flushed/fsynced; partial journals fail native validation.
"""
import json
import fcntl
import os
import pathlib
import runpy
import stat
import sys
import threading

ROOT = pathlib.Path('/Users/Shared/tx643-private-recovery-3d73b0a4')
if os.environ.get('HOME') != str(ROOT / 'home') or os.environ.get('TERMINALX_HOME') != str(ROOT / 'state'):
    raise SystemExit('wrong recovery fixture home')
if pathlib.Path.cwd().resolve() != ROOT / 'fixture':
    raise SystemExit('wrong recovery fixture cwd')
# CLI capability queries do not represent a launched fixture session.
if sys.argv[1:] in (['--version'], ['-v']):
    print('0.0.0 (fake-claude)')
    raise SystemExit(0)

def private_file(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise RuntimeError('unowned fixture input')
        value = source.read(limit + 1)
        if len(value) > limit:
            raise RuntimeError('fixture input too large')
        return value

challenge = private_file(ROOT / 'challenge', 64).decode('ascii')
if len(challenge) != 36:
    raise SystemExit('invalid fixture challenge')
fd = os.open(ROOT / ('launch-%d.jsonl' % os.getpid()), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
journal = os.fdopen(fd, 'w', buffering=1)
serial = 0
record_lock = threading.Lock()
screen_lock = threading.Lock()

def record(kind, **fields):
    global serial
    with record_lock:
        fcntl.flock(journal.fileno(), fcntl.LOCK_EX)
        try:
            serial += 1
            journal.write(json.dumps(dict(seq=serial, kind=kind, challenge=challenge, pid=os.getpid(), **fields), separators=(',', ':')) + '\n')
            journal.flush()
            os.fsync(journal.fileno())
        finally:
            fcntl.flock(journal.fileno(), fcntl.LOCK_UN)

# No externally supplied source path or module. Native verifier hashes BOTH
# these files against include_bytes! from this derived source before arming.
namespace = runpy.run_path(str(ROOT / 'fake-claude'))
Fake = namespace['Fake']
submit = Fake.submit
screen = Fake.screen
output_seq = 0

def counted_submit(self, text):
    if text.strip('\n').strip() and not text.startswith('/'):
        record('submit', text=text)
    return submit(self, text)

def counted_screen(self, text):
    global output_seq
    with screen_lock:
        screen(self, text)
        output_seq += 1
        marker = ('\r\nTX643:%s:%d:%d\r\n' % (challenge, os.getpid(), output_seq)).encode()
        while marker:
            written = os.write(1, marker)
            if written <= 0:
                raise RuntimeError('fixture output failed')
            marker = marker[written:]
        record('output', cursor=output_seq)

Fake.submit = counted_submit
Fake.screen = counted_screen
record('start', interpreter=os.path.realpath(sys.executable), adapter=str(ROOT / 'bin/claude'))
try:
    namespace['main']()
finally:
    record('exit')
    journal.close()
