#!/usr/bin/env python3
"""Compare reference Whisper and transcribe-cpp with identical pinned BIN weights.

Usage: run-reference-comparison.py EVALUATION_DIR QUIET_MANIFEST NEW_OUTPUT_DIR REFERENCE_DIR TRANSCRIBE_PROBE
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
    evaluation, quiet, output, reference_dir, transcribe = map(Path, sys.argv[1:])
    rows = json.loads((evaluation / 'corpus.json').read_text())
    rows += json.loads(quiet.read_text())
    ids = ['silence', 'white-noise', 'tone', 'daniel-learning',
           'daniel-learning-gain-0.001']
    inputs = [next(r for r in rows if r['id'] == item) for item in ids]
    models = json.loads((reference_dir / 'models.json').read_text())
    for m in models:
        m.setdefault('id', m['filename'].removeprefix('ggml-').removesuffix('-q8_0.bin'))
        m['path'] = str(reference_dir / m['filename'])
    if not models or len({m['id'] for m in models}) != len(models):
        raise SystemExit('Expected a nonempty model manifest with unique IDs')
    for item in inputs + models:
        path = Path(item.get('audioPath', item.get('path')))
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != item['sha256']:
            raise SystemExit('Checksum mismatch: ' + item['id'])
    if not (reference_dir / 'reference-trace').is_file():
        raise SystemExit('Build the reference probe first')
    output.mkdir(mode=0o700, exist_ok=False)
    (output / 'manifest.json').write_text(json.dumps(
        {'models': models, 'inputs': inputs}, indent=2))
    prompt = 'TranscriptionTab.tsx, dictationText.ts, refreshDictationEngine, Zephyr, fix/offline-dictation'
    failed = False
    for model in models:
        for backend in ['reference', 'transcribe']:
            probe = reference_dir / 'reference-trace' if backend == 'reference' else transcribe
            for mode, hint in [('off', ''), ('on', prompt)]:
                name = model['id'] + '-' + backend + '-' + mode
                start = time.monotonic()
                with (output / (name + '.out')).open('w') as stdout, \
                     (output / (name + '.err')).open('w') as stderr:
                    result = subprocess.run(
                        [str(probe.resolve()), model['path'], hint,
                         *[item['audioPath'] for item in inputs]],
                        env={**os.environ, 'TX439_TRACE_BACKEND': 'cpu'},
                        stdout=stdout, stderr=stderr, check=False)
                print(name, result.returncode, round(time.monotonic() - start, 3), flush=True)
                failed |= result.returncode != 0
    return int(failed)


if __name__ == '__main__':
    if len(sys.argv) != 6:
        raise SystemExit(__doc__)
    raise SystemExit(main())
