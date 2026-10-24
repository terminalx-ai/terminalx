#!/usr/bin/env python3
"""Prepare checksum-pinned public/generated PCM without recognition or app access.
Usage: prepare-native-vad-inputs.py UPSTREAM_SOURCE EVALUATION_DIR QUIET_MANIFEST ESC_AUDIO_DIR MODEL_PATH NEW_OUTPUT_DIR
Requires diagnostic numpy==1.26.4 and scipy==1.13.1. No network downloads.
ESC_AUDIO_DIR must contain the selected WAVs fetched from the pinned source manifest.
"""
import hashlib
import json
from pathlib import Path
import sys
import wave
import numpy as np
import scipy
from scipy.signal import resample_poly

if len(sys.argv) != 7:
    raise SystemExit(__doc__)
if np.__version__ != '1.26.4' or scipy.__version__ != '1.13.1':
    raise ValueError('Use the pinned diagnostic numpy/scipy versions')
source, evaluation, quiet, esc, model, output = map(Path, sys.argv[1:])
docs = Path(__file__).parent
output.mkdir(mode=0o700, exist_ok=False)
entries = []
labels = []

def digest(data):
    return hashlib.sha256(data).hexdigest()

def write(name, pcm, speech, group, provenance):
    if any(e['id'] == name for e in entries):
        raise ValueError('Duplicate ID')
    samples = np.asarray(pcm, dtype='<f4')
    if not len(samples) or not np.isfinite(samples).all() or np.max(np.abs(samples)) > 1:
        raise ValueError('Invalid PCM: '+name+' peak='+str(np.max(np.abs(samples))))
    path = output / (name + '.f32')
    data = samples.tobytes()
    with path.open('xb') as file:
        file.write(data)
    entries.append({'id': name, 'audioPath': str(path.resolve()), 'sha256': digest(data), 'sampleRate': 16000})
    labels.append({'id': name, 'speech': speech, 'group': group, 'provenance': provenance})

def wav(path):
    with wave.open(str(path), 'rb') as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getcomptype() != 'NONE':
            raise ValueError('Expected mono PCM16')
        return audio.getframerate(), np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768

for manifest in [evaluation / 'corpus.json', quiet]:
    for row in json.loads(manifest.read_text()):
        data = Path(row['audioPath']).read_bytes()
        if digest(data) != row['sha256']:
            raise ValueError('Existing corpus checksum mismatch')
        write(row['id'], np.frombuffer(data, dtype='<f4'), row['id'] not in ['silence','white-noise','tone'],
              'synthetic-regression', {'manifest': str(manifest), 'inputSha256': row['sha256']})
if len(entries) != 51:
    raise ValueError('Expected all 51 original controls')

# Exact same seed/order/math as the earlier 24 generated holdout controls.
rng = np.random.default_rng(4391)
t = np.arange(80000, dtype=np.float64) / 16000
signals = [('white', rng.uniform(-1, 1, len(t))),
           ('impulses', (rng.random(len(t)) < 0.001) * rng.choice([-1., 1.], len(t))),
           ('hum', 0.5*np.sin(2*np.pi*50*t)+0.25*np.sin(2*np.pi*100*t)+0.25*np.sin(2*np.pi*150*t))]
signals += [('tone-'+str(hz), np.sin(2*np.pi*hz*t)) for hz in [80,440,1000,4000]]
signals += [('chirps', np.sin(2*np.pi*(200*t+1000*(t % 0.5)**2)))]
for name, signal in signals:
    for amplitude in [0.001,0.02,0.5]:
        write('heldout-'+name+'-amplitude-'+str(amplitude), (signal*amplitude).astype(np.float32),
              False, 'generated-regression', {'seed': 4391, 'amplitude': amplitude})

for row in json.loads((docs/'native-vad-fleurs-sources.json').read_text()):
    path = source/row['sourcePath']
    if digest(path.read_bytes()) != row['sha256']:
        raise ValueError('FLEURS checksum mismatch')
    rate, samples = wav(path)
    if rate != 16000:
        raise ValueError('Unexpected FLEURS rate')
    for gain in [1,0.03,0.001]:
        write('fleurs-'+path.stem+'-gain-'+str(gain), samples*np.float32(gain), True, 'public-human',
              {'source': row, 'gain': gain, 'conversion': 'PCM16 / 32768; no resampling'})

for row in json.loads((docs/'native-vad-esc10-sources.json').read_text()):
    path = esc/row['filename']
    data = path.read_bytes()
    blob = hashlib.sha1(('blob '+str(len(data))+'\0').encode()+data).hexdigest()
    if len(data) != row['sizeBytes'] or blob != row['gitBlob']:
        raise ValueError('ESC pinned Git blob mismatch')
    rate, samples = wav(path)
    if rate != 44100:
        raise ValueError('Unexpected ESC rate')
    converted = resample_poly(samples * np.float32(0.5), 160, 441, window=('kaiser', 5.0), padtype='constant')
    # Fixed 6 dB headroom for every ESC file prevents resampling overshoot.
    # Still fail, never clip, if the resulting samples exceed the accepted range.
    write('esc10-'+path.stem, converted, False, 'public-environmental-label',
          {'source':row, 'sourceSha256':digest(data), 'preResampleGain':0.5, 'conversion':'scipy 1.13.1 resample_poly 160/441 Kaiser beta5 constant padding; no clipping'})

model_spec = json.loads((docs/'native-vad-model.json').read_text())
model_data = model.read_bytes()
if len(model_data) != model_spec['sizeBytes'] or digest(model_data) != model_spec['sha256']:
    raise ValueError('Native model checksum mismatch')
if len(entries) != 161:
    raise ValueError('Expected complete 161-input selection')
(output/'manifest.json').write_text(json.dumps({'modelPath':str(model.resolve()),
    'modelSha256':model_spec['sha256'],'inputs':entries},indent=2)+'\n')
(output/'labels.json').write_text(json.dumps(labels,indent=2)+'\n')
print('Prepared',len(entries),'inputs; no model inference')
