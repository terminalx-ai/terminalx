#!/usr/bin/env python3
"""Compare all-off outputs, retaining missing/failed rows as failures.
Usage: compare-runtime-compatibility.py BASELINE_DIR CANDIDATE_DIR NEW_OUTPUT_CSV
Both directories contain <model-id>-<version>.out from whisper-trace.cpp.
BASELINE_DIR/manifest.json pins every input and model; candidates must use it.
"""
import csv
import json
from pathlib import Path
import sys

if len(sys.argv) != 4:
    raise SystemExit(__doc__)
baseline, candidate, destination = map(Path,sys.argv[1:])
manifest = json.loads((baseline/'manifest.json').read_text())

def parse(path):
    rows = {}
    if not path.exists():
        return rows
    for line in path.read_text().splitlines():
        if line.startswith('/'):
            audio, status, encoded, *_ = line.split('\t')
            if audio in rows:
                raise ValueError('Duplicate audio row')
            rows[audio] = (int(status),bytes.fromhex(encoded).decode('utf-8'))
    return rows

failures = 0
with destination.open('x',newline='') as output:
    writer = csv.DictWriter(output,fieldnames=['model','input','baseline_status','candidate_status',
        'baseline_raw','candidate_raw','exact_raw_match','trimmed_match'],lineterminator='\n')
    writer.writeheader()
    for model in manifest['models']:
        old = parse(baseline/(model['id']+'-0.2.3.out'))
        new = parse(candidate/(model['id']+'-0.4.1.out'))
        for item in manifest['inputs']:
            a = old.get(item['audioPath'],('missing',''))
            b = new.get(item['audioPath'],('missing',''))
            exact = a[0] == b[0] == 0 and a[1] == b[1]
            trimmed = a[0] == b[0] == 0 and a[1].strip() == b[1].strip()
            failures += not trimmed
            writer.writerow(dict(model=model['id'],input=item['id'],baseline_status=a[0],candidate_status=b[0],
                baseline_raw=a[1],candidate_raw=b[1],exact_raw_match=exact,trimmed_match=trimmed))
print('Mismatches:',failures,'of',len(manifest['models'])*len(manifest['inputs']))
raise SystemExit(1 if failures else 0)
