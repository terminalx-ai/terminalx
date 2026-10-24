#!/usr/bin/env python3
"""Fetch only pinned public diagnostic fixtures, verifying before writing.
Usage: fetch-silero-fixtures.py NEW_PRIVATE_DIRECTORY [--holdout]
No credentials, microphone, private audio or application store access.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

if len(sys.argv) not in [2, 3] or (len(sys.argv) == 3 and sys.argv[2] != '--holdout'):
    raise SystemExit(__doc__)
root = Path(sys.argv[1])
root.mkdir(mode=0o700, exist_ok=False)
manifest_name = 'silero-holdout-sources.json' if len(sys.argv) == 3 else 'silero-sources.json'
manifest = json.loads(Path(__file__).with_name(manifest_name).read_text())


def fetch(row):
    with urllib.request.urlopen(row['url'], timeout=30) as source:
        data = source.read(row['sizeBytes'] + 1)
    if len(data) != row['sizeBytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
        raise ValueError('Checksum or size mismatch: ' + row['local'])
    if hashlib.sha1(('blob ' + str(len(data)) + '\0').encode() + data).hexdigest() != row['gitBlob']:
        raise ValueError('Git blob mismatch: ' + row['local'])
    path = root / row['local']
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as output:
        output.write(data)
    return len(data)


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    sizes = list(pool.map(fetch, manifest))
print('Verified', len(sizes), 'files;', sum(sizes), 'bytes')
