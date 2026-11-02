#!/usr/bin/env python3
"""Run public-C telemetry on an explicitly supplied synthetic evaluation corpus.

Usage: run-whisper-traces.py EVALUATION_DIR NEW_OUTPUT_DIR PROBE_EXECUTABLE
No downloads, audio capture, user-history discovery or runtime threshold changes.
"""
import array
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def main():
    evaluation, output, probe = map(Path, sys.argv[1:])
    if sys.byteorder != "little":
        raise SystemExit("This fixture generator requires little-endian float32")
    corpus = json.loads((evaluation / "corpus.json").read_text())
    models = [m for m in json.loads((evaluation / "models.json").read_text())
              if m["id"].startswith("whisper-")]
    for model in models:
        path = Path(model["path"])
        with path.open("rb") as source:
            digest = hashlib.sha256()
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if path.stat().st_size != model["sizeBytes"] or digest.hexdigest() != model["sha256"]:
            raise SystemExit("Model checksum/size mismatch: " + model["id"])
    for item in corpus:
        if hashlib.sha256(Path(item["audioPath"]).read_bytes()).hexdigest() != item["sha256"]:
            raise SystemExit("Input checksum mismatch: " + item["id"])
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    quiet = []
    for item in corpus:
        if not item.get("voice"):
            continue
        samples = array.array("f")
        samples.frombytes(Path(item["audioPath"]).read_bytes())
        for gain in (0.03, 0.001):
            path = output / (item["id"] + "-gain-" + str(gain) + ".f32le")
            path.write_bytes(array.array("f", (value * gain for value in samples)).tobytes())
            quiet.append({"id": path.stem, "audioPath": str(path.resolve()),
                          "source": item["id"], "gain": gain,
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    (output / "quiet-manifest.json").write_text(json.dumps(quiet, indent=2))
    prompt = "TranscriptionTab.tsx, dictationText.ts, refreshDictationEngine, Zephyr, fix/offline-dictation"
    failed = False
    for model in models:
        for name, inputs in (("original", corpus), ("quiet", quiet)):
            for mode, hint in (("off", ""), ("on", prompt)):
                stem = output / (model["id"] + "-" + name + "-" + mode)
                with stem.with_suffix(".out").open("w") as stdout, stem.with_suffix(".err").open("w") as stderr:
                    result = subprocess.run([str(probe.resolve()), model["path"], hint,
                                             *[item["audioPath"] for item in inputs]],
                                            stdout=stdout, stderr=stderr, check=False)
                print(stem.name, result.returncode, flush=True)
                failed |= result.returncode != 0
    return int(failed)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    raise SystemExit(main())
