#!/usr/bin/env python3
"""Disposable ACP lifecycle peer using the repository's captured ACP wire shapes.
No provider/account/model is contacted. This is fixture evidence only.
"""
import json, sys, threading, time, uuid
if '--version' in sys.argv:
    print('issue467 ACP fixture 1')
    raise SystemExit
sid = 'fixture-' + str(uuid.uuid4())
lock = threading.Lock()
pending = {}
cancel = threading.Event()
number = 0

def emit(value):
    with lock:
        print(json.dumps(value), flush=True)

def reply(i, value):
    emit({'jsonrpc': '2.0', 'id': i, 'result': value})

def text(value):
    emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': sid, 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': value}}}})

def turn(request, n, stopped):
    prompt = ''.join((p.get('text', '') for p in request.get('params', {}).get('prompt', [])))
    status = 'end_turn'
    if prompt.startswith('ask:'):
        i = 9000 + n
        ready = threading.Event()
        box = {}
        pending[i] = (ready, box)
        emit({'jsonrpc': '2.0', 'id': i, 'method': 'session/request_permission', 'params': {'sessionId': sid, 'toolCall': {'toolCallId': 'fixture-tool-' + str(n), 'title': prompt[4:], 'kind': 'execute', 'rawInput': {'command': prompt[4:]}}, 'options': [{'optionId': 'allow', 'name': 'Allow', 'kind': 'allow_once'}, {'optionId': 'reject', 'name': 'Reject', 'kind': 'reject_once'}]}})
        end = time.monotonic() + 120
        while not ready.wait(0.1) and (not stopped.is_set()) and (time.monotonic() < end):
            pass
        result = box.get('result', {}).get('outcome', {})
        allowed = result.get('outcome') == 'selected' and result.get('optionId') == 'allow'
        text(('allowed: ' if allowed else 'denied: ') + prompt[4:] + '\n')
        pending.pop(i, None)
    elif prompt.startswith('slow:'):
        parts = prompt.split(':')
        total = int(parts[1])
        delay = int(parts[2]) if len(parts) > 2 else 400
        for k in range(1, total + 1):
            if stopped.wait(delay / 1000):
                status = 'cancelled'
                break
            text('chunk %d of %d\n' % (k, total))
    else:
        text('fixture: ' + prompt + '\n')
    reply(request['id'], {'stopReason': status})
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    i = request.get('id')
    if method == 'initialize':
        reply(i, {'protocolVersion': 1, 'agentCapabilities': {}})
    elif method in ['session/new', 'session/load']:
        reply(i, {'sessionId': sid})
    elif method in ['session/set_mode', 'session/set_model']:
        reply(i, {})
    elif method == 'session/prompt':
        number += 1
        cancel = threading.Event()
        threading.Thread(target=turn, args=(request, number, cancel), daemon=True).start()
    elif method == 'session/cancel':
        cancel.set()
    elif method is None and i in pending:
        (ready, box) = pending[i]
        box.update(request)
        ready.set()
    elif i is not None:
        emit({'jsonrpc': '2.0', 'id': i, 'error': {'code': -32601, 'message': 'Unsupported fixture method'}})
