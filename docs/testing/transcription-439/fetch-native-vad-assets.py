#!/usr/bin/env python3
"""Fetch only the preselected pinned public model and ESC-10 diagnostic audio.
Usage: fetch-native-vad-assets.py NEW_PRIVATE_DIRECTORY
Does not run models, access app stores, or use credentials.
"""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

if len(sys.argv) != 2:
    raise SystemExit(__doc__)
root = Path(sys.argv[1])
root.mkdir(mode=0o700, exist_ok=False)
docs = Path(__file__).parent
model = json.loads((docs/'native-vad-model.json').read_text())
noise = json.loads((docs/'native-vad-esc10-sources.json').read_text())
verified = []
for row in [model] + noise:
    name = row['filename']
    if Path(name).name != name or not row['url'].startswith('https://'):
        raise ValueError('Invalid pinned asset path/URL')
    with urllib.request.urlopen(row['url'], timeout=30) as response:
        data = response.read(row['sizeBytes'] + 1)
    sha = hashlib.sha256(data).hexdigest()
    if len(data) != row['sizeBytes']:
        raise ValueError('Size mismatch: ' + name)
    if 'sha256' in row and sha != row['sha256']:
        raise ValueError('SHA-256 mismatch: ' + name)
    if 'gitBlob' in row:
        blob = hashlib.sha1(('blob '+str(len(data))+'\0').encode()+data).hexdigest()
        if blob != row['gitBlob']:
            raise ValueError('Git blob mismatch: ' + name)
    with (root/name).open('xb') as output:
        output.write(data)
    verified.append({**row, 'verifiedSha256':sha, 'path':str((root/name).resolve())})
    # Preserve the verified prefix even if a later transfer fails.
    (root/'verified.json').write_text(json.dumps(verified,indent=2)+'\n')
print('Verified',len(verified),'assets;',sum(r['sizeBytes'] for r in verified),'bytes')
