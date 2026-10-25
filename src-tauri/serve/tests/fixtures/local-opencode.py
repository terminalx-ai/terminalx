#!/usr/bin/env python3
"""Disposable HTTP/SSE lifecycle peer; wire shapes come from OpenCode fixtures.
Never contacts a provider, executes a requested command, or uses credentials.
"""
import http.server, json, queue, sys, threading, time, uuid
if '--version' in sys.argv:
    print('issue467 OpenCode fixture 1')
    raise SystemExit
port = int(sys.argv[sys.argv.index('--port') + 1])
sid = 'fixture-' + str(uuid.uuid4())
events = queue.Queue()
pending = {}
cancel = threading.Event()
number = 0

def emit(kind, properties):
    events.put({'type': kind, 'properties': properties})

def status(kind):
    emit('session.status', {'sessionID': sid, 'status': {'type': kind}})

class Handler(http.server.BaseHTTPRequestHandler):

    def log_message(self, *args):
        pass

    def result(self, value, code=200):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/event'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            try:
                while True:
                    try:
                        data = ('data: ' + json.dumps(events.get(timeout=5)) + '\n\n').encode()
                    except queue.Empty:
                        data = b': fixture heartbeat\n\n'
                    self.wfile.write(data)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif self.path.startswith('/session/'):
            self.result({'id': sid})
        else:
            self.result({'fixture': True})

    def do_POST(self):
        global number, cancel
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
        if self.path == '/session':
            self.result({'id': sid})
            return
        if '/permissions/' in self.path:
            key = self.path.rsplit('/', 1)[-1]
            if key not in pending:
                self.result({'message': 'expired fixture request'}, 404)
                return
            (ready, box) = pending[key]
            box.update(body)
            ready.set()
            self.result(True)
            return
        if self.path.endswith('/abort'):
            cancel.set()
            self.result(True)
            return
        if not self.path.endswith('/message'):
            self.result({'message': 'unsupported fixture route'}, 404)
            return
        number += 1
        n = number
        cancel = threading.Event()
        stopped = cancel
        mid = 'message-' + str(n)
        pid = 'part-' + str(n)
        prompt = ''.join((p.get('text', '') for p in body.get('parts', [])))
        status('busy')
        emit('message.updated', {'sessionID': sid, 'info': {'id': mid, 'role': 'assistant', 'sessionID': sid, 'modelID': 'fixture', 'providerID': 'fixture', 'time': {'created': int(time.time() * 1000)}}})
        text = ''

        def part(done=False):
            value = {'id': pid, 'messageID': mid, 'sessionID': sid, 'type': 'text', 'text': text}
            if done:
                value['time'] = {'start': 1, 'end': 2}
            emit('message.part.updated', {'sessionID': sid, 'part': value})
        if prompt.startswith('ask:'):
            key = 'permission-' + str(n)
            ready = threading.Event()
            box = {}
            pending[key] = (ready, box)
            emit('permission.updated', {'id': key, 'sessionID': sid, 'type': 'bash', 'title': 'Fixture: ' + prompt[4:], 'callID': 'tool-' + str(n), 'metadata': {'command': prompt[4:]}})
            end = time.monotonic() + 120
            while not ready.wait(0.1) and (not stopped.is_set()) and (time.monotonic() < end):
                pass
            text = ('allowed: ' if box.get('response') in ['once', 'always'] else 'denied: ') + prompt[4:] + '\n'
            pending.pop(key, None)
        elif prompt.startswith('slow:'):
            parts = prompt.split(':')
            total = int(parts[1])
            delay = int(parts[2]) if len(parts) > 2 else 400
            for k in range(1, total + 1):
                if stopped.wait(delay / 1000):
                    break
                text += 'chunk %d of %d\n' % (k, total)
                part()
        else:
            text = 'fixture: ' + prompt + '\n'
        part(True)
        status('idle')
        emit('session.idle', {'sessionID': sid})
        self.result({})
http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
