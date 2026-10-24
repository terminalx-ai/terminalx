#!/usr/bin/env python3
"""Prepare explicit real-app OFF/ON matrices; never discovers user audio.
Usage: prepare-production-detector.py PRESERVED_EVIDENCE_ROOT NEW_OUTPUT_DIR
All 19 original inputs on all five models, plus all 32 quiet controls on
both Whisper models. No input/result is dropped or selected after scoring.
"""
import hashlib
import json
from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit(__doc__)
root, output = map(lambda value: Path(value).resolve(), sys.argv[1:])
output.mkdir(mode=0o700, parents=False, exist_ok=False)
models = json.loads((root / 'evaluation/models.json').read_text())
corpus = json.loads((root / 'evaluation/corpus.json').read_text())
stress = json.loads((root / 'trace-stress/manifest.json').read_text())
assert len(models) == 5 and len(corpus) == 19 and len(stress) == 32
by_id = {row['id']: row for row in corpus}
pin = json.loads((Path(__file__).parent / 'native-vad-model.json').read_text())
detector = root / 'native-vad-assets' / pin['filename']

def verify(path, digest, size=None):
    path = Path(path)
    if size is not None and path.stat().st_size != size:
        raise ValueError(f'Wrong size: {path}')
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    if value.hexdigest() != digest:
        raise ValueError(f'Wrong checksum: {path}')

verify(detector, pin['sha256'], pin['sizeBytes'])
for row in corpus + stress:
    verify(row['audioPath'], row['sha256'])
for model in models:
    verify(model['path'], model['sha256'], model['sizeBytes'])
options = output / 'noise-only.json'
options.write_text(json.dumps({'options': {'noiseGuard': True}, 'entries': []}, indent=2) + '\n')
index = []
for model in models:
    selected = corpus + (stress if model['id'].startswith('whisper-') else [])
    manifests = []
    for row in selected:
        original = by_id[row.get('source', row['id'])]
        destination = output / f"{model['id']}--{row['id']}.json"
        manifests.append({'model': model['id'], 'modelPath': model['path'],
            'detectorPath': str(detector), 'audioPath': row['audioPath'],
            'personalizationPath': str(options), 'outputPath': str(destination),
            'reference': original['reference'], 'terms': original.get('terms', []),
            'warmup': True})
        index.append({'id': row['id'], 'model': model['id'], 'inputSha256': row['sha256'],
            'speechControl': bool(original['reference']), 'outputPath': str(destination)})
    (output / f"{model['id']}-matrix.json").write_text(json.dumps(manifests, indent=2) + '\n')
(output / 'index.json').write_text(json.dumps(index, indent=2) + '\n')
(output / 'provenance.json').write_text(json.dumps({'model': pin, 'models': models,
    'selection': 'all 19 base controls on five engines; all 32 quiet controls on both Whisper engines',
    'pairs': len(index), 'recognitionAudioModified': False,
    'limitations': 'Synthetic file input; not microphone accuracy. Environmental detector false positives remain in the separate complete 322-condition evidence.'}, indent=2) + '\n')
print(f'Prepared {len(index)} pairs in {output}')
