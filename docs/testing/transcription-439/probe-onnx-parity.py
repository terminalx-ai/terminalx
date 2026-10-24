#!/usr/bin/env python3
# Diagnostic adaptation of Silero's public ONNX state/context protocol.
# Copyright (c) 2020-present Silero Team. MIT; see silero-LICENSE.txt.
"""Score the native probe's identical 16 kHz inputs using the diagnostic ONNX runtime.
Usage: probe-onnx-parity.py MANIFEST_JSON ONNX_MODEL ONNX_SHA256 NEW_OUTPUT_JSONL
The model checksum is mandatory: a family name alone is not weight identity.
"""
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np
import onnxruntime as ort

if len(sys.argv) != 5:
    raise SystemExit(__doc__)
manifest_path, model_path, expected_sha, output_path = sys.argv[1:]
model_data = Path(model_path).read_bytes()
if hashlib.sha256(model_data).hexdigest() != expected_sha:
    raise ValueError('Model checksum mismatch')
manifest = json.loads(Path(manifest_path).read_text())
inputs = []
ids = set()
for item in manifest['inputs']:
    if item['id'] in ids or item['sampleRate'] != 16000:
        raise ValueError('Require unique IDs and 16 kHz inputs')
    ids.add(item['id'])
    data = Path(item['audioPath']).read_bytes()
    if not data or len(data) % 4 or len(data) > 16000 * 4 * 300 or data.startswith(b'RIFF'):
        raise ValueError('Invalid f32le input')
    if hashlib.sha256(data).hexdigest() != item['sha256']:
        raise ValueError('Input checksum mismatch')
    samples = np.frombuffer(data, dtype='<f4')
    if not np.isfinite(samples).all() or np.max(np.abs(samples)) > 1:
        raise ValueError('Input must be finite and in [-1, 1]')
    inputs.append((item, samples))
if not inputs:
    raise ValueError('Empty manifest')
ort.disable_telemetry_events()
options = ort.SessionOptions()
options.inter_op_num_threads = options.intra_op_num_threads = 1
with Path(output_path).open('x') as output:
    session = ort.InferenceSession(model_path, sess_options=options, providers=['CPUExecutionProvider'])
    if session.get_providers() != ['CPUExecutionProvider']:
        raise ValueError('Unexpected provider')
    for item, samples in inputs:
        for normalized in [False, True]:
            peak = np.max(np.abs(samples))
            detector = samples / peak if normalized and peak else samples
            state = np.zeros((2, 1, 128), dtype=np.float32)
            context = np.zeros((1, 64), dtype=np.float32)
            probabilities = []
            started = time.perf_counter_ns()
            for offset in range(0, len(detector), 512):
                chunk = np.zeros((1, 512), dtype=np.float32)
                part = detector[offset:offset + 512]
                chunk[0, :len(part)] = part
                frame = np.concatenate([context, chunk], axis=1)
                score, state = session.run(None, {'input': frame, 'state': state,
                                                  'sr': np.array(16000, dtype=np.int64)})
                probability = float(score.item())
                if not 0 <= probability <= 1:
                    raise ValueError('Invalid probability')
                probabilities.append(probability)
                context = frame[:, -64:]
            row = {'id': item['id'], 'normalized': normalized, 'inputSha256': item['sha256'],
                   'detectorSha256': hashlib.sha256(detector.astype('<f4').tobytes()).hexdigest(),
                   'elapsedUs': (time.perf_counter_ns() - started) // 1000,
                   'probabilities': probabilities, 'speech': any(p >= 0.5 for p in probabilities),
                   'error': None}
            output.write(json.dumps(row) + '\n')
            output.flush()
