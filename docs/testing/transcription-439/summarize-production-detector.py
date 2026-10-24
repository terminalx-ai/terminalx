#!/usr/bin/env python3
"""Summarize every prepared pair, including absent/failed rows.
Usage: summarize-production-detector.py MATRIX_DIR NEW_CSV NEW_SUMMARY_JSON
No threshold tuning or removal of failed controls.
"""
import csv
import json
from pathlib import Path
import statistics
import sys

if len(sys.argv) != 4:
    raise SystemExit(__doc__)
root, csv_path, summary_path = map(Path, sys.argv[1:])
index = json.loads((root / 'index.json').read_text())
rows = []
for item in index:
    row = {'model': item['model'], 'id': item['id'], 'speechControl': item['speechControl'],
           'inputSha256': item['inputSha256'], 'pass': False, 'error': ''}
    try:
        result = json.loads(Path(item['outputPath']).read_text())
        off, on = result['baseline'], result['personalized']
        same_raw = off['raw'] == on['raw']
        expected = 'speech' if item['speechControl'] else 'noSpeech'
        ok = (same_raw and off['noise']['status'] == 'disabled'
              and off['noise']['elapsedUs'] == 0 and on['noise']['status'] == expected
              and (on['finalText'] == off['finalText'] if item['speechControl'] else on['finalText'] == ''))
        row.update({'baselineRaw': off['raw'], 'onRaw': on['raw'],
            'baselineFinal': off['finalText'], 'onFinal': on['finalText'],
            'sameRecognitionOutput': same_raw, 'noiseStatus': on['noise']['status'],
            'noiseUs': on['noise']['elapsedUs'],
            'offInferenceMs': off['inferenceMs'], 'onInferenceMs': on['inferenceMs'],
            'offProcessingUs': off['processingUs'], 'onProcessingUs': on['processingUs'],
            'offWER': off['score']['wordErrorRate'], 'onWER': on['score']['wordErrorRate'],
            'offTermAccuracy': off['score']['termAccuracy'], 'onTermAccuracy': on['score']['termAccuracy'],
            'pass': ok})
    except Exception as error:
        row['error'] = str(error)
    rows.append(row)
fields = list(dict.fromkeys(key for row in rows for key in row))
with csv_path.open('x') as output:
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader(); writer.writerows(rows)
complete = [r for r in rows if not r['error']]
times = sorted(r['noiseUs'] for r in complete)
summary = {'pairsExpected': len(index), 'pairsComplete': len(complete),
    'pairsPassed': sum(r['pass'] for r in rows),
    'failures': [r for r in rows if not r['pass']],
    'detectorMedianUs': statistics.median(times) if times else None,
    'detectorP95Us': times[min(len(times)-1, int(len(times)*.95))] if times else None,
    'detectorMaxUs': max(times) if times else None,
    'nonSpeechBaselineNonempty': sum(bool(r.get('baselineFinal')) for r in complete if not r['speechControl']),
    'nonSpeechFinalNonempty': sum(bool(r.get('onFinal')) for r in complete if not r['speechControl']),
    'limitations': 'Synthetic file recognition, not microphone accuracy. Timing includes model verification; first enabled call may include detector load. Separate broad detector evidence retains both environmental false positives.'}
with summary_path.open('x') as output:
    json.dump(summary, output, indent=2); output.write('\n')
print(json.dumps({k:v for k,v in summary.items() if k != 'failures'}, indent=2))
raise SystemExit(0 if all(r['pass'] for r in rows) and rows else 1)
