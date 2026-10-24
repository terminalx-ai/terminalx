#!/usr/bin/env python3
"""Generate invented offline speech and a paired matrix; never record a microphone.

Usage: python3 generate-synthetic.py /absolute/private/output /absolute/models.json
models.json is the verified catalog inventory (id/path/sizeBytes/sha256). Model
weights must already exist. This script downloads nothing and plays no audio.
"""
import hashlib
import json
import math
from pathlib import Path
import random
import struct
import subprocess
import sys
import wave


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    root, inventory = Path(sys.argv[1]), Path(sys.argv[2])
    if not root.is_absolute() or not inventory.is_absolute():
        raise SystemExit("Use explicit absolute paths")
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ("audio", "options", "results"):
        (root / name).mkdir(mode=0o700)
    script = json.loads(Path(__file__).with_name("sentences.json").read_text())["sentences"]
    script += [{"id": "learning", "spoken": "Open the paraquet files", "reference": "Open the Parakeet files", "terms": ["Parakeet"]}]
    corpus = []
    for voice in ("Samantha", "Daniel"):
        for sentence in script:
            if not sentence["spoken"]:
                continue
            name = voice.lower() + "-" + sentence["id"]
            wav = root / "audio" / (name + ".wav")
            subprocess.run(["/usr/bin/say", "-v", voice, "-r", "165", "-o", str(wav), "--file-format=WAVE", "--data-format=LEI16@16000", sentence["spoken"]], check=True)
            with wave.open(str(wav), "rb") as audio:
                assert (audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) == (1, 16000, 2)
                samples = [x[0] / 32768 for x in struct.iter_unpack("<h", audio.readframes(audio.getnframes()))]
            samples = [0.0] * 4000 + samples + [0.0] * 4000
            pcm = root / "audio" / (name + ".f32le")
            pcm.write_bytes(struct.pack("<" + "f" * len(samples), *samples))
            corpus.append(dict(sentence, id=name, voice=voice, rate=165, wav=str(wav), audioPath=str(pcm), sha256=hashlib.sha256(pcm.read_bytes()).hexdigest()))
    rng = random.Random(439)
    signals = [("silence", [0.0] * 80000), ("white-noise", [rng.uniform(-0.02, 0.02) for _ in range(80000)]), ("tone", [0.05 * math.sin(2 * math.pi * 440 * i / 16000) for i in range(80000)])]
    for name, samples in signals:
        pcm = root / "audio" / (name + ".f32le")
        pcm.write_bytes(struct.pack("<" + "f" * len(samples), *samples))
        corpus.append(dict(id=name, spoken=None, reference="", terms=["TranscriptionTab.tsx", "refreshDictationEngine"], audioPath=str(pcm), sha256=hashlib.sha256(pcm.read_bytes()).hexdigest(), provenance="generated deterministic signal; seed 439"))
    (root / "corpus.json").write_text(json.dumps(corpus, indent=2))
    terms = list(dict.fromkeys(t for s in corpus for t in s["terms"]))
    entries = [dict(id="evaluation-" + str(i), kind="vocabulary", heard="", written=t, soundsLike=["paraquet", "parquet"] if t == "Parakeet" else [], project=None) for i, t in enumerate(terms)]
    configs = {"context": {"options": {"context": True}, "entries": []}, "dictionary": {"options": {"dictionary": True}, "entries": entries}, "combined": {"options": {"context": True, "dictionary": True, "retakes": True, "normalize": True, "code": True, "guards": True}, "entries": entries}}
    for name, data in configs.items():
        (root / "options" / (name + ".json")).write_text(json.dumps(data, indent=2))
    matrix = []
    for model in json.loads(inventory.read_text()):
        weight = Path(model["path"])
        assert weight.stat().st_size == model["sizeBytes"]
        digest = hashlib.sha256()
        with weight.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1048576), b""):
                digest.update(chunk)
        assert digest.hexdigest() == model["sha256"]
        for sample in corpus:
            for mode in configs:
                output = root / "results" / (model["id"] + "--" + sample["id"] + "--" + mode + ".json")
                matrix.append(dict(model=model["id"], modelPath=str(weight), audioPath=sample["audioPath"], personalizationPath=str(root / "options" / (mode + ".json")), outputPath=str(output), terms=sample["terms"], reference=sample["reference"], warmup=True))
    (root / "matrix.json").write_text(json.dumps(matrix, indent=2))
    print(str(root / "matrix.json"))


if __name__ == "__main__":
    main()
