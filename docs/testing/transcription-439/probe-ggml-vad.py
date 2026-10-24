#!/usr/bin/env python3
"""Diagnostic ctypes caller for the detector-only public-GGML adapter.
Usage: probe-ggml-vad.py MANIFEST_JSON DETECTOR_DYLIB NEW_OUTPUT_JSONL
No Python or shared probe library is proposed for shipping with the application.
"""
import ctypes as c
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np

if len(sys.argv) != 4:
    raise SystemExit(__doc__)
manifest_path, library_path, output_path = sys.argv[1:]
manifest = json.loads(Path(manifest_path).read_text())
model_bytes = Path(manifest['modelPath']).read_bytes()
if hashlib.sha256(model_bytes).hexdigest() != manifest['modelSha256']:
    raise ValueError('Model checksum mismatch')
inputs = []
ids = set()
for item in manifest['inputs']:
    if item['id'] in ids or item['sampleRate'] != 16000:
        raise ValueError('Require unique IDs and 16 kHz inputs')
    ids.add(item['id'])
    data = Path(item['audioPath']).read_bytes()
    if not data or len(data)%4 or len(data)>16000*4*300 or data.startswith(b'RIFF'):
        raise ValueError('Invalid f32le input')
    if hashlib.sha256(data).hexdigest() != item['sha256']:
        raise ValueError('Input checksum mismatch')
    samples = np.frombuffer(data,dtype='<f4')
    if not np.isfinite(samples).all() or np.max(np.abs(samples))>1:
        raise ValueError('Invalid PCM range')
    inputs.append((item,samples))
lib = c.CDLL(library_path)
lib.tx_vad_open.argtypes=[c.c_void_p,c.c_size_t,c.POINTER(c.c_void_p)]
lib.tx_vad_open.restype=c.c_int
lib.tx_vad_close.argtypes=[c.c_void_p]
lib.tx_vad_close.restype=None
lib.tx_vad_score.argtypes=[c.c_void_p,c.POINTER(c.c_float),c.c_size_t,c.POINTER(c.c_float),c.c_size_t]
lib.tx_vad_score.restype=c.c_int
model_buffer=c.create_string_buffer(model_bytes)
handle=c.c_void_p()
if lib.tx_vad_open(model_buffer,len(model_bytes),c.byref(handle)):
    raise RuntimeError('Native detector model load failed')
try:
    with Path(output_path).open('x') as output:
        for item,samples in inputs:
            for normalized in [False,True]:
                peak=np.max(np.abs(samples))
                detector=samples/peak if normalized and peak else samples
                probs=np.full((len(samples)+511)//512,np.nan,dtype=np.float32)
                start=time.perf_counter_ns()
                status=lib.tx_vad_score(handle,detector.ctypes.data_as(c.POINTER(c.c_float)),len(detector),
                                        probs.ctypes.data_as(c.POINTER(c.c_float)),len(probs))
                elapsed=(time.perf_counter_ns()-start)//1000
                error=None if status==0 and np.isfinite(probs).all() and np.all((probs>=0)&(probs<=1)) else 'Native computation failed/incomplete'
                row={'id':item['id'],'normalized':normalized,'inputSha256':item['sha256'],
                     'detectorSha256':hashlib.sha256(detector.astype('<f4').tobytes()).hexdigest(),
                     'elapsedUs':elapsed,'probabilities':probs.tolist() if not error else [],
                     'speech':bool(np.any(probs>=0.5)) if not error else None,'error':error}
                output.write(json.dumps(row)+'\n');output.flush()
                if error:
                    raise RuntimeError(error)
finally:
    lib.tx_vad_close(handle)
