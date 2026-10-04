#!/usr/bin/env python3
"""Read-only legacy Electron AppImage preflight; not for terminalx-serve."""

import argparse
import datetime
import hashlib
import json
import platform
import re
import socket
import time
import uuid
from pathlib import Path


LIMIT = 1024 * 1024


def read_json(path):
    with Path(path).open('rb') as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('oversized JSON')
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('expected object')
    return value


def artifact_matches(path, expected):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(LIMIT), b''):
            digest.update(chunk)
    return digest.hexdigest() == expected


def runtime_status(metadata, timeout=10):
    transports = metadata.get('transports', [metadata.get('transport')])
    if not isinstance(transports, list):
        raise ValueError('invalid transports')
    endpoint = next((t.get('endpoint') for t in transports
                     if isinstance(t, dict) and t.get('kind') == 'unix'), None)
    token = metadata.get('authToken')
    identity = metadata.get('runtimeId')
    if not all(isinstance(v, str) and v for v in (endpoint, token, identity)):
        raise ValueError('incomplete runtime metadata')
    request_id = str(uuid.uuid4())
    request = {'id': request_id, 'authToken': token, 'method': 'status.get'}
    deadline = time.monotonic() + timeout
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(endpoint)
        connection.sendall((json.dumps(request) + '\n').encode())
        pending = b''
        received = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('runtime deadline')
            connection.settimeout(remaining)
            chunk = connection.recv(65536)
            if not chunk:
                raise ValueError('runtime closed before reply')
            received += len(chunk)
            if received > LIMIT:
                raise ValueError('oversized runtime response')
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                if not line.strip():
                    continue
                frame = json.loads(line)
                if frame == {'_keepalive': True}:
                    continue
                if not isinstance(frame, dict) or frame.get('id') != request_id:
                    raise ValueError('mismatched response')
                if frame.get('ok') is not True:
                    raise ValueError('RPC rejected')
                envelope = frame.get('_meta', {})
                if not isinstance(envelope, dict):
                    raise ValueError('invalid response metadata')
                envelope_identity = envelope.get('runtimeId', identity)
                result = frame.get('result')
                if (not isinstance(result, dict) or result.get('runtimeId') != identity
                        or envelope_identity != identity):
                    raise ValueError('runtime identity changed')
                return project_status(result)


def project_status(result):
    # Do not dump status/metadata: either can include account and token material.
    version = result.get('appVersion')
    capabilities = result.get('capabilities')
    protocol = result.get('runtimeProtocolVersion', result.get('protocolVersion'))
    if not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9.+_-]{1,100}', version):
        raise ValueError('missing runtime version')
    if (not isinstance(capabilities, list) or len(capabilities) > 512
            or any(not isinstance(c, str) or not re.fullmatch(r'[a-zA-Z0-9._-]{1,160}', c)
                   for c in capabilities)):
        raise ValueError('invalid capability report')
    if type(protocol) is not int or protocol < 0:
        raise ValueError('missing protocol version')
    return {'appVersion': version, 'runtimeProtocolVersion': protocol,
            'advertisedCapabilities': sorted(set(capabilities)),
            'runtimeIdentitySha256': hashlib.sha256(result['runtimeId'].encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha256', required=True, help='Approved build SHA, not the installed marker')
    parser.add_argument('--artifact', type=Path, default=Path('/opt/terminalx/TerminalX.AppImage'))
    parser.add_argument('--metadata', type=Path, required=True, help='Installed terminalx-runtime.json')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{64}', args.sha256):
        parser.error('--sha256 must be 64 lowercase hexadecimal characters')
    report = {'schema': 1, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'hostPlatform': platform.system(), 'expectedArtifactSha256': args.sha256,
              'artifact': 'not-run', 'rpc': 'not-run', 'agentReadiness': 'not-tested',
              'extractedTreeIntegrity': 'not-tested', 'remoteClientCompatibility': 'not-tested'}
    if platform.system() != 'Linux':
        report['result'] = 'blocked-non-linux-host'
    else:
        try:
            report['artifact'] = 'fail'
            report['artifact'] = 'pass' if artifact_matches(args.artifact, args.sha256) else 'fail'
            if report['artifact'] == 'pass':
                report['rpc'] = 'fail'
                report['runtime'] = runtime_status(read_json(args.metadata))
                report['rpc'] = 'pass'
            report['result'] = 'preflight-pass' if report['rpc'] == 'pass' else 'fail'
        except (OSError, ValueError, TypeError, AttributeError, StopIteration):
            # Never print exception text: it may contain a credential or raw response.
            report['result'] = 'fail'
    print(json.dumps(report, indent=2))
    return 0 if report['result'] == 'preflight-pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
