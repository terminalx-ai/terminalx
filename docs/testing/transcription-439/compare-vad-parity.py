#!/usr/bin/env python3
"""Compare complete diagnostic results without dropping failures.
Usage: compare-vad-parity.py NATIVE_JSONL ONNX_JSONL NEW_SUMMARY_JSON
Exit nonzero for mismatches. Never substitutes missing data with silence.
"""
import json
from pathlib import Path
import sys

if len(sys.argv) != 4:
    raise SystemExit(__doc__)

def load(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        row = json.loads(line)
        key = (row['id'], row['normalized'])
        if key in result:
            raise ValueError('Duplicate row: ' + repr(key))
        result[key] = row
    return result

native, reference = map(load, sys.argv[1:3])
rows = []
passed = bool(native) and native.keys() == reference.keys()
for key in sorted(native.keys() | reference.keys()):
    a, b = native.get(key), reference.get(key)
    row = {'id': key[0], 'normalized': key[1]}
    if not a or not b or a.get('error') or b.get('error'):
        row.update({'pass': False, 'error': 'Missing row or runtime error', 'native': a, 'reference': b})
    elif (a['inputSha256'] != b['inputSha256'] or a['detectorSha256'] != b['detectorSha256']
          or len(a['probabilities']) != len(b['probabilities']) or not a['probabilities']):
        row.update({'pass': False, 'error': 'Input/hash/frame-count mismatch'})
    else:
        differences = [abs(x-y) for x, y in zip(a['probabilities'], b['probabilities'])]
        maximum = max(differences)
        same_decision = a['speech'] == b['speech']
        row.update({'maxAbsDifference': maximum, 'meanAbsDifference': sum(differences)/len(differences),
                    'sameDecision': same_decision, 'nativeSpeech': a['speech'], 'referenceSpeech': b['speech'],
                    'pass': maximum <= 1e-4 and same_decision})
    passed = passed and row['pass']
    rows.append(row)
with Path(sys.argv[3]).open('x') as output:
    json.dump({'pass': passed, 'absoluteTolerance': 1e-4, 'rows': rows}, output, indent=2)
    output.write('\n')
print('PASS' if passed else 'FAIL', len(rows), 'paired conditions')
raise SystemExit(0 if passed else 1)
