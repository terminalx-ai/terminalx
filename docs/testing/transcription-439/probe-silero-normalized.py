# Diagnostic adaptation of Silero's public ONNX state/context calling protocol.
# Copyright (c) 2020-present Silero Team. MIT; see silero-LICENSE.txt.
import csv
import hashlib
import json
from pathlib import Path
import time
import sys
import wave
import numpy as np
import onnxruntime as ort

if len(sys.argv) != 5:
    raise SystemExit('Usage: probe-silero-normalized.py FIXTURE_DIR EVALUATION_DIR QUIET_MANIFEST NEW_OUTPUT_CSV')
root, evaluation, quiet, output_csv = map(Path, sys.argv[1:])
sources = json.loads(Path(__file__).with_name('silero-holdout-sources.json').read_text())
for row in sources:
    row['path'] = str(root / row['local'])
for row in sources:
    assert hashlib.sha256(Path(row['path']).read_bytes()).hexdigest() == row['sha256']
model = next(row for row in sources if row['sourcePath'].endswith('.onnx'))
ort.disable_telemetry_events()
options = ort.SessionOptions()
options.inter_op_num_threads = 1
options.intra_op_num_threads = 1
session = ort.InferenceSession(model['path'], sess_options=options, providers=['CPUExecutionProvider'])
assert session.get_providers() == ['CPUExecutionProvider']
inputs = []
for manifest in [evaluation / 'corpus.json', quiet]:
    for item in json.loads(manifest.read_text()):
        data = Path(item['audioPath']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        inputs.append((item['id'], 'synthetic', item['id'] not in ['silence', 'white-noise', 'tone'], 16000, np.frombuffer(data, dtype='<f4')))
for row in sources:
    if not row['sourcePath'].endswith('.wav'):
        continue
    with wave.open(row['path'], 'rb') as wav:
        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getcomptype() == 'NONE'
        rate = wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
    for gain in [1, 0.03, 0.001]:
        inputs.append((Path(row['path']).stem + '-gain-' + str(gain), 'fsdd', True, rate, samples * np.float32(gain)))
assert len(inputs) == 231
rng = np.random.default_rng(4391)
t = np.arange(80000, dtype=np.float64) / 16000
signals = [('white', rng.uniform(-1, 1, len(t))),
           ('impulses', (rng.random(len(t)) < 0.001) * rng.choice([-1., 1.], len(t))),
           ('hum', 0.5*np.sin(2*np.pi*50*t)+0.25*np.sin(2*np.pi*100*t)+0.25*np.sin(2*np.pi*150*t))]
signals += [('tone-'+str(hz), np.sin(2*np.pi*hz*t)) for hz in [80,440,1000,4000]]
signals += [('chirps', np.sin(2*np.pi*(200*t+1000*(t % 0.5)**2)))]
for name, signal in signals:
    for amplitude in [0.001,0.02,0.5]:
        inputs.append(('heldout-'+name+'-amplitude-'+str(amplitude), 'generated-holdout', False, 16000, (signal*amplitude).astype(np.float32)))
assert len(inputs) == 255
with output_csv.open('x', newline='') as output:
    fields = ['mode', 'detector_sha256', 'id', 'corpus', 'speech', 'rate', 'samples', 'pcm_sha256', 'frames', 'voice_frames', 'max_score', 'mean_score', 'elapsed_us']
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    for name, corpus, speech, rate, samples in inputs:
        for mode in ['raw', 'peak-normalized']:
            peak = float(np.max(np.abs(samples)))
            detector_samples = samples / np.float32(peak) if mode == 'peak-normalized' and peak else samples
            assert rate in [8000, 16000] and samples.size > 0 and np.isfinite(samples).all() and np.max(np.abs(samples)) <= 1
            size = 512 if rate == 16000 else 256
            context_size = 64 if rate == 16000 else 32
            state = np.zeros((2, 1, 128), dtype=np.float32)
            context = np.zeros((1, context_size), dtype=np.float32)
            scores = []
            start = time.perf_counter_ns()
            for offset in range(0, len(samples), size):
                frame = np.zeros((1, size), dtype=np.float32)
                part = detector_samples[offset:offset + size]
                frame[0, :len(part)] = part
                frame = np.concatenate([context, frame], axis=1)
                score, state = session.run(None, {'input': frame, 'state': state, 'sr': np.array(rate, dtype=np.int64)})
                probability = float(score.item())
                assert 0 <= probability <= 1
                scores.append(probability)
                context = frame[:, -context_size:]
            writer.writerow(dict(mode=mode, detector_sha256=hashlib.sha256(detector_samples.astype('<f4').tobytes()).hexdigest(), id=name, corpus=corpus, speech=speech, rate=rate, samples=len(samples), pcm_sha256=hashlib.sha256(samples.astype('<f4').tobytes()).hexdigest(), frames=len(scores), voice_frames=sum(p >= 0.5 for p in scores), max_score=max(scores), mean_score=sum(scores)/len(scores), elapsed_us=(time.perf_counter_ns()-start)//1000))
print('completed', len(inputs), 'inputs')
