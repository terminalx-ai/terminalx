#!/usr/bin/env python3
"""Compare strict CPU and Metal using explicit, checksum-verified public fixtures.

Usage: run-backend-comparison.py EVALUATION_DIR QUIET_MANIFEST NEW_OUTPUT_DIR PROBE
Requires the corpus and quiet controls described in GUEST-RESULTS.md.
No download, audio capture, runtime tuning or application dependency changes.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    evaluation, quiet, output, probe = map(Path, sys.argv[1:])
    rows = json.loads((evaluation / 'corpus.json').read_text())
    rows += json.loads(quiet.read_text())
    ids = ['silence', 'white-noise', 'tone', 'daniel-learning',
           'daniel-learning-gain-0.001']
    inputs = [next(r for r in rows if r['id'] == item) for item in ids]
    models = [m for m in json.loads((evaluation / 'models.json').read_text())
              if m['id'].startswith('whisper-')]
    if len(models) != 2:
        raise SystemExit('Expected both catalog Whisper models')
    for item in inputs + models:
        path = Path(item.get('audioPath', item.get('path')))
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != item['sha256']:
            raise SystemExit('Checksum mismatch: ' + item['id'])
    output.mkdir(mode=0o700, exist_ok=False)
    (output / 'manifest.json').write_text(json.dumps(
        {'models': models, 'inputs': inputs}, indent=2))
    prompt = 'TranscriptionTab.tsx, dictationText.ts, refreshDictationEngine, Zephyr, fix/offline-dictation'
    failed = False
    for model in models:
        for backend in ['cpu', 'metal']:
            for mode, hint in [('off', ''), ('on', prompt)]:
                name = model['id'] + '-' + backend + '-' + mode
                start = time.monotonic()
                with (output / (name + '.out')).open('w') as stdout, \
                     (output / (name + '.err')).open('w') as stderr:
                    result = subprocess.run(
                        [str(probe.resolve()), model['path'], hint,
                         *[item['audioPath'] for item in inputs]],
                        env={**os.environ, 'TX439_TRACE_BACKEND': backend},
                        stdout=stdout, stderr=stderr, check=False)
                print(name, result.returncode, round(time.monotonic() - start, 3), flush=True)
                failed |= result.returncode != 0
    return int(failed)


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    raise SystemExit(main())
