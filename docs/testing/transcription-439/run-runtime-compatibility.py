#!/usr/bin/env python3
"""Run every catalog model on the full saved base corpus with personalization OFF.
Usage: run-runtime-compatibility.py EVALUATION_DIR OLD_PROBE NEW_PROBE NEW_OUTPUT_DIR [--candidate-only]
Both probes use the checked-in whisper-trace.cpp public API and strict CPU.
No files are screened by outcome; a failed/timed-out run is retained and fails.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

if len(sys.argv) not in [5,6] or (len(sys.argv) == 6 and sys.argv[5] != '--candidate-only'):
    raise SystemExit(__doc__)
evaluation, old, new, output = map(Path, sys.argv[1:5])
models = json.loads((evaluation/'models.json').read_text())
inputs = json.loads((evaluation/'corpus.json').read_text())
if len(models) != 5 or not inputs:
    raise ValueError('Expected all five catalog models and the complete base corpus')

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024),b''):
            h.update(chunk)
    return h.hexdigest()
for row in models + inputs:
    if sha(row.get('audioPath',row.get('path'))) != row['sha256']:
        raise ValueError('Checksum mismatch: '+row['id'])
output.mkdir(mode=0o700,exist_ok=False)
(output/'manifest.json').write_text(json.dumps({'models':models,'inputs':inputs,
    'oldProbe':str(old),'oldProbeSha256':sha(old),'newProbe':str(new),'newProbeSha256':sha(new),
    'backend':'cpu','prompt':'','source':'whisper-trace.cpp'},indent=2)+'\n')
failed=False
results=[]
for model in models:
    for label,probe in ([('0.4.1',new)] if len(sys.argv) == 6 else [('0.2.3',old),('0.4.1',new)]):
        stem=model['id']+'-'+label
        started=time.monotonic()
        with (output/(stem+'.out')).open('w') as stdout, (output/(stem+'.err')).open('w') as stderr:
            try:
                process=subprocess.run([str(probe.resolve()),model['path'],'',*[r['audioPath'] for r in inputs]],
                    stdout=stdout,stderr=stderr,env={**os.environ,'TX439_TRACE_BACKEND':'cpu'},timeout=1200)
                status=process.returncode
            except subprocess.TimeoutExpired:
                status='timeout'
        failed |= status != 0
        row={'model':model['id'],'version':label,'status':status,'elapsedSeconds':time.monotonic()-started}
        results.append(row)
        (output/'runs.json').write_text(json.dumps(results,indent=2)+'\n')
        print(json.dumps(row),flush=True)
raise SystemExit(1 if failed else 0)
