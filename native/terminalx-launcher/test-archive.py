#!/usr/bin/env python3
"""Disposable signature regression using the normal Tauri archive replay probe.

The probe must implement CLI create_tar_from_src and updater entry.unpack as
recorded in the acceptance manifest. This does not launch or replace an app.
"""
import argparse, hashlib, json, pathlib, subprocess, tempfile
p = argparse.ArgumentParser()
p.add_argument('--bundle', type=pathlib.Path, required=True)
p.add_argument('--launcher', type=pathlib.Path, required=True)
p.add_argument('--archive-probe', type=pathlib.Path, required=True)
a = p.parse_args()
root = pathlib.Path(tempfile.mkdtemp(prefix='tx467-native-launcher-archive-'))
steps = []
def run(args, expected=0):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True)
    steps.append({'command': [str(x) for x in args], 'exit': result.returncode,
                  'stdout': result.stdout, 'stderr': result.stderr})
    (root / 'steps.json').write_text(json.dumps(steps, indent=2))
    assert result.returncode == expected, steps[-1]
run(['codesign', '--verify', '--deep', '--strict', a.bundle])
app = root / 'Native Launcher.app'
run(['ditto', a.bundle, app])
launcher = app / 'Contents/MacOS/terminalx'
# Replacing only our disposable copy drops the old script xattrs deliberately.
launcher.unlink()
launcher.write_bytes(a.launcher.read_bytes())
launcher.chmod(0o755)
run(['codesign', '--force', '--sign', '-', launcher])
run(['codesign', '--force', '--sign', '-', app])
run(['codesign', '--verify', '--deep', '--strict', app])
archive = root / 'normal-native.app.tar.gz'
extracted = root / 'extracted.app'
run([a.archive_probe, app, archive, extracted])
run(['codesign', '--verify', '--deep', '--strict', extracted])
run(['codesign', '--verify', '--strict', extracted / 'Contents/MacOS/terminalx'])
run(['codesign', '--verify', '--strict', extracted / 'Contents/Resources/local-runtime/terminalx-serve'])
files = lambda base: {str(q.relative_to(base)): hashlib.sha256(q.read_bytes()).hexdigest()
                      for q in sorted(base.rglob('*')) if q.is_file()}
assert files(app) == files(extracted)
(root / 'manifest.json').write_text(json.dumps({
    'scope': 'disposable ad-hoc signing and normal archive algorithm replay; no app launch',
    'launcherSha256': hashlib.sha256(a.launcher.read_bytes()).hexdigest(),
    'archiveProbeSha256': hashlib.sha256(a.archive_probe.read_bytes()).hexdigest(),
    'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'memberHashes': files(extracted), 'steps': steps}, indent=2))
print(root)
